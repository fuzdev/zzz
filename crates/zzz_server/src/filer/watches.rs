//! Per-directory watches and the classification of notify events.

use super::{prefix_dir, retain_under, under};
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

// -- Event classification -----------------------------------------------------

/// What a notify event says about one path — a hint about where to look,
/// resolved against the disk by [`FilerState::apply_hint`](super::event_loop::FilerState::apply_hint).
///
/// Either way `lstat` decides: a regular file is upserted, anything else
/// (missing, a symlink, a special file) removes the path and everything
/// indexed under it. The hints differ only for directories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PathHint {
    /// The entry itself may have appeared, vanished, or been renamed (create,
    /// remove, any rename side) — a directory gets its subtree synced, since
    /// a rename or recreate reports only the directory.
    Entry,
    /// Changed in place — a watched directory is only re-synced if it can't
    /// be listed any more (a chmod that made it unreadable drops what's under
    /// it); its children report their own events. One without a watch is
    /// synced, since a chmod that makes an unreadable directory readable
    /// reports only this.
    Contents,
}

/// Whether notify events of this kind can affect the index. Access events
/// (open/read/close) are dropped before they reach the channel — the
/// filer's own scans would otherwise flood it.
pub(super) const fn is_indexable_kind(kind: EventKind) -> bool {
    !matches!(kind, EventKind::Access(_) | EventKind::Other)
}

/// Whether an event of this kind can mean a watched directory is gone from
/// its path — removed, or renamed away. Its watches are dropped (notify
/// drops its own for a removed or renamed-away child of a watched directory)
/// and whatever is at the path now is re-watched by its sync. The arrival
/// side of a rename (`To`, `Both`) names a path that's synced anyway.
pub(super) const fn may_drop_watches(kind: EventKind) -> bool {
    matches!(
        kind,
        EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(
                RenameMode::From | RenameMode::Any | RenameMode::Other
            ))
            | EventKind::Any
    )
}

/// Split a notify event into per-path hints.
///
/// Every rename side (`Name(From)`, `Name(To)`, `Name(Any)`) is an
/// [`PathHint::Entry`] hint: the disk says whether the path is now gone or
/// present, which also covers events that arrive late or out of order.
/// `Name(Both)` follows the separate `From` and `To` of the same rename
/// (every backend that reports it does), so its paths are
/// [`PathHint::Contents`] hints — resolved again, but a directory the `To`
/// already synced (and watched) isn't walked a second time.
pub(super) fn classify_event(kind: EventKind, paths: Vec<PathBuf>) -> Vec<(PathBuf, PathHint)> {
    let hint = match kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => PathHint::Contents,
        EventKind::Create(_)
        | EventKind::Remove(_)
        | EventKind::Modify(ModifyKind::Name(_))
        | EventKind::Any => PathHint::Entry,
        EventKind::Modify(_) => PathHint::Contents,
        EventKind::Access(_) | EventKind::Other => return vec![],
    };
    paths.into_iter().map(|p| (p, hint)).collect()
}

// -- Directory watches --------------------------------------------------------

/// What trying to watch a directory before listing it found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WatchAttempt {
    /// List it — it's watched, or unwatched while the filer is degraded.
    List,
    /// The directory can't be read (`EACCES`) — skipped.
    Denied,
    /// The directory is gone — skipped.
    Gone,
}

/// Creates a filer's watcher, wired to its event channel — again after an
/// overflow, when the old one's state can't be trusted. `None` when no
/// watcher can be created (e.g. inotify's `max_user_instances`).
pub(super) type WatcherFactory = Box<dyn Fn() -> Option<RecommendedWatcher> + Send>;

/// A directory's inode, `(dev, ino)` — the identity a kernel watch is on.
type DirId = (u64, u64);

/// Whether a failure to list a directory may clear up by itself (`EMFILE`,
/// `ENOMEM`, `EIO`, …) — the walk then keeps what's indexed under it and
/// retries later — rather than meaning the directory is unreadable or gone.
pub(super) fn is_transient_list_error(error: &io::Error) -> bool {
    !matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

/// The keys of `map` at or under `prefix` (a [`dir_prefix`](super::dir_prefix)).
fn keys_under<'a, V>(
    map: &'a BTreeMap<String, V>,
    prefix: &'a str,
) -> impl Iterator<Item = &'a String> {
    map.range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
        .map(|(key, _)| key)
        .take_while(move |key| key.starts_with(prefix))
}

