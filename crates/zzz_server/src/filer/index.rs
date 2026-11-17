//! The index's file metadata: `lstat` stamps, disknodes, and the diff of a scanned subtree.

use super::{ChangeType, RACY_STAT_MARGIN, SerializableDisknode};
use std::collections::BTreeMap;
use std::ops::Bound;
use std::time::SystemTime;

/// A filer's in-memory index, keyed by absolute file path. Ordered so a
/// directory's files are one contiguous prefix range.
pub(super) type FileIndex = BTreeMap<String, SerializableDisknode>;

// -- File metadata helpers ----------------------------------------------------

/// Convert a `SystemTime` to milliseconds since epoch (matching JS `Date` format).
#[expect(
    clippy::redundant_pub_crate,
    reason = "re-exported as `pub(crate)` from `filer`; the module itself is private"
)]
pub(crate) fn system_time_to_ms(t: SystemTime) -> Option<f64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64() * 1000.0)
}

/// A regular file's identity and change stamps from `lstat`.
///
/// An indexed file whose fresh `FileStat` equals its trusted indexed one is
/// unchanged ([`is_unchanged`]). `change_time` is `st_ctime`, the inode
/// change time — not the disknode's wire `ctime`, which is the birth time.
/// It moves on every write, truncate, `utimes`, chmod, chown, xattr write,
/// link, and rename, and can't be set from userspace on a kernel-managed
/// filesystem (a FUSE one may report `mtime` instead — see
/// `docs/architecture.md` § Known Limitations), so a rewrite that keeps the
/// size and restores `mtime` (`touch -r`) still moves the stamp — and so
/// does a metadata-only change, which broadcasts a `change` whose
/// wire metadata is the same as before (accepted: a client re-reads and
/// finds the same text).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FileStat {
    dev: u64,
    ino: u64,
    pub(super) size: u64,
    mtime: (i64, i64),
    change_time: (i64, i64),
}

