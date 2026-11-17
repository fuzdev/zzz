//! A filer's event loop: its state, the debounced notifications, and the flush.

use super::core::{FilerBroadcast, FilerDepth, RescanSignal};
use super::ignore::{
    GitRoot, IgnoreError, IgnoreRule, IgnoredSet, RuleMarker, SharedRule, is_ignored,
    is_in_nested_repo, is_nested_repo, rule_marker,
};
use super::index::{
    FileIndex, FileStat, ScanIndex, ScannedFile, apply_subtree, deleted_disknode, is_unchanged,
    stat_disknode,
};
use super::walk::scan_directory;
use super::watches::{
    DirWatches, PathHint, classify_event, is_transient_list_error, may_drop_watches,
};
use super::{
    ChangeType, Clock, DEGRADED_RESCAN_COST_FACTOR, DiskfileChange, EVENT_CHANNEL_CAPACITY,
    FilerChangeParams, IgnoredWire, REPRUNE_BROADCAST_MAX, SerializableDisknode, dir_prefix,
};
use parking_lot::Mutex;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use std::time::{Duration, SystemTime};
use tokio::sync::{RwLock, mpsc, oneshot};
use tokio::time::Instant;

/// A change a sync found: the path, how it changed, and its node.
type Change = (String, ChangeType, SerializableDisknode);

// -- Debouncing ---------------------------------------------------------------

/// Quiet period after a path's last change before its broadcast fires.
const DEBOUNCE_DURATION: Duration = Duration::from_millis(80);

/// Longest a pending broadcast waits after its first queued change, so a
/// path written more often than every [`DEBOUNCE_DURATION`] still broadcasts.
pub(super) const DEBOUNCE_MAX_WAIT: Duration = Duration::from_millis(500);

/// A pending debounced notification (broadcast only — index updates are immediate).
pub(super) struct PendingNotification {
    pub(super) change_type: ChangeType,
    /// When the first change of this pending run was queued.
    first_queued: Instant,
    deadline: Instant,
    disknode: SerializableDisknode,
}

/// The broadcast deadline for a change queued at `now` in a pending run that
/// started at `first_queued`: a quiet period, capped by the max wait.
fn debounce_deadline(now: Instant, first_queued: Instant) -> Instant {
    (now + DEBOUNCE_DURATION).min(first_queued + DEBOUNCE_MAX_WAIT)
}

/// Fold a new change into a path's pending (not yet broadcast) change.
///
/// `add`+`change` → `add`; `delete`+`add` → `change` (replaced in place, e.g.
/// an atomic save — clients still hold the path). `add`+`delete` → `delete`,
/// not nothing: `session_load` / `project_open` read the index directly, so
/// a client may already hold a path whose `add` broadcast is still pending,
/// and a `delete` for a path a client never saw is a no-op for it. A file
/// changed and changed back inside one window still broadcasts its `change`
/// — the fold doesn't compare against what was last broadcast.
pub(super) const fn coalesce_change(prev: Option<ChangeType>, next: ChangeType) -> ChangeType {
    match (prev, next) {
        (None, next) => next,
        (Some(_), ChangeType::Delete) => ChangeType::Delete,
        (Some(ChangeType::Add), _) => ChangeType::Add,
        (Some(ChangeType::Change | ChangeType::Delete), _) => ChangeType::Change,
    }
}

// -- Git's ignore rule, live --------------------------------------------------

/// Most paths one burst ([`FilerState::vet_adds`]) or one rescan
/// ([`FilerState::vet_scanned`]) vets with a `check_ignore`; past it the
/// filer re-prunes instead. git's check costs about 1.8 µs per path per
/// index entry, so a vet grows with the paths times the index. Measured
/// 2026-11-17 on a 160k-entry index (sparse wpt): about 1.8 ms per path,
/// 1024 paths in 1.8 s against the 2 s
/// [`CHECK_TIMEOUT`](super::ignore::CHECK_TIMEOUT), while a re-prune of
/// that tree took about 0.3 s — cheaper past about 150 paths (on an
/// 81k-entry index, past about 500). At 128 a full vet stays near a quarter
/// second on the largest trees measured, well inside the timeout; a burst
/// past it is a tree arriving wholesale (an unpacked archive, a checkout),
/// which one listing answers sooner than path by path.
pub(super) const VET_MAX_PATHS: usize = 128;

/// Most new directories one burst lists the ignored paths of, one
/// `ls_ignored` each, before a re-prune is cheaper.
const VET_MAX_NEW_DIRS: usize = 8;

/// How many times a burst re-asks about paths that turned into directories
/// while git answered for them (an answer about a missing path is about a
/// file), before it re-prunes instead.
const VET_ROUNDS: usize = 3;

/// Paths a git root's set gains from live vetting before it's rebuilt by a
/// re-prune — an ignored path's deletion isn't seen (its events are filtered
/// out), so a tool churning uniquely named ignored files would grow the set
/// without bound.
const LIVE_ADDED_MAX: usize = 10_000;

/// Quiet time after a `.gitignore` or `info/exclude` change before its
/// re-prune runs, each change restarting it. A checkout or a rebase step
/// writes its files within a few hundred milliseconds, and between steps
/// git spawns its next process in tens; waiting out the quiet applies the
/// end state once, not each intermediate one (a `node_modules/`
/// un-ignored mid-checkout would broadcast every file in it). It stays
/// short of the lag a hand edit of a `.gitignore` would show.
pub(super) const REPRUNE_SETTLE: Duration = Duration::from_millis(400);

/// Longest a rule change's re-prune waits after its first change, so a
/// `.gitignore` rewritten more often than every [`REPRUNE_SETTLE`] (a long
/// rebase, a tool regenerating it) still re-prunes.
pub(super) const REPRUNE_SETTLE_MAX_WAIT: Duration = Duration::from_secs(5);

/// Re-prunes in a row that a change on disk asked for — a rule edit, lost
/// events, new files git couldn't vet, a set grown past
/// [`LIVE_ADDED_MAX`] — whose listing fails (a timeout, a git error)
/// before a git root falls back to fixed names for good. One failure keeps
/// the last set and waits for the next trigger — a failed re-prune never
/// retries itself, so each failure is a separate trigger's: a cold cache on
/// a large tree, or a load spike, can outlast `LIST_TIMEOUT` once. Three
/// separate changes failing in a row is a git that can't answer for this
/// root (a FIFO `.gitignore` blocks every listing), and a set that can't be
/// refreshed drifts from git's answer silently.
///
/// The retries while one has failed — each `session_load` rescan and
/// degraded poll ([`FilerState::reprune_if_failing`]) — don't count: they
/// come at the user's and the poll's pace, not the disk's, and a reload or
/// two shouldn't give up git's rule. So a git that never answers costs a
/// listing's timeout per degraded poll and per load until a third change
/// fails too — on a quiet degraded tree, possibly never. Each load waits
/// out that timeout (`LIST_TIMEOUT`, 5 s) with the filer's loop blocked;
/// the polls are bounded by `DEGRADED_RESCAN_COST_FACTOR`, which spaces
/// them by ten times the poll's own duration — about 50 s apart, roughly a
/// 10% duty cycle.
pub(super) const REPRUNE_MAX_FAILURES: u32 = 3;

/// What a re-prune answers ([`FilerState::reprune`]) — whether its failure
/// counts toward [`REPRUNE_MAX_FAILURES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RepruneTrigger {
    /// A re-prune a change on disk asked for (a rule edit, lost events, new
    /// files git couldn't vet, a set grown past its budget): a failure
    /// counts.
    Change,
    /// A retry after a failure, by a `session_load` rescan or a degraded
    /// poll: a failure doesn't count.
    Retry,
}

/// A git root's live ignore state ([`FilerState::git`]).
pub(super) struct GitIgnore {
    pub(super) root: GitRoot,
    /// `<root>/.git/info/exclude`, whose events the filer's watcher passes
    /// through (see `DirWatches::watch_git_info`).
    pub(super) exclude: PathBuf,
    /// Paths live vetting added to the set since the last prune.
    pub(super) live_added: usize,
    /// Re-prunes in a row a change on disk asked for whose listing failed
    /// ([`REPRUNE_MAX_FAILURES`]); nonzero while the last re-prune failed.
    pub(super) failures: u32,
}

/// A re-prune waiting to run ([`FilerState::reprune`]).
#[derive(Debug, Clone, Copy)]
pub(super) struct PendingReprune {
    /// Whether it rebuilds the watches too.
    reset_watches: bool,
    /// When it runs.
    due: Instant,
    /// When the first request of a re-prune waiting for the rule's files to
    /// settle came — what [`REPRUNE_SETTLE_MAX_WAIT`] counts from. `None`
    /// for one due at once.
    settling_since: Option<Instant>,
}

impl PendingReprune {
    /// The re-prune pending once a rule change is requested at `now`, with
    /// `prev` pending before it (see [`FilerState::request_settled_reprune`]).
    pub(super) fn settled(prev: Option<Self>, now: Instant) -> Self {
        let Some(prev) = prev else {
            return Self {
                reset_watches: false,
                due: now + REPRUNE_SETTLE,
                settling_since: Some(now),
            };
        };
        prev.settling_since.map_or(prev, |since| Self {
            due: (now + REPRUNE_SETTLE).min(since + REPRUNE_SETTLE_MAX_WAIT),
            ..prev
        })
    }

    /// When it runs.
    pub(super) const fn due(&self) -> Instant {
        self.due
    }

    /// A re-prune due at once.
    pub(super) fn now(reset_watches: bool) -> Self {
        Self {
            reset_watches,
            due: Instant::now(),
            settling_since: None,
        }
    }
}

/// How a sync vets the files its walk finds ([`FilerState::sync_subtree`]).
#[derive(Debug)]
pub(super) enum Vetting {
    /// One `check_ignore` over the files not yet indexed
    /// ([`FilerState::vet_scanned`]) — a walk no listing just preceded.
    Scan,
    /// List the dir again after the walk, against the listing that preceded
    /// it ([`FilerState::relist`]) — a burst's new dir's, or `None` for a
    /// re-prune's walk of the root, whose listing is the set itself.
    Relist(Option<IgnoredSet>),
    /// Nothing — no git, or none that answers.
    Off,
}

