//! Binary-level integration tests for `zzz daemon` / `zzz status`.
//!
//! `zzz` is a bin-only crate, so integration tests can't import its
//! modules — they drive the compiled binary (`CARGO_BIN_EXE_zzz`) against
//! an isolated temp `$HOME`. These cover the status read-back paths
//! (no-daemon, stale-daemon cleanup) without needing a real `zzz_server`
//! or a database. The full `daemon start` ↔ live-server e2e (which needs
//! Postgres) is left to a later, infra-gated test.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration test: panics are assertion failures by design"
)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const fn zzz_bin() -> &'static str {
    env!("CARGO_BIN_EXE_zzz")
}

/// A unique temp dir to use as `$HOME` (no `tempfile` dep in this crate).
fn temp_home(tag: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("zzz_cli_it_{}_{tag}_{nonce}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn daemon_status_json_reports_not_running_when_no_daemon() {
    let home = temp_home("none");
    let out = Command::new(zzz_bin())
        .args(["daemon", "status", "--json"])
        .env("HOME", &home)
        .output()
        .expect("run zzz daemon status");

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("\"running\":false"),
        "expected running:false, got: {stdout}"
    );

    let _ = fs::remove_dir_all(&home);
}

#[test]
fn daemon_status_cleans_up_stale_daemon_json() {
    let home = temp_home("stale");
    let run_dir = home.join(".zzz").join("run");
    fs::create_dir_all(&run_dir).unwrap();
    let daemon_json = run_dir.join("daemon.json");
    // A valid-i32 pid that is not a running process.
    fs::write(
        &daemon_json,
        r#"{"version":1,"pid":2000000000,"port":59999,"started":"2026-05-30T00:00:00Z","app_version":"test"}"#,
    )
    .unwrap();

    let out = Command::new(zzz_bin())
        .args(["daemon", "status"]) // non-json path performs stale cleanup
        .env("HOME", &home)
        .output()
        .expect("run zzz daemon status");

    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("stale"), "expected a stale notice, got: {stdout}");
    assert!(
        !daemon_json.exists(),
        "stale daemon.json should have been cleaned up"
    );

    let _ = fs::remove_dir_all(&home);
}