/// A filer's per-directory watches and the bookkeeping behind its
/// [`WatchStatus`](super::WatchStatus).
///
/// Directories are keyed in [`dir_prefix`](super::dir_prefix) form. The bookkeeping errs toward
/// "not watched": re-adding a live watch is a harmless no-op in notify (the
/// mask is merged into the same watch), while believing a dead watch is live
/// would leave a directory silently stale.
///
/// Two paths can name one inode — a renamed directory whose old path hasn't
/// been dropped yet, a bind mount — and the kernel gives them one shared
/// watch, so watches are reference-counted by inode ([`DirId`]) and the
/// kernel watch is only removed with its last path.
///
/// Only the filer's event loop uses it — directly for quick bookkeeping, on a
/// blocking thread for walks and watch calls — so its lock is uncontended.
pub(super) struct DirWatches {
    make_watcher: WatcherFactory,
    /// `None` when no watcher could be created; every directory is then
    /// unwatched.
    watcher: Option<RecommendedWatcher>,
    /// The filer's root.
    source_dir: String,
    /// `FilerConfig::watch_limit`.
    watch_limit: Option<usize>,
    /// Directories with a watch, and the inode each was watched on.
    pub(super) watched: BTreeMap<String, DirId>,
    /// How many `watched` paths share each inode's kernel watch.
    watch_refs: HashMap<DirId, usize>,
    /// Directories to poll: listed without a watch (degraded mode while
    /// non-empty), or kept after a transient listing failure.
    unwatched: BTreeSet<String>,
    /// Directories skipped as unreadable, each logged once until it's
    /// readable (or gone) again.
    unreadable: BTreeSet<String>,
    /// A watch limit was hit — no more watches are tried until the next
    /// rescan, since every attempt would fail the same way.
    limit_reached: bool,
    /// Whether a root the walk can't list is kept for polling — set once the
    /// filer is running (its initial scan fails instead).
    pub(super) poll_missing_root: bool,
    /// A git root whose `.git/info/` gets a watch besides the walk's
    /// directories ([`real_info_dir`](super::ignore::real_info_dir)), for its
    /// `exclude`: a fixed watch outside the bookkeeping, added again on each
    /// new watcher, so a reset or an overflow rebuild keeps it.
    git_info_root: Option<PathBuf>,
    /// Test seam: whether that watch is in place on the current watcher.
    #[cfg(test)]
    git_info_watched: bool,
    /// `unwatched.len()`, published for [`Filer::watch_status`](super::core::Filer::watch_status) readers,
    /// which can't take the lock (a walk holds it on a blocking thread).
    pub(super) unwatched_count: Arc<AtomicUsize>,
    /// Test seam: listing this directory fails with a transient error.
    #[cfg(test)]
    fail_listing: Option<String>,
}

impl DirWatches {
    pub(super) fn new(
        make_watcher: WatcherFactory,
        source_dir: &str,
        watch_limit: Option<usize>,
    ) -> Self {
        let watcher = make_watcher();
        Self {
            make_watcher,
            watcher,
            source_dir: source_dir.to_owned(),
            watch_limit,
            watched: BTreeMap::new(),
            watch_refs: HashMap::new(),
            unwatched: BTreeSet::new(),
            unreadable: BTreeSet::new(),
            limit_reached: false,
            poll_missing_root: false,
            git_info_root: None,
            #[cfg(test)]
            git_info_watched: false,
            unwatched_count: Arc::new(AtomicUsize::new(0)),
            #[cfg(test)]
            fail_listing: None,
        }
    }

    /// Replace the watcher with a fresh one and forget every watch — after
    /// lost events, when neither this bookkeeping nor notify's own path map
    /// can be trusted (a directory renamed without its parent's report keeps
    /// its old path in notify, so re-watching the new path would reuse the
    /// watch and unwatching the old one remove it). The old watcher is
    /// dropped first, freeing its watches; the caller's walk re-adds them.
    pub(super) fn reset(&mut self) {
        self.watcher = None;
        self.watched.clear();
        self.watch_refs.clear();
        self.unwatched.clear();
        self.limit_reached = false;
        #[cfg(test)]
        {
            self.git_info_watched = false;
        }
        self.watcher = (self.make_watcher)();
        self.add_git_info_watch();
    }

    /// Watch `root`'s `.git/info/` from now on, on this watcher and every
    /// later one (see [`Self::reset`]).
    pub(super) fn watch_git_info(&mut self, root: &Path) {
        self.git_info_root = Some(root.to_path_buf());
        self.add_git_info_watch();
    }

