//! The blocking directory walk and the scan over it.

use super::core::FilerDepth;
use super::ignore::{IgnoreRule, is_nested_repo};
use super::index::{
    FileIndex, FileStat, ScanIndex, ScannedFile, is_unchanged, make_disknode, reusable_stat,
    system_time_to_ms,
};
use super::watches::{DirWatches, WatchAttempt, is_transient_list_error};
use super::{Clock, WALK_CHANNEL_CAPACITY, dir_prefix};
use parking_lot::Mutex;
use std::collections::BTreeSet;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::{RwLock, mpsc};

/// Walk `prefix` (a directory, [`dir_prefix`] form) on the calling blocking
/// thread: watch each directory, then list it, sending every regular file
/// found to `jobs` with its `lstat` (taken after reading `clock`, see
/// [`reusable_stat`]) and descending into real subdirectories. Finishes with
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
/// entirely, as are FIFOs, sockets, and devices. Entries `rule` ignores
/// ([`IgnoreRule::ignores_name`], [`IgnoreRule::ignores_entry`]) and
/// non-UTF-8 names are skipped with their subtrees. Under a git root, so is
/// a directory holding a repo of its own ([`is_nested_repo`]) — `prefix`
/// itself included, when it's below `source_dir`.
///
/// Returns the directories whose listing failed transiently
/// ([`is_transient_list_error`]) — the caller keeps what's indexed under
/// them — and the nested repos it stopped at (absolute, no trailing `/`),
/// or the error of listing `prefix` itself. Below `prefix`, an unreadable
/// or vanished directory is skipped.
#[expect(
    clippy::too_many_arguments,
    reason = "the walk's inputs, each from the filer's state or its caller"
)]
fn walk_blocking(
    prefix: &str,
    source_dir: &str,
    ignored_dirs: &[PathBuf],
    rule: &IgnoreRule,
    depth: FilerDepth,
    watches: &mut DirWatches,
    reset_watches: bool,
    clock: Clock,
    jobs: &mpsc::Sender<FileJob>,
) -> io::Result<(Vec<String>, Vec<String>)> {
    if reset_watches {
        watches.reset();
    }
    let mut listed = BTreeSet::new();
    let mut unreadable = BTreeSet::new();
    let mut kept = Vec::new();
    let mut root_error = None;
    // a dir that became a repo of its own lists as nothing, its watches
    // dropped by the reconcile
    let mut nested = Vec::new();
    let mut stack = vec![prefix.to_owned()];
    if rule.is_git() && prefix != source_dir && is_nested_repo(super::prefix_dir(prefix)) {
        stack.clear();
        nested.push(prefix.trim_end_matches('/').to_owned());
    }
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
                    tracing::warn!(
                        path = %dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "failed to list a directory; retrying later"
                    );
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
            if rule.ignores_name(name) || ignored_dirs.contains(&path) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if rule.ignores_entry(&path_str, file_type.is_dir()) {
                continue;
            }
            if file_type.is_dir() {
                if depth == FilerDepth::Tree {
                    if rule.is_git() && is_nested_repo(&path) {
                        nested.push(path_str);
                    } else {
                        stack.push(dir_prefix(&path_str));
                    }
                }
                continue;
            }
            if !file_type.is_file() {
                // symlink, FIFO, socket, device
                continue;
            }
            // the clock before the `lstat`, never after: a stamp is trusted
            // against a time no later than it was taken (see `reusable_stat`)
            let observed_at = clock();
            // `DirEntry::metadata` is an `lstat` — never follows a link
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            // swapped for a symlink, FIFO, or directory since the listing
            let Some(job) = file_job(path_str, &meta, observed_at) else {
                continue;
            };
            if jobs.blocking_send(job).is_err() {
                // the scan was dropped (its filer stopped) — a partial walk
                // must not reconcile away watches it never reached
                return Err(io::ErrorKind::Interrupted.into());
            }
        }
    }
    watches.reconcile(prefix, &listed, &unreadable, &kept);
    root_error.map_or(Ok((kept, nested)), Err)
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
            tracing::debug!(
                path = %path.display(),
                error = %fuz_sys::cli::format_error_chain(&e),
                "failed to remove an orphaned staged-write file"
            );
        }
    }
}

/// One file found by the walk, with its `lstat`.
#[derive(Debug)]
struct FileJob {
    path_str: String,
    ctime: Option<f64>,
    mtime: Option<f64>,
    stat: FileStat,
    /// The clock's reading just before the `lstat` (see [`reusable_stat`]).
    observed_at: SystemTime,
}

