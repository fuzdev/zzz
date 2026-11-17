//! A running filer: its configuration, the handle, and `start_filer`.

use super::event_loop::{
    FilerState, GitIgnore, PendingReprune, drop_newly_ignored, filer_event_loop,
};
use super::ignore::{GitRoot, IgnoreRule, SharedRule, is_ignored, rule_marker};
use super::index::{FileIndex, apply_subtree};
use super::walk::scan_directory;
use super::watches::{DirWatches, WatcherFactory, is_indexable_kind};
use super::{
    DEGRADED_RESCAN_INTERVAL, EVENT_CHANNEL_CAPACITY, IGNORED_REFRESH_INTERVAL, IgnoredPaths,
    IgnoredWire, WatchStatus,
};
use crate::scoped_fs::{ProtectedDir, protected_dir};
use notify::{RecommendedWatcher, Watcher};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};
use tokio::sync::{Notify, RwLock, mpsc, oneshot};

// -- Filer configuration ------------------------------------------------------

/// Per-filer configuration: which directories to ignore, and the watch
/// budget.
pub struct FilerConfig {
    /// Absolute directories to ignore beyond the default names. For a
    /// tree watcher whose root contains `zzz_dir`, this is `zzz_dir`
    /// (which has its own watcher); otherwise empty.
    pub ignored_dirs: Vec<PathBuf>,
    /// Most directory watches this filer adds. `None` leaves only the OS
    /// limit (inotify's `max_user_watches`, shared by every process of the
    /// user); reaching either puts the filer in degraded mode.
    pub watch_limit: Option<usize>,
    /// Shortest interval between degraded-mode rescans of the unwatched
    /// directories.
    pub degraded_rescan_interval: Duration,
    /// The protected directory the root is, or is inside ([`protected_dir`]:
    /// a credential directory, or a `.zzz` directory other than the app dir)
    /// — [`start_filer`] refuses it rather than index credentials or the
    /// daemon home's secrets.
    pub root_protected: Option<ProtectedDir>,
    /// How much of the root the filer indexes.
    pub depth: FilerDepth,
    /// The daemon's git, when it's usable — a root that is a checkout,
    /// indexed whole, takes git's ignore rule through it; `None` leaves every
    /// root on fixed names (see [`super::ignore`]).
    pub git: Option<Arc<fuz_git::Git>>,
    /// Called when the filer's ignored set (or its resync count) changed,
    /// at most once per [`IGNORED_REFRESH_INTERVAL`] — how the open
    /// projects learn to republish it. Only a filer on git's rule calls it.
    pub on_ignored_change: Option<FilerIgnoredChange>,
    /// Test seam: run as if no watcher could be created.
    #[cfg(test)]
    pub no_watcher: bool,
}

impl FilerConfig {
    /// Config for the `zzz_dir` watcher — no extra ignores, since it needs
    /// to see files inside the zzz directory. (Default names still apply
    /// below its root, so a `.zzz/` nested inside the app dir is skipped.)
    pub const fn zzz_dir() -> Self {
        Self {
            ignored_dirs: vec![],
            watch_limit: None,
            degraded_rescan_interval: DEGRADED_RESCAN_INTERVAL,
            root_protected: None,
            depth: FilerDepth::Tree,
            git: None,
            on_ignored_change: None,
            #[cfg(test)]
            no_watcher: false,
        }
    }

    /// Config for a watcher on the whole tree of `root` — a project's focused
    /// directory, or a `scoped_dir` — that ignores
    /// `zzz_dir` by its full path when it sits strictly inside `root`, so its
    /// files aren't indexed and broadcast twice. A custom-named app dir is
    /// matched by path, not name, so same-named directories elsewhere (an app
    /// dir named `data` vs a project's own `data/`) stay visible; `.zzz`
    /// directories are ignored everywhere by name, under every ignore rule
    /// (see [`super::ignore`]).
    ///
    /// A root in a protected directory is marked [`Self::root_protected`], so
    /// the filer refuses to start on it.
    ///
    /// Both paths are expected in their canonical form (as `resolve_dir` and
    /// `project_open` produce); a trailing `/` is ignored.
    pub fn tree(root: &str, zzz_dir: &str) -> Self {
        let root = Path::new(root);
        let zzz_dir = Path::new(zzz_dir);
        let nested = zzz_dir.starts_with(root) && zzz_dir != root;
        Self {
            ignored_dirs: if nested {
                vec![zzz_dir.to_path_buf()]
            } else {
                vec![]
            },
            root_protected: protected_dir(root, zzz_dir),
            ..Self::zzz_dir()
        }
    }