// -- Event loop ---------------------------------------------------------------

/// State owned by a filer's event-loop task: the index (shared for reads),
/// the directory watches, the ignore rule, and the pending debounced
/// broadcasts.
pub(super) struct FilerState {
    pub(super) source_dir: String,
    pub(super) ignored_dirs: Vec<PathBuf>,
    /// What the filer ignores; the event loop is its only writer.
    pub(super) rule: SharedRule,
    /// Whether the set is on the wire, and the resync count the loop bumps.
    pub(super) wire: Arc<IgnoredWire>,
    /// A git root's handle on git — `None` under fixed names, for good once
    /// git can't answer any more.
    pub(super) git: Option<GitIgnore>,
    /// A re-prune waiting to run once it's due and the current step is done.
    pub(super) reprune: Option<PendingReprune>,
    /// Directories (prefix form) whose ignored paths this burst already
    /// listed, each with that listing — their walk lists them again rather
    /// than vet what it finds ([`Vetting::Relist`]).
    pub(super) vetted: HashMap<String, IgnoredSet>,
    pub(super) depth: FilerDepth,
    pub(super) files: Arc<RwLock<FileIndex>>,
    /// Keyed by index path.
    pub(super) pending: HashMap<String, PendingNotification>,
    pub(super) watches: Arc<Mutex<DirWatches>>,
    /// `DirWatches::unwatched_count`, readable without the lock.
    pub(super) unwatched_count: Arc<AtomicUsize>,
    pub(super) degraded_rescan_interval: Duration,
    /// What a stamp's trust is judged against (see [`reusable_stat`](super::index::reusable_stat)).
    pub(super) clock: Clock,
}

impl FilerState {
    /// Apply one notify event to the index and the pending broadcasts.
    pub(super) async fn handle_event(&mut self, event: notify::Event) {
        let drops_watches = may_drop_watches(event.kind);
        let rule = self.rule.get();
        let source_dir = PathBuf::from(&self.source_dir);
        let source_dir = source_dir.as_path();
        for (path, hint) in classify_event(event.kind, event.paths) {
            // a `.git` appearing in a watched directory makes it a repo of
            // its own: its re-sync walks nothing there, dropping what's
            // indexed
            let (path, hint) = match rule_marker(&path, source_dir, &self.ignored_dirs, &rule) {
                Some(RuleMarker::RepoDir(dir)) => (dir, PathHint::Entry),
                _ => (path, hint),
            };
            if is_ignored(&path, source_dir, &self.ignored_dirs, &rule)
                || (rule.is_git() && is_in_nested_repo(&path, source_dir))
            {
                continue;
            }
            // A directory removed or renamed away takes its watches along
            // (notify drops them; a moved directory's are dropped here). If
            // something is at the path again, `apply_hint` re-watches it.
            if drops_watches && let Some(path_str) = path.to_str() {
                self.unwatch_tree(path_str).await;
            }
            self.apply_hint(&path, hint).await;
        }
    }

    /// Resolve a path hint against the disk (`lstat`, never following links).
    async fn apply_hint(&mut self, path: &Path, hint: PathHint) {
        // `handle_event` filters non-UTF-8 paths through `is_ignored`
        let Some(path_str) = path.to_str().map(str::to_owned) else {
            return;
        };
        // The path's type may have changed since it was indexed (a directory
        // replaced by a file or vice versa), so each branch also clears what
        // the other type would have left behind.
        // the clock before the `lstat`, never after: a stamp is trusted
        // against a time no later than it was taken (see `reusable_stat`)
        let observed_at = (self.clock)();
        match tokio::fs::symlink_metadata(path).await {
            Ok(meta) if meta.is_file() => {
                self.remove_children(&path_str).await;
                self.upsert(path_str, &meta, observed_at).await;
            }
            // a top-level filer indexes nothing below its root
            Ok(meta)
                if meta.is_dir()
                    && self.depth == FilerDepth::TopLevel
                    && dir_prefix(&path_str) != self.source_dir =>
            {
                self.remove_tree(&path_str).await;
            }
            Ok(meta) if meta.is_dir() => {
                self.remove_entry(&path_str).await;
                let watched = self.watches.lock().is_watched(&dir_prefix(&path_str));
                // a watched directory changed in place only needs a sync if
                // it can't be listed any more (chmod'ed unreadable) — which
                // drops what's indexed under it
                if hint == PathHint::Entry || !watched || tokio::fs::read_dir(path).await.is_err() {
                    self.sync_subtree(&path_str, false, Vetting::Scan).await;
                }
            }
            // the root itself is gone: its failing sync empties the index
            // and keeps the root polled until it's back
            _ if dir_prefix(&path_str) == self.source_dir => {
                self.sync_subtree(&path_str, false, Vetting::Scan).await;
            }
            // missing (a stale or short-lived event), a symlink, or a
            // special file — nothing indexable lives here
            _ => self.remove_tree(&path_str).await,
        }
    }

    /// Index one regular file by its `lstat` (`meta`, taken after
    /// `observed_at`), queueing `add` (newly indexed) or `change` (indexed,
    /// and not known to be unchanged — see [`is_unchanged`]). An unchanged
    /// file is left as it is.
    async fn upsert(&mut self, path: String, meta: &std::fs::Metadata, observed_at: SystemTime) {
        let (change, node) = {
            let mut index = self.files.write().await;
            let change = match index.get(&path) {
                None => ChangeType::Add,
                Some(old) if is_unchanged(old.stat, FileStat::of(meta)) => return,
                Some(_) => ChangeType::Change,
            };
            let node = stat_disknode(path.clone(), &self.source_dir, meta, observed_at);
            index.insert(path.clone(), node.clone());
            (change, node)
        };
        self.queue(path, change, node);
    }

    /// Remove `path` and every file indexed under it, with any watches.
    async fn remove_tree(&mut self, path: &str) {
        self.remove_entry(path).await;
        self.remove_children(path).await;
    }

    /// Remove the index entry at exactly `path`, if any.
    async fn remove_entry(&mut self, path: &str) {
        let removed = self.files.write().await.remove(path);
        if let Some(node) = removed {
            self.queue(path.to_owned(), ChangeType::Delete, deleted_disknode(node));
        }
    }

    /// Remove every index entry under `path/`, and the watches and nested
    /// repos there — the path is no longer a directory.
    async fn remove_children(&mut self, path: &str) {
        self.unwatch_tree(path).await;
        self.rule.set_nested_under(&dir_prefix(path), &[], &[]);
        let removed = {
            let mut index = self.files.write().await;
            apply_subtree(&mut index, &dir_prefix(path), ScanIndex::new())
        };
        for (path, change, node) in removed {
            self.queue(path, change, node);
        }
    }

    /// Drop the watches at and under `path` (see [`DirWatches::drop_under`]),
    /// on a blocking thread when there are any.
    async fn unwatch_tree(&self, path: &str) {
        let prefix = dir_prefix(path);
        if !self.watches.lock().tracks_under(&prefix) {
            return;
        }
        let watches = Arc::clone(&self.watches);
        let _ = tokio::task::spawn_blocking(move || watches.lock().drop_under(&prefix)).await;
    }

    /// Re-walk `dir` (watching its directories) and reconcile the index
    /// entries under it. A `dir` that's unreadable or gone leaves nothing
    /// under it — and if it's the root, it's polled until it's back. What's
    /// indexed under a directory whose listing failed transiently is kept
    /// (and the directory polled), never broadcast as deleted.
    ///
    /// Under a git root, what the walk found is vetted as `vetting` says —
    /// except that a dir this burst listed the ignored paths of is listed
    /// again instead ([`Vetting::Relist`]).
    async fn sync_subtree(&mut self, dir: &str, reset_watches: bool, vetting: Vetting) {
        for (path, change, node) in self.sync_changes(dir, reset_watches, vetting).await {
            self.queue(path, change, node);
        }
    }

    /// [`Self::sync_subtree`] up to the changes it applied to the index,
    /// which it returns rather than queues.
    async fn sync_changes(
        &mut self,
        dir: &str,
        reset_watches: bool,
        vetting: Vetting,
    ) -> Vec<Change> {
        let prefix = dir_prefix(dir);
        let scanned = scan_directory(
            &prefix,
            &self.source_dir,
            &self.ignored_dirs,
            self.rule.get(),
            self.depth,
            &self.watches,
            reset_watches,
            self.clock,
            Some(&*self.files),
        )
        .await;
        let (mut fresh, kept) = match scanned {
            Ok(scan) => {
                self.rule
                    .set_nested_under(&prefix, &scan.nested, &scan.kept);
                (scan.files, scan.kept)
            }
            Err(e) if is_transient_list_error(&e) => return vec![],
            Err(_) => {
                self.rule.set_nested_under(&prefix, &[], &[]);
                (ScanIndex::new(), vec![])
            }
        };
        let vetting = match (self.git.is_some(), self.vetted.remove(&prefix)) {
            (false, _) => Vetting::Off,
            (true, Some(first)) => Vetting::Relist(Some(first)),
            (true, None) => vetting,
        };
        let scan_vetted = matches!(vetting, Vetting::Scan);
        match vetting {
            Vetting::Scan => self.vet_scanned(&mut fresh).await,
            Vetting::Relist(first) => self.relist(&prefix, first, &mut fresh).await,
            Vetting::Off => {}
        }
        let changes = {
            let mut index = self.files.write().await;
            for kept_dir in &kept {
                for key in index
                    .range::<str, _>((Bound::Included(kept_dir.as_str()), Bound::Unbounded))
                    .map(|(key, _)| key)
                    .take_while(|key| key.starts_with(kept_dir.as_str()))
                {
                    fresh.entry(key.clone()).or_insert(ScannedFile::Unchanged);
                }
            }
            apply_subtree(&mut index, &prefix, fresh)
        };
        // a `.gitignore` only a scan saw change (in an unwatched dir, while
        // degraded) — a listing's own walk finds none git didn't read
        if scan_vetted {
            let rule = self.rule.get();
            let source_dir = Path::new(&self.source_dir);
            if changes.iter().any(|(path, _, _)| {
                rule_marker(Path::new(path), source_dir, &self.ignored_dirs, &rule)
                    == Some(RuleMarker::Gitignore)
            }) {
                self.request_settled_reprune();
            }
        }
        changes
    }

