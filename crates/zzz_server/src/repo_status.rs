//! Tier-1 status for the entries of open registry projects.
//!
//! Each present entry's git state from local refs, as `repos status` reads
//! it (`fuz_repos::status::status`, no fetch, no busy detection), narrowed
//! for the wire ([`RepoStatusInfo`]).
//!
//! A poll ([`RepoStatusManager::poll`]) never waits on git. It stamps every
//! present entry's git dir ([`stat_stamp`]) and starts a probe, on a small
//! pool, for each entry that is stale:
//!
//! - its stamp moved since the last probe — a commit, a checkout, a fetch,
//!   a stash, an index write;
//! - it was edit-hinted ([`RepoStatusManager::hint`]: its filer saw a
//!   change) and its last probe is at least [`HINT_MIN_INTERVAL`] old —
//!   editing a tracked file moves nothing under `.git`;
//! - it was never probed, or the poll asked for a `refresh`;
//! - else, the sweep: the one entry whose last probe is oldest, once that
//!   is past [`SWEEP_AGE`] — an unfocused repo edited by another program
//!   has no filer to hint it.
//!
//! It returns every entry's last known status at once, with `probing` set
//! on those in flight; the client polls while it shows them, and the
//! statuses fill in.
//!
//! **What git runs.** `git status` runs the clean filters the repo's config
//! names on files whose stat changed — the same exposure as `repos status`
//! or a git-aware prompt, and only for registry entries the project
//! resolved present and confined, never an unregistered dir. `fuz_git`'s
//! runner still refuses hooks, an fsmonitor, and background maintenance.
//!
//! The registry's entries come from the resolve `project_open` made
//! ([`RepoStatusManager::set_registry`]), held from its open's commit to its
//! close's, under the projects lock; a poll of a root with nothing held is
//! refused.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fuz_git::Git;
use fuz_repos::classify::{NeedsHuman, Refresh};
use fuz_repos::registry::{Entry, RegistryDirs};
use fuz_repos::report::EntryStatus;
use fuz_repos::sessions::LiveSessions;
use fuz_repos::state::{Head, Presence, Relation};
use fuz_repos::status::{StatusOptions, status};
use serde::Serialize;
use tokio::sync::Semaphore;

use crate::project::{EntryDir, ProjectEntry};

/// The least time between two probes of an entry its filer keeps hinting,
/// so an agent writing files doesn't keep `git status` running.
pub const HINT_MIN_INTERVAL: Duration = Duration::from_secs(3);

/// How old an entry's last probe gets before the sweep re-probes it.
pub const SWEEP_AGE: Duration = Duration::from_secs(60);

/// Probes in flight at once, across every project.
pub const PROBE_POOL: usize = 2;

/// The most files a stamp reads under one refs directory; past it the
/// stamp counts what's left instead, so a repo with a huge ref namespace
/// stays cheap to stamp.
const STAMP_REFS_MAX: usize = 4096;

// -- Wire -----------------------------------------------------------------------

/// An entry's status — twin of `RepoStatusJson` in `action_specs.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepoStatusInfo {
    /// The entry's key in its table.
    pub key: String,
    pub state: RepoStatusState,
    /// Whether a probe of it is in flight.
    pub probing: bool,
    /// When the status was read (unix ms); `None` while pending.
    pub probed_at: Option<u64>,
    /// The branch the primary checkout is on; `None` when detached or not
    /// read.
    pub branch: Option<String>,
    pub detached: bool,
    /// Whether it's on the branch the entry follows; `None` when the entry
    /// follows none, or it wasn't read.
    pub on_branch: Option<bool>,
    pub uncommitted: UncommittedInfo,
    /// The operation stopped mid-way in the primary checkout (`rebase`,
    /// `cherry_pick`, …).
    pub in_progress: Option<String>,
    /// The followed branch's relation to origin, when it was compared.
    pub followed: Option<RelationInfo>,
    pub stashes: u32,
    /// The newest fetch's time (unix seconds), as `repos status` reads it.
    pub fetched_at: Option<u64>,
    /// Why `repos sync` would leave the entry to a person, by kind, deduped —
    /// but the primary checkout's operation, which `in_progress` says.
    pub needs_human: Vec<String>,
    /// What failed, for a failed probe.
    pub error: Option<String>,
}

/// Where an entry's status stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoStatusState {
    /// Not probed yet.
    Pending,
    Ok,
    /// The probe failed; `error` says why, and the facts may be partial.
    Failed,
    /// Nothing at the entry's dir.
    Missing,
    /// The dir holds no repo.
    NotARepo,
}

/// Uncommitted changes in the primary checkout.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct UncommittedInfo {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
}

/// A branch's relation to origin, narrowed: the counts where they mean
/// something, else the kind alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RelationInfo {
    pub kind: &'static str,
    pub ahead: u32,
    pub behind: u32,
}

