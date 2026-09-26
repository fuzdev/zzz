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
//! - **Per-directory watches.** The filer adds one non-recursive watch per
//!   directory from its own walk ([`DirWatches`]), so ignored directories
//!   (`node_modules/`, `target/`, …), symlinks, non-UTF-8 directories, and the
//!   app dir are never watched — a workspace needs a watch per directory it
//!   indexes, not per directory on disk. Each directory is watched before it
//!   is listed, so an entry created in between is either listed or reported.
//!   A directory that appears gets watches for its subtree as part of its
//!   sync; one that is removed or renamed away has its watches dropped.
//!   Failures are per directory: an unreadable directory is skipped (logged
//!   once), a vanished one ignored, one whose listing fails transiently kept
//!   as indexed and polled, and only an unreadable or missing root fails
//!   [`start_filer`].
//! - **Degraded mode.** When the OS runs out of watches (inotify's
//!   `max_user_watches`), or no watcher can be created at all, the index still
//!   comes from the scan; the directories left without a watch are rescanned
//!   periodically instead ([`WatchStatus::Degraded`]), retrying their watches
//!   each time.
//! - **Cheap rescans.** A rescan reuses a file's indexed node when its `lstat`
//!   identity and change stamps ([`FileStat`]) are unchanged, so rescans
//!   (`session_load`, overflow recovery, degraded polling) re-read only files
//!   that changed — trusting a stamp only once the file has been still for a
//!   while ([`reusable_stat`]).
//! - **Debounce coalescing.** Broadcasts are debounced per path
//!   ([`coalesce_change`]): a `delete` followed by an `add` inside the window
//!   becomes `change`, and an `add` followed by a `delete` becomes a bare
//!   `delete` (a no-op for clients that never saw the add). A path that
//!   keeps changing still broadcasts at least every [`DEBOUNCE_MAX_WAIT`].
//! - **Overflow recovery.** Paths under ignored directories are filtered in
//!   the notify callback, before the bounded channel. If the channel is
//!   still full, or notify reports a rescan (inotify queue overflow), the
//!   filer schedules one coalesced rescan of its root, which rebuilds the
//!   watches on a fresh watcher ([`DirWatches::reset`]), diffs the index
//!   against the disk, and broadcasts the differences.
//! - **Symlinks are skipped entirely** — consistent with `ScopedFs`'s
//!   no-symlink rule. The walker never follows or indexes a symlink (file or
//!   directory), so no watch is added through one, and an event whose path is
//!   a symlink resolves as "not indexable". This keeps link loops
//!   (`up -> ..`, a Wine prefix's `dosdevices/z: -> /`) from hanging the
//!   scan, and keeps files outside the watched root out of the index.
//!
//! The walk and the watch calls block (directory reads, a round trip to
//! notify's watcher thread per watch), so they run on a blocking thread
//! (`spawn_blocking`), never on an async worker.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime};

use futures_util::{StreamExt, stream};
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
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

/// Capacity of the walker → reader channel of a scan. The blocking walker
/// runs ahead of the reads by at most this many files, keeping a scan's
/// memory flat in tree size.
const WALK_CHANNEL_CAPACITY: usize = 256;

/// Shortest interval between rescans of the directories a degraded filer
/// couldn't watch. The actual interval also scales with how long the last
/// one took ([`DEGRADED_RESCAN_COST_FACTOR`]), so a huge unwatched tree
/// isn't rescanned back to back.
const DEGRADED_RESCAN_INTERVAL: Duration = Duration::from_secs(5);

/// A degraded rescan waits at least this many times its own duration before
/// the next one — at most ~10% of a thread spent polling.
const DEGRADED_RESCAN_COST_FACTOR: u32 = 10;

/// How long a file must have been still (by `mtime` and `ctime`) before its
/// [`FileStat`] is trusted to reuse its contents — see [`reusable_stat`].
/// Covers filesystems with coarse timestamps (a jiffy on tmpfs, whole seconds
/// on some others).
const RACY_STAT_MARGIN: Duration = Duration::from_secs(2);

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
    /// The `lstat` this node was read after — lets a rescan reuse the node
    /// while the file is unchanged. Not part of the wire shape.
    #[serde(skip)]
    stat: Option<FileStat>,
}

/// A filer's in-memory index, keyed by absolute file path. Ordered so a
/// directory's files are one contiguous prefix range.
type FileIndex = BTreeMap<String, SerializableDisknode>;

/// Whether every directory a filer indexes has a watch — returned by
/// `workspace_open` as `watch_status`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WatchStatus {
    /// Every indexed directory is watched; changes arrive as events.
    Full,
    /// Some directories have no watch — the OS watch limit (inotify's
    /// `max_user_watches`) was reached, no watcher could be created, or the
    /// root went missing. They're rescanned periodically, so their changes
    /// arrive late (after up to [`DEGRADED_RESCAN_INTERVAL`] or longer).
    Degraded,
}

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
/// the walker never descends into one (see [`walk_blocking`]).
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

/// The directory a [`dir_prefix`]-form path names, without its trailing
/// slash — the spelling watches are added and removed under, matching the
/// paths notify reports events at.
fn prefix_dir(prefix: &str) -> &Path {
    let trimmed = prefix.trim_end_matches('/');
    Path::new(if trimmed.is_empty() { "/" } else { trimmed })
}