    /// Reconcile the whole index with the disk. `reset_watches` rebuilds
    /// every watch on a fresh watcher ([`DirWatches::reset`]) — after lost
    /// events, when the watch state can't be trusted.
    pub(super) async fn rescan(&mut self, reset_watches: bool) {
        self.watches.lock().retry_watches();
        let root = self.source_dir.clone();
        self.sync_subtree(&root, reset_watches, Vetting::Scan).await;
    }

    /// Degraded mode: rescan each directory without a watch (each unwatched
    /// subtree once), retrying their watches.
    pub(super) async fn rescan_unwatched(&mut self) {
        let roots = {
            let mut watches = self.watches.lock();
            watches.retry_watches();
            watches.unwatched_roots()
        };
        for root in roots {
            self.sync_subtree(&root, false, Vetting::Scan).await;
        }
    }

    // -- Git's rule, live -----------------------------------------------------

    /// Apply a burst of notify events — under a git root, once its adds are
    /// vetted ([`Self::vet_adds`]). A `.gitignore` or `info/exclude` among
    /// them requests a re-prune once they settle, and a vetting that fails
    /// one at once; the burst is then dropped, as is every burst while a
    /// re-prune is pending: the re-prune's full rescan resolves every path
    /// they named against the disk.
    pub(super) async fn handle_burst(&mut self, events: Vec<notify::Event>) {
        if let Some(exclude) = self.git.as_ref().map(|git| git.exclude.clone()) {
            // a snapshot held across `vet_adds` would make each of its
            // `add_ignored`s clone the whole set
            let rule_changed = {
                let rule = self.rule.get();
                let source_dir = Path::new(&self.source_dir);
                events.iter().flat_map(|e| &e.paths).any(|path| {
                    *path == exclude
                        || rule_marker(path, source_dir, &self.ignored_dirs, &rule)
                            == Some(RuleMarker::Gitignore)
                })
            };
            if rule_changed {
                self.request_settled_reprune();
            }
            if self.reprune.is_some() {
                self.drop_watches_of(&events).await;
                return;
            }
            if !self.vet_adds(&events).await {
                self.request_reprune(false);
                self.drop_watches_of(&events).await;
                return;
            }
        }
        for event in events {
            self.handle_event(event).await;
        }
        self.vetted.clear();
    }

    /// Drop the watches a dropped burst's removes and renames took with
    /// them, as [`Self::handle_event`] would: the re-prune's walk trusts a
    /// directory's watch bookkeeping, so one removed and made again under
    /// the same path would stay unwatched.
    async fn drop_watches_of(&self, events: &[notify::Event]) {
        for event in events.iter().filter(|event| may_drop_watches(event.kind)) {
            for path in event.paths.iter().filter_map(|path| path.to_str()) {
                self.unwatch_tree(path).await;
            }
        }
    }

    /// Ask git about the paths `events` add that aren't indexed yet — files
    /// not in the index, directories not watched — in one `check_ignore`,
    /// adding the ignored ones to the set; then list the ignored paths of
    /// each new directory git doesn't ignore, before its walk. A missing
    /// path is asked about as a file (it may be back by the time its event
    /// is applied); symlinks aren't asked about, nor are paths in a repo of
    /// their own (nested repos and populated submodules aren't indexed, and
    /// `check_ignore` refuses a submodule's paths — an unpopulated
    /// submodule it refuses one in is left unindexed). A dir the set prunes
    /// that's a file now leaves the set's dirs and is asked about as the
    /// file. The reverse isn't vetted: a file the set ignores that's a dir
    /// now (git ignoring `x` but not `x/`) stays skipped as the file was,
    /// and the dir is picked up at the next re-prune or rescan.
    ///
    /// Returns false when the burst must re-prune instead: git failed (a
    /// failed batch says nothing about which paths are ignored), or the
    /// burst is too big to vet path by path.
    async fn vet_adds(&mut self, events: &[notify::Event]) -> bool {
        let Some(root) = self.git.as_ref().map(|git| git.root.clone()) else {
            return true;
        };
        let source_dir = PathBuf::from(&self.source_dir);
        let source_dir = source_dir.as_path();
        let mut candidates = BTreeSet::new();
        // dirs the set prunes that an event named
        let mut pruned = BTreeSet::new();
        {
            let rule = self.rule.get();
            let index = self.files.read().await;
            let watches = self.watches.lock();
            for path in events.iter().flat_map(|e| &e.paths) {
                let Some(path_str) = path.to_str() else {
                    continue;
                };
                if rule.prunes_dir(path) {
                    pruned.insert(path_str.to_owned());
                    continue;
                }
                if is_ignored(path, source_dir, &self.ignored_dirs, &rule) {
                    continue;
                }
                if dir_prefix(path_str) == self.source_dir
                    || index.contains_key(path_str)
                    || watches.is_watched(&dir_prefix(path_str))
                {
                    continue;
                }
                candidates.insert(path_str.to_owned());
            }
        }
        // (path, whether it was a directory when asked about)
        let mut round: Vec<(String, bool)> = Vec::new();
        for path in pruned {
            // still a dir, or gone: the set still answers for it
            if tokio::fs::symlink_metadata(&path)
                .await
                .is_ok_and(|meta| meta.is_file())
            {
                self.rule.forget_dir(&path);
                round.push((path, false));
            }
        }
        for path in candidates {
            let Ok(meta) = tokio::fs::symlink_metadata(&path).await else {
                // asked about as a file, so one that's back by the time its
                // event is applied isn't indexed unasked
                if !is_in_nested_repo(Path::new(&path), source_dir) {
                    round.push((path, false));
                }
                continue;
            };
            let in_repo = is_in_nested_repo(Path::new(&path), source_dir)
                || (meta.is_dir() && is_nested_repo(Path::new(&path)));
            if (meta.is_file() || meta.is_dir()) && !in_repo {
                round.push((path, meta.is_dir()));
            }
        }
        if round.len() > VET_MAX_PATHS {
            return false;
        }
        let mut new_dirs = Vec::new();
        for _ in 0..VET_ROUNDS {
            if round.is_empty() {
                break;
            }
            let asked = round.iter().map(|(path, _)| path.clone()).collect();
            let checked = match root.check(asked).await {
                Ok(checked) => checked,
                Err(e) => {
                    tracing::debug!(
                        path = %self.source_dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "git couldn't vet a burst of new paths; re-pruning"
                    );
                    return false;
                }
            };
            for submodule in &checked.submodules {
                self.leave_unindexed(submodule).await;
            }
            let ignored: HashSet<String> = checked.ignored.into_iter().collect();
            let mut found = IgnoredSet::default();
            let mut again = Vec::new();
            for (path, was_dir) in round {
                if ignored.contains(&path) {
                    found.insert(path, was_dir);
                    continue;
                }
                if checked
                    .submodules
                    .iter()
                    .any(|submodule| Path::new(&path).starts_with(submodule))
                {
                    continue;
                }
                let is_dir = tokio::fs::symlink_metadata(&path)
                    .await
                    .is_ok_and(|meta| meta.is_dir());
                if is_dir && !was_dir {
                    // asked about as a file: ask again, as the directory
                    again.push((path, true));
                } else if is_dir {
                    new_dirs.push(path);
                }
            }
            self.add_ignored(&found);
            round = again;
        }
        if !round.is_empty() || new_dirs.len() > VET_MAX_NEW_DIRS {
            return false;
        }
        for dir in new_dirs {
            match root.prune(PathBuf::from(&dir)).await {
                Ok(listed) => {
                    self.add_ignored(&listed);
                    self.vetted.insert(dir_prefix(&dir), listed);
                }
                Err(e) => {
                    tracing::debug!(
                        path = %dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "git couldn't list a new directory's ignored paths; re-pruning"
                    );
                    return false;
                }
            }
        }
        true
    }

    /// Leave `dir`, an unpopulated submodule's, unindexed — as a populated
    /// one is: add it to the set's pruned dirs, and drop what's indexed and
    /// watched under it.
    async fn leave_unindexed(&mut self, dir: &str) {
        let mut set = IgnoredSet::default();
        set.insert_submodule(dir.to_owned());
        self.rule.extend(&set);
        self.remove_tree(dir).await;
    }

    /// Drop from `fresh` (a scan's result) the new files git ignores —
    /// files a walk found that no event vetted: a rescan's (`session_load`'s,
    /// a degraded poll's), or a directory's sync. One `check_ignore` when
    /// there are any. A failure, or too many to vet, drops the new files
    /// from `fresh` — unvetted, they stay unindexed until a pass vets them,
    /// since the re-prune it requests is dropped when this is a failed
    /// re-prune's own scan — and requests a re-prune. An ignored file in a
    /// watched dir requests one and leaves `fresh` as it is for the re-prune
    /// to correct: an event vets what arrives there, so the scan reached a
    /// dir nothing vetted (one a `.git` just left), which its listing would
    /// prune whole rather than file by file.
    async fn vet_scanned(&mut self, fresh: &mut ScanIndex) {
        let Some(root) = self.git.as_ref().map(|git| git.root.clone()) else {
            return;
        };
        let new: Vec<String> = {
            let index = self.files.read().await;
            fresh
                .iter()
                .filter(|(path, scanned)| {
                    matches!(scanned, ScannedFile::Updated(_)) && !index.contains_key(*path)
                })
                .map(|(path, _)| path.clone())
                .collect()
        };
        if new.is_empty() {
            return;
        }
        if new.len() > VET_MAX_PATHS {
            // too many to vet in one check: unvetted, they stay out until a
            // pass vets them, as on a failed check below
            for path in &new {
                fresh.remove(path);
            }
            self.request_reprune(false);
            return;
        }
        match root.check(new.clone()).await {
            Ok(checked) => {
                for submodule in &checked.submodules {
                    let prefix = dir_prefix(submodule);
                    fresh.retain(|path, _| !path.starts_with(&prefix));
                    self.leave_unindexed(submodule).await;
                }
                let in_watched_dir = {
                    let watches = self.watches.lock();
                    checked.ignored.iter().any(|path| {
                        Path::new(path)
                            .parent()
                            .and_then(Path::to_str)
                            .is_some_and(|parent| watches.is_watched(&dir_prefix(parent)))
                    })
                };
                let mut found = IgnoredSet::default();
                for path in checked.ignored {
                    fresh.remove(&path);
                    found.insert(path, false);
                }
                self.add_ignored(&found);
                if in_watched_dir {
                    self.request_reprune(false);
                }
            }
            Err(e) => {
                tracing::debug!(
                    path = %self.source_dir,
                    error = %fuz_sys::cli::format_error_chain(&e),
                    "git couldn't vet a scan's new files; re-pruning"
                );
                // unvetted, they stay out until a pass vets them: the
                // re-prune requested here is dropped when this scan is a
                // failed re-prune's own
                for path in &new {
                    fresh.remove(path);
                }
                self.request_reprune(false);
            }
        }
    }

