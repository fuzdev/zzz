//! A git root's rule, live: a listing racing its walk, re-prunes (their
//! settling, failures, and triggers), the `info/exclude` watch, and the
//! vetting of adds — on running filers, and on an event loop's state driven
//! by hand where the timing has to be exact.

use super::core::{Filer, FilerConfig};
use super::dir_prefix;
use super::event_loop::{
    PendingReprune, REPRUNE_MAX_FAILURES, REPRUNE_SETTLE, REPRUNE_SETTLE_MAX_WAIT, RepruneTrigger,
    VET_MAX_PATHS,
};
use super::ignore::GitRoot;
use super::test_support::{
    GitCall, HookedGit, TempDir, checkout, config_with_git, event, git_state, indexed, keys_of,
    run_git, start, start_git, state_for, test_git, wait_for_keys, watched_dirs,
};
use notify::EventKind;
use notify::event::{CreateKind, RemoveKind};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::Instant;

/// A rescan of `filer`, as `session_load` asks for one.
async fn rescan(filer: &Filer) {
    let (tx, rx) = oneshot::channel();
    filer.rescan_tx.send(tx).await.unwrap();
    rx.await.unwrap();
}

/// How long a test waits for git calls that come after a git timeout:
/// `LIST_TIMEOUT` and the walks around it, with headroom for a loaded
/// machine.
const PAST_TIMEOUT_WAIT: Duration = Duration::from_secs(30);

/// Wait (up to 10s) until `check` holds of `filer`.
async fn wait_until(filer: &Filer, what: &str, check: impl Fn(&Filer) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check(filer) {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Whether `filer` has a watch at or under `rel`.
fn watches_under(filer: &Filer, tmp: &TempDir, rel: &str) -> bool {
    let prefix = dir_prefix(&tmp.key(rel));
    watched_dirs(filer)
        .iter()
        .any(|dir| dir.starts_with(&prefix))
}

fn ignores(filer: &Filer, tmp: &TempDir, rel: &str) -> bool {
    filer
        .ignored_paths()
        .is_some_and(|paths| paths.contains(&tmp.key(rel)))
}

/// A hook writing `files` (relative to `tmp`), making their dirs.
fn write_hook(tmp: &TempDir, files: &[&str]) -> String {
    files
        .iter()
        .map(|rel| {
            let path = tmp.path(rel);
            format!(
                "mkdir -p '{}' && echo x > '{}'",
                path.parent().unwrap().display(),
                path.display()
            )
        })
        .collect::<Vec<_>>()
        .join(" && ")
}

// -- A listing racing its walk ----------------------------------------------

/// Files created between the start's listing and its walk are found by the
/// listing after the walk — and later events don't make them indexed (they'd
/// skip a path as already indexed).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_the_start_walk_finds_unlisted_is_listed_again() {
    let tmp = checkout(&[(".gitignore", "target/\n*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    git.hook(
        GitCall::LsFiles,
        1,
        &write_hook(&tmp, &["target/debug/out", "b.log"]),
    );
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore", "a.txt"]));
    assert!(!watches_under(&filer, &tmp, "target"));
    assert!(ignores(&filer, &tmp, "target") && ignores(&filer, &tmp, "b.log"));
    tmp.write("b.log", "y");
    tmp.write("c.txt", "c");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "c.txt"])).await;
}

/// The same for a re-prune's walk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_a_re_prune_walk_finds_unlisted_is_listed_again() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    git.hook(
        GitCall::LsFiles,
        listed + 1,
        &write_hook(&tmp, &["out/x.txt", "c.log"]),
    );
    tmp.write(".gitignore", "*.log\nout/\n");
    git.wait_for_calls(GitCall::LsFiles, listed + 2).await;
    tmp.write("c.log", "y");
    tmp.write("d.txt", "d");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "d.txt"])).await;
    assert!(!watches_under(&filer, &tmp, "out"));
    assert!(ignores(&filer, &tmp, "out"));
}

/// The same for a burst's new dir, listed before its walk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_a_new_dir_walk_finds_unlisted_is_listed_again() {
    let tmp = checkout(&[(".gitignore", "node_modules/\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    git.hook(
        GitCall::LsFiles,
        listed + 1,
        &write_hook(&tmp, &["pkg/a.js", "pkg/node_modules/dep/x.js"]),
    );
    std::fs::create_dir(tmp.path("pkg")).unwrap();
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "pkg/a.js"])).await;
    assert!(!watches_under(&filer, &tmp, "pkg/node_modules"));
    assert!(ignores(&filer, &tmp, "pkg/node_modules"));
    tmp.write("pkg/node_modules/dep/x.js", "y");
    tmp.write("b.txt", "b");
    wait_for_keys(
        &filer,
        &tmp.keys(&[".gitignore", "a.txt", "b.txt", "pkg/a.js"]),
    )
    .await;
}

/// What the start's second listing no longer ignores — an excludes file
/// edited after the first listing (or its confirming check), before any
/// watch could see it — is walked by a re-prune as the loop starts, and
/// watched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn what_the_start_second_listing_un_ignores_is_walked() {
    for call in [GitCall::LsFiles, GitCall::CheckIgnore] {
        let tmp = checkout(&[(".gitignore", "out/\n"), ("out/x.txt", "x"), ("a.txt", "a")]);
        let git = HookedGit::new();
        git.hook(
            call,
            1,
            &format!("printf '' > '{}'", tmp.path(".gitignore").display()),
        );
        let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
        wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "out/x.txt"])).await;
        assert!(!ignores(&filer, &tmp, "out"), "{call:?}");
        tmp.write("out/y.txt", "y");
        wait_for_keys(
            &filer,
            &tmp.keys(&[".gitignore", "a.txt", "out/x.txt", "out/y.txt"]),
        )
        .await;
    }
}

// -- Re-prunes ----------------------------------------------------------------

