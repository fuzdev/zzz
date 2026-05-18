//! `zzz daemon` — manage the zzz daemon lifecycle.
//!
//! Three subcommands: `start`, `stop`, `status`.
//!
//! # Implementation notes for the daemon-lifecycle port
//!
//! `fuz_common` exposes daemon-lifecycle primitives that look reusable:
//! `DaemonInfo` / `MaybeDaemonInfo` (structs), `read_daemon_info` /
//! `write_daemon_info` / `remove_daemon_file` / `current_daemon_info`
//! (I/O), `is_pid_alive` / `verify_pid_is_fuzd` / `send_signal` (PID
//! ops), `get_daemon_log_path` / `rotate_logs` (logs). The fuz CLI uses
//! all of these — see `private_fuz/crates/fuz/src/daemon.rs:1-12`.
//!
//! **However**: the I/O helpers are hardcoded to `~/.fuz/`. They go
//! through `daemon_file_path()` → `ensure_fuz_home()` with no app-name
//! parameter. The TS counterpart (`@fuzdev/fuz_app/cli/daemon.js`) DOES
//! take a `name` — see `read_daemon_info(runtime, 'zzz')` at
//! `src/lib/zzz/commands/open.ts:36`. Three possible paths:
//!   1. Push parameterization upstream into `fuz_common::daemon` (so
//!      `read_daemon_info(app: &str)` keys off the right home dir).
//!      Cleanest long-term, but cross-repo and out of scope for this
//!      scaffold.
//!   2. Reuse `DaemonInfo` (the on-disk JSON shape — pure data) and
//!      write a thin zzz-side I/O wrapper that hits `~/.zzz/run/`.
//!      Quickest path, mirrors the TS shape, accepts the duplication.
//!   3. Fork the whole module. Probably wrong — `DaemonInfo` is the
//!      cross-stack contract and duplicating it invites drift.
//!
//! Best guess is (2) until (1) gets prioritized; flagging the
//! uncertainty so the implementer doesn't pick blindly.
//!
//! **Sibling-binary discovery**: `daemon_start` needs to locate the
//! `zzz_server` binary (the cargo workspace member in `crates/zzz_server`).
//! fuz handles this in `find_fuzd_binary`
//! (`private_fuz/crates/fuz/src/daemon.rs:147-156`) — checks the same
//! dir as the current exe first, falls back to `PATH`. Port that pattern.

use argh::FromArgs;

use crate::CliError;

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
///
/// Mirrors `src/lib/zzz/cli/schemas.ts` `DaemonStartArgs`.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "start")]
pub struct DaemonStart {
    // TODO: add flags from `src/lib/zzz/cli/schemas.ts` (`DaemonStartArgs`
    // currently carries `--port` and `--host`, both overriding config).
    /// daemon port (cross-stack flag — must align with `zzz_server --port`;
    /// TODO: wire up)
    // TODO: per workspace convention (rust_conventions.md §CLI Patterns,
    // "naming parity across stack"), add `short = 'p'` when wiring up if
    // either side (TS, Rust daemon) adopts the alias. Neither does today.
    #[argh(option)]
    #[allow(dead_code)] // TODO: wire up
    pub port: Option<u16>,

    /// bind host (TODO: wire up)
    #[argh(option)]
    #[allow(dead_code)] // TODO: wire up
    pub host: Option<String>,
}

/// Stop the running daemon.
///
/// Mirrors `src/lib/zzz/cli/schemas.ts` `DaemonStopArgs`.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "stop")]
pub struct DaemonStop {
    // TODO: add flags from `src/lib/zzz/cli/schemas.ts` (`DaemonStopArgs`
    // takes no flags today — keep parity if it grows).
}

/// Show daemon status.
///
/// Mirrors `src/lib/zzz/cli/schemas.ts` `DaemonStatusArgs`.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "status")]
pub struct DaemonStatus {
    // TODO: add flags from `src/lib/zzz/cli/schemas.ts`.
    /// machine-readable JSON output
    #[argh(switch)]
    #[allow(dead_code)] // TODO: wire up
    pub json: bool,
}

/// Handle `zzz daemon …` subcommands.
///
/// Reference: `src/lib/zzz/commands/daemon.ts` (the Deno port dispatches
/// via `create_subcommand_router` in `src/lib/zzz/main.ts:34-57`).
pub fn cmd_daemon(args: Daemon) -> Result<(), CliError> {
    match args.nested {
        DaemonSub::Start(opts) => cmd_daemon_start(&opts),
        DaemonSub::Stop(opts) => cmd_daemon_stop(&opts),
        DaemonSub::Status(opts) => cmd_daemon_status(&opts),
    }
}

/// Reference: `src/lib/zzz/commands/daemon.ts` `daemon_start`.
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // TODO: drop once implemented
fn cmd_daemon_start(_args: &DaemonStart) -> Result<(), CliError> {
    // TODO: implement — spawn `zzz_server` (sibling binary in this
    // workspace), poll health, write `~/.zzz/run/daemon.json`.
    println!("TODO: implement zzz daemon start");
    Ok(())
}

/// Reference: `src/lib/zzz/commands/daemon.ts` `daemon_stop`.
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // TODO: drop once implemented
fn cmd_daemon_stop(_args: &DaemonStop) -> Result<(), CliError> {
    // TODO: implement — read daemon.json, send shutdown signal, clean up
    // stale state file. See fuz's `daemon_stop` in
    // `private_fuz/crates/fuz/src/daemon.rs` for the polling shape.
    println!("TODO: implement zzz daemon stop");
    Ok(())
}

/// Reference: `src/lib/zzz/commands/daemon.ts` `daemon_status`.
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // TODO: drop once implemented
fn cmd_daemon_status(_args: &DaemonStatus) -> Result<(), CliError> {
    // TODO: implement — read daemon.json, probe `/health`, optionally
    // serialize as JSON when `--json` is set.
    println!("TODO: implement zzz daemon status");
    Ok(())
}
