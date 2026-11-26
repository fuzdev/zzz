//! The open projects: their state, and the one path that changes it.
//!
//! [`ProjectManager`] owns which projects are open and what each focuses.
//! Everything else that follows from that — the filers running for them, the
//! `ScopedFs` roots admitting them, what `project_list` and `session_load`
//! report — is derived from that state in one place, `ProjectManager::commit`:
//! an open, close, focus, or unfocus computes the next state and commits it,
//! and the commit starts the filers the next state needs, stops or narrows
//! the ones it doesn't, sets the roots, publishes the snapshot readers see,
//! and broadcasts `project_changed` — all under the lock that guards the
//! state, so those stay in step and notifications for one root go out in the
//! order its changes took effect.
//!
//! Every commit that changes the state bumps the manager's **rev** and
//! stamps it on what changed ([`OpenProject::rev`]), so every reply and
//! `project_changed` carries the rev its state was committed at, and the
//! published snapshot the rev it was taken at ([`PublishedProjects::rev`]).
//! A client applies a project's state only when its rev is newer than the
//! one it holds, so the order replies and notifications reach it in — over
//! one socket, two, or HTTP — doesn't matter. A reply's files are read
//! under the lock its change committed under, so they're the index of
//! exactly the state its rev names. The counter starts at the clock
//! (`rev_seed`), so revs keep increasing across restarts.
//!
//! Each commit also refreshes what git ignores, and the repos of their own
//! the filer leaves unindexed, under every focused dir on git's rule
//! ([`OpenProject::ignored`]), read from the filers under the
//! lock: a change there is a change of the project's state, stamped and
//! broadcast like any other. A filer whose set changes on its own (an edit
//! to a `.gitignore`, a live-vetted file) asks for that commit
//! ([`ProjectManager::refresh_ignored`]) from a task of its own, never
//! waiting on the lock itself.
//!
//! What a project keeps indexed is [`filers_of`]: a registry's root at its
//! top level, and each focused directory whole. Two projects can keep one
//! directory (a registry's entry that's also open as its own project), so
//! what runs is the union over the open projects, each directory at the
//! deepest any of them indexes it (`desired_filers`) — never a count kept
//! by hand.
//!
//! An initial scan walks, watches, and stats a whole tree, so an open or a
//! focus starts its filers *before* taking the lock, where other projects'
//! changes don't wait on it; the commit then finds them running. If the
//! operation fails after that, what it started and the open projects don't
//! keep is released under the lock (`release`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use fuz_realtime::notify_to_string;
use fuz_repos::registry::EntryKind;
use serde::Serialize;

use crate::filer::{
    FilerConfig, FilerDepth, FilerLifetime, IgnoredPaths, SerializableDisknode, WatchStatus,
};
use crate::handlers::App;
use crate::repo_status::RegistrySource;

// -- State ----------------------------------------------------------------------

/// An open project as the manager holds it. [`ProjectInfo`] is its wire
/// projection ([`Self::to_info`]).
///
/// Equality is the project's state and leaves out [`Self::rev`], which says
/// when the state last changed: comparing a project with its next state
/// tells whether anything changed, and so whether a commit stamps a new rev.
#[derive(Debug, Clone)]
pub struct OpenProject {
    /// The root, canonical, with a trailing `/` — the project's identity.
    pub root: String,
    /// The root's basename.
    pub name: String,
    /// When it was first opened (RFC 3339).
    pub opened_at: String,
    pub kind: OpenKind,
    /// The registry passed over to root it here, when one was
    /// ([`crate::project::Fallback`]) — as the latest resolve found it.
    pub fallback: Option<OpenFallback>,
    /// What git ignores under each focused dir whose filer is on git's
    /// rule, keyed by the dir — none for a dir on fixed names. Filled by
    /// every commit from the filers (`ProjectManager::commit`); empty on
    /// a project as resolved.
    pub ignored: BTreeMap<String, IgnoredPaths>,
    /// The manager's rev at the commit that last changed this project
    /// (`ProjectManager::commit`); 0 for a project as resolved, not yet
    /// committed.
    pub rev: u64,
}

impl PartialEq for OpenProject {
    fn eq(&self, other: &Self) -> bool {
        // `rev` left out on purpose — see the type's docs; destructured, so
        // a field added to the type can't be left out of equality unnoticed
        let Self {
            root,
            name,
            opened_at,
            kind,
            fallback,
            ignored,
            rev: _,
        } = self;
        *root == other.root
            && *name == other.name
            && *opened_at == other.opened_at
            && *kind == other.kind
            && *fallback == other.fallback
            && *ignored == other.ignored
    }
}

impl Eq for OpenProject {}

/// Which rule rooted an open project ([`crate::project::ProjectKind`]).
///
/// Only a registry has entries and a focus to change; a checkout's or plain
/// directory's one focus is its root, for as long as it's open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenKind {
    Registry {
        /// The registry file as found at the root.
        registry_path: String,
        /// The entries, in the registry's order.
        entries: Vec<OpenEntry>,
        /// The focused entries' dirs (trailing `/`), each indexed whole: the
        /// present entries an open or `repo_focus` focused. May be empty.
        focused: BTreeSet<String>,
    },
    GitRepo,
    PlainDir,
}

/// Why an open checkout or plain directory isn't the registry found above
/// it ([`crate::project::Fallback`]) — on the wire as is, the twin of
/// `ProjectFallbackJson`, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenFallback {
    /// The opened directory is in none of the registry's present entries.
    Unregistered { registry_path: String },
    /// The registry was refused, for `reason` (a `ProjectError` reason, or
    /// `registry_root_in_entry`).
    RegistryRefused {
        registry_path: String,
        reason: &'static str,
    },
}

/// A registry entry of an open project ([`crate::project::ProjectEntry`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenEntry {
    /// The entry's key in its table.
    pub key: String,
    pub kind: EntryKind,
    /// Where its checkout is (trailing `/`): canonical when present, else
    /// the declared dir under the root.
    pub dir: String,
    pub state: EntryState,
}

/// Where an entry's checkout stands, as the project's last resolve left it
/// ([`crate::project::EntryDir`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryState {
    /// Focusable.
    Present,
    /// Not yet cloned.
    Missing,
    /// Refused alone, for `reason`: `EntryRefusal::reason`, or `invalid_path`
    /// for a present dir whose path isn't UTF-8.
    Refused { reason: &'static str },
}

impl OpenProject {
    /// The focused directories, sorted: a registry's focused entries, or a
    /// checkout's or plain directory's root.
    pub fn focused(&self) -> Vec<&str> {
        match &self.kind {
            OpenKind::Registry { focused, .. } => focused.iter().map(String::as_str).collect(),
            OpenKind::GitRepo | OpenKind::PlainDir => vec![self.root.as_str()],
        }
    }

    /// The project as the wire carries it.
    pub fn to_info(&self) -> ProjectInfo {
        let (kind, registry_path, entries) = match &self.kind {
            OpenKind::Registry {
                registry_path,
                entries,
                ..
            } => (
                ProjectInfoKind::Registry,
                Some(registry_path.clone()),
                entries.iter().map(OpenEntry::to_info).collect(),
            ),
            OpenKind::GitRepo => (ProjectInfoKind::GitRepo, None, Vec::new()),
            OpenKind::PlainDir => (ProjectInfoKind::PlainDir, None, Vec::new()),
        };
        ProjectInfo {
            root: self.root.clone(),
            name: self.name.clone(),
            opened_at: self.opened_at.clone(),
            kind,
            registry_path,
            entries,
            fallback: self.fallback.clone(),
            focused: self.focused().into_iter().map(str::to_owned).collect(),
            ignored: self.ignored.clone(),
            rev: self.rev,
        }
    }
}

impl OpenEntry {
    /// The entry as the wire carries it.
    fn to_info(&self) -> ProjectEntryInfo {
        let (state, reason) = match self.state {
            EntryState::Present => (ProjectEntryState::Present, None),
            EntryState::Missing => (ProjectEntryState::Missing, None),
            EntryState::Refused { reason } => (ProjectEntryState::Refused, Some(reason)),
        };
        ProjectEntryInfo {
            key: self.key.clone(),
            kind: match self.kind {
                EntryKind::Repo => EntryInfoKind::Repo,
                EntryKind::Reference => EntryInfoKind::Reference,
            },
            dir: self.dir.clone(),
            state,
            reason,
        }
    }
}

// -- Wire -----------------------------------------------------------------------

/// An open project — twin of `ProjectInfoJson` in `project.svelte.ts`. Built
/// from an [`OpenProject`], never stored: its flat shape admits states the
/// domain type rules out.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub opened_at: String,
    pub kind: ProjectInfoKind,
    /// The registry file, for a registry project.
    pub registry_path: Option<String>,
    /// A registry's entries, in its order; empty for other kinds.
    pub entries: Vec<ProjectEntryInfo>,
    /// The registry passed over, for a checkout or plain directory found
    /// under one.
    pub fallback: Option<OpenFallback>,
    /// The focused directories (trailing `/`), sorted ([`OpenProject::focused`]).
    pub focused: Vec<String>,
    /// What git ignores under each focused dir on git's rule
    /// ([`OpenProject::ignored`]); a focused dir missing from it is on fixed
    /// names, and a registry's root, indexed at its top level, never has an
    /// entry.
    pub ignored: BTreeMap<String, IgnoredPaths>,
    /// The rev at which this project last changed ([`OpenProject::rev`]) —
    /// on a close, the close's own. A client applies a project's state only
    /// when its rev is newer than the one it holds.
    pub rev: u64,
}

/// Which rule rooted a project ([`OpenKind`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectInfoKind {
    Registry,
    GitRepo,
    PlainDir,
}

/// A registry entry of an open project — twin of `ProjectEntryJson`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectEntryInfo {
    pub key: String,
    pub kind: EntryInfoKind,
    pub dir: String,
    pub state: ProjectEntryState,
    /// Why it's refused, for a refused entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// A registry's two tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryInfoKind {
    Repo,
    Reference,
}

/// Where an entry's checkout stands ([`EntryState`], its reason aside).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectEntryState {
    Present,
    Missing,
    Refused,
}

/// What a `project_changed` notification reports.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProjectChange {
    /// Newly open.
    Open,
    /// Already open, and now different: a new focus, or the registry's
    /// entries as resolved again.
    Update,
    Close,
}

#[derive(Serialize)]
struct ProjectChangedParams {
    #[serde(rename = "type")]
    change_type: ProjectChange,
    project: ProjectInfo,
}

/// The directories to index, each with how much of it ([`filers_of`],
/// `desired_filers`).
pub type Filers = BTreeMap<String, FilerDepth>;

/// The open projects, keyed by root (trailing `/`).
type Projects = BTreeMap<String, OpenProject>;

/// What readers that don't take the lock see: the state as the last commit
/// left it ([`ProjectManager::published`]).
#[derive(Debug, Default)]
pub struct PublishedProjects {
    /// The open projects, by root.
    pub projects: Vec<OpenProject>,
    /// The directories those projects keep indexed (`desired_filers`). A
    /// filer running on any other directory belongs to no open project — a
    /// permanent one, or one an open or focus in flight started.
    pub filers: BTreeSet<String>,
    /// The manager's rev when these were published: every change to
    /// `projects` up to it is in them, and none after.
    pub rev: u64,
}