/// The members of `set` at or under `prefix` (a [`dir_prefix`]).
fn under<'a>(set: &'a BTreeSet<String>, prefix: &'a str) -> impl Iterator<Item = &'a String> {
    set.range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
        .take_while(move |entry| entry.starts_with(prefix))
}

/// Remove the members of `set` under `prefix` that `keep` rejects.
///
/// @mutates set - entries under `prefix` failing `keep` are removed
fn retain_under(set: &mut BTreeSet<String>, prefix: &str, keep: impl Fn(&str) -> bool) {
    let removed: Vec<String> = under(set, prefix)
        .filter(|entry| !keep(entry))
        .cloned()
        .collect();
    for entry in removed {
        set.remove(&entry);
    }
}

// -- File metadata helpers ----------------------------------------------------

/// Convert a `SystemTime` to milliseconds since epoch (matching JS `Date` format).
fn system_time_to_ms(t: SystemTime) -> Option<f64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64() * 1000.0)
}

/// A regular file's identity and change stamps from `lstat`.
///
/// A rescan that finds a file's `FileStat` unchanged reuses its indexed node
/// instead of re-reading it. The stamp is taken before the read, so a write
/// racing the read leaves a stale stamp, which only costs one more read. The
/// inode change time (`st_ctime`) moves on every write, truncate, chmod, and
/// rename and can't be set from userspace, so a rewrite that keeps the size
/// and restores `mtime` (`touch -r`) is still re-read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileStat {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: (i64, i64),
    change_time: (i64, i64),
}

impl FileStat {
    fn of(meta: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;

        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            size: meta.size(),
            mtime: (meta.mtime(), meta.mtime_nsec()),
            change_time: (meta.ctime(), meta.ctime_nsec()),
        }
    }
}

/// Nanoseconds since the epoch of a `(seconds, nanoseconds)` stamp.
fn stamp_nanos((secs, nanos): (i64, i64)) -> i128 {
    i128::from(secs) * 1_000_000_000 + i128::from(nanos)
}

/// The stamp to record for a file whose contents were read after `stat`
/// was taken — or `None` when a later rescan mustn't trust it, git's
/// "racily clean" rule.
///
/// Timestamps have filesystem granularity (a jiffy on tmpfs, whole seconds on
/// some filesystems), so two same-size writes inside one tick can leave size,
/// `mtime`, and `ctime` all unchanged; a stamp is only recorded once the file
/// has been still for [`RACY_STAT_MARGIN`] as of `now` (after the read). A
/// read that got a different number of bytes than the stat's size
/// (`bytes_read`, when the contents were read) raced a write outright. An
/// unrecorded stamp just means the next rescan reads the file again.
fn reusable_stat(stat: FileStat, bytes_read: Option<usize>, now: SystemTime) -> Option<FileStat> {
    if bytes_read.is_some_and(|len| u64::try_from(len).ok() != Some(stat.size)) {
        return None;
    }
    let now = now
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i128::try_from(d.as_nanos()).ok())?;
    let margin = i128::try_from(RACY_STAT_MARGIN.as_nanos()).ok()?;
    let newest = stamp_nanos(stat.mtime).max(stamp_nanos(stat.change_time));
    (now - newest >= margin).then_some(stat)
}

/// Construct a `SerializableDisknode` from pre-read components.
fn make_disknode(
    id: String,
    source_dir: &str,
    contents: Option<String>,
    ctime: Option<f64>,
    mtime: Option<f64>,
    stat: Option<FileStat>,
) -> SerializableDisknode {
    SerializableDisknode {
        id,
        source_dir: source_dir.to_owned(),
        contents,
        ctime,
        mtime,
        dependents: vec![],
        dependencies: vec![],
        stat,
    }
}

