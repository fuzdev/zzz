//! `FilerManager`: the filers of a daemon, their lifetimes and depths.

use super::core::{
    Filer, FilerBroadcast, FilerConfig, FilerDepth, FilerIgnoredChange, start_filer,
};
use super::index::FileIndex;
use super::{IgnoredPaths, SerializableDisknode, WatchStatus};
use crate::handlers::App;
use parking_lot::Mutex;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use tokio::sync::{RwLock, mpsc, oneshot};

// -- FilerManager -------------------------------------------------------------

/// Whether a filer was started at server startup (permanent) or via
/// `project_open` (can be stopped on `project_close`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilerLifetime {
    /// Started at server startup for `zzz_dir` or `scoped_dirs` — never stopped.
    Permanent,
    /// Started via `project_open` — stopped when no open project uses it.
    Project,
}

/// Entry in the filer manager.
#[derive(Debug)]
pub struct FilerEntry {
    pub filer: Filer,
    pub lifetime: FilerLifetime,
    /// What the filer indexes of its root ([`FilerConfig::depth`]).
    pub depth: FilerDepth,
}

/// Manages all active filers with deduplication and lifetime tracking.
///
/// One filer per unique directory path. Permanent filers (`zzz_dir`, `scoped_dirs`)
/// survive `project_close`. Project filers are stopped on close.
pub struct FilerManager {
    filers: RwLock<HashMap<String, FilerEntry>>,
    /// A gate per path whose filer is being started, so concurrent starts
    /// of one path share a single initial scan: the first scans, the rest
    /// wait for it and adopt its filer.
    starting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Test seam: how many initial scans ran.
    #[cfg(test)]
    scans: AtomicUsize,
}

impl std::fmt::Debug for FilerManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilerManager").finish_non_exhaustive()
    }
}

/// A [`FilerBroadcast`] through `App::broadcast`. Holds the app weakly — the
/// filers live in the app, so a strong reference would be a cycle.
fn app_broadcast(app: &Arc<App>) -> FilerBroadcast {
    let app: Weak<App> = Arc::downgrade(app);
    Arc::new(move |message: &str| {
        if let Some(app) = app.upgrade() {
            app.broadcast(message);
        }
    })
}

/// A [`FilerIgnoredChange`] that refreshes the open projects
/// (`ProjectManager::refresh_ignored`) on a task of its own: the refresh
/// takes the projects lock, and a commit may stop the very filer whose
/// publisher calls this, aborting it — a commit must run to completion.
/// Holds the app weakly, as [`app_broadcast`] does.
fn app_ignored_change(app: &Arc<App>) -> FilerIgnoredChange {
    let app: Weak<App> = Arc::downgrade(app);
    Arc::new(move || {
        let Some(app) = app.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            if let Err(e) = app.projects.refresh_ignored(&app).await {
                tracing::warn!(
                    error = %fuz_sys::cli::format_error_chain(&e),
                    "failed to republish a filer's ignored paths"
                );
            }
        });
    })
}

/// `config` with the app's git when the boot check found it usable, so a
/// checkout's filer takes git's ignore rule, and the hook that republishes
/// its ignored set.
fn with_app(mut config: FilerConfig, app: &Arc<App>) -> FilerConfig {
    if app.git_usability.is_usable() {
        config.git = Some(Arc::clone(&app.git));
    }
    config.on_ignored_change = Some(app_ignored_change(app));
    config
}

impl Default for FilerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FilerManager {
    pub fn new() -> Self {
        Self {
            filers: RwLock::new(HashMap::new()),
            starting: Mutex::new(HashMap::new()),
            #[cfg(test)]
            scans: AtomicUsize::new(0),
        }
    }

    /// Start a filer for the given directory path. Returns `Ok(true)` if a new
    /// filer was created, `Ok(false)` if one already existed for this path
    /// (or another start of it finished first — concurrent starts share one
    /// initial scan).
    ///
    /// If a filer already exists, its lifetime is upgraded to `Permanent` if
    /// the new request is `Permanent` (but never downgraded). One that
    /// indexes only its root's top level is replaced by a new one when the
    /// request is for the whole tree; a whole-tree filer serves a top-level
    /// request as it is.
    ///
    /// # Errors
    ///
    /// The root can't be listed (see [`start_filer`]).
    pub async fn start_filer(
        &self,
        path: &str,
        app: Arc<App>,
        config: FilerConfig,
        lifetime: FilerLifetime,
    ) -> io::Result<bool> {
        let config = with_app(config, &app);
        self.start_with(path, app_broadcast(&app), config, lifetime)
            .await
    }

