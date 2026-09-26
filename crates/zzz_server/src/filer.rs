//! File index + watcher: one [`Filer`] per watched directory, managed by
//! [`FilerManager`].
//!
//! Each filer keeps an in-memory index (path → [`SerializableDisknode`]) and
//! broadcasts debounced `filer_change` notifications. After the initial scan,
//! all index mutation happens on the filer's own event-loop task, and every
//! mutation queues the matching broadcast — so the broadcast stream converges
//! on the index (readers of the index can be up to one debounce window ahead
//! of it):
//!
//! - **Level-triggered events.** A notify event is only a hint about which
//!   path to look at ([`classify_event`]); the filer then `lstat`s the path
//!   and decides from what is on disk — even for removes and rename-froms,
//!   since events can arrive late or out of order (a backlog behind
//!   `rm -rf src && git checkout src`, or macOS `FSEvents` reporting create before
//!   remove). `add` vs `change` comes from whether the path was already
//!   indexed, not from the event kind, so renames and short-lived files
//!   resolve to the right broadcast. A directory that appears (created,
//!   renamed in, or recreated) has its subtree synced; a path that is gone
//!   takes every indexed file under it along.
//! - **Debounce coalescing.** Broadcasts are debounced per path
//!   ([`coalesce_change`]): a `delete` followed by an `add` inside the window
//!   becomes `change`, and an `add` followed by a `delete` becomes a bare
//!   `delete` (a no-op for clients that never saw the add). A path that
//!   keeps changing still broadcasts at least every [`DEBOUNCE_MAX_WAIT`].
//! - **Overflow recovery.** Paths under ignored directories are filtered in
//!   the notify callback, before the bounded channel. If the channel is
//!   still full, or notify reports a rescan (inotify queue overflow), the
//!   filer schedules one coalesced rescan of its root, which diffs the index
//!   against the disk and broadcasts the differences.
//! - **Symlinks are skipped entirely** — consistent with `ScopedFs`'s
//!   no-symlink rule. The walker never follows or indexes a symlink (file or
//!   directory), notify is configured not to follow them when adding
//!   recursive watches, and an event whose path is a symlink resolves as
//!   "not indexable". This keeps link loops (`up -> ..`, a Wine prefix's
//!   `dosdevices/z: -> /`) from hanging the scan, and keeps files outside
//!   the watched root out of the index.

use std::collections::{BTreeMap, HashMap};
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{Stream, StreamExt, stream};
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Notify, RwLock, mpsc, oneshot};
use tokio::time::Instant;

use crate::handlers::App;

// -- Indexing limits ----------------------------------------------------------

/// Max bytes of file content held in the in-memory index. Anything above
/// this skips the read and stores `contents: None`. Protects RSS
/// against lockfiles, generated artifacts, or large binaries that the
/// watcher otherwise would happily pull into memory.
///
/// TODO @parity: align with `fuz_app`'s equivalent cap when it lands.
const MAX_INDEXED_FILE_SIZE: u64 = 4 * 1024 * 1024;

/// Cap on concurrent file reads during a directory scan.
/// File reads block on disk + utf-8 validation; without a cap a large
/// tree would unbound the in-flight set and exhaust fd budgets on small
/// workstations.
const MAX_CONCURRENT_FILE_READS: usize = 32;

/// Capacity of the notify → event-loop channel. Ignored paths are filtered
/// before the send, so this only has to absorb bursts in indexed paths; on
/// overflow the filer falls back to a coalesced rescan of its root.
const EVENT_CHANNEL_CAPACITY: usize = 1024;

// -- Notification params ------------------------------------------------------

/// Params for `filer_change` `remote_notification`.
///
/// Matches the TypeScript `filer_change_action_spec` input schema:
/// `{ change: DiskfileChange, disknode: SerializableDisknode }`.
#[derive(Serialize)]
struct FilerChangeParams {
    change: DiskfileChange,
    disknode: SerializableDisknode,
}

/// Matches `DiskfileChange` from `diskfile_types.ts`.
#[derive(Serialize, Clone)]
struct DiskfileChange {
    #[serde(rename = "type")]
    change_type: ChangeType,
    path: String,
}

/// Matches `DiskfileChangeType` from `diskfile_types.ts`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ChangeType {
    Add,
    Change,
    Delete,
}

/// Matches `SerializableDisknode` from `diskfile_types.ts`.
///
/// Simplified — `dependents` and `dependencies` are always empty (no
/// dependency tracking in the Rust backend).
#[derive(Serialize, Clone, Debug)]
pub struct SerializableDisknode {
    pub id: String,
    pub source_dir: String,
    pub contents: Option<String>,
    pub ctime: Option<f64>,
    pub mtime: Option<f64>,
    pub dependents: Vec<Value>,
    pub dependencies: Vec<Value>,
}

/// A filer's in-memory index, keyed by absolute file path. Ordered so a
/// directory's files are one contiguous prefix range.
type FileIndex = BTreeMap<String, SerializableDisknode>;

// -- Default ignored directories ----------------------------------------------

/// Directory names ignored by all watchers, wherever they appear. Individual
/// filers can ignore specific directories by full path on top of these via
/// `FilerConfig`.
///
/// `.zzz` is zzz's conventional app-dir and CLI daemon-home name — the daemon
/// home (`~/.zzz/`) holds `.env`, `bootstrap_token`, and `run/`, which must
/// never be indexed or broadcast from a workspace like `~`.
const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".svelte-kit",
    "target",
    "dist",
    ".zzz",
];

/// Check if a single path component is ignored by every watcher: a name in
/// the default directory ignore list, or a `ScopedFs::write_file` staging
/// file (only the rename that publishes a write is indexed and broadcast).
fn is_ignored_name(name: &str) -> bool {
    DEFAULT_IGNORED_DIRS.contains(&name) || crate::scoped_fs::is_temp_file_name(name)
}

