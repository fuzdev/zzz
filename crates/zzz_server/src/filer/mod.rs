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
//!   path to look at ([`classify_event`](watches::classify_event)); the filer then `lstat`s the path
//!   and decides from what is on disk — even for removes and rename-froms,
//!   since events can arrive late or out of order (a backlog behind
//!   `rm -rf src && git checkout src`, or macOS `FSEvents` reporting create before
//!   remove). `add` vs `change` comes from whether the path was already
//!   indexed, not from the event kind, so renames and short-lived files
//!   resolve to the right broadcast. A directory that appears (created,
//!   renamed in, or recreated) has its subtree synced; a path that is gone
//!   takes every indexed file under it along.
//! - **Per-directory watches.** The filer adds one non-recursive watch per
//!   directory from its own walk ([`DirWatches`](watches::DirWatches)), so ignored directories
//!   (`node_modules/`, `target/`, …), symlinks, non-UTF-8 directories, and the
//!   app dir are never watched — a root needs a watch per directory it
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
//! - **Stat-only.** The index holds each file's identity, size, timestamps,
//!   and `lstat` stamp ([`FileStat`]) — never its contents. A scan or an
//!   event costs an `lstat` per file and reads nothing; a client reads a
//!   file's contents from the disk with `diskfile_read`, and `filer_change`,
//!   `session_load`, and `project_open` send the metadata alone.
//! - **Change by stamp.** A file whose fresh stamp matches its indexed one is
//!   unchanged, and nothing is broadcast; any other is a `change` with the
//!   new metadata — a `touch` and a rewrite of the same bytes included — and
//!   a client holding the file's contents reads them again. A stamp is
//!   trusted only once its inode change time is a while old
//!   ([`reusable_stat`](index::reusable_stat), git's "racily clean" rule), so a file looked at
//!   while it might still be written is a `change` the next time too,
//!   whether or not its stamp moved ([`is_unchanged`](index::is_unchanged)). A write the stamp
//!   can't see (an `mmap` store to an already-dirty page, a remote
//!   filesystem whose server clock lags by more than the margin) goes
//!   unnoticed until the stamp next moves.
//! - **Debounce coalescing.** Broadcasts are debounced per path
//!   ([`coalesce_change`](event_loop::coalesce_change)): a `delete` followed by an `add` inside the window
//!   becomes `change`, and an `add` followed by a `delete` becomes a bare
//!   `delete` (a no-op for clients that never saw the add). A path that
//!   keeps changing still broadcasts at least every [`DEBOUNCE_MAX_WAIT`](event_loop::DEBOUNCE_MAX_WAIT).
//! - **Overflow recovery.** Paths under ignored directories are filtered in
//!   the notify callback, before the bounded channel. If the channel is
//!   still full, or notify reports a rescan (inotify queue overflow), the
//!   filer schedules one coalesced rescan of its root, which rebuilds the
//!   watches on a fresh watcher ([`DirWatches::reset`](watches::DirWatches::reset)), diffs the index
//!   against the disk, and broadcasts the differences.
//! - **Symlinks are skipped entirely** — consistent with `ScopedFs`'s
//!   no-symlink rule. The walker never follows or indexes a symlink (file or
//!   directory), so no watch is added through one, and an event whose path is
//!   a symlink resolves as "not indexable". This keeps link loops
//!   (`up -> ..`, a Wine prefix's `dosdevices/z: -> /`) from hanging the
//!   scan, and keeps files outside the watched root out of the index.
//!
//! The walk and the watch calls block (directory reads and `lstat`s, a round
//! trip to notify's watcher thread per watch), so they run on a blocking
//! thread (`spawn_blocking`), never on an async worker.

use self::index::FileStat;
#[cfg(test)]
use self::index::make_disknode;
use serde::Serialize;
use std::collections::BTreeSet;
use std::ops::Bound;
use std::path::Path;
use std::time::{Duration, SystemTime};

mod core;
mod event_loop;
mod index;
mod manager;
#[cfg(test)]
mod test_support;
mod walk;
mod watches;

pub use self::core::{Filer, FilerBroadcast, FilerConfig, FilerDepth, start_filer};
pub(crate) use self::index::system_time_to_ms;
pub use self::manager::{FilerEntry, FilerLifetime, FilerManager, FilerSnapshot};

// -- Indexing limits ----------------------------------------------------------

/// Capacity of the notify → event-loop channel. Ignored paths are filtered
/// before the send, so this only has to absorb bursts in indexed paths; on
/// overflow the filer falls back to a coalesced rescan of its root.
const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// Capacity of the walker → scan channel. The blocking walker sends each
/// file's `lstat` ahead of the scan that compares it with the index by at
/// most this many files, and stops once the scan is dropped (its filer
/// stopped) and the channel closes.
const WALK_CHANNEL_CAPACITY: usize = 256;

/// Shortest interval between rescans of the directories a degraded filer
/// couldn't watch. The actual interval also scales with how long the last
/// one took ([`DEGRADED_RESCAN_COST_FACTOR`]), so a huge unwatched tree
/// isn't rescanned back to back.
const DEGRADED_RESCAN_INTERVAL: Duration = Duration::from_secs(5);