impl RepoStatusInfo {
    fn pending(key: &str) -> Self {
        Self {
            key: key.to_owned(),
            state: RepoStatusState::Pending,
            probing: false,
            probed_at: None,
            branch: None,
            detached: false,
            on_branch: None,
            uncommitted: UncommittedInfo::default(),
            in_progress: None,
            followed: None,
            stashes: 0,
            fetched_at: None,
            needs_human: Vec::new(),
            error: None,
        }
    }
}

/// The wire projection of one probe.
fn to_info(key: &str, status: &EntryStatus, probed_at: u64) -> RepoStatusInfo {
    let mut info = RepoStatusInfo::pending(key);
    info.probed_at = Some(probed_at);
    info.state = match status.presence {
        Presence::Present => RepoStatusState::Ok,
        Presence::Missing => RepoStatusState::Missing,
        Presence::NotARepo => RepoStatusState::NotARepo,
    };
    if let Some(error) = &status.probe_error {
        info.state = RepoStatusState::Failed;
        info.error = Some(error.message.clone());
    }
    if let Some(primary) = status.checkouts.iter().find(|c| c.primary) {
        match &primary.head {
            Head::Branch { name } => info.branch = Some(name.clone()),
            Head::Detached { .. } => info.detached = true,
        }
        let u = primary.uncommitted;
        info.uncommitted = UncommittedInfo {
            staged: u.staged,
            unstaged: u.unstaged,
            untracked: u.untracked,
            conflicted: u.conflicted,
        };
        info.in_progress = primary.in_progress.and_then(|op| serde_tag(&op));
    }
    if let Some(at_rest) = status.at_rest {
        info.on_branch = at_rest.on_branch;
        info.followed = at_rest.followed.map(to_relation);
    }
    info.stashes = status.stashes;
    info.fetched_at = status.fetched_at;
    // the reasons' own serde tags, so a reason fuz_repos adds names itself
    // the primary's own operation is `in_progress`; a worktree's is said only
    // by its reason, so it stays
    let primary = status.checkouts.iter().find(|c| c.primary).map(|c| &c.path);
    let reasons = status.needs_human.iter().filter(|reason| {
        !matches!(reason, NeedsHuman::OperationInProgress { checkout, .. } if Some(checkout) == primary)
    });
    for kind in reasons.filter_map(serde_tag) {
        // a reason per checkout can repeat a kind
        if !info.needs_human.contains(&kind) {
            info.needs_human.push(kind);
        }
    }
    info
}

/// A value's serde name: a unit variant's string, or a tagged enum's
/// `kind` — so a variant `fuz_repos` adds names itself, in its wire spelling.
fn serde_tag<T: Serialize>(value: &T) -> Option<String> {
    match serde_json::to_value(value).ok()? {
        serde_json::Value::String(name) => Some(name),
        serde_json::Value::Object(map) => map.get("kind")?.as_str().map(str::to_owned),
        _ => None,
    }
}

const fn to_relation(relation: Relation) -> RelationInfo {
    let (kind, ahead, behind) = match relation {
        Relation::InSync => ("in_sync", 0, 0),
        Relation::Ahead { commits } => ("ahead", commits, 0),
        Relation::Behind { commits } => ("behind", 0, commits),
        Relation::Diverged { ahead, behind } => ("diverged", ahead, behind),
        Relation::Shallow => ("shallow", 0, 0),
        Relation::Gone => ("gone", 0, 0),
        Relation::Unmapped => ("unmapped", 0, 0),
        Relation::Untracked => ("untracked", 0, 0),
    };
    RelationInfo {
        kind,
        ahead,
        behind,
    }
}

// -- The stamp ------------------------------------------------------------------

/// A hash of what moves under an entry's git dir when its refs, HEAD, index,
/// stash, or config move.
///
/// The checkout's own `HEAD`, `index`, and `FETCH_HEAD`; the common git
/// dir's [`COMMON_STAMPED`] files, `refs/heads/**`, and
/// `refs/remotes/origin/**`; and each linked worktree's `HEAD` and
/// `index`. Each by `lstat`: inode, size, and mtime, or its
/// absence. Editing a tracked file moves none of these — the hints and the
/// sweep cover that.
///
/// `None` when the checkout's `.git` is neither a directory nor a readable
/// gitfile; the probe then says what's there.
pub fn stat_stamp(dir: &Path) -> Option<u64> {
    let git_dir = git_dir_of(dir)?;
    let common = read_small(&git_dir.join("commondir")).map_or_else(
        || git_dir.clone(),
        |c| git_dir.join(c.trim_end_matches(['\n', '\r'])),
    );
    let mut h = DefaultHasher::new();
    for name in ["HEAD", "index", "FETCH_HEAD"] {
        stamp_path(&mut h, &git_dir.join(name));
    }
    for name in COMMON_STAMPED {
        stamp_path(&mut h, &common.join(name));
    }
    for refs in ["refs/heads", "refs/remotes/origin"] {
        stamp_tree(&mut h, &common.join(refs));
    }
    if let Ok(worktrees) = fs::read_dir(common.join("worktrees")) {
        let mut ids: Vec<PathBuf> = worktrees.filter_map(|e| e.ok().map(|e| e.path())).collect();
        ids.sort();
        for id in ids {
            stamp_path(&mut h, &id.join("HEAD"));
            stamp_path(&mut h, &id.join("index"));
        }
    }
    Some(h.finish())
}