/// Check if a path is ignored: not valid UTF-8, a default-ignored name among
/// its components below `source_dir`, or at/under one of `ignored_dirs`.
///
/// Non-UTF-8 paths are skipped entirely rather than indexed under a lossy
/// (U+FFFD) key no client could address. A path is non-UTF-8 when any
/// component is, so everything under a non-UTF-8 directory is skipped too —
/// the walker never descends into one (see [`walk_files`]).
///
/// Only checks names after the `source_dir` prefix — root path segments
/// like `/`, `home`, `user` can never match ignored names and are skipped.
/// `ignored_dirs` match by whole components (`Path::starts_with`), so
/// `/w/data` doesn't cover `/w/data2`.
fn is_ignored(path: &Path, source_dir: &Path, ignored_dirs: &[PathBuf]) -> bool {
    if path.to_str().is_none() || ignored_dirs.iter().any(|dir| path.starts_with(dir)) {
        return true;
    }
    let suffix = path.strip_prefix(source_dir).unwrap_or(path);
    suffix
        .components()
        .any(|c| is_ignored_name(c.as_os_str().to_str().unwrap_or("")))
}

/// `dir` with exactly one trailing slash — the index-key prefix of
/// everything under it.
fn dir_prefix(dir: &str) -> String {
    let mut prefix = dir.trim_end_matches('/').to_owned();
    prefix.push('/');
    prefix
}

// -- File metadata helpers ----------------------------------------------------

/// Convert a `SystemTime` to milliseconds since epoch (matching JS `Date` format).
fn system_time_to_ms(t: std::time::SystemTime) -> Option<f64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64() * 1000.0)
}

/// Construct a `SerializableDisknode` from pre-read components.
fn make_disknode(
    id: String,
    source_dir: &str,
    contents: Option<String>,
    ctime: Option<f64>,
    mtime: Option<f64>,
) -> SerializableDisknode {
    SerializableDisknode {
        id,
        source_dir: source_dir.to_owned(),
        contents,
        ctime,
        mtime,
        dependents: vec![],
        dependencies: vec![],
    }
}

/// The disknode broadcast with a `delete` — identity only, no contents.
fn deleted_disknode(node: SerializableDisknode) -> SerializableDisknode {
    make_disknode(node.id, &node.source_dir, None, None, None)
}

/// Read a file's contents for the index, or `None` if it's not an indexable
/// UTF-8 regular file of at most [`MAX_INDEXED_FILE_SIZE`] bytes.
///
/// The path was `lstat`ed before this is called, but it can be swapped in
/// between, so the open itself refuses to follow a symlink (`O_NOFOLLOW`) or
/// block on a FIFO (`O_NONBLOCK`), the opened handle is re-checked to be a
/// regular file, and the read is bounded regardless of the earlier size.
async fn read_indexable_contents(path: PathBuf) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;

        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&path)
            .ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_INDEXED_FILE_SIZE + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_INDEXED_FILE_SIZE {
            return None;
        }
        String::from_utf8(bytes).ok()
    })
    .await
    .ok()
    .flatten()
}

/// Read a regular file's disknode given its (non-following) metadata.
///
/// Honours [`MAX_INDEXED_FILE_SIZE`]: oversized files keep their metadata
/// but store `contents: None`. Unreadable or non-UTF-8 files also store
/// `contents: None`.
async fn read_disknode(
    path: &Path,
    path_str: String,
    source_dir: &str,
    meta: &std::fs::Metadata,
) -> SerializableDisknode {
    let ctime = meta.created().ok().and_then(system_time_to_ms);
    let mtime = meta.modified().ok().and_then(system_time_to_ms);
    let contents = if meta.len() > MAX_INDEXED_FILE_SIZE {
        None
    } else {
        read_indexable_contents(path.to_path_buf()).await
    };
    make_disknode(path_str, source_dir, contents, ctime, mtime)
}

/// Whether two disknodes for the same path differ in a way clients care
/// about (contents or timestamps).
fn disknode_changed(a: &SerializableDisknode, b: &SerializableDisknode) -> bool {
    a.contents != b.contents
        || a.mtime.map(f64::to_bits) != b.mtime.map(f64::to_bits)
        || a.ctime.map(f64::to_bits) != b.ctime.map(f64::to_bits)
}

// -- Event classification -----------------------------------------------------

/// What a notify event says about one path — a hint about where to look,
/// resolved against the disk by [`FilerState::apply_hint`].
///
/// Either way `lstat` decides: a regular file is upserted, anything else
/// (missing, a symlink, a special file) removes the path and everything
/// indexed under it. The hints differ only for directories.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathHint {
    /// The entry itself may have appeared, vanished, or been renamed (create,
    /// remove, any rename side) — a directory gets its subtree synced, since
    /// a rename or recreate reports only the directory.
    Entry,
    /// Changed in place — a directory is ignored (its children report their
    /// own events).
    Contents,
}

/// Whether notify events of this kind can affect the index. Access events
/// (open/read/close) are dropped before they reach the channel — the
/// filer's own scans would otherwise flood it.
const fn is_indexable_kind(kind: EventKind) -> bool {
    !matches!(kind, EventKind::Access(_) | EventKind::Other)
}

/// Split a notify event into per-path hints.
///
/// Every rename side (`Name(From)`, `Name(To)`, both paths of `Name(Both)`,
/// `Name(Any)`) is an [`PathHint::Entry`] hint: the disk says whether the
/// path is now gone or present, which also covers events that arrive late or
/// out of order.
fn classify_event(kind: EventKind, paths: Vec<PathBuf>) -> Vec<(PathBuf, PathHint)> {
    let hint = match kind {
        EventKind::Create(_)
        | EventKind::Remove(_)
        | EventKind::Modify(ModifyKind::Name(_))
        | EventKind::Any => PathHint::Entry,
        EventKind::Modify(_) => PathHint::Contents,
        EventKind::Access(_) | EventKind::Other => return vec![],
    };
    paths.into_iter().map(|p| (p, hint)).collect()
}

// -- Debouncing ---------------------------------------------------------------

/// Quiet period after a path's last change before its broadcast fires.
const DEBOUNCE_DURATION: Duration = Duration::from_millis(80);

/// Longest a pending broadcast waits after its first queued change, so a
/// path written more often than every [`DEBOUNCE_DURATION`] still broadcasts.
const DEBOUNCE_MAX_WAIT: Duration = Duration::from_millis(500);