    /// [`Self::start_filer`] with an explicit broadcast sink.
    async fn start_with(
        &self,
        path: &str,
        broadcast: FilerBroadcast,
        config: FilerConfig,
        lifetime: FilerLifetime,
    ) -> io::Result<bool> {
        debug_assert!(
            path.ends_with('/'),
            "FilerManager paths must have trailing slash: {path}"
        );
        let depth = config.depth;
        if self.adopt(path, lifetime, depth).await {
            return Ok(false);
        }

        let gate = Arc::clone(self.starting.lock().entry(path.to_owned()).or_default());
        let started = async {
            let _gate = gate.lock().await;
            // another start of this path finished while this one waited
            if self.adopt(path, lifetime, depth).await {
                return Ok(false);
            }
            #[cfg(test)]
            self.scans.fetch_add(1, Ordering::Relaxed);
            let filer = start_filer(path, broadcast, config).await?;
            let mut filers = self.filers.write().await;
            let lifetime = match filers.get(path) {
                Some(existing) if !serves(existing.depth, depth) => {
                    max_lifetime(existing.lifetime, lifetime)
                }
                Some(_) => return Ok(false),
                None => lifetime,
            };
            // replacing a top-level filer drops it, which stops it. Depth
            // only ever grows here: a tree filer serves a later top-level
            // request as it is, so a caller that wants it narrowed replaces
            // it (`Self::replace_filer`)
            filers.insert(
                path.to_owned(),
                FilerEntry {
                    filer,
                    lifetime,
                    depth,
                },
            );
            Ok(true)
        }
        .await;
        // the gate is shared only through `starting`, under its lock — with
        // no other holder, nobody is waiting on it
        let mut starting = self.starting.lock();
        if Arc::strong_count(&gate) == 2 {
            starting.remove(path);
        }
        drop(starting);
        started
    }

    /// Whether a filer already watches `path` and indexes what `depth` asks
    /// for — upgrading its lifetime to `Permanent` if `lifetime` is (never
    /// downgrading it).
    async fn adopt(&self, path: &str, lifetime: FilerLifetime, depth: FilerDepth) -> bool {
        let filers = self.filers.read().await;
        let Some(entry) = filers.get(path) else {
            return false;
        };
        if !serves(entry.depth, depth) {
            return false;
        }
        if lifetime == FilerLifetime::Permanent && entry.lifetime == FilerLifetime::Project {
            drop(filers);
            if let Some(entry) = self.filers.write().await.get_mut(path) {
                entry.lifetime = FilerLifetime::Permanent;
            }
        }
        true
    }

    /// Start a new filer for `path` with `config` and swap it in for the one
    /// running there, if that one is project-scoped — for narrowing a filer,
    /// which [`Self::start_filer`] never does. A permanent filer is kept as
    /// it is (the new one is dropped); with none running, the new one is
    /// added, project-scoped. The old filer runs until the new one has
    /// finished its scan, so the path is never unwatched.
    ///
    /// # Errors
    ///
    /// The root can't be listed (see [`start_filer`]); the old filer stays.
    pub async fn replace_filer(
        &self,
        path: &str,
        app: Arc<App>,
        config: FilerConfig,
    ) -> io::Result<()> {
        let config = with_app(config, &app);
        self.replace_with(path, app_broadcast(&app), config).await
    }

