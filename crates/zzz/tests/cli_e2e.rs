//! End-to-end test: `zzz daemon start` ↔ a live `testing_zzz_server`.
//!
//! Unlike `cli_daemon.rs` (which only exercises the daemon.json read-back
//! paths with no real server), this drives the full lifecycle against a
//! spawned backend: `daemon start` → poll `daemon status --json` until
//! healthy → `daemon stop` → assert `daemon.json` is gone.
//!
//! Infra-gated like the cross-backend vitest projects: it self-skips unless
//! `ZZZ_TEST_E2E=1`. When opted in, it needs:
//!   - a built `testing_zzzd` binary (the fast-argon2 test binary;
//!     `cargo build -p testing_zzz_server`), found beside the `zzz` test
//!     binary or via `ZZZ_SERVER_BIN`;
//!   - a reachable `PostgreSQL` DB (`DATABASE_URL`, default
//!     `postgres://localhost/zzz_test`).
//!
//! Run it with:
//! ```bash
//! cargo build -p testing_zzz_server
//! ZZZ_TEST_E2E=1 cargo test -p zzz --test cli_e2e -- --nocapture
//! ```

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration test: panics are assertion failures by design"
)]

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const fn zzz_bin() -> &'static str {
    env!("CARGO_BIN_EXE_zzz")
}

/// The `testing_zzzd` binary: `ZZZ_SERVER_BIN` override, else beside the
/// `zzz` test binary (same `target/<profile>/` dir).
fn testing_server_bin() -> PathBuf {
    if let Some(path) = std::env::var_os("ZZZ_SERVER_BIN") {
        return PathBuf::from(path);
    }
    PathBuf::from(zzz_bin())
        .parent()
        .expect("zzz bin has a parent dir")
        .join("testing_zzzd")
}

/// A unique temp dir to use as `$HOME` (no `tempfile` dep in this crate).
fn temp_home(tag: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir =
        std::env::temp_dir().join(format!("zzz_cli_e2e_{}_{tag}_{nonce}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn daemon_start_status_stop_against_live_server() {
    if std::env::var_os("ZZZ_TEST_E2E").is_none() {
        eprintln!("skipping cli_e2e: set ZZZ_TEST_E2E=1 (needs Postgres + testing_zzz_server)");
        return;
    }

    let server_bin = testing_server_bin();
    assert!(
        server_bin.exists(),
        "testing_zzzd not found at {} — run `cargo build -p testing_zzz_server` or set ZZZ_SERVER_BIN",
        server_bin.display()
    );

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://localhost/zzz_test".to_string());
    let home = temp_home("lifecycle");
    // Take a free port from the OS (bind :0, read it, release) so concurrent
    // runs don't collide on a pid-derived guess. A small TOCTOU window remains
    // before the daemon rebinds it, which is acceptable for a gated e2e.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        listener.local_addr().expect("read local_addr").port()
    };

    // `zzz daemon start` runs the server in the foreground, so spawn it as a
    // child and drive `status` / `stop` against it from this test process.
    let mut start = Command::new(zzz_bin())
        .args(["daemon", "start", "--port", &port.to_string()])
        .env("HOME", &home)
        .env("ZZZ_SERVER_BIN", &server_bin)
        .env("DATABASE_URL", &database_url)
        .env(
            "SECRET_FUZ_COOKIE_KEYS",
            "dev-only-not-for-production-use-000",
        )
        .env("FUZ_ALLOWED_ORIGINS", "http://localhost:*")
        .env_remove("PORT") // ensure --port wins over any inherited PORT
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn `zzz daemon start`");

    // Poll `daemon status --json` until the server is up (or give up).
    let deadline = Instant::now() + Duration::from_secs(40);
    let mut healthy = false;
    while Instant::now() < deadline {
        if let Some(code) = start.try_wait().expect("try_wait on start child") {
            panic!("`zzz daemon start` exited early with {code} before becoming healthy");
        }
        let out = Command::new(zzz_bin())
            .args(["daemon", "status", "--json"])
            .env("HOME", &home)
            .output()
            .expect("run `zzz daemon status --json`");
        let stdout = String::from_utf8_lossy(&out.stdout);
        if stdout.contains("\"running\":true") && stdout.contains("\"healthy\":true") {
            healthy = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    assert!(healthy, "daemon never reported healthy within the timeout");

    // Stop it via the CLI and confirm a clean shutdown report.
    let stop = Command::new(zzz_bin())
        .args(["daemon", "stop"])
        .env("HOME", &home)
        .output()
        .expect("run `zzz daemon stop`");
    assert!(
        stop.status.success(),
        "stop failed: {}",
        String::from_utf8_lossy(&stop.stderr)
    );
    let stop_stdout = String::from_utf8_lossy(&stop.stdout);
    assert!(
        stop_stdout.contains("stopped") || stop_stdout.contains("SIGTERM"),
        "unexpected stop output: {stop_stdout}"
    );

    // `daemon.json` should be cleaned up once the server exits (by `stop`
    // and/or the `daemon start` foreground loop's own cleanup).
    let daemon_json = home.join(".zzz").join("run").join("daemon.json");
    let gone_deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < gone_deadline && daemon_json.exists() {
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(
        !daemon_json.exists(),
        "daemon.json should be removed after stop"
    );

    // Reap the foreground `start` process (it exits when its child dies).
    let _ = start.kill();
    let _ = start.wait();
    let _ = fs::remove_dir_all(&home);
}
