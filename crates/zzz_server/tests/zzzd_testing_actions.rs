//! `zzzd` mounts no `_testing_*` action, whatever its environment: the
//! backdoors are the `testing_zzzd` binary's alone, mounted through its
//! `extra_action_specs_factory`. `ZZZ_ENABLE_TEST_ACTIONS`, which once
//! mounted them on the production daemon, is set here to pin that it no
//! longer does.
//!
//! The real binary boots on a database of its own (`fuz_testing`'s, pglet by
//! default) and is asked over HTTP: an unknown method answers
//! `method_not_found` before any credential is read, where a mounted one
//! would refuse the anonymous caller instead. `ping` is the control that the
//! RPC route answers at all.

#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers outside `#[test]` fns panic on a failed setup or check"
)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use fuz_testing::{TestEngine, TestingDbOptions};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// A bare database: `zzzd` runs its own migrations on boot.
const DB: TestingDbOptions<'static> = TestingDbOptions {
    suite: "zzzd_testing_actions",
    migrations: &[],
    setup_sql: None,
    engine: TestEngine::Any,
};

/// How long the daemon may take to answer `/health`: a bound on a hang only.
const BOOT_DEADLINE: Duration = Duration::from_secs(60);

/// A fresh directory as the daemon's home, removed when the guard drops.
struct TempHome(PathBuf);

impl TempHome {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "zzzd_testing_actions_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(std::fs::canonicalize(dir).unwrap())
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The daemon, killed and reaped when the guard drops.
struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A loopback port free at the moment of asking.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// One HTTP/1.1 request to the daemon; `None` when nothing answers yet.
async fn request(port: u16, method: &str, path: &str, body: Option<&str>) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
    let body = body.unwrap_or("");
    let head = format!(
        "{method} {path} HTTP/1.1\r\nhost: localhost:{port}\r\ncontent-type: application/json\r\n\
         content-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.ok()?;
    stream.write_all(body.as_bytes()).await.ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).await.ok()?;
    Some(response)
}

/// The JSON-RPC envelope `zzzd` answers `method` with, anonymously.
async fn rpc(port: u16, method: &str, params: &Value) -> Value {
    let mut envelope = json!({"jsonrpc": "2.0", "id": 1, "method": method});
    if !params.is_null() {
        envelope["params"] = params.clone();
    }
    let body = envelope.to_string();
    let response = request(port, "POST", "/api/rpc", Some(&body))
        .await
        .expect("the daemon answers");
    let (_, body) = response.split_once("\r\n\r\n").expect("a response body");
    serde_json::from_str(body).unwrap_or_else(|e| panic!("a JSON-RPC envelope ({e}): {body}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zzzd_mounts_no_testing_action_even_with_the_old_flag_set() {
    let db = DB.open().await;
    let home = TempHome::new();
    let port = free_port();
    let log_path = home.0.join("zzzd.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_zzzd"))
        .current_dir(&home.0)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home.0)
        .env("NO_COLOR", "1")
        .env("DATABASE_URL", db.url())
        .env(
            "SECRET_FUZ_COOKIE_KEYS",
            "testing-actions-test-cookie-key-0123456789abcdef",
        )
        .env("FUZ_ALLOWED_ORIGINS", format!("http://localhost:{port}"))
        .env("PUBLIC_ZZZ_DIR", home.0.join("app"))
        .env("ZZZ_ENABLE_TEST_ACTIONS", "1")
        .args(["--port", &port.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .expect("zzzd spawns");
    let mut daemon = Daemon(child);

    let boot_log = || std::fs::read_to_string(&log_path).unwrap_or_default();
    let deadline = Instant::now() + BOOT_DEADLINE;
    loop {
        if let Some(response) = request(port, "GET", "/health", None).await
            && response.starts_with("HTTP/1.1 200")
        {
            break;
        }
        if let Some(status) = daemon.0.try_wait().unwrap() {
            panic!("zzzd exited ({status}) before it served:\n{}", boot_log());
        }
        assert!(
            Instant::now() < deadline,
            "zzzd never served /health:\n{}",
            boot_log()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let ping = rpc(port, "ping", &Value::Null).await;
    assert!(ping.get("result").is_some(), "the control answers: {ping}");
    // every `_testing_*` action `testing_zzzd` mounts, and the one `zzzd`
    // once mounted under the flag
    for (method, params) in [
        ("_testing_emit_notifications", json!({"count": 0})),
        ("_testing_reset", json!({})),
        ("_testing_drain_effects", Value::Null),
        ("_testing_db_invariants", Value::Null),
        ("_testing_action_manifest", Value::Null),
        (
            "_testing_flood_notifications",
            json!({"count": 0, "size": 0}),
        ),
        ("_testing_credential_read", json!({})),
        ("_testing_origin_check", json!({})),
        ("_testing_shorten_credential_expiry", json!({})),
    ] {
        let answer = rpc(port, method, &params).await;
        assert_eq!(
            answer["error"]["code"], -32601,
            "{method} is not mounted: {answer}"
        );
    }
}