    /// Add the `.git/info/` watch to the current watcher, when there's a
    /// root for it and it's still a real directory under a real `.git`.
    fn add_git_info_watch(&mut self) {
        let (Some(root), Some(watcher)) = (&self.git_info_root, self.watcher.as_mut()) else {
            return;
        };
        let Some(info) = super::ignore::real_info_dir(root) else {
            return;
        };
        match watcher.watch(&info, RecursiveMode::NonRecursive) {
            Ok(()) => {
                #[cfg(test)]
                {
                    self.git_info_watched = true;
                }
            }
            Err(e) => tracing::debug!(
                path = %info.display(),
                error = %fuz_sys::cli::format_error_chain(&e),
                "failed to watch a repo's info/; its exclude file takes effect at the next re-prune"
            ),
        }
    }

    #[cfg(test)]
    pub(super) const fn is_git_info_watched(&self) -> bool {
        self.git_info_watched
    }

    /// Ensure `dir` is watched before it's listed (a no-op if it already is).
    pub(super) fn attempt(&mut self, dir: &str) -> WatchAttempt {
        if self.watched.contains_key(dir) {
            return WatchAttempt::List;
        }
        let over_limit = self.limit_reached
            || self
                .watch_limit
                .is_some_and(|limit| self.watched.len() >= limit);
        let Some(watcher) = self.watcher.as_mut().filter(|_| !over_limit) else {
            self.limit_reached |= over_limit;
            self.unwatched.insert(dir.to_owned());
            return WatchAttempt::List;
        };
        // the inode the watch lands on (see the type docs)
        let id = match std::fs::symlink_metadata(prefix_dir(dir)) {
            Ok(meta) if meta.is_dir() => {
                use std::os::unix::fs::MetadataExt;
                (meta.dev(), meta.ino())
            }
            // replaced by a file or a link since it was listed
            Ok(_) => return WatchAttempt::Gone,
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return WatchAttempt::Denied,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return WatchAttempt::Gone,
            Err(_) => {
                self.unwatched.insert(dir.to_owned());
                return WatchAttempt::List;
            }
        };
        match watcher.watch(prefix_dir(dir), RecursiveMode::NonRecursive) {
            Ok(()) => {
                *self.watch_refs.entry(id).or_default() += 1;
                self.watched.insert(dir.to_owned(), id);
                self.unwatched.remove(dir);
                WatchAttempt::List
            }
            Err(e) => match &e.kind {
                notify::ErrorKind::MaxFilesWatch => {
                    self.limit_reached = true;
                    self.unwatched.insert(dir.to_owned());
                    WatchAttempt::List
                }
                notify::ErrorKind::PathNotFound => WatchAttempt::Gone,
                notify::ErrorKind::Io(io) if io.kind() == io::ErrorKind::NotFound => {
                    WatchAttempt::Gone
                }
                notify::ErrorKind::Io(io) if io.kind() == io::ErrorKind::PermissionDenied => {
                    WatchAttempt::Denied
                }
                _ => {
                    tracing::debug!(
                        path = %dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "failed to watch a directory"
                    );
                    self.unwatched.insert(dir.to_owned());
                    WatchAttempt::List
                }
            },
        }
    }

    /// List `dir` (with the test seam's injected failure).
    // `allow`, not `expect`: `self` is read only by the `#[cfg(test)]` seam,
    // so the lint fires in the lib build and not in the test build.
    #[allow(clippy::unused_self, reason = "`self` carries the test seam")]
    pub(super) fn read_dir(&self, dir: &str) -> io::Result<std::fs::ReadDir> {
        #[cfg(test)]
        if self.fail_listing.as_deref() == Some(dir) {
            return Err(io::Error::other("injected listing failure"));
        }
        std::fs::read_dir(dir)
    }

    /// Record `dir` as unreadable, logging it the first time.
    pub(super) fn note_unreadable(&mut self, dir: &str) {
        if self.unreadable.insert(dir.to_owned()) {
            tracing::warn!(path = %dir, "skipping an unreadable directory");
        }
    }