/// A start whose second listing times out keeps its first and re-prunes as
/// the event loop starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_start_listing_that_times_out_keeps_the_set_and_re_prunes() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
    ]);
    let git = HookedGit::new();
    git.hook(GitCall::LsFiles, 2, "sleep 7");
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore", "a.txt"]));
    assert!(ignores(&filer, &tmp, "venv"));
    git.wait_for_calls_within(GitCall::LsFiles, 4, PAST_TIMEOUT_WAIT)
        .await;
    tmp.write("b.txt", "b");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "b.txt"])).await;
    assert!(ignores(&filer, &tmp, "venv"));
}

/// A re-prune whose listing times out keeps the last set — no fallback to
/// fixed names, which don't name `venv/` — and the next trigger lists again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_re_prune_that_times_out_keeps_the_set_until_the_next() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
    ]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    git.hook(GitCall::LsFiles, listed + 1, "sleep 7");
    tmp.write(".gitignore", "venv/\n*.tmp\n");
    git.wait_for_calls(GitCall::LsFiles, listed + 1).await;
    // the next trigger, once the failed one is done
    tmp.write(".gitignore", "venv/\n*.tmp\n# again\n");
    git.wait_for_calls_within(GitCall::LsFiles, listed + 3, PAST_TIMEOUT_WAIT)
        .await;
    tmp.write("b.tmp", "b");
    tmp.write("c.txt", "c");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "c.txt"])).await;
    assert!(ignores(&filer, &tmp, "venv"));
}

/// Three failed re-prune listings in a row fall back to fixed names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn re_prunes_failing_in_a_row_fall_back_to_fixed_names() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
    ]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    for n in 1..=3 {
        git.hook(GitCall::LsFiles, listed + n, "exit 1");
    }
    for n in 1..=3 {
        assert!(filer.ignored_paths().is_some(), "fell back after {n}");
        tmp.write(".gitignore", &format!("venv/\n# {n}\n"));
        git.wait_for_calls(GitCall::LsFiles, listed + n).await;
    }
    wait_until(&filer, "the fallback", |filer| {
        filer.ignored_paths().is_none()
    })
    .await;
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "venv/lib/a.py"])).await;
}

/// Lost events re-prune: an excludes file no watch covers (here the
/// configured global one) takes effect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_overflow_re_prunes_rather_than_rescans() {
    let tmp = checkout(&[("a.txt", "a"), ("b.secret", "s")]);
    let elsewhere = TempDir::new();
    let excludes = elsewhere.path("excludes");
    std::fs::write(&excludes, "").unwrap();
    run_git(
        &tmp.0,
        &["config", "core.excludesFile", excludes.to_str().unwrap()],
    );
    let filer = start_git(&tmp).await;
    assert_eq!(keys_of(&filer).await, tmp.keys(&["a.txt", "b.secret"]));
    std::fs::write(&excludes, "*.secret\n").unwrap();
    filer.signal.request();
    wait_for_keys(&filer, &tmp.keys(&["a.txt"])).await;
}

/// Rewrites of a `.gitignore` closer together than the settle re-prune
/// once, after them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rule_changes_in_quick_succession_re_prune_once() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    for n in 0..5 {
        tmp.write(".gitignore", &format!("*.log\n# {n}\n"));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tmp.write(".gitignore", "*.log\n*.txt\n");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore"])).await;
    // one listing, and the one after its walk: both come
    git.wait_for_calls(GitCall::LsFiles, listed + 2).await;
    // TODO: then no third — an absence after a sleep; exact needs the filer to
    // report a re-prune settled with none pending (a test hook on its rule
    // state).
    tokio::time::sleep(REPRUNE_SETTLE * 2).await;
    assert_eq!(git.calls(GitCall::LsFiles), listed + 2);
}

#[test]
fn a_rule_change_re_prune_waits_for_quiet_within_a_cap() {
    let first = Instant::now();
    let pending = PendingReprune::settled(None, first);
    assert_eq!(pending.due(), first + REPRUNE_SETTLE);
    let later = first + REPRUNE_SETTLE / 2;
    let pending = PendingReprune::settled(Some(pending), later);
    assert_eq!(
        pending.due(),
        later + REPRUNE_SETTLE,
        "each change restarts it"
    );
    let mut pending = pending;
    let mut now = later;
    while now < first + REPRUNE_SETTLE_MAX_WAIT {
        now += REPRUNE_SETTLE / 2;
        pending = PendingReprune::settled(Some(pending), now);
    }
    assert_eq!(pending.due(), first + REPRUNE_SETTLE_MAX_WAIT, "capped");
    // one due at once stays due
    let at_once = PendingReprune::now(false);
    let pending = PendingReprune::settled(Some(at_once), at_once.due() + REPRUNE_SETTLE);
    assert_eq!(pending.due(), at_once.due());
}

/// A re-prune isn't run before it's due.
#[tokio::test]
async fn a_pending_re_prune_runs_once_due() {
    let tmp = TempDir::new();
    let mut state = state_for(&tmp).await;
    state.request_settled_reprune();
    let due = state.reprune_due().unwrap();
    state
        .run_pending_reprune(due - Duration::from_millis(1))
        .await;
    assert_eq!(state.reprune_due(), Some(due));
    state.run_pending_reprune(due).await;
    assert_eq!(state.reprune_due(), None);
}

/// One trigger whose listing fails is one failure: the failed re-prune's
/// own rescan (which sees the `.gitignore` still changed) doesn't retry
/// it, so a git failing fast can't spend every failure on one write.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_trigger_failing_fast_lists_once_and_keeps_the_set() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
    ]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    for n in 1..=3 {
        git.hook(GitCall::LsFiles, listed + n, "exit 1");
    }
    tmp.write(".gitignore", "venv/\n# one write\n");
    git.wait_for_calls(GitCall::LsFiles, listed + 1).await;
    // a self-retry would come within a settle or two
    // TODO: an absence after a sleep — exact needs the filer to report a
    // re-prune settled with none pending (a test hook on its rule state).
    tokio::time::sleep(REPRUNE_SETTLE * 5).await;
    assert_eq!(git.calls(GitCall::LsFiles), listed + 1, "one listing");
    assert!(ignores(&filer, &tmp, "venv"), "no fallback");
}

