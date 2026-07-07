//! `zzz status` — show current system state.

use argh::FromArgs;

use crate::CliError;
use crate::daemon_lifecycle::{self as dl, DaemonInfo, DaemonState};

/// Show current system state (daemon, loaded workspaces, watched repos).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "status")]
pub struct Status {
    /// machine-readable JSON output
    #[argh(switch)]
    pub json: bool,
}

/// Handle `zzz status`.
///
/// Reports daemon status (the same report as `zzz daemon status`). A
/// fuller summary (open workspaces, watcher state) is follow-on work.
pub async fn cmd_status(args: &Status) -> Result<(), CliError> {
    report_status(args.json).await
}

/// Read `daemon.json`, probe PID liveness + `/health`, and print a summary.
/// Cleans up a stale `daemon.json` when the recorded pid is gone.
pub async fn report_status(json: bool) -> Result<(), CliError> {
    let state = dl::get_daemon_state().await;
    if json {
        println!("{}", status_json(&state));
        return Ok(());
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
            println!("  port:    {} (not listening)", info.port);
        }
        DaemonState::Stale(info) => {
            println!(
                "stale daemon.json (pid {} not running) — cleaning up",
                info.pid
            );
            dl::remove_daemon_info()?;
        }
    }
    Ok(())
}

/// The machine-readable status snapshot. `Stopped` is the bare `{running:
/// false}`; the others carry the recorded `DaemonInfo` plus the
/// `running`/`healthy` pair derived from the variant (the wire shape
/// `fuz_app`'s CLI expects).
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
        "port": info.port,
        "started": info.started,
        "app_version": info.app_version,
    })
}