/// The disknode broadcast with a `delete` — identity only, no contents.
fn deleted_disknode(node: SerializableDisknode) -> SerializableDisknode {
    make_disknode(node.id, &node.source_dir, None, None, None, None)
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
    let stat = reusable_stat(
        FileStat::of(meta),
        contents.as_ref().map(String::len),
        SystemTime::now(),
    );
    make_disknode(path_str, source_dir, contents, ctime, mtime, stat)
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
const fn is_indexable_kind(kind: EventKind) -> bool {
    !matches!(kind, EventKind::Access(_) | EventKind::Other)
}

/// Whether an event of this kind can mean a watched directory is gone from
/// its path — removed, or renamed away. Its watches are dropped (notify
/// drops its own for a removed or renamed-away child of a watched directory)
/// and whatever is at the path now is re-watched by its sync. The arrival
/// side of a rename (`To`, `Both`) names a path that's synced anyway.
const fn may_drop_watches(kind: EventKind) -> bool {
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
fn classify_event(kind: EventKind, paths: Vec<PathBuf>) -> Vec<(PathBuf, PathHint)> {
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

/// One file found by a scan: re-read, or unchanged since it was indexed
/// (its [`FileStat`] matched, so the indexed node stands).
#[derive(Debug)]
enum ScannedFile {
    Unchanged,
    Read(Box<SerializableDisknode>),
}

/// The files a scan found, keyed like the index.
type ScanIndex = BTreeMap<String, ScannedFile>;

/// Replace the index entries under `prefix` with `fresh` (a scan of that
/// subtree), returning the resulting changes. Unchanged entries produce
/// nothing; a re-read file whose contents and timestamps match only has its
/// stored [`FileStat`] refreshed, so the next rescan can reuse it.
///
/// @mutates index - entries under `prefix` are inserted, replaced, or removed to match `fresh`
fn apply_subtree(
    index: &mut FileIndex,
    prefix: &str,
    mut fresh: ScanIndex,
) -> Vec<(String, ChangeType, SerializableDisknode)> {
    let mut changes = Vec::new();
    let old_keys: Vec<String> = index
        .range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
        .take_while(|(k, _)| k.starts_with(prefix))
        .map(|(k, _)| k.clone())
        .collect();
    for key in old_keys {
        match fresh.remove(&key) {
            Some(ScannedFile::Unchanged) => {}
            Some(ScannedFile::Read(node)) => {
                let Some(old) = index.get_mut(&key) else {
                    continue;
                };
                if disknode_changed(old, &node) {
                    old.clone_from(&node);
                    changes.push((key, ChangeType::Change, *node));
                } else {
                    old.stat = node.stat;
                }
            }
            None => {
                if let Some(node) = index.remove(&key) {
                    changes.push((key, ChangeType::Delete, deleted_disknode(node)));
                }
            }
        }
    }
    for (key, scanned) in fresh {
        // `Unchanged` is only reported for an indexed key, all handled above
        if let ScannedFile::Read(node) = scanned {
            index.insert(key.clone(), (*node).clone());
            changes.push((key, ChangeType::Add, *node));
        }
    }
    changes
}

// -- Filer configuration ------------------------------------------------------

/// Per-filer configuration: which directories to ignore, and the watch
/// budget.
pub struct FilerConfig {
    /// Absolute directories to ignore beyond the default names. For a
    /// workspace watcher whose root contains `zzz_dir`, this is `zzz_dir`
    /// (which has its own watcher); otherwise empty.
    pub ignored_dirs: Vec<PathBuf>,
    /// Most directory watches this filer adds. `None` leaves only the OS
    /// limit (inotify's `max_user_watches`, shared by every process of the
    /// user); reaching either puts the filer in degraded mode.
    pub watch_limit: Option<usize>,
    /// Shortest interval between degraded-mode rescans of the unwatched
    /// directories.
    pub degraded_rescan_interval: Duration,
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
            #[cfg(test)]
            no_watcher: false,
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
            ..Self::zzz_dir()
        }
    }
}

// -- Directory watches --------------------------------------------------------

/// What trying to watch a directory before listing it found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchAttempt {
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
type WatcherFactory = Box<dyn Fn() -> Option<RecommendedWatcher> + Send>;

/// A directory's inode, `(dev, ino)` — the identity a kernel watch is on.
type DirId = (u64, u64);

/// Whether a failure to list a directory may clear up by itself (`EMFILE`,
/// `ENOMEM`, `EIO`, …) — the walk then keeps what's indexed under it and
/// retries later — rather than meaning the directory is unreadable or gone.
fn is_transient_list_error(error: &io::Error) -> bool {
    !matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

/// The keys of `map` at or under `prefix` (a [`dir_prefix`]).
fn keys_under<'a, V>(
    map: &'a BTreeMap<String, V>,
    prefix: &'a str,
) -> impl Iterator<Item = &'a String> {
    map.range::<str, _>((Bound::Included(prefix), Bound::Unbounded))
        .map(|(key, _)| key)
        .take_while(move |key| key.starts_with(prefix))
}

/// A filer's per-directory watches and the bookkeeping behind its
/// [`WatchStatus`].
///
/// Directories are keyed in [`dir_prefix`] form. The bookkeeping errs toward
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
struct DirWatches {
    make_watcher: WatcherFactory,
    /// `None` when no watcher could be created; every directory is then
    /// unwatched.
    watcher: Option<RecommendedWatcher>,
    /// The filer's root.
    source_dir: String,
    /// `FilerConfig::watch_limit`.
    watch_limit: Option<usize>,
    /// Directories with a watch, and the inode each was watched on.
    watched: BTreeMap<String, DirId>,
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
    poll_missing_root: bool,
    /// `unwatched.len()`, published for [`Filer::watch_status`] readers,
    /// which can't take the lock (a walk holds it on a blocking thread).
    unwatched_count: Arc<AtomicUsize>,
    /// Test seam: listing this directory fails with a transient error.
    #[cfg(test)]
    fail_listing: Option<String>,
}

