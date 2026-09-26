//! `zzz status` — show current system state.

use std::process::ExitCode;

use argh::FromArgs;

use crate::CliError;
use crate::daemon_lifecycle::{self as dl, DaemonState};

/// Show current system state (exit 0 running, 1 not responding, 3 not running, 4 unknown).
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

/// Exit code when `daemon.json` can't be read as this zzz's record, so
/// whether a daemon runs is unknown (the LSB `status` convention).
const EXIT_UNKNOWN: u8 = 4;

/// Handle `zzz status`.
///
/// Reports daemon status (the same report as `zzz daemon status`). A
/// fuller summary (open workspaces, watcher state) is follow-on work.
pub async fn cmd_status(args: &Status) -> Result<ExitCode, CliError> {
    report_status(args.json).await
}

/// Classify the recorded daemon, print a summary, and return the exit code:
/// 0 running, 1 alive but not responding, 3 not running, 4 unknown (a
/// `daemon.json` this zzz can't read, left untouched). Removes a stale
/// `daemon.json` (only if it still records the stale process), in both the
/// text and JSON forms.
pub async fn report_status(json: bool) -> Result<ExitCode, CliError> {
    let state = dl::get_daemon_state().await;
    let code = match &state {
        DaemonState::Running(_) => ExitCode::SUCCESS,
        DaemonState::Wedged(_) => ExitCode::from(EXIT_NOT_RESPONDING),
        DaemonState::Stopped | DaemonState::Stale(_) => ExitCode::from(EXIT_NOT_RUNNING),
        DaemonState::Foreign(_) => ExitCode::from(EXIT_UNKNOWN),
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
        DaemonState::Foreign(record) => {
            println!("daemon status unknown: {}", record.describe());
        }
    }
    Ok(code)
}

/// The machine-readable status snapshot — every key always present:
///
/// - `state` — `running`, `not_responding`, `not_running`, `stale` (the
///   record named a process that's gone; the record was removed), or
///   `unknown` (a `daemon.json` this zzz can't read), matching the exit code
///   (0, 1, 3, 3, 4)
/// - `running` — the recorded process is alive (`running`,
///   `not_responding`)
/// - `healthy` — it answers `/health` (`running` only)
/// - `daemon` — the `daemon.json` record (`running`, `not_responding`,
///   `stale`), else `null`
/// - `foreign_record` — `{pid, kind, description}` for `unknown` (`pid`
///   `null` when it names none; `kind` `older`, `newer`, or `unreadable`),
///   else `null`
fn status_json(state: &DaemonState) -> serde_json::Value {
    let (name, info, foreign) = match state {
        DaemonState::Stopped => ("not_running", None, None),
        DaemonState::Running(info) => ("running", Some(info), None),
        DaemonState::Wedged(info) => ("not_responding", Some(info), None),
        DaemonState::Stale(info) => ("stale", Some(info), None),
        DaemonState::Foreign(record) => ("unknown", None, Some(record)),
    };
    serde_json::json!({
        "state": name,
        "running": matches!(state, DaemonState::Running(_) | DaemonState::Wedged(_)),
        "healthy": matches!(state, DaemonState::Running(_)),
        "daemon": info,
        "foreign_record": foreign.map(|record| serde_json::json!({
            "pid": record.pid,
            "kind": record.kind.name(),
            "description": record.describe(),
        })),
    })
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;
    use crate::daemon_lifecycle::{DaemonInfo, ForeignKind, ForeignRecord};

    fn info() -> DaemonInfo {
        DaemonInfo {
            version: dl::DAEMON_INFO_VERSION,
            pid: 42,
            boot_id: "boot".to_owned(),
            pid_start_ticks: 7,
            port: 4460,
            started: "2026-05-30T12:00:00Z".to_owned(),
            app_version: "0.0.1".to_owned(),
        }
    }

    #[test]
    fn status_json_has_one_shape_for_every_state() {
        let record = serde_json::to_value(info()).unwrap();
        let foreign = ForeignRecord {
            pid: Some(77),
            kind: ForeignKind::Older,
        };
        let cases = [
            (DaemonState::Running(info()), "running", true, true),
            (DaemonState::Wedged(info()), "not_responding", true, false),
            (DaemonState::Stale(info()), "stale", false, false),
            (DaemonState::Stopped, "not_running", false, false),
            (DaemonState::Foreign(foreign), "unknown", false, false),
        ];
        for (state, name, running, healthy) in cases {
            let json = status_json(&state);
            let mut keys: Vec<&str> = json
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                ["daemon", "foreign_record", "healthy", "running", "state"],
                "{name}"
            );
            assert_eq!(json["state"], name);
            assert_eq!(json["running"], running, "{name}");
            assert_eq!(json["healthy"], healthy, "{name}");
            let has_record = matches!(name, "running" | "not_responding" | "stale");
            assert_eq!(
                json["daemon"],
                if has_record {
                    record.clone()
                } else {
                    serde_json::Value::Null
                }
            );
            if name == "unknown" {
                assert_eq!(
                    json["foreign_record"],
                    serde_json::json!({
                        "pid": 77,
                        "kind": "older",
                        "description": "daemon.json from an older zzz (pid 77) — stop it manually",
                    })
                );
            } else {
                assert!(json["foreign_record"].is_null(), "{name}");
            }
        }
    }
}
