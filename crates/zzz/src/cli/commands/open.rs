//! `zzz open` — default command.
//!
//! Opens the zzz browser UI, auto-starting the daemon if needed.
//! Handles `zzz`, `zzz <file>`, `zzz <dir>`.
//!
//! The flow:
//!   1. Require init — `~/.zzz` must exist (`zzz init`).
//!   2. Daemon discovery — read `~/.zzz/run/daemon.json`, verify the pid is
//!      alive and `/health` responds; clean up a stale record otherwise.
//!   3. Auto-start if not running — spawn `zzzd` **detached** (new process
//!      group, log-file stdio), poll `/health`, record `daemon.json`. This
//!      differs from `daemon start`, which runs the server in the foreground
//!      and forwards signals to it.
//!   4. For a directory arg, a best-effort `workspace_open` JSON-RPC call.
//!      `workspace_open` requires an authenticated account, which the CLI
//!      can't supply (the daemon token is a different credential axis), so
//!      this call warn-fails under auth — the authenticated browser does the
//!      real open via the `?workspace=` query param below.
//!   5. Browser launch (`xdg-open` / `open` / `start`), with the
//!      `?workspace=<path>` param when a path was given.

use std::process::Stdio;
use std::time::{Duration, Instant};

use argh::FromArgs;

use crate::CliError;
use crate::daemon_lifecycle::{self as dl, DaemonInfo};

/// Open file or directory in browser (default command).
///
/// Accepts at most one positional path.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "open")]
pub struct Open {
    /// path to open (file or directory)
    #[argh(positional)]
    pub path: Option<String>,
}

/// Handle `zzz open` (and the implicit no-subcommand default).
pub async fn cmd_open(args: &Open) -> Result<(), CliError> {
    let zzz_dir = dl::zzz_dir()?;
    if !zzz_dir.exists() {
        return Err(CliError::NotInitialized);
    }

    let info = match discover_running_daemon().await {
        Some(info) => info,
        None => start_daemon_detached().await?,
    };
    let port = info.port;

    let target = resolve_path(args.path.as_deref());

    if let Some(target) = target.as_deref() {
        let workspace_path = if target.ends_with('/') {
            target.to_string()
        } else {
            format!("{target}/")
        };
        open_workspace_best_effort(port, &workspace_path).await;
    }

    let mut url = format!("http://localhost:{port}");
    if let Some(target) = target.as_deref() {
        url.push_str("/workspaces?workspace=");
        url.push_str(&encode_uri_component(target));
    }

    println!("opening {url}");
    open_browser(&url).await;
    Ok(())
}

/// Read `daemon.json` and return it only when the daemon is actually
/// running and answering `/health`. A stale or unresponsive record is
/// cleaned up so the caller can auto-start a fresh daemon.
async fn discover_running_daemon() -> Option<DaemonInfo> {
    let info = dl::read_daemon_info()?;
    if !dl::is_pid_alive(info.pid) {
        let _ = dl::remove_daemon_info();
        return None;
    }
    if dl::check_health(info.port).await {
        return Some(info);
    }
    // Alive but not answering `/health` — treat it as wedged and terminate it
    // (mirroring `daemon stop`) so the auto-start below can rebind the port,
    // then drop the stale record. Without this, the restart would collide with
    // the old process still holding the port.
    eprintln!(
        "warning: daemon pid {} on port {} is not responding; restarting",
        info.pid, info.port
    );
    let _ = dl::send_sigterm(info.pid);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && dl::is_pid_alive(info.pid) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = dl::remove_daemon_info();
    None
}