/// Failures apart — separate triggers, each failing once and then
/// re-pruned by the next trigger with success — never fall back: a
/// success resets the count.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failures_apart_each_followed_by_a_success_never_fall_back() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    for round in 0..REPRUNE_MAX_FAILURES {
        let listed = git.calls(GitCall::LsFiles);
        git.hook(GitCall::LsFiles, listed + 1, "exit 1");
        tmp.write(".gitignore", &format!("*.log\n# fails {round}\n"));
        git.wait_for_calls(GitCall::LsFiles, listed + 1).await;
        // the next trigger, after the failed one: it lists and relists,
        // unless the failure fell back to fixed names
        tmp.write(".gitignore", &format!("*.log\n# succeeds {round}\n"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while filer.ignored_paths().is_some() && git.calls(GitCall::LsFiles) < listed + 3 {
            assert!(Instant::now() < deadline, "round {round}: no re-prune");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            filer.ignored_paths().is_some(),
            "round {round}: fell back on failures apart"
        );
    }
}

/// On a healthy git a `session_load` rescan is a plain rescan, not a
/// re-prune.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_load_rescan_on_a_healthy_git_lists_nothing() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    tmp.write("b.txt", "b");
    rescan(&filer).await;
    assert_eq!(git.calls(GitCall::LsFiles), listed, "no listing");
    assert!(keys_of(&filer).await.contains(&tmp.key("b.txt")));
}

/// A re-prune whose listing times out leaves its rule change unapplied
/// only until the next `session_load` rescan, which re-prunes in its place.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_load_rescan_after_a_timed_out_re_prune_re_prunes() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
    ]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    git.hook(GitCall::LsFiles, listed + 1, "sleep 7");
    tmp.write(".gitignore", "# nothing\n");
    git.wait_for_calls(GitCall::LsFiles, listed + 1).await;
    // queued behind the failed re-prune, which holds the loop
    rescan(&filer).await;
    assert_eq!(
        keys_of(&filer).await,
        tmp.keys(&[".gitignore", "a.txt", "venv/lib/a.py"])
    );
    assert!(filer.ignored_paths().is_some(), "no fallback");
}

/// While degraded, the next poll after a failed re-prune re-prunes in
/// place of its rescan of the unwatched dirs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_degraded_poll_after_a_failed_re_prune_re_prunes() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
        ("sub/x.md", "x"),
    ]);
    let git = HookedGit::new();
    let config = FilerConfig {
        watch_limit: Some(1),
        degraded_rescan_interval: Duration::from_millis(100),
        ..config_with_git(&tmp, Arc::clone(&git.git))
    };
    let filer = start(&tmp, config).await;
    let listed = git.calls(GitCall::LsFiles);
    git.hook(GitCall::LsFiles, listed + 1, "exit 1");
    tmp.write(".gitignore", "# nothing\n");
    wait_for_keys(
        &filer,
        &tmp.keys(&[".gitignore", "a.txt", "sub/x.md", "venv/lib/a.py"]),
    )
    .await;
    assert!(git.calls(GitCall::LsFiles) > listed + 1, "re-pruned again");
}

/// A git failing for every load rescan keeps retrying on git's rule: each
/// load re-prunes, but a retry's failure doesn't count toward
/// [`REPRUNE_MAX_FAILURES`] — only re-prunes a change on disk asked for do.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn load_rescans_on_a_failing_git_retry_without_falling_back() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
    ]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    let loads = REPRUNE_MAX_FAILURES + 1;
    for n in 1..=loads + 1 {
        git.hook(GitCall::LsFiles, listed + n, "exit 1");
    }
    tmp.write(".gitignore", "venv/\n# one write\n");
    git.wait_for_calls(GitCall::LsFiles, listed + 1).await;
    for n in 1..=loads {
        rescan(&filer).await;
        assert_eq!(
            git.calls(GitCall::LsFiles),
            listed + 1 + n,
            "load {n} re-prunes"
        );
        assert!(filer.ignored_paths().is_some(), "fell back at load {n}");
    }
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt"])).await;
}

/// [`REPRUNE_MAX_FAILURES`] re-prunes a change on disk asked for failing in
/// a row fall back to fixed names, whatever failing retries come between.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rule_changes_on_a_failing_git_fall_back_to_fixed_names() {
    let tmp = checkout(&[
        (".gitignore", "venv/\n"),
        ("venv/lib/a.py", "a"),
        ("a.txt", "a"),
    ]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    let listed = git.calls(GitCall::LsFiles);
    let failing = REPRUNE_MAX_FAILURES * 2;
    for n in 1..=failing {
        git.hook(GitCall::LsFiles, listed + n, "exit 1");
    }
    for n in 1..=REPRUNE_MAX_FAILURES {
        assert!(state.git.is_some(), "fell back before change {n}");
        state.reprune(false, RepruneTrigger::Change).await;
        if n < REPRUNE_MAX_FAILURES {
            // a failing retry between changes counts for nothing
            assert!(state.reprune_if_failing().await, "retried");
            assert!(state.git.is_some(), "a retry's failure counted");
        }
    }
    assert_eq!(
        git.calls(GitCall::LsFiles),
        listed + REPRUNE_MAX_FAILURES * 2 - 1
    );
    assert!(state.git.is_none(), "fell back");
    assert_eq!(
        indexed(&state).await,
        tmp.keys(&[".gitignore", "a.txt", "venv/lib/a.py"])
    );
    assert!(!state.reprune_if_failing().await, "fixed names don't retry");
}

/// Bursts dropped while a re-prune settles still drop the watches their
/// removes and renames took: a dir removed (or moved away) and made again
/// meanwhile is watched again by the re-prune's walk, and a file deleted
/// meanwhile leaves the index.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dir_remade_while_a_re_prune_settles_is_watched_again() {
    let tmp = checkout(&[
        (".gitignore", "*.log\n"),
        ("a.txt", "a"),
        ("d/old.txt", "o"),
        ("e/old.txt", "o"),
    ]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    tmp.write(".gitignore", "*.log\n*.tmp\n");
    tokio::time::sleep(Duration::from_millis(50)).await;
    std::fs::remove_file(tmp.path("a.txt")).unwrap();
    std::fs::remove_dir_all(tmp.path("d")).unwrap();
    std::fs::create_dir(tmp.path("d")).unwrap();
    let away = TempDir::new();
    std::fs::rename(tmp.path("e"), away.path("e")).unwrap();
    std::fs::create_dir(tmp.path("e")).unwrap();
    // the re-prune's listing, and the one after its walk
    git.wait_for_calls(GitCall::LsFiles, listed + 2).await;
    tmp.write("d/new.txt", "n");
    tmp.write("e/new.txt", "n");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "d/new.txt", "e/new.txt"])).await;
}

