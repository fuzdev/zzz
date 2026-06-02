//! Daemon-lifecycle primitives for the zzz CLI.
//!
//! The CLI is a thin client that manages the long-running `zzz_server`
//! daemon: it spawns the binary, polls its `/health` endpoint, records a
//! `daemon.json` for discovery, and reads that file back for `status` /
//! `stop`. This module owns the pure-ish plumbing those handlers share.
//!
//! The on-disk contract mirrors `fuz_app`'s `cli/daemon.js`
//! (`~/.zzz/run/daemon.json`, `{version, pid, port, started, app_version}`)
//! so the file stays readable across the CLI's Deno-to-Rust transition.
//! It keeps a **local** `DaemonInfo`: `fuz_sys`'s daemon helpers model a
//! socket-based v2 schema (no `port`) over a UDS transport, whereas
//! `zzz_server` is HTTP/port-based and this file mirrors `fuz_app`'s v1
//! `{port, started, app_version}` wire shape. The OS-level plumbing — PID
//! liveness, signal forwarding, RFC-3339 timestamps, crash-safe atomic
//! writes — does route through `fuz_sys` rather than being re-derived here.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::CliError;

/// Production daemon binary name. The CLI spawns and discovers this.
///
/// The single source of truth for the daemon binary name (the `[[bin]]`
/// target of the `zzz_server` crate), named `zzzd` for fuz/fuzd-style
/// symmetry; nothing else in the CLI hardcodes the name.
pub const DAEMON_BIN: &str = "zzzd";

/// Default daemon port when neither `--port`, `PORT`, nor config supplies one.
pub const DEFAULT_PORT: u16 = 4460;

/// How long `daemon start` waits for the server to report healthy.
pub const HEALTH_TIMEOUT_MS: u64 = 30_000;

/// Poll interval while waiting for health.
pub const HEALTH_POLL_INTERVAL_MS: u64 = 200;

/// Per-request timeout for a single `/health` probe.
pub const HEALTH_REQUEST_TIMEOUT_MS: u64 = 2_000;

/// On-disk daemon record at `~/.zzz/run/daemon.json`.
///
/// Matches `fuz_app`'s `DaemonInfo` shape so the file is interchangeable
/// across the CLI transition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonInfo {
    /// Schema version (currently `1`).
    pub version: u32,
    /// Daemon process id.
    pub pid: u32,
    /// HTTP port the daemon listens on.
    pub port: u16,
    /// ISO-8601 timestamp when the daemon started.
    pub started: String,
    /// `zzz` version that started the daemon.
    pub app_version: String,
}

/// `~/.zzz` — the CLI state directory. Errors if `$HOME` is unset.
pub fn zzz_dir() -> Result<PathBuf, CliError> {
    let home = std::env::var_os("HOME").ok_or(CliError::HomeUnset)?;
    Ok(PathBuf::from(home).join(".zzz"))
}

/// `~/.zzz/run/daemon.json`.
pub fn daemon_info_path() -> Result<PathBuf, CliError> {
    Ok(zzz_dir()?.join("run").join("daemon.json"))
}

/// `~/.zzz/config.json`.
pub fn config_path() -> Result<PathBuf, CliError> {
    Ok(zzz_dir()?.join("config.json"))
}