/// A pending debounced notification (broadcast only — index updates are immediate).
struct PendingNotification {
    change_type: ChangeType,
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
/// not nothing: `session_load` / `workspace_open` read the index directly, so
/// a client may already hold a path whose `add` broadcast is still pending,
/// and a `delete` for a path a client never saw is a no-op for it. Otherwise
/// the latest wins.
const fn coalesce_change(prev: Option<ChangeType>, next: ChangeType) -> ChangeType {
    match (prev, next) {
        (None, next) => next,
        (Some(ChangeType::Add), ChangeType::Add | ChangeType::Change) => ChangeType::Add,
        (Some(ChangeType::Change | ChangeType::Delete), ChangeType::Add | ChangeType::Change) => {
            ChangeType::Change
        }
        (Some(_), ChangeType::Delete) => ChangeType::Delete,
    }
}

/// Replace the index entries under `prefix` with `fresh` (a walk of that
/// subtree), returning the resulting changes. Unchanged entries produce
/// nothing.
///
/// @mutates index - entries under `prefix` are inserted, replaced, or removed to match `fresh`
fn apply_subtree(
    index: &mut FileIndex,
    prefix: &str,
    mut fresh: FileIndex,
) -> Vec<(String, ChangeType, SerializableDisknode)> {
    let mut changes = Vec::new();
    let old_keys: Vec<String> = index
        .range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
        .take_while(|(k, _)| k.starts_with(prefix))
        .map(|(k, _)| k.clone())
        .collect();
    for key in old_keys {
        match fresh.remove(&key) {
            Some(node) => {
                if index
                    .get(&key)
                    .is_some_and(|old| disknode_changed(old, &node))
                {
                    index.insert(key.clone(), node.clone());
                    changes.push((key, ChangeType::Change, node));
                }
            }
            None => {
                if let Some(node) = index.remove(&key) {
                    changes.push((key, ChangeType::Delete, deleted_disknode(node)));
                }
            }
        }
    }
    for (key, node) in fresh {
        index.insert(key.clone(), node.clone());
        changes.push((key, ChangeType::Add, node));
    }
    changes
}

// -- Filer configuration ------------------------------------------------------

/// Per-filer configuration controlling which directories to ignore.
pub struct FilerConfig {
    /// Absolute directories to ignore beyond the default names. For a
    /// workspace watcher whose root contains `zzz_dir`, this is `zzz_dir`
    /// (which has its own watcher); otherwise empty.
    pub ignored_dirs: Vec<PathBuf>,
}

impl FilerConfig {
    /// Config for the `zzz_dir` watcher — no extra ignores, since it needs
    /// to see files inside the zzz directory. (Default names still apply
    /// below its root, so a `.zzz/` nested inside the app dir is skipped.)
    pub const fn zzz_dir() -> Self {
        Self {
            ignored_dirs: vec![],
        }
    }

    /// Config for a workspace or `scoped_dir` watcher on `root` — ignores
    /// `zzz_dir` by its full path when it sits strictly inside `root`, so its
    /// files aren't indexed and broadcast twice. A custom-named app dir is
    /// matched by path, not name, so same-named directories elsewhere (an app
    /// dir named `data` vs a workspace's own `data/`) stay visible; `.zzz`
    /// directories are ignored everywhere by `DEFAULT_IGNORED_DIRS`.
    ///
    /// Both paths are expected in their canonical form (as `resolve_dir` and
    /// `workspace_open` produce); a trailing `/` is ignored.
    pub fn workspace(root: &str, zzz_dir: &str) -> Self {
        let root = Path::new(root);
        let zzz_dir = Path::new(zzz_dir);
        let nested = zzz_dir.starts_with(root) && zzz_dir != root;
        Self {
            ignored_dirs: if nested {
                vec![zzz_dir.to_path_buf()]
            } else {
                vec![]
            },
        }
    }
}

// -- Filer --------------------------------------------------------------------

/// Coalesced "rescan the root" request, raised from the notify callback
/// (sync context) when events were dropped or notify asks for a rescan.
#[derive(Default)]
struct RescanSignal {
    needed: AtomicBool,
    notify: Notify,
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
    fn take(&self) -> bool {
        self.needed.swap(false, Ordering::AcqRel)
    }
}

/// Watches a directory for file changes, maintains an in-memory file index,
/// and broadcasts `filer_change` notifications to WebSocket clients.
///
/// Dropped when the filer is stopped (notify cleans up on Drop,
/// the tokio task is aborted).
pub struct Filer {
    /// Held to keep the notify watcher alive — dropped when the filer stops.
    _watcher: RecommendedWatcher,
    /// Background task processing watcher events.
    task: tokio::task::JoinHandle<()>,
    /// In-memory file index. Written only by the event-loop task (initial
    /// scan aside); read by `session_load` / `workspace_open`.
    files: Arc<RwLock<FileIndex>>,
    /// Requests a full rescan on the event loop; the reply fires once the
    /// index matches the disk.
    rescan_tx: mpsc::Sender<oneshot::Sender<()>>,
}

impl Drop for Filer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Start watching a directory, perform an initial file scan, and return a `Filer`.
///
/// The initial scan populates the file index before returning, so callers
/// can immediately read it. The background task then keeps the index
/// updated and broadcasts changes.
pub async fn start_filer(
    path: &str,
    app: Arc<App>,
    config: FilerConfig,
) -> Result<Filer, notify::Error> {
    let (tx, rx) = mpsc::channel::<notify::Event>(EVENT_CHANNEL_CAPACITY);
    let signal = Arc::new(RescanSignal::default());

    let watcher_root = PathBuf::from(path);
    let watcher_ignores = config.ignored_dirs.clone();
    let watcher_signal = Arc::clone(&signal);
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            let mut event = match res {
                Ok(event) => event,
                Err(e) => {
                    tracing::warn!(error = %e, "file watcher error");
                    return;
                }
            };
            if event.need_rescan() {
                watcher_signal.request();
                return;
            }
            if !is_indexable_kind(event.kind) {
                return;
            }
            // Filter before the bounded channel so `target/` or
            // `node_modules/` churn can't crowd out real edits.
            event
                .paths
                .retain(|p| !is_ignored(p, &watcher_root, &watcher_ignores));
            if event.paths.is_empty() {
                return;
            }
            if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(event) {
                watcher_signal.request();
            }
        },
        // Never add watches through symlinked directories (see module docs).
        notify::Config::default().with_follow_symlinks(false),
    )?;

    watcher.watch(Path::new(path), RecursiveMode::Recursive)?;

    let source_dir = path.to_owned();

    // Initial scan — populate the file index (no broadcast; callers read it)
    let mut initial_files = FileIndex::new();
    scan_directory(
        &source_dir,
        &source_dir,
        &config.ignored_dirs,
        &mut initial_files,
    )
    .await;
    let files = Arc::new(RwLock::new(initial_files));

    let (rescan_tx, rescan_rx) = mpsc::channel(64);
    let state = FilerState {
        source_dir,
        ignored_dirs: config.ignored_dirs,
        files: Arc::clone(&files),
        pending: HashMap::new(),
    };
    let task = tokio::spawn(filer_event_loop(state, rx, rescan_rx, signal, app));

    Ok(Filer {
        _watcher: watcher,
        task,
        files,
        rescan_tx,
    })
}