    /// [`Self::replace_filer`] with an explicit broadcast sink.
    async fn replace_with(
        &self,
        path: &str,
        broadcast: FilerBroadcast,
        config: FilerConfig,
    ) -> io::Result<()> {
        debug_assert!(
            path.ends_with('/'),
            "FilerManager paths must have trailing slash: {path}"
        );
        let depth = config.depth;
        let filer = start_filer(path, broadcast, config).await?;
        let mut filers = self.filers.write().await;
        match filers.get_mut(path) {
            Some(entry) if entry.lifetime == FilerLifetime::Permanent => {}
            // dropping the old filer stops it
            Some(entry) => {
                entry.filer = filer;
                entry.depth = depth;
            }
            None => {
                filers.insert(
                    path.to_owned(),
                    FilerEntry {
                        filer,
                        lifetime: FilerLifetime::Project,
                        depth,
                    },
                );
            }
        }
        Ok(())
    }

    /// How much of its root the filer on `path` indexes, and its lifetime —
    /// `None` with no filer there.
    pub async fn depth_of(&self, path: &str) -> Option<(FilerDepth, FilerLifetime)> {
        self.filers
            .read()
            .await
            .get(path)
            .map(|entry| (entry.depth, entry.lifetime))
    }

    /// [`Self::replace_filer`] only where there's something to narrow: a
    /// project-scoped filer on `path` indexing its whole tree. Any other —
    /// none, a permanent one, one already at its top level — is left as it
    /// is, with no scan.
    ///
    /// Returns whether a filer was replaced.
    ///
    /// # Errors
    ///
    /// The root can't be listed (see [`start_filer`]); the old filer stays.
    pub async fn narrow_filer(
        &self,
        path: &str,
        app: Arc<App>,
        config: FilerConfig,
    ) -> io::Result<bool> {
        if self.depth_of(path).await != Some((FilerDepth::Tree, FilerLifetime::Project)) {
            return Ok(false);
        }
        self.replace_filer(path, app, config).await?;
        Ok(true)
    }

    /// Every project-scoped filer's root and depth.
    #[cfg(test)]
    pub(crate) async fn project_filers(&self) -> BTreeMap<String, FilerDepth> {
        self.filers
            .read()
            .await
            .iter()
            .filter(|(_, entry)| entry.lifetime == FilerLifetime::Project)
            .map(|(root, entry)| (root.clone(), entry.depth))
            .collect()
    }

    /// Stop and remove a filer for the given path. Only stops project-scoped
    /// filers — permanent filers are preserved.
    ///
    /// Returns `true` if the filer was actually stopped.
    pub async fn stop_filer(&self, path: &str) -> bool {
        debug_assert!(
            path.ends_with('/'),
            "FilerManager paths must have trailing slash: {path}"
        );
        let mut filers = self.filers.write().await;
        if let Some(entry) = filers.get(path) {
            if entry.lifetime == FilerLifetime::Permanent {
                return false;
            }
            filers.remove(path);
            true
        } else {
            false
        }
    }

    /// Rescan every active filer's watched directory, reconciling each index
    /// with the disk (differences are broadcast as `filer_change`).
    ///
    /// Called by `session_load` before `snapshot` to guarantee a
    /// consistent snapshot — notify events are eventually consistent, so a
    /// just-written file may not yet be in the index when the event loop is
    /// still draining. A direct filesystem walk sidesteps that race; files
    /// whose trusted `lstat` stamp is unchanged aren't broadcast
    /// ([`is_unchanged`](super::index::is_unchanged)). The rescans run on each filer's event loop, so
    /// they serialize with event handling instead of racing it.
    pub async fn rescan_all(&self) {
        // Snapshot the request senders under the outer lock, then rescan
        // without holding it — the outer lock blocks start_filer/stop_filer.
        let senders: Vec<mpsc::Sender<oneshot::Sender<()>>> = {
            let filers = self.filers.read().await;
            filers.values().map(|e| e.filer.rescan_tx.clone()).collect()
        };
        // TODO: no timeout, so a git root whose rescan stalls on git (up to
        // its listing timeouts) delays every client's `session_load`; a
        // per-filer timeout would bound it
        futures_util::future::join_all(senders.into_iter().map(|rescan_tx| async move {
            let (reply_tx, reply_rx) = oneshot::channel();
            if rescan_tx.send(reply_tx).await.is_ok() {
                let _ = reply_rx.await;
            }
        }))
        .await;
    }