// -- The `info/exclude` watch -------------------------------------------------

/// The filer's own watcher watches `.git/info/`, and keeps it through an
/// overflow's rebuild of every watch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn info_exclude_is_watched_by_the_filer_watcher_through_a_rebuild() {
    let tmp = checkout(&[("a.txt", "a"), ("b.txt", "b"), ("secret.txt", "s")]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    assert!(filer.watches.lock().is_git_info_watched());
    let listed = git.calls(GitCall::LsFiles);
    filer.signal.request();
    git.wait_for_calls(GitCall::LsFiles, listed + 2).await;
    tmp.write(".git/info/exclude", "secret.txt\n");
    wait_for_keys(&filer, &tmp.keys(&["a.txt", "b.txt"])).await;
    assert!(filer.watches.lock().is_git_info_watched());
    // and again after another rebuild
    let listed = git.calls(GitCall::LsFiles);
    filer.signal.request();
    git.wait_for_calls(GitCall::LsFiles, listed + 2).await;
    tmp.write(".git/info/exclude", "secret.txt\nb.txt\n");
    wait_for_keys(&filer, &tmp.keys(&["a.txt"])).await;
}

/// No watch for a plain dir, nor through a symlinked `info/`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn info_is_watched_only_as_a_real_dir_of_a_checkout() {
    let plain = TempDir::new();
    plain.write("a.txt", "a");
    let filer = start(&plain, FilerConfig::tree(&plain.root(), "/nowhere/")).await;
    assert!(!filer.watches.lock().is_git_info_watched());

    let tmp = checkout(&[("a.txt", "a")]);
    let elsewhere = TempDir::new();
    std::fs::rename(tmp.path(".git/info"), elsewhere.path("info")).unwrap();
    std::os::unix::fs::symlink(elsewhere.path("info"), tmp.path(".git/info")).unwrap();
    let filer = start_git(&tmp).await;
    assert!(filer.ignored_paths().is_some());
    assert!(!filer.watches.lock().is_git_info_watched());
}

// -- Vetting ------------------------------------------------------------------

/// A path missing when its burst is vetted is asked about as a file, so
/// it isn't indexed unasked when it's back by the time its event applies.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_path_missing_when_vetted_is_asked_about_as_a_file() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    tmp.write("b.txt", "b");
    let checked = git.calls(GitCall::CheckIgnore);
    git.hook(
        GitCall::CheckIgnore,
        checked + 1,
        &write_hook(&tmp, &["x.log"]),
    );
    let paths = [tmp.path("b.txt"), tmp.path("x.log")];
    state
        .handle_burst(vec![event(EventKind::Create(CreateKind::File), &paths)])
        .await;
    assert_eq!(
        indexed(&state).await,
        tmp.keys(&[".gitignore", "a.txt", "b.txt"])
    );
}

/// A file turned into a dir while git answered for it is asked about again,
/// as the dir: pruned whole, never walked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_turned_dir_while_vetted_is_asked_about_as_the_dir() {
    let tmp = checkout(&[(".gitignore", "out/\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    tmp.write("out", "a file, which `out/` doesn't name");
    let checked = git.calls(GitCall::CheckIgnore);
    let out = tmp.path("out");
    git.hook(
        GitCall::CheckIgnore,
        checked + 1,
        &format!(
            "rm -f '{0}' && mkdir '{0}' && echo a > '{0}/a.txt'",
            out.display()
        ),
    );
    state
        .handle_burst(vec![event(EventKind::Create(CreateKind::File), &[out])])
        .await;
    assert!(state.rule.get().prunes_dir(&tmp.path("out")));
    assert_eq!(indexed(&state).await, tmp.keys(&[".gitignore", "a.txt"]));
    assert!(
        !state
            .watches
            .lock()
            .is_watched(&dir_prefix(&tmp.key("out")))
    );
    assert!(state.reprune_due().is_none());
}

/// A failed re-prune whose own scan git can't vet either leaves the new
/// files it found unindexed — the re-prune that scan requests is dropped,
/// as a failure never retries itself — until a pass vets them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_re_prune_leaves_what_it_couldnt_vet_unindexed() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    let listed = git.calls(GitCall::LsFiles);
    let checked = git.calls(GitCall::CheckIgnore);
    git.hook(GitCall::LsFiles, listed + 1, "exit 1");
    git.hook(GitCall::CheckIgnore, checked + 1, "exit 1");
    tmp.write(".gitignore", "*.log\n*.tmp\n");
    tmp.write("x.tmp", "x");
    tmp.write("y.txt", "y");
    state.reprune(false, RepruneTrigger::Change).await;
    assert_eq!(
        git.calls(GitCall::CheckIgnore),
        checked + 1,
        "its scan asked"
    );
    assert_eq!(indexed(&state).await, tmp.keys(&[".gitignore", "a.txt"]));
    assert!(state.reprune_due().is_none(), "no retry");
    state.rescan(false).await;
    assert_eq!(
        indexed(&state).await,
        tmp.keys(&[".gitignore", "a.txt", "y.txt"])
    );
}

/// A burst whose vetting fails drops the watches its removes took, as a
/// burst dropped while a re-prune settles does: a dir removed and made
/// again in it is watched again by the re-prune's walk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_failing_its_vetting_drops_the_watches_its_removes_took() {
    let tmp = checkout(&[
        (".gitignore", "*.log\n"),
        ("a.txt", "a"),
        ("d/old.txt", "o"),
    ]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    let d = dir_prefix(&tmp.key("d"));
    assert!(state.watches.lock().is_watched(&d));
    let checked = git.calls(GitCall::CheckIgnore);
    git.hook(GitCall::CheckIgnore, checked + 1, "exit 1");
    std::fs::remove_dir_all(tmp.path("d")).unwrap();
    std::fs::create_dir(tmp.path("d")).unwrap();
    tmp.write("n.txt", "n");
    state
        .handle_burst(vec![
            event(EventKind::Remove(RemoveKind::Folder), &[tmp.path("d")]),
            event(EventKind::Create(CreateKind::Folder), &[tmp.path("d")]),
            event(EventKind::Create(CreateKind::File), &[tmp.path("n.txt")]),
        ])
        .await;
    assert_eq!(
        git.calls(GitCall::CheckIgnore),
        checked + 1,
        "vetted, failing"
    );
    assert!(state.reprune_due().is_some());
    assert!(!state.watches.lock().is_watched(&d), "its watch dropped");
    state.run_pending_reprune(Instant::now()).await;
    assert!(state.watches.lock().is_watched(&d), "watched again");
    assert_eq!(
        indexed(&state).await,
        tmp.keys(&[".gitignore", "a.txt", "n.txt"])
    );
}

/// More new paths than one check takes re-prune instead.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_too_big_to_vet_re_prunes() {
    let tmp = checkout(&[("a.txt", "a")]);
    let mut state = git_state(&tmp, test_git()).await;
    let paths: Vec<_> = (0..=VET_MAX_PATHS)
        .map(|n| {
            let rel = format!("n{n}.txt");
            tmp.write(&rel, "n");
            tmp.path(&rel)
        })
        .collect();
    state
        .handle_burst(vec![event(EventKind::Create(CreateKind::File), &paths)])
        .await;
    assert!(state.reprune_due().is_some());
    assert_eq!(indexed(&state).await, tmp.keys(&["a.txt"]), "dropped");
}