/// One file discovered by the walk phase — input to the read phase.
struct FileJob {
    path: PathBuf,
    path_str: String,
    ctime: Option<f64>,
    mtime: Option<f64>,
    size: u64,
}

/// In-progress directory walk state for [`walk_files`].
///
/// `current` holds the open readdir handle for the directory currently
/// being drained; `dir_stack` holds the not-yet-visited directories.
/// Subdirectories discovered while draining `current` are pushed onto
/// the stack so traversal stays depth-first.
struct WalkState {
    dir_stack: Vec<String>,
    current: Option<tokio::fs::ReadDir>,
    ignored_dirs: Vec<PathBuf>,
}

/// Stream of file jobs discovered by walking `root` recursively.
///
/// Staging files of `ScopedFs::write_file` are never yielded; orphaned ones
/// are deleted along the way (see [`sweep_orphaned_temp_file`]).
///
/// Only regular files are yielded and only real directories are descended
/// into — entry types come from `DirEntry::file_type`, which does not follow
/// symlinks, so symlinks (and link loops) are skipped entirely, as are
/// FIFOs, sockets, and devices (reading a FIFO would block the scan).
///
/// Streaming (vs. pre-collecting into `Vec<FileJob>`) keeps peak memory
/// flat in tree size: only the active readdir handle + dir-stack +
/// in-flight `buffer_unordered` futures are resident at any moment.
///
/// Implementation uses `stream::unfold` rather than spawning a producer
/// task — no `mpsc` channel, no extra `tokio::spawn`, and the walker
/// runs on the same task as the consumer so cancellation propagates
/// naturally when the consumer drops the stream.
fn walk_files(root: String, ignored_dirs: Vec<PathBuf>) -> impl Stream<Item = FileJob> {
    let state = WalkState {
        dir_stack: vec![root],
        current: None,
        ignored_dirs,
    };
    stream::unfold(state, |mut state| async move {
        loop {
            // Ensure a current readdir handle. Pop dirs off the stack
            // until one opens successfully or the stack is empty.
            while state.current.is_none() {
                let dir = state.dir_stack.pop()?;
                state.current = tokio::fs::read_dir(&dir).await.ok();
            }

            // Pull the next entry. Scope the &mut borrow so we can
            // mutate `state.dir_stack` on the dir-discovery branch.
            let entry_result = match state.current.as_mut() {
                Some(entries) => entries.next_entry().await,
                None => continue,
            };

            match entry_result {
                Ok(Some(entry)) => {
                    let path = entry.path();
                    // a non-UTF-8 name (file or directory — so its whole
                    // subtree) is skipped, like an ignored one
                    let Some(path_str) = path.to_str().map(str::to_owned) else {
                        continue;
                    };
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if crate::scoped_fs::is_temp_file_name(name) {
                        if crate::scoped_fs::is_staged_write_file_name(name) {
                            sweep_orphaned_temp_file(&entry).await;
                        }
                        continue;
                    }
                    if path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(is_ignored_name)
                        || state.ignored_dirs.contains(&path)
                    {
                        continue;
                    }
                    let Ok(file_type) = entry.file_type().await else {
                        continue;
                    };
                    if file_type.is_dir() {
                        let mut dir_path = path_str;
                        if !dir_path.ends_with('/') {
                            dir_path.push('/');
                        }
                        state.dir_stack.push(dir_path);
                        continue;
                    }
                    if !file_type.is_file() {
                        // symlink, FIFO, socket, device
                        continue;
                    }
                    let Ok(meta) = entry.metadata().await else {
                        continue;
                    };
                    let ctime = meta.created().ok().and_then(system_time_to_ms);
                    let mtime = meta.modified().ok().and_then(system_time_to_ms);
                    let job = FileJob {
                        path,
                        path_str,
                        ctime,
                        mtime,
                        size: meta.len(),
                    };
                    return Some((job, state));
                }
                Ok(None) => {
                    // Directory exhausted — drop handle, pop next on
                    // the outer loop iteration.
                    state.current = None;
                }
                Err(_) => {
                    // Per-entry read failure (e.g. permission denied on
                    // a single dirent); skip and keep draining.
                }
            }
        }
    })
}

/// Delete `entry` if it's a staging file orphaned by a crash mid-write: a
/// regular file (not followed through a symlink) whose exact name
/// `ScopedFs::write_file` generates (the caller checked
/// `is_staged_write_file_name`) and last modified at least
/// `ORPHANED_TEMP_FILE_MIN_AGE` ago — far longer than a live write takes.
/// Anything else, including a user's own `.zzz-tmp-*` names, is left alone.
///
/// Only staging files the walk reaches are swept, so one inside an ignored
/// directory (`node_modules/`, `.git/`, …) stays until removed by hand.
async fn sweep_orphaned_temp_file(entry: &tokio::fs::DirEntry) {
    let Ok(meta) = entry.metadata().await else {
        return;
    };
    let is_old = meta
        .modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= crate::scoped_fs::ORPHANED_TEMP_FILE_MIN_AGE);
    if !meta.file_type().is_file() || !is_old {
        return;
    }
    let path = entry.path();
    match tokio::fs::remove_file(&path).await {
        Ok(()) => tracing::info!(path = %path.display(), "removed an orphaned staged-write file"),
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "failed to remove an orphaned staged-write file");
        }
    }
}