    /// What each of `dirs` (trailing `/`) carries on the wire as ignored
    /// ([`Filer::ignored_on_wire`]): one entry per dir whose filer indexes
    /// its whole tree on git's rule — none for a dir on fixed names, a
    /// top-level filer, or no filer. Every filer is marked on or off the
    /// wire by whether its dir is among `dirs` ([`Filer::set_on_wire`]), all
    /// under one read of the filer map.
    ///
    /// Lock order: the filer map (read), then each filer's rule (read) —
    /// called by `ProjectManager`'s commit under the projects lock, as
    /// `files_for` is; no filer lock is held across an await.
    pub async fn ignored_on_wire(&self, dirs: &BTreeSet<String>) -> BTreeMap<String, IgnoredPaths> {
        let filers = self.filers.read().await;
        let mut ignored = BTreeMap::new();
        for (root, entry) in filers.iter() {
            let wanted = entry.depth == FilerDepth::Tree && dirs.contains(root);
            entry.filer.set_on_wire(wanted);
            if wanted && let Some(paths) = entry.filer.ignored_on_wire(root) {
                ignored.insert(root.clone(), paths);
            }
        }
        ignored
    }

    /// The indexed files of the filer watching exactly `path` (trailing
    /// slash). Empty if no filer watches it.
    pub async fn files_for(&self, path: &str) -> Vec<SerializableDisknode> {
        let files = {
            let filers = self.filers.read().await;
            filers.get(path).map(|e| Arc::clone(&e.filer.files))
        };
        match files {
            Some(files) => files.read().await.values().cloned().collect(),
            None => vec![],
        }
    }

    /// Test seam: hold the index of the filer on `path` for writing, so a
    /// read of it waits.
    #[cfg(test)]
    pub(crate) async fn hold_index(&self, path: &str) -> impl Drop + use<> {
        let files = Arc::clone(&self.filers.read().await[path].filer.files);
        files.write_owned().await
    }

    /// The watch status of the filer watching exactly `path` (trailing
    /// slash); `Full` if no filer watches it.
    pub async fn watch_status_for(&self, path: &str) -> WatchStatus {
        self.filers
            .read()
            .await
            .get(path)
            .map_or(WatchStatus::Full, |e| e.filer.watch_status())
    }

    /// The root and indexed files of every permanent filer and every
    /// project-scoped one `keep` names, as one snapshot. Used by
    /// `session_load` to return the complete file listing — of the open
    /// projects as published, so a filer an open or focus in flight started isn't in
    /// it before its project is.
    ///
    /// The roots and file indexes are taken under one read of the filer map,
    /// so `roots` names exactly the filers `files` comes from: a file under a
    /// root that's missing from `files` isn't on disk (or isn't indexed —
    /// ignored, a symlink, non-UTF-8).
    pub async fn snapshot(&self, keep: &BTreeSet<String>) -> FilerSnapshot {
        // Collect Arc handles under the outer lock, then release it before
        // awaiting the inner per-filer locks — avoids holding the manager
        // lock across await points (which would block start_filer/stop_filer).
        let (mut roots, file_maps): (Vec<String>, Vec<Arc<RwLock<FileIndex>>>) = {
            let filers = self.filers.read().await;
            filers
                .iter()
                .filter(|(root, e)| e.lifetime == FilerLifetime::Permanent || keep.contains(*root))
                .map(|(root, e)| (root.clone(), Arc::clone(&e.filer.files)))
                .unzip()
        };
        roots.sort_unstable();

        let mut files = Vec::new();
        for index in &file_maps {
            files.extend(index.read().await.values().cloned());
        }
        FilerSnapshot { roots, files }
    }
}

/// Whether a filer indexing `existing` of its root serves a request for
/// `wanted`: anything does for a top-level request, only a tree for a tree.
fn serves(existing: FilerDepth, wanted: FilerDepth) -> bool {
    existing == FilerDepth::Tree || wanted == FilerDepth::TopLevel
}

/// The longer of two lifetimes — `Permanent` wins.
fn max_lifetime(a: FilerLifetime, b: FilerLifetime) -> FilerLifetime {
    if a == FilerLifetime::Permanent || b == FilerLifetime::Permanent {
        FilerLifetime::Permanent
    } else {
        FilerLifetime::Project
    }
}