/// More new files than one check takes, found by a rescan, stay out
/// unvetted — the indexed ones kept — and re-prune, which indexes them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rescan_finding_too_many_to_vet_re_prunes() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    let checked = git.calls(GitCall::CheckIgnore);
    let added: Vec<String> = (0..=VET_MAX_PATHS).map(|n| format!("n{n}.txt")).collect();
    for rel in &added {
        tmp.write(rel, "n");
    }
    tmp.write("x.log", "x");
    state.rescan(false).await;
    assert_eq!(git.calls(GitCall::CheckIgnore), checked, "not checked");
    assert_eq!(
        indexed(&state).await,
        tmp.keys(&[".gitignore", "a.txt"]),
        "the new dropped, the indexed kept"
    );
    assert!(state.reprune_due().is_some());
    state.run_pending_reprune(Instant::now()).await;
    let mut expected: Vec<&str> = added.iter().map(String::as_str).collect();
    expected.extend([".gitignore", "a.txt"]);
    assert_eq!(indexed(&state).await, tmp.keys(&expected));
}

/// An ignored dir replaced by a file of its name: the file is vetted, and
/// indexed when git doesn't ignore it — and a dir back again is ignored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ignored_dir_replaced_by_a_file_is_vetted_as_the_file() {
    let tmp = checkout(&[
        (".gitignore", "build/\n"),
        ("build/a.txt", "a"),
        ("c.txt", "c"),
    ]);
    let filer = start_git(&tmp).await;
    assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore", "c.txt"]));
    std::fs::remove_dir_all(tmp.path("build")).unwrap();
    tmp.write("build", "now a file");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "build", "c.txt"])).await;
    std::fs::remove_file(tmp.path("build")).unwrap();
    tmp.write("build/x.txt", "x");
    tmp.write("d.txt", "d");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", "c.txt", "d.txt"])).await;
    // a path indexed as a file isn't vetted when it's a dir again: its walk
    // finds the ignored files, which re-prunes
    wait_until(&filer, "build pruned", |filer| {
        ignores(filer, &tmp, "build")
    })
    .await;
}

/// A rescan that walks a dir no event vetted — one a `.git` left — finds
/// its ignored files one by one, and re-prunes: git's listing prunes their
/// dir whole, unwatched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dir_a_repo_left_is_re_pruned_not_vetted_file_by_file() {
    let tmp = checkout(&[
        (".gitignore", "node_modules/\n"),
        ("a.txt", "a"),
        ("plain/b.txt", "b"),
        ("plain/node_modules/dep/x.js", "x"),
        ("plain/node_modules/dep/y.js", "y"),
    ]);
    run_git(&tmp.path("plain"), &["init", "-q"]);
    let filer = start_git(&tmp).await;
    assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore", "a.txt"]));
    std::fs::remove_dir_all(tmp.path("plain/.git")).unwrap();
    rescan(&filer).await;
    // the re-prune the first requested runs before the loop takes this one
    rescan(&filer).await;
    assert!(ignores(&filer, &tmp, "plain/node_modules"));
    assert!(!watches_under(&filer, &tmp, "plain/node_modules"));
    assert_eq!(
        keys_of(&filer).await,
        tmp.keys(&[".gitignore", "a.txt", "plain/b.txt"])
    );
}

/// While degraded, a `.gitignore` only a poll sees re-prunes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gitignore_a_degraded_poll_finds_re_prunes() {
    let tmp = checkout(&[("a.txt", "a"), ("sub/x.md", "x")]);
    let config = FilerConfig {
        watch_limit: Some(1),
        degraded_rescan_interval: Duration::from_millis(100),
        ..config_with_git(&tmp, test_git())
    };
    let filer = start(&tmp, config).await;
    assert_eq!(keys_of(&filer).await, tmp.keys(&["a.txt", "sub/x.md"]));
    tmp.write("sub/.gitignore", "*.md\n");
    wait_for_keys(&filer, &tmp.keys(&["a.txt", "sub/.gitignore"])).await;
}