/// Recursively scan a directory and populate the file map.
///
/// Walks the tree and reads files concurrently in a single pipeline:
/// [`walk_files`] streams `FileJob`s as directories are discovered, and
/// `buffer_unordered` fans out up to [`MAX_CONCURRENT_FILE_READS`]
/// reads at a time (see [`read_indexable_contents`]). Files over
/// [`MAX_INDEXED_FILE_SIZE`] skip the read and store `contents: None`.
///
/// Called by `start_filer` (cold path) and by the event loop's subtree
/// syncs and rescans (hot path — `session_load` rescans every filer).
async fn scan_directory(
    dir: &str,
    source_dir: &str,
    ignored_dirs: &[PathBuf],
    files: &mut FileIndex,
) {
    let source_dir_owned = source_dir.to_owned();
    let walker = walk_files(dir.to_owned(), ignored_dirs.to_owned());
    let stream = walker
        .map(|job| {
            let source_dir = source_dir_owned.clone();
            async move {
                let contents = if job.size > MAX_INDEXED_FILE_SIZE {
                    None
                } else {
                    read_indexable_contents(job.path).await
                };
                let disknode = make_disknode(
                    job.path_str.clone(),
                    &source_dir,
                    contents,
                    job.ctime,
                    job.mtime,
                );
                (job.path_str, disknode)
            }
        })
        .buffer_unordered(MAX_CONCURRENT_FILE_READS);
    // `stream::unfold`'s state future is `!Unpin`, so the composed
    // stream needs pinning before `.next()`. `std::pin::pin!` puts it
    // on the local stack — no heap allocation.
    let mut stream = std::pin::pin!(stream);

    while let Some((path_str, disknode)) = stream.next().await {
        files.insert(path_str, disknode);
    }
}

// -- Event loop ---------------------------------------------------------------

/// State owned by a filer's event-loop task: the index (shared for reads)
/// and the pending debounced broadcasts.
struct FilerState {
    source_dir: String,
    ignored_dirs: Vec<PathBuf>,
    files: Arc<RwLock<FileIndex>>,
    /// Keyed by index path.
    pending: HashMap<String, PendingNotification>,
}

