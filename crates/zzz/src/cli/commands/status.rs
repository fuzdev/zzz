//! `zzz status` — show current system state.

use argh::FromArgs;

use crate::CliError;
use crate::daemon_lifecycle as dl;

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
/// Reports daemon status (the same report as `zzz daemon status`). The
/// fuller workspace/watcher summary the Deno `status.ts` sketches is
/// follow-on work once those land in the Rust CLI.
pub async fn cmd_status(args: &Status) -> Result<(), CliError> {
    report_status(args.json).await
}

/// Read `daemon.json`, probe PID liveness + `/health`, and print a summary.
/// Cleans up a stale `daemon.json` when the recorded pid is gone.
pub async fn report_status(json: bool) -> Result<(), CliError> {
    let Some(info) = dl::read_daemon_info() else {
        if json {
            println!("{}", serde_json::json!({ "running": false }));
        } else {
            println!("no daemon running");
        }
        return Ok(());
    };
    let pid_alive = dl::is_pid_alive(info.pid);
    let healthy = if pid_alive {
        dl::check_health(info.port).await
    } else {
        false
    };

    if json {
        let out = serde_json::json!({
            "running": pid_alive,
            "healthy": healthy,
            "version": info.version,
            "pid": info.pid,
            "port": info.port,
            "started": info.started,
            "app_version": info.app_version,
        });
        println!("{out}");
    } else if pid_alive && healthy {
        println!("daemon running");
        println!("  pid:     {}", info.pid);
        println!("  port:    {}", info.port);
        println!("  version: {}", info.app_version);
        println!("  started: {}", info.started);
        println!("  url:     http://localhost:{}", info.port);
    } else if pid_alive {
        println!(
            "daemon process alive but not responding on port {}",
            info.port
        );
        println!("  pid:     {}", info.pid);
        println!("  port:    {} (not listening)", info.port);
    } else {
        println!(
            "stale daemon.json (pid {} not running) — cleaning up",
            info.pid
        );
        dl::remove_daemon_info()?;
    }
    Ok(())
}
