//! The compact wire encoding of a snapshot's files — what `session_load`,
//! `project_open`, `repo_focus`, and `repo_files` carry, twin of
//! `SnapshotFiles` in `diskfile_types.ts`.
//!
//! The files are grouped by their filer dir (`source_dir`), one group per
//! dir, each file a tuple relative to it:
//!
//! ```json
//! [{"dir": "/w/", "files": [["a.txt", 9, 1700000000000], ["b.txt", 3, 1700000000000, 1690000000000]]}]
//! ```
//!
//! A tuple is `[rel, size, mtime, ctime?]`: the path below `dir`, the size in
//! bytes, the modification time, and the birth time — left off when it
//! equals `mtime`, as it does for most files. Timestamps are whole
//! milliseconds since the epoch ([`system_time_to_ms`](super::system_time_to_ms)).
//! A snapshot of a large tree spends most of its bytes on its files, and per
//! file this is about half the `SerializableDisknode` object `filer_change`
//! still carries: no keys, no repeated `source_dir`, and the dir prefix of
//! every path dropped.

use super::SerializableDisknode;
use serde::Serialize;
use serde::ser::{SerializeSeq, SerializeStruct};

/// A snapshot's files, encoded on the wire grouped by filer dir (see the
/// module docs).
#[derive(Debug)]
pub struct SnapshotFiles {
    /// Sorted by `source_dir` (stably, so each dir keeps the order its index
    /// gave), which makes each group one contiguous run.
    files: Vec<SerializableDisknode>,
}

impl SnapshotFiles {
    /// Groups `files` by their `source_dir`.
    #[must_use]
    pub fn new(mut files: Vec<SerializableDisknode>) -> Self {
        // a snapshot reads one filer's index after another, so the runs are
        // mostly in place already, which the stable sort is linear over
        files.sort_by(|a, b| a.source_dir.cmp(&b.source_dir));
        Self { files }
    }

    /// An estimate of the serialized size in bytes, for sizing a response
    /// buffer up front.
    ///
    /// Counts each group's dir and each file's relative path, plus their
    /// punctuation and numbers. A path JSON escapes (quotes, backslashes,
    /// control characters) renders longer, and the buffer grows past the
    /// estimate as needed.
    #[must_use]
    pub fn json_size_hint(&self) -> usize {
        /// A group's keys and punctuation, beside its dir.
        const GROUP_OVERHEAD: usize = 24;
        /// A file's quotes, commas, brackets, size, and `mtime`.
        const FILE_OVERHEAD: usize = 28;
        /// A `ctime` that differs from `mtime`.
        const CTIME_OVERHEAD: usize = 14;
        let groups: usize = self
            .groups()
            .map(|group| GROUP_OVERHEAD + group[0].source_dir.len())
            .sum();
        self.files.iter().fold(2 + groups, |total, node| {
            let ctime = if node.ctime == node.mtime {
                0
            } else {
                CTIME_OVERHEAD
            };
            total + FILE_OVERHEAD + ctime + node.id.len().saturating_sub(node.source_dir.len())
        })
    }

    /// Each dir's run of files — never empty.
    fn groups(&self) -> impl Iterator<Item = &[SerializableDisknode]> {
        self.files.chunk_by(|a, b| a.source_dir == b.source_dir)
    }
}

impl Serialize for SnapshotFiles {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(None)?;
        for group in self.groups() {
            seq.serialize_element(&FileGroup(group))?;
        }
        seq.end()
    }
}

/// One dir's files: `{dir, files}`.
struct FileGroup<'a>(&'a [SerializableDisknode]);

impl Serialize for FileGroup<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let dir = self.0.first().map_or("", |node| node.source_dir.as_str());
        let mut state = serializer.serialize_struct("FileGroup", 2)?;
        state.serialize_field("dir", dir)?;
        state.serialize_field("files", &FileTuples(self.0))?;
        state.end()
    }
}

/// One dir's files as tuples.
struct FileTuples<'a>(&'a [SerializableDisknode]);