    /// Config for a watcher on the files directly in `root` alone
    /// ([`FilerDepth::TopLevel`]) — a registry root's loose files, whose
    /// subdirectories are its repos, indexed by filers of their own when
    /// focused. Otherwise as [`Self::tree`].
    pub fn top_level(root: &str, zzz_dir: &str) -> Self {
        Self {
            depth: FilerDepth::TopLevel,
            ..Self::tree(root, zzz_dir)
        }
    }
}

impl std::fmt::Debug for FilerConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilerConfig")
            .field("ignored_dirs", &self.ignored_dirs)
            .field("watch_limit", &self.watch_limit)
            .field("depth", &self.depth)
            .field("git", &self.git.is_some())
            .field("on_ignored_change", &self.on_ignored_change.is_some())
            .finish_non_exhaustive()
    }
}

/// How much of its root a filer indexes ([`FilerConfig::depth`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilerDepth {
    /// Every file under the root, at any depth — ignored directories aside.
    Tree,
    /// Only the files directly in the root: its subdirectories are never
    /// listed or watched, and one appearing is not indexed.
    TopLevel,
}

// -- Filer --------------------------------------------------------------------

/// Where a filer sends its `filer_change` notifications (serialized
/// JSON-RPC messages).
pub type FilerBroadcast = Arc<dyn Fn(&str) + Send + Sync>;

/// Told that a filer's ignored set changed ([`FilerConfig::on_ignored_change`]).
///
/// It runs on the filer's publisher task, which a stopped filer aborts, so
/// anything that may stop filers (a `ProjectManager` commit) it spawns
/// rather than awaits — and the filer never waits on it, nor on the lock
/// that work takes.
pub type FilerIgnoredChange = Arc<dyn Fn() + Send + Sync>;

/// A coalesced request: "rescan the root", raised from the notify callback
/// (sync context) when events were dropped or notify asks for a rescan, and
/// "the ignored set changed", raised by the event loop for the publisher
/// ([`publish_ignored_changes`]).
#[derive(Default)]
pub(super) struct RescanSignal {
    needed: AtomicBool,
    pub(super) notify: Notify,
}

impl RescanSignal {
    /// Mark a rescan as needed; wakes the event loop only on the
    /// not-needed → needed transition, so a burst of drops is one rescan.
    pub(super) fn request(&self) {
        if !self.needed.swap(true, Ordering::AcqRel) {
            self.notify.notify_one();
        }
    }

    /// Clear the request, returning whether one was pending.
    pub(super) fn take(&self) -> bool {
        self.needed.swap(false, Ordering::AcqRel)
    }
}

/// Watches a directory for file changes, maintains an in-memory file index,
/// and broadcasts `filer_change` notifications to WebSocket clients.
///
/// Dropped when the filer is stopped: the event-loop task is aborted, which
/// drops its watches (notify cleans up on Drop).
pub struct Filer {
    /// Background task processing watcher events.
    pub(super) task: tokio::task::JoinHandle<()>,
    /// In-memory file index. Written only by the event-loop task (initial
    /// scan aside); read by `session_load` / `project_open`.
    pub(super) files: Arc<RwLock<FileIndex>>,
    /// Requests a full rescan on the event loop; the reply fires once the
    /// index matches the disk.
    pub(super) rescan_tx: mpsc::Sender<oneshot::Sender<()>>,
    /// How many listed directories have no watch.
    unwatched_count: Arc<AtomicUsize>,
    /// What the filer ignores, as its event loop keeps it.
    rule: SharedRule,
    /// Whether its set is on the wire, and its resync count.
    wire: Arc<IgnoredWire>,
    /// The wire form of the set at a rule version, so a commit that finds
    /// the rule unchanged sorts nothing.
    wire_cache: Mutex<Option<WireCache>>,
    /// The task that calls [`FilerConfig::on_ignored_change`], if any.
    publisher: Option<tokio::task::JoinHandle<()>>,
    #[cfg(test)]
    pub(super) watches: Arc<Mutex<DirWatches>>,
    /// Test seam: the overflow signal its watcher raises.
    #[cfg(test)]
    pub(super) signal: Arc<RescanSignal>,
}

