//! `zzz init` — initialize `~/.zzz/`.
//!
//! State directory layout (from `zzz/CLAUDE.md` §"Zzz App Directory"):
//! ```text
//! ~/.zzz/
//!   config.json     — daemon config (port)
//!   state/db/       — PGlite data (planned)
//!   state/          — persistent data (completions, workspaces.json)
//!   cache/          — regenerable data, safe to delete
//!   run/daemon.json — PID, port, version (ephemeral)
//! ```
//! The TS reference at `src/lib/zzz/commands/init.ts` creates the
//! directory and a default `config.json`; the config schema is at
//! `src/lib/zzz/cli_config.ts`. Path is configurable via
//! `PUBLIC_ZZZ_DIR` env (default `~/.zzz/`).

use argh::FromArgs;

use crate::CliError;

/// Initialize zzz configuration (`~/.zzz/`).
///
/// Mirrors `src/lib/zzz/cli/schemas.ts` `InitArgs`.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "init")]
pub struct Init {
    // TODO: add flags from `src/lib/zzz/cli/schemas.ts` (`InitArgs` carries
    // an optional `--port` for the daemon's default port).
    /// daemon port (cross-stack flag — must align with `zzz daemon start --port`
    /// and `zzz_server --port`; TODO: wire up)
    // TODO: per workspace convention (rust_conventions.md §CLI Patterns,
    // "naming parity across stack"), add `short = 'p'` when wiring up if
    // either side (TS, Rust daemon) adopts the alias. Neither does today.
    #[argh(option)]
    #[allow(dead_code)] // TODO: wire up
    pub port: Option<u16>,
}

/// Handle `zzz init`.
///
/// Reference: `src/lib/zzz/commands/init.ts`.
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // TODO: drop once implemented
pub fn cmd_init(_args: &Init) -> Result<(), CliError> {
    // TODO: implement — see `src/lib/zzz/commands/init.ts` for the Deno
    // reference (create config dir + config.json with default port).
    println!("TODO: implement zzz init");
    Ok(())
}