/// Why an open, close, focus, or unfocus didn't take effect, or a read of a
/// focus ([`ProjectManager::focused_files`]) was refused.
#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    /// The root names no open project.
    #[error("project not open: {root}")]
    NotOpen { root: String },
    /// A read of a directory that's none of the open project's focused
    /// directories.
    #[error("{dir} isn't a focused repo of {root}")]
    NotFocused { root: String, dir: String },
    /// A focus or unfocus on a checkout or plain directory, whose one focus
    /// is its root, kept while it's open.
    #[error("{root} isn't a registry project — its root is its one focus")]
    NotRegistry { root: String },
    /// The directory is none of the registry's entries.
    #[error("{dir} is none of the registry entries of {root}")]
    RepoNotInProject { root: String, dir: String },
    /// A focus on an entry not cloned as the project last resolved it.
    #[error(
        "registry entry {key} isn't cloned at {dir} (opening a path in it resolves the registry again)"
    )]
    RepoMissing { key: String, dir: String },
    /// A focus on an entry the last resolve refused.
    #[error("registry entry {key} at {dir} is refused: {reason}")]
    RepoRefused {
        key: String,
        dir: String,
        reason: &'static str,
    },
    /// A directory the next state needs indexed can't be listed. Nothing
    /// changed.
    #[error("can't index {dir}")]
    Filer {
        dir: String,
        #[source]
        source: std::io::Error,
    },
    /// The change took effect, and its `project_changed` couldn't be built.
    #[error("notification params serialize failed")]
    Notify(#[source] serde_json::Error),
}

/// An open or focus as it landed: the project, and the files its reply
/// carries.
///
/// The files are read under the lock the change committed under, so they're
/// the index of exactly the state `project.rev` names (see
/// [`ProjectManager::open`]).
#[derive(Debug)]
pub struct Landed {
    pub project: OpenProject,
    /// An open's: every directory the project keeps indexed. A focus's: the
    /// focused repo's alone.
    pub files: Vec<SerializableDisknode>,
    /// Over every directory the project keeps indexed.
    pub watch_status: WatchStatus,
}

/// An open as it landed ([`ProjectManager::open`]): the project and its
/// files, whether the open created it, and each requested focus that didn't
/// land.
#[derive(Debug)]
pub struct Opened {
    pub landed: Landed,
    /// Whether this open created the project, rather than merging into one
    /// already open. A client that closed the project while its open was in
    /// flight closes it again only when its own open created it — merged,
    /// someone else opened it since the close.
    pub opened: bool,
    /// Those refused before the lock — by the fresh resolve, then by a
    /// listing that failed — then those whose filer was stopped by the time
    /// the lock was taken, each group in the order requested. A focus
    /// refused before the lock that a racing commit focused since landed,
    /// and isn't among them.
    pub refused: Vec<FocusRefused>,
}

/// A focus an open was asked for that didn't land, and why.
///
/// The error is [`LifecycleError::RepoNotInProject`],
/// [`LifecycleError::RepoMissing`], [`LifecycleError::RepoRefused`],
/// [`LifecycleError::NotRegistry`], or [`LifecycleError::Filer`].
#[derive(Debug)]
pub struct FocusRefused {
    /// The directory as requested (trailing `/`).
    pub dir: String,
    pub error: LifecycleError,
}

/// A focused directory's index as one commit left it
/// ([`ProjectManager::focused_files`]).
#[derive(Debug)]
pub struct FocusedFiles {
    /// The files of the directory's filer.
    pub files: Vec<SerializableDisknode>,
    /// Over every directory the project keeps indexed, as an open's.
    pub watch_status: WatchStatus,
    /// The project's rev when they were read ([`OpenProject::rev`]): at or
    /// after the commit that focused the directory, so a client holding a
    /// later focus of it can tell a read of an earlier one.
    pub rev: u64,
}

// -- Derivations ----------------------------------------------------------------

/// The filers a project keeps, each a directory key and what it indexes.
///
/// A registry's root at its top level, and every focused directory whole.
/// The root of a checkout or plain directory is its one focused directory.
pub fn filers_of(project: &OpenProject) -> Filers {
    let mut filers: Filers = project
        .focused()
        .into_iter()
        .map(|dir| (dir.to_owned(), FilerDepth::Tree))
        .collect();
    filers
        .entry(project.root.clone())
        .or_insert(FilerDepth::TopLevel);
    filers
}

/// What `projects` keep of each directory: the deepest any of them indexes
/// it.
fn desired_filers<'a>(projects: impl IntoIterator<Item = &'a OpenProject>) -> Filers {
    let mut desired = Filers::new();
    for project in projects {
        deepen(&mut desired, &filers_of(project));
    }
    desired
}

/// Add `more` to `filers`, keeping the deeper of two depths for a directory.
fn deepen(filers: &mut Filers, more: &Filers) {
    for (dir, depth) in more {
        let entry = filers.entry(dir.clone()).or_insert(*depth);
        if *depth == FilerDepth::Tree {
            *entry = FilerDepth::Tree;
        }
    }
}

/// `existing` updated by a fresh resolve of the same root: the fresh kind,
/// entries, and fallback — why the root is where it is now, which changes
/// with the registry above as the kind does (one passed over as untrusted,
/// then trusted and listing nothing that holds the path) — and the focused
/// directories of both that the fresh resolve still supports — a present
/// entry's dir for a registry, the root for a checkout or plain directory.
/// So a focus outlives no change of kind (a plain `~/dev` focused on its
/// root, then a registry there) and no entry removed or gone missing.
pub(crate) fn merge_project(existing: &OpenProject, fresh: &OpenProject) -> OpenProject {
    let mut merged = OpenProject {
        opened_at: existing.opened_at.clone(),
        // what the filers last said, until the commit reads them again — so
        // comparing the merge with `existing` sees only the resolve's change
        ignored: existing.ignored.clone(),
        // the rev it last changed at, until a commit stamps a change
        rev: existing.rev,
        ..fresh.clone()
    };
    // a checkout's or plain directory's one focus is its root, as fresh
    if let OpenKind::Registry {
        entries, focused, ..
    } = &mut merged.kind
    {
        let supported = |dir: &str| {
            entries
                .iter()
                .any(|entry| entry.state == EntryState::Present && entry.dir == dir)
        };
        let kept: Vec<String> = existing
            .focused()
            .into_iter()
            .filter(|dir| supported(dir))
            .map(str::to_owned)
            .collect();
        focused.extend(kept);
    }
    merged
}

/// The focus of `project` to change — refused when it isn't a registry,
/// whose one focus is its root.
fn focused_mut(project: &mut OpenProject) -> Result<&mut BTreeSet<String>, LifecycleError> {
    match &mut project.kind {
        OpenKind::Registry { focused, .. } => Ok(focused),
        OpenKind::GitRepo | OpenKind::PlainDir => Err(LifecycleError::NotRegistry {
            root: project.root.clone(),
        }),
    }
}

/// The entry of `project` whose checkout is `dir` — refused when `project`
/// isn't a registry or has no such entry.
fn entry_of<'a>(project: &'a OpenProject, dir: &str) -> Result<&'a OpenEntry, LifecycleError> {
    let OpenKind::Registry { entries, .. } = &project.kind else {
        return Err(LifecycleError::NotRegistry {
            root: project.root.clone(),
        });
    };
    entries
        .iter()
        .find(|entry| entry.dir == dir)
        .ok_or_else(|| LifecycleError::RepoNotInProject {
            root: project.root.clone(),
            dir: dir.to_owned(),
        })
}

/// Check that `dir` is a present registry entry of `project` — what a focus
/// can focus.
fn check_focusable(project: &OpenProject, dir: &str) -> Result<(), LifecycleError> {
    let entry = entry_of(project, dir)?;
    match entry.state {
        EntryState::Present => Ok(()),
        EntryState::Missing => Err(LifecycleError::RepoMissing {
            key: entry.key.clone(),
            dir: dir.to_owned(),
        }),
        EntryState::Refused { reason } => Err(LifecycleError::RepoRefused {
            key: entry.key.clone(),
            dir: dir.to_owned(),
            reason,
        }),
    }
}

/// Split the focuses an open of `fresh` was asked for into those to scan
/// and those refused by the fresh resolve, by the rule [`merge_project`]
/// keeps a focus by: a present entry of a registry. Duplicates collapse; a
/// focus `fresh` has already (the opened path's) lands without a scan of
/// its own. A checkout's or plain directory's root is its one focus, so a
/// request for it lands and any other is [`LifecycleError::NotRegistry`] —
/// refused per directory rather than failing the open, since a client
/// reopening a registry can't know it's since become a checkout.
fn check_requested(fresh: &OpenProject, requested: &[String]) -> (Vec<String>, Vec<FocusRefused>) {
    let focused = fresh.focused();
    let mut seen = BTreeSet::new();
    let mut wanted = Vec::new();
    let mut refused = Vec::new();
    for dir in requested {
        let dir = with_trailing_slash(dir.clone());
        if focused.contains(&dir.as_str()) || !seen.insert(dir.clone()) {
            continue;
        }
        match check_focusable(fresh, &dir) {
            Ok(()) => wanted.push(dir),
            Err(error) => refused.push(FocusRefused { dir, error }),
        }
    }
    (wanted, refused)
}

/// `key` as a directory key: with a trailing `/`.
fn with_trailing_slash(mut key: String) -> String {
    if !key.ends_with('/') {
        key.push('/');
    }
    key
}

// -- Filers ---------------------------------------------------------------------

/// The index of every filer in `filers`, deduplicated by path.
async fn files_of(app: &App, filers: &Filers) -> Vec<SerializableDisknode> {
    let mut files: BTreeMap<String, SerializableDisknode> = BTreeMap::new();
    for dir in filers.keys() {
        for file in app.filer_manager.files_for(dir).await {
            files.entry(file.id.clone()).or_insert(file);
        }
    }
    files.into_values().collect()
}

/// Whether every filer in `filers` has every directory watched.
async fn watch_status_of(app: &App, filers: &Filers) -> WatchStatus {
    for dir in filers.keys() {
        if app.filer_manager.watch_status_for(dir).await == WatchStatus::Degraded {
            return WatchStatus::Degraded;
        }
    }
    WatchStatus::Full
}

/// Start every filer in `filers`, or find the ones already running —
/// failing at the first that can't start.
async fn ensure_filers(app: &Arc<App>, filers: &Filers) -> Result<(), LifecycleError> {
    for (dir, depth) in filers {
        let config = match depth {
            FilerDepth::Tree => FilerConfig::tree(dir, &app.zzz_dir),
            FilerDepth::TopLevel => FilerConfig::top_level(dir, &app.zzz_dir),
        };
        app.filer_manager
            .start_filer(dir, Arc::clone(app), config, FilerLifetime::Project)
            .await
            .map_err(|source| LifecycleError::Filer {
                dir: dir.clone(),
                source,
            })?;
    }
    Ok(())
}