    /// The second listing of `prefix`, after its walk: what was created
    /// between `first` (the listing before it) and the walk is in `fresh`
    /// unvetted, and its later events would skip it as indexed. What git
    /// ignores now and didn't then is dropped from `fresh` with any watches
    /// the walk added under it — the root's listing replacing the set, a
    /// dir's adding to it. Anything created after this listing arrives as an
    /// event, vetted. A path that left the set needs no walk: git stops
    /// ignoring an existing path only when an excludes file changes, which
    /// re-prunes on its own, or when it's tracked, which no event reports
    /// anyway. A failed listing re-prunes.
    async fn relist(&mut self, prefix: &str, first: Option<IgnoredSet>, fresh: &mut ScanIndex) {
        let Some(root) = self.git.as_ref().map(|git| git.root.clone()) else {
            return;
        };
        let dir = super::prefix_dir(prefix).to_path_buf();
        let second = match root.prune(dir).await {
            Ok(second) => second,
            Err(e) => {
                tracing::debug!(
                    path = %prefix,
                    error = %fuz_sys::cli::format_error_chain(&e),
                    "git couldn't list a walked directory's ignored paths again; re-pruning"
                );
                self.request_reprune(false);
                return;
            }
        };
        let Some(first) = first else {
            // the root's: its listing replaces the set
            let added = match &*self.rule.get() {
                IgnoreRule::Git(current) => second.added_since(current),
                IgnoreRule::FixedNames => return,
            };
            self.rule.set(IgnoreRule::Git(second));
            drop_newly_ignored(&added, &self.source_dir, fresh, &self.watches).await;
            return;
        };
        let added = second.added_since(&first);
        self.add_ignored(&added);
        drop_newly_ignored(&added, &self.source_dir, fresh, &self.watches).await;
    }

    /// Add live-vetted paths to the set, re-pruning once it has grown by
    /// [`LIVE_ADDED_MAX`] since the last prune.
    fn add_ignored(&mut self, paths: &IgnoredSet) {
        if paths.is_empty() {
            return;
        }
        let added = self.rule.extend(paths);
        let Some(git) = self.git.as_mut() else {
            return;
        };
        git.live_added += added;
        if git.live_added > LIVE_ADDED_MAX {
            self.request_reprune(false);
        }
    }

    /// Request a re-prune ([`Self::run_pending_reprune`]) at once, rebuilding
    /// the watches too if `reset_watches` — coalesced with any already
    /// pending, which then runs at once too.
    pub(super) fn request_reprune(&mut self, reset_watches: bool) {
        let prev_reset = self.reprune.is_some_and(|prev| prev.reset_watches);
        self.reprune = Some(PendingReprune::now(reset_watches || prev_reset));
    }

    /// Request a re-prune once the rule's files settle: [`REPRUNE_SETTLE`]
    /// after this request, unless another comes first, and no later than
    /// [`REPRUNE_SETTLE_MAX_WAIT`] after the first. One already due at once
    /// stays so.
    pub(super) fn request_settled_reprune(&mut self) {
        self.reprune = Some(PendingReprune::settled(self.reprune, Instant::now()));
    }

    /// When the pending re-prune is due, if there is one.
    pub(super) fn reprune_due(&self) -> Option<Instant> {
        self.reprune.as_ref().map(PendingReprune::due)
    }

    /// Run the pending re-prune, if one is due by `now`.
    pub(super) async fn run_pending_reprune(&mut self, now: Instant) {
        if let Some(pending) = self.reprune.filter(|pending| pending.due <= now) {
            self.reprune = None;
            self.reprune(pending.reset_watches, RepruneTrigger::Change)
                .await;
        }
    }

    /// Recompute a git root's ignored set from scratch and apply the
    /// difference — its full rescan removes (and broadcasts deletes for) what
    /// is newly ignored, dropping its watches, and walks and adds what no
    /// longer is; then it lists again ([`Self::relist`]). Without git (fixed
    /// names, or a fallback) it's a rescan.
    ///
    /// Runs inline on the event loop, behind the listing's timeout: the loop
    /// is the index's only writer, so a re-prune on a task of its own would
    /// race the events applied meanwhile against the set it's replacing.
    /// Events queue while it runs, and an overflow coalesces into one more.
    ///
    /// The root no longer the checkout it was (a symlink swapped in, its
    /// `.git` gone) falls back to fixed names for the rest of the filer's
    /// life, and so do [`REPRUNE_MAX_FAILURES`] failed listings in a row of
    /// `trigger`s that count ([`RepruneTrigger::Change`]): a set that can't
    /// be refreshed would drift from git's answer silently. A failure short
    /// of that keeps the last set — the rescan vetting what it finds — until
    /// the next trigger (an edit, an overflow, a rescan that asks for one,
    /// and while a failure is the last word any `session_load` rescan or
    /// degraded poll, [`Self::reprune_if_failing`], whose failures don't
    /// count) re-prunes; nothing the failed re-prune's own rescan requests
    /// counts, so it never retries itself.
    pub(super) async fn reprune(&mut self, reset_watches: bool, trigger: RepruneTrigger) {
        let Some(git) = self.git.as_mut() else {
            self.rescan(reset_watches).await;
            return;
        };
        let root = git.root.clone();
        let vetting = match root.prune(root.dir().to_path_buf()).await {
            Ok(set) => {
                git.live_added = 0;
                git.failures = 0;
                self.rule.set(IgnoreRule::Git(set));
                Vetting::Relist(None)
            }
            Err(e) => {
                // a retry's failure leaves the count as it was, nonzero, so
                // the next load or poll retries again
                if trigger == RepruneTrigger::Change {
                    git.failures += 1;
                }
                let unconfined = matches!(e, IgnoreError::Unconfined(_));
                if unconfined || git.failures >= REPRUNE_MAX_FAILURES {
                    tracing::warn!(
                        path = %self.source_dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "git can't answer what this root ignores any more; ignoring by fixed names"
                    );
                    self.rule.set(IgnoreRule::FixedNames);
                    self.git = None;
                    Vetting::Off
                } else {
                    tracing::warn!(
                        path = %self.source_dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        failures = git.failures,
                        "git couldn't list what this root ignores; keeping the last listing until the next re-prune"
                    );
                    Vetting::Scan
                }
            }
        };
        self.vetted.clear();
        self.watches.lock().retry_watches();
        let source_dir = self.source_dir.clone();
        let failed = matches!(vetting, Vetting::Scan);
        let changes = self.sync_changes(&source_dir, reset_watches, vetting).await;
        self.queue_or_resync(changes);
        if failed {
            // its own rescan re-requests what it saw (the rule's file still
            // changed, a failing check): a failure never retries itself, so
            // one trigger can't spend every failure; the next one re-prunes
            self.reprune = None;
        }
    }

    /// Re-prune in place of a rescan — `session_load`'s, or a degraded
    /// poll's — while the last re-prune failed, returning whether it did.
    /// Each such rescan retries, so a failure short of
    /// [`REPRUNE_MAX_FAILURES`] keeps a rule change unapplied only until the
    /// next one — but a retry's failure doesn't count toward the fallback
    /// ([`RepruneTrigger::Retry`]): only re-prunes a change on disk asked
    /// for do, a pending one this takes with it included. A git that never
    /// answers so costs a listing's timeout per load and per degraded poll,
    /// on a quiet tree without end (bounded as [`REPRUNE_MAX_FAILURES`]
    /// says).
    pub(super) async fn reprune_if_failing(&mut self) -> bool {
        if self.git.as_ref().is_none_or(|git| git.failures == 0) {
            return false;
        }
        // take a pending request with it: one already settled would
        // otherwise run again right after, a second listing for one trigger
        let (reset_watches, trigger) = self
            .reprune
            .take()
            .map_or((false, RepruneTrigger::Retry), |pending| {
                (pending.reset_watches, RepruneTrigger::Change)
            });
        self.reprune(reset_watches, trigger).await;
        true
    }

    /// Queue a re-prune's changes — or, past [`REPRUNE_BROADCAST_MAX`] of
    /// them while the set is on the wire, none: un-ignoring a big tree (a
    /// `node_modules/`) would otherwise send a `filer_change` per file,
    /// tens of MB, to every socket. It bumps the resync count instead,
    /// which the loop then publishes ([`filer_event_loop`]), and every
    /// client pulls the dir whole once (`repo_files`) — reading the index
    /// this re-prune left, since the refresh that publishes the count
    /// follows it.
    ///
    /// Each held-back path's pending change goes too: a stale one sent
    /// after the pull's reply would undo it on the client. Off the wire (a
    /// permanent filer alone) nobody would pull, so it sends them all.
    ///
    /// @mutates self.pending - the changes queued, or their paths' pending
    ///   changes dropped
    pub(super) fn queue_or_resync(&mut self, changes: Vec<Change>) {
        if changes.len() > REPRUNE_BROADCAST_MAX && self.wire.on_wire.load(Ordering::Acquire) {
            tracing::debug!(
                path = %self.source_dir,
                changes = changes.len(),
                "a re-prune changed too many files to send each; clients pull the dir instead"
            );
            for (path, _, _) in &changes {
                self.pending.remove(path);
            }
            self.wire.resyncs.fetch_add(1, Ordering::AcqRel);
            return;
        }
        for (path, change, node) in changes {
            self.queue(path, change, node);
        }
    }

