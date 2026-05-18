//! `zzz open` — default command.
//!
//! Opens the zzz browser UI, auto-starting the daemon if needed.
//! Handles `zzz`, `zzz <file>`, `zzz <dir>`.
//!
//! # Implementation outline
//!
//! When given a directory, the TS reference at
//! `src/lib/zzz/commands/open.ts` does **not** read the filesystem
//! directly — it makes a JSON-RPC `workspace_open` call to the daemon
//! over HTTP. That handler is one of the 30 action specs in
//! `src/lib/action_specs.ts` (mirrored on the Rust backend at
//! `crates/zzz_server/src/handlers/workspace.rs`). So `cmd_open` needs:
//!   1. Daemon discovery — read `~/.zzz/run/daemon.json` (see
//!      `commands/daemon.rs` for the helper-reuse story).
//!   2. Auto-start if not running (`daemon_start` path).
//!   3. RPC call to `POST {url}/api/rpc` with `{method: "workspace_open",
//!      params: {path}}` for directories — unclear whether file paths
//!      get a different action or just open the URL with a fragment.
//!      Check `open.ts` for the dispatch shape when implementing.
//!   4. Browser launch (`xdg-open` / `open` / `start` per OS).

use argh::FromArgs;

use crate::CliError;

/// Open file or directory in browser (default command).
///
/// Mirrors `src/lib/zzz/cli/schemas.ts` `OpenArgs` (the TS schema accepts
/// at most one positional path).
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "open")]
pub struct Open {
    // TODO: add flags from `src/lib/zzz/cli/schemas.ts` (OpenArgs currently
    // only carries the positional path — keep parity if it grows).
    /// path to open (file or directory)
    #[argh(positional)]
    #[allow(dead_code)] // TODO: wire up
    pub path: Option<String>,
}

/// Handle `zzz open` (and the implicit no-subcommand default).
///
/// Reference: `src/lib/zzz/commands/open.ts`.
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // TODO: drop once implemented
pub fn cmd_open(_args: &Open) -> Result<(), CliError> {
    // TODO: implement — see `src/lib/zzz/commands/open.ts` for the Deno
    // reference (auto-start daemon via daemon.json lifecycle helpers,
    // resolve workspace_open over RPC if path is a directory, open browser).
    println!("TODO: implement zzz open");
    Ok(())
}