/// The walk's job for `path_str` by its `lstat` (`meta`, taken after
/// `observed_at`) — `None` unless it's still a regular file, since the
/// listing's entry type is older than the `lstat`.
fn file_job(
    path_str: String,
    meta: &std::fs::Metadata,
    observed_at: SystemTime,
) -> Option<FileJob> {
    meta.is_file().then(|| FileJob {
        path_str,
        ctime: meta.created().ok().and_then(system_time_to_ms),
        mtime: meta.modified().ok().and_then(system_time_to_ms),
        stat: FileStat::of(meta),
        observed_at,
    })
}

/// Scan `prefix` (a directory, [`dir_prefix`] form): walk it on a blocking
/// thread — adding watches and taking each file's `lstat` as it goes, see
/// [`walk_blocking`] — while comparing each file with `known`.
///
/// The walker streams `FileJob`s through a bounded channel; nothing is read.
/// A file whose `known` node holds its stamp, trusted, is
/// [`ScannedFile::Unchanged`] ([`is_unchanged`]); any other gets a node from
/// its `lstat`.
///
/// Called by `start_filer` (cold path) and by the event loop's subtree
/// syncs and rescans (hot path — `session_load` rescans every filer). The
/// event loop is the index's only writer, so holding `known` for the scan
/// blocks nobody but itself.
///
/// Returns the files found, the directories whose listing failed
/// transiently, and the nested repos the walk stopped at (see
/// [`walk_blocking`]).
///
/// # Errors
///
/// The error of listing `prefix` itself (see [`walk_blocking`]).
#[expect(
    clippy::too_many_arguments,
    reason = "the walk's inputs, each from the filer's state or its caller"
)]
pub(super) async fn scan_directory(
    prefix: &str,
    source_dir: &str,
    ignored_dirs: &[PathBuf],
    rule: Arc<IgnoreRule>,
    depth: FilerDepth,
    watches: &Arc<Mutex<DirWatches>>,
    reset_watches: bool,
    clock: Clock,
    known: Option<&RwLock<FileIndex>>,
) -> io::Result<DirScan> {
    let (job_tx, mut job_rx) = mpsc::channel::<FileJob>(WALK_CHANNEL_CAPACITY);
    let walk = {
        let prefix = prefix.to_owned();
        let source_dir = source_dir.to_owned();
        let ignored_dirs = ignored_dirs.to_vec();
        let watches = Arc::clone(watches);
        tokio::task::spawn_blocking(move || {
            walk_blocking(
                &prefix,
                &source_dir,
                &ignored_dirs,
                &rule,
                depth,
                &mut watches.lock(),
                reset_watches,
                clock,
                &job_tx,
            )
        })
    };
    let mut fresh = ScanIndex::new();
    {
        let known = match known {
            Some(known) => Some(known.read().await),
            None => None,
        };
        while let Some(job) = job_rx.recv().await {
            let (path_str, scanned) = scan_file(job, source_dir, known.as_deref());
            fresh.insert(path_str, scanned);
        }
    }
    let (kept, nested) = walk.await.map_err(io::Error::other)??;
    Ok(DirScan {
        files: fresh,
        kept,
        nested,
    })
}

/// What [`scan_directory`] found under its prefix.
#[derive(Debug)]
pub(super) struct DirScan {
    /// Each file walked, unchanged or with its fresh node.
    pub(super) files: ScanIndex,
    /// The directories whose listing failed transiently, prefix form — what's
    /// indexed under them is kept.
    pub(super) kept: Vec<String>,
    /// The dirs holding a repo of their own the walk stopped at under a git
    /// root ([`is_nested_repo`]), absolute, no trailing `/`.
    pub(super) nested: Vec<String>,
}