/// [`Filer::ignored_on_wire`]'s lists at one [`SharedRule`] version.
struct WireCache {
    version: u64,
    paths: Arc<Vec<String>>,
    nested: Arc<Vec<String>>,
}

impl std::fmt::Debug for Filer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Filer")
            .field("unwatched_count", &self.unwatched_count)
            .finish_non_exhaustive()
    }
}

impl Drop for Filer {
    fn drop(&mut self) {
        self.task.abort();
        if let Some(publisher) = &self.publisher {
            publisher.abort();
        }
    }
}

impl Filer {
    /// Whether every directory this filer indexes has a watch.
    pub fn watch_status(&self) -> WatchStatus {
        if self.unwatched_count.load(Ordering::Relaxed) == 0 {
            WatchStatus::Full
        } else {
            WatchStatus::Degraded
        }
    }

    /// How many times what this filer ignores has changed — for tests; the
    /// event loop signals its publisher on the same count.
    #[cfg(test)]
    pub(crate) fn ignored_version(&self) -> u64 {
        self.rule.version()
    }

    /// The absolute paths git ignores under this filer's root, sorted: the
    /// dirs it prunes whole and the files it skips one by one, without a
    /// trailing `/`. `None` for a filer on fixed names. For tests; the wire
    /// form is [`Self::ignored_on_wire`].
    #[cfg(test)]
    pub(crate) fn ignored_paths(&self) -> Option<Vec<String>> {
        match &*self.rule.get() {
            IgnoreRule::FixedNames => None,
            IgnoreRule::Git(set) => Some(set.sorted()),
        }
    }

    /// What an open project carries for this filer's root: git's ignored
    /// paths and the nested repos it leaves unindexed, relative, and the
    /// resync count. `None` for a filer on fixed names, which leaves the
    /// client's own rule in force.
    pub fn ignored_on_wire(&self, source_dir: &str) -> Option<IgnoredPaths> {
        let (rule, nested, version) = self.rule.get_versioned();
        let IgnoreRule::Git(set) = &*rule else {
            return None;
        };
        // read after the rule: a resync bumped meanwhile is a newer one,
        // whose refresh follows
        let resyncs = self.wire.resyncs.load(Ordering::Acquire);
        let mut cache = self.wire_cache.lock();
        let (paths, nested) = match &*cache {
            Some(cached) if cached.version == version => {
                (Arc::clone(&cached.paths), Arc::clone(&cached.nested))
            }
            _ => {
                let paths = Arc::new(set.relative_sorted(source_dir));
                let nested = Arc::new(set.nested_on_wire(&nested, source_dir));
                *cache = Some(WireCache {
                    version,
                    paths: Arc::clone(&paths),
                    nested: Arc::clone(&nested),
                });
                (paths, nested)
            }
        };
        drop(cache);
        Some(IgnoredPaths {
            paths,
            nested,
            resyncs,
        })
    }

    /// Whether the filer is marked on the wire — for tests.
    #[cfg(test)]
    pub(crate) fn is_on_wire(&self) -> bool {
        self.wire.on_wire.load(Ordering::Acquire)
    }

    /// Mark whether an open project carries this filer's set — see
    /// [`IgnoredWire::on_wire`].
    pub fn set_on_wire(&self, on_wire: bool) {
        self.wire.on_wire.store(on_wire, Ordering::Release);
    }
}