/// The checkout's git dir: `.git` itself, or where a gitfile points.
fn git_dir_of(dir: &Path) -> Option<PathBuf> {
    let dot_git = dir.join(".git");
    let meta = fs::symlink_metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(dot_git);
    }
    if !meta.is_file() {
        return None;
    }
    let text = read_small(&dot_git)?;
    // as git reads one: `gitdir: <path>`, the line break trimmed
    let target = text
        .strip_prefix("gitdir: ")?
        .trim_end_matches(['\n', '\r']);
    Some(dir.join(target))
}

/// The files of the common git dir a stamp reads, beside the checkout's own
/// `HEAD`, `index`, and `FETCH_HEAD`: the main worktree's `HEAD` and `index`
/// (a linked-worktree entry reports the main worktree too), `packed-refs`,
/// the stash's reflog, a reftable repo's table list (its refs live there,
/// not under `refs/`), and `config` (an `origin` edit is a status change).
const COMMON_STAMPED: [&str; 7] = [
    "HEAD",
    "index",
    "FETCH_HEAD",
    "packed-refs",
    "logs/refs/stash",
    "reftable/tables.list",
    "config",
];

/// The most a stamp reads of a gitfile or a `commondir` file.
const SMALL_FILE_MAX: u64 = 4096;

/// A gitfile's or `commondir`'s text: a regular file, never followed through
/// a symlink, opened without waiting on a FIFO, and at most
/// [`SMALL_FILE_MAX`] bytes (`fuz_sys`'s bounded read).
fn read_small(path: &Path) -> Option<String> {
    String::from_utf8(fuz_sys::secure_file::load_bounded_file(path, SMALL_FILE_MAX).ok()?).ok()
}

fn stamp_path(h: &mut DefaultHasher, path: &Path) {
    path.hash(h);
    match fs::symlink_metadata(path) {
        Ok(meta) => (meta.ino(), meta.len(), meta.mtime(), meta.mtime_nsec()).hash(h),
        Err(_) => 0u8.hash(h),
    }
}

/// Stamps every file under `root`, in a stable order, up to
/// [`STAMP_REFS_MAX`]; past that, how many more there were.
fn stamp_tree(h: &mut DefaultHasher, root: &Path) {
    let mut stack = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut overflow = 0usize;
    while let Some(dir) = stack.pop() {
        stamp_path(h, &dir);
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if files.len() < STAMP_REFS_MAX {
                files.push(entry.path());
            } else {
                overflow += 1;
            }
        }
    }
    files.sort();
    for file in &files {
        stamp_path(h, file);
    }
    overflow.hash(h);
}

// -- The manager ----------------------------------------------------------------

/// A registry as `project_open` resolved it, for probing.
#[derive(Debug)]
pub struct RegistrySource {
    /// The project root.
    pub root: PathBuf,
    /// Every entry, in the registry's order.
    pub entries: Vec<Entry>,
    /// The canonical dir of each present entry, by key; an entry missing
    /// from it is missing or refused, and never probed.
    pub present: HashMap<String, PathBuf>,
    /// The entries not yet cloned, as the resolve found them; the rest
    /// that aren't present were refused, and aren't reported.
    pub missing: HashSet<String>,
    pub dirs: RegistryDirs,
}

impl RegistrySource {
    /// From a resolved registry's root and entries.
    pub fn new(root: &Path, entries: &[ProjectEntry]) -> Self {
        let all: Vec<Entry> = entries.iter().map(|e| e.entry.clone()).collect();
        let present = entries
            .iter()
            .filter_map(|e| match &e.dir {
                EntryDir::Present(dir) => Some((e.entry.key.clone(), dir.clone())),
                EntryDir::Missing | EntryDir::Refused(_) => None,
            })
            .collect();
        let missing = entries
            .iter()
            .filter(|e| matches!(e.dir, EntryDir::Missing))
            .map(|e| e.entry.key.clone())
            .collect();
        Self {
            root: root.to_path_buf(),
            missing,
            dirs: RegistryDirs::new(root, &all),
            entries: all,
            present,
        }
    }
}