/// Spawn `zzzd` detached and wait for it to report healthy, then record
/// `daemon.json`.
///
/// Detached = a new process group (`process_group(0)`, so the daemon ignores
/// the launching terminal's Ctrl-C) with its stdio captured to
/// `~/.zzz/run/daemon.log`, and the child is never awaited (a dropped
/// `std::process::Child` is not killed) — so the daemon outlives this CLI
/// invocation. It is process-group-detached, not session-detached: a true
/// `setsid` needs `unsafe`, which the workspace forbids, so the daemon relies
/// on orphaning-to-init plus the separate process group to survive. Contrast
/// `daemon start`, which keeps the server in the foreground with inherited
/// stdio.
///
/// The poll loop also watches for an early child exit (e.g. a bind failure
/// when a wedged old daemon still holds the port) so a failed start surfaces
/// in seconds — pointing at the log — instead of blocking the full health
/// timeout, and the captured log makes the cause diagnosable after exit.
async fn start_daemon_detached() -> Result<DaemonInfo, CliError> {
    use std::os::unix::process::CommandExt as _;

    let port = dl::resolve_port(None);
    let child_env = dl::build_child_env();
    let bin = dl::resolve_server_bin();

    // Capture the detached daemon's stdout/stderr to a log file — it has no
    // terminal once this CLI exits, so this is what makes a boot failure
    // diagnosable. Truncated on each fresh start.
    let run_dir = dl::zzz_dir()?.join("run");
    std::fs::create_dir_all(&run_dir)?;
    let log_path = run_dir.join("daemon.log");
    let log = std::fs::File::create(&log_path)?;
    let log_err = log.try_clone()?;

    println!("starting daemon on port {port}...");

    let mut child = std::process::Command::new(&bin)
        .args(["--port", &port.to_string()])
        .envs(&child_env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .process_group(0)
        .spawn()
        .map_err(|e| CliError::Daemon(format!("failed to spawn {}: {e}", bin.display())))?;
    let pid = child.id();

    let startup_failed = || CliError::DaemonStartupFailed {
        port,
        log_path: log_path.display().to_string(),
    };

    let deadline = Instant::now() + Duration::from_millis(dl::HEALTH_TIMEOUT_MS);
    let mut healthy = false;
    while Instant::now() < deadline {
        if dl::check_health(port).await {
            healthy = true;
            break;
        }
        // Bail out the moment the daemon exits (e.g. a bind failure) rather
        // than waiting out the whole health timeout.
        if child.try_wait()?.is_some() {
            return Err(startup_failed());
        }
        tokio::time::sleep(Duration::from_millis(dl::HEALTH_POLL_INTERVAL_MS)).await;
    }
    if !healthy {
        let _ = dl::send_sigterm(pid);
        return Err(startup_failed());
    }

    // Healthy — release the child handle (std does not kill on drop) so the
    // daemon keeps running after this CLI process exits.
    drop(child);

    let info = DaemonInfo {
        version: 1,
        pid,
        port,
        started: dl::now_iso8601(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    dl::write_daemon_info(&info)?;
    println!(
        "daemon running on http://localhost:{port} (logs: {})",
        log_path.display()
    );
    Ok(info)
}

/// Best-effort `workspace_open` JSON-RPC call. Failures (including the
/// `-32001 unauthenticated` the auth-gated handler returns to the
/// credential-less CLI) only warn — the browser opens the workspace via the
/// `?workspace=` query param.
async fn open_workspace_best_effort(port: u16, workspace_path: &str) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(dl::HEALTH_REQUEST_TIMEOUT_MS))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            eprintln!("warning: could not build http client: {e}");
            return;
        }
    };
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "workspace_open",
        "params": { "path": workspace_path },
    });
    let url = format!("http://localhost:{port}/api/rpc");
    match client.post(&url).json(&body).send().await {
        Ok(resp) if !resp.status().is_success() => {
            eprintln!("warning: workspace_open request failed: {}", resp.status());
        }
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(value) => {
                if let Some(error) = value.get("error") {
                    let message = error
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown error");
                    eprintln!("warning: workspace_open error: {message}");
                } else {
                    println!("workspace opened: {workspace_path}");
                }
            }
            Err(e) => eprintln!("warning: could not parse workspace_open response: {e}"),
        },
        Err(e) => eprintln!("warning: failed to contact daemon: {e}"),
    }
}

/// Resolve the target path to an absolute path. Absolute (`/…`) and
/// home-relative (`~/…`) paths pass through unchanged — the daemon expands
/// `~` — and everything else is joined onto the current directory.
fn resolve_path(path: Option<&str>) -> Option<String> {
    let path = path?;
    if path.starts_with('/') || path.starts_with('~') {
        return Some(path.to_string());
    }
    Some(std::env::current_dir().map_or_else(
        |_| path.to_string(),
        |cwd| format!("{}/{path}", cwd.display()),
    ))
}

/// Percent-encode a string the way JavaScript's `encodeURIComponent` does:
/// every byte except the unreserved set `A-Za-z0-9-_.!~*'()` is escaped.
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => {
                use std::fmt::Write as _;
                // Writing to a String is infallible.
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// Open `url` in the user's browser, trying the platform openers in turn and
/// falling back to printing the URL.
async fn open_browser(url: &str) {
    for opener in ["xdg-open", "open", "start"] {
        let status = tokio::process::Command::new(opener)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if matches!(status, Ok(s) if s.success()) {
            return;
        }
    }
    println!("open in browser: {url}");
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
    fn resolve_path_passes_through_absolute_and_home() {
        assert_eq!(
            resolve_path(Some("/abs/path")).as_deref(),
            Some("/abs/path")
        );
        assert_eq!(resolve_path(Some("~/dev")).as_deref(), Some("~/dev"));
    }

    #[test]
    fn resolve_path_none_is_none() {
        assert_eq!(resolve_path(None), None);
    }

    #[test]
    fn resolve_path_relative_is_joined_onto_cwd() {
        let cwd = std::env::current_dir().unwrap();
        let resolved = resolve_path(Some("foo")).unwrap();
        assert_eq!(resolved, format!("{}/foo", cwd.display()));
    }

    #[test]
    fn encode_uri_component_matches_js_semantics() {
        // Unreserved set passes through untouched.
        assert_eq!(encode_uri_component("aZ09-_.!~*'()"), "aZ09-_.!~*'()");
        // Path separators, spaces, and other bytes are percent-escaped.
        assert_eq!(encode_uri_component("/home/a b"), "%2Fhome%2Fa%20b");
        assert_eq!(encode_uri_component("~/dev/"), "~%2Fdev%2F");
    }
}
