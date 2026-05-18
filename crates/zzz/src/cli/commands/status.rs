//! `zzz status` — show current system state.

use argh::FromArgs;

use crate::CliError;

/// Show current system state (daemon, loaded workspaces, watched repos).
///
/// Mirrors `src/lib/zzz/cli/schemas.ts` `StatusArgs`.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "status")]
pub struct Status {
    // TODO: add flags from `src/lib/zzz/cli/schemas.ts`.
    /// machine-readable JSON output
    #[argh(switch)]
    #[allow(dead_code)] // TODO: wire up
    pub json: bool,
}

/// Handle `zzz status`.
///
/// Reference: `src/lib/zzz/commands/status.ts`.
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // TODO: drop once implemented
pub fn cmd_status(_args: &Status) -> Result<(), CliError> {
    // TODO: implement — read daemon.json, probe `/health`, summarize
    // workspaces + watchers. JSON output when `--json` is set.
    println!("TODO: implement zzz status");
    Ok(())
}