impl FileStat {
    pub(super) fn of(meta: &std::fs::Metadata) -> Self {
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

/// The stamp to index for a file `lstat`ed at `observed_at` — or `None`
/// when a later look mustn't trust it, git's "racily clean" rule.
///
/// Timestamps have filesystem granularity (often a jiffy, whole seconds on
/// some filesystems, two seconds on FAT), so a write inside the same tick as
/// the one before it can leave the size, `mtime`, and `ctime` all as they
/// were. A stamp is trusted only when its inode change time (`st_ctime`)
/// lies more than [`RACY_STAT_MARGIN`] before `observed_at`, which the
/// caller reads before the `lstat`: any write after the `lstat` then sets a
/// change time in a later tick, and moves the stamp. Only the change time
/// counts — every write, truncate, and `utimes` moves it, and userspace
/// can't set it on a kernel-managed filesystem — so an `mtime` in the future (an archive from a clock
/// ahead, `touch -d tomorrow`, `cp -p`) doesn't keep a still file untrusted.
/// An untrusted stamp makes the next look at the file a `change` whatever
/// it finds ([`is_unchanged`]).
pub(super) fn reusable_stat(stat: FileStat, observed_at: SystemTime) -> Option<FileStat> {
    let observed_at = observed_at
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i128::try_from(d.as_nanos()).ok())?;
    let margin = i128::try_from(RACY_STAT_MARGIN.as_nanos()).ok()?;
    (observed_at - stamp_nanos(stat.change_time) > margin).then_some(stat)
}

/// Whether an indexed file whose node holds `indexed` (its trusted stamp, or
/// `None`) is unchanged on disk, by a fresh `lstat`'s `stat`.
///
/// Only a trusted stamp that matches exactly says so. A moved stamp is a
/// change — a `touch` and a rewrite of the same bytes too, since the stamp
/// can't tell them from a real edit — and so is any untrusted one, even
/// matching, since a same-size write inside the timestamp tick it was taken
/// in leaves it as it was. Either way a `change` costs a client holding the
/// file a re-read that finds the same text. Rescans and watch events alike
/// decide by this; a matching trusted stamp on an event is a stale or
/// duplicate report, and nothing is broadcast.
///
/// TODO: hashing a file's bytes when its stamp moves could tell a touch from
/// an edit and spare clients a touch storm's `change`s — only if one is
/// measured to matter.
pub(super) fn is_unchanged(indexed: Option<FileStat>, stat: FileStat) -> bool {
    indexed == Some(stat)
}

/// Construct a `SerializableDisknode` from its components.
pub(super) fn make_disknode(
    id: String,
    source_dir: &str,
    size: Option<u64>,
    ctime: Option<f64>,
    mtime: Option<f64>,
    stat: Option<FileStat>,
) -> SerializableDisknode {
    SerializableDisknode {
        id,
        source_dir: source_dir.to_owned(),
        size,
        ctime,
        mtime,
        stat,
    }
}

/// The disknode broadcast with a `delete` — identity only.
pub(super) fn deleted_disknode(node: SerializableDisknode) -> SerializableDisknode {
    make_disknode(node.id, &node.source_dir, None, None, None, None)
}

/// A regular file's disknode from its (non-following) metadata, `lstat`ed
/// at `observed_at` (see [`reusable_stat`]).
pub(super) fn stat_disknode(
    path_str: String,
    source_dir: &str,
    meta: &std::fs::Metadata,
    observed_at: SystemTime,
) -> SerializableDisknode {
    make_disknode(
        path_str,
        source_dir,
        Some(meta.len()),
        meta.created().ok().and_then(system_time_to_ms),
        meta.modified().ok().and_then(system_time_to_ms),
        reusable_stat(FileStat::of(meta), observed_at),
    )
}

/// One file found by a scan: unchanged since it was indexed (its trusted
/// [`FileStat`] matched, so the indexed node stands — [`is_unchanged`]), or
/// its node from this scan's `lstat` — new, or not known to be unchanged.
#[derive(Debug)]
pub(super) enum ScannedFile {
    Unchanged,
    Updated(Box<SerializableDisknode>),
}

/// The files a scan found, keyed like the index.
pub(super) type ScanIndex = BTreeMap<String, ScannedFile>;

/// Replace the index entries under `prefix` with `fresh` (a scan of that
/// subtree), returning the resulting changes: nothing for an unchanged
/// entry, a `change` for an updated one, an `add` for a new one, and a
/// `delete` for one the scan didn't find.
///
/// @mutates index - entries under `prefix` are inserted, replaced, or removed to match `fresh`
pub(super) fn apply_subtree(
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
            Some(ScannedFile::Updated(node)) => {
                index.insert(key.clone(), (*node).clone());
                changes.push((key, ChangeType::Change, *node));
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
        if let ScannedFile::Updated(node) = scanned {
            index.insert(key.clone(), (*node).clone());
            changes.push((key, ChangeType::Add, *node));
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::test_support::node;
    use std::time::Duration;

    #[test]
    fn only_a_matching_trusted_stamp_is_unchanged() {
        let stat = FileStat {
            dev: 1,
            ino: 2,
            size: 4,
            mtime: (1_000, 0),
            change_time: (1_000, 500),
        };
        assert!(is_unchanged(Some(stat), stat));
        // an untrusted stamp says nothing, even matching — a same-size write
        // inside its tick would look just like this
        assert!(!is_unchanged(None, stat));
        // any part of the stamp moved: a touch, a rewrite of the same bytes,
        // `touch -r` after a write (only the ctime moves), a replaced inode
        for moved in [
            FileStat { dev: 9, ..stat },
            FileStat { ino: 9, ..stat },
            FileStat { size: 5, ..stat },
            FileStat {
                mtime: (1_000, 1),
                ..stat
            },
            FileStat {
                change_time: (1_000, 501),
                ..stat
            },
        ] {
            assert!(!is_unchanged(Some(stat), moved), "{moved:?}");
        }
    }

    #[test]
    fn apply_subtree_diffs_only_under_prefix() {
        let mut index = FileIndex::new();
        for n in [
            node("/w/d/same", 1, 1.0),
            node("/w/d/touched", 1, 1.0),
            node("/w/d/gone", 1, 1.0),
            node("/w/d2/sibling", 1, 1.0),
            node("/w/top", 1, 1.0),
        ] {
            index.insert(n.id.clone(), n);
        }
        let mut fresh = ScanIndex::new();
        fresh.insert("/w/d/same".to_owned(), ScannedFile::Unchanged);
        for n in [node("/w/d/touched", 1, 2.0), node("/w/d/new", 1, 1.0)] {
            fresh.insert(n.id.clone(), ScannedFile::Updated(Box::new(n)));
        }

        let mut changes: Vec<(String, ChangeType, Option<f64>)> =
            apply_subtree(&mut index, "/w/d/", fresh)
                .into_iter()
                .map(|(path, change, node)| (path, change, node.mtime))
                .collect();
        changes.sort_by(|a, b| a.0.cmp(&b.0));
        // an updated file is a change with its new metadata, whatever moved
        assert_eq!(
            changes,
            vec![
                ("/w/d/gone".to_owned(), ChangeType::Delete, None),
                ("/w/d/new".to_owned(), ChangeType::Add, Some(1.0)),
                ("/w/d/touched".to_owned(), ChangeType::Change, Some(2.0)),
            ]
        );
        let keys: Vec<&str> = index.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "/w/d/new",
                "/w/d/same",
                "/w/d/touched",
                "/w/d2/sibling",
                "/w/top"
            ]
        );
        assert_eq!(index["/w/d/touched"].mtime, Some(2.0), "the index moved");
    }

    #[test]
    fn reusable_stat_follows_the_racily_clean_rule() {
        let stat = FileStat {
            dev: 1,
            ino: 2,
            size: 4,
            mtime: (1_000, 0),
            change_time: (1_000, 500_000_000),
        };
        let at = |secs: u64, millis: u64| {
            std::time::UNIX_EPOCH + Duration::from_secs(secs) + Duration::from_millis(millis)
        };
        // the change time (1_000.5 s) more than the margin (3 s) back — trusted
        assert_eq!(reusable_stat(stat, at(1_003, 501)), Some(stat));
        assert_eq!(reusable_stat(stat, at(9_999, 0)), Some(stat));
        // exactly the margin back, or less — not trusted
        assert_eq!(reusable_stat(stat, at(1_003, 500)), None);
        assert_eq!(reusable_stat(stat, at(1_000, 0)), None);
        // a clock behind the stamp — not trusted
        assert_eq!(reusable_stat(stat, at(999, 0)), None);
        // an mtime in the future (an archive from a clock ahead, `touch -d
        // tomorrow`) doesn't matter: the change time decides
        let future = FileStat {
            mtime: (90_000, 0),
            ..stat
        };
        assert_eq!(reusable_stat(future, at(1_004, 0)), Some(future));
        // and a later write is still a change — it moves the change time
        let written = FileStat {
            change_time: (1_010, 0),
            ..future
        };
        assert!(!is_unchanged(reusable_stat(future, at(1_004, 0)), written));
    }
}