/// The publisher of a filer's ignored set: each time the event loop raises
/// `signal`, call `on_change`, then wait out [`IGNORED_REFRESH_INTERVAL`] —
/// a signal raised meanwhile is kept (the flag stays set, and `Notify`
/// stores the wakeup) and answered once it's over, so a burst of changes
/// costs one call now and one after the interval.
pub(super) async fn publish_ignored_changes(
    signal: Arc<RescanSignal>,
    on_change: FilerIgnoredChange,
    interval: Duration,
) {
    loop {
        signal.notify.notified().await;
        if signal.take() {
            on_change();
            tokio::time::sleep(interval).await;
        }
    }
}

/// The [`WatcherFactory`] of a filer on `path`: each watcher it creates
/// filters its events (ignored paths, access events) and sends them to `tx`,
/// requesting a rescan on `signal` when events are lost. It holds `tx`, so the
/// event channel stays open even while there's no watcher. `exclude` is a git
/// root's `.git/info/exclude`, passed through though `.git` is ignored.
fn watcher_factory(
    path: &str,
    config: &FilerConfig,
    rule: &SharedRule,
    exclude: Option<PathBuf>,
    tx: mpsc::Sender<notify::Event>,
    signal: Arc<RescanSignal>,
) -> WatcherFactory {
    let root = PathBuf::from(path);
    let ignored_dirs = config.ignored_dirs.clone();
    let rule = rule.clone();
    #[cfg(test)]
    let no_watcher = config.no_watcher;
    Box::new(move || {
        #[cfg(test)]
        if no_watcher {
            return None;
        }
        let (root, ignored_dirs, rule, exclude, tx, signal) = (
            root.clone(),
            ignored_dirs.clone(),
            rule.clone(),
            exclude.clone(),
            tx.clone(),
            Arc::clone(&signal),
        );
        let path = root.display().to_string();
        RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                let mut event = match res {
                    Ok(event) => event,
                    Err(e) => {
                        tracing::warn!(
                            error = %fuz_sys::cli::format_error_chain(&e),
                            "file watcher error"
                        );
                        return;
                    }
                };
                if event.need_rescan() {
                    signal.request();
                    return;
                }
                if !is_indexable_kind(event.kind) {
                    return;
                }
                // Filter before the bounded channel. Ignored directories have
                // no watches, but their own entries are reported by their
                // parent's. What a git root's rule hangs on (a `.gitignore`,
                // a nested `.git`, `info/exclude`) passes even when ignored
                // itself, and so does a dir git's rule prunes, which may be a
                // file now.
                let rule = rule.get();
                event.paths.retain(|p| {
                    exclude.as_deref() == Some(p.as_path())
                        || !is_ignored(p, &root, &ignored_dirs, &rule)
                        || rule.prunes_dir(p)
                        || rule_marker(p, &root, &ignored_dirs, &rule).is_some()
                });
                if event.paths.is_empty() {
                    return;
                }
                if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(event) {
                    signal.request();
                }
            },
            // Watches are only added on real directories from the walk, but
            // never follow a link regardless (see module docs).
            notify::Config::default().with_follow_symlinks(false),
        )
        .inspect_err(|e| {
            tracing::warn!(
                path,
                error = %fuz_sys::cli::format_error_chain(e),
                "failed to create a file watcher; rescanning periodically instead"
            );
        })
        .ok()
    })
}