/// One entry's probe state.
#[derive(Debug, Default)]
struct Slot {
    /// The stamp the last probe started under.
    stamp: Option<u64>,
    info: Option<RepoStatusInfo>,
    probed_at: Option<Instant>,
    hinted: bool,
    probing: bool,
    /// The id of the probe last started for it: only that probe lands.
    probe: u64,
}

#[derive(Debug)]
struct Registry {
    source: Arc<RegistrySource>,
    slots: HashMap<String, Slot>,
}

/// Why a poll was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollRefused {
    /// No status is held for the root: it isn't open, or isn't a registry.
    Unknown,
}

/// The status of every open registry project's entries (module docs).
#[derive(Debug)]
pub struct RepoStatusManager {
    registries: Mutex<HashMap<String, Registry>>,
    pool: Arc<Semaphore>,
    /// The next probe's id.
    next_probe: AtomicU64,
    /// How many probes ran git: a test seam.
    #[cfg(test)]
    runs: std::sync::atomic::AtomicUsize,
    /// [`HINT_MIN_INTERVAL`], but a seam for tests.
    hint_min_interval: Duration,
    /// [`SWEEP_AGE`], but a seam for tests.
    sweep_age: Duration,
}

impl Default for RepoStatusManager {
    fn default() -> Self {
        Self::new()
    }
}

/// One probe a poll starts.
struct Probe {
    id: u64,
    root: String,
    key: String,
    source: Arc<RegistrySource>,
}

impl RepoStatusManager {
    pub fn new() -> Self {
        Self::with_intervals(HINT_MIN_INTERVAL, SWEEP_AGE)
    }

    /// A manager re-probing hinted entries at most every
    /// `hint_min_interval`, and sweeping ones older than `sweep_age`.
    pub fn with_intervals(hint_min_interval: Duration, sweep_age: Duration) -> Self {
        Self {
            registries: Mutex::new(HashMap::new()),
            pool: Arc::new(Semaphore::new(PROBE_POOL)),
            next_probe: AtomicU64::new(1),
            #[cfg(test)]
            runs: std::sync::atomic::AtomicUsize::new(0),
            hint_min_interval,
            sweep_age,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Registry>> {
        // a panic mid-update leaves at worst a stale slot, re-probed later
        self.registries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Hold `source` for the registry project at `root` (trailing `/`), as
    /// its latest resolve found it; the slots of entries still in it stay.
    pub fn set_registry(&self, root: &str, source: RegistrySource) {
        let source = Arc::new(source);
        let mut registries = self.lock();
        match registries.get_mut(root) {
            Some(registry) => {
                registry
                    .slots
                    .retain(|key, _| source.present.contains_key(key));
                registry.source = source;
            }
            None => {
                registries.insert(
                    root.to_owned(),
                    Registry {
                        source,
                        slots: HashMap::new(),
                    },
                );
            }
        }
    }

    /// Drop what's held for `root`.
    pub fn forget(&self, root: &str) {
        self.lock().remove(root);
    }

    /// Drop every registry but those in `open`.
    pub fn retain(&self, open: &[&str]) {
        self.lock().retain(|root, _| open.contains(&root.as_str()));
    }

    /// Mark the entries whose checkout is `dir` (canonical, trailing `/` or
    /// not) edited: the next poll re-probes them, at most every
    /// [`HINT_MIN_INTERVAL`].
    pub fn hint(&self, dir: &str) {
        let dir = Path::new(dir.trim_end_matches('/'));
        let mut registries = self.lock();
        for registry in registries.values_mut() {
            for (key, present) in &registry.source.present {
                if present == dir {
                    registry.slots.entry(key.clone()).or_default().hinted = true;
                }
            }
        }
    }

    /// Every entry's last known status for the registry at `root`, starting
    /// the probes the stale ones need (module docs). `refresh` re-probes
    /// every present entry not already in flight.
    ///
    /// # Errors
    ///
    /// [`PollRefused::Unknown`] when nothing is held for `root`.
    pub async fn poll(
        self: &Arc<Self>,
        git: &Arc<Git>,
        root: &str,
        refresh: bool,
    ) -> Result<Vec<RepoStatusInfo>, PollRefused> {
        let source = self
            .lock()
            .get(root)
            .map(|r| Arc::clone(&r.source))
            .ok_or(PollRefused::Unknown)?;

        let stamping = Arc::clone(&source);
        let stamps: HashMap<String, Option<u64>> = tokio::task::spawn_blocking(move || {
            stamping
                .present
                .iter()
                .map(|(key, dir)| (key.clone(), stat_stamp(dir)))
                .collect()
        })
        .await
        .unwrap_or_default();

        let now = Instant::now();
        let (infos, probes) = {
            let mut registries = self.lock();
            let registry = registries.get_mut(root).ok_or(PollRefused::Unknown)?;
            // a resolve that landed while stamping replaced the source: its
            // entries are the ones to report, stamped on the next poll
            if !Arc::ptr_eq(&registry.source, &source) {
                return Ok(report(registry));
            }
            let mut probes = Vec::new();
            let mut sweep: Option<(&str, Instant)> = None;
            for entry in &source.entries {
                let Some(stamp) = stamps.get(&entry.key) else {
                    continue;
                };
                let slot = registry.slots.entry(entry.key.clone()).or_default();
                if slot.probing {
                    continue;
                }
                let stale = refresh
                    || slot.probed_at.is_none()
                    || slot.stamp != *stamp
                    || (slot.hinted
                        && slot
                            .probed_at
                            .is_some_and(|at| now.duration_since(at) >= self.hint_min_interval));
                if stale {
                    probes.push(entry.key.clone());
                } else if let Some(at) = slot.probed_at
                    && now.duration_since(at) >= self.sweep_age
                    && sweep.is_none_or(|(_, oldest)| at < oldest)
                {
                    sweep = Some((&entry.key, at));
                }
            }
            if probes.is_empty()
                && let Some((key, _)) = sweep
            {
                probes.push(key.to_owned());
            }
            let probes: Vec<Probe> = probes
                .into_iter()
                .map(|key| {
                    let slot = registry.slots.entry(key.clone()).or_default();
                    let id = self.next_probe.fetch_add(1, Ordering::Relaxed);
                    slot.probe = id;
                    slot.probing = true;
                    slot.hinted = false;
                    slot.stamp = stamps.get(&key).copied().flatten();
                    Probe {
                        id,
                        root: root.to_owned(),
                        key,
                        source: Arc::clone(&source),
                    }
                })
                .collect();
            (report(registry), probes)
        };
        for probe in probes {
            self.start_probe(Arc::clone(git), probe);
        }
        Ok(infos)
    }

    /// Run one probe on the pool and land its result.
    fn start_probe(self: &Arc<Self>, git: Arc<Git>, probe: Probe) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let Ok(_permit) = Arc::clone(&manager.pool).acquire_owned().await else {
                return;
            };
            // forgotten, or superseded, while it queued: run no git for it
            if !manager.is_current(&probe) {
                return;
            }
            #[cfg(test)]
            manager.runs.fetch_add(1, Ordering::Relaxed);
            let source = Arc::clone(&probe.source);
            let key = probe.key.clone();
            let probed = tokio::task::spawn_blocking(move || probe_entry(&git, &source, &key))
                .await
                .ok()
                .flatten();
            manager.land(&probe, probed);
        });
    }