/// Release what `was` kept that `now` doesn't: a directory `now` lacks has
/// its filer stopped, and one kept whole that `now` keeps at its top level
/// alone is narrowed to that. Permanent filers (the app dir, the scoped
/// dirs) are left as they are by both.
///
/// Neither can fail: a narrowing whose new filer can't start leaves the
/// whole-tree one, which indexes more than needed, not less.
async fn release(app: &Arc<App>, was: &Filers, now: &Filers) {
    for (dir, depth) in was {
        match now.get(dir) {
            None => {
                app.filer_manager.stop_filer(dir).await;
            }
            Some(FilerDepth::TopLevel) if *depth == FilerDepth::Tree => {
                let config = FilerConfig::top_level(dir, &app.zzz_dir);
                if let Err(e) = app
                    .filer_manager
                    .narrow_filer(dir, Arc::clone(app), config)
                    .await
                {
                    tracing::warn!(
                        path = %dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "failed to narrow a root's filer to its top level; it stays whole"
                    );
                }
            }
            Some(_) => {}
        }
    }
}

// -- Manager --------------------------------------------------------------------

/// The open projects and the lock their changes take — see the module docs.
///
/// Each of [`Self::open`], [`Self::close`], [`Self::close_all`],
/// [`Self::focus`], and [`Self::unfocus`] must run to completion: a commit
/// dropped partway leaves the state, the filers, and the snapshot out of
/// step. The spine cancels a socket's in-flight handlers when it closes, so
/// a caller runs each in its own task.
#[derive(Debug)]
pub struct ProjectManager {
    /// The open projects. Holding this guard is the only way to change
    /// them, to stop or narrow a filer, and to set the `ScopedFs` roots and
    /// [`Self::published`]. A scan before the lock starts or widens filers;
    /// nothing else does without it. A read that must see filers and state
    /// agree takes it too ([`Self::focused_files`]).
    projects: tokio::sync::Mutex<Projects>,
    /// The state as the last commit left it, for readers that don't wait on
    /// the lock.
    published: parking_lot::RwLock<Arc<PublishedProjects>>,
    /// The lifecycle rev: bumped by every commit that changes the state, and
    /// stamped on what it changed ([`OpenProject::rev`]), so a client can
    /// tell newer project state from older whatever order replies and
    /// notifications reach it in. Written only under `projects`' lock — the
    /// atomic is for the type system, the lock orders it; read outside the
    /// lock only through [`Self::published`].
    rev: AtomicU64,
}

/// The rev a manager starts at: microseconds since the Unix epoch at boot,
/// so revs keep increasing across a daemon restart — each commit bumps by
/// one, and no daemon commits a million times a second — and a client
/// holding revs from the last boot takes the new daemon's state as newer. A
/// clock that stepped back breaks that; a client resets what it holds on a
/// new `server_instance_id` anyway, so it costs a resync, not wrong state.
///
/// Microseconds since the epoch stay under 2^53 until the year 2255, so a
/// rev is exact as a JSON number (an IEEE double) on every client. A clock
/// before the epoch seeds 0.
fn rev_seed(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).map_or(0, |since| {
        u64::try_from(since.as_micros()).unwrap_or(u64::MAX)
    })
}

impl Default for ProjectManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectManager {
    /// A manager with no project open, its rev seeded from the clock
    /// (`rev_seed`).
    pub fn new() -> Self {
        Self::with_rev_seed(rev_seed(SystemTime::now()))
    }

    /// A manager whose rev starts at `seed` — [`Self::new`]'s clock reading,
    /// or a test's.
    pub(crate) fn with_rev_seed(seed: u64) -> Self {
        Self {
            projects: tokio::sync::Mutex::default(),
            published: parking_lot::RwLock::new(Arc::new(PublishedProjects {
                rev: seed,
                ..PublishedProjects::default()
            })),
            rev: AtomicU64::new(seed),
        }
    }

    /// The open projects and the directories they keep indexed, as the last
    /// commit left them. Never a state in the making: an open is published
    /// only once its filers run and its root is in scope.
    pub fn published(&self) -> Arc<PublishedProjects> {
        Arc::clone(&self.published.read())
    }

    /// The index of `dir`, a focused directory of the open project at
    /// `root` — a registry's focused entry, or a checkout's or plain
    /// directory's root — read under the lock every commit holds.
    ///
    /// A commit stops or narrows filers (`release`) before it publishes,
    /// so a check against [`Self::published`] and a read of the filer
    /// outside the lock could pass the check and read a filer already
    /// stopped (no files) or narrowed (a nested registry's top level) — an
    /// answer no state ever held. Under the lock, the check and the read see
    /// one state: no commit is partway, and every filer the state keeps runs
    /// at least as deep as it keeps it.
    ///
    /// Lock order: this mutex, then `FilerManager`'s filer map (read, let go
    /// before the next), then one filer's index (read) — the order a commit
    /// takes them in, through `ensure_filers`, `release`, and
    /// `check_invariants`. Nothing that holds the filer map or an index
    /// takes this mutex (the filers never touch the projects), so the read
    /// can't deadlock against a commit; it waits for one, and a commit waits
    /// for it to clone the index.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`]; [`LifecycleError::NotFocused`] for a
    /// directory the project doesn't focus — refused rather than answered
    /// with no files, which an empty repo would read as.
    pub async fn focused_files(
        &self,
        app: &App,
        root: &str,
        dir: &str,
    ) -> Result<FocusedFiles, LifecycleError> {
        let projects = self.projects.lock().await;
        let project = projects.get(root).ok_or_else(|| LifecycleError::NotOpen {
            root: root.to_owned(),
        })?;
        if !project.focused().contains(&dir) {
            return Err(LifecycleError::NotFocused {
                root: root.to_owned(),
                dir: dir.to_owned(),
            });
        }
        let files = app.filer_manager.files_for(dir).await;
        let watch_status = watch_status_of(app, &filers_of(project)).await;
        let rev = project.rev;
        drop(projects);
        Ok(FocusedFiles {
            files,
            watch_status,
            rev,
        })
    }

    /// Open `fresh` — a project as just resolved, focusing what the open
    /// focuses — or update the open project at its root with it
    /// (`merge_project`): the fresh kind and entries, the focus of both.
    /// `requested` are more directories to focus once it lands, each checked
    /// against `fresh` (`check_requested`) and landing or refused alone.
    ///
    /// The filers `fresh` itself keeps (its root, the opened path's focus)
    /// are required: one that can't start fails the open. A requested focus
    /// is scanned before the lock like them, but one that can't be listed —
    /// then, or under the lock, where a racing unfocus may have stopped its
    /// filer since — is refused alone and the rest of the open lands. Under
    /// the lock each landing focus's filer is ensured before the commit, so
    /// the commit's own ensure finds every filer running and can fail only
    /// on a required one, as before.
    ///
    /// Broadcasts `project_changed` — `open` for a new project, `update` for
    /// an open one this changed, nothing for one it didn't — stamped with the
    /// commit's rev; one it didn't change keeps the rev it last changed at.
    /// The files of every directory the project keeps are read before the
    /// lock drops, so they're the index at the returned project's rev.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::Filer`] when the root or the opened path's focus
    /// can't be listed, leaving nothing new open; [`LifecycleError::Notify`].
    pub async fn open(
        &self,
        app: &Arc<App>,
        fresh: OpenProject,
        requested: &[String],
    ) -> Result<Opened, LifecycleError> {
        self.open_with_registry(app, fresh, requested, None).await
    }

    /// [`Self::open`], also holding `registry` — the resolve's entries, for a
    /// registry project — for its repo status
    /// (`RepoStatusManager::set_registry`) once the open commits, under the
    /// lock, so it follows the commit order: a close of the root that commits
    /// first can't drop it, and one that commits after drops it.
    ///
    /// # Errors
    ///
    /// As [`Self::open`].
    pub async fn open_with_registry(
        &self,
        app: &Arc<App>,
        fresh: OpenProject,
        requested: &[String],
        registry: Option<RegistrySource>,
    ) -> Result<Opened, LifecycleError> {
        let (wanted, mut refused) = check_requested(&fresh, requested);

        // the scans run before the lock (see the module docs); a required
        // directory that can't be listed fails the open here, before
        // anything is recorded
        let mut started = filers_of(&fresh);
        if let Err(error) = ensure_filers(app, &started).await {
            let projects = self.projects.lock().await;
            release(app, &started, &desired_filers(projects.values())).await;
            return Err(error);
        }
        let mut scanned = Vec::new();
        for dir in wanted {
            let one = Filers::from([(dir.clone(), FilerDepth::Tree)]);
            match ensure_filers(app, &one).await {
                Ok(()) => {
                    started.insert(dir.clone(), FilerDepth::Tree);
                    scanned.push(dir);
                }
                // a failed start leaves no filer of its own behind
                Err(error) => refused.push(FocusRefused { dir, error }),
            }
        }

        let mut projects = self.projects.lock().await;
        let previous = projects.get(&fresh.root);
        let mut project =
            previous.map_or_else(|| fresh.clone(), |existing| merge_project(existing, &fresh));
        if let OpenKind::Registry { focused, .. } = &mut project.kind {
            for dir in scanned {
                // a dedup hit unless something stopped the filer since its
                // scan — then a refusal here, before the commit could fail
                // the whole open on it; a scan that widened it is released
                // by the commit, `started` naming it
                let one = Filers::from([(dir.clone(), FilerDepth::Tree)]);
                match ensure_filers(app, &one).await {
                    Ok(()) => {
                        focused.insert(dir);
                    }
                    Err(error) => refused.push(FocusRefused { dir, error }),
                }
            }
        }
        // a focus refused before the lock that another commit focused since —
        // a racing `repo_focus`, or an open — landed after all
        let landed = project.focused();
        refused.retain(|refusal| !landed.contains(&refusal.dir.as_str()));
        let opened = previous.is_none();
        let change = match previous {
            None => Some(ProjectChange::Open),
            Some(previous) if *previous != project => Some(ProjectChange::Update),
            Some(_) => None,
        };
        let mut next = projects.clone();
        next.insert(project.root.clone(), project.clone());
        let changes = change.map(|change| (change, project.clone()));
        let committed = self
            .commit(app, &mut projects, next, &started, changes)
            .await;
        // whether the open committed, not the commit's result: a failed
        // notify still committed it, and a failed filer start committed
        // nothing (a reopen's root then holds the previous project)
        if let Some(source) = registry
            && !matches!(committed, Err(LifecycleError::Filer { .. }))
            && projects.contains_key(&project.root)
        {
            app.repo_status.set_registry(&project.root, source);
        }
        committed?;
        // as committed: stamped, with the ignored paths the commit read
        let project = projects[&project.root].clone();
        // read before the lock drops: a commit after it could stop or narrow
        // a filer this reads, and the reply would carry files no state at
        // `project.rev` held — which a client applying the reply's state by
        // its rev would take as the truth about those directories
        let filers = filers_of(&project);
        let files = files_of(app, &filers).await;
        let watch_status = watch_status_of(app, &filers).await;
        drop(projects);

        Ok(Opened {
            landed: Landed {
                project,
                files,
                watch_status,
            },
            opened,
            refused,
        })
    }

