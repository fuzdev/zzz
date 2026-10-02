//! `zzz daemon` — manage the zzz daemon lifecycle.
//!
//! Three subcommands: `start` (foreground), `stop`, `status`. The shared
//! plumbing (launch preparation, serving wait, `daemon.json` I/O, process
//! identity) lives in `crate::daemon_launch` and `crate::daemon_lifecycle`;
//! these handlers orchestrate it.

use std::process::{ExitCode, Stdio};

use argh::FromArgs;

use crate::CliError;
use crate::daemon_launch::{CliConfig, DaemonLaunch};
use crate::daemon_lifecycle::{self as dl, DaemonInfo, DaemonRecord, DaemonState, StartOutcome};

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
    /// daemon port, 1-65535 (overrides `ZZZ_PORT` and config; default 4460)
    #[argh(option, from_str_fn(dl::parse_port))]
    pub port: Option<u16>,
}

/// Stop the running daemon.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "stop")]
pub struct DaemonStop {}

/// Show daemon status (exit 0 running, 1 not responding, 3 not running, 4 unknown).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "status")]
pub struct DaemonStatus {
    /// machine-readable JSON output
    #[argh(switch)]
    pub json: bool,
}

/// Handle `zzz daemon …` subcommands.
pub async fn cmd_daemon(args: Daemon) -> Result<ExitCode, CliError> {
    match args.nested {
        DaemonSub::Start(opts) => cmd_daemon_start(&opts).await,
        DaemonSub::Stop(opts) => cmd_daemon_stop(&opts).await.map(|()| ExitCode::SUCCESS),
        DaemonSub::Status(opts) => crate::cli::commands::status::report_status(opts.json).await,
    }
}

/// Spawn `zzzd`, wait until it serves, record `daemon.json`, then block
/// until it exits — stopping it on SIGINT/SIGTERM/SIGHUP (`SIGTERM`, then
/// `SIGKILL` after [`dl::STOP_TIMEOUT`]) and removing `daemon.json` (if it's
/// still ours) on exit. Exits with the daemon's status: its exit code, or
/// 128 + the signal that ended it.
async fn cmd_daemon_start(args: &DaemonStart) -> Result<ExitCode, CliError> {
    match dl::get_daemon_state().await {
        DaemonState::Running(info) | DaemonState::Wedged(info) => {
            return Err(CliError::AlreadyRunning {
                pid: info.pid,
                port: info.port,
            });
        }
        DaemonState::Stale(info) => {
            eprintln!(
                "warning: stale daemon.json (pid {} is gone), replacing",
                info.pid
            );
        }
        DaemonState::Foreign(record) => {
            return Err(record.refuse("start a daemon"));
        }
        DaemonState::Stopped => {}
    }

    let config = CliConfig::read(&dl::require_zzz_dir()?)?;
    let launch = DaemonLaunch::prepare(args.port, config.as_ref())?;
    let port = launch.port;
    dl::require_free_port(port, true)?;
    let bin = dl::resolve_server_bin()?;

    // Read before the spawn, so an unreadable boot id fails with no child.
    let boot_id = dl::current_boot_id()?;
    // Registered before the spawn so a signal during startup stops the
    // child instead of killing this process and orphaning it.
    let mut signals = dl::ShutdownSignals::register()?;

    let mut command = tokio::process::Command::from(launch.command(&bin));
    // `kill_on_drop`: an early return below never leaves the daemon running
    // without a record (the normal paths reap it first).
    command
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| CliError::Daemon(format!("failed to spawn {}: {e}", bin.display())))?;
    let pid = child
        .id()
        .ok_or_else(|| CliError::Daemon("spawned child has no pid".to_owned()))?;
    // The child stays unreaped until it's waited on, so its pid can't be
    // reused and signalling it below is safe.
    let start_ticks = dl::child_start_ticks(pid)?;

    let raced = tokio::select! {
        outcome = dl::wait_until_serving(pid, port, || child.try_wait()) => Ok(outcome),
        signal = signals.recv() => Err(signal),
    };
    let outcome = match raced {
        Ok(outcome) => outcome?,
        Err(signal) => {
            dl::stop_child(pid, dl::STOP_TIMEOUT, Some(&mut signals), || {
                child.try_wait()
            })
            .await;
            return Err(CliError::Interrupted { signal });
        }
    };
    match outcome {
        StartOutcome::Serving => {}
        StartOutcome::Exited(status) => {
            return Err(CliError::DaemonExited {
                status: status.to_string(),
            });
        }
        StartOutcome::TimedOut => {
            dl::stop_child(pid, dl::STOP_TIMEOUT, Some(&mut signals), || {
                child.try_wait()
            })
            .await;
            return Err(CliError::ServerNotHealthy {
                port,
                ms: dl::HEALTH_TIMEOUT_MS,
            });
        }
    }

    let info = DaemonInfo::new(pid, boot_id, start_ticks, port);
    dl::write_daemon_info(&info)?;
    println!("daemon running on http://localhost:{port}");

    // Foreground lifecycle: run until the child exits on its own, or a
    // signal stops it.
    let exited = tokio::select! {
        status = child.wait() => Some(status),
        _ = signals.recv() => None,
    };
    let status = match exited {
        Some(status) => status.ok(),
        None => {
            dl::stop_child(pid, dl::STOP_TIMEOUT, Some(&mut signals), || {
                child.try_wait()
            })
            .await
        }
    };
    dl::remove_daemon_info_if(&info)?;
    let code = status.map_or(1, dl::exit_code_of);
    if code != 0 {
        eprintln!(
            "zzzd exited ({})",
            status.map_or_else(|| "status unknown".to_owned(), |s| s.to_string())
        );
    }
    Ok(ExitCode::from(code))
}

/// Stop the recorded daemon: SIGTERM, wait for exit, remove `daemon.json`.
/// Signals only a process that still matches the record (boot, pid, start
/// time); a record from another zzz version is reported, never acted on.
async fn cmd_daemon_stop(_args: &DaemonStop) -> Result<(), CliError> {
    let info = match dl::read_daemon_record() {
        DaemonRecord::Absent => {
            println!("no daemon running (no daemon.json)");
            return Ok(());
        }
        DaemonRecord::Foreign(record) => return Err(record.refuse("signal the daemon")),
        DaemonRecord::Current(info) => info,
    };
    if !info.is_alive() {
        dl::remove_daemon_info_if(&info)?;
        println!("removed stale daemon.json (pid {} is gone)", info.pid);
        return Ok(());
    }
    if !dl::terminate(&info).await? {
        return Err(CliError::Daemon(format!(
            "daemon pid {} did not exit within {}s of SIGTERM",
            info.pid,
            dl::STOP_TIMEOUT.as_secs()
        )));
    }
    dl::remove_daemon_info_if(&info)?;
    println!("daemon stopped (pid {})", info.pid);
    Ok(())
}