    /// What the publisher watches for change: the rule's version and the
    /// resync count.
    fn ignored_stamp(&self) -> (u64, u64) {
        (
            self.rule.version(),
            self.wire.resyncs.load(Ordering::Acquire),
        )
    }

    pub(super) fn is_degraded(&self) -> bool {
        self.unwatched_count.load(Ordering::Relaxed) > 0
    }

    /// Fold a change into the path's pending broadcast (see [`coalesce_change`]).
    fn queue(&mut self, path: String, change: ChangeType, disknode: SerializableDisknode) {
        self.queue_at(Instant::now(), path, change, disknode);
    }

    /// [`Self::queue`] with an explicit clock.
    fn queue_at(
        &mut self,
        now: Instant,
        path: String,
        change: ChangeType,
        disknode: SerializableDisknode,
    ) {
        let prev = self.pending.get(&path);
        let change_type = coalesce_change(prev.map(|p| p.change_type), change);
        let first_queued = prev.map_or(now, |p| p.first_queued);
        self.pending.insert(
            path,
            PendingNotification {
                change_type,
                first_queued,
                deadline: debounce_deadline(now, first_queued),
                disknode,
            },
        );
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|p| p.deadline).min()
    }

    /// Remove and return the pending broadcasts whose deadline has passed.
    fn take_ready(&mut self, now: Instant) -> Vec<PendingNotification> {
        self.pending
            .extract_if(|_, p| p.deadline <= now)
            .map(|(_, p)| p)
            .collect()
    }
}

/// Drop from `fresh` (a walk's result) what `added` — the paths a second
/// listing found ignored — covers, and the watches the walk added under its
/// dirs.
pub(super) async fn drop_newly_ignored(
    added: &IgnoredSet,
    source_dir: &str,
    fresh: &mut ScanIndex,
    watches: &Arc<Mutex<DirWatches>>,
) {
    if added.is_empty() {
        return;
    }
    let root = super::prefix_dir(source_dir);
    fresh.retain(|path, _| !added.covers(Path::new(path), root));
    let prefixes: Vec<String> = added.pruned_dirs().map(|dir| dir_prefix(dir)).collect();
    let watches = Arc::clone(watches);
    let _ = tokio::task::spawn_blocking(move || {
        let mut watches = watches.lock();
        for prefix in &prefixes {
            if watches.tracks_under(prefix) {
                watches.drop_under(prefix);
            }
        }
    })
    .await;
}

/// Background event loop: receives notify events and rescan requests,
/// updates the index, polls unwatched directories while degraded, runs a
/// git root's re-prunes when they're due, and broadcasts debounced
/// `filer_change` notifications.
pub(super) async fn filer_event_loop(
    mut state: FilerState,
    mut rx: mpsc::Receiver<notify::Event>,
    mut rescan_rx: mpsc::Receiver<oneshot::Sender<()>>,
    signal: Arc<RescanSignal>,
    ignored_signal: Arc<RescanSignal>,
    broadcast: FilerBroadcast,
) {
    // next degraded-mode rescan, while degraded
    let mut poll_at: Option<Instant> = None;
    // the set as `start_filer` left it is read by the commit that follows
    let mut published = state.ignored_stamp();
    loop {
        state.run_pending_reprune(Instant::now()).await;
        // checked here, between whole steps, so a refresh reads what a
        // step left — a re-prune's index included, not one partway through
        let stamp = state.ignored_stamp();
        if stamp != published {
            published = stamp;
            ignored_signal.request();
        }
        flush_ready(&mut state, Instant::now(), &broadcast).await;
        if !state.is_degraded() {
            poll_at = None;
        } else if poll_at.is_none() {
            poll_at = Some(Instant::now() + state.degraded_rescan_interval);
        }
        let next_deadline = state.next_deadline();
        let reprune_due = state.reprune_due();
        tokio::select! {
            biased;
            Some(reply) = rescan_rx.recv() => {
                // Every request already queued was sent before this scan
                // starts, so one scan answers them all (concurrent
                // `session_load`s share it instead of walking the tree
                // once each).
                let mut replies = vec![reply];
                while let Ok(reply) = rescan_rx.try_recv() {
                    replies.push(reply);
                }
                if !state.reprune_if_failing().await {
                    state.rescan(false).await;
                }
                for reply in replies {
                    let _ = reply.send(());
                }
            }
            // The watcher factory holds a sender, so the channel never closes
            // — not even while there's no watcher, when degraded polling and
            // rescans still run here.
            // what's queued is one burst, so a git root vets its adds with
            // one git call
            Some(event) = rx.recv() => {
                let mut burst = vec![event];
                while burst.len() < EVENT_CHANNEL_CAPACITY
                    && let Ok(event) = rx.try_recv()
                {
                    burst.push(event);
                }
                state.handle_burst(burst).await;
            }
            // Below `rx` so an overflow rescan runs once the backlog drains.
            () = signal.notify.notified() => {
                if signal.take() {
                    tracing::debug!(path = %state.source_dir, "file watcher overflowed, rescanning");
                    // events were lost, so the watch state may be stale too,
                    // and a git root's set: a re-prune (a rescan without git)
                    state.request_reprune(true);
                }
            }
            () = tokio::time::sleep_until(reprune_due.unwrap_or_else(Instant::now)),
                if reprune_due.is_some() => {}
            () = tokio::time::sleep_until(poll_at.unwrap_or_else(Instant::now)),
                if poll_at.is_some() => {
                let started = Instant::now();
                if !state.reprune_if_failing().await {
                    state.rescan_unwatched().await;
                }
                let wait = state
                    .degraded_rescan_interval
                    .max(started.elapsed() * DEGRADED_RESCAN_COST_FACTOR);
                poll_at = Some(Instant::now() + wait);
            }
            () = tokio::time::sleep_until(next_deadline.unwrap_or_else(Instant::now)),
                if next_deadline.is_some() => {}
        }
    }
}

/// Broadcast the pending changes whose deadline has passed by `now`.
///
/// Yields to the runtime after each broadcast. A broadcast only queues its
/// frame on every connection, and a connection's writer is another task: a
/// batch sent with no await in it would pile up whole in each queue, and one
/// larger than the queue's byte budget would close every socket before a
/// writer could take a frame. The yield gives the writers a turn to take the
/// frame first.
async fn flush_ready(state: &mut FilerState, now: Instant, broadcast: &FilerBroadcast) {
    for ready in state.take_ready(now) {
        let notification = filer_change_notification(&ready);
        broadcast(&notification);
        // each queue holds the registry's copy — free this one before the
        // yield instead of holding it across the writers' turn
        drop(notification);
        tokio::task::yield_now().await;
    }
}