    /// Close the open project at `root` — matched as given (plus a trailing
    /// `/`), then canonicalized, so a non-canonical spelling of an open root
    /// (`/a/./b`, a symlinked path) closes it too, while a project whose root
    /// was deleted can still be closed by its stored root.
    ///
    /// Its filers stop unless another open project keeps them, its root
    /// leaves scope, and `project_changed` `close` is broadcast. Returns the
    /// closed project stamped with the close's rev. Permanent
    /// filers and roots (the app dir, the scoped dirs) stay, so closing a
    /// project that overlaps one never revokes the access it grants.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`]; [`LifecycleError::Notify`].
    pub async fn close(&self, app: &Arc<App>, root: &str) -> Result<OpenProject, LifecycleError> {
        let mut key = with_trailing_slash(root.to_owned());
        // resolved before the lock — only consulted if `key` itself isn't open
        let canonical_key = tokio::fs::canonicalize(root)
            .await
            .ok()
            .and_then(|canonical| canonical.to_str().map(str::to_owned))
            .map(with_trailing_slash);

        let mut projects = self.projects.lock().await;
        if !projects.contains_key(&key)
            && let Some(canonical_key) = canonical_key
        {
            key = canonical_key;
        }
        let mut next = projects.clone();
        let Some(project) = next.remove(&key) else {
            return Err(LifecycleError::NotOpen {
                root: root.to_owned(),
            });
        };
        let mut project = project;
        let changes = [(ProjectChange::Close, project.clone())];
        let committed = self
            .commit(app, &mut projects, next, &Filers::new(), changes)
            .await;
        // under the lock, so a reopen committing after this keeps its own;
        // by the state the commit left, so a commit that failed before it
        // closed anything keeps the open project's
        if !projects.contains_key(&project.root) {
            app.repo_status.forget(&project.root);
        }
        if let Some(rev) = committed? {
            project.rev = rev;
        }
        Ok(project)
    }

    /// Close every open project, as [`Self::close`] does each. Every project
    /// is released before any `close` is broadcast.
    ///
    /// Returns the closed projects, each stamped with the close's rev.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::Notify`] — every project is closed regardless.
    pub async fn close_all(&self, app: &Arc<App>) -> Result<Vec<OpenProject>, LifecycleError> {
        let mut projects = self.projects.lock().await;
        let mut closed: Vec<OpenProject> = projects.values().cloned().collect();
        let changes: Vec<(ProjectChange, OpenProject)> = closed
            .iter()
            .map(|project| (ProjectChange::Close, project.clone()))
            .collect();
        let committed = self
            .commit(app, &mut projects, Projects::new(), &Filers::new(), changes)
            .await;
        if projects.is_empty() {
            app.repo_status.retain(&[]);
        }
        if let Some(rev) = committed? {
            for project in &mut closed {
                project.rev = rev;
            }
        }
        Ok(closed)
    }

    /// Focus the registry entry at `dir` of the open project at `root`: its
    /// whole tree is then indexed and watched. The entry must be present as
    /// the project's last resolve left it — the registry isn't resolved
    /// again.
    ///
    /// Broadcasts `project_changed` `update`; focusing a focused entry
    /// changes and broadcasts nothing. The repo's files are read before the
    /// lock drops, as an open's are.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`], [`LifecycleError::NotRegistry`],
    /// [`LifecycleError::RepoNotInProject`], [`LifecycleError::RepoMissing`],
    /// [`LifecycleError::RepoRefused`]; [`LifecycleError::Filer`] when the
    /// repo can't be listed, leaving the project as it was;
    /// [`LifecycleError::Notify`].
    pub async fn focus(
        &self,
        app: &Arc<App>,
        root: &str,
        dir: &str,
    ) -> Result<Landed, LifecycleError> {
        let not_open = || LifecycleError::NotOpen {
            root: root.to_owned(),
        };
        // checked before the scan, so a refused focus starts nothing
        {
            let published = self.published();
            let project = published
                .projects
                .iter()
                .find(|project| project.root == root)
                .ok_or_else(not_open)?;
            check_focusable(project, dir)?;
        }
        // the scan runs before the lock, as an open's does
        let started = Filers::from([(dir.to_owned(), FilerDepth::Tree)]);
        if let Err(error) = ensure_filers(app, &started).await {
            let projects = self.projects.lock().await;
            release(app, &started, &desired_filers(projects.values())).await;
            return Err(error);
        }

        self.land_focus(app, root, dir, &started).await
    }

    /// The second half of [`Self::focus`], under the lock: check again that
    /// `dir` is focusable — the project may have closed, or opened again
    /// with the entry no longer present, while the scan ran — and record the
    /// focus. `started` is what the scan started, released if the check
    /// fails.
    async fn land_focus(
        &self,
        app: &Arc<App>,
        root: &str,
        dir: &str,
        started: &Filers,
    ) -> Result<Landed, LifecycleError> {
        let mut projects = self.projects.lock().await;
        let checked = projects
            .get(root)
            .ok_or_else(|| LifecycleError::NotOpen {
                root: root.to_owned(),
            })
            .and_then(|previous| {
                check_focusable(previous, dir)?;
                let mut project = previous.clone();
                focused_mut(&mut project)?.insert(dir.to_owned());
                Ok((previous.clone(), project))
            });
        let (previous, project) = match checked {
            Ok(checked) => checked,
            Err(error) => {
                release(app, started, &desired_filers(projects.values())).await;
                return Err(error);
            }
        };
        let mut next = projects.clone();
        next.insert(project.root.clone(), project.clone());
        let changes = (previous != project).then(|| (ProjectChange::Update, project.clone()));
        self.commit(app, &mut projects, next, started, changes)
            .await?;
        // as committed, as an open's is
        let project = projects[root].clone();
        // read before the lock drops, as an open's reply is
        let files = app.filer_manager.files_for(dir).await;
        let watch_status = watch_status_of(app, &filers_of(&project)).await;
        drop(projects);

        Ok(Landed {
            project,
            files,
            watch_status,
        })
    }

    /// Drop the registry entry at `dir` from the focus of the open project at
    /// `root`. Its filer stops unless another open project keeps it (one
    /// keeping it at its top level narrows it to that).
    ///
    /// Broadcasts `project_changed` `update`; unfocusing an unfocused entry —
    /// present or not — changes and broadcasts nothing. A registry may be
    /// left with no focus.
    ///
    /// Returns the project as it's left.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`], [`LifecycleError::NotRegistry`],
    /// [`LifecycleError::RepoNotInProject`]; [`LifecycleError::Notify`].
    pub async fn unfocus(
        &self,
        app: &Arc<App>,
        root: &str,
        dir: &str,
    ) -> Result<OpenProject, LifecycleError> {
        let mut projects = self.projects.lock().await;
        let previous = projects.get(root).ok_or_else(|| LifecycleError::NotOpen {
            root: root.to_owned(),
        })?;
        entry_of(previous, dir)?;
        let mut project = previous.clone();
        focused_mut(&mut project)?.remove(dir);
        if *previous == project {
            return Ok(project);
        }
        let mut next = projects.clone();
        next.insert(project.root.clone(), project.clone());
        let changes = [(ProjectChange::Update, project.clone())];
        self.commit(app, &mut projects, next, &Filers::new(), changes)
            .await?;
        // as committed: its dropped focus's ignored paths gone with it
        Ok(projects[root].clone())
    }

    /// Commit the open projects unchanged, so the commit reads every
    /// focused dir's ignored paths again — what a filer whose set changed
    /// asks for (`FilerIgnoredChange`, at most once a second per filer).
    /// A project whose set moved is stamped and broadcast as `update`;
    /// nothing else changes, and no filer starts or stops.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::Filer`] if a filer the projects keep was gone and
    /// can't start again; [`LifecycleError::Notify`].
    pub async fn refresh_ignored(&self, app: &Arc<App>) -> Result<(), LifecycleError> {
        let mut projects = self.projects.lock().await;
        let next = projects.clone();
        self.commit(app, &mut projects, next, &Filers::new(), [])
            .await?;
        Ok(())
    }

    /// Make `next` the open projects. `started` is what the caller's scans
    /// started before taking the lock; `changes` is what changed, to
    /// broadcast once `next` is in effect — empty for a commit that changes
    /// no project's state (a no-op open still commits, releasing what its
    /// scans started).
    ///
    /// In order: every filer `next` needs is ensured — a failure there
    /// releases what the operation started and leaves everything as it was;
    /// then each project's ignored paths are read from its filers
    /// ([`refresh_ignored_of`]), a project whose set moved counting as
    /// changed; then, when anything changed, the rev is bumped and stamped on each
    /// changed project, in `next` and in its notification (a close's on the
    /// closed project alone); then `next` replaces the state, the filers it
    /// no longer needs are stopped or narrowed, the roots it drops leave
    /// `ScopedFs` and the ones it adds enter, the snapshot is published with
    /// the rev, and `changes` go out.
    ///
    /// Returns the rev stamped on the changes, `None` when there were none.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::Filer`], with nothing changed (the rev included);
    /// [`LifecycleError::Notify`] for the first notification that can't be
    /// built, with `next` in effect and every other one sent.
    async fn commit(
        &self,
        app: &Arc<App>,
        projects: &mut tokio::sync::MutexGuard<'_, Projects>,
        mut next: Projects,
        started: &Filers,
        changes: impl IntoIterator<Item = (ProjectChange, OpenProject)>,
    ) -> Result<Option<u64>, LifecycleError> {
        let before = desired_filers(projects.values());
        let after = desired_filers(next.values());

        // a close or unfocus that ran between the caller's scans and the lock
        // stopped the filers it alone kept — dedup hits otherwise
        if let Err(error) = ensure_filers(app, &after).await {
            let mut attempted = after;
            deepen(&mut attempted, started);
            release(app, &attempted, &before).await;
            return Err(error);
        }

        let mut changes: Vec<(ProjectChange, OpenProject)> = changes.into_iter().collect();
        refresh_ignored_of(app, projects, &mut next, &mut changes).await;
        let stamped = (!changes.is_empty()).then(|| {
            // under the lock, so no two commits share a rev
            let rev = self.rev.load(Ordering::Relaxed) + 1;
            self.rev.store(rev, Ordering::Relaxed);
            for (_, project) in &mut changes {
                project.rev = rev;
                if let Some(kept) = next.get_mut(&project.root) {
                    kept.rev = rev;
                }
            }
            rev
        });

        let closed: Vec<String> = projects
            .keys()
            .filter(|root| !next.contains_key(*root))
            .cloned()
            .collect();
        let opened: Vec<String> = next
            .keys()
            .filter(|root| !projects.contains_key(*root))
            .cloned()
            .collect();
        **projects = next;

        let mut was = before;
        deepen(&mut was, started);
        release(app, &was, &after).await;
        for root in &closed {
            app.scoped_fs.remove_path(Path::new(root));
        }
        for root in &opened {
            app.scoped_fs.add_path(Path::new(root));
        }
        *self.published.write() = Arc::new(PublishedProjects {
            projects: projects.values().cloned().collect(),
            filers: after.keys().cloned().collect(),
            rev: self.rev.load(Ordering::Relaxed),
        });
        #[cfg(debug_assertions)]
        check_invariants(app, projects, &after).await;

        let mut result = Ok(stamped);
        for (change, project) in changes {
            let sent = broadcast_project_changed(app, change, &project);
            if result.is_ok()
                && let Err(error) = sent
            {
                result = Err(error);
            }
        }
        result
    }
}