/// Start watching a directory, perform an initial file scan, and return a `Filer`.
///
/// `path` is the root in [`dir_prefix`](super::dir_prefix) form. The initial scan (walk,
/// watches, `lstat`s) populates the file index before returning, so callers
/// can immediately read it; it runs on blocking threads. The background task
/// then keeps the index updated and broadcasts changes.
///
/// # Errors
///
/// Fails only when the root itself can't be listed — unreadable
/// (`PermissionDenied`), missing (`NotFound`), or not a directory — or is
/// refused: a root in a protected directory
/// ([`FilerConfig::root_protected`], `PermissionDenied`). Every other
/// failure is per directory (skipped, or left unwatched in degraded mode),
/// including failing to create the watcher at all.
pub async fn start_filer(
    path: &str,
    broadcast: FilerBroadcast,
    config: FilerConfig,
) -> io::Result<Filer> {
    if let Some(dir) = config.root_protected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("refusing to index {dir}: {path}"),
        ));
    }
    let (git_root, rule) = initial_rule(path, &config).await;
    let rule = SharedRule::new(rule);
    let wire = Arc::new(IgnoredWire::default());
    let ignored_signal = Arc::new(RescanSignal::default());
    // fixed names never change, so only a git root has anything to publish
    let on_ignored_change = config
        .on_ignored_change
        .clone()
        .filter(|_| git_root.is_some());
    let (tx, rx) = mpsc::channel::<notify::Event>(EVENT_CHANNEL_CAPACITY);
    let signal = Arc::new(RescanSignal::default());
    let exclude = git_root.as_ref().map(GitRoot::info_exclude);
    let make_watcher = watcher_factory(path, &config, &rule, exclude, tx, Arc::clone(&signal));

    let source_dir = path.to_owned();
    let watches = Arc::new(Mutex::new(DirWatches::new(
        make_watcher,
        &source_dir,
        config.watch_limit,
    )));
    if let Some(root) = &git_root {
        watches.lock().watch_git_info(root.dir());
    }
    let unwatched_count = Arc::clone(&watches.lock().unwatched_count);

    // Initial scan — populate the file index (no broadcast; callers read it).
    // A directory whose listing failed transiently has nothing indexed to
    // keep yet; it's polled until it lists.
    let scan = scan_directory(
        &source_dir,
        &source_dir,
        &config.ignored_dirs,
        rule.get(),
        config.depth,
        &watches,
        false,
        SystemTime::now,
        None,
    )
    .await?;
    rule.set_nested_under(&source_dir, &scan.nested, &scan.kept);
    let mut fresh = scan.files;
    // List again: what was created between the listing and the walk is in
    // the walk unvetted, and its later events skip it as indexed. Anything
    // created after this listing arrives as an event, vetted. What left
    // the set between the listings (an excludes file edited before the
    // walk's watches saw it) re-prunes as the event loop starts, and so
    // does a failure, keeping the first set.
    let mut reprune = None;
    if let Some(root) = &git_root
        && let IgnoreRule::Git(first) = &*rule.get()
    {
        match root.prune(root.dir().to_path_buf()).await {
            Ok(second) => {
                let added = second.added_since(first);
                // the walk skipped what left the set meanwhile, and no watch
                // may have seen its excludes file change: a re-prune walks it
                if !first.added_since(&second).is_empty() {
                    reprune = Some(PendingReprune::now(false));
                }
                rule.set(IgnoreRule::Git(second));
                drop_newly_ignored(&added, &source_dir, &mut fresh, &watches).await;
            }
            Err(e) => {
                tracing::debug!(
                    path,
                    error = %fuz_sys::cli::format_error_chain(&e),
                    "git couldn't list this checkout's ignored paths again; re-pruning"
                );
                reprune = Some(PendingReprune::now(false));
            }
        }
    }
    watches.lock().poll_missing_root = true;
    let mut initial_files = FileIndex::new();
    apply_subtree(&mut initial_files, &source_dir, fresh);
    let files = Arc::new(RwLock::new(initial_files));

    let git = git_root.map(|root| GitIgnore {
        exclude: root.info_exclude(),
        root,
        live_added: 0,
        failures: 0,
    });
    let (rescan_tx, rescan_rx) = mpsc::channel(64);
    let state = FilerState {
        source_dir,
        ignored_dirs: config.ignored_dirs,
        rule: rule.clone(),
        wire: Arc::clone(&wire),
        git,
        reprune,
        vetted: HashMap::new(),
        depth: config.depth,
        files: Arc::clone(&files),
        pending: HashMap::new(),
        watches: Arc::clone(&watches),
        unwatched_count: Arc::clone(&unwatched_count),
        degraded_rescan_interval: config.degraded_rescan_interval,
        clock: SystemTime::now,
    };
    // spawned once nothing can fail, so a failed start leaves no task
    let publisher = on_ignored_change.map(|on_change| {
        tokio::spawn(publish_ignored_changes(
            Arc::clone(&ignored_signal),
            on_change,
            IGNORED_REFRESH_INTERVAL,
        ))
    });
    let task = tokio::spawn(filer_event_loop(
        state,
        rx,
        rescan_rx,
        Arc::clone(&signal),
        ignored_signal,
        broadcast,
    ));

    Ok(Filer {
        task,
        files,
        rescan_tx,
        unwatched_count,
        rule,
        wire,
        wire_cache: Mutex::new(None),
        publisher,
        #[cfg(test)]
        watches,
        #[cfg(test)]
        signal,
    })
}