/// Read and parse `daemon.json`. Returns `None` when absent or unparseable.
#[must_use]
pub fn read_daemon_info() -> Option<DaemonInfo> {
    let path = daemon_info_path().ok()?;
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Atomically write `daemon.json`, creating `run/`. Crash-safe temp → fsync →
/// rename → parent fsync via [`fuz_sys::fs::write_atomic`]; mode `0o644`
/// (the record — pid / port / version — is not secret).
pub fn write_daemon_info(info: &DaemonInfo) -> Result<(), CliError> {
    let run_dir = zzz_dir()?.join("run");
    fs::create_dir_all(&run_dir)?;
    let path = run_dir.join("daemon.json");
    let mut content =
        serde_json::to_string_pretty(info).map_err(|e| CliError::Daemon(e.to_string()))?;
    content.push('\n');
    fuz_sys::fs::write_atomic(&path, content.as_bytes(), 0o644)?;
    Ok(())
}

/// Remove `daemon.json` if present. Missing-file is not an error.
pub fn remove_daemon_info() -> Result<(), CliError> {
    let path = daemon_info_path()?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// CLI config at `~/.zzz/config.json`. Only the daemon port today.
#[derive(Debug, Deserialize)]
struct CliConfig {
    #[serde(default = "default_port")]
    zzz_config_port: u16,
}

const fn default_port() -> u16 {
    DEFAULT_PORT
}

/// Configured daemon port, or [`DEFAULT_PORT`] when unset/unreadable.
fn config_port() -> u16 {
    config_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|c| serde_json::from_str::<CliConfig>(&c).ok())
        .map_or(DEFAULT_PORT, |c| c.zzz_config_port)
}

/// Resolve the daemon port: `--port` flag > `PORT` env > config > default.
#[must_use]
pub fn resolve_port(flag: Option<u16>) -> u16 {
    if let Some(p) = flag {
        return p;
    }
    if let Ok(s) = std::env::var("PORT")
        && let Ok(p) = s.parse::<u16>()
    {
        return p;
    }
    config_port()
}

/// Locate the `zzz_server` binary to spawn.
///
/// `ZZZ_SERVER_BIN` override > beside the CLI exe > `~/.zzz/bin/` >
/// `./target/debug/` (dev) > bare name on `$PATH`.
#[must_use]
pub fn resolve_server_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("ZZZ_SERVER_BIN") {
        return PathBuf::from(p);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join(DAEMON_BIN));
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(
            PathBuf::from(home)
                .join(".zzz")
                .join("bin")
                .join(DAEMON_BIN),
        );
    }
    candidates.push(PathBuf::from("./target/debug").join(DAEMON_BIN));
    candidates
        .into_iter()
        .find(|c| c.exists())
        .unwrap_or_else(|| PathBuf::from(DAEMON_BIN))
}

/// Whether `pid` names a live process.
///
/// Adapts the wire-shape `u32` pid to the `i32` [`fuz_sys::is_pid_alive`]
/// takes (a `/proc/{pid}` existence probe on Linux). A pid that overflows
/// `i32` can't name a real process, so it reads as not-alive.
#[must_use]
pub fn is_pid_alive(pid: u32) -> bool {
    i32::try_from(pid).is_ok_and(fuz_sys::is_pid_alive)
}

/// Send `SIGTERM` to `pid` via [`fuz_sys::send_signal`].
///
/// A process that's already gone is not an error — `stop` is idempotent;
/// only a failure to *issue* the signal surfaces.
pub fn send_sigterm(pid: u32) -> Result<(), CliError> {
    let raw = i32::try_from(pid).map_err(|_| CliError::Daemon(format!("invalid pid {pid}")))?;
    fuz_sys::send_signal(raw, "-TERM")
        .map(|_| ())
        .map_err(|e| CliError::Daemon(format!("failed to signal pid {pid}: {e}")))
}

/// Probe `http://localhost:{port}/health`; `true` on a 2xx within timeout.
pub async fn check_health(port: u16) -> bool {
    // reqwest uses `rustls-no-provider`; install the `ring` provider first.
    fuz_sys::tls::ensure_crypto_provider();
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(HEALTH_REQUEST_TIMEOUT_MS))
        .build()
    else {
        return false;
    };
    let url = format!("http://localhost:{port}/health");
    matches!(client.get(&url).send().await, Ok(r) if r.status().is_success())
}

/// Resolved liveness of the daemon described by `daemon.json`.
///
/// Collapses the read-record → probe-pid → probe-`/health` sequence into one
/// value so each command branches on a single state instead of re-deriving a
/// `pid_alive` + `healthy` boolean pair (which drifts apart per command). The
/// payload carries the `DaemonInfo` for the cases that have one.
#[derive(Debug)]
pub enum DaemonState {
    /// No `daemon.json` — nothing is recorded as running.
    Stopped,
    /// `daemon.json` records a pid that is no longer alive.
    Stale(DaemonInfo),
    /// Process is alive but not answering `/health` (wedged, or still binding).
    Wedged(DaemonInfo),
    /// Process is alive and answering `/health`.
    Running(DaemonInfo),
}