/// git refuses to answer for a path inside an unpopulated submodule: the
/// submodule is left unindexed, as a populated one is, and the rest of the
/// burst vetted without a re-prune.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unpopulated_submodule_is_left_unindexed_without_a_re_prune() {
    let source = checkout(&[("lib.rs", "x")]);
    run_git(&source.0, &["add", "."]);
    run_git(&source.0, &["commit", "-qm", "init"]);
    let tmp = checkout(&[(".gitignore", "*.log\n")]);
    run_git(
        &tmp.0,
        &["submodule", "add", "-q", source.0.to_str().unwrap(), "sub"],
    );
    run_git(&tmp.0, &["commit", "-qm", "sub"]);
    run_git(&tmp.0, &["submodule", "deinit", "-q", "-f", "sub"]);
    let git = HookedGit::new();
    let filer = start(&tmp, config_with_git(&tmp, Arc::clone(&git.git))).await;
    let listed = git.calls(GitCall::LsFiles);
    tmp.write("sub/f.txt", "f");
    tmp.write("sub/g.log", "g");
    tmp.write("a.txt", "a");
    tmp.write("b.log", "b");
    wait_for_keys(&filer, &tmp.keys(&[".gitignore", ".gitmodules", "a.txt"])).await;
    tmp.write("sub/h.txt", "h");
    tmp.write("c.txt", "c");
    wait_for_keys(
        &filer,
        &tmp.keys(&[".gitignore", ".gitmodules", "a.txt", "c.txt"]),
    )
    .await;
    assert_eq!(git.calls(GitCall::LsFiles), listed, "no re-prune");
    assert!(!watches_under(&filer, &tmp, "sub"));
    assert!(!ignores(&filer, &tmp, "sub"), "not published as ignored");
    let wire = filer.ignored_on_wire(&tmp.root()).unwrap();
    assert_eq!(*wire.nested, ["sub/"], "published as a repo of its own");
}

/// A burst touching several unpopulated submodules asks again once per
/// submodule git refuses it for, leaving each unindexed without a
/// re-prune.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn several_unpopulated_submodules_in_one_burst_are_left_unindexed() {
    let source = checkout(&[("lib.rs", "x")]);
    run_git(&source.0, &["add", "."]);
    run_git(&source.0, &["commit", "-qm", "init"]);
    let tmp = checkout(&[(".gitignore", "*.log\n")]);
    for sub in ["s1", "s2", "s3"] {
        run_git(
            &tmp.0,
            &["submodule", "add", "-q", source.0.to_str().unwrap(), sub],
        );
    }
    run_git(&tmp.0, &["commit", "-qm", "subs"]);
    for sub in ["s1", "s2", "s3"] {
        run_git(&tmp.0, &["submodule", "deinit", "-q", "-f", sub]);
    }
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    let listed = git.calls(GitCall::LsFiles);
    let rels = ["s1/f.txt", "s2/f.txt", "s3/g.log", "a.txt", "b.log"];
    for rel in rels {
        tmp.write(rel, "x");
    }
    let paths: Vec<_> = rels.iter().map(|rel| tmp.path(rel)).collect();
    state
        .handle_burst(vec![event(EventKind::Create(CreateKind::File), &paths)])
        .await;
    assert!(state.reprune_due().is_none(), "no re-prune");
    assert_eq!(git.calls(GitCall::LsFiles), listed);
    assert_eq!(
        indexed(&state).await,
        tmp.keys(&[".gitignore", ".gitmodules", "a.txt"])
    );
}

/// A refusal naming a submodule already dropped fails at once rather than
/// asking again: a path spelled through `..` reaches the submodule without
/// sharing its prefix, so dropping its paths can't drop that one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repeated_submodule_refusal_fails_without_asking_again() {
    let source = checkout(&[("lib.rs", "x")]);
    run_git(&source.0, &["add", "."]);
    run_git(&source.0, &["commit", "-qm", "init"]);
    let tmp = checkout(&[(".gitignore", "*.log\n")]);
    run_git(
        &tmp.0,
        &["submodule", "add", "-q", source.0.to_str().unwrap(), "sub"],
    );
    run_git(&tmp.0, &["commit", "-qm", "sub"]);
    run_git(&tmp.0, &["submodule", "deinit", "-q", "-f", "sub"]);
    let git = HookedGit::new();
    let root = GitRoot::at(&tmp.root(), Arc::clone(&git.git)).unwrap();
    let checked = git.calls(GitCall::CheckIgnore);
    let paths = vec![tmp.key("sub/f.txt"), tmp.key("x/../sub/g.txt")];
    assert!(root.check(paths).await.is_err());
    assert_eq!(
        git.calls(GitCall::CheckIgnore),
        checked + 2,
        "the refusal, and the one repeating it"
    );
}

// -- The rule reviewer's killing tests ----------------------------------------

/// A dir below the root reached through a symlinked ancestor is refused
/// before git runs, not just a symlinked root.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dir_under_a_symlinked_ancestor_is_refused() {
    let tmp = checkout(&[("a.txt", "a")]);
    let elsewhere = checkout(&[("b/c.txt", "c")]);
    std::os::unix::fs::symlink(&elsewhere.0, tmp.path("link")).unwrap();
    let root = GitRoot::at(&tmp.root(), test_git()).unwrap();
    let error = root.prune(tmp.path("link/b")).await.unwrap_err();
    assert!(
        matches!(error, super::ignore::IgnoreError::Unconfined(_)),
        "{error}"
    );
}