/// The rule a filer on `path` ([`dir_prefix`](super::dir_prefix) form)
/// starts with, and its git root when that's git's: a root that is a
/// checkout (`project::is_checkout`) indexed whole, with a usable git whose
/// first listing succeeds. Anything else is on fixed names — a failing git
/// warned about, since the root then indexes what its `.gitignore` names.
pub(super) async fn initial_rule(
    path: &str,
    config: &FilerConfig,
) -> (Option<GitRoot>, IgnoreRule) {
    if config.depth != FilerDepth::Tree {
        return (None, IgnoreRule::FixedNames);
    }
    let Some(git) = config.git.as_ref() else {
        if crate::project::is_checkout(super::prefix_dir(path)) {
            tracing::warn!(
                path,
                "git is unusable; ignoring by fixed names in a checkout"
            );
        }
        return (None, IgnoreRule::FixedNames);
    };
    let Some(root) = GitRoot::at(path, Arc::clone(git)) else {
        return (None, IgnoreRule::FixedNames);
    };
    match root.prune(root.dir().to_path_buf()).await {
        Ok(set) => (Some(root), IgnoreRule::Git(set)),
        Err(e) => {
            tracing::warn!(
                path,
                error = %fuz_sys::cli::format_error_chain(&e),
                "git couldn't list what this checkout ignores; ignoring by fixed names"
            );
            (None, IgnoreRule::FixedNames)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::dir_prefix;
    use crate::filer::test_support::{
        TempDir, keys_of, lock_dir, start, wait_for_keys, watched_dirs,
    };

    #[test]
    fn tree_config_ignores_zzz_dir_only_when_nested() {
        let nested = FilerConfig::tree("/w/", "/w/sub/data/");
        assert_eq!(nested.ignored_dirs, vec![PathBuf::from("/w/sub/data")]);
        // the root itself, a sibling, an ancestor, and a name-prefix sibling
        for (root, zzz_dir) in [
            ("/w/", "/w/"),
            ("/w/", "/other/.zzz/"),
            ("/w/sub/data/inner/", "/w/sub/data/"),
            ("/w/data2/", "/w/data/"),
        ] {
            assert!(
                FilerConfig::tree(root, zzz_dir).ignored_dirs.is_empty(),
                "{root} {zzz_dir}"
            );
        }
    }

    #[test]
    fn tree_config_marks_a_root_in_a_protected_dir() {
        let zzz_home = Some(ProtectedDir::ZzzHome);
        for (root, zzz_dir, marked) in [
            ("/home/u/.zzz/", "/home/u/.zzz/.zzz/", zzz_home),
            ("/w/.zzz/run/", "/home/u/.zzz/.zzz/", zzz_home),
            ("/home/u/.zzz/.zzz/", "/home/u/.zzz/.zzz/", None),
            ("/home/u/.zzz/.zzz/state/", "/home/u/.zzz/.zzz/", None),
            ("/home/u/", "/home/u/.zzz/.zzz/", None),
            (
                "/home/u/.ssh/",
                "/home/u/.zzz/.zzz/",
                Some(ProtectedDir::Credentials(".ssh")),
            ),
            (
                "/w/x/.kube/cache/",
                "/home/u/.zzz/.zzz/",
                Some(ProtectedDir::Credentials(".kube")),
            ),
        ] {
            assert_eq!(
                FilerConfig::tree(root, zzz_dir).root_protected,
                marked,
                "{root} {zzz_dir}"
            );
        }
        assert_eq!(FilerConfig::zzz_dir().root_protected, None);
    }

    #[tokio::test]
    async fn a_root_in_a_zzz_home_fails_to_start() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path(".zzz/.zzz")).unwrap();
        std::fs::write(tmp.path(".zzz/.env"), "SECRET=x").unwrap();
        let home = dir_prefix(&tmp.key(".zzz"));
        let app_dir = dir_prefix(&tmp.key(".zzz/.zzz"));
        let error = start_filer(
            &home,
            Arc::new(|_: &str| {}),
            FilerConfig::tree(&home, &app_dir),
        )
        .await
        .expect_err("the daemon home is refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        // the app dir itself still starts
        start_filer(
            &app_dir,
            Arc::new(|_: &str| {}),
            FilerConfig::tree(&app_dir, &app_dir),
        )
        .await
        .expect("the app dir starts");
    }

    #[test]
    fn rescan_signal_coalesces() {
        let signal = RescanSignal::default();
        assert!(!signal.take());
        signal.request();
        signal.request();
        assert!(signal.take());
        assert!(!signal.take());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreadable_or_missing_root_fails_to_start() {
        let missing = TempDir::new();
        let root = missing.root();
        std::fs::remove_dir(&missing.0).unwrap();
        let error = start_filer(&root, Arc::new(|_: &str| {}), FilerConfig::zzz_dir())
            .await
            .expect_err("a missing root fails");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);

        let tmp = TempDir::new();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        let Some(_unlock) = lock_dir(&tmp.0) else {
            return;
        };
        let error = start_filer(&tmp.root(), Arc::new(|_: &str| {}), FilerConfig::zzz_dir())
            .await
            .expect_err("an unreadable root fails");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_top_level_filer_indexes_and_watches_its_root_alone() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("repo/src")).unwrap();
        std::fs::write(tmp.path("README.md"), "r").unwrap();
        std::fs::write(tmp.path("repo/a.txt"), "a").unwrap();
        std::fs::write(tmp.path("repo/src/b.txt"), "b").unwrap();

        let filer = start(&tmp, FilerConfig::top_level(&tmp.root(), "/nowhere/")).await;
        assert_eq!(keys_of(&filer).await, [tmp.key("README.md")]);
        assert_eq!(watched_dirs(&filer), [tmp.root()]);

        // a new loose file arrives; a new directory, and files in one, don't
        std::fs::create_dir_all(tmp.path("other")).unwrap();
        std::fs::write(tmp.path("other/c.txt"), "c").unwrap();
        std::fs::write(tmp.path("repo/d.txt"), "d").unwrap();
        std::fs::write(tmp.path("notes.txt"), "n").unwrap();
        wait_for_keys(&filer, &[tmp.key("README.md"), tmp.key("notes.txt")]).await;
        // a file replaced by a directory leaves the index, and its contents
        // stay out
        std::fs::remove_file(tmp.path("notes.txt")).unwrap();
        std::fs::create_dir(tmp.path("notes.txt")).unwrap();
        std::fs::write(tmp.path("notes.txt/e.txt"), "e").unwrap();
        wait_for_keys(&filer, &[tmp.key("README.md")]).await;
        // a rescan sees the same
        let (reply_tx, reply_rx) = oneshot::channel();
        filer.rescan_tx.send(reply_tx).await.unwrap();
        reply_rx.await.unwrap();
        assert_eq!(keys_of(&filer).await, [tmp.key("README.md")]);
        assert_eq!(watched_dirs(&filer), [tmp.root()]);
    }
}