    /// After a walk of `prefix`: drop the watches and bookkeeping of every
    /// directory under it the walk didn't list (gone, unreadable, or no
    /// longer a directory), and forget unreadable ones that weren't seen
    /// unreadable again. Everything under a `kept` directory (one whose
    /// listing failed transiently) stays as it was, and the directory itself
    /// is polled until a listing succeeds.
    ///
    /// A running filer's root that the walk couldn't list (removed, made
    /// unreadable) stays unwatched instead, so degraded polling notices when
    /// it's back.
    pub(super) fn reconcile(
        &mut self,
        prefix: &str,
        listed: &BTreeSet<String>,
        unreadable: &BTreeSet<String>,
        kept: &[String],
    ) {
        let in_kept = |dir: &str| kept.iter().any(|k| dir.starts_with(k.as_str()));
        let keep_root = self.poll_missing_root
            && prefix == self.source_dir
            && !listed.contains(&self.source_dir)
            && !in_kept(&self.source_dir);
        let stale: Vec<String> = keys_under(&self.watched, prefix)
            .filter(|dir| !listed.contains(*dir) && !in_kept(dir))
            .cloned()
            .collect();
        for dir in stale {
            self.unwatch(&dir);
        }
        let source_dir = self.source_dir.clone();
        let watched = &self.watched;
        retain_under(&mut self.unwatched, prefix, |dir| {
            (listed.contains(dir) && !watched.contains_key(dir))
                || in_kept(dir)
                || (keep_root && dir == source_dir)
        });
        retain_under(&mut self.unreadable, prefix, |dir| {
            unreadable.contains(dir) || in_kept(dir)
        });
        self.unwatched.extend(kept.iter().cloned());
        if keep_root && self.unwatched.insert(source_dir) {
            tracing::warn!(path = %self.source_dir, "the watched directory can't be listed; polling it");
        }
        self.publish();
    }

    /// Whether any directory at or under `prefix` has bookkeeping.
    pub(super) fn tracks_under(&self, prefix: &str) -> bool {
        keys_under(&self.watched, prefix).next().is_some()
            || under(&self.unwatched, prefix).next().is_some()
            || under(&self.unreadable, prefix).next().is_some()
    }

    /// Drop every watch and all bookkeeping at or under `prefix` — its
    /// directory is gone, or no longer a directory. A watch notify already
    /// dropped (it does for removed and renamed-away directories) makes the
    /// unwatch a no-op error, ignored.
    pub(super) fn drop_under(&mut self, prefix: &str) {
        let dirs: Vec<String> = keys_under(&self.watched, prefix).cloned().collect();
        for dir in dirs {
            self.unwatch(&dir);
        }
        retain_under(&mut self.unwatched, prefix, |_| false);
        retain_under(&mut self.unreadable, prefix, |_| false);
        self.publish();
    }

    /// Forget `dir`'s watch, removing the kernel watch unless another watched
    /// path still shares its inode.
    fn unwatch(&mut self, dir: &str) {
        let Some(id) = self.watched.remove(dir) else {
            return;
        };
        let refs = self.watch_refs.entry(id).or_default();
        *refs = refs.saturating_sub(1);
        if *refs > 0 {
            return;
        }
        self.watch_refs.remove(&id);
        if let Some(watcher) = self.watcher.as_mut() {
            let _ = watcher.unwatch(prefix_dir(dir));
        }
    }

    pub(super) fn is_watched(&self, dir: &str) -> bool {
        self.watched.contains_key(dir)
    }

    /// Allow watch attempts again after a limit was hit (watches may have
    /// been freed since).
    pub(super) const fn retry_watches(&mut self) {
        self.limit_reached = false;
    }

    /// The topmost directories to poll — each not under another, so
    /// rescanning these covers every unwatched one once.
    pub(super) fn unwatched_roots(&self) -> Vec<String> {
        let mut roots: Vec<String> = Vec::new();
        for dir in &self.unwatched {
            if roots
                .last()
                .is_none_or(|root| !dir.starts_with(root.as_str()))
            {
                roots.push(dir.clone());
            }
        }
        roots
    }