/// A dir arriving that looks like a git dir (a planted repo naming itself
/// its own work tree, every path excluded) isn't read as one — the listing
/// that would hide its files is refused, and the re-prune from the root
/// indexes them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_planted_git_dir_arriving_is_not_read_as_a_repo() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let filer = start_git(&tmp).await;
    let staging = TempDir::new();
    run_git(&staging.0, &["init", "-q", "--bare", "pkg"]);
    let pkg = staging.path("pkg");
    let final_pkg = tmp.path("pkg");
    std::fs::write(
        pkg.join("config"),
        format!(
            "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = {}\n",
            final_pkg.display()
        ),
    )
    .unwrap();
    std::fs::create_dir_all(pkg.join("info")).unwrap();
    std::fs::write(pkg.join("info/exclude"), "*\n").unwrap();
    std::fs::write(pkg.join("note.txt"), "n").unwrap();
    std::fs::rename(&pkg, &final_pkg).unwrap();
    let note = tmp.key("pkg/note.txt");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !keys_of(&filer).await.contains(&note) {
        assert!(Instant::now() < deadline, "{:?}", keys_of(&filer).await);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Churn of uniquely named ignored files (whose deletes are filtered out)
/// re-prunes once the set has grown past its cap.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignored_churn_re_prunes_the_set_back_down() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("logs/keep.txt", "k")]);
    let filer = start_git(&tmp).await;
    let mut n = 0;
    for _ in 0..22 {
        let batch: Vec<String> = (0..500)
            .map(|i| tmp.key(&format!("logs/{}.log", n + i)))
            .collect();
        n += 500;
        for path in &batch {
            std::fs::write(path, "x").unwrap();
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        for path in &batch {
            std::fs::remove_file(path).unwrap();
        }
    }
    // the re-prune brings the set back down: wait for it, not for a time
    wait_until(&filer, "the set to drop the deleted files", |filer| {
        filer.ignored_paths().unwrap().len() < 10_000
    })
    .await;
}

/// A rescan's walk (here a degraded filer's, with no watcher) vets the new
/// files it finds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rescan_vets_the_new_files_it_finds() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let config = FilerConfig {
        no_watcher: true,
        degraded_rescan_interval: Duration::from_secs(3600),
        ..config_with_git(&tmp, test_git())
    };
    let filer = start(&tmp, config).await;
    tmp.write("b.log", "b");
    tmp.write("c.txt", "c");
    rescan(&filer).await;
    assert_eq!(
        keys_of(&filer).await,
        tmp.keys(&[".gitignore", "a.txt", "c.txt"])
    );
    assert!(ignores(&filer, &tmp, "b.log"));
}

/// A rescan whose check of its new files fails leaves them unindexed and
/// re-prunes, which indexes them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rescan_failing_to_vet_re_prunes() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    let checked = git.calls(GitCall::CheckIgnore);
    git.hook(GitCall::CheckIgnore, checked + 1, "exit 1");
    tmp.write("y.txt", "y");
    state.rescan(false).await;
    assert_eq!(
        git.calls(GitCall::CheckIgnore),
        checked + 1,
        "vetted, failing"
    );
    assert_eq!(indexed(&state).await, tmp.keys(&[".gitignore", "a.txt"]));
    assert!(state.reprune_due().is_some());
    state.run_pending_reprune(Instant::now()).await;
    assert_eq!(
        indexed(&state).await,
        tmp.keys(&[".gitignore", "a.txt", "y.txt"])
    );
}

/// A file event from a dir that just became a repo of its own, arriving in
/// the burst after its `.git`, isn't indexed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_arriving_after_its_dir_became_a_repo_is_not_indexed() {
    let tmp = checkout(&[("a.txt", "a"), ("plain/b.txt", "b")]);
    let filer = start_git(&tmp).await;
    for i in 0..20 {
        std::fs::create_dir(tmp.path("plain/.git")).unwrap();
        tmp.write(&format!("plain/new{i}.txt"), "n");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(keys_of(&filer).await, tmp.keys(&["a.txt"]), "round {i}");
        std::fs::remove_dir(tmp.path("plain/.git")).unwrap();
        // a `.git` leaving shows at the next rescan
        rescan(&filer).await;
        let mut expected = vec![tmp.key("a.txt"), tmp.key("plain/b.txt")];
        expected.extend((0..=i).map(|j| tmp.key(&format!("plain/new{j}.txt"))));
        expected.sort();
        wait_for_keys(&filer, &expected).await;
    }
}

/// A `.gitignore` that ignores itself still re-prunes when edited.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gitignore_ignoring_itself_still_re_prunes() {
    let tmp = checkout(&[
        (".gitignore", ".gitignore\n*.log\n"),
        ("a.log", "a"),
        ("b.txt", "b"),
    ]);
    let filer = start_git(&tmp).await;
    assert_eq!(keys_of(&filer).await, tmp.keys(&["b.txt"]));
    tmp.write(".gitignore", ".gitignore\n");
    wait_for_keys(&filer, &tmp.keys(&["a.log", "b.txt"])).await;
}

/// A dir that just became a repo of its own takes a file event two levels
/// below it out of the index too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deeper_file_after_its_ancestor_became_a_repo_is_not_indexed() {
    let tmp = checkout(&[("a.txt", "a"), ("plain/sub/b.txt", "b")]);
    let filer = start_git(&tmp).await;
    for i in 0..10 {
        std::fs::create_dir(tmp.path("plain/.git")).unwrap();
        tmp.write(&format!("plain/sub/new{i}.txt"), "n");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(keys_of(&filer).await, tmp.keys(&["a.txt"]), "round {i}");
        std::fs::remove_dir(tmp.path("plain/.git")).unwrap();
        rescan(&filer).await;
    }
}

// -- The ignored set on the wire ----------------------------------------------

/// A running git filer on `tmp` whose broadcasts and ignored-change calls
/// are recorded: the paths of each `filer_change`, and a call count.
async fn start_recorded(
    tmp: &TempDir,
) -> (
    Filer,
    Arc<parking_lot::Mutex<Vec<String>>>,
    Arc<std::sync::atomic::AtomicUsize>,
) {
    let broadcasts: Arc<parking_lot::Mutex<Vec<String>>> = Arc::default();
    let calls: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let sink = Arc::clone(&broadcasts);
    let counter = Arc::clone(&calls);
    let config = FilerConfig {
        on_ignored_change: Some(Arc::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })),
        ..config_with_git(tmp, test_git())
    };
    let filer = super::core::start_filer(
        &tmp.root(),
        Arc::new(move |message: &str| {
            let message: serde_json::Value = serde_json::from_str(message).unwrap();
            let path = message["params"]["change"]["path"].as_str().unwrap();
            sink.lock().push(path.to_owned());
        }),
        config,
    )
    .await
    .unwrap();
    (filer, broadcasts, calls)
}

/// A checkout with `n` files in an ignored `big/` and one plain file.
fn big_ignored_checkout(n: usize) -> TempDir {
    let tmp = checkout(&[(".gitignore", "big/\n"), ("a.txt", "a")]);
    std::fs::create_dir_all(tmp.path("big")).unwrap();
    for i in 0..n {
        std::fs::write(tmp.path(&format!("big/{i}.js")), "x").unwrap();
    }
    tmp
}