/// One walked file as a scan finds it: unchanged when `known` indexes it with
/// its stamp, trusted ([`is_unchanged`]), else its node from the walk's
/// `lstat`.
fn scan_file(job: FileJob, source_dir: &str, known: Option<&FileIndex>) -> (String, ScannedFile) {
    let unchanged = known
        .and_then(|known| known.get(&job.path_str))
        .is_some_and(|node| is_unchanged(node.stat, job.stat));
    if unchanged {
        return (job.path_str, ScannedFile::Unchanged);
    }
    let node = make_disknode(
        job.path_str.clone(),
        source_dir,
        Some(job.stat.size),
        job.ctime,
        job.mtime,
        reusable_stat(job.stat, job.observed_at),
    );
    (job.path_str, ScannedFile::Updated(Box::new(node)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::ChangeType;
    use crate::filer::core::FilerConfig;
    use crate::filer::ignore::is_ignored;
    use crate::filer::test_support::settled;
    use crate::filer::test_support::{
        TempDir, event, indexed, pending_of, scan_into, state_for, state_with, watches_for,
    };
    use notify::EventKind;
    use notify::event::CreateKind;
    use std::path::Path;
    use std::time::Duration;

    async fn scan_with(root: &str, ignored_dirs: &[PathBuf]) -> FileIndex {
        scan_into(root, ignored_dirs, &watches_for(root, None), settled).await
    }

    async fn scan(root: &str) -> FileIndex {
        scan_with(root, &[]).await
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
            assert!(
                is_ignored(path, &tmp.0, &[], &IgnoreRule::FixedNames),
                "{}",
                path.display()
            );
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
        let old = SystemTime::now() - Duration::from_hours(2);
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

    #[test]
    fn ignored_dirs_match_by_full_path_not_name() {
        let root = Path::new("/w");
        let ignored = [PathBuf::from("/w/app/data")];
        assert!(is_ignored(
            Path::new("/w/app/data"),
            root,
            &ignored,
            &IgnoreRule::FixedNames
        ));
        assert!(is_ignored(
            Path::new("/w/app/data/x.txt"),
            root,
            &ignored,
            &IgnoreRule::FixedNames
        ));
        assert!(!is_ignored(
            Path::new("/w/data/x.txt"),
            root,
            &ignored,
            &IgnoreRule::FixedNames
        ));
        assert!(!is_ignored(
            Path::new("/w/app/data2/x.txt"),
            root,
            &ignored,
            &IgnoreRule::FixedNames
        ));
        // default names still apply alongside
        assert!(is_ignored(
            Path::new("/w/data/.git/HEAD"),
            root,
            &ignored,
            &IgnoreRule::FixedNames
        ));
    }

    #[test]
    fn the_cli_daemon_home_is_ignored_in_a_home_root() {
        let home = Path::new("/home/u");
        let config = FilerConfig::tree("/home/u/", "/home/u/.zzz/.zzz/");
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
                is_ignored(
                    &home.join(rel),
                    home,
                    &config.ignored_dirs,
                    &IgnoreRule::FixedNames
                ),
                "{rel}"
            );
        }
        assert!(!is_ignored(
            &home.join("notes/.env"),
            home,
            &config.ignored_dirs,
            &IgnoreRule::FixedNames
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
        let config = FilerConfig::tree(&root, &dir_prefix(&tmp.key(".zzz/.zzz")));
        let files = scan_with(&root, &config.ignored_dirs).await;
        let keys: Vec<String> = files.keys().cloned().collect();
        assert_eq!(keys, vec![tmp.key("notes.txt")]);
    }

    #[tokio::test]
    async fn credential_dirs_are_skipped_by_the_scan() {
        let tmp = TempDir::new();
        for name in crate::scoped_fs::CREDENTIAL_DIR_NAMES {
            std::fs::create_dir_all(tmp.path(&format!("{name}/sub"))).unwrap();
            std::fs::write(tmp.path(&format!("{name}/key")), "SECRET").unwrap();
            std::fs::write(tmp.path(&format!("{name}/sub/key")), "SECRET").unwrap();
            std::fs::create_dir_all(tmp.path(&format!("nested/{name}"))).unwrap();
            std::fs::write(tmp.path(&format!("nested/{name}/key")), "SECRET").unwrap();
        }
        for rel in [".sshx/f", "ssh/f", "nested/.env", "notes.txt"] {
            if let Some(parent) = Path::new(rel).parent() {
                std::fs::create_dir_all(tmp.path(&parent.to_string_lossy())).unwrap();
            }
            std::fs::write(tmp.path(rel), "x").unwrap();
        }
        let root = tmp.root();
        let files = scan_with(&root, &[]).await;
        let mut keys: Vec<String> = files.keys().cloned().collect();
        keys.sort();
        let mut expected = vec![
            tmp.key(".sshx/f"),
            tmp.key("nested/.env"),
            tmp.key("notes.txt"),
            tmp.key("ssh/f"),
        ];
        expected.sort();
        assert_eq!(keys, expected);
    }

    #[tokio::test]
    async fn the_app_dir_is_ignored_by_path_while_same_named_dirs_stay_indexed() {
        let tmp = TempDir::new();
        for dir in ["app/data", "data", "src/data"] {
            std::fs::create_dir_all(tmp.path(dir)).unwrap();
            std::fs::write(tmp.path(&format!("{dir}/f.txt")), "x").unwrap();
        }
        let root = tmp.root();
        let config = FilerConfig::tree(&root, &dir_prefix(&tmp.key("app/data")));

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

    #[cfg(unix)]
    #[test]
    fn the_walk_indexes_only_what_its_lstat_says_is_a_regular_file() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new();
        std::fs::write(tmp.path("f.txt"), "f").unwrap();
        symlink(tmp.path("f.txt"), tmp.path("link")).unwrap();
        std::fs::create_dir(tmp.path("dir")).unwrap();
        let job = |rel: &str| {
            let meta = std::fs::symlink_metadata(tmp.path(rel)).unwrap();
            file_job(tmp.key(rel), &meta, SystemTime::now())
        };
        assert!(job("f.txt").is_some());
        // what the listing said was a file, swapped since
        assert!(job("link").is_none());
        assert!(job("dir").is_none());
    }
}
