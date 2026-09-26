//! `zzz status` — show current system state.

use std::process::ExitCode;

use argh::FromArgs;

use crate::CliError;
use crate::daemon_lifecycle::{self as dl, DaemonInfo, DaemonState};

/// Show current system state (exit 0 running, 1 not responding, 3 not running).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "status")]
pub struct Status {
    /// machine-readable JSON output
    #[argh(switch)]
    pub json: bool,
}

/// Exit code when the recorded daemon is alive but not answering `/health`.
const EXIT_NOT_RESPONDING: u8 = 1;

/// Exit code when no daemon is running (the LSB `status` convention).
const EXIT_NOT_RUNNING: u8 = 3;

/// Handle `zzz status`.
///
/// Reports daemon status (the same report as `zzz daemon status`). A
/// fuller summary (open workspaces, watcher state) is follow-on work.
pub async fn cmd_status(args: &Status) -> Result<ExitCode, CliError> {
    report_status(args.json).await
}

/// Classify the recorded daemon, print a summary, and return the exit code:
/// 0 running, 1 alive but not responding, 3 not running. Removes a stale
/// `daemon.json` (only if it still records the stale process), in both the
/// text and JSON forms.
pub async fn report_status(json: bool) -> Result<ExitCode, CliError> {
    let state = dl::get_daemon_state().await;
    let code = match &state {
        DaemonState::Running(_) => ExitCode::SUCCESS,
        DaemonState::Wedged(_) => ExitCode::from(EXIT_NOT_RESPONDING),
        DaemonState::Stopped | DaemonState::Stale(_) => ExitCode::from(EXIT_NOT_RUNNING),
    };
    if let DaemonState::Stale(info) = &state {
        dl::remove_daemon_info_if(info)?;
    }
    if json {
        println!("{}", status_json(&state));
        return Ok(code);
    }
    match state {
        DaemonState::Stopped => println!("no daemon running"),
        DaemonState::Running(info) => {
            println!("daemon running");
            println!("  pid:     {}", info.pid);
            println!("  port:    {}", info.port);
            println!("  version: {}", info.app_version);
            println!("  started: {}", info.started);
            println!("  url:     http://localhost:{}", info.port);
        }
        DaemonState::Wedged(info) => {
            println!(
                "daemon process alive but not responding on port {}",
                info.port
            );
            println!("  pid:     {}", info.pid);
            println!("  port:    {} (not answering /health)", info.port);
        }
        DaemonState::Stale(info) => {
            println!(
                "no daemon running (removed stale daemon.json: pid {} is gone)",
                info.pid
            );
        }
    }
    Ok(code)
}

/// The machine-readable status snapshot. `Stopped` is the bare `{running:
/// false}`; the others carry the recorded `DaemonInfo` plus the
/// `running`/`healthy` pair derived from the variant.
fn status_json(state: &DaemonState) -> serde_json::Value {
    match state {
        DaemonState::Stopped => serde_json::json!({ "running": false }),
        DaemonState::Running(info) => status_json_info(info, true, true),
        DaemonState::Wedged(info) => status_json_info(info, true, false),
        DaemonState::Stale(info) => status_json_info(info, false, false),
    }
}

fn status_json_info(info: &DaemonInfo, running: bool, healthy: bool) -> serde_json::Value {
    serde_json::json!({
        "running": running,
        "healthy": healthy,
        "version": info.version,
        "pid": info.pid,
        "boot_id": info.boot_id,
        "pid_start_ticks": info.pid_start_ticks,
        "port": info.port,
        "started": info.started,
        "app_version": info.app_version,
    })
}