/// Fill each project of `next` with its focused dirs' ignored paths as the
/// filers have them now, and add an `update` to `changes` for each project
/// open before (in `projects`) whose set moved and that isn't already among
/// them. A changed project's notification carries the fresh set; a close's
/// keeps what it had.
///
/// Every filer `next` keeps runs (the commit ensured them), and the lock is
/// held, so the sets are those of the filers this state keeps — the reply
/// and the notification carry what the rev they're stamped with names.
async fn refresh_ignored_of(
    app: &App,
    projects: &Projects,
    next: &mut Projects,
    changes: &mut Vec<(ProjectChange, OpenProject)>,
) {
    let focused: BTreeSet<String> = next
        .values()
        .flat_map(OpenProject::focused)
        .map(str::to_owned)
        .collect();
    let ignored = app.filer_manager.ignored_on_wire(&focused).await;
    // TODO every `project_changed` resends each focused dir's whole set, a
    // vetted file joining it included: with the live-added budget (up to
    // ~10k paths) that's ~0.5 MB per change to every socket. A per-dir
    // version clients already hold, or keeping live-added paths off the
    // wire, would send a set only when it moved.
    for project in next.values_mut() {
        let of_project = project
            .focused()
            .into_iter()
            .filter_map(|dir| Some((dir.to_owned(), ignored.get(dir)?.clone())))
            .collect();
        project.ignored = of_project;
    }
    for (change, project) in changes.iter_mut() {
        if *change != ProjectChange::Close
            && let Some(kept) = next.get(&project.root)
        {
            project.ignored = kept.ignored.clone();
        }
    }
    for (root, project) in next.iter() {
        let listed = changes.iter().any(|(_, changed)| changed.root == *root);
        if !listed
            && projects
                .get(root)
                .is_some_and(|previous| previous != project)
        {
            changes.push((ProjectChange::Update, project.clone()));
        }
    }
}

/// Broadcast a `project_changed`. Called only from
/// [`ProjectManager::commit`], under the lock, so notifications for one root
/// go out in the order its changes took effect — a close's `close` can't
/// land after a racing open's `open`.
fn broadcast_project_changed(
    app: &App,
    change: ProjectChange,
    project: &OpenProject,
) -> Result<(), LifecycleError> {
    let params = serde_json::to_value(ProjectChangedParams {
        change_type: change,
        project: project.to_info(),
    })
    .map_err(LifecycleError::Notify)?;
    app.broadcast(&notify_to_string("project_changed", &params));
    Ok(())
}

