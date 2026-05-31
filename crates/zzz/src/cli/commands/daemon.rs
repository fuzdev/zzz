//! `zzz daemon` — manage the zzz daemon lifecycle.
//!
//! Three subcommands: `start` (foreground), `stop`, `status`. The shared
//! plumbing (binary discovery, health probe, `daemon.json` I/O, PID ops)
//! lives in `crate::daemon_lifecycle`; these handlers orchestrate it.

use std::process::Stdio;
use std::time::{Duration, Instant};

use argh::FromArgs;
use tokio::signal::unix::{SignalKind, signal};

use crate::CliError;
use crate::daemon_lifecycle as dl;

/// Manage the zzz daemon.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "daemon")]
pub struct Daemon {
    #[argh(subcommand)]
    pub nested: DaemonSub,
}

#[derive(FromArgs, Debug)]
#[argh(subcommand)]
pub enum DaemonSub {
    Start(DaemonStart),
    Stop(DaemonStop),
    Status(DaemonStatus),
}

/// Start the zzz daemon (foreground).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "start")]
pub struct DaemonStart {
    /// daemon port (overrides `PORT` env and config; default 4460)
    #[argh(option)]
    pub port: Option<u16>,

    /// bind host (accepted for parity; `zzz_server` binds loopback only, so
    /// this is currently a no-op)
    #[argh(option)]
    #[allow(dead_code)] // parity placeholder — zzz_server has no host flag
    pub host: Option<String>,
}

/// Stop the running daemon.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "stop")]
pub struct DaemonStop {}

/// Show daemon status.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "status")]
pub struct DaemonStatus {
    /// machine-readable JSON output
    #[argh(switch)]
    pub json: bool,
}

/// Handle `zzz daemon …` subcommands.
pub async fn cmd_daemon(args: Daemon) -> Result<(), CliError> {
    match args.nested {
        DaemonSub::Start(opts) => cmd_daemon_start(&opts).await,
        DaemonSub::Stop(opts) => cmd_daemon_stop(&opts).await,
        DaemonSub::Status(opts) => cmd_daemon_status(&opts).await,
    }
}

/// Spawn `zzz_server`, wait for it to report healthy, record `daemon.json`,
/// then block until it exits — forwarding SIGINT/SIGTERM to the child and
/// cleaning up `daemon.json` on exit.
async fn cmd_daemon_start(args: &DaemonStart) -> Result<(), CliError> {
    let port = dl::resolve_port(args.port);
    let child_env = dl::build_child_env();

    // Warn (don't block) on a leftover daemon.json from a prior crash.
    if let Some(stale) = dl::read_daemon_info()
        && !dl::is_pid_alive(stale.pid)
    {
        eprintln!(
            "warning: stale daemon.json (pid {} not running), replacing",
            stale.pid
        );
    }

    let bin = dl::resolve_server_bin();
    let mut child = tokio::process::Command::new(&bin)
        .args(["--port", &port.to_string()])
        .envs(&child_env)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| CliError::Daemon(format!("failed to spawn {}: {e}", bin.display())))?;
    let pid = child
        .id()
        .ok_or_else(|| CliError::Daemon("spawned child has no pid".to_string()))?;

    // Poll /health until the server is up or the timeout elapses.
    let deadline = Instant::now() + Duration::from_millis(dl::HEALTH_TIMEOUT_MS);
    let mut healthy = false;
    while Instant::now() < deadline {
        if dl::check_health(port).await {
            healthy = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(dl::HEALTH_POLL_INTERVAL_MS)).await;
    }
    if !healthy {
        let _ = dl::send_sigterm(pid);
        let _ = child.wait().await;
        return Err(CliError::ServerNotHealthy {
            port,
            ms: dl::HEALTH_TIMEOUT_MS,
        });
    }

    dl::write_daemon_info(&dl::DaemonInfo {
        version: 1,
        pid,
        port,
        started: dl::now_iso8601(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })?;
    println!("daemon running on http://localhost:{port}");

    // Foreground lifecycle: a signal forwards SIGTERM to the child (using
    // the copied pid, so no borrow conflict with the `child.wait()` arm),
    // then the next loop iteration reaps it.
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = child.wait() => break,
            _ = sigint.recv() => { let _ = dl::send_sigterm(pid); }
            _ = sigterm.recv() => { let _ = dl::send_sigterm(pid); }
        }
    }
    let _ = dl::remove_daemon_info();
    Ok(())
}

/// Stop the running daemon: SIGTERM, wait for exit, clean up `daemon.json`.
async fn cmd_daemon_stop(_args: &DaemonStop) -> Result<(), CliError> {
    let Some(info) = dl::read_daemon_info() else {
        println!("no daemon running (no daemon.json)");
        return Ok(());
    };
    if !dl::is_pid_alive(info.pid) {
        dl::remove_daemon_info()?;
        println!("removed stale daemon.json (pid {} not running)", info.pid);
        return Ok(());
    }
    dl::send_sigterm(info.pid)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && dl::is_pid_alive(info.pid) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let still_alive = dl::is_pid_alive(info.pid);
    dl::remove_daemon_info()?;
    if still_alive {
        println!("sent SIGTERM to pid {} (still running after 10s)", info.pid);
    } else {
        println!("daemon stopped (pid {})", info.pid);
    }
    Ok(())
}

/// Show daemon status — shares the report with `zzz status`.
async fn cmd_daemon_status(args: &DaemonStatus) -> Result<(), CliError> {
    crate::cli::commands::status::report_status(args.json).await
}
