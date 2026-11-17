//! Shared helpers for the filer modules' tests.

use super::core::{Filer, FilerConfig, FilerDepth, start_filer};
use super::event_loop::FilerState;
use super::index::{FileIndex, apply_subtree, make_disknode};
use super::walk::scan_directory;
use super::watches::{DirWatches, WatcherFactory, is_indexable_kind};
use super::{ChangeType, Clock, DEGRADED_RESCAN_INTERVAL, SerializableDisknode, dir_prefix};
use notify::{EventKind, RecommendedWatcher, Watcher};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::RwLock;
use tokio::time::Instant;

pub(super) fn node(path: &str, size: u64, mtime: f64) -> SerializableDisknode {
    make_disknode(path.to_owned(), "/w/", Some(size), None, Some(mtime), None)
}

/// A unique temp dir removed on drop.
pub(super) struct TempDir(pub(super) PathBuf);

impl TempDir {
    pub(super) fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("zzz_filer_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // canonical, so paths match what the walker yields
        Self(dir.canonicalize().unwrap())
    }

    pub(super) fn root(&self) -> String {
        dir_prefix(&self.0.to_string_lossy())
    }

    pub(super) fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }

    pub(super) fn key(&self, rel: &str) -> String {
        self.path(rel).to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A factory of real watchers whose events go to `sink`.
pub(super) fn factory_into(sink: Arc<Mutex<Vec<PathBuf>>>) -> WatcherFactory {
    Box::new(move || {
        let sink = Arc::clone(&sink);
        RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res
                    && is_indexable_kind(event.kind)
                {
                    sink.lock().extend(event.paths);
                }
            },
            notify::Config::default().with_follow_symlinks(false),
        )
        .ok()
    })
}

/// Watches for `root` through real watchers whose events are dropped.
pub(super) fn watches_for(root: &str, watch_limit: Option<usize>) -> Arc<Mutex<DirWatches>> {
    Arc::new(Mutex::new(DirWatches::new(
        factory_into(Arc::default()),
        root,
        watch_limit,
    )))
}

/// A clock an hour ahead, so every stamp a filer takes is trusted, as
/// for files that have been still a while — tests on it move a stamp on
/// purpose (a new size, `set_mtime`, or a wait past the timestamp tick).
pub(super) fn settled() -> SystemTime {
    SystemTime::now() + Duration::from_hours(1)
}

/// The initial scan of `root`, as `start_filer` runs it, on `clock`.
pub(super) async fn scan_into(
    root: &str,
    ignored_dirs: &[PathBuf],
    watches: &Arc<Mutex<DirWatches>>,
    clock: Clock,
) -> FileIndex {
    let fresh = tokio::time::timeout(
        Duration::from_secs(10),
        scan_directory(
            root,
            root,
            ignored_dirs,
            FilerDepth::Tree,
            watches,
            false,
            clock,
            None,
        ),
    )
    .await
    .expect("scan must terminate")
    .expect("the root is listable")
    .0;
    let mut files = FileIndex::new();
    apply_subtree(&mut files, root, fresh);
    files
}

pub(super) async fn state_with(tmp: &TempDir, ignored_dirs: Vec<PathBuf>) -> FilerState {
    state_on(tmp, ignored_dirs, settled).await
}

/// The event-loop state of a filer on `tmp` whose stamps are judged by
/// `clock`.
pub(super) async fn state_on(
    tmp: &TempDir,
    ignored_dirs: Vec<PathBuf>,
    clock: Clock,
) -> FilerState {
    let root = tmp.root();
    let watches = watches_for(&root, None);
    let files = scan_into(&root, &ignored_dirs, &watches, clock).await;
    watches.lock().poll_missing_root = true;
    let unwatched_count = Arc::clone(&watches.lock().unwatched_count);
    FilerState {
        source_dir: root,
        ignored_dirs,
        depth: FilerDepth::Tree,
        files: Arc::new(RwLock::new(files)),
        pending: HashMap::new(),
        watches,
        unwatched_count,
        degraded_rescan_interval: DEGRADED_RESCAN_INTERVAL,
        clock,
    }
}

/// The event-loop state of a filer on `tmp`, on the [`settled`] clock.
pub(super) async fn state_for(tmp: &TempDir) -> FilerState {
    state_with(tmp, vec![]).await
}

pub(super) fn event(kind: EventKind, paths: &[PathBuf]) -> notify::Event {
    let mut event = notify::Event::new(kind);
    event.paths = paths.to_vec();
    event
}

pub(super) fn pending_of(state: &FilerState) -> Vec<(String, ChangeType)> {
    let mut pending: Vec<(String, ChangeType)> = state
        .pending
        .iter()
        .map(|(k, v)| (k.clone(), v.change_type))
        .collect();
    pending.sort_by(|a, b| a.0.cmp(&b.0));
    pending
}

pub(super) async fn indexed(state: &FilerState) -> Vec<String> {
    state.files.read().await.keys().cloned().collect()
}

/// A running filer on `tmp`, its broadcasts dropped.
pub(super) async fn start(tmp: &TempDir, config: FilerConfig) -> Filer {
    start_filer(&tmp.root(), Arc::new(|_: &str| {}), config)
        .await
        .expect("the filer starts")
}

pub(super) async fn keys_of(filer: &Filer) -> Vec<String> {
    filer.files.read().await.keys().cloned().collect()
}

pub(super) fn watched_dirs(filer: &Filer) -> Vec<String> {
    filer.watches.lock().watched.keys().cloned().collect()
}

/// Wait (up to 10s) until `filer`'s indexed paths equal `expected`.
pub(super) async fn wait_for_keys(filer: &Filer, expected: &[String]) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let keys = keys_of(filer).await;
        if keys == expected {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out: indexed {keys:?}, expected {expected:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Restores a directory's permissions on drop, so a failed test can
/// still clean up its `chmod 000` directory.
pub(super) struct Unlock(PathBuf);

impl Drop for Unlock {
    fn drop(&mut self) {
        set_mode(&self.0, 0o755);
    }
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// `chmod 000` `path`, or `None` when the OS doesn't enforce it (running
/// as root) — the test then has nothing to check.
pub(super) fn lock_dir(path: &Path) -> Option<Unlock> {
    set_mode(path, 0o000);
    let unlock = Unlock(path.to_path_buf());
    std::fs::read_dir(path).is_err().then_some(unlock)
}
