//! A running filer: its configuration, the handle, and `start_filer`.

use super::event_loop::{FilerState, filer_event_loop};
use super::index::{FileIndex, apply_subtree};
use super::walk::{is_ignored, scan_directory};
use super::watches::{DirWatches, WatcherFactory, is_indexable_kind};
use super::{DEGRADED_RESCAN_INTERVAL, EVENT_CHANNEL_CAPACITY, WatchStatus};
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
#[derive(Debug)]
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
    /// directories are ignored everywhere by `DEFAULT_IGNORED_DIRS`.
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

/// Coalesced "rescan the root" request, raised from the notify callback
/// (sync context) when events were dropped or notify asks for a rescan.
#[derive(Default)]
pub(super) struct RescanSignal {
    needed: AtomicBool,
    pub(super) notify: Notify,
}

impl RescanSignal {
    /// Mark a rescan as needed; wakes the event loop only on the
    /// not-needed → needed transition, so a burst of drops is one rescan.
    fn request(&self) {
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
    #[cfg(test)]
    pub(super) watches: Arc<Mutex<DirWatches>>,
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
}

/// The [`WatcherFactory`] of a filer on `path`: each watcher it creates
/// filters its events (ignored paths, access events) and sends them to `tx`,
/// requesting a rescan on `signal` when events are lost. It holds `tx`, so the
/// event channel stays open even while there's no watcher.
fn watcher_factory(
    path: &str,
    config: &FilerConfig,
    tx: mpsc::Sender<notify::Event>,
    signal: Arc<RescanSignal>,
) -> WatcherFactory {
    let root = PathBuf::from(path);
    let ignored_dirs = config.ignored_dirs.clone();
    #[cfg(test)]
    let no_watcher = config.no_watcher;
    Box::new(move || {
        #[cfg(test)]
        if no_watcher {
            return None;
        }
        let (root, ignored_dirs, tx, signal) = (
            root.clone(),
            ignored_dirs.clone(),
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
                // parent's.
                event.paths.retain(|p| !is_ignored(p, &root, &ignored_dirs));
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
    let (tx, rx) = mpsc::channel::<notify::Event>(EVENT_CHANNEL_CAPACITY);
    let signal = Arc::new(RescanSignal::default());
    let make_watcher = watcher_factory(path, &config, tx, Arc::clone(&signal));

    let source_dir = path.to_owned();
    let watches = Arc::new(Mutex::new(DirWatches::new(
        make_watcher,
        &source_dir,
        config.watch_limit,
    )));
    let unwatched_count = Arc::clone(&watches.lock().unwatched_count);

    // Initial scan — populate the file index (no broadcast; callers read it).
    // A directory whose listing failed transiently has nothing indexed to
    // keep yet; it's polled until it lists.
    let (fresh, _kept) = scan_directory(
        &source_dir,
        &source_dir,
        &config.ignored_dirs,
        config.depth,
        &watches,
        false,
        SystemTime::now,
        None,
    )
    .await?;
    watches.lock().poll_missing_root = true;
    let mut initial_files = FileIndex::new();
    apply_subtree(&mut initial_files, &source_dir, fresh);
    let files = Arc::new(RwLock::new(initial_files));

    let (rescan_tx, rescan_rx) = mpsc::channel(64);
    let state = FilerState {
        source_dir,
        ignored_dirs: config.ignored_dirs,
        depth: config.depth,
        files: Arc::clone(&files),
        pending: HashMap::new(),
        watches: Arc::clone(&watches),
        unwatched_count: Arc::clone(&unwatched_count),
        degraded_rescan_interval: config.degraded_rescan_interval,
        clock: SystemTime::now,
    };
    let task = tokio::spawn(filer_event_loop(state, rx, rescan_rx, signal, broadcast));

    Ok(Filer {
        task,
        files,
        rescan_tx,
        unwatched_count,
        #[cfg(test)]
        watches,
    })
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