impl DirWatches {
    fn new(make_watcher: WatcherFactory, source_dir: &str, watch_limit: Option<usize>) -> Self {
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
    fn reset(&mut self) {
        self.watcher = None;
        self.watched.clear();
        self.watch_refs.clear();
        self.unwatched.clear();
        self.limit_reached = false;
        self.watcher = (self.make_watcher)();
    }

    /// Ensure `dir` is watched before it's listed (a no-op if it already is).
    fn attempt(&mut self, dir: &str) -> WatchAttempt {
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
                    tracing::debug!(path = %dir, error = %e, "failed to watch a directory");
                    self.unwatched.insert(dir.to_owned());
                    WatchAttempt::List
                }
            },
        }
    }

    /// List `dir` (with the test seam's injected failure).
    #[allow(clippy::unused_self, reason = "`self` carries the test seam")]
    fn read_dir(&self, dir: &str) -> io::Result<std::fs::ReadDir> {
        #[cfg(test)]
        if self.fail_listing.as_deref() == Some(dir) {
            return Err(io::Error::other("injected listing failure"));
        }
        std::fs::read_dir(dir)
    }

    /// Record `dir` as unreadable, logging it the first time.
    fn note_unreadable(&mut self, dir: &str) {
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
    fn reconcile(
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
    fn tracks_under(&self, prefix: &str) -> bool {
        keys_under(&self.watched, prefix).next().is_some()
            || under(&self.unwatched, prefix).next().is_some()
            || under(&self.unreadable, prefix).next().is_some()
    }

    /// Drop every watch and all bookkeeping at or under `prefix` — its
    /// directory is gone, or no longer a directory. A watch notify already
    /// dropped (it does for removed and renamed-away directories) makes the
    /// unwatch a no-op error, ignored.
    fn drop_under(&mut self, prefix: &str) {
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

    fn is_watched(&self, dir: &str) -> bool {
        self.watched.contains_key(dir)
    }

    /// Allow watch attempts again after a limit was hit (watches may have
    /// been freed since).
    const fn retry_watches(&mut self) {
        self.limit_reached = false;
    }

    /// The topmost directories to poll — each not under another, so
    /// rescanning these covers every unwatched one once.
    fn unwatched_roots(&self) -> Vec<String> {
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

/// Walk `prefix` (a directory, [`dir_prefix`] form) on the calling blocking
/// thread: watch each directory, then list it, sending every regular file
/// found to `jobs` and descending into real subdirectories. Finishes with
/// [`DirWatches::reconcile`] over the directories it listed. `reset_watches`
/// first replaces the watcher ([`DirWatches::reset`]).
///
/// Watching before listing closes the race with concurrent writers: an entry
/// created before the watch lands is listed, and one created after is
/// reported by the watch (a file created before its directory's `Create`
/// event is handled is picked up by that directory's sync).
///
/// Staging files of `ScopedFs::write_file` are never yielded; orphaned ones
/// are deleted along the way (see [`sweep_orphaned_temp_file`]).
///
/// Only regular files are yielded and only real directories are descended
/// into (and watched) — entry types come from `DirEntry::file_type`, which
/// does not follow symlinks, so symlinks (and link loops) are skipped
/// entirely, as are FIFOs, sockets, and devices (reading a FIFO would block
/// the scan). Ignored and non-UTF-8 names are skipped with their subtrees.
///
/// Returns the directories whose listing failed transiently
/// ([`is_transient_list_error`]) — the caller keeps what's indexed under
/// them — or the error of listing `prefix` itself. Below `prefix`, an
/// unreadable or vanished directory is skipped.
fn walk_blocking(
    prefix: &str,
    ignored_dirs: &[PathBuf],
    watches: &mut DirWatches,
    reset_watches: bool,
    jobs: &mpsc::Sender<FileJob>,
) -> io::Result<Vec<String>> {
    if reset_watches {
        watches.reset();
    }
    let mut listed = BTreeSet::new();
    let mut unreadable = BTreeSet::new();
    let mut kept = Vec::new();
    let mut root_error = None;
    let mut stack = vec![prefix.to_owned()];
    while let Some(dir) = stack.pop() {
        let entries = match watches.attempt(&dir) {
            WatchAttempt::List => watches.read_dir(&dir),
            WatchAttempt::Denied => Err(io::ErrorKind::PermissionDenied.into()),
            WatchAttempt::Gone => Err(io::ErrorKind::NotFound.into()),
        };
        let entries = match entries {
            Ok(entries) => entries,
            Err(e) => {
                if e.kind() == io::ErrorKind::PermissionDenied {
                    watches.note_unreadable(&dir);
                    unreadable.insert(dir.clone());
                } else if is_transient_list_error(&e) {
                    tracing::warn!(path = %dir, error = %e, "failed to list a directory; retrying later");
                    kept.push(dir.clone());
                }
                if dir == prefix {
                    root_error = Some(e);
                }
                continue;
            }
        };
        listed.insert(dir.clone());
        for entry in entries {
            // a failed read mid-listing (`EIO`) leaves the rest unknown
            let Ok(entry) = entry else {
                kept.push(dir.clone());
                break;
            };
            let path = entry.path();
            // a non-UTF-8 name (file or directory — so its whole subtree) is
            // skipped, like an ignored one
            let Some(path_str) = path.to_str().map(str::to_owned) else {
                continue;
            };
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if crate::scoped_fs::is_temp_file_name(name) {
                if crate::scoped_fs::is_staged_write_file_name(name) {
                    sweep_orphaned_temp_file(&entry);
                }
                continue;
            }
            if is_ignored_name(name) || ignored_dirs.contains(&path) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(dir_prefix(&path_str));
                continue;
            }
            if !file_type.is_file() {
                // symlink, FIFO, socket, device
                continue;
            }
            // `DirEntry::metadata` is an `lstat` — never follows a link
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let job = FileJob {
                path,
                path_str,
                ctime: meta.created().ok().and_then(system_time_to_ms),
                mtime: meta.modified().ok().and_then(system_time_to_ms),
                stat: FileStat::of(&meta),
            };
            if jobs.blocking_send(job).is_err() {
                // the scan was dropped (its filer stopped) — a partial walk
                // must not reconcile away watches it never reached
                return Err(io::ErrorKind::Interrupted.into());
            }
        }
    }
    watches.reconcile(prefix, &listed, &unreadable, &kept);
    root_error.map_or(Ok(kept), Err)
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
fn sweep_orphaned_temp_file(entry: &std::fs::DirEntry) {
    let Ok(meta) = entry.metadata() else {
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
    match std::fs::remove_file(&path) {
        Ok(()) => tracing::info!(path = %path.display(), "removed an orphaned staged-write file"),
        Err(e) => {
            tracing::debug!(path = %path.display(), error = %e, "failed to remove an orphaned staged-write file");
        }
    }
}

// -- Filer --------------------------------------------------------------------

/// Where a filer sends its `filer_change` notifications (serialized
/// JSON-RPC messages).
pub type FilerBroadcast = Arc<dyn Fn(&str) + Send + Sync>;

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
/// Dropped when the filer is stopped: the event-loop task is aborted, which
/// drops its watches (notify cleans up on Drop).
pub struct Filer {
    /// Background task processing watcher events.
    task: tokio::task::JoinHandle<()>,
    /// In-memory file index. Written only by the event-loop task (initial
    /// scan aside); read by `session_load` / `workspace_open`.
    files: Arc<RwLock<FileIndex>>,
    /// Requests a full rescan on the event loop; the reply fires once the
    /// index matches the disk.
    rescan_tx: mpsc::Sender<oneshot::Sender<()>>,
    /// How many listed directories have no watch.
    unwatched_count: Arc<AtomicUsize>,
    #[cfg(test)]
    watches: Arc<Mutex<DirWatches>>,
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
                        tracing::warn!(error = %e, "file watcher error");
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
                event
                    .paths
                    .retain(|p| !is_ignored(p, &root, &ignored_dirs));
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
            tracing::warn!(path, error = %e, "failed to create a file watcher; rescanning periodically instead");
        })
        .ok()
    })
}

/// Start watching a directory, perform an initial file scan, and return a `Filer`.
///
/// `path` is the root in [`dir_prefix`] form. The initial scan (walk,
/// watches, reads) populates the file index before returning, so callers can
/// immediately read it; it runs on blocking threads. The background task
/// then keeps the index updated and broadcasts changes.
///
/// # Errors
///
/// Fails only when the root itself can't be listed — unreadable
/// (`PermissionDenied`), missing (`NotFound`), or not a directory. Every
/// other failure is per directory (skipped, or left unwatched in degraded
/// mode), including failing to create the watcher at all.
pub async fn start_filer(
    path: &str,
    broadcast: FilerBroadcast,
    config: FilerConfig,
) -> io::Result<Filer> {
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
        &watches,
        false,
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
        files: Arc::clone(&files),
        pending: HashMap::new(),
        watches: Arc::clone(&watches),
        unwatched_count: Arc::clone(&unwatched_count),
        degraded_rescan_interval: config.degraded_rescan_interval,
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

/// One file discovered by the walk — input to the read phase.
struct FileJob {
    path: PathBuf,
    path_str: String,
    ctime: Option<f64>,
    mtime: Option<f64>,
    stat: FileStat,
}

/// Scan `prefix` (a directory, [`dir_prefix`] form): walk it on a blocking
/// thread — adding watches as it goes, see [`walk_blocking`] — while reading
/// the files it finds concurrently.
///
/// The walker streams `FileJob`s through a bounded channel and
/// `buffer_unordered` fans out up to [`MAX_CONCURRENT_FILE_READS`] reads at a
/// time (see [`read_indexable_contents`]), so the walk and the reads overlap
/// and peak memory stays flat in tree size. Files over
/// [`MAX_INDEXED_FILE_SIZE`] skip the read and store `contents: None`. A file
/// whose `known` node has the same [`FileStat`] isn't read at all
/// ([`ScannedFile::Unchanged`]).
///
/// Called by `start_filer` (cold path) and by the event loop's subtree
/// syncs and rescans (hot path — `session_load` rescans every filer).
///
/// Returns the files found plus the directories whose listing failed
/// transiently (see [`walk_blocking`]).
///
/// # Errors
///
/// The error of listing `prefix` itself (see [`walk_blocking`]).
async fn scan_directory(
    prefix: &str,
    source_dir: &str,
    ignored_dirs: &[PathBuf],
    watches: &Arc<Mutex<DirWatches>>,
    reset_watches: bool,
    known: Option<&RwLock<FileIndex>>,
) -> io::Result<(ScanIndex, Vec<String>)> {
    let (job_tx, job_rx) = mpsc::channel::<FileJob>(WALK_CHANNEL_CAPACITY);
    let walk = {
        let prefix = prefix.to_owned();
        let ignored_dirs = ignored_dirs.to_vec();
        let watches = Arc::clone(watches);
        tokio::task::spawn_blocking(move || {
            walk_blocking(
                &prefix,
                &ignored_dirs,
                &mut watches.lock(),
                reset_watches,
                &job_tx,
            )
        })
    };
    let jobs = stream::unfold(job_rx, |mut rx| async move {
        rx.recv().await.map(|job| (job, rx))
    });
    let reads = jobs
        .map(|job| scan_file(job, source_dir, known))
        .buffer_unordered(MAX_CONCURRENT_FILE_READS);
    // `stream::unfold`'s state future is `!Unpin`, so the composed stream
    // needs pinning before `.next()`. `std::pin::pin!` puts it on the local
    // stack — no heap allocation.
    let mut reads = std::pin::pin!(reads);

    let mut fresh = ScanIndex::new();
    while let Some((path_str, scanned)) = reads.next().await {
        fresh.insert(path_str, scanned);
    }
    let kept = walk.await.map_err(io::Error::other)??;
    Ok((fresh, kept))
}

/// Read one walked file, or report it unchanged when `known` indexes it
/// with the same [`FileStat`].
async fn scan_file(
    job: FileJob,
    source_dir: &str,
    known: Option<&RwLock<FileIndex>>,
) -> (String, ScannedFile) {
    let unchanged = match known {
        Some(known) => known
            .read()
            .await
            .get(&job.path_str)
            .is_some_and(|node| node.stat == Some(job.stat)),
        None => false,
    };
    if unchanged {
        return (job.path_str, ScannedFile::Unchanged);
    }
    let contents = if job.stat.size > MAX_INDEXED_FILE_SIZE {
        None
    } else {
        read_indexable_contents(job.path).await
    };
    let stat = reusable_stat(
        job.stat,
        contents.as_ref().map(String::len),
        SystemTime::now(),
    );
    let node = make_disknode(
        job.path_str.clone(),
        source_dir,
        contents,
        job.ctime,
        job.mtime,
        stat,
    );
    (job.path_str, ScannedFile::Read(Box::new(node)))
}

// -- Event loop ---------------------------------------------------------------

/// State owned by a filer's event-loop task: the index (shared for reads),
/// the directory watches, and the pending debounced broadcasts.
struct FilerState {
    source_dir: String,
    ignored_dirs: Vec<PathBuf>,
    files: Arc<RwLock<FileIndex>>,
    /// Keyed by index path.
    pending: HashMap<String, PendingNotification>,
    watches: Arc<Mutex<DirWatches>>,
    /// `DirWatches::unwatched_count`, readable without the lock.
    unwatched_count: Arc<AtomicUsize>,
    degraded_rescan_interval: Duration,
}

impl FilerState {
    /// Apply one notify event to the index and the pending broadcasts.
    async fn handle_event(&mut self, event: notify::Event) {
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
        match tokio::fs::symlink_metadata(path).await {
            Ok(meta) if meta.is_file() => {
                self.remove_children(&path_str).await;
                let node = read_disknode(path, path_str.clone(), &self.source_dir, &meta).await;
                self.upsert(path_str, node).await;
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

    /// Insert or update one file, queueing `add` (newly indexed) or
    /// `change` (indexed, and differs). An unchanged file only has its stored
    /// [`FileStat`] refreshed.
    async fn upsert(&mut self, path: String, node: SerializableDisknode) {
        let change = {
            let mut index = self.files.write().await;
            match index.get_mut(&path) {
                None => {
                    index.insert(path.clone(), node.clone());
                    Some(ChangeType::Add)
                }
                Some(old) if disknode_changed(old, &node) => {
                    *old = node.clone();
                    Some(ChangeType::Change)
                }
                Some(old) => {
                    old.stat = node.stat;
                    None
                }
            }
        };
        if let Some(change) = change {
            self.queue(path, change, node);
        }
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
            &self.watches,
            reset_watches,
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
    async fn rescan(&mut self, reset_watches: bool) {
        self.watches.lock().retry_watches();
        let root = self.source_dir.clone();
        self.sync_subtree(&root, reset_watches).await;
    }

    /// Degraded mode: rescan each directory without a watch (each unwatched
    /// subtree once), retrying their watches.
    async fn rescan_unwatched(&mut self) {
        let roots = {
            let mut watches = self.watches.lock();
            watches.retry_watches();
            watches.unwatched_roots()
        };
        for root in roots {
            self.sync_subtree(&root, false).await;
        }
    }

    fn is_degraded(&self) -> bool {
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
async fn filer_event_loop(
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
                // `session_load`s share it instead of re-reading the tree
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

        for ready in state.take_ready(Instant::now()) {
            let params = FilerChangeParams {
                change: DiskfileChange {
                    change_type: ready.change_type,
                    path: ready.disknode.id.clone(),
                },
                disknode: ready.disknode,
            };
            let notification = fuz_http::notification("filer_change", &params);
            broadcast(&notification);
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
    /// A gate per path whose filer is being started, so concurrent starts
    /// of one path share a single initial scan: the first scans, the rest
    /// wait for it and adopt its filer.
    starting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Test seam: how many initial scans ran.
    #[cfg(test)]
    scans: AtomicUsize,
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
    /// the new request is `Permanent` (but never downgraded).
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
        if self.adopt(path, lifetime).await {
            return Ok(false);
        }

        let gate = Arc::clone(self.starting.lock().entry(path.to_owned()).or_default());
        let started = async {
            let _gate = gate.lock().await;
            // another start of this path finished while this one waited
            if self.adopt(path, lifetime).await {
                return Ok(false);
            }
            #[cfg(test)]
            self.scans.fetch_add(1, Ordering::Relaxed);
            let filer = start_filer(path, broadcast, config).await?;
            let mut filers = self.filers.write().await;
            if filers.contains_key(path) {
                return Ok(false);
            }
            filers.insert(path.to_owned(), FilerEntry { filer, lifetime });
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

    /// Whether a filer already watches `path` — upgrading its lifetime to
    /// `Permanent` if `lifetime` is (never downgrading it).
    async fn adopt(&self, path: &str, lifetime: FilerLifetime) -> bool {
        let filers = self.filers.read().await;
        let Some(entry) = filers.get(path) else {
            return false;
        };
        if lifetime == FilerLifetime::Permanent && entry.lifetime == FilerLifetime::Workspace {
            drop(filers);
            if let Some(entry) = self.filers.write().await.get_mut(path) {
                entry.lifetime = FilerLifetime::Permanent;
            }
        }
        true
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
    /// Called by `session_load` before `snapshot` to guarantee a
    /// consistent snapshot — notify events are eventually consistent, so a
    /// just-written file may not yet be in the index when the event loop is
    /// still draining. A direct filesystem walk sidesteps that race; files
    /// whose `lstat` is unchanged aren't re-read. The rescans run on each
    /// filer's event loop, so they serialize with event handling instead of
    /// racing it.
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

    /// The watch status of the filer watching exactly `path` (trailing
    /// slash); `Full` if no filer watches it.
    pub async fn watch_status_for(&self, path: &str) -> WatchStatus {
        self.filers
            .read()
            .await
            .get(path)
            .map_or(WatchStatus::Full, |e| e.filer.watch_status())
    }

    /// Every active filer's root and indexed files, as one snapshot. Used by
    /// `session_load` to return the complete file listing.
    ///
    /// The roots and file indexes are taken under one read of the filer map,
    /// so `roots` names exactly the filers `files` comes from: a file under a
    /// root that's missing from `files` isn't on disk (or isn't indexed —
    /// ignored, a symlink, non-UTF-8).
    pub async fn snapshot(&self) -> FilerSnapshot {
        // Collect Arc handles under the outer lock, then release it before
        // awaiting the inner per-filer locks — avoids holding the manager
        // lock across await points (which would block start_filer/stop_filer).
        let (mut roots, file_maps): (Vec<String>, Vec<Arc<RwLock<FileIndex>>>) = {
            let filers = self.filers.read().await;
            filers
                .iter()
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
            None,
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
        let mut fresh = ScanIndex::new();
        for n in [
            node("/w/d/same", "s", 1.0),
            node("/w/d/edited", "new", 2.0),
            node("/w/d/new", "n", 1.0),
        ] {
            fresh.insert(n.id.clone(), ScannedFile::Read(Box::new(n)));
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

    /// A factory of real watchers whose events go to `sink`.
    fn factory_into(sink: Arc<Mutex<Vec<PathBuf>>>) -> WatcherFactory {
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
    fn watches_for(root: &str, watch_limit: Option<usize>) -> Arc<Mutex<DirWatches>> {
        Arc::new(Mutex::new(DirWatches::new(
            factory_into(Arc::default()),
            root,
            watch_limit,
        )))
    }

    /// The initial scan of `root`, as `start_filer` runs it.
    async fn scan_into(
        root: &str,
        ignored_dirs: &[PathBuf],
        watches: &Arc<Mutex<DirWatches>>,
    ) -> FileIndex {
        let fresh = tokio::time::timeout(
            Duration::from_secs(10),
            scan_directory(root, root, ignored_dirs, watches, false, None),
        )
        .await
        .expect("scan must terminate")
        .expect("the root is listable")
        .0;
        let mut files = FileIndex::new();
        apply_subtree(&mut files, root, fresh);
        files
    }

    async fn scan_with(root: &str, ignored_dirs: &[PathBuf]) -> FileIndex {
        scan_into(root, ignored_dirs, &watches_for(root, None)).await
    }

    async fn scan(root: &str) -> FileIndex {
        scan_with(root, &[]).await
    }

    async fn state_with(tmp: &TempDir, ignored_dirs: Vec<PathBuf>) -> FilerState {
        state_watched_by(tmp, ignored_dirs, watches_for(&tmp.root(), None)).await
    }

    async fn state_watched_by(
        tmp: &TempDir,
        ignored_dirs: Vec<PathBuf>,
        watches: Arc<Mutex<DirWatches>>,
    ) -> FilerState {
        let root = tmp.root();
        let files = scan_into(&root, &ignored_dirs, &watches).await;
        watches.lock().poll_missing_root = true;
        let unwatched_count = Arc::clone(&watches.lock().unwatched_count);
        FilerState {
            source_dir: root,
            ignored_dirs,
            files: Arc::new(RwLock::new(files)),
            pending: HashMap::new(),
            watches,
            unwatched_count,
            degraded_rescan_interval: DEGRADED_RESCAN_INTERVAL,
        }
    }

    async fn state_for(tmp: &TempDir) -> FilerState {
        state_with(tmp, vec![]).await
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
        state.rescan(false).await;
        assert_eq!(indexed(&state).await, vec![tmp.key("a.txt")]);
        assert!(state.pending.is_empty(), "{:?}", pending_of(&state));
    }

    #[tokio::test]
    async fn the_walk_sweeps_only_old_exact_staging_files() {
        use crate::scoped_fs::TEMP_FILE_PREFIX;

        let tmp = TempDir::new();
        let hex = "0123456789abcdef0123456789abcdef";
        let old = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        let make = |name: &str, age: Option<SystemTime>| {
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
        let files = scan_with(&root, &config.ignored_dirs).await;
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

        let mut state = state_with(&tmp, config.ignored_dirs).await;
        assert_eq!(
            indexed(&state).await,
            vec![tmp.key("data/f.txt"), tmp.key("src/data/f.txt")]
        );
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

    // -- stat reuse -----------------------------------------------------------

    #[tokio::test]
    async fn rescans_reuse_unchanged_files_and_reread_changed_ones() {
        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "one").unwrap();
        // a stamp is only trusted once the file has been still for a while
        tokio::time::sleep(RACY_STAT_MARGIN + Duration::from_millis(100)).await;
        let mut state = state_for(&tmp).await;
        let key = tmp.key("f.txt");
        assert!(state.files.read().await[&key].stat.is_some());

        // an unchanged stat keeps the indexed node — the file isn't re-read
        state.files.write().await.get_mut(&key).unwrap().contents = Some("sentinel".to_owned());
        state.rescan(false).await;
        assert!(state.pending.is_empty());
        assert_eq!(
            state.files.read().await[&key].contents.as_deref(),
            Some("sentinel")
        );

        // a same-size rewrite that restores the mtime still moves the ctime
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
            state.files.read().await[&key].contents.as_deref(),
            Some("two")
        );
    }

    // -- per-directory watches ------------------------------------------------

    /// A running filer on `tmp`, its broadcasts dropped.
    async fn start(tmp: &TempDir, config: FilerConfig) -> Filer {
        start_filer(&tmp.root(), Arc::new(|_: &str| {}), config)
            .await
            .expect("the filer starts")
    }

    async fn keys_of(filer: &Filer) -> Vec<String> {
        filer.files.read().await.keys().cloned().collect()
    }

    fn watched_dirs(filer: &Filer) -> Vec<String> {
        filer.watches.lock().watched.keys().cloned().collect()
    }

    /// Wait (up to 10s) until `filer`'s indexed paths equal `expected`.
    async fn wait_for_keys(filer: &Filer, expected: &[String]) {
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
    struct Unlock(PathBuf);

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
    fn lock_dir(path: &Path) -> Option<Unlock> {
        set_mode(path, 0o000);
        let unlock = Unlock(path.to_path_buf());
        std::fs::read_dir(path).is_err().then_some(unlock)
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
    async fn an_unreadable_or_missing_root_fails_to_start() {
        let missing = TempDir::new();
        let root = missing.root();
        std::fs::remove_dir(&missing.0).unwrap();
        let error = start_filer(&root, Arc::new(|_: &str| {}), FilerConfig::zzz_dir())
            .await
            .err()
            .expect("a missing root fails");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);

        let tmp = TempDir::new();
        std::fs::write(tmp.path("a.txt"), "a").unwrap();
        let Some(_unlock) = lock_dir(&tmp.0) else {
            return;
        };
        let error = start_filer(&tmp.root(), Arc::new(|_: &str| {}), FilerConfig::zzz_dir())
            .await
            .err()
            .expect("an unreadable root fails");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
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
        let config = FilerConfig::workspace(&tmp.root(), &dir_prefix(&tmp.key("app/data")));
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

    // -- round 2: no watcher, aliasing, racy stats, transient errors ----------

    #[test]
    fn reusable_stat_follows_the_racily_clean_rule() {
        let stat = FileStat {
            dev: 1,
            ino: 2,
            size: 4,
            mtime: (1_000, 0),
            change_time: (1_000, 500),
        };
        let at = |secs: u64, millis: u64| {
            std::time::UNIX_EPOCH + Duration::from_secs(secs) + Duration::from_millis(millis)
        };
        // still for the whole margin — trusted
        assert_eq!(reusable_stat(stat, Some(4), at(1_002, 1)), Some(stat));
        assert_eq!(reusable_stat(stat, None, at(1_002, 1)), Some(stat));
        // changed within the margin of the read (by ctime) — not trusted
        assert_eq!(reusable_stat(stat, Some(4), at(1_002, 0)), None);
        assert_eq!(reusable_stat(stat, Some(4), at(1_000, 0)), None);
        // the read saw a different size than the stat — raced a write
        assert_eq!(reusable_stat(stat, Some(5), at(9_999, 0)), None);
    }

    #[tokio::test]
    async fn same_tick_rewrites_are_never_served_stale() {
        use std::io::{Seek, SeekFrom, Write};

        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "AAAA").unwrap();
        let mut state = state_for(&tmp).await;
        let key = tmp.key("f.txt");
        for i in 0..50 {
            let (a, b) = (format!("{:04}", i * 2), format!("{:04}", i * 2 + 1));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .open(tmp.path("f.txt"))
                .unwrap();
            file.write_all(a.as_bytes()).unwrap();
            state.rescan(false).await;
            // a second same-size write, likely inside the same timestamp tick
            file.seek(SeekFrom::Start(0)).unwrap();
            file.write_all(b.as_bytes()).unwrap();
            drop(file);
            state.rescan(false).await;
            assert_eq!(
                state.files.read().await[&key].contents.as_deref(),
                Some(b.as_str()),
                "iteration {i}"
            );
        }
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
            files: Arc::default(),
            pending: HashMap::new(),
            watches: Arc::clone(&watches),
            unwatched_count,
            degraded_rescan_interval: DEGRADED_RESCAN_INTERVAL,
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
                FilerLifetime::Workspace,
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
        let snapshot = manager.snapshot().await;
        assert!(snapshot.roots.is_empty() && snapshot.files.is_empty());

        for (tmp, lifetime) in [(&a, FilerLifetime::Permanent), (&b, FilerLifetime::Workspace)] {
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
        let snapshot = manager.snapshot().await;
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
        let snapshot = manager.snapshot().await;
        assert_eq!(snapshot.roots, vec![a.root()]);
        assert_eq!(snapshot.files.len(), 1);
    }
}