/// A degraded rescan waits at least this many times its own duration before
/// the next one — at most ~10% of a thread spent polling.
const DEGRADED_RESCAN_COST_FACTOR: u32 = 10;

/// How long before a stamp was taken the file's inode change time must lie
/// for the stamp to be trusted to say the file is unchanged — see
/// [`reusable_stat`](index::reusable_stat). Strictly longer than the coarsest timestamp tick a
/// filesystem keeps (often a jiffy, whole seconds on some, two seconds on
/// FAT) plus the lag of the coarse clock inode times are taken from behind
/// the wall clock (up to a jiffy).
const RACY_STAT_MARGIN: Duration = Duration::from_secs(3);

/// The wall clock a filer judges stamps against ([`reusable_stat`](index::reusable_stat)):
/// `SystemTime::now`, or a test's.
type Clock = fn() -> SystemTime;

// -- Notification params ------------------------------------------------------

/// Params for `filer_change` `remote_notification`.
///
/// Matches the TypeScript `filer_change_action_spec` input schema:
/// `{ change: DiskfileChange, disknode: SerializableDisknode }`.
#[derive(Serialize)]
struct FilerChangeParams<'a> {
    change: DiskfileChange,
    disknode: &'a SerializableDisknode,
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
    /// Newly indexed.
    Add,
    /// Indexed, and not known to be unchanged — its `lstat` stamp moved, or
    /// the indexed one wasn't trusted (see [`is_unchanged`](index::is_unchanged)).
    Change,
    Delete,
}

/// Matches `SerializableDisknode` from `diskfile_types.ts`: the file's
/// identity, size, and timestamps — never its contents, which a client reads
/// with `diskfile_read`.
#[derive(Serialize, Clone, Debug)]
pub struct SerializableDisknode {
    pub id: String,
    pub source_dir: String,
    /// The file's size in bytes, from the `lstat` the node was made from.
    /// `None` for a `delete`'s node, which is identity only.
    pub size: Option<u64>,
    pub ctime: Option<f64>,
    pub mtime: Option<f64>,
    /// The stamp of the `lstat` the node was made from, when it's trusted
    /// ([`reusable_stat`](index::reusable_stat)) — a later `lstat` with the same stamp means the
    /// file is unchanged ([`is_unchanged`](index::is_unchanged)). Not part of the wire shape.
    #[serde(skip)]
    stat: Option<FileStat>,
}

/// An estimate of the serialized size in bytes of `nodes` as a JSON array.
///
/// Counts every node's paths plus its keys, for sizing a response buffer up
/// front (`session_load`, `project_open`). A path JSON escapes (quotes,
/// backslashes, control characters) renders longer, and the buffer grows past
/// the estimate as needed.
pub fn disknodes_json_size_hint(nodes: &[SerializableDisknode]) -> usize {
    /// The keys, punctuation, size, and two timestamps of a node.
    const NODE_OVERHEAD: usize = 96;
    nodes.iter().fold(2, |total, node| {
        total + NODE_OVERHEAD + node.id.len() + node.source_dir.len()
    })
}

#[cfg(test)]
impl SerializableDisknode {
    /// A node with the given identity, size, and timestamps — for tests
    /// outside this module, which can't name `stat`.
    pub(crate) fn for_test(id: &str, size: Option<u64>, mtime: Option<f64>) -> Self {
        make_disknode(id.to_owned(), "/w/", size, mtime, mtime, None)
    }
}

/// Whether every directory a filer indexes has a watch — returned by
/// `project_open` as `watch_status`.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disknode_serializes_to_its_wire_shape() {
        let node = SerializableDisknode::for_test("/w/a.txt", Some(9), Some(2.5));
        assert_eq!(
            serde_json::to_value(&node).unwrap(),
            serde_json::json!({
                "id": "/w/a.txt",
                "source_dir": "/w/",
                "size": 9,
                "ctime": 2.5,
                "mtime": 2.5,
            })
        );
        let big = SerializableDisknode::for_test("/w/big.bin", Some(5_000_000), None);
        assert_eq!(
            serde_json::to_value(&big).unwrap(),
            serde_json::json!({
                "id": "/w/big.bin",
                "source_dir": "/w/",
                "size": 5_000_000,
                "ctime": null,
                "mtime": null,
            })
        );
    }

    #[test]
    fn disknodes_size_hint_tracks_the_rendered_size() {
        let nodes: Vec<SerializableDisknode> = (0..10)
            .map(|i| {
                SerializableDisknode::for_test(
                    &format!("/w/dir/file_{i}.txt"),
                    Some(10_000),
                    Some(1_700_000_000_000.25),
                )
            })
            .collect();
        let rendered = serde_json::to_string(&nodes).unwrap().len();
        let hint = disknodes_json_size_hint(&nodes);
        assert!(
            hint.abs_diff(rendered) * 10 <= rendered,
            "hint {hint} off rendered {rendered} by over 10%"
        );
        assert_eq!(disknodes_json_size_hint(&[]), "[]".len());
    }
}