/// Un-ignoring a big tree on the wire sends no `filer_change` per file: it
/// bumps the resync count, and the filer asks for a refresh once its index
/// holds the whole tree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_big_re_prune_on_the_wire_resyncs_instead_of_broadcasting() {
    let n = super::REPRUNE_BROADCAST_MAX + 10;
    let tmp = big_ignored_checkout(n);
    let (filer, broadcasts, calls) = start_recorded(&tmp).await;
    filer.set_on_wire(true);
    let root = tmp.root();
    let before = filer.ignored_on_wire(&root).unwrap();
    assert_eq!(before.resyncs, 0);
    assert!(before.paths.contains(&"big/".to_owned()), "{before:?}");

    tmp.write(".gitignore", "");
    wait_until(&filer, "the resync", |filer| {
        filer.ignored_on_wire(&root).unwrap().resyncs == 1
    })
    .await;
    // the refresh is asked for after the re-prune, so its pull reads all
    wait_until(&filer, "the refresh", |_| {
        calls.load(std::sync::atomic::Ordering::SeqCst) >= 1
    })
    .await;
    assert_eq!(filer.files.read().await.len(), n + 2);
    let after = filer.ignored_on_wire(&root).unwrap();
    assert!(!after.paths.contains(&"big/".to_owned()), "{after:?}");
    // past the debounce: nothing under `big/` went out
    // TODO: an absence after a sleep — exact needs the broadcast debounce to
    // report a flush with nothing pending (a test hook on the filer).
    tokio::time::sleep(Duration::from_millis(700)).await;
    let big = tmp.key("big/");
    assert!(
        !broadcasts.lock().iter().any(|path| path.starts_with(&big)),
        "a per-file change went out"
    );
}

/// Off the wire (a permanent filer alone) nobody would pull, so the same
/// re-prune sends every change; and one under the threshold sends them
/// either way.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_re_prune_off_the_wire_or_under_the_threshold_broadcasts_each_change() {
    let n = super::REPRUNE_BROADCAST_MAX + 10;
    for (files, on_wire) in [(n, false), (20, true)] {
        let tmp = big_ignored_checkout(files);
        let (filer, broadcasts, _) = start_recorded(&tmp).await;
        filer.set_on_wire(on_wire);
        tmp.write(".gitignore", "");
        let big = tmp.key("big/");
        let deadline = Instant::now() + Duration::from_secs(20);
        while broadcasts
            .lock()
            .iter()
            .filter(|path| path.starts_with(&big))
            .count()
            < files
        {
            assert!(
                Instant::now() < deadline,
                "{files} {on_wire}: not every change went out"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(filer.ignored_on_wire(&tmp.root()).unwrap().resyncs, 0);
    }
}

/// The publisher calls at once, then at most once per interval however
/// often it's signalled, and keeps a signal raised meanwhile.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignored_changes_are_published_at_most_once_per_interval() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let signal = Arc::new(super::core::RescanSignal::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let interval = Duration::from_millis(600);
    let task = tokio::spawn(super::core::publish_ignored_changes(
        Arc::clone(&signal),
        Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
        interval,
    ));
    let count = || calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(count(), 0, "nothing signalled");
    let started = Instant::now();
    for _ in 0..5 {
        signal.request();
    }
    while count() == 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // a burst inside the interval waits it out
    for _ in 0..5 {
        signal.request();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if started.elapsed() < interval {
        assert_eq!(count(), 1, "held for the interval");
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while count() < 2 {
        assert!(Instant::now() < deadline, "the burst was dropped");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(started.elapsed() >= interval, "the second came early");
    tokio::time::sleep(interval * 2).await;
    assert_eq!(count(), 2, "the burst, once; nothing more signalled");
    task.abort();
}

/// a re-prune that resyncs with the rule unchanged (an overflow
/// over a big unseen tree) still asks for a refresh — the count alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resync_alone_asks_for_a_refresh() {
    let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.txt", "a")]);
    let calls: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let counter = Arc::clone(&calls);
    let config = FilerConfig {
        on_ignored_change: Some(Arc::new(move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })),
        no_watcher: true,
        degraded_rescan_interval: Duration::from_secs(3600),
        ..config_with_git(&tmp, test_git())
    };
    let filer = super::core::start_filer(&tmp.root(), Arc::new(|_: &str| {}), config)
        .await
        .unwrap();
    filer.set_on_wire(true);
    let version = filer.ignored_version();
    std::fs::create_dir_all(tmp.path("new")).unwrap();
    for i in 0..super::REPRUNE_BROADCAST_MAX + 10 {
        std::fs::write(tmp.path(&format!("new/{i}.js")), "x").unwrap();
    }
    filer.signal.request();
    let root = tmp.root();
    wait_until(&filer, "the resync", |filer| {
        filer.ignored_on_wire(&root).unwrap().resyncs == 1
    })
    .await;
    assert_eq!(filer.ignored_version(), version, "the rule didn't move");
    wait_until(&filer, "the refresh", |_| {
        calls.load(std::sync::atomic::Ordering::SeqCst) >= 1
    })
    .await;
}

/// A rule change pending when a load or poll retries is taken by the retry
/// (`FilerState::reprune_if_failing`) and counts as the change it is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rule_change_a_retry_takes_counts() {
    let tmp = checkout(&[(".gitignore", "venv/\n"), ("a.txt", "a")]);
    let git = HookedGit::new();
    let mut state = git_state(&tmp, Arc::clone(&git.git)).await;
    let listed = git.calls(GitCall::LsFiles);
    for n in 1..=REPRUNE_MAX_FAILURES {
        git.hook(GitCall::LsFiles, listed + n, "exit 1");
    }
    for _ in 1..REPRUNE_MAX_FAILURES {
        state.reprune(false, RepruneTrigger::Change).await;
    }
    assert!(state.git.is_some());
    // a `.gitignore` edit settling, not yet due, when a load retries
    state.reprune = Some(PendingReprune::settled(None, Instant::now()));
    assert!(state.reprune_if_failing().await);
    assert!(state.reprune.is_none(), "taken");
    assert!(state.git.is_none(), "the taken rule change counted");
}