/// Classify the recorded daemon's liveness. Probes `/health` only when the
/// recorded pid is alive, so a stale record costs no network round-trip.
pub async fn get_daemon_state() -> DaemonState {
    let Some(info) = read_daemon_info() else {
        return DaemonState::Stopped;
    };
    if !is_pid_alive(info.pid) {
        return DaemonState::Stale(info);
    }
    if check_health(info.port).await {
        DaemonState::Running(info)
    } else {
        DaemonState::Wedged(info)
    }
}

/// Parse a `.env` file into key/value pairs. Missing file → empty.
///
/// Minimal `KEY=VALUE` parsing: blank lines and `#` comments skipped,
/// surrounding matching quotes stripped. Sufficient for passing
/// `DATABASE_URL` / `SECRET_FUZ_COOKIE_KEYS` / etc. through to the daemon.
#[must_use]
pub fn load_env_file(path: &Path) -> Vec<(String, String)> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content.lines().filter_map(parse_env_line).collect()
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(value);
    Some((key.to_string(), value.to_string()))
}

/// Build the child env for the daemon: inherited env, then non-overriding
/// values from the active `.env` file, then a `PUBLIC_ZZZ_DIR` default.
///
/// `.env` is chosen when `NODE_ENV=production`, else `.env.development`
/// (matching the Deno CLI). `zzz_server` reads its config straight from env
/// (no dotenv loader of its own), so the CLI supplies it here.
#[must_use]
pub fn build_child_env() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let env_file = if env.get("NODE_ENV").map(String::as_str) == Some("production") {
        ".env"
    } else {
        ".env.development"
    };
    for (key, value) in load_env_file(Path::new(env_file)) {
        env.entry(key).or_insert(value);
    }
    let home = env.get("HOME").cloned().unwrap_or_else(|| ".".to_string());
    env.entry("PUBLIC_ZZZ_DIR".to_string())
        .or_insert_with(|| format!("{home}/.zzz"));
    env
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    #[test]
    fn daemon_info_round_trips_and_matches_wire_shape() {
        let info = DaemonInfo {
            version: 1,
            pid: 4242,
            port: 4460,
            started: "2026-05-30T12:00:00Z".to_string(),
            app_version: "0.0.1".to_string(),
        };
        let json = serde_json::to_value(&info).unwrap();
        // Keys must match fuz_app's `DaemonInfo` contract exactly.
        assert_eq!(json["version"], 1);
        assert_eq!(json["pid"], 4242);
        assert_eq!(json["port"], 4460);
        assert_eq!(json["started"], "2026-05-30T12:00:00Z");
        assert_eq!(json["app_version"], "0.0.1");
        let back: DaemonInfo = serde_json::from_value(json).unwrap();
        assert_eq!(back.pid, info.pid);
        assert_eq!(back.port, info.port);
    }

    #[test]
    fn is_pid_alive_for_self_and_not_for_bogus() {
        let me = std::process::id();
        assert!(is_pid_alive(me));
        // A pid this large should not exist on a normal system.
        assert!(!is_pid_alive(4_000_000_000));
    }

    #[test]
    fn resolve_port_prefers_flag() {
        assert_eq!(resolve_port(Some(9999)), 9999);
    }

    #[test]
    fn parse_env_line_handles_comments_blanks_and_quotes() {
        assert_eq!(parse_env_line("# comment"), None);
        assert_eq!(parse_env_line("   "), None);
        assert_eq!(parse_env_line("=novalue"), None);
        assert_eq!(
            parse_env_line("DATABASE_URL=postgres://localhost/zzz"),
            Some((
                "DATABASE_URL".to_string(),
                "postgres://localhost/zzz".to_string()
            ))
        );
        assert_eq!(
            parse_env_line("KEY = \"quoted value\""),
            Some(("KEY".to_string(), "quoted value".to_string()))
        );
    }

    #[tokio::test]
    async fn check_health_true_for_200_false_for_closed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        // A one-shot mock that answers the first connection with 200 /health.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0_u8; 1024];
                let _ = sock.read(&mut buf).await;
                let body = b"{\"status\":\"ok\"}";
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(body).await;
                let _ = sock.flush().await;
            }
        });
        assert!(
            check_health(port).await,
            "expected healthy against a 200 /health"
        );
        let _ = server.await;

        // Bind then drop to obtain a port with nothing listening.
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_port = probe.local_addr().unwrap().port();
        drop(probe);
        assert!(
            !check_health(closed_port).await,
            "expected unhealthy against a closed port"
        );
    }
}