    /// Publish the unwatched count, logging degraded-mode transitions.
    fn publish(&self) {
        let count = self.unwatched.len();
        let previous = self.unwatched_count.swap(count, Ordering::Relaxed);
        if previous == 0 && count > 0 {
            tracing::warn!(
                path = %self.source_dir,
                unwatched_dirs = count,
                "file watching degraded: some directories have no watch (the OS watch limit, \
                 inotify's max_user_watches, was reached, no watcher could be created, or a \
                 listing failed); rescanning them periodically"
            );
        } else if previous > 0 && count == 0 {
            tracing::info!(path = %self.source_dir, "file watching restored for every directory");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::core::{FilerConfig, FilerDepth};
    use crate::filer::event_loop::FilerState;
    use crate::filer::test_support::settled;
    use crate::filer::test_support::{
        TempDir, factory_into, indexed, keys_of, lock_dir, pending_of, start, state_for,
        wait_for_keys, watched_dirs,
    };
    use crate::filer::{ChangeType, DEGRADED_RESCAN_INTERVAL, WatchStatus, dir_prefix};
    use notify::event::{CreateKind, DataChange, RemoveKind};
    use parking_lot::Mutex;
    use std::time::Duration;
    use tokio::sync::oneshot;
    use tokio::time::Instant;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn classify_entry_vs_contents() {
        let entry_kinds = [
            EventKind::Create(CreateKind::File),
            EventKind::Remove(RemoveKind::File),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            EventKind::Any,
        ];
        for kind in entry_kinds {
            assert_eq!(
                classify_event(kind, vec![p("/w/a")]),
                vec![(p("/w/a"), PathHint::Entry)],
                "{kind:?}"
            );
        }
        // both sides of a rename are looked up on disk again, without
        // re-walking a directory the separate `To` already synced
        assert_eq!(
            classify_event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                vec![p("/w/old"), p("/w/new")]
            ),
            vec![
                (p("/w/old"), PathHint::Contents),
                (p("/w/new"), PathHint::Contents)
            ]
        );
        assert_eq!(
            classify_event(
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                vec![p("/w/a")]
            ),
            vec![(p("/w/a"), PathHint::Contents)]
        );
        assert!(
            classify_event(
                EventKind::Access(notify::event::AccessKind::Any),
                vec![p("/w/a")]
            )
            .is_empty()
        );
        assert!(classify_event(EventKind::Other, vec![p("/w/a")]).is_empty());
        assert!(!is_indexable_kind(EventKind::Access(
            notify::event::AccessKind::Any
        )));
        assert!(is_indexable_kind(EventKind::Create(CreateKind::Any)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreadable_subdirectory_is_skipped_and_its_siblings_watched() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("open")).unwrap();
        std::fs::create_dir_all(tmp.path("locked/inner")).unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        std::fs::write(tmp.path("open/b.txt"), "b").unwrap();
        std::fs::write(tmp.path("locked/secret.txt"), "s").unwrap();
        let Some(unlock) = lock_dir(&tmp.path("locked")) else {
            return;
        };

        let filer = start(&tmp, FilerConfig::zzz_dir()).await;
        assert_eq!(
            keys_of(&filer).await,
            vec![tmp.key("a.txt"), tmp.key("open/b.txt")]
        );
        assert_eq!(
            watched_dirs(&filer),
            vec![tmp.root(), dir_prefix(&tmp.key("open"))]
        );
        assert_eq!(filer.watch_status(), WatchStatus::Full);

        // the siblings are watched
        std::fs::write(tmp.path("open/c.txt"), "c").unwrap();
        wait_for_keys(
            &filer,
            &[
                tmp.key("a.txt"),
                tmp.key("open/b.txt"),
                tmp.key("open/c.txt"),
            ],
        )
        .await;

        // made readable, it's picked up (its parent reports the chmod)
        drop(unlock);
        wait_for_keys(
            &filer,
            &[
                tmp.key("a.txt"),
                tmp.key("locked/secret.txt"),
                tmp.key("open/b.txt"),
                tmp.key("open/c.txt"),
            ],
        )
        .await;
        assert!(watched_dirs(&filer).contains(&dir_prefix(&tmp.key("locked/inner"))));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_directory_created_after_start_is_watched_with_its_early_files() {
        let tmp = TempDir::new();
        let filer = start(&tmp, FilerConfig::zzz_dir()).await;
        assert_eq!(watched_dirs(&filer), vec![tmp.root()]);

        // files created right away, before the new directories' watches land
        std::fs::create_dir_all(tmp.path("new/deep")).unwrap();
        std::fs::write(tmp.path("new/a.txt"), "a").unwrap();
        std::fs::write(tmp.path("new/deep/b.txt"), "b").unwrap();
        wait_for_keys(&filer, &[tmp.key("new/a.txt"), tmp.key("new/deep/b.txt")]).await;
        assert_eq!(
            watched_dirs(&filer),
            vec![
                tmp.root(),
                dir_prefix(&tmp.key("new")),
                dir_prefix(&tmp.key("new/deep"))
            ]
        );

        // and later changes inside them arrive as events
        std::fs::write(tmp.path("new/deep/c.txt"), "c").unwrap();
        wait_for_keys(
            &filer,
            &[
                tmp.key("new/a.txt"),
                tmp.key("new/deep/b.txt"),
                tmp.key("new/deep/c.txt"),
            ],
        )
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn directories_renamed_in_around_and_out_move_their_watches() {
        let outside = TempDir::new();
        std::fs::create_dir_all(outside.path("d/sub")).unwrap();
        std::fs::write(outside.path("d/x.txt"), "x").unwrap();
        std::fs::write(outside.path("d/sub/y.txt"), "y").unwrap();
        let tmp = TempDir::new();
        let filer = start(&tmp, FilerConfig::zzz_dir()).await;

        // renamed in — the subtree is indexed and watched
        std::fs::rename(outside.path("d"), tmp.path("d")).unwrap();
        wait_for_keys(&filer, &[tmp.key("d/sub/y.txt"), tmp.key("d/x.txt")]).await;
        std::fs::write(tmp.path("d/sub/z.txt"), "z").unwrap();
        wait_for_keys(
            &filer,
            &[
                tmp.key("d/sub/y.txt"),
                tmp.key("d/sub/z.txt"),
                tmp.key("d/x.txt"),
            ],
        )
        .await;

        // renamed within the tree — the watches follow the new name
        std::fs::rename(tmp.path("d"), tmp.path("e")).unwrap();
        wait_for_keys(
            &filer,
            &[
                tmp.key("e/sub/y.txt"),
                tmp.key("e/sub/z.txt"),
                tmp.key("e/x.txt"),
            ],
        )
        .await;
        std::fs::write(tmp.path("e/sub/w.txt"), "w").unwrap();
        wait_for_keys(
            &filer,
            &[
                tmp.key("e/sub/w.txt"),
                tmp.key("e/sub/y.txt"),
                tmp.key("e/sub/z.txt"),
                tmp.key("e/x.txt"),
            ],
        )
        .await;
        assert_eq!(
            watched_dirs(&filer),
            vec![
                tmp.root(),
                dir_prefix(&tmp.key("e")),
                dir_prefix(&tmp.key("e/sub"))
            ]
        );

        // renamed out — its files and watches go
        std::fs::rename(tmp.path("e"), outside.path("e")).unwrap();
        wait_for_keys(&filer, &[]).await;
        assert_eq!(watched_dirs(&filer), vec![tmp.root()]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ignored_linked_and_non_utf8_directories_get_no_watches() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new();
        for dir in [
            "node_modules/pkg/lib",
            "target/debug",
            ".git/objects",
            "src/lib",
            "app/data/cache",
        ] {
            std::fs::create_dir_all(tmp.path(dir)).unwrap();
        }
        std::fs::create_dir_all(tmp.0.join(OsStr::from_bytes(b"bad\xff/inner"))).unwrap();
        symlink(tmp.path("src"), tmp.path("linked")).unwrap();
        let config = FilerConfig::tree(&tmp.root(), &dir_prefix(&tmp.key("app/data")));
        let filer = start(&tmp, config).await;

        assert_eq!(
            watched_dirs(&filer),
            vec![
                tmp.root(),
                dir_prefix(&tmp.key("app")),
                dir_prefix(&tmp.key("src")),
                dir_prefix(&tmp.key("src/lib")),
            ]
        );
        // an ignored directory created later isn't watched either
        std::fs::create_dir_all(tmp.path("src/node_modules/x")).unwrap();
        std::fs::write(tmp.path("src/lib/a.txt"), "a").unwrap();
        wait_for_keys(&filer, &[tmp.key("src/lib/a.txt")]).await;
        assert_eq!(watched_dirs(&filer).len(), 4);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_watch_limit_degrades_the_filer_and_polling_keeps_it_fresh() {
        let tmp = TempDir::new();
        for dir in ["a", "b", "c"] {
            std::fs::create_dir_all(tmp.path(dir)).unwrap();
            std::fs::write(tmp.path(&format!("{dir}/1.txt")), "1").unwrap();
        }
        let config = FilerConfig {
            watch_limit: Some(2),
            degraded_rescan_interval: Duration::from_millis(50),
            ..FilerConfig::zzz_dir()
        };
        let filer = start(&tmp, config).await;

        // the index still comes from the scan
        let initial = [tmp.key("a/1.txt"), tmp.key("b/1.txt"), tmp.key("c/1.txt")];
        assert_eq!(keys_of(&filer).await, initial);
        assert_eq!(filer.watch_status(), WatchStatus::Degraded);
        assert_eq!(watched_dirs(&filer).len(), 2);
        assert_eq!(filer.watches.lock().unwatched.len(), 2);

        // changes in every directory arrive, the unwatched ones by polling
        for dir in ["a", "b", "c"] {
            std::fs::write(tmp.path(&format!("{dir}/2.txt")), "2").unwrap();
        }
        std::fs::create_dir_all(tmp.path("c/new")).unwrap();
        std::fs::write(tmp.path("c/new/3.txt"), "3").unwrap();
        wait_for_keys(
            &filer,
            &[
                tmp.key("a/1.txt"),
                tmp.key("a/2.txt"),
                tmp.key("b/1.txt"),
                tmp.key("b/2.txt"),
                tmp.key("c/1.txt"),
                tmp.key("c/2.txt"),
                tmp.key("c/new/3.txt"),
            ],
        )
        .await;

        // with watches available again, polling re-adds them
        filer.watches.lock().watch_limit = None;
        let deadline = Instant::now() + Duration::from_secs(10);
        while filer.watch_status() == WatchStatus::Degraded {
            assert!(Instant::now() < deadline, "the filer stayed degraded");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(watched_dirs(&filer).len(), 5);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_root_that_goes_missing_is_polled_until_it_returns() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        let config = FilerConfig {
            degraded_rescan_interval: Duration::from_millis(50),
            ..FilerConfig::zzz_dir()
        };
        let filer = start(&tmp, config).await;

        std::fs::remove_dir_all(&tmp.0).unwrap();
        wait_for_keys(&filer, &[]).await;
        let deadline = Instant::now() + Duration::from_secs(10);
        while filer.watch_status() == WatchStatus::Full {
            assert!(Instant::now() < deadline, "the missing root isn't polled");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        std::fs::create_dir_all(&tmp.0).unwrap();
        std::fs::write(tmp.path("b.txt"), "b").unwrap();
        wait_for_keys(&filer, &[tmp.key("b.txt")]).await;
        assert_eq!(filer.watch_status(), WatchStatus::Full);
        assert_eq!(watched_dirs(&filer), vec![tmp.root()]);
    }

    #[test]
    fn unwatched_roots_are_the_topmost_unwatched_directories() {
        let mut watches = DirWatches::new(Box::new(|| None), "/w/", None);
        for dir in [
            "/w/a/",
            "/w/a/b/",
            "/w/a-b/",
            "/w/c/d/",
            "/w/c/d/e/",
            "/w/c/f/",
        ] {
            watches.unwatched.insert(dir.to_owned());
        }
        assert_eq!(
            watches.unwatched_roots(),
            vec!["/w/a-b/", "/w/a/", "/w/c/d/", "/w/c/f/"]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_no_watcher_the_filer_polls_and_rescans() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        std::fs::create_dir_all(tmp.path("sub")).unwrap();
        let config = FilerConfig {
            no_watcher: true,
            degraded_rescan_interval: Duration::from_millis(50),
            ..FilerConfig::zzz_dir()
        };
        let filer = start(&tmp, config).await;
        assert_eq!(filer.watch_status(), WatchStatus::Degraded);
        assert!(watched_dirs(&filer).is_empty());

        // polling keeps the index fresh
        std::fs::write(tmp.path("sub/b.txt"), "b").unwrap();
        wait_for_keys(&filer, &[tmp.key("a.txt"), tmp.key("sub/b.txt")]).await;

        // and a requested rescan (`session_load`) is answered
        std::fs::write(tmp.path("c.txt"), "c").unwrap();
        let (reply_tx, reply_rx) = oneshot::channel();
        filer.rescan_tx.send(reply_tx).await.expect("the loop runs");
        tokio::time::timeout(Duration::from_secs(10), reply_rx)
            .await
            .expect("the rescan is answered")
            .unwrap();
        assert!(keys_of(&filer).await.contains(&tmp.key("c.txt")));
        assert!(!filer.task.is_finished());
    }

    /// A watched directory renamed while its parent's report of it is lost
    /// (here: the root isn't watched, standing in for an inotify overflow)
    /// keeps working after the rescan — the new path shares the old path's
    /// kernel watch, which dropping the old path must not remove.
    async fn check_rename_behind_the_watchers_back(reset_watches: bool) {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("d/sub")).unwrap();
        let root = tmp.root();
        let seen: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let watches = Arc::new(Mutex::new(DirWatches::new(
            factory_into(Arc::clone(&seen)),
            &root,
            None,
        )));
        {
            let mut watches = watches.lock();
            for dir in ["d", "d/sub"] {
                assert_eq!(
                    watches.attempt(&dir_prefix(&tmp.key(dir))),
                    WatchAttempt::List
                );
            }
        }
        std::fs::rename(tmp.path("d"), tmp.path("e")).unwrap();
        watches.lock().poll_missing_root = true;
        let unwatched_count = Arc::clone(&watches.lock().unwatched_count);
        let mut state = FilerState {
            source_dir: root.clone(),
            ignored_dirs: vec![],
            rule: crate::filer::ignore::SharedRule::new(
                crate::filer::ignore::IgnoreRule::FixedNames,
            ),
            git: None,
            reprune: None,
            vetted: HashMap::new(),
            depth: FilerDepth::Tree,
            files: Arc::default(),
            pending: HashMap::new(),
            watches: Arc::clone(&watches),
            unwatched_count,
            degraded_rescan_interval: DEGRADED_RESCAN_INTERVAL,
            clock: settled,
        };
        state.rescan(reset_watches).await;
        assert_eq!(
            watches.lock().watched.keys().cloned().collect::<Vec<_>>(),
            vec![
                root,
                dir_prefix(&tmp.key("e")),
                dir_prefix(&tmp.key("e/sub"))
            ]
        );

        tokio::time::sleep(Duration::from_millis(50)).await;
        seen.lock().clear();
        let written = [
            tmp.path("e/new.txt"),
            tmp.path("e/sub/new.txt"),
            tmp.path("top.txt"),
        ];
        for path in &written {
            std::fs::write(path, "x").unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let seen = seen.lock().clone();
            if written.iter().all(|path| seen.contains(path)) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "reset {reset_watches}: missing events, saw {seen:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_overflow_rescan_rebuilds_the_watches_of_a_renamed_directory() {
        check_rename_behind_the_watchers_back(true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_rescan_keeps_the_shared_watch_of_a_renamed_directory() {
        check_rename_behind_the_watchers_back(false).await;
    }

    #[tokio::test]
    async fn a_transient_listing_failure_keeps_the_index_and_polls() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("a")).unwrap();
        std::fs::create_dir_all(tmp.path("b")).unwrap();
        std::fs::write(tmp.path("a/f.txt"), "f").unwrap();
        std::fs::write(tmp.path("b/g.txt"), "g").unwrap();
        let mut state = state_for(&tmp).await;
        let all = vec![tmp.key("a/f.txt"), tmp.key("b/g.txt")];

        // a subdirectory's listing fails (EMFILE, EIO, …)
        let a = dir_prefix(&tmp.key("a"));
        state.watches.lock().fail_listing = Some(a.clone());
        state.rescan(false).await;
        assert!(state.pending.is_empty(), "{:?}", pending_of(&state));
        assert_eq!(indexed(&state).await, all);
        assert!(state.is_degraded());
        assert!(state.watches.lock().is_watched(&a));

        // the root's listing fails
        state.watches.lock().fail_listing = Some(tmp.root());
        state.rescan(false).await;
        assert!(state.pending.is_empty(), "{:?}", pending_of(&state));
        assert_eq!(indexed(&state).await, all);

        // polling retries them once listings work again
        state.watches.lock().fail_listing = None;
        std::fs::write(tmp.path("a/h.txt"), "h").unwrap();
        state.rescan_unwatched().await;
        assert!(!state.is_degraded());
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("a/h.txt"), ChangeType::Add)]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_watched_directory_made_unreadable_drops_its_files() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("d/inner")).unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        std::fs::write(tmp.path("d/secret.txt"), "s").unwrap();
        let filer = start(&tmp, FilerConfig::zzz_dir()).await;
        let everything = [tmp.key("a.txt"), tmp.key("d/secret.txt")];
        assert_eq!(keys_of(&filer).await, everything);

        let Some(unlock) = lock_dir(&tmp.path("d")) else {
            return;
        };
        wait_for_keys(&filer, &[tmp.key("a.txt")]).await;
        assert_eq!(watched_dirs(&filer), vec![tmp.root()]);

        drop(unlock);
        wait_for_keys(&filer, &everything).await;
        assert_eq!(watched_dirs(&filer).len(), 3);
    }
}