/// Returned by [`FilerManager::snapshot`].
#[derive(Debug)]
pub struct FilerSnapshot {
    /// The root (trailing `/`) of every filer the snapshot covers, sorted.
    pub roots: Vec<String>,
    /// The indexed files of those filers — a file under two roots (nested
    /// filers) appears once per root.
    pub files: Vec<SerializableDisknode>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::test_support::TempDir;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_tree_request_replaces_a_top_level_filer_and_not_the_reverse() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("sub")).unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        std::fs::write(tmp.path("sub/b.txt"), "b").unwrap();
        let manager = FilerManager::new();
        let root = tmp.root();
        let start = |config| {
            manager.start_with(
                &root,
                Arc::new(|_: &str| {}),
                config,
                FilerLifetime::Project,
            )
        };
        let top = || FilerConfig::top_level(&root, "/nowhere/");
        let tree = || FilerConfig::tree(&root, "/nowhere/");

        assert!(start(top()).await.unwrap());
        assert!(!start(top()).await.unwrap(), "a top-level filer serves one");
        assert_eq!(manager.files_for(&root).await.len(), 1);
        assert!(start(tree()).await.unwrap(), "replaced by a tree");
        assert_eq!(manager.files_for(&root).await.len(), 2);
        assert!(
            !start(top()).await.unwrap(),
            "a tree serves a top-level request"
        );
        assert!(!start(tree()).await.unwrap());
        assert_eq!(manager.files_for(&root).await.len(), 2);
        assert_eq!(manager.scans.load(Ordering::Relaxed), 2);
        // a permanent top-level filer replaced stays permanent
        let other = TempDir::new();
        let other_root = other.root();
        for (config, lifetime) in [
            (
                FilerConfig::top_level(&other_root, "/nowhere/"),
                FilerLifetime::Permanent,
            ),
            (
                FilerConfig::tree(&other_root, "/nowhere/"),
                FilerLifetime::Project,
            ),
        ] {
            assert!(
                manager
                    .start_with(&other_root, Arc::new(|_: &str| {}), config, lifetime)
                    .await
                    .unwrap()
            );
        }
        assert!(!manager.stop_filer(&other_root).await);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_replacement_narrows_a_project_filer_and_keeps_a_permanent_one() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("sub")).unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        std::fs::write(tmp.path("sub/b.txt"), "b").unwrap();
        let manager = FilerManager::new();
        let root = tmp.root();
        let sink = || -> FilerBroadcast { Arc::new(|_: &str| {}) };
        let top = || FilerConfig::top_level(&root, "/nowhere/");
        let tree = || FilerConfig::tree(&root, "/nowhere/");

        manager
            .start_with(&root, sink(), tree(), FilerLifetime::Project)
            .await
            .unwrap();
        assert_eq!(manager.files_for(&root).await.len(), 2);
        manager.replace_with(&root, sink(), top()).await.unwrap();
        assert_eq!(manager.files_for(&root).await.len(), 1, "narrowed");
        assert!(
            !manager
                .start_with(&root, sink(), top(), FilerLifetime::Project)
                .await
                .unwrap()
        );
        // a root that can't be listed leaves the filer as it was
        let gone = format!("{root}gone/");
        assert!(manager.replace_with(&gone, sink(), top()).await.is_err());

        let other = TempDir::new();
        let other_root = other.root();
        std::fs::create_dir_all(other.path("sub")).unwrap();
        std::fs::write(other.path("sub/c.txt"), "c").unwrap();
        let other_tree = FilerConfig::tree(&other_root, "/nowhere/");
        manager
            .start_with(&other_root, sink(), other_tree, FilerLifetime::Permanent)
            .await
            .unwrap();
        let other_top = FilerConfig::top_level(&other_root, "/nowhere/");
        manager
            .replace_with(&other_root, sink(), other_top)
            .await
            .unwrap();
        assert_eq!(
            manager.files_for(&other_root).await.len(),
            1,
            "a permanent filer stays whole"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_starts_of_one_path_share_one_scan() {
        let tmp = TempDir::new();
        for i in 0..50 {
            std::fs::write(tmp.path(&format!("{i}.txt")), "x").unwrap();
        }
        let manager = FilerManager::new();
        let root = tmp.root();
        let start = || {
            manager.start_with(
                &root,
                Arc::new(|_: &str| {}),
                FilerConfig::zzz_dir(),
                FilerLifetime::Project,
            )
        };
        let (first, second) = tokio::join!(start(), start());
        let mut created = [first.unwrap(), second.unwrap()];
        created.sort_unstable();
        assert_eq!(created, [false, true]);
        assert_eq!(manager.scans.load(Ordering::Relaxed), 1);
        assert!(manager.starting.lock().is_empty());
        assert_eq!(manager.files_for(&root).await.len(), 50);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_names_the_roots_its_files_come_from() {
        let a = TempDir::new();
        let b = TempDir::new();
        std::fs::write(a.path("a.txt"), "a").unwrap();
        std::fs::write(b.path("b.txt"), "b").unwrap();
        let manager = FilerManager::new();
        let none = BTreeSet::new();
        let kept = BTreeSet::from([b.root()]);
        let snapshot = manager.snapshot(&kept).await;
        assert!(snapshot.roots.is_empty() && snapshot.files.is_empty());

        for (tmp, lifetime) in [(&a, FilerLifetime::Permanent), (&b, FilerLifetime::Project)] {
            manager
                .start_with(
                    &tmp.root(),
                    Arc::new(|_: &str| {}),
                    FilerConfig::zzz_dir(),
                    lifetime,
                )
                .await
                .unwrap();
        }
        // a project-scoped filer only when it's named, a permanent one always
        let snapshot = manager.snapshot(&none).await;
        assert_eq!(snapshot.roots, vec![a.root()]);
        assert_eq!(snapshot.files.len(), 1);
        let snapshot = manager.snapshot(&kept).await;
        let mut roots = vec![a.root(), b.root()];
        roots.sort_unstable();
        assert_eq!(snapshot.roots, roots);
        let mut files: Vec<String> = snapshot.files.into_iter().map(|f| f.id).collect();
        files.sort_unstable();
        let mut expected = vec![a.key("a.txt"), b.key("b.txt")];
        expected.sort_unstable();
        assert_eq!(files, expected);

        // a stopped filer leaves both
        assert!(manager.stop_filer(&b.root()).await);
        let snapshot = manager.snapshot(&kept).await;
        assert_eq!(snapshot.roots, vec![a.root()]);
        assert_eq!(snapshot.files.len(), 1);
    }

    /// each filer is on the wire exactly while a focused dir names
    /// it and it indexes its tree — a permanent one too, while focused.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ignored_on_wire_marks_each_filer() {
        let (a, b, c) = (TempDir::new(), TempDir::new(), TempDir::new());
        let manager = FilerManager::new();
        let sink = || -> FilerBroadcast { Arc::new(|_: &str| {}) };
        let (ra, rb, rc) = (a.root(), b.root(), c.root());
        for (root, config, lifetime) in [
            (
                &ra,
                FilerConfig::tree(&ra, "/nowhere/"),
                FilerLifetime::Project,
            ),
            (
                &rb,
                FilerConfig::tree(&rb, "/nowhere/"),
                FilerLifetime::Permanent,
            ),
            (
                &rc,
                FilerConfig::top_level(&rc, "/nowhere/"),
                FilerLifetime::Project,
            ),
        ] {
            manager
                .start_with(root, sink(), config, lifetime)
                .await
                .unwrap();
        }
        let marks = |manager: &FilerManager| {
            let filers = manager.filers.try_read().unwrap();
            [&ra, &rb, &rc].map(|r| filers[r.as_str()].filer.is_on_wire())
        };
        assert!(
            manager
                .ignored_on_wire(&BTreeSet::from([ra.clone(), rc.clone()]))
                .await
                .is_empty()
        );
        assert_eq!(marks(&manager), [true, false, false]);
        manager.ignored_on_wire(&BTreeSet::from([rb.clone()])).await;
        assert_eq!(marks(&manager), [false, true, false]);
        manager.ignored_on_wire(&BTreeSet::new()).await;
        assert_eq!(marks(&manager), [false, false, false]);
    }
}
