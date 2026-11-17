//! Shared helpers for the filer modules' tests.

use super::core::{Filer, FilerConfig, FilerDepth, initial_rule, start_filer};
use super::event_loop::{FilerState, GitIgnore};
use super::ignore::{IgnoreRule, SharedRule};
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
            Arc::new(IgnoreRule::FixedNames),
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
    .files;
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
        rule: SharedRule::new(IgnoreRule::FixedNames),
        wire: Arc::default(),
        git: None,
        reprune: None,
        vetted: HashMap::new(),
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

/// The environment a test's git sees — its own and the filer's alike: no
/// `HOME`, so no user's global config or excludes file changes an answer.
fn test_git_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    vec![
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
    ]
}

/// A git runner for a filer under test, over [`test_git_env`]. Fails the
/// test when this machine's git is unusable, as the daemon's boot check
/// would find it.
pub(super) fn test_git() -> Arc<fuz_git::Git> {
    crate::git::GitUsability::checked_for_tests();
    Arc::new(fuz_git::Git::with_clean_env(test_git_env()))
}

/// Run git in `dir` with `args`, failing the test unless it succeeds.
pub(super) fn run_git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "protocol.file.allow=always",
        ])
        .args(args)
        .env_clear()
        .envs(test_git_env())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

impl TempDir {
    /// Write `text` to `rel`, making its directories.
    pub(super) fn write(&self, rel: &str, text: &str) {
        let path = self.path(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// The index keys of `rels`, sorted as the index holds them.
    pub(super) fn keys(&self, rels: &[&str]) -> Vec<String> {
        let mut keys: Vec<String> = rels.iter().map(|rel| self.key(rel)).collect();
        keys.sort();
        keys
    }
}

/// A checkout at a fresh temp dir, its files written from `files`.
pub(super) fn checkout(files: &[(&str, &str)]) -> TempDir {
    let tmp = TempDir::new();
    run_git(&tmp.0, &["init", "-q"]);
    for (rel, text) in files {
        tmp.write(rel, text);
    }
    tmp
}

/// A whole-tree filer's config on `tmp`, with `git`.
pub(super) fn config_with_git(tmp: &TempDir, git: Arc<fuz_git::Git>) -> FilerConfig {
    FilerConfig {
        git: Some(git),
        ..FilerConfig::tree(&tmp.root(), "/nowhere/")
    }
}

/// A running whole-tree filer on `tmp`, with git.
pub(super) async fn start_git(tmp: &TempDir) -> Filer {
    start(tmp, config_with_git(tmp, test_git())).await
}

/// The event-loop state of a filer on `tmp`, a checkout, on git's rule
/// through `git` — its first listing alone, as before `start_filer` lists
/// again — on the [`settled`] clock.
pub(super) async fn git_state(tmp: &TempDir, git: Arc<fuz_git::Git>) -> FilerState {
    let root = tmp.root();
    let (git_root, rule) = initial_rule(&root, &config_with_git(tmp, git)).await;
    let git_root = git_root.expect("a checkout on git's rule");
    let rule = Arc::new(rule);
    let watches = watches_for(&root, None);
    let scan = scan_directory(
        &root,
        &root,
        &[],
        Arc::clone(&rule),
        FilerDepth::Tree,
        &watches,
        false,
        settled,
        None,
    )
    .await
    .expect("the root is listable");
    let mut files = FileIndex::new();
    apply_subtree(&mut files, &root, scan.files);
    let mut state = state_for(tmp).await;
    *state.files.write().await = files;
    state.watches = watches;
    state.unwatched_count = Arc::clone(&state.watches.lock().unwatched_count);
    state.rule = SharedRule::new(Arc::unwrap_or_clone(rule));
    state.rule.set_nested_under(&root, &scan.nested, &scan.kept);
    state.git = Some(GitIgnore {
        exclude: git_root.info_exclude(),
        root: git_root,
        live_added: 0,
        failures: 0,
    });
    state
}

/// A git for a filer under test whose `ls-files` and `check-ignore` calls
/// are counted, each kind on its own, and can run a hook after git answers
/// and before the answer is passed on: a file created by the hook was
/// created after git looked, as by a racing writer. A hook that fails
/// fails its call, with no output and exit code 2 — not 1, which
/// `check-ignore` exits with for "nothing ignored", so a failing hook fails
/// a `check_ignore` too. The call count is written to a temp file and
/// renamed into place, so a test reading it mid-write never sees it empty.
pub(super) struct HookedGit {
    dir: TempDir,
    pub(super) git: Arc<fuz_git::Git>,
}

/// The two git calls a [`HookedGit`] counts and hooks.
#[derive(Debug, Clone, Copy)]
pub(super) enum GitCall {
    LsFiles,
    CheckIgnore,
}

impl GitCall {
    const fn key(self) -> &'static str {
        match self {
            Self::LsFiles => "ls",
            Self::CheckIgnore => "check",
        }
    }
}

impl HookedGit {
    pub(super) fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let real = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("git"))
            .find(|path| path.is_file())
            .expect("git on PATH");
        let dir = TempDir::new();
        let script = format!(
            r#"#!/bin/sh
d='{d}'
k=
for a in "$@"; do case "$a" in ls-files) k=ls; break;; check-ignore) k=check; break;; esac; done
[ -z "$k" ] && exec '{git}' "$@"
n=$(cat "$d/$k.count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$d/$k.count.$$"; mv "$d/$k.count.$$" "$d/$k.count"
'{git}' "$@" > "$d/out.$$"; rc=$?
if [ -f "$d/$k.$n" ] && ! sh "$d/$k.$n" >/dev/null 2>&1 </dev/null; then
  rm -f "$d/out.$$"; exit 2
fi
cat "$d/out.$$"; rm -f "$d/out.$$"; exit $rc
"#,
            d = dir.0.display(),
            git = real.display(),
        );
        std::fs::create_dir(dir.path("bin")).unwrap();
        std::fs::write(dir.path("bin/git"), script).unwrap();
        std::fs::set_permissions(dir.path("bin/git"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let mut path = std::ffi::OsString::from(dir.path("bin"));
        path.push(":");
        path.push(std::env::var_os("PATH").unwrap_or_default());
        crate::git::GitUsability::checked_for_tests();
        let git = Arc::new(fuz_git::Git::with_clean_env(vec![
            ("PATH".into(), path),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ]));
        Self { dir, git }
    }

    /// Run `script` (`sh`) after the `n`th call of `call`, from 1.
    pub(super) fn hook(&self, call: GitCall, n: u32, script: &str) {
        std::fs::write(self.dir.path(&format!("{}.{n}", call.key())), script).unwrap();
    }

    /// How many calls of `call` have run.
    pub(super) fn calls(&self, call: GitCall) -> u32 {
        std::fs::read_to_string(self.dir.path(&format!("{}.count", call.key())))
            .ok()
            .and_then(|count| count.trim().parse().ok())
            .unwrap_or(0)
    }

    /// Wait (up to 10s) until `call` has run at least `n` times.
    pub(super) async fn wait_for_calls(&self, call: GitCall, n: u32) {
        self.wait_for_calls_within(call, n, Duration::from_secs(10))
            .await;
    }

    /// Wait (up to `limit`) until `call` has run at least `n` times — for a
    /// wait that sits out a git timeout, which a loaded machine stretches.
    pub(super) async fn wait_for_calls_within(&self, call: GitCall, n: u32, limit: Duration) {
        let deadline = Instant::now() + limit;
        while self.calls(call) < n {
            assert!(
                Instant::now() < deadline,
                "{call:?} ran {} times, expected {n}",
                self.calls(call)
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