impl Serialize for FileTuples<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(None)?;
        for node in self.0 {
            // every indexed id is its filer's root plus a path below it; one
            // that isn't can't be told relative to its dir, so it's left out,
            // as a file that isn't indexed would be
            let Some(rel) = node.id.strip_prefix(node.source_dir.as_str()) else {
                tracing::error!(
                    id = %node.id,
                    source_dir = %node.source_dir,
                    "an indexed file outside its filer dir, left out of a snapshot"
                );
                continue;
            };
            seq.serialize_element(&FileTuple { rel, node })?;
        }
        seq.end()
    }
}

/// `[rel, size, mtime, ctime?]` — `ctime` only when it differs from `mtime`.
struct FileTuple<'a> {
    rel: &'a str,
    node: &'a SerializableDisknode,
}

impl Serialize for FileTuple<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Self { rel, node } = self;
        let with_ctime = node.ctime != node.mtime;
        let mut seq = serializer.serialize_seq(Some(if with_ctime { 4 } else { 3 }))?;
        seq.serialize_element(rel)?;
        seq.serialize_element(&node.size)?;
        seq.serialize_element(&node.mtime)?;
        if with_ctime {
            seq.serialize_element(&node.ctime)?;
        }
        seq.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::index::make_disknode;
    use serde_json::json;

    fn node(
        id: &str,
        source_dir: &str,
        size: Option<u64>,
        mtime: Option<u64>,
        ctime: Option<u64>,
    ) -> SerializableDisknode {
        make_disknode(id.to_owned(), source_dir, size, ctime, mtime, None)
    }

    #[test]
    fn groups_by_dir_with_paths_relative_and_ctime_only_when_it_differs() {
        let files = SnapshotFiles::new(vec![
            node("/w/b/x.txt", "/w/b/", Some(1), Some(10), Some(10)),
            node("/w/a.txt", "/w/", Some(9), Some(20), Some(5)),
            node("/w/b/y/z.txt", "/w/b/", Some(2), Some(30), None),
            node("/w/c.txt", "/w/", Some(0), None, None),
        ]);
        assert_eq!(
            serde_json::to_value(&files).unwrap(),
            json!([
                {"dir": "/w/", "files": [["a.txt", 9, 20, 5], ["c.txt", 0, null]]},
                {"dir": "/w/b/", "files": [["x.txt", 1, 10], ["y/z.txt", 2, 30, null]]},
            ])
        );
        assert_eq!(
            serde_json::to_string(&SnapshotFiles::new(Vec::new())).unwrap(),
            "[]"
        );
    }

    #[test]
    fn a_file_outside_its_dir_is_left_out() {
        let files = SnapshotFiles::new(vec![
            node("/elsewhere/a.txt", "/w/", Some(1), Some(1), Some(1)),
            node("/w/b.txt", "/w/", Some(1), Some(1), Some(1)),
        ]);
        assert_eq!(
            serde_json::to_value(&files).unwrap(),
            json!([{"dir": "/w/", "files": [["b.txt", 1, 1]]}])
        );
    }

    #[test]
    fn the_size_hint_tracks_the_rendered_size() {
        let nodes: Vec<SerializableDisknode> = (0..200)
            .map(|i| {
                let dir = format!("/home/user/dev/repo_{}/", i % 3);
                let ctime = if i % 7 == 0 {
                    Some(1_690_000_000_000)
                } else {
                    Some(1_700_000_000_123)
                };
                node(
                    &format!("{dir}src/lib/module_{i}.ts"),
                    &dir,
                    Some(12_345),
                    Some(1_700_000_000_123),
                    ctime,
                )
            })
            .collect();
        let files = SnapshotFiles::new(nodes);
        let rendered = serde_json::to_string(&files).unwrap().len();
        let hint = files.json_size_hint();
        assert!(
            hint.abs_diff(rendered) * 10 <= rendered,
            "hint {hint} off rendered {rendered} by over 10%"
        );
        assert_eq!(SnapshotFiles::new(Vec::new()).json_size_hint(), "[]".len());
    }
}