/// The `filer_change` notification for a pending change.
fn filer_change_notification(pending: &PendingNotification) -> String {
    fuz_http::notification(
        "filer_change",
        &FilerChangeParams {
            change: DiskfileChange {
                change_type: pending.change_type,
                path: pending.disknode.id.clone(),
            },
            disknode: &pending.disknode,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::index::system_time_to_ms;
    use crate::filer::test_support::settled;
    use crate::filer::test_support::{
        TempDir, event, indexed, node, pending_of, state_for, state_on,
    };
    use notify::EventKind;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode};
    use serde_json::Value;

    #[test]
    fn coalesce_table() {
        use ChangeType::{Add, Change, Delete};
        let cases = [
            (None, Add, Add),
            (None, Change, Change),
            (None, Delete, Delete),
            // short-lived file — a client may have read the pending add
            // straight from the index, so it still hears the delete
            (Some(Add), Delete, Delete),
            (Some(Add), Change, Add),
            (Some(Add), Add, Add),
            // replaced in place — clients still hold it
            (Some(Delete), Add, Change),
            (Some(Delete), Change, Change),
            (Some(Delete), Delete, Delete),
            (Some(Change), Change, Change),
            (Some(Change), Add, Change),
            (Some(Change), Delete, Delete),
        ];
        for (prev, next, expected) in cases {
            assert_eq!(coalesce_change(prev, next), expected, "{prev:?} + {next:?}");
        }
    }

    /// The `params` of the `filer_change` notification for a pending change.
    fn notification_params(change_type: ChangeType, disknode: SerializableDisknode) -> Value {
        let now = Instant::now();
        let notification = filer_change_notification(&PendingNotification {
            change_type,
            first_queued: now,
            deadline: now,
            disknode,
        });
        let mut message: Value = serde_json::from_str(&notification).unwrap();
        assert_eq!(message["method"], "filer_change");
        message["params"].take()
    }

    #[test]
    fn a_notification_carries_metadata_and_no_contents() {
        // every change sends the node's metadata — never a `contents` key
        for (change_type, wire) in [(ChangeType::Add, "add"), (ChangeType::Change, "change")] {
            assert_eq!(
                notification_params(change_type, node("/w/f", 4, 2)),
                serde_json::json!({
                    "change": { "type": wire, "path": "/w/f" },
                    "disknode": {
                        "id": "/w/f",
                        "source_dir": "/w/",
                        "size": 4,
                        "ctime": null,
                        "mtime": 2,
                    },
                }),
                "{change_type:?}"
            );
        }
        // a delete's node is identity only
        assert_eq!(
            notification_params(ChangeType::Delete, deleted_disknode(node("/w/f", 4, 2))),
            serde_json::json!({
                "change": { "type": "delete", "path": "/w/f" },
                "disknode": {
                    "id": "/w/f",
                    "source_dir": "/w/",
                    "size": null,
                    "ctime": null,
                    "mtime": null,
                },
            })
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_events_are_not_indexed() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        let mut state = state_for(&tmp).await;

        symlink(tmp.path("a.txt"), tmp.path("link.txt")).unwrap();
        symlink(".", tmp.path("loop")).unwrap();
        state
            .handle_event(event(
                EventKind::Create(CreateKind::Any),
                &[tmp.path("link.txt"), tmp.path("loop")],
            ))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("a.txt")]);
        assert!(state.pending.is_empty());

        // a file replaced by a symlink leaves the index
        std::fs::remove_file(tmp.path("a.txt")).unwrap();
        symlink("/", tmp.path("a.txt")).unwrap();
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Any),
                &[tmp.path("a.txt")],
            ))
            .await;
        assert!(indexed(&state).await.is_empty());
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("a.txt"), ChangeType::Delete)]
        );
    }

    /// Set `path`'s modification time to `secs` seconds after the epoch.
    fn set_mtime(path: &Path, secs: u64) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    /// Report `path` as modified, flush everything pending, and return the
    /// `filer_change` params broadcast.
    async fn modified(state: &mut FilerState, path: &Path) -> Vec<Value> {
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Any),
                &[path.to_path_buf()],
            ))
            .await;
        flushed(state).await
    }

    /// Flush everything pending and return the `filer_change` params broadcast.
    async fn flushed(state: &mut FilerState) -> Vec<Value> {
        let frames = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&frames);
        let broadcast: FilerBroadcast = Arc::new(move |message: &str| {
            let mut message: Value = serde_json::from_str(message).unwrap();
            sink.lock().push(message["params"].take());
        });
        flush_ready(state, Instant::now() + DEBOUNCE_MAX_WAIT, &broadcast).await;
        assert!(state.pending.is_empty());
        std::mem::take(&mut *frames.lock())
    }

    #[tokio::test]
    async fn disknodes_carry_the_file_size_in_bytes() {
        let tmp = TempDir::new();
        // multi-byte UTF-8: the size counts bytes, not characters
        std::fs::write(tmp.path("text.txt"), "héllo").unwrap();
        // not UTF-8 — the index doesn't care
        std::fs::write(tmp.path("bytes.bin"), [0xff, 0xfe, 0x00]).unwrap();
        let mut state = state_for(&tmp).await;

        // the walk's nodes, as `session_load` and `project_open` send them:
        // the size, and no contents
        {
            let index = state.files.read().await;
            let text = serde_json::to_value(&index[&tmp.key("text.txt")]).unwrap();
            assert_eq!(text["size"], 6);
            assert!(
                !text.as_object().unwrap().contains_key("contents"),
                "{text}"
            );
            let bytes = serde_json::to_value(&index[&tmp.key("bytes.bin")]).unwrap();
            assert_eq!(bytes["size"], 3);
            assert!(
                !bytes.as_object().unwrap().contains_key("contents"),
                "{bytes}"
            );
        }

        // a change's node carries the new size
        std::fs::write(tmp.path("text.txt"), "héllo, world").unwrap();
        let frames = modified(&mut state, &tmp.path("text.txt")).await;
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(frames[0]["disknode"]["size"], 13);
        std::fs::write(tmp.path("bytes.bin"), [0xff; 5]).unwrap();
        let frames = modified(&mut state, &tmp.path("bytes.bin")).await;
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(frames[0]["disknode"]["size"], 5);
    }

    #[tokio::test]
    async fn every_move_of_a_file_broadcasts_a_change_with_its_metadata() {
        let tmp = TempDir::new();
        let path = tmp.path("f.txt");
        let key = tmp.key("f.txt");
        std::fs::write(&path, "one").unwrap();
        set_mtime(&path, 1000);
        let mut state = state_for(&tmp).await;
        // the metadata a frame's node carries — and no contents key
        let metadata = |frame: &Value| {
            let disknode = frame["disknode"].as_object().unwrap();
            assert!(!disknode.contains_key("contents"), "{disknode:?}");
            (disknode["size"].clone(), disknode["mtime"].clone())
        };

        // touched: a change with the new timestamps
        set_mtime(&path, 2000);
        let frames = modified(&mut state, &path).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0]["change"],
            serde_json::json!({ "type": "change", "path": key })
        );
        assert_eq!(metadata(&frames[0]), (3.into(), 2_000_000.into()));
        assert_eq!(state.files.read().await[&key].mtime, Some(2_000_000));

        // rewritten with the same bytes: also a change
        std::fs::write(&path, "one").unwrap();
        set_mtime(&path, 3000);
        let frames = modified(&mut state, &path).await;
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(metadata(&frames[0]), (3.into(), 3_000_000.into()));

        // changed: the same shape
        std::fs::write(&path, "three").unwrap();
        set_mtime(&path, 4000);
        let frames = modified(&mut state, &path).await;
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(metadata(&frames[0]), (5.into(), 4_000_000.into()));

        // nothing moved, and the stamp is trusted: no broadcast
        assert!(modified(&mut state, &path).await.is_empty());

        // first sighting: an add, metadata only
        let new_path = tmp.path("new.txt");
        std::fs::write(&new_path, "new").unwrap();
        set_mtime(&new_path, 1000);
        let frames = modified(&mut state, &new_path).await;
        assert_eq!(frames[0]["change"]["type"], "add");
        assert_eq!(metadata(&frames[0]), (3.into(), 1_000_000.into()));
    }

    #[tokio::test]
    async fn changes_inside_one_window_broadcast_once_with_the_latest_metadata() {
        let tmp = TempDir::new();
        let path = tmp.path("f.txt");
        std::fs::write(&path, "one").unwrap();
        set_mtime(&path, 1000);
        let mut state = state_for(&tmp).await;
        let modify = |path: &Path| event(EventKind::Modify(ModifyKind::Any), &[path.to_path_buf()]);

        // changed, then touched, inside one debounce window: one change, with
        // the touch's timestamp
        std::fs::write(&path, "two!").unwrap();
        set_mtime(&path, 2000);
        state.handle_event(modify(&path)).await;
        set_mtime(&path, 3000);
        state.handle_event(modify(&path)).await;
        let frames = flushed(&mut state).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(frames[0]["disknode"]["size"], 4);
        assert_eq!(frames[0]["disknode"]["mtime"], 3_000_000);

        // touched twice: one change, with the latest timestamp
        set_mtime(&path, 4000);
        state.handle_event(modify(&path)).await;
        set_mtime(&path, 5000);
        state.handle_event(modify(&path)).await;
        let frames = flushed(&mut state).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(frames[0]["disknode"]["mtime"], 5_000_000);

        // a file added and touched before its add went out is still an add
        let new_path = tmp.path("new.txt");
        std::fs::write(&new_path, "new").unwrap();
        set_mtime(&new_path, 1000);
        state.handle_event(modify(&new_path)).await;
        set_mtime(&new_path, 2000);
        state.handle_event(modify(&new_path)).await;
        let frames = flushed(&mut state).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["change"]["type"], "add");
        assert_eq!(frames[0]["disknode"]["mtime"], 2_000_000);
    }

    #[tokio::test]
    async fn staged_write_temp_files_are_ignored() {
        let tmp = TempDir::new();
        let temp_name = format!("{}abc", crate::scoped_fs::TEMP_FILE_PREFIX);
        std::fs::write(tmp.path(&temp_name), "staged").unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        let mut state = state_for(&tmp).await;
        assert_eq!(indexed(&state).await, vec![tmp.key("a.txt")]);

        assert!(is_ignored(
            &tmp.path(&temp_name),
            &tmp.0,
            &[],
            &IgnoreRule::FixedNames
        ));
        state
            .handle_event(event(
                EventKind::Create(CreateKind::File),
                &[tmp.path(&temp_name)],
            ))
            .await;
        assert!(state.pending.is_empty());

        // the publishing rename reports the target, which is indexed
        std::fs::rename(tmp.path(&temp_name), tmp.path("a.txt")).unwrap();
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                &[tmp.path("a.txt")],
            ))
            .await;
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("a.txt"), ChangeType::Change)]
        );
    }

    #[tokio::test]
    async fn rename_emits_delete_and_add_without_ghosts() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("old.txt"), "x").unwrap();
        let mut state = state_for(&tmp).await;

        std::fs::rename(tmp.path("old.txt"), tmp.path("new.txt")).unwrap();
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &[tmp.path("old.txt"), tmp.path("new.txt")],
            ))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("new.txt")]);
        assert_eq!(
            pending_of(&state),
            vec![
                (tmp.key("new.txt"), ChangeType::Add),
                (tmp.key("old.txt"), ChangeType::Delete),
            ]
        );
    }

    #[tokio::test]
    async fn split_rename_events_resolve_by_side() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("old.txt"), "x").unwrap();
        let mut state = state_for(&tmp).await;

        std::fs::rename(tmp.path("old.txt"), tmp.path("new.txt")).unwrap();
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                &[tmp.path("old.txt")],
            ))
            .await;
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                &[tmp.path("new.txt")],
            ))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("new.txt")]);
        assert_eq!(
            pending_of(&state),
            vec![
                (tmp.key("new.txt"), ChangeType::Add),
                (tmp.key("old.txt"), ChangeType::Delete),
            ]
        );
    }

    #[tokio::test]
    async fn short_lived_file_broadcasts_only_a_delete() {
        let tmp = TempDir::new();
        let mut state = state_for(&tmp).await;

        // create observed while the file still exists
        std::fs::write(tmp.path("4913"), "").unwrap();
        state
            .handle_event(event(
                EventKind::Create(CreateKind::File),
                &[tmp.path("4913")],
            ))
            .await;
        assert_eq!(pending_of(&state), vec![(tmp.key("4913"), ChangeType::Add)]);
        std::fs::remove_file(tmp.path("4913")).unwrap();
        state
            .handle_event(event(
                EventKind::Remove(RemoveKind::File),
                &[tmp.path("4913")],
            ))
            .await;
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("4913"), ChangeType::Delete)]
        );
        assert!(indexed(&state).await.is_empty());
        state.pending.clear();

        // create observed only after the file is already gone
        state
            .handle_event(event(
                EventKind::Create(CreateKind::File),
                &[tmp.path("gone")],
            ))
            .await;
        state
            .handle_event(event(
                EventKind::Remove(RemoveKind::File),
                &[tmp.path("gone")],
            ))
            .await;
        assert!(state.pending.is_empty());
        assert!(indexed(&state).await.is_empty());
    }

    #[tokio::test]
    async fn replace_in_place_is_a_change() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "one").unwrap();
        let mut state = state_for(&tmp).await;

        // atomic save: remove, then recreate with new contents
        std::fs::remove_file(tmp.path("f.txt")).unwrap();
        state
            .handle_event(event(
                EventKind::Remove(RemoveKind::File),
                &[tmp.path("f.txt")],
            ))
            .await;
        std::fs::write(tmp.path("f.txt"), "two").unwrap();
        state
            .handle_event(event(
                EventKind::Create(CreateKind::File),
                &[tmp.path("f.txt")],
            ))
            .await;
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("f.txt"), ChangeType::Change)]
        );
    }

    #[tokio::test]
    async fn modify_whose_stat_fails_is_a_delete() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "one").unwrap();
        let mut state = state_for(&tmp).await;

        std::fs::remove_file(tmp.path("f.txt")).unwrap();
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Data(DataChange::Any)),
                &[tmp.path("f.txt")],
            ))
            .await;
        assert!(indexed(&state).await.is_empty());
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("f.txt"), ChangeType::Delete)]
        );
    }

    #[tokio::test]
    async fn a_modify_with_a_trusted_unmoved_stamp_is_not_broadcast() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "one").unwrap();
        // settled: the stamp the scan took is trusted
        let mut state = state_for(&tmp).await;

        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Any),
                &[tmp.path("f.txt")],
            ))
            .await;
        assert!(state.pending.is_empty());
    }

    #[tokio::test]
    async fn directory_moves_carry_their_files() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("d/nested")).unwrap();
        std::fs::write(tmp.path("d/a.txt"), "a").unwrap();
        std::fs::write(tmp.path("d/nested/b.txt"), "b").unwrap();
        std::fs::write(tmp.path("d_sibling.txt"), "s").unwrap();
        let mut state = state_for(&tmp).await;

        // moved out of the watched tree — only the dir itself reports
        let outside = TempDir::new();
        std::fs::rename(tmp.path("d"), outside.path("d")).unwrap();
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                &[tmp.path("d")],
            ))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("d_sibling.txt")]);
        assert_eq!(
            pending_of(&state),
            vec![
                (tmp.key("d/a.txt"), ChangeType::Delete),
                (tmp.key("d/nested/b.txt"), ChangeType::Delete),
            ]
        );
        state.pending.clear();

        // moved back in — the subtree is walked
        std::fs::rename(outside.path("d"), tmp.path("e")).unwrap();
        state
            .handle_event(event(
                EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                &[tmp.path("e")],
            ))
            .await;
        assert_eq!(
            pending_of(&state),
            vec![
                (tmp.key("e/a.txt"), ChangeType::Add),
                (tmp.key("e/nested/b.txt"), ChangeType::Add),
            ]
        );
    }

    #[tokio::test]
    async fn ignored_paths_are_skipped() {
        let tmp = TempDir::new();
        let mut state = state_for(&tmp).await;
        std::fs::create_dir_all(tmp.path("target")).unwrap();
        std::fs::write(tmp.path("target/out"), "o").unwrap();
        state
            .handle_event(event(
                EventKind::Create(CreateKind::File),
                &[tmp.path("target/out")],
            ))
            .await;
        assert!(state.pending.is_empty());
        assert!(is_ignored(
            &tmp.path("node_modules/x/y.js"),
            &tmp.0,
            &[],
            &IgnoreRule::FixedNames
        ));
    }

    #[tokio::test]
    async fn rescan_reconciles_dropped_events() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("kept.txt"), "k").unwrap();
        std::fs::write(tmp.path("edited.txt"), "old").unwrap();
        std::fs::write(tmp.path("deleted.txt"), "d").unwrap();
        let mut state = state_for(&tmp).await;

        // changes whose events were all dropped
        std::fs::write(tmp.path("edited.txt"), "new contents").unwrap();
        std::fs::remove_file(tmp.path("deleted.txt")).unwrap();
        std::fs::write(tmp.path("added.txt"), "a").unwrap();

        state.rescan(false).await;
        assert_eq!(
            pending_of(&state),
            vec![
                (tmp.key("added.txt"), ChangeType::Add),
                (tmp.key("deleted.txt"), ChangeType::Delete),
                (tmp.key("edited.txt"), ChangeType::Change),
            ]
        );
        assert_eq!(
            indexed(&state).await,
            vec![
                tmp.key("added.txt"),
                tmp.key("edited.txt"),
                tmp.key("kept.txt")
            ]
        );
        // a second rescan finds nothing new
        state.pending.clear();
        state.rescan(false).await;
        assert!(state.pending.is_empty());
    }

    #[tokio::test]
    async fn take_ready_respects_deadlines() {
        let tmp = TempDir::new();
        let mut state = state_for(&tmp).await;
        state.queue(tmp.key("x"), ChangeType::Add, node(&tmp.key("x"), 1, 1));
        assert!(state.take_ready(Instant::now()).is_empty());
        let ready = state.take_ready(Instant::now() + DEBOUNCE_DURATION);
        assert_eq!(ready.len(), 1);
        assert!(state.pending.is_empty());
        assert!(state.next_deadline().is_none());
    }

    /// A registry holding one connection whose outbound queue has a budget
    /// of `outbound_queue_bytes`, with a filer broadcast sink into it.
    fn one_connection(
        outbound_queue_bytes: usize,
    ) -> (
        Arc<fuz_realtime::ConnectionRegistry>,
        fuz_realtime::Connection,
        fuz_realtime::ConnectionReceiver,
        FilerBroadcast,
    ) {
        let registry = Arc::new(fuz_realtime::ConnectionRegistry::new());
        let (sender, receiver) = fuz_realtime::connection_channel(outbound_queue_bytes);
        let connection = registry.add_connection(
            sender,
            fuz_realtime::ConnectionIdentity::default(),
            tokio_util::sync::CancellationToken::new(),
        );
        let sink = Arc::clone(&registry);
        let broadcast: FilerBroadcast = Arc::new(move |message: &str| {
            let _ = sink.broadcast(message);
        });
        (registry, connection, receiver, broadcast)
    }

    #[tokio::test]
    async fn flush_yields_so_a_read_connection_outlasts_its_budget() {
        const CHANGES: usize = 32;
        const NAME_BYTES: usize = 1024;
        // room for a few frames (each carries its path twice), a fraction of
        // the batch
        const BUDGET: usize = 8 * NAME_BYTES;

        let tmp = TempDir::new();
        let mut state = state_for(&tmp).await;
        let now = Instant::now();
        // long names make the frames big enough for the budget to matter
        let name = "x".repeat(NAME_BYTES - 16);
        for i in 0..CHANGES {
            let key = format!("{}{i}/{name}", tmp.root());
            state.queue_at(now, key.clone(), ChangeType::Add, node(&key, 1, 1));
        }
        let (registry, connection, mut rx, broadcast) = one_connection(BUDGET);
        // the connection's writer — takes a frame whenever it gets a turn,
        // and stops early if the registry closes the connection
        let writer = tokio::spawn(async move {
            let mut frames = 0;
            while frames < CHANGES && rx.recv().await.is_some() {
                frames += 1;
            }
            frames
        });

        flush_ready(&mut state, now + DEBOUNCE_DURATION, &broadcast).await;

        assert!(state.pending.is_empty());
        assert_eq!(connection.close_reason.get(), None);
        assert!(registry.is_registered(connection.id));
        let frames = tokio::time::timeout(Duration::from_secs(5), writer)
            .await
            .expect("the writer must finish")
            .unwrap();
        assert_eq!(frames, CHANGES);
    }

    #[tokio::test]
    async fn a_change_frame_is_small_whatever_the_file_holds() {
        let tmp = TempDir::new();
        let mut state = state_for(&tmp).await;
        let now = Instant::now();
        // a file far over what a frame could carry, and a tiny one
        for (rel, size) in [("big.bin", u64::MAX / 2), ("small.txt", 1)] {
            let key = tmp.key(rel);
            state.queue_at(now, key.clone(), ChangeType::Change, node(&key, size, 1));
        }
        // nothing takes a frame during the flush, as when the writer is busy
        // with an earlier one
        let (registry, connection, mut rx, broadcast) =
            one_connection(crate::WS_OPTIONS.outbound_queue_bytes);

        flush_ready(&mut state, now + DEBOUNCE_DURATION, &broadcast).await;

        assert_eq!(connection.close_reason.get(), None);
        assert!(registry.is_registered(connection.id));
        for _ in 0..2 {
            let frame = rx.try_recv().unwrap();
            // the envelope, the paths, and the metadata
            assert!(
                frame.as_str().len() < 512 + 2 * tmp.root().len(),
                "{}",
                frame.as_str()
            );
            let message: Value = serde_json::from_str(frame.as_str()).unwrap();
            assert!(
                !message["params"]["disknode"]
                    .as_object()
                    .unwrap()
                    .contains_key("contents")
            );
        }
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn debounce_is_capped_for_continuously_changing_paths() {
        let tmp = TempDir::new();
        let mut state = state_for(&tmp).await;
        let key = tmp.key("hot.log");
        let t0 = Instant::now();
        // written every 50ms — never quiet for a full debounce window
        let mut t = t0;
        while t < t0 + DEBOUNCE_MAX_WAIT {
            state.queue_at(t, key.clone(), ChangeType::Change, node(&key, 1, 1));
            assert!(state.take_ready(t).is_empty(), "not ready at {:?}", t - t0);
            t += Duration::from_millis(50);
        }
        let ready = state.take_ready(t0 + DEBOUNCE_MAX_WAIT);
        assert_eq!(ready.len(), 1, "flushed by the max wait");
        // the next run starts fresh
        let t1 = t0 + DEBOUNCE_MAX_WAIT;
        state.queue_at(t1, key.clone(), ChangeType::Change, node(&key, 1, 2));
        assert_eq!(state.next_deadline(), Some(t1 + DEBOUNCE_DURATION));
        assert_eq!(
            debounce_deadline(t0 + Duration::from_millis(10), t0),
            t0 + Duration::from_millis(10) + DEBOUNCE_DURATION
        );
        assert_eq!(
            debounce_deadline(t0 + DEBOUNCE_MAX_WAIT, t0),
            t0 + DEBOUNCE_MAX_WAIT
        );
    }

    #[tokio::test]
    async fn late_remove_of_a_recreated_file_keeps_it() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "one").unwrap();
        let mut state = state_for(&tmp).await;

        // `rm f.txt && git checkout f.txt`, events processed after both, or
        // FSEvents reporting the create before the remove. A different
        // length, so the settled clock can't hide the rewrite: within one
        // timestamp tick, a filesystem that hands the freed inode straight
        // back (ext4) gives a same-length file the stamp it had
        std::fs::remove_file(tmp.path("f.txt")).unwrap();
        std::fs::write(tmp.path("f.txt"), "three").unwrap();
        state
            .handle_event(event(
                EventKind::Create(CreateKind::File),
                &[tmp.path("f.txt")],
            ))
            .await;
        state
            .handle_event(event(
                EventKind::Remove(RemoveKind::File),
                &[tmp.path("f.txt")],
            ))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("f.txt")]);
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("f.txt"), ChangeType::Change)]
        );
    }

    #[tokio::test]
    async fn late_remove_of_a_recreated_directory_resyncs_it() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("src")).unwrap();
        std::fs::write(tmp.path("src/a.txt"), "a").unwrap();
        std::fs::write(tmp.path("src/b.txt"), "b").unwrap();
        let mut state = state_for(&tmp).await;

        // `rm -rf src && git checkout src` (b.txt not restored), with only
        // the directory's remove event processed
        std::fs::remove_dir_all(tmp.path("src")).unwrap();
        std::fs::create_dir_all(tmp.path("src")).unwrap();
        std::fs::write(tmp.path("src/a.txt"), "a").unwrap();
        state
            .handle_event(event(
                EventKind::Remove(RemoveKind::Folder),
                &[tmp.path("src")],
            ))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("src/a.txt")]);
        // a.txt's timestamps may or may not differ; b.txt is certainly gone
        assert!(
            pending_of(&state).contains(&(tmp.key("src/b.txt"), ChangeType::Delete)),
            "{:?}",
            pending_of(&state)
        );
        assert!(
            !pending_of(&state)
                .iter()
                .any(|(k, c)| k == &tmp.key("src/a.txt") && *c == ChangeType::Delete)
        );
    }

    #[tokio::test]
    async fn directory_replaced_by_file_drops_its_children() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("x")).unwrap();
        std::fs::write(tmp.path("x/child.txt"), "c").unwrap();
        let mut state = state_for(&tmp).await;

        // `mv x away; echo > x`, with only the create of `x` processed
        let outside = TempDir::new();
        std::fs::rename(tmp.path("x"), outside.path("x")).unwrap();
        std::fs::write(tmp.path("x"), "now a file").unwrap();
        state
            .handle_event(event(EventKind::Create(CreateKind::File), &[tmp.path("x")]))
            .await;

        assert_eq!(indexed(&state).await, vec![tmp.key("x")]);
        assert_eq!(
            pending_of(&state),
            vec![
                (tmp.key("x"), ChangeType::Add),
                (tmp.key("x/child.txt"), ChangeType::Delete),
            ]
        );
    }

    #[tokio::test]
    async fn file_replaced_by_directory_drops_the_file() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("x"), "a file").unwrap();
        let mut state = state_for(&tmp).await;

        // `rm x; mkdir x; touch x/child.txt`, with only the create of `x` processed
        std::fs::remove_file(tmp.path("x")).unwrap();
        std::fs::create_dir_all(tmp.path("x")).unwrap();
        std::fs::write(tmp.path("x/child.txt"), "c").unwrap();
        state
            .handle_event(event(
                EventKind::Create(CreateKind::Folder),
                &[tmp.path("x")],
            ))
            .await;

        assert_eq!(indexed(&state).await, vec![tmp.key("x/child.txt")]);
        assert_eq!(
            pending_of(&state),
            vec![
                (tmp.key("x"), ChangeType::Delete),
                (tmp.key("x/child.txt"), ChangeType::Add),
            ]
        );

        // an in-place change event on the directory also drops a stale entry
        state
            .files
            .write()
            .await
            .insert(tmp.key("x"), node(&tmp.key("x"), 5, 1));
        state.pending.clear();
        state
            .handle_event(event(EventKind::Modify(ModifyKind::Any), &[tmp.path("x")]))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("x/child.txt")]);
        assert_eq!(pending_of(&state), vec![(tmp.key("x"), ChangeType::Delete)]);
    }

    #[tokio::test]
    async fn rescans_skip_unchanged_files_and_report_moved_stamps() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "one").unwrap();
        let mut state = state_for(&tmp).await;
        let key = tmp.key("f.txt");
        assert!(state.files.read().await[&key].stat.is_some());

        // a trusted, unmoved stamp keeps the indexed node as it is
        state.files.write().await.get_mut(&key).unwrap().mtime = Some(1);
        state.rescan(false).await;
        assert!(state.pending.is_empty());
        assert_eq!(state.files.read().await[&key].mtime, Some(1));

        // a same-size rewrite that restores the mtime still moves the ctime
        // (past the timestamp tick, so the settled clock can't hide it)
        let mtime = std::fs::metadata(tmp.path("f.txt"))
            .unwrap()
            .modified()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(tmp.path("f.txt"), "two").unwrap();
        std::fs::File::options()
            .write(true)
            .open(tmp.path("f.txt"))
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        state.rescan(false).await;
        assert_eq!(pending_of(&state), vec![(key.clone(), ChangeType::Change)]);
        assert_eq!(
            state.files.read().await[&key].mtime,
            system_time_to_ms(mtime),
            "the index took the new node"
        );
    }

    #[tokio::test]
    async fn same_tick_rewrites_are_never_missed() {
        use std::io::{Seek, SeekFrom, Write};

        let tmp = TempDir::new();
        let path = tmp.path("f.txt");
        std::fs::write(&path, "AAAA").unwrap();
        // the real clock: every write here is too recent to trust its stamp
        let mut state = state_on(&tmp, vec![], SystemTime::now).await;
        let key = tmp.key("f.txt");
        for i in 0..50 {
            let (a, b) = (format!("{:04}", i * 2), format!("{:04}", i * 2 + 1));
            let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.write_all(a.as_bytes()).unwrap();
            state.rescan(false).await;
            state.pending.clear();
            // a second same-size write, likely inside the same timestamp
            // tick, so likely leaving the stamp as the rescan saw it
            file.seek(SeekFrom::Start(0)).unwrap();
            file.write_all(b.as_bytes()).unwrap();
            drop(file);
            state.rescan(false).await;
            assert_eq!(
                pending_of(&state),
                vec![(key.clone(), ChangeType::Change)],
                "iteration {i}"
            );
            state.pending.clear();
        }
    }

    #[tokio::test]
    async fn a_file_dated_in_the_future_is_not_a_change_on_every_look() {
        let tmp = TempDir::new();
        let path = tmp.path("f.txt");
        std::fs::write(&path, "one").unwrap();
        // `touch -d tomorrow`, an archive from a clock ahead: an mtime past
        // even the settled clock
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() + Duration::from_hours(24))
            .unwrap();
        let mut state = state_for(&tmp).await;
        assert!(state.files.read().await[&tmp.key("f.txt")].stat.is_some());
        state.rescan(false).await;
        assert!(state.pending.is_empty(), "{:?}", pending_of(&state));
        assert!(modified(&mut state, &path).await.is_empty());
    }

    #[tokio::test]
    async fn a_racy_stamp_is_a_change_until_it_settles() {
        let tmp = TempDir::new();
        let path = tmp.path("f.txt");
        let key = tmp.key("f.txt");
        std::fs::write(&path, "one").unwrap();
        // just written: the scan's stamp isn't trusted
        let mut state = state_on(&tmp, vec![], SystemTime::now).await;
        assert!(state.files.read().await[&key].stat.is_none());

        // nothing moved, but the stamp can't say so: an event is a change
        let frames = modified(&mut state, &path).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["change"]["type"], "change");
        // and so is a rescan
        state.rescan(false).await;
        assert_eq!(pending_of(&state), vec![(key.clone(), ChangeType::Change)]);
        flushed(&mut state).await;

        // once its change time is past the margin, the next look is a
        // change still (the indexed stamp is the untrusted one), and trusts
        // what it finds
        state.clock = settled;
        let frames = modified(&mut state, &path).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["change"]["type"], "change");
        assert!(state.files.read().await[&key].stat.is_some());

        // from then on an unmoved stamp is no change, by event or rescan
        assert!(modified(&mut state, &path).await.is_empty());
        state.rescan(false).await;
        assert!(state.pending.is_empty(), "{:?}", pending_of(&state));
    }

    /// a resynced re-prune drops the pending changes of its own
    /// paths only, and bumps the count; off the wire it queues them all.
    #[tokio::test]
    async fn a_resynced_re_prune_drops_only_its_paths_pending_changes() {
        let tmp = TempDir::new();
        let root = tmp.root();
        for on_wire in [true, false] {
            let mut state = state_for(&tmp).await;
            state.wire.on_wire.store(on_wire, Ordering::Release);
            let outside = format!("{root}outside.txt");
            let inside = format!("{root}big/0.js");
            state.queue(outside.clone(), ChangeType::Change, node(&outside, 1, 1));
            state.queue(inside.clone(), ChangeType::Add, node(&inside, 1, 1));
            let changes: Vec<Change> = (0..=REPRUNE_BROADCAST_MAX)
                .map(|i| {
                    let p = format!("{root}big/{i}.js");
                    (p.clone(), ChangeType::Delete, node(&p, 1, 1))
                })
                .collect();
            state.queue_or_resync(changes);
            let resyncs = state.wire.resyncs.load(Ordering::Acquire);
            if on_wire {
                assert_eq!(pending_of(&state), vec![(outside, ChangeType::Change)]);
                assert_eq!(resyncs, 1);
            } else {
                assert_eq!(pending_of(&state).len(), REPRUNE_BROADCAST_MAX + 2);
                assert_eq!(resyncs, 0);
            }
        }
    }
}