/// What a commit leaves true, checked in debug builds: every directory the
/// open projects keep has a filer indexing at least that much of it, and the
/// runtime `ScopedFs` roots are exactly the open projects' roots (a root
/// that's also a permanent one stays permanent).
///
/// A filer may run that no project keeps — one an open or focus in flight started
/// before taking the lock — so this doesn't check there are no others; the
/// tests' `assert_settled` does, between operations.
#[cfg(debug_assertions)]
async fn check_invariants(app: &App, projects: &Projects, desired: &Filers) {
    for (dir, depth) in desired {
        let running = app
            .filer_manager
            .depth_of(dir)
            .await
            .map(|(depth, _)| depth);
        debug_assert!(
            running == Some(FilerDepth::Tree) || running == Some(*depth),
            "a commit left {dir} wanted at {depth:?} and running at {running:?}"
        );
    }
    let roots: BTreeSet<&str> = projects.keys().map(String::as_str).collect();
    let runtime = app.scoped_fs.runtime_roots();
    debug_assert!(
        runtime.iter().all(|root| roots.contains(root.as_str())),
        "a commit left a ScopedFs root with no open project: {runtime:?} vs {roots:?}"
    );
    debug_assert!(
        roots.iter().all(|root| app.scoped_fs.has_root(root)),
        "a commit left an open project out of scope: {roots:?} vs {runtime:?}"
    );
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use serde_json::Value;

    use super::*;

    /// Inert handles: a lazy pool that never connects, no roots, no sockets.
    fn inert_app() -> Arc<App> {
        app_over(Arc::new(fuz_realtime::ConnectionRegistry::new()))
    }

    /// [`inert_app`] broadcasting over `realtime`.
    fn app_over(realtime: Arc<fuz_realtime::ConnectionRegistry>) -> Arc<App> {
        Arc::new(app_value(realtime))
    }

    fn app_value(realtime: Arc<fuz_realtime::ConnectionRegistry>) -> App {
        let pool = fuz_db::create_pool(
            "postgres://localhost:1/project_manager_test_unused",
            &fuz_db::PoolOptions::default(),
        )
        .expect("a lazy pool builds without connecting");
        App::new(
            pool.clone(),
            crate::scoped_fs::ScopedFs::without_roots(),
            "/nowhere/".to_owned(),
            vec![],
            crate::provider::ProviderManager::new(),
            realtime,
            Arc::new(fuz_auth::AuditEmitter::new(pool, Arc::default())),
        )
    }

    /// [`inert_app`] with its manager's rev seeded at `seed` — a daemon
    /// booted when the clock read that.
    fn app_seeded(seed: u64) -> Arc<App> {
        Arc::new(App {
            projects: ProjectManager::with_rev_seed(seed),
            ..app_value(Arc::new(fuz_realtime::ConnectionRegistry::new()))
        })
    }

    /// [`inert_app`] with a usable git, so a checkout's filer takes git's
    /// rule and publishes its ignored set.
    fn app_with_git(realtime: Arc<fuz_realtime::ConnectionRegistry>) -> Arc<App> {
        Arc::new(App {
            git_usability: crate::git::GitUsability::checked_for_tests(),
            ..app_value(realtime)
        })
    }

    /// `git init` in `dir`, failing the test unless it succeeds.
    fn git_init(dir: &Path) {
        let out = std::process::Command::new("git")
            .current_dir(dir)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
    }

    /// A checkout project at `root` (a key), focusing its root.
    fn checkout_at(root: &str) -> OpenProject {
        OpenProject {
            kind: OpenKind::GitRepo,
            ..plain_at(root)
        }
    }

    /// [`inert_app`] with one socket, whose frames the receiver takes.
    fn app_with_socket() -> (
        Arc<App>,
        fuz_realtime::Connection,
        fuz_realtime::ConnectionReceiver,
    ) {
        let realtime = Arc::new(fuz_realtime::ConnectionRegistry::new());
        let (sender, receiver) = fuz_realtime::connection_channel(1 << 20);
        let connection = realtime.add_connection(
            sender,
            fuz_realtime::ConnectionIdentity::default(),
            tokio_util::sync::CancellationToken::new(),
        );
        (app_over(realtime), connection, receiver)
    }

    /// The `project_changed` notifications queued on `rx`, each its type, its
    /// root, and the focus it reports — other frames (`filer_change`) skipped.
    fn project_changes(rx: &mut fuz_realtime::ConnectionReceiver) -> Vec<(String, String, Value)> {
        let mut changes = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let message: Value = serde_json::from_str(frame.as_str()).unwrap();
            if message["method"] == "project_changed" {
                let params = &message["params"];
                changes.push((
                    params["type"].as_str().unwrap().to_owned(),
                    params["project"]["root"].as_str().unwrap().to_owned(),
                    params["project"]["focused"].clone(),
                ));
            }
        }
        changes
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zzz_project_manager_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }

        fn key(&self, rel: &str) -> String {
            format!("{}/{rel}", self.0.display())
        }

        fn write(&self, rel: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A registry project at `root` (a key) with an entry per `keys` — each
    /// present at `root/key/` — focusing `focus`.
    fn registry_at(root: &str, keys: &[&str], focus: &[&str]) -> OpenProject {
        let entry = |key: &&str| OpenEntry {
            key: (*key).to_owned(),
            kind: EntryKind::Repo,
            dir: format!("{root}{key}/"),
            state: EntryState::Present,
        };
        OpenProject {
            root: root.to_owned(),
            name: "w".to_owned(),
            opened_at: "t".to_owned(),
            kind: OpenKind::Registry {
                registry_path: format!("{root}repos.toml"),
                entries: keys.iter().map(entry).collect(),
                focused: focus.iter().map(|key| format!("{root}{key}/")).collect(),
            },
            rev: 0,
            fallback: None,
            ignored: BTreeMap::new(),
        }
    }

    /// A plain-directory project at `root` (a key), focusing its root.
    fn plain_at(root: &str) -> OpenProject {
        OpenProject {
            root: root.to_owned(),
            name: "plain".to_owned(),
            opened_at: "t".to_owned(),
            kind: OpenKind::PlainDir,
            rev: 0,
            fallback: None,
            ignored: BTreeMap::new(),
        }
    }

    /// With no operation in flight: the project-scoped filers running are
    /// exactly what the open projects keep, each at exactly that depth, and
    /// the published snapshot is the state.
    async fn assert_settled(app: &Arc<App>) {
        let projects = app.projects.projects.lock().await;
        let desired = desired_filers(projects.values());
        assert_eq!(app.filer_manager.project_filers().await, desired);
        let published = app.projects.published();
        assert_eq!(
            published.projects.iter().collect::<Vec<_>>(),
            projects.values().collect::<Vec<_>>(),
        );
        assert_eq!(
            published.filers,
            desired.keys().cloned().collect::<BTreeSet<_>>()
        );
        // published at the manager's rev, every project no newer than it
        assert_eq!(published.rev, app.projects.rev.load(Ordering::Relaxed));
        assert!(
            published.projects.iter().all(|p| p.rev <= published.rev),
            "a project stamped after its snapshot's rev"
        );
        let mut roots = app.scoped_fs.runtime_roots();
        roots.sort();
        assert_eq!(roots, projects.keys().cloned().collect::<Vec<_>>());
    }

    #[test]
    fn a_checkout_or_plain_dir_keeps_its_root_whole_and_a_registry_its_top_level() {
        assert_eq!(
            filers_of(&plain_at("/w/")).into_iter().collect::<Vec<_>>(),
            [("/w/".to_owned(), FilerDepth::Tree)]
        );
        assert_eq!(
            filers_of(&registry_at("/w/", &["app", "site"], &["app"]))
                .into_iter()
                .collect::<Vec<_>>(),
            [
                ("/w/".to_owned(), FilerDepth::TopLevel),
                ("/w/app/".to_owned(), FilerDepth::Tree),
            ]
        );
    }

    #[test]
    fn a_reopen_takes_the_fresh_fallback_and_counts_it_as_a_change() {
        let refused = OpenProject {
            fallback: Some(OpenFallback::RegistryRefused {
                registry_path: "/w/repos.toml".to_owned(),
                reason: "registry_untrusted",
            }),
            rev: 3,
            ..plain_at("/w/x/")
        };
        let unregistered = OpenProject {
            fallback: Some(OpenFallback::Unregistered {
                registry_path: "/w/repos.toml".to_owned(),
            }),
            ..plain_at("/w/x/")
        };
        let merged = merge_project(&refused, &unregistered);
        assert_eq!(merged.fallback, unregistered.fallback);
        assert_eq!(merged.rev, 3);
        // so the commit stamps a new rev and broadcasts an update
        assert_ne!(merged, refused);
        assert_eq!(merge_project(&refused, &refused), refused);

        let info = serde_json::to_value(merged.to_info()).unwrap();
        assert_eq!(
            info["fallback"],
            serde_json::json!({"kind": "unregistered", "registry_path": "/w/repos.toml"})
        );
        assert_eq!(plain_at("/w/").to_info().fallback, None);
    }

    #[test]
    fn the_open_projects_keep_each_directory_at_the_deepest_any_does() {
        // a registry focusing `app`, a plain project at `app`, and a registry
        // rooted at `site` — which the first doesn't focus
        let desired = desired_filers(&[
            registry_at("/w/", &["app", "site"], &["app"]),
            plain_at("/w/app/"),
            registry_at("/w/site/", &[], &[]),
        ]);
        assert_eq!(
            desired.into_iter().collect::<Vec<_>>(),
            [
                ("/w/".to_owned(), FilerDepth::TopLevel),
                ("/w/app/".to_owned(), FilerDepth::Tree),
                ("/w/site/".to_owned(), FilerDepth::TopLevel),
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_registry_open_holds_its_status_source_until_its_close() {
        let tmp = TempDir::new();
        tmp.write("w/README.md");
        let app = inert_app();
        let root = tmp.key("w/");
        let source = || RegistrySource::new(Path::new(&root), &[]);
        app.projects
            .open_with_registry(&app, registry_at(&root, &[], &[]), &[], Some(source()))
            .await
            .unwrap();
        assert!(app.repo_status.poll(&app.git, &root, false).await.is_ok());
        app.projects.close(&app, &root).await.unwrap();
        assert!(app.repo_status.poll(&app.git, &root, false).await.is_err());

        app.projects
            .open_with_registry(&app, registry_at(&root, &[], &[]), &[], Some(source()))
            .await
            .unwrap();
        app.projects.close_all(&app).await.unwrap();
        assert!(app.repo_status.poll(&app.git, &root, false).await.is_err());
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_close_narrows_a_root_another_project_keeps_at_its_top_level() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        // a registry focusing `app` whole, and a registry rooted at `app`,
        // which keeps only its top level
        app.projects
            .open(&app, registry_at(&root, &["app"], &["app"]), &[])
            .await
            .unwrap();
        app.projects
            .open(&app, registry_at(&app_dir, &[], &[]), &[])
            .await
            .unwrap();
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 2);

        app.projects.close(&app, &root).await.unwrap();
        assert_eq!(
            app.filer_manager
                .files_for(&app_dir)
                .await
                .into_iter()
                .map(|f| f.id)
                .collect::<Vec<_>>(),
            [tmp.key("w/app/a.txt")],
            "narrowed to the nested registry's top level"
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_refused_under_the_lock_narrows_what_its_scan_widened() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &[]), &[])
            .await
            .unwrap();
        app.projects
            .open(&app, registry_at(&app_dir, &[], &[]), &[])
            .await
            .unwrap();

        // a focus whose scan ran — widening the nested registry's top-level
        // filer to the whole tree — and then found the project closed
        let started = Filers::from([(app_dir.clone(), FilerDepth::Tree)]);
        ensure_filers(&app, &started).await.unwrap();
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 2);
        app.projects.close(&app, &root).await.unwrap();
        assert!(matches!(
            app.projects
                .land_focus(&app, &root, &app_dir, &started)
                .await,
            Err(LifecycleError::NotOpen { .. })
        ));
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 1);
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focused_files_read_holds_the_lock_while_it_reads() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &["app"]), &[])
            .await
            .unwrap();

        // the read parks on the index, past its check
        let held = app.filer_manager.hold_index(&app_dir).await;
        let reader = tokio::spawn({
            let (app, root, app_dir) = (Arc::clone(&app), root.clone(), app_dir.clone());
            async move { app.projects.focused_files(&app, &root, &app_dir).await }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while app.projects.projects.try_lock().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the read takes the lock");
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!reader.is_finished(), "the read waits on the index");
        assert!(
            app.projects.projects.try_lock().is_err(),
            "the read holds the lock across its read, so no commit stops the filer between"
        );
        drop(held);
        assert_eq!(reader.await.unwrap().unwrap().files.len(), 2);
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_and_a_focus_read_their_reply_files_under_the_lock() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &["app"]), &[])
            .await
            .unwrap();

        // each parks on the focused repo's index, past its commit — an open
        // that changes nothing, then a focus of the focused repo
        for focusing in [false, true] {
            let held = app.filer_manager.hold_index(&app_dir).await;
            let reply = tokio::spawn({
                let (app, root, app_dir) = (Arc::clone(&app), root.clone(), app_dir.clone());
                async move {
                    if focusing {
                        app.projects
                            .focus(&app, &root, &app_dir)
                            .await
                            .unwrap()
                            .files
                    } else {
                        app.projects
                            .open(&app, registry_at(&root, &["app"], &["app"]), &[])
                            .await
                            .unwrap()
                            .landed
                            .files
                    }
                }
            });
            tokio::time::timeout(Duration::from_secs(5), async {
                while app.projects.projects.try_lock().is_ok() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the change takes the lock");
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!reply.is_finished(), "the reply's read waits on the index");
            assert!(
                app.projects.projects.try_lock().is_err(),
                "the reply's files are read under the lock its commit held"
            );
            drop(held);
            let files = reply.await.unwrap();
            assert!(
                files
                    .iter()
                    .any(|file| file.id == tmp.key("w/app/sub/c.txt")),
                "{files:?}"
            );
        }
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focused_files_read_waits_out_a_commit_partway() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &["app"]), &[])
            .await
            .unwrap();
        let read = app
            .projects
            .focused_files(&app, &root, &app_dir)
            .await
            .unwrap();
        assert_eq!(read.files.len(), 2);

        // an unfocus partway through its commit: under the lock, its filer
        // stopped (`release`), the snapshot not yet published
        let mut projects = app.projects.projects.lock().await;
        let mut next = projects.clone();
        focused_mut(next.get_mut(&root).unwrap())
            .unwrap()
            .remove(&app_dir);
        app.filer_manager.stop_filer(&app_dir).await;
        assert!(
            app.projects.published().projects[0]
                .focused()
                .contains(&app_dir.as_str()),
            "a check against the snapshot would pass here and read no files"
        );
        let reader = tokio::spawn({
            let (app, root, app_dir) = (Arc::clone(&app), root.clone(), app_dir.clone());
            async move { app.projects.focused_files(&app, &root, &app_dir).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!reader.is_finished(), "the read waits on the lock");

        // the commit finishes, and the read sees the state it left
        let update = (ProjectChange::Update, next[&root].clone());
        app.projects
            .commit(&app, &mut projects, next, &Filers::new(), [update])
            .await
            .unwrap();
        drop(projects);
        assert!(matches!(
            reader.await.unwrap(),
            Err(LifecycleError::NotFocused { .. })
        ));
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn each_change_is_broadcast_once_and_a_change_of_nothing_never() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/b.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, site_dir) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/site/"));
        let manager = &app.projects;
        manager
            .open(&app, registry_at(&root, &["app", "site"], &["app"]), &[])
            .await
            .unwrap();
        // an open that changes nothing broadcasts nothing
        manager
            .open(&app, registry_at(&root, &["app", "site"], &["app"]), &[])
            .await
            .unwrap();
        manager.focus(&app, &root, &site_dir).await.unwrap();
        manager.focus(&app, &root, &site_dir).await.unwrap();
        manager.unfocus(&app, &root, &app_dir).await.unwrap();
        manager.unfocus(&app, &root, &app_dir).await.unwrap();
        manager.close(&app, &root).await.unwrap();
        assert!(matches!(
            manager.close(&app, &root).await,
            Err(LifecycleError::NotOpen { .. })
        ));

        let focus = |dirs: &[&String]| serde_json::json!(dirs);
        assert_eq!(
            project_changes(&mut rx),
            [
                ("open".to_owned(), root.clone(), focus(&[&app_dir])),
                (
                    "update".to_owned(),
                    root.clone(),
                    focus(&[&app_dir, &site_dir])
                ),
                ("update".to_owned(), root.clone(), focus(&[&site_dir])),
                ("close".to_owned(), root.clone(), focus(&[&site_dir])),
            ]
        );
        assert_settled(&app).await;
    }

    /// The `project_changed` notifications queued on `rx`, each its type and
    /// the rev it carries.
    fn change_revs(rx: &mut fuz_realtime::ConnectionReceiver) -> Vec<(String, u64)> {
        let mut changes = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let message: Value = serde_json::from_str(frame.as_str()).unwrap();
            if message["method"] == "project_changed" {
                let params = &message["params"];
                changes.push((
                    params["type"].as_str().unwrap().to_owned(),
                    params["project"]["rev"].as_u64().unwrap(),
                ));
            }
        }
        changes
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn every_changing_commit_bumps_the_rev_and_stamps_it_and_a_no_op_never() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/b.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, site_dir) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/site/"));
        let manager = &app.projects;
        let seed = manager.published().rev;
        let revs = |project: &OpenProject| (project.rev, manager.published().rev);

        let opened = manager
            .open(&app, registry_at(&root, &["app", "site"], &["app"]), &[])
            .await
            .unwrap();
        assert!(opened.opened, "this open created the project");
        assert_eq!(revs(&opened.landed.project), (seed + 1, seed + 1));
        // an open that changes nothing merges, and stamps nothing
        let again = manager
            .open(&app, registry_at(&root, &["app", "site"], &["app"]), &[])
            .await
            .unwrap();
        assert!(!again.opened, "merged into the open project");
        assert_eq!(revs(&again.landed.project), (seed + 1, seed + 1));

        let focused = manager.focus(&app, &root, &site_dir).await.unwrap();
        assert_eq!(revs(&focused.project), (seed + 2, seed + 2));
        let read = manager.focused_files(&app, &root, &site_dir).await.unwrap();
        assert_eq!(read.rev, seed + 2, "a read carries the project's rev");
        let focused = manager.focus(&app, &root, &site_dir).await.unwrap();
        assert_eq!(revs(&focused.project), (seed + 2, seed + 2));
        let unfocused = manager.unfocus(&app, &root, &app_dir).await.unwrap();
        assert_eq!(revs(&unfocused), (seed + 3, seed + 3));
        let unfocused = manager.unfocus(&app, &root, &app_dir).await.unwrap();
        assert_eq!(revs(&unfocused), (seed + 3, seed + 3));
        // the published snapshot holds the projects at the rev it was taken at
        let published = manager.published();
        assert_eq!(published.projects[0].rev, seed + 3);

        let closed = manager.close(&app, &root).await.unwrap();
        assert_eq!(
            revs(&closed),
            (seed + 4, seed + 4),
            "a close returns its rev"
        );
        assert!(manager.published().projects.is_empty());

        assert_eq!(
            change_revs(&mut rx),
            [
                ("open".to_owned(), seed + 1),
                ("update".to_owned(), seed + 2),
                ("update".to_owned(), seed + 3),
                ("close".to_owned(), seed + 4),
            ],
            "each notification carries the rev its commit stamped"
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_commit_that_fails_bumps_no_rev() {
        let tmp = TempDir::new();
        tmp.write("w/README.md");
        let app = inert_app();
        let seed = app.projects.published().rev;
        // the root can't be listed, so the open fails before anything commits
        let missing = tmp.key("gone/");
        assert!(matches!(
            app.projects.open(&app, plain_at(&missing), &[]).await,
            Err(LifecycleError::Filer { .. })
        ));
        assert_eq!(app.projects.published().rev, seed);
        let opened = app
            .projects
            .open(&app, plain_at(&tmp.key("w/")), &[])
            .await
            .unwrap();
        assert_eq!(
            opened.landed.project.rev,
            seed + 1,
            "the next change takes the next rev"
        );
    }

    #[test]
    fn the_rev_seed_is_the_clock_in_microseconds_and_exact_as_a_json_number() {
        let at = |micros: u64| UNIX_EPOCH + Duration::from_micros(micros);
        assert_eq!(rev_seed(at(1_763_251_200_000_000)), 1_763_251_200_000_000);
        assert_eq!(rev_seed(UNIX_EPOCH - Duration::from_secs(1)), 0);
        // a JSON number is a double: exact up to 2^53, which a seed from the
        // clock stays under for centuries
        assert!(rev_seed(SystemTime::now()) < 1 << 53);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_later_boot_starts_above_every_rev_an_earlier_boot_stamped() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/b.txt"] {
            tmp.write(rel);
        }
        let (root, site_dir) = (tmp.key("w/"), tmp.key("w/site/"));
        let booted = SystemTime::now();

        // a first boot that changes its projects a few times
        let first = app_seeded(rev_seed(booted));
        first
            .projects
            .open(&first, registry_at(&root, &["app", "site"], &["app"]), &[])
            .await
            .unwrap();
        first
            .projects
            .focus(&first, &root, &site_dir)
            .await
            .unwrap();
        let last = first.projects.close(&first, &root).await.unwrap().rev;
        assert_settled(&first).await;

        // a restart a millisecond later — a thousand revs of headroom
        let second = app_seeded(rev_seed(booted + Duration::from_millis(1)));
        assert!(second.projects.published().rev > last);
        let reopened = second
            .projects
            .open(&second, registry_at(&root, &["app", "site"], &["app"]), &[])
            .await
            .unwrap();
        assert!(
            reopened.landed.project.rev > last,
            "a client holding the first boot's revs takes the second's as newer"
        );
        assert_settled(&second).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_commit_whose_filer_cant_start_leaves_everything_as_it_was() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, gone) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/gone/"));
        app.projects
            .open(&app, registry_at(&root, &["app", "gone"], &[]), &[])
            .await
            .unwrap();
        // the registry nested in `app` keeps it at its top level
        app.projects
            .open(&app, registry_at(&app_dir, &[], &[]), &[])
            .await
            .unwrap();
        let filers = app.filer_manager.project_filers().await;
        project_changes(&mut rx);

        // a next state focusing `app` and an entry with no directory: `app`
        // is widened before the missing one fails the commit
        let mut projects = app.projects.projects.lock().await;
        let mut next = projects.clone();
        *focused_mut(next.get_mut(&root).unwrap()).unwrap() =
            BTreeSet::from([app_dir.clone(), gone.clone()]);
        let update = (ProjectChange::Update, next[&root].clone());
        let failed = app
            .projects
            .commit(&app, &mut projects, next, &Filers::new(), [update])
            .await;
        drop(projects);
        assert!(
            matches!(&failed, Err(LifecycleError::Filer { dir, source })
                if dir == &gone && source.kind() == std::io::ErrorKind::NotFound),
            "{failed:?}"
        );
        // nothing recorded, the widened filer narrowed back, nothing broadcast
        assert_eq!(app.filer_manager.project_filers().await, filers);
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 1);
        assert!(project_changes(&mut rx).is_empty());
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_whose_repo_vanished_after_its_scan_fails_and_broadcasts_nothing() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &[]), &[])
            .await
            .unwrap();
        project_changes(&mut rx);

        // the focus's scan ran, then an unfocus elsewhere stopped its filer
        // and the repo was deleted, before the focus took the lock
        let started = Filers::from([(app_dir.clone(), FilerDepth::Tree)]);
        ensure_filers(&app, &started).await.unwrap();
        app.filer_manager.stop_filer(&app_dir).await;
        std::fs::remove_dir_all(tmp.0.join("w/app")).unwrap();
        let failed = app
            .projects
            .land_focus(&app, &root, &app_dir, &started)
            .await;
        assert!(
            matches!(&failed, Err(LifecycleError::Filer { dir, source })
                if dir == &app_dir && source.kind() == std::io::ErrorKind::NotFound),
            "{failed:?}"
        );
        assert!(app.projects.published().projects[0].focused().is_empty());
        assert!(project_changes(&mut rx).is_empty());
        assert_settled(&app).await;
    }

    /// The requested focuses an open refused, each its dir and its error's
    /// variant name.
    fn refusals(opened: &Opened) -> Vec<(String, String)> {
        opened
            .refused
            .iter()
            .map(|FocusRefused { dir, error }| {
                let variant = format!("{error:?}");
                let name = variant.split([' ', '{', '(']).next().unwrap().to_owned();
                (dir.clone(), name)
            })
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_lands_every_requested_focus_in_one_commit() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/b.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, site_dir) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/site/"));
        // the root opened, its repos requested — a trailing slash optional,
        // a duplicate collapsed
        let opened = app
            .projects
            .open(
                &app,
                registry_at(&root, &["app", "site"], &[]),
                &[site_dir.clone(), tmp.key("w/app"), app_dir.clone()],
            )
            .await
            .unwrap();
        assert!(opened.refused.is_empty(), "{:?}", opened.refused);
        assert_eq!(opened.landed.project.focused(), [&app_dir, &site_dir]);
        let mut ids: Vec<String> = opened.landed.files.iter().map(|f| f.id.clone()).collect();
        ids.sort();
        assert_eq!(
            ids,
            [
                tmp.key("w/README.md"),
                tmp.key("w/app/a.txt"),
                tmp.key("w/site/b.txt")
            ],
            "the reply carries the root's and both focuses' files"
        );
        let focus = serde_json::json!([app_dir, site_dir]);
        assert_eq!(
            project_changes(&mut rx),
            [("open".to_owned(), root.clone(), focus.clone())],
            "one notification for the open and its focuses"
        );

        // again, on the open project: nothing changes, nothing is broadcast
        let again = app
            .projects
            .open(
                &app,
                registry_at(&root, &["app", "site"], &[]),
                std::slice::from_ref(&app_dir),
            )
            .await
            .unwrap();
        assert!(again.refused.is_empty());
        assert!(project_changes(&mut rx).is_empty());
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_refuses_each_requested_focus_that_isnt_a_present_entry_alone() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/b.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir, site_dir, keys_dir, nope) = (
            tmp.key("w/"),
            tmp.key("w/app/"),
            tmp.key("w/site/"),
            tmp.key("w/keys/"),
            tmp.key("w/nope/"),
        );
        // `site` not cloned and `keys` refused as just resolved
        let mut fresh = registry_at(&root, &["app", "site", "keys"], &[]);
        if let OpenKind::Registry { entries, .. } = &mut fresh.kind {
            entries[1].state = EntryState::Missing;
            entries[2].state = EntryState::Refused {
                reason: "entry_not_confined",
            };
        }
        let opened = app
            .projects
            .open(
                &app,
                fresh,
                &[
                    site_dir.clone(),
                    app_dir.clone(),
                    keys_dir.clone(),
                    nope.clone(),
                    nope.clone(),
                ],
            )
            .await
            .unwrap();
        assert_eq!(opened.landed.project.focused(), [&app_dir]);
        assert_eq!(
            refusals(&opened),
            [
                (site_dir, "RepoMissing".to_owned()),
                (keys_dir, "RepoRefused".to_owned()),
                (nope, "RepoNotInProject".to_owned()),
            ]
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unlistable_requested_focus_is_refused_alone_and_leaves_no_filer() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, gone) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/gone/"));
        // `gone` is present as resolved, and vanished before its scan
        let opened = app
            .projects
            .open(
                &app,
                registry_at(&root, &["app", "gone"], &[]),
                &[gone.clone(), app_dir.clone()],
            )
            .await
            .unwrap();
        assert_eq!(opened.landed.project.focused(), [&app_dir]);
        assert!(
            matches!(&opened.refused[..], [FocusRefused { dir, error: LifecycleError::Filer { source, .. } }]
                if dir == &gone && source.kind() == std::io::ErrorKind::NotFound),
            "{:?}",
            opened.refused
        );
        assert_eq!(
            project_changes(&mut rx),
            [("open".to_owned(), root, serde_json::json!([app_dir]))]
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_requested_focus_stopped_before_the_lock_is_refused_and_its_widening_released() {
        let tmp = TempDir::new();
        for rel in [
            "w/README.md",
            "w/app/a.txt",
            "w/app/sub/c.txt",
            "w/site/b.txt",
        ] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, site_dir) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/site/"));
        // the registry nested in `app` keeps it at its top level
        app.projects
            .open(&app, registry_at(&app_dir, &[], &[]), &[])
            .await
            .unwrap();
        project_changes(&mut rx);

        // the open's scans run while the lock is held elsewhere — `app`
        // widened to its whole tree — and it waits on the lock
        let mut projects = app.projects.projects.lock().await;
        let opening = tokio::spawn({
            let (app, root, app_dir, site_dir) = (
                Arc::clone(&app),
                root.clone(),
                app_dir.clone(),
                site_dir.clone(),
            );
            async move {
                app.projects
                    .open(
                        &app,
                        registry_at(&root, &["app", "site"], &[]),
                        &[app_dir, site_dir],
                    )
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while app.filer_manager.depth_of(&app_dir).await.map(|(d, _)| d)
                != Some(FilerDepth::Tree)
                || app.filer_manager.depth_of(&site_dir).await.is_none()
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the open's scans run before the lock");

        // meanwhile the nested registry closes, stopping `app`'s filer, and
        // `app` is deleted
        let mut next = projects.clone();
        let nested = next.remove(&app_dir).unwrap();
        app.projects
            .commit(
                &app,
                &mut projects,
                next,
                &Filers::new(),
                [(ProjectChange::Close, nested)],
            )
            .await
            .unwrap();
        assert!(app.filer_manager.depth_of(&app_dir).await.is_none());
        std::fs::remove_dir_all(tmp.0.join("w/app")).unwrap();
        drop(projects);

        let opened = opening.await.unwrap().unwrap();
        assert_eq!(opened.landed.project.focused(), [&site_dir]);
        assert!(
            matches!(&opened.refused[..], [FocusRefused { dir, error: LifecycleError::Filer { source, .. } }]
                if dir == &app_dir && source.kind() == std::io::ErrorKind::NotFound),
            "{:?}",
            opened.refused
        );
        assert_eq!(
            project_changes(&mut rx),
            [
                ("close".to_owned(), app_dir, serde_json::json!([])),
                ("open".to_owned(), root, serde_json::json!([site_dir])),
            ]
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_requested_focus_refused_before_the_lock_and_focused_since_isnt_refused() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir, site_dir) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/site/"));
        app.projects
            .open(&app, registry_at(&root, &["app", "site"], &[]), &[])
            .await
            .unwrap();

        // the open's scans run while the lock is held elsewhere: `site`, a
        // present entry as resolved but not on disk yet, fails its scan, then
        // `app` — scanned after it, in request order — starts its filer
        let mut projects = app.projects.projects.lock().await;
        let opening = tokio::spawn({
            let (app, root, app_dir, site_dir) = (
                Arc::clone(&app),
                root.clone(),
                app_dir.clone(),
                site_dir.clone(),
            );
            async move {
                app.projects
                    .open(
                        &app,
                        registry_at(&root, &["app", "site"], &[]),
                        &[site_dir, app_dir],
                    )
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while app.filer_manager.depth_of(&app_dir).await.is_none() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the open's scans run before the lock");
        assert!(app.filer_manager.depth_of(&site_dir).await.is_none());

        // meanwhile `site` appears, and another client's focus of it commits
        tmp.write("w/site/b.txt");
        let started = Filers::from([(site_dir.clone(), FilerDepth::Tree)]);
        ensure_filers(&app, &started).await.unwrap();
        let mut next = projects.clone();
        let mut project = next.get(&root).unwrap().clone();
        focused_mut(&mut project).unwrap().insert(site_dir.clone());
        next.insert(root.clone(), project);
        app.projects
            .commit(&app, &mut projects, next, &started, [])
            .await
            .unwrap();
        drop(projects);

        // the open's refusal of `site` is stale: it's focused, not refused
        let opened = opening.await.unwrap().unwrap();
        assert_eq!(opened.landed.project.focused(), [&app_dir, &site_dir]);
        assert!(opened.refused.is_empty(), "{:?}", refusals(&opened));
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_requested_focus_the_fresh_resolve_drops_is_refused_though_focused_before() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/b.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, site_dir) = (tmp.key("w/"), tmp.key("w/site/"));
        app.projects
            .open(&app, registry_at(&root, &["app", "site"], &["site"]), &[])
            .await
            .unwrap();

        // `site` left the registry since: the reopen drops its focus and
        // refuses the request for it, though the open project focused it
        let opened = app
            .projects
            .open(
                &app,
                registry_at(&root, &["app"], &[]),
                std::slice::from_ref(&site_dir),
            )
            .await
            .unwrap();
        assert!(opened.landed.project.focused().is_empty());
        assert_eq!(
            refusals(&opened),
            [(site_dir, "RepoNotInProject".to_owned())]
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_checkout_or_plain_dir_lands_a_requested_root_and_refuses_any_other_focus() {
        let tmp = TempDir::new();
        for rel in ["p/x.txt", "p/deep/y.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (plain, deep) = (tmp.key("p/"), tmp.key("p/deep/"));
        // a reopen of what was a registry here, its focus requested
        let opened = app
            .projects
            .open(&app, plain_at(&plain), &[plain.clone(), deep.clone()])
            .await
            .unwrap();
        assert_eq!(opened.landed.project.focused(), [&plain]);
        assert_eq!(refusals(&opened), [(deep, "NotRegistry".to_owned())]);
        assert_settled(&app).await;
    }

    /// A tiny deterministic generator, so a failing interleaving reproduces
    /// from its seed.
    /// The `project_changed` notifications queued on `rx`, each its type,
    /// its rev, and the `ignored` it reports.
    fn ignored_changes(rx: &mut fuz_realtime::ConnectionReceiver) -> Vec<(String, u64, Value)> {
        let mut changes = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let message: Value = serde_json::from_str(frame.as_str()).unwrap();
            if message["method"] == "project_changed" {
                let params = &message["params"];
                changes.push((
                    params["type"].as_str().unwrap().to_owned(),
                    params["project"]["rev"].as_u64().unwrap(),
                    params["project"]["ignored"].clone(),
                ));
            }
        }
        changes
    }

    /// Whether `paths` (an `ignored` entry's paths, as JSON) holds `path`.
    fn lists(ignored: &Value, dir: &str, path: &str) -> bool {
        ignored[dir]["paths"]
            .as_array()
            .is_some_and(|paths| paths.iter().any(|p| p == path))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_ignored_change_is_stamped_broadcast_and_carried_by_replies() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.key("repo")).unwrap();
        git_init(Path::new(&tmp.key("repo")));
        std::fs::write(tmp.key("repo/.gitignore"), "*.log\n").unwrap();
        tmp.write("repo/a.log");
        tmp.write("repo/b.txt");
        tmp.write("plain/c.txt");
        let realtime = Arc::new(fuz_realtime::ConnectionRegistry::new());
        let (sender, mut rx) = fuz_realtime::connection_channel(1 << 20);
        let _connection = realtime.add_connection(
            sender,
            fuz_realtime::ConnectionIdentity::default(),
            tokio_util::sync::CancellationToken::new(),
        );
        let app = app_with_git(realtime);
        let root = tmp.key("repo/");

        // the open's reply and notification carry the set, relative
        let opened = app
            .projects
            .open(&app, checkout_at(&root), &[])
            .await
            .unwrap();
        let project = &opened.landed.project;
        let ignored = &project.ignored[&root];
        assert!(ignored.paths.contains(&"a.log".to_owned()), "{ignored:?}");
        assert_eq!(ignored.resyncs, 0);
        let changes = ignored_changes(&mut rx);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].0, "open");
        assert!(lists(&changes[0].2, &root, "a.log"), "{changes:?}");
        let open_rev = project.rev;
        assert_eq!(changes[0].1, open_rev);
        // a plain dir is on fixed names: no entry
        let plain = tmp.key("plain/");
        let opened = app
            .projects
            .open(&app, plain_at(&plain), &[])
            .await
            .unwrap();
        assert!(opened.landed.project.ignored.is_empty());
        let _ = ignored_changes(&mut rx);

        // a `.gitignore` edit re-prunes, and the filer asks for a refresh:
        // an `update` at a new rev with the new set
        std::fs::write(tmp.key("repo/.gitignore"), "*.txt\n").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let update = loop {
            let found = ignored_changes(&mut rx)
                .into_iter()
                .find(|(_, _, ignored)| lists(ignored, &root, "b.txt"));
            if let Some(found) = found {
                break found;
            }
            assert!(std::time::Instant::now() < deadline, "no refresh");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(update.0, "update");
        assert!(update.1 > open_rev);
        assert!(!lists(&update.2, &root, "a.log"));
        // the published state and a focus read agree with it
        let published = app.projects.published();
        let held = published.projects.iter().find(|p| p.root == root).unwrap();
        assert_eq!(held.rev, update.1);
        assert!(held.ignored[&root].paths.contains(&"b.txt".to_owned()));
        let read = app
            .projects
            .focused_files(&app, &root, &root)
            .await
            .unwrap();
        assert!(read.rev >= update.1);
        // a refresh that finds nothing moved stamps nothing
        let _ = ignored_changes(&mut rx);
        app.projects.refresh_ignored(&app).await.unwrap();
        assert_eq!(app.projects.published().rev, read.rev);
        assert!(ignored_changes(&mut rx).is_empty());
        app.projects.close_all(&app).await.unwrap();
    }

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from((self.0 >> 33) % (bound as u64)).unwrap()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn interleaved_opens_closes_and_focuses_leave_the_filers_and_scope_the_state_needs() {
        let tmp = TempDir::new();
        for rel in [
            "w/README.md",
            "w/app/a.txt",
            "w/app/sub/c.txt",
            "w/site/b.txt",
            "p/x.txt",
            "p/deep/y.txt",
        ] {
            tmp.write(rel);
        }
        // a checkout, so its filer re-prunes and asks for refreshes, each
        // taking the projects lock on a task of its own, among the rest
        git_init(Path::new(&tmp.key("w/app")));
        let app = app_with_git(Arc::new(fuz_realtime::ConnectionRegistry::new()));
        let (root, app_dir, site_dir, plain) = (
            tmp.key("w/"),
            tmp.key("w/app/"),
            tmp.key("w/site/"),
            tmp.key("p/"),
        );

        let mut landed = 0;
        for seed in 0..12_u64 {
            let mut rng = Lcg(seed);
            let mut tasks = Vec::new();
            for _ in 0..24 {
                let app = Arc::clone(&app);
                let (root, app_dir, site_dir, plain) = (
                    root.clone(),
                    app_dir.clone(),
                    site_dir.clone(),
                    plain.clone(),
                );
                let op = rng.next(12);
                tasks.push(tokio::spawn(async move {
                    let manager = &app.projects;
                    match op {
                        0 => manager
                            .open(&app, registry_at(&root, &["app", "site"], &["app"]), &[])
                            .await
                            .map(drop),
                        1 => manager
                            .open(&app, registry_at(&root, &["app", "site"], &[]), &[])
                            .await
                            .map(drop),
                        // the registry nested in the first one's entry
                        2 => manager
                            .open(&app, registry_at(&app_dir, &[], &[]), &[])
                            .await
                            .map(drop),
                        3 => manager.open(&app, plain_at(&plain), &[]).await.map(drop),
                        4 => manager.focus(&app, &root, &app_dir).await.map(drop),
                        5 => manager.focus(&app, &root, &site_dir).await.map(drop),
                        6 => manager.unfocus(&app, &root, &app_dir).await.map(drop),
                        7 => manager.close(&app, &root).await.map(drop),
                        // a reopen: the root, every focus requested, one of
                        // them no entry
                        8 => manager
                            .open(
                                &app,
                                registry_at(&root, &["app", "site"], &[]),
                                &[site_dir, app_dir, format!("{root}nope/")],
                            )
                            .await
                            .map(drop),
                        9 => manager.close(&app, &app_dir).await.map(drop),
                        10 => manager.refresh_ignored(&app).await,
                        // a rule edit: a re-prune, and its refresh
                        _ => {
                            let rule = if seed % 2 == 0 { "*.txt\n" } else { "sub/\n" };
                            std::fs::write(format!("{app_dir}.gitignore"), rule).unwrap();
                            Ok(())
                        }
                    }
                }));
            }
            for task in tasks {
                // a deadlock between a commit and a refresh hangs here
                let done = tokio::time::timeout(Duration::from_secs(60), task).await;
                match done.expect("no deadlock").unwrap() {
                    Ok(()) => landed += 1,
                    // the one refusal the state allows here: the project
                    // closed under a racing operation
                    Err(LifecycleError::NotOpen { .. }) => {}
                    Err(other) => panic!("seed {seed}: {other:?}"),
                }
            }
            assert_settled(&app).await;
        }
        assert!(landed > 0, "the operations ran");

        app.projects.close_all(&app).await.unwrap();
        assert_settled(&app).await;
        assert!(app.filer_manager.project_filers().await.is_empty());
    }

    /// reopening an open git checkout with nothing changed stamps
    /// no rev and broadcasts nothing (`merge_project` keeps `ignored`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_no_op_reopen_of_a_checkout_stamps_nothing() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.key("repo")).unwrap();
        git_init(Path::new(&tmp.key("repo")));
        std::fs::write(tmp.key("repo/.gitignore"), "*.log\n").unwrap();
        tmp.write("repo/a.log");
        let app = app_with_git(Arc::new(fuz_realtime::ConnectionRegistry::new()));
        let root = tmp.key("repo/");
        app.projects
            .open(&app, checkout_at(&root), &[])
            .await
            .unwrap();
        let rev = app.projects.published().rev;
        app.projects
            .open(&app, checkout_at(&root), &[])
            .await
            .unwrap();
        assert_eq!(
            app.projects.published().rev,
            rev,
            "a no-op reopen stamped a rev"
        );
        app.projects.close_all(&app).await.unwrap();
    }
}