    /// Whether `probe` is the one its slot last started.
    fn is_current(&self, probe: &Probe) -> bool {
        self.lock()
            .get(&probe.root)
            .and_then(|r| r.slots.get(&probe.key))
            .is_some_and(|slot| slot.probe == probe.id)
    }

    /// Land `probe`'s result in its slot, unless a newer probe superseded it
    /// (a reopen, or an entry dropped and re-added) — which then lands its
    /// own.
    fn land(&self, probe: &Probe, probed: Option<RepoStatusInfo>) {
        let mut registries = self.lock();
        let Some(slot) = registries
            .get_mut(&probe.root)
            .and_then(|r| r.slots.get_mut(&probe.key))
            .filter(|slot| slot.probe == probe.id)
        else {
            return;
        };
        slot.probing = false;
        match probed {
            Some(info) => {
                slot.info = Some(info);
                slot.probed_at = Some(Instant::now());
            }
            // a probe that panicked or found no entry: never probed, so the
            // next poll tries again
            None => slot.probed_at = None,
        }
    }
}

/// Every entry's status as held, in the registry's order, refused entries
/// left out.
fn report(registry: &Registry) -> Vec<RepoStatusInfo> {
    let source = &registry.source;
    source
        .entries
        .iter()
        .filter_map(|entry| {
            let slot = registry.slots.get(&entry.key);
            let mut info = match slot.and_then(|s| s.info.clone()) {
                Some(info) => info,
                None if source.present.contains_key(&entry.key) => {
                    RepoStatusInfo::pending(&entry.key)
                }
                None if source.missing.contains(&entry.key) => {
                    let mut info = RepoStatusInfo::pending(&entry.key);
                    info.state = RepoStatusState::Missing;
                    info
                }
                None => return None,
            };
            info.probing = slot.is_some_and(|s| s.probing);
            Some(info)
        })
        .collect()
}