impl FilerState {
    /// Apply one notify event to the index and the pending broadcasts.
    async fn handle_event(&mut self, event: notify::Event) {
        for (path, hint) in classify_event(event.kind, event.paths) {
            if is_ignored(&path, Path::new(&self.source_dir), &self.ignored_dirs) {
                continue;
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
        match tokio::fs::symlink_metadata(path).await {
            Ok(meta) if meta.is_file() => {
                self.remove_children(&path_str).await;
                let node = read_disknode(path, path_str.clone(), &self.source_dir, &meta).await;
                self.upsert(path_str, node).await;
            }
            Ok(meta) if meta.is_dir() => {
                self.remove_entry(&path_str).await;
                if hint == PathHint::Entry {
                    self.sync_subtree(&path_str).await;
                }
            }
            // missing (a stale or short-lived event), a symlink, or a
            // special file — nothing indexable lives here
            _ => self.remove_tree(&path_str).await,
        }
    }

    /// Insert or update one file, queueing `add` (newly indexed) or
    /// `change` (indexed, and differs).
    async fn upsert(&mut self, path: String, node: SerializableDisknode) {
        let change = {
            let mut index = self.files.write().await;
            let change = match index.get(&path) {
                None => Some(ChangeType::Add),
                Some(old) if disknode_changed(old, &node) => Some(ChangeType::Change),
                Some(_) => None,
            };
            if change.is_some() {
                index.insert(path.clone(), node.clone());
            }
            change
        };
        if let Some(change) = change {
            self.queue(path, change, node);
        }
    }

    /// Remove `path` and every file indexed under it.
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

    /// Remove every index entry under `path/`.
    async fn remove_children(&mut self, path: &str) {
        let removed = {
            let mut index = self.files.write().await;
            apply_subtree(&mut index, &dir_prefix(path), FileIndex::new())
        };
        for (path, change, node) in removed {
            self.queue(path, change, node);
        }
    }

    /// Re-walk `dir` and reconcile the index entries under it.
    async fn sync_subtree(&mut self, dir: &str) {
        let prefix = dir_prefix(dir);
        let mut fresh = FileIndex::new();
        scan_directory(&prefix, &self.source_dir, &self.ignored_dirs, &mut fresh).await;
        let changes = {
            let mut index = self.files.write().await;
            apply_subtree(&mut index, &prefix, fresh)
        };
        for (path, change, node) in changes {
            self.queue(path, change, node);
        }
    }

    /// Reconcile the whole index with the disk.
    async fn rescan(&mut self) {
        let root = self.source_dir.clone();
        self.sync_subtree(&root).await;
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
/// updates the index, and broadcasts debounced `filer_change` notifications.
async fn filer_event_loop(
    mut state: FilerState,
    mut rx: mpsc::Receiver<notify::Event>,
    mut rescan_rx: mpsc::Receiver<oneshot::Sender<()>>,
    signal: Arc<RescanSignal>,
    app: Arc<App>,
) {
    loop {
        let next_deadline = state.next_deadline();
        tokio::select! {
            biased;
            Some(reply) = rescan_rx.recv() => {
                // Every request already queued was sent before this scan
                // starts, so one scan answers them all (concurrent
                // `session_load`s share it instead of re-reading the tree
                // once each).
                let mut replies = vec![reply];
                while let Ok(reply) = rescan_rx.try_recv() {
                    replies.push(reply);
                }
                // a full rescan also satisfies any overflow-triggered one
                signal.take();
                state.rescan().await;
                for reply in replies {
                    let _ = reply.send(());
                }
            }
            event = rx.recv() => {
                let Some(event) = event else {
                    break; // watcher dropped
                };
                state.handle_event(event).await;
            }
            // Below `rx` so an overflow rescan runs once the backlog drains.
            () = signal.notify.notified() => {
                if signal.take() {
                    tracing::debug!(path = %state.source_dir, "file watcher overflowed, rescanning");
                    state.rescan().await;
                }
            }
            () = tokio::time::sleep_until(next_deadline.unwrap_or_else(Instant::now)),
                if next_deadline.is_some() => {}
        }

        for ready in state.take_ready(Instant::now()) {
            let params = FilerChangeParams {
                change: DiskfileChange {
                    change_type: ready.change_type,
                    path: ready.disknode.id.clone(),
                },
                disknode: ready.disknode,
            };
            let notification = fuz_http::notification("filer_change", &params);
            app.broadcast(&notification);
        }
    }
}

// -- FilerManager -------------------------------------------------------------

/// Whether a filer was started at server startup (permanent) or via
/// `workspace_open` (can be stopped on `workspace_close`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FilerLifetime {
    /// Started at server startup for `zzz_dir` or `scoped_dirs` — never stopped.
    Permanent,
    /// Started via `workspace_open` — stopped on `workspace_close`.
    Workspace,
}

/// Entry in the filer manager.
pub struct FilerEntry {
    pub filer: Filer,
    pub lifetime: FilerLifetime,
}

/// Manages all active filers with deduplication and lifetime tracking.
///
/// One filer per unique directory path. Permanent filers (`zzz_dir`, `scoped_dirs`)
/// survive `workspace_close`. Workspace filers are stopped on close.
pub struct FilerManager {
    filers: RwLock<HashMap<String, FilerEntry>>,
}

impl FilerManager {
    pub fn new() -> Self {
        Self {
            filers: RwLock::new(HashMap::new()),
        }
    }

    /// Start a filer for the given directory path. Returns `Ok(true)` if a new
    /// filer was created, `Ok(false)` if one already existed for this path.
    ///
    /// If a filer already exists, its lifetime is upgraded to `Permanent` if
    /// the new request is `Permanent` (but never downgraded).
    pub async fn start_filer(
        &self,
        path: &str,
        app: Arc<App>,
        config: FilerConfig,
        lifetime: FilerLifetime,
    ) -> Result<bool, notify::Error> {
        debug_assert!(
            path.ends_with('/'),
            "FilerManager paths must have trailing slash: {path}"
        );

        // Fast path — already watching
        {
            let filers = self.filers.read().await;
            if let Some(entry) = filers.get(path) {
                // Upgrade lifetime if needed (workspace → permanent)
                if lifetime == FilerLifetime::Permanent
                    && entry.lifetime == FilerLifetime::Workspace
                {
                    drop(filers);
                    let mut filers = self.filers.write().await;
                    if let Some(entry) = filers.get_mut(path) {
                        entry.lifetime = FilerLifetime::Permanent;
                    }
                }
                return Ok(false);
            }
        }

        // Create new filer
        let filer = start_filer(path, app, config).await?;

        let mut filers = self.filers.write().await;
        // Double-check in case another task raced us
        if filers.contains_key(path) {
            // Filer was created by another task between our read and write
            return Ok(false);
        }
        filers.insert(path.to_owned(), FilerEntry { filer, lifetime });
        Ok(true)
    }

    /// Stop and remove a filer for the given path. Only stops workspace-scoped
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
    /// Called by `session_load` before `collect_all_files` to guarantee a
    /// consistent snapshot — notify events are eventually consistent, so a
    /// just-written file may not yet be in the index when the event loop is
    /// still draining. A direct filesystem walk sidesteps that race. The
    /// rescans run on each filer's event loop, so they serialize with event
    /// handling instead of racing it.
    pub async fn rescan_all(&self) {
        // Snapshot the request senders under the outer lock, then rescan
        // without holding it — the outer lock blocks start_filer/stop_filer.
        let senders: Vec<mpsc::Sender<oneshot::Sender<()>>> = {
            let filers = self.filers.read().await;
            filers.values().map(|e| e.filer.rescan_tx.clone()).collect()
        };
        futures_util::future::join_all(senders.into_iter().map(|rescan_tx| async move {
            let (reply_tx, reply_rx) = oneshot::channel();
            if rescan_tx.send(reply_tx).await.is_ok() {
                let _ = reply_rx.await;
            }
        }))
        .await;
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

    /// Collect all files from all filers into a single Vec.
    /// Used by `session_load` to return the complete file listing.
    pub async fn collect_all_files(&self) -> Vec<SerializableDisknode> {
        // Collect Arc handles under the outer lock, then release it before
        // awaiting the inner per-filer locks — avoids holding the manager
        // lock across await points (which would block start_filer/stop_filer).
        let file_maps: Vec<Arc<RwLock<FileIndex>>> = {
            let filers = self.filers.read().await;
            filers
                .values()
                .map(|e| Arc::clone(&e.filer.files))
                .collect()
        };

        let mut all_files = Vec::new();
        for files in &file_maps {
            let index = files.read().await;
            all_files.extend(index.values().cloned());
        }
        all_files
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, RemoveKind, RenameMode};

    // -- pure: classification + coalescing + subtree diff ---------------------

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
        // both sides of a rename are looked up on disk
        assert_eq!(
            classify_event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                vec![p("/w/old"), p("/w/new")]
            ),
            vec![
                (p("/w/old"), PathHint::Entry),
                (p("/w/new"), PathHint::Entry)
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

    fn node(path: &str, contents: &str, mtime: f64) -> SerializableDisknode {
        make_disknode(
            path.to_owned(),
            "/w/",
            Some(contents.to_owned()),
            None,
            Some(mtime),
        )
    }

    #[test]
    fn apply_subtree_diffs_only_under_prefix() {
        let mut index = FileIndex::new();
        for n in [
            node("/w/d/same", "s", 1.0),
            node("/w/d/edited", "old", 1.0),
            node("/w/d/gone", "g", 1.0),
            node("/w/d2/sibling", "x", 1.0),
            node("/w/top", "t", 1.0),
        ] {
            index.insert(n.id.clone(), n);
        }
        let mut fresh = FileIndex::new();
        for n in [
            node("/w/d/same", "s", 1.0),
            node("/w/d/edited", "new", 2.0),
            node("/w/d/new", "n", 1.0),
        ] {
            fresh.insert(n.id.clone(), n);
        }

        let mut changes: Vec<(String, ChangeType)> = apply_subtree(&mut index, "/w/d/", fresh)
            .into_iter()
            .map(|(path, change, _)| (path, change))
            .collect();
        changes.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            changes,
            vec![
                ("/w/d/edited".to_owned(), ChangeType::Change),
                ("/w/d/gone".to_owned(), ChangeType::Delete),
                ("/w/d/new".to_owned(), ChangeType::Add),
            ]
        );
        let keys: Vec<&str> = index.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "/w/d/edited",
                "/w/d/new",
                "/w/d/same",
                "/w/d2/sibling",
                "/w/top"
            ]
        );
        assert_eq!(index["/w/d/edited"].contents.as_deref(), Some("new"));
    }

    // -- filesystem: walker + event loop state --------------------------------

    /// A unique temp dir removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("zzz_filer_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            // canonical, so paths match what the walker yields
            Self(dir.canonicalize().unwrap())
        }

        fn root(&self) -> String {
            dir_prefix(&self.0.to_string_lossy())
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        fn key(&self, rel: &str) -> String {
            self.path(rel).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn scan(root: &str) -> FileIndex {
        let mut files = FileIndex::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            scan_directory(root, root, &[], &mut files),
        )
        .await
        .expect("scan must terminate");
        files
    }

    async fn state_for(tmp: &TempDir) -> FilerState {
        let root = tmp.root();
        let files = scan(&root).await;
        FilerState {
            source_dir: root,
            ignored_dirs: vec![],
            files: Arc::new(RwLock::new(files)),
            pending: HashMap::new(),
        }
    }

    fn event(kind: EventKind, paths: &[PathBuf]) -> notify::Event {
        let mut event = notify::Event::new(kind);
        event.paths = paths.to_vec();
        event
    }

    fn pending_of(state: &FilerState) -> Vec<(String, ChangeType)> {
        let mut pending: Vec<(String, ChangeType)> = state
            .pending
            .iter()
            .map(|(k, v)| (k.clone(), v.change_type))
            .collect();
        pending.sort_by(|a, b| a.0.cmp(&b.0));
        pending
    }

    async fn indexed(state: &FilerState) -> Vec<String> {
        state.files.read().await.keys().cloned().collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scan_skips_symlinks_and_loops() {
        use std::os::unix::fs::symlink;

        let outside = TempDir::new();
        std::fs::write(outside.path("secret.txt"), "outside").unwrap();

        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("sub")).unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        std::fs::write(tmp.path("sub/b.txt"), "b").unwrap();
        symlink("..", tmp.path("sub/up")).unwrap(); // loop
        symlink(".", tmp.path("self")).unwrap(); // loop
        symlink("/", tmp.path("root")).unwrap(); // `dosdevices/z:`-style
        symlink(outside.path("secret.txt"), tmp.path("linked.txt")).unwrap();
        symlink(&outside.0, tmp.path("linked_dir")).unwrap();

        let files = scan(&tmp.root()).await;
        let keys: Vec<&str> = files.keys().map(String::as_str).collect();
        assert_eq!(keys, vec![tmp.key("a.txt"), tmp.key("sub/b.txt")]);
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

    #[cfg(unix)]
    #[tokio::test]
    async fn non_utf8_paths_are_skipped_with_their_subtrees() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let bad = OsStr::from_bytes(b"bad\xff");
        let tmp = TempDir::new();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        std::fs::write(tmp.0.join(bad), "x").unwrap();
        let bad_dir = tmp.path("sub").join(bad);
        std::fs::create_dir_all(bad_dir.join("inner")).unwrap();
        std::fs::write(bad_dir.join("ok_name.txt"), "x").unwrap();
        std::fs::write(bad_dir.join("inner/deep.txt"), "x").unwrap();

        let mut state = state_for(&tmp).await;
        assert_eq!(indexed(&state).await, vec![tmp.key("a.txt")]);

        // events inside the non-UTF-8 directory, or for the entry itself,
        // are filtered like ignored paths — no lossy keys, no flapping
        let paths = [
            tmp.0.join(bad),
            bad_dir.clone(),
            bad_dir.join("ok_name.txt"),
            bad_dir.join("inner/deep.txt"),
        ];
        for path in &paths {
            assert!(is_ignored(path, &tmp.0, &[]), "{}", path.display());
        }
        state
            .handle_event(event(EventKind::Create(CreateKind::Any), &paths))
            .await;
        state.rescan().await;
        assert_eq!(indexed(&state).await, vec![tmp.key("a.txt")]);
        assert!(state.pending.is_empty(), "{:?}", pending_of(&state));
    }

    #[tokio::test]
    async fn the_walk_sweeps_only_old_exact_staging_files() {
        use crate::scoped_fs::TEMP_FILE_PREFIX;

        let tmp = TempDir::new();
        let hex = "0123456789abcdef0123456789abcdef";
        let old = std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        let make = |name: &str, age: Option<std::time::SystemTime>| {
            let path = tmp.path(name);
            std::fs::write(&path, "x").unwrap();
            if let Some(time) = age {
                std::fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(time)
                    .unwrap();
            }
            path
        };
        let orphan = make(&format!("{TEMP_FILE_PREFIX}{hex}"), Some(old));
        let fresh = make(&format!("{TEMP_FILE_PREFIX}{}", "f".repeat(32)), None);
        let not_ours = make(&format!("{TEMP_FILE_PREFIX}notes.txt"), Some(old));
        let uppercase = make(
            &format!("{TEMP_FILE_PREFIX}{}", hex.to_uppercase()),
            Some(old),
        );
        let dir = tmp.path(&format!("{TEMP_FILE_PREFIX}{}", "e".repeat(32)));
        std::fs::create_dir(&dir).unwrap();
        std::fs::File::open(&dir)
            .unwrap()
            .set_modified(old)
            .unwrap();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();

        let files = scan(&tmp.root()).await;

        assert_eq!(
            files.keys().cloned().collect::<Vec<_>>(),
            vec![tmp.key("a.txt")]
        );
        assert!(!orphan.exists(), "an old exact staging file is swept");
        for kept in [&fresh, &not_ours, &uppercase, &dir] {
            assert!(kept.exists(), "{} must be kept", kept.display());
        }
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
        assert_eq!(
            state.files.read().await[&tmp.key("f.txt")]
                .contents
                .as_deref(),
            Some("two")
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
    async fn unchanged_modify_is_not_broadcast() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "one").unwrap();
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

    #[test]
    fn workspace_config_ignores_zzz_dir_only_when_nested() {
        let nested = FilerConfig::workspace("/w/", "/w/sub/data/");
        assert_eq!(nested.ignored_dirs, vec![PathBuf::from("/w/sub/data")]);
        // the root itself, a sibling, an ancestor, and a name-prefix sibling
        for (root, zzz_dir) in [
            ("/w/", "/w/"),
            ("/w/", "/other/.zzz/"),
            ("/w/sub/data/inner/", "/w/sub/data/"),
            ("/w/data2/", "/w/data/"),
        ] {
            assert!(
                FilerConfig::workspace(root, zzz_dir)
                    .ignored_dirs
                    .is_empty(),
                "{root} {zzz_dir}"
            );
        }
    }

    #[test]
    fn ignored_dirs_match_by_full_path_not_name() {
        let root = Path::new("/w");
        let ignored = [PathBuf::from("/w/app/data")];
        assert!(is_ignored(Path::new("/w/app/data"), root, &ignored));
        assert!(is_ignored(Path::new("/w/app/data/x.txt"), root, &ignored));
        assert!(!is_ignored(Path::new("/w/data/x.txt"), root, &ignored));
        assert!(!is_ignored(Path::new("/w/app/data2/x.txt"), root, &ignored));
        // default names still apply alongside
        assert!(is_ignored(Path::new("/w/data/.git/HEAD"), root, &ignored));
    }

    #[test]
    fn the_cli_daemon_home_is_ignored_in_a_home_workspace() {
        let home = Path::new("/home/u");
        let config = FilerConfig::workspace("/home/u/", "/home/u/.zzz/.zzz/");
        assert_eq!(
            config.ignored_dirs,
            vec![PathBuf::from("/home/u/.zzz/.zzz")]
        );
        for rel in [
            ".zzz/.env",
            ".zzz/bootstrap_token",
            ".zzz/config.json",
            ".zzz/run/daemon.json",
        ] {
            assert!(
                is_ignored(&home.join(rel), home, &config.ignored_dirs),
                "{rel}"
            );
        }
        assert!(!is_ignored(
            &home.join("notes/.env"),
            home,
            &config.ignored_dirs
        ));
    }

    #[tokio::test]
    async fn the_cli_daemon_home_is_skipped_by_the_scan() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path(".zzz/.zzz")).unwrap();
        std::fs::create_dir_all(tmp.path(".zzz/run")).unwrap();
        for rel in [
            ".zzz/.env",
            ".zzz/bootstrap_token",
            ".zzz/run/daemon.json",
            ".zzz/.zzz/f",
            "notes.txt",
        ] {
            std::fs::write(tmp.path(rel), "x").unwrap();
        }
        let root = tmp.root();
        let config = FilerConfig::workspace(&root, &dir_prefix(&tmp.key(".zzz/.zzz")));
        let mut files = FileIndex::new();
        scan_directory(&root, &root, &config.ignored_dirs, &mut files).await;
        let keys: Vec<String> = files.keys().cloned().collect();
        assert_eq!(keys, vec![tmp.key("notes.txt")]);
    }

    #[tokio::test]
    async fn the_app_dir_is_ignored_by_path_while_same_named_dirs_stay_indexed() {
        let tmp = TempDir::new();
        for dir in ["app/data", "data", "src/data"] {
            std::fs::create_dir_all(tmp.path(dir)).unwrap();
            std::fs::write(tmp.path(&format!("{dir}/f.txt")), "x").unwrap();
        }
        let root = tmp.root();
        let config = FilerConfig::workspace(&root, &dir_prefix(&tmp.key("app/data")));

        let mut files = FileIndex::new();
        scan_directory(&root, &root, &config.ignored_dirs, &mut files).await;
        let keys: Vec<String> = files.keys().cloned().collect();
        assert_eq!(keys, vec![tmp.key("data/f.txt"), tmp.key("src/data/f.txt")]);

        let mut state = FilerState {
            source_dir: root,
            ignored_dirs: config.ignored_dirs,
            files: Arc::new(RwLock::new(files)),
            pending: HashMap::new(),
        };
        std::fs::write(tmp.path("app/data/g.txt"), "y").unwrap();
        std::fs::write(tmp.path("data/g.txt"), "y").unwrap();
        state
            .handle_event(event(
                EventKind::Create(CreateKind::File),
                &[tmp.path("app/data/g.txt"), tmp.path("data/g.txt")],
            ))
            .await;
        assert_eq!(
            pending_of(&state),
            vec![(tmp.key("data/g.txt"), ChangeType::Add)]
        );
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

        state.rescan().await;
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
        state.rescan().await;
        assert!(state.pending.is_empty());
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

    #[tokio::test]
    async fn take_ready_respects_deadlines() {
        let tmp = TempDir::new();
        let mut state = state_for(&tmp).await;
        state.queue(tmp.key("x"), ChangeType::Add, node(&tmp.key("x"), "x", 1.0));
        assert!(state.take_ready(Instant::now()).is_empty());
        let ready = state.take_ready(Instant::now() + DEBOUNCE_DURATION);
        assert_eq!(ready.len(), 1);
        assert!(state.pending.is_empty());
        assert!(state.next_deadline().is_none());
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
            state.queue_at(t, key.clone(), ChangeType::Change, node(&key, "x", 1.0));
            assert!(state.take_ready(t).is_empty(), "not ready at {:?}", t - t0);
            t += Duration::from_millis(50);
        }
        let ready = state.take_ready(t0 + DEBOUNCE_MAX_WAIT);
        assert_eq!(ready.len(), 1, "flushed by the max wait");
        // the next run starts fresh
        let t1 = t0 + DEBOUNCE_MAX_WAIT;
        state.queue_at(t1, key.clone(), ChangeType::Change, node(&key, "y", 2.0));
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
        // FSEvents reporting the create before the remove
        std::fs::remove_file(tmp.path("f.txt")).unwrap();
        std::fs::write(tmp.path("f.txt"), "two").unwrap();
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

    #[cfg(unix)]
    #[tokio::test]
    async fn contents_reads_refuse_links_fifos_and_oversize() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new();
        std::fs::write(tmp.path("ok.txt"), "ok").unwrap();
        symlink(tmp.path("ok.txt"), tmp.path("link.txt")).unwrap();
        let big = vec![b'x'; usize::try_from(MAX_INDEXED_FILE_SIZE).unwrap() + 1];
        std::fs::write(tmp.path("big.txt"), &big).unwrap();
        std::fs::write(tmp.path("bin"), [0xff, 0xfe]).unwrap();
        let fifo = std::process::Command::new("mkfifo")
            .arg(tmp.path("fifo"))
            .status()
            .is_ok_and(|s| s.success());

        let read = |rel: &str| {
            tokio::time::timeout(
                Duration::from_secs(5),
                read_indexable_contents(tmp.path(rel)),
            )
        };
        assert_eq!(read("ok.txt").await.unwrap().as_deref(), Some("ok"));
        assert_eq!(read("link.txt").await.unwrap(), None);
        assert_eq!(read("big.txt").await.unwrap(), None);
        assert_eq!(read("bin").await.unwrap(), None);
        if fifo {
            assert_eq!(read("fifo").await.expect("must not block"), None);
        }
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
            .insert(tmp.key("x"), node(&tmp.key("x"), "stale", 1.0));
        state.pending.clear();
        state
            .handle_event(event(EventKind::Modify(ModifyKind::Any), &[tmp.path("x")]))
            .await;
        assert_eq!(indexed(&state).await, vec![tmp.key("x/child.txt")]);
        assert_eq!(pending_of(&state), vec![(tmp.key("x"), ChangeType::Delete)]);
    }
}
