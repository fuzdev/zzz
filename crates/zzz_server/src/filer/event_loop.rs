//! A filer's event loop: its state, the debounced notifications, and the flush.

use super::core::{FilerBroadcast, FilerDepth, RescanSignal};
use super::index::{
    FileIndex, FileStat, ScanIndex, ScannedFile, apply_subtree, deleted_disknode, is_unchanged,
    stat_disknode,
};
use super::walk::{is_ignored, scan_directory};
use super::watches::{
    DirWatches, PathHint, classify_event, is_transient_list_error, may_drop_watches,
};
use super::{
    ChangeType, Clock, DEGRADED_RESCAN_COST_FACTOR, DiskfileChange, FilerChangeParams,
    SerializableDisknode, dir_prefix,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};
use tokio::sync::{RwLock, mpsc, oneshot};
use tokio::time::Instant;

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

// -- Event loop ---------------------------------------------------------------

/// State owned by a filer's event-loop task: the index (shared for reads),
/// the directory watches, and the pending debounced broadcasts.
pub(super) struct FilerState {
    pub(super) source_dir: String,
    pub(super) ignored_dirs: Vec<PathBuf>,
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
        for (path, hint) in classify_event(event.kind, event.paths) {
            if is_ignored(&path, Path::new(&self.source_dir), &self.ignored_dirs) {
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
                    self.sync_subtree(&path_str, false).await;
                }
            }
            // the root itself is gone: its failing sync empties the index
            // and keeps the root polled until it's back
            _ if dir_prefix(&path_str) == self.source_dir => {
                self.sync_subtree(&path_str, false).await;
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

    /// Remove every index entry under `path/`, and the watches there — the
    /// path is no longer a directory.
    async fn remove_children(&mut self, path: &str) {
        self.unwatch_tree(path).await;
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
    async fn sync_subtree(&mut self, dir: &str, reset_watches: bool) {
        let prefix = dir_prefix(dir);
        let scanned = scan_directory(
            &prefix,
            &self.source_dir,
            &self.ignored_dirs,
            self.depth,
            &self.watches,
            reset_watches,
            self.clock,
            Some(&*self.files),
        )
        .await;
        let (mut fresh, kept) = match scanned {
            Ok(scanned) => scanned,
            Err(e) if is_transient_list_error(&e) => return,
            Err(_) => (ScanIndex::new(), vec![]),
        };
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
        for (path, change, node) in changes {
            self.queue(path, change, node);
        }
    }

    /// Reconcile the whole index with the disk. `reset_watches` rebuilds
    /// every watch on a fresh watcher ([`DirWatches::reset`]) — after lost
    /// events, when the watch state can't be trusted.
    pub(super) async fn rescan(&mut self, reset_watches: bool) {
        self.watches.lock().retry_watches();
        let root = self.source_dir.clone();
        self.sync_subtree(&root, reset_watches).await;
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
            self.sync_subtree(&root, false).await;
        }
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

/// Background event loop: receives notify events and rescan requests,
/// updates the index, polls unwatched directories while degraded, and
/// broadcasts debounced `filer_change` notifications.
pub(super) async fn filer_event_loop(
    mut state: FilerState,
    mut rx: mpsc::Receiver<notify::Event>,
    mut rescan_rx: mpsc::Receiver<oneshot::Sender<()>>,
    signal: Arc<RescanSignal>,
    broadcast: FilerBroadcast,
) {
    // next degraded-mode rescan, while degraded
    let mut poll_at: Option<Instant> = None;
    loop {
        if !state.is_degraded() {
            poll_at = None;
        } else if poll_at.is_none() {
            poll_at = Some(Instant::now() + state.degraded_rescan_interval);
        }
        let next_deadline = state.next_deadline();
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
                state.rescan(false).await;
                for reply in replies {
                    let _ = reply.send(());
                }
            }
            // The watcher factory holds a sender, so the channel never closes
            // — not even while there's no watcher, when degraded polling and
            // rescans still run here.
            Some(event) = rx.recv() => {
                state.handle_event(event).await;
            }
            // Below `rx` so an overflow rescan runs once the backlog drains.
            () = signal.notify.notified() => {
                if signal.take() {
                    tracing::debug!(path = %state.source_dir, "file watcher overflowed, rescanning");
                    // events were lost, so the watch state may be stale too
                    state.rescan(true).await;
                }
            }
            () = tokio::time::sleep_until(poll_at.unwrap_or_else(Instant::now)),
                if poll_at.is_some() => {
                let started = Instant::now();
                state.rescan_unwatched().await;
                let wait = state
                    .degraded_rescan_interval
                    .max(started.elapsed() * DEGRADED_RESCAN_COST_FACTOR);
                poll_at = Some(Instant::now() + wait);
            }
            () = tokio::time::sleep_until(next_deadline.unwrap_or_else(Instant::now)),
                if next_deadline.is_some() => {}
        }

        flush_ready(&mut state, Instant::now(), &broadcast).await;
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
                notification_params(change_type, node("/w/f", 4, 2.0)),
                serde_json::json!({
                    "change": { "type": wire, "path": "/w/f" },
                    "disknode": {
                        "id": "/w/f",
                        "source_dir": "/w/",
                        "size": 4,
                        "ctime": null,
                        "mtime": 2.0,
                    },
                }),
                "{change_type:?}"
            );
        }
        // a delete's node is identity only
        assert_eq!(
            notification_params(ChangeType::Delete, deleted_disknode(node("/w/f", 4, 2.0))),
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
        assert_eq!(metadata(&frames[0]), (3.into(), 2_000_000.0.into()));
        assert_eq!(state.files.read().await[&key].mtime, Some(2_000_000.0));

        // rewritten with the same bytes: also a change
        std::fs::write(&path, "one").unwrap();
        set_mtime(&path, 3000);
        let frames = modified(&mut state, &path).await;
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(metadata(&frames[0]), (3.into(), 3_000_000.0.into()));

        // changed: the same shape
        std::fs::write(&path, "three").unwrap();
        set_mtime(&path, 4000);
        let frames = modified(&mut state, &path).await;
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(metadata(&frames[0]), (5.into(), 4_000_000.0.into()));

        // nothing moved, and the stamp is trusted: no broadcast
        assert!(modified(&mut state, &path).await.is_empty());

        // first sighting: an add, metadata only
        let new_path = tmp.path("new.txt");
        std::fs::write(&new_path, "new").unwrap();
        set_mtime(&new_path, 1000);
        let frames = modified(&mut state, &new_path).await;
        assert_eq!(frames[0]["change"]["type"], "add");
        assert_eq!(metadata(&frames[0]), (3.into(), 1_000_000.0.into()));
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
        assert_eq!(frames[0]["disknode"]["mtime"], 3_000_000.0);

        // touched twice: one change, with the latest timestamp
        set_mtime(&path, 4000);
        state.handle_event(modify(&path)).await;
        set_mtime(&path, 5000);
        state.handle_event(modify(&path)).await;
        let frames = flushed(&mut state).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["change"]["type"], "change");
        assert_eq!(frames[0]["disknode"]["mtime"], 5_000_000.0);

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
        assert_eq!(frames[0]["disknode"]["mtime"], 2_000_000.0);
    }

    #[tokio::test]
    async fn staged_write_temp_files_are_ignored() {
        let tmp = TempDir::new();
        let temp_name = format!("{}abc", crate::scoped_fs::TEMP_FILE_PREFIX);
        std::fs::write(tmp.path(&temp_name), "staged").unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        let mut state = state_for(&tmp).await;
        assert_eq!(indexed(&state).await, vec![tmp.key("a.txt")]);

        assert!(is_ignored(&tmp.path(&temp_name), &tmp.0, &[]));
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
        assert!(is_ignored(&tmp.path("node_modules/x/y.js"), &tmp.0, &[]));
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
        state.queue(tmp.key("x"), ChangeType::Add, node(&tmp.key("x"), 1, 1.0));
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
            state.queue_at(now, key.clone(), ChangeType::Add, node(&key, 1, 1.0));
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
            state.queue_at(now, key.clone(), ChangeType::Change, node(&key, size, 1.0));
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
            state.queue_at(t, key.clone(), ChangeType::Change, node(&key, 1, 1.0));
            assert!(state.take_ready(t).is_empty(), "not ready at {:?}", t - t0);
            t += Duration::from_millis(50);
        }
        let ready = state.take_ready(t0 + DEBOUNCE_MAX_WAIT);
        assert_eq!(ready.len(), 1, "flushed by the max wait");
        // the next run starts fresh
        let t1 = t0 + DEBOUNCE_MAX_WAIT;
        state.queue_at(t1, key.clone(), ChangeType::Change, node(&key, 1, 2.0));
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
            .insert(tmp.key("x"), node(&tmp.key("x"), 5, 1.0));
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
        state.files.write().await.get_mut(&key).unwrap().mtime = Some(-1.0);
        state.rescan(false).await;
        assert!(state.pending.is_empty());
        assert_eq!(state.files.read().await[&key].mtime, Some(-1.0));

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
}