/// `repos status`'s probe of one entry, from local refs.
fn probe_entry(git: &Git, source: &RegistrySource, key: &str) -> Option<RepoStatusInfo> {
    let entry = source.entries.iter().find(|e| e.key == key)?;
    let live = LiveSessions::Known(Vec::new());
    let run = status(
        std::slice::from_ref(entry),
        &source.dirs,
        &source.root,
        git,
        StatusOptions {
            fetch: false,
            refresh: Refresh::Unasked,
            unregistered: None,
            jobs: 1,
            visibility_base: None,
            live: &live,
        },
    );
    let probed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    run.entries
        .first()
        .map(|status| to_info(key, status, probed_at))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::process::Command;

    use fuz_repos::registry::ValidRegistry;

    use super::*;

    const REGISTRY: &str = r#"owners = ["me"]

[repos.app]
url = "https://github.com/me/app"
visibility = "public"
purpose = "an app"

[repos.site]
url = "https://github.com/me/site"
visibility = "public"
purpose = "a site"
"#;

    /// A registry root with `app` a checkout (one commit on `main`) and
    /// `site` missing.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("zzz_repo_status_{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("home")).unwrap();
            fs::create_dir_all(root.join("app")).unwrap();
            let root = root.canonicalize().unwrap();
            fs::write(root.join("repos.toml"), REGISTRY).unwrap();
            let f = Self { root };
            f.git(&["init", "-q"]);
            fs::write(f.app().join("a.txt"), "one\n").unwrap();
            f.git(&["add", "a.txt"]);
            f.git(&["commit", "-q", "-m", "one"]);
            f
        }

        fn app(&self) -> PathBuf {
            self.root.join("app")
        }

        fn env(&self) -> Vec<(OsString, OsString)> {
            vec![
                ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
                ("HOME".into(), self.root.join("home").into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ]
        }

        fn runner(&self) -> Arc<Git> {
            Arc::new(Git::with_clean_env(self.env()))
        }

        /// Runs git in `app`.
        fn git(&self, args: &[&str]) {
            let out = Command::new("git")
                .current_dir(self.app())
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@example.com",
                    "-c",
                    "init.defaultBranch=main",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .env_clear()
                .envs(self.env())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        fn source(&self) -> RegistrySource {
            let path = self.root.join("repos.toml");
            let registry = ValidRegistry::parse(REGISTRY, &path).unwrap();
            let entries: Vec<ProjectEntry> = registry
                .entries()
                .into_iter()
                .map(|entry| {
                    let dir = if entry.key == "app" {
                        EntryDir::Present(self.app())
                    } else {
                        EntryDir::Missing
                    };
                    ProjectEntry { entry, dir }
                })
                .collect();
            RegistrySource::new(&self.root, &entries)
        }

        fn key(&self) -> String {
            format!("{}/", self.root.display())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn find<'a>(infos: &'a [RepoStatusInfo], key: &str) -> &'a RepoStatusInfo {
        infos.iter().find(|i| i.key == key).unwrap()
    }

    /// Polls until no probe is in flight, then once more for the result.
    async fn settle(
        manager: &Arc<RepoStatusManager>,
        git: &Arc<Git>,
        root: &str,
    ) -> Vec<RepoStatusInfo> {
        for _ in 0..200 {
            let infos = manager.poll(git, root, false).await.unwrap();
            if infos
                .iter()
                .all(|i| !i.probing && i.state != RepoStatusState::Pending)
            {
                return infos;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("probes never settled");
    }

    #[test]
    fn the_stamp_moves_with_refs_and_the_index_but_not_an_edit() {
        let f = Fixture::new();
        let first = stat_stamp(&f.app()).unwrap();
        assert_eq!(
            stat_stamp(&f.app()),
            Some(first),
            "stable while nothing moves"
        );

        // editing a tracked file moves nothing under .git
        fs::write(f.app().join("a.txt"), "two\n").unwrap();
        assert_eq!(stat_stamp(&f.app()), Some(first));

        f.git(&["add", "a.txt"]);
        let staged = stat_stamp(&f.app()).unwrap();
        assert_ne!(staged, first, "the index moved");

        f.git(&["commit", "-q", "-m", "two"]);
        let committed = stat_stamp(&f.app()).unwrap();
        assert_ne!(committed, staged, "the branch moved");

        f.git(&["branch", "other"]);
        let branched = stat_stamp(&f.app()).unwrap();
        assert_ne!(branched, committed, "a new branch");

        fs::write(f.app().join("a.txt"), "three\n").unwrap();
        f.git(&["stash", "-q"]);
        assert_ne!(stat_stamp(&f.app()).unwrap(), branched, "a stash");
    }

    #[test]
    fn no_stamp_without_a_git_dir() {
        let f = Fixture::new();
        fs::create_dir_all(f.root.join("plain")).unwrap();
        assert_eq!(stat_stamp(&f.root.join("plain")), None);
    }

    #[test]
    fn a_gitfile_checkout_is_stamped_from_its_git_dir() {
        let f = Fixture::new();
        let linked = f.root.join("linked");
        f.git(&[
            "worktree",
            "add",
            "-q",
            linked.to_str().unwrap(),
            "-b",
            "wt",
        ]);
        let first = stat_stamp(&linked).unwrap();
        fs::write(linked.join("a.txt"), "wt\n").unwrap();
        Command::new("git")
            .current_dir(&linked)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(["commit", "-qam", "wt"])
            .env_clear()
            .envs(f.env())
            .output()
            .unwrap();
        assert_ne!(
            stat_stamp(&linked).unwrap(),
            first,
            "the linked worktree's branch moved"
        );
    }

    #[tokio::test]
    async fn a_poll_fills_in_and_reprobes_only_what_moved() {
        let f = Fixture::new();
        let git = f.runner();
        let manager = Arc::new(RepoStatusManager::with_intervals(
            Duration::ZERO,
            Duration::from_secs(3600),
        ));
        let root = f.key();
        manager.set_registry(&root, f.source());

        let first = manager.poll(&git, &root, false).await.unwrap();
        assert_eq!(first.len(), 2);
        let app = find(&first, "app");
        assert_eq!(app.state, RepoStatusState::Pending);
        assert!(app.probing, "the first poll starts its probe");
        assert_eq!(find(&first, "site").state, RepoStatusState::Missing);

        let settled = settle(&manager, &git, &root).await;
        let app = find(&settled, "app");
        assert_eq!(app.state, RepoStatusState::Ok, "{app:?}");
        assert_eq!(app.branch.as_deref(), Some("main"));
        assert_eq!(app.uncommitted, UncommittedInfo::default());
        let probed_at = app.probed_at.unwrap();

        // an edit moves no stamp, so without a hint nothing re-probes
        fs::write(f.app().join("a.txt"), "two\n").unwrap();
        let again = manager.poll(&git, &root, false).await.unwrap();
        let app = find(&again, "app");
        assert!(!app.probing);
        assert_eq!(app.uncommitted.unstaged, 0, "still the old status");

        // the filer's hint does
        manager.hint(&format!("{}/", f.app().display()));
        let hinted = manager.poll(&git, &root, false).await.unwrap();
        assert!(find(&hinted, "app").probing);
        let settled = settle(&manager, &git, &root).await;
        let app = find(&settled, "app");
        assert_eq!(app.uncommitted.unstaged, 1);
        assert!(app.probed_at.unwrap() >= probed_at);

        // a commit moves the stamp
        f.git(&["commit", "-qam", "two"]);
        let moved = manager.poll(&git, &root, false).await.unwrap();
        assert!(find(&moved, "app").probing);
        let settled = settle(&manager, &git, &root).await;
        assert_eq!(
            find(&settled, "app").uncommitted,
            UncommittedInfo::default()
        );

        // refresh re-probes regardless
        let refreshed = manager.poll(&git, &root, true).await.unwrap();
        assert!(find(&refreshed, "app").probing);
        settle(&manager, &git, &root).await;
    }

    #[tokio::test]
    async fn a_hint_waits_out_the_interval() {
        let f = Fixture::new();
        let git = f.runner();
        let manager = Arc::new(RepoStatusManager::with_intervals(
            Duration::from_secs(3600),
            Duration::from_secs(3600),
        ));
        let root = f.key();
        manager.set_registry(&root, f.source());
        settle(&manager, &git, &root).await;

        manager.hint(&f.app().display().to_string());
        let polled = manager.poll(&git, &root, false).await.unwrap();
        assert!(
            !find(&polled, "app").probing,
            "hinted too soon after the last probe"
        );
    }

    #[tokio::test]
    async fn the_sweep_reprobes_an_old_status() {
        let f = Fixture::new();
        let git = f.runner();
        let manager = Arc::new(RepoStatusManager::with_intervals(
            Duration::from_secs(3600),
            Duration::from_millis(200),
        ));
        let root = f.key();
        manager.set_registry(&root, f.source());
        settle(&manager, &git, &root).await;
        tokio::time::sleep(Duration::from_millis(250)).await;

        let polled = manager.poll(&git, &root, false).await.unwrap();
        assert!(find(&polled, "app").probing, "past the sweep age");
    }

    #[tokio::test]
    async fn a_forgotten_root_is_refused() {
        let f = Fixture::new();
        let git = f.runner();
        let manager = Arc::new(RepoStatusManager::new());
        let root = f.key();
        assert_eq!(
            manager.poll(&git, &root, false).await,
            Err(PollRefused::Unknown)
        );
        manager.set_registry(&root, f.source());
        assert!(manager.poll(&git, &root, false).await.is_ok());
        manager.forget(&root);
        assert_eq!(
            manager.poll(&git, &root, false).await,
            Err(PollRefused::Unknown)
        );
    }

    #[test]
    fn a_reftable_repo_is_stamped_from_its_table_list() {
        let f = Fixture::new();
        let rt = f.root.join("rt");
        fs::create_dir_all(&rt).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(&rt)
                .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .env_clear()
                .envs(f.env())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q", "--ref-format=reftable", "-b", "main"]);
        git(&["commit", "-q", "--allow-empty", "-m", "one"]);
        let first = stat_stamp(&rt).unwrap();
        git(&["branch", "other"]);
        assert_ne!(
            stat_stamp(&rt).unwrap(),
            first,
            "a new branch, in the tables"
        );
    }

    #[test]
    fn an_oversized_gitfile_makes_no_stamp() {
        let f = Fixture::new();
        let dir = f.root.join("big");
        fs::create_dir_all(&dir).unwrap();
        let text = format!("gitdir: {}\n", "x".repeat(8192));
        fs::write(dir.join(".git"), text).unwrap();
        assert_eq!(stat_stamp(&dir), None);
    }

    #[tokio::test]
    async fn a_superseded_probe_lands_nowhere() {
        let f = Fixture::new();
        let git = f.runner();
        let manager = Arc::new(RepoStatusManager::new());
        let root = f.key();
        manager.set_registry(&root, f.source());
        let settled = settle(&manager, &git, &root).await;
        let before = find(&settled, "app").clone();

        let stale = Probe {
            id: 0,
            root: root.clone(),
            key: "app".to_owned(),
            source: Arc::new(f.source()),
        };
        assert!(!manager.is_current(&stale));
        let mut other = before.clone();
        other.branch = Some("stale".to_owned());
        manager.land(&stale, Some(other));
        let polled = manager.poll(&git, &root, false).await.unwrap();
        assert_eq!(find(&polled, "app").branch, before.branch);
    }

    #[tokio::test]
    async fn a_probe_superseded_while_queued_never_runs() {
        let f = Fixture::new();
        let git = f.runner();
        let manager = Arc::new(RepoStatusManager::new());
        let root = f.key();
        manager.set_registry(&root, f.source());
        // the pool held, so the probe queues
        let held = Arc::clone(&manager.pool)
            .acquire_many_owned(u32::try_from(PROBE_POOL).unwrap())
            .await
            .unwrap();
        let polled = manager.poll(&git, &root, false).await.unwrap();
        assert!(find(&polled, "app").probing);
        manager.forget(&root);
        manager.set_registry(&root, f.source());
        drop(held);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(manager.runs.load(Ordering::Relaxed), 0);
        // the reopened root probes afresh
        settle(&manager, &git, &root).await;
        assert_eq!(manager.runs.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn a_missing_entry_stays_missing_until_resolved_again() {
        let f = Fixture::new();
        let git = f.runner();
        let manager = Arc::new(RepoStatusManager::new());
        let root = f.key();
        manager.set_registry(&root, f.source());
        // cloned after the resolve: still reported as the resolve found it
        fs::create_dir_all(f.root.join("site")).unwrap();
        let polled = manager.poll(&git, &root, false).await.unwrap();
        assert_eq!(find(&polled, "site").state, RepoStatusState::Missing);
    }

    #[test]
    fn the_primary_operation_is_in_progress_and_a_worktrees_is_its_reason() {
        let f = Fixture::new();
        let git = f.runner();
        let source = f.source();
        // a merge stopped in the primary: said by `in_progress` alone
        let head = fs::read_to_string(f.app().join(".git/HEAD")).unwrap();
        let commit = {
            let r = head.trim().strip_prefix("ref: ").unwrap();
            fs::read_to_string(f.app().join(".git").join(r)).unwrap()
        };
        fs::write(f.app().join(".git/MERGE_HEAD"), &commit).unwrap();
        let info = probe_entry(&git, &source, "app").unwrap();
        assert_eq!(info.in_progress.as_deref(), Some("merge"));
        assert!(
            !info
                .needs_human
                .iter()
                .any(|k| k == "operation_in_progress"),
            "{:?}",
            info.needs_human
        );

        // and one in a linked worktree too: that one is the reason
        let linked = f.root.join("linked");
        f.git(&[
            "worktree",
            "add",
            "-q",
            linked.to_str().unwrap(),
            "-b",
            "wt",
        ]);
        let wt_git = f.app().join(".git/worktrees/linked");
        fs::write(wt_git.join("MERGE_HEAD"), &commit).unwrap();
        let info = probe_entry(&git, &source, "app").unwrap();
        assert_eq!(info.in_progress.as_deref(), Some("merge"));
        assert_eq!(
            info.needs_human
                .iter()
                .filter(|k| *k == "operation_in_progress")
                .count(),
            1,
            "{:?}",
            info.needs_human
        );
    }

    #[test]
    fn relations_keep_their_counts() {
        assert_eq!(
            to_relation(Relation::Diverged {
                ahead: 2,
                behind: 3
            }),
            RelationInfo {
                kind: "diverged",
                ahead: 2,
                behind: 3
            }
        );
        assert_eq!(to_relation(Relation::Behind { commits: 4 }).behind, 4);
        assert_eq!(to_relation(Relation::Gone).kind, "gone");
    }
}
