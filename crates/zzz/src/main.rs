//! zzz CLI
//!
//! Command-line client for the zzz daemon — Rust counterpart to the
//! Deno-compiled `zzz` binary at `src/lib/zzz/main.ts`.
//!
//! Placeholder scaffold: every handler is a `// TODO:` stub. The Deno
//! binary remains the source of truth — see `src/lib/zzz/CLAUDE.md`.
//!
//! # Future work
//!
//! - **Async runtime**: handlers are sync `fn` today. Real implementations
//!   need network I/O (browser launch via `xdg-open`, RPC to the daemon,
//!   health polling on daemon start). `tokio` is already a workspace dep
//!   used by `zzz_server`. Open question — `#[tokio::main] async fn run`
//!   (mirrors `private_fuz/crates/fuz/src/main.rs:62-63`, simple but
//!   spins the runtime for sync subcommands too) or per-handler
//!   `Runtime::new().block_on(...)` (more code, avoids runtime startup
//!   for `version`/`init`). The fuz precedent is `#[tokio::main]`; I'd
//!   default to that unless the cold-start cost shows up.
//! - **Help examples**: argh supports a top-level `example = "..."`
//!   attribute that renders an `Examples:` section in `--help`. The TS
//!   side has 7 example invocations in `src/lib/zzz/cli/cli_help.ts`
//!   (`ZZZ_HELP_EXAMPLES`). Mirror these on the `TopLevel` derive when
//!   wiring real behavior.

mod cli;
mod error;

use argh::FromArgs;

pub use error::CliError;

use crate::cli::commands::{
    daemon::{self, Daemon},
    init::{self, Init},
    open::{self, Open},
    status::{self, Status},
    version::{self, Version},
};

/// Known subcommand names. Used by `rewrite_argv_for_path_as_command` to
/// decide whether the first positional should be treated as a path
/// argument to `open` (rewrite) or left alone for argh's subcommand
/// matcher to dispatch.
///
/// Includes argh's own `help` token so `zzz help` is left to argh.
const KNOWN_SUBCOMMANDS: &[&str] = &["open", "init", "daemon", "status", "version", "help"];

/// zzz — local-first forge for power users and devs.
///
/// Mirrors the Deno CLI surface at `src/lib/zzz/cli/cli_help.ts`
/// (see `ZZZ_COMMANDS`).
#[derive(FromArgs, Debug)]
struct TopLevel {
    #[argh(subcommand)]
    nested: Option<Subcommand>,
}

#[derive(FromArgs, Debug)]
#[argh(subcommand)]
enum Subcommand {
    Open(Open),
    Init(Init),
    Daemon(Daemon),
    Status(Status),
    Version(Version),
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        if let Some(hint) = e.hint() {
            eprintln!("{hint}");
        }
        std::process::exit(e.exit_code());
    }
}

fn run() -> Result<(), CliError> {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = parse_argv(argv);
    // No subcommand → default to `open` with no path, matching the Deno CLI
    // (`src/lib/zzz/main.ts:77-83`).
    let Some(sub) = cmd.nested else {
        return open::cmd_open(&Open { path: None });
    };
    match sub {
        Subcommand::Open(args) => open::cmd_open(&args),
        Subcommand::Init(args) => init::cmd_init(&args),
        Subcommand::Daemon(args) => daemon::cmd_daemon(args),
        Subcommand::Status(args) => status::cmd_status(&args),
        Subcommand::Version(args) => version::cmd_version(&args),
    }
}

/// Parse argv into `TopLevel`, applying the path-as-command rewrite.
///
/// Mirrors `src/lib/zzz/main.ts:86-94`: if the first positional isn't a
/// known subcommand (and isn't a flag), inject `open` so argh routes it to
/// the open handler with the original token as a positional argument.
/// This lets `zzz ~/dev/` behave like `zzz open ~/dev/`.
fn parse_argv(argv: Vec<String>) -> TopLevel {
    let rewritten = rewrite_argv_for_path_as_command(argv);
    let arg_strs: Vec<&str> = rewritten.iter().map(String::as_str).collect();
    let (cmd_name, args) = arg_strs.split_at(1);
    match TopLevel::from_args(cmd_name, args) {
        Ok(cmd) => cmd,
        Err(early_exit) => {
            // argh signals --help / --version success via Ok(()); parse
            // errors via Err(()). Match argh::from_env's exit behavior.
            let code = if early_exit.status.is_ok() {
                println!("{}", early_exit.output);
                0
            } else {
                eprintln!("{}", early_exit.output);
                1
            };
            std::process::exit(code);
        }
    }
}

/// If argv[1] looks like a path rather than a known subcommand, inject
/// `open` at position 1 so argh dispatches via the `Open` handler.
///
/// Leaves `--flag`-style tokens alone (argh handles `--help` / `-h`
/// natively) and leaves `help` alone (argh's built-in help keyword).
///
/// **`--version` / `-v` is not handled here yet.** argh does NOT handle
/// `--version` natively (verified by direct test — it returns
/// "Unrecognized argument: --version"). The TS CLI exposes
/// `--version`/`-v` as a global flag via `ZzzGlobalArgs`
/// (`src/lib/zzz/cli/cli_args.ts:22-31`). Two ways to add parity:
///   1. Intercept here, before `from_args` — quick and matches the
///      "argv rewrite" theme of this layer.
///   2. Add `#[argh(switch, short = 'v')] version: bool` to `TopLevel` —
///      idiomatic argh, but `--version` then shows in `--help` as a
///      regular switch rather than a special token.
///
/// Option (2) is probably the right call; flagging both because the
/// trade-off is real.
fn rewrite_argv_for_path_as_command(mut argv: Vec<String>) -> Vec<String> {
    let needs_rewrite = argv.get(1).is_some_and(|first| {
        !first.starts_with('-') && !KNOWN_SUBCOMMANDS.contains(&first.as_str())
    });
    if needs_rewrite {
        argv.insert(1, "open".to_string());
    }
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("zzz")
            .chain(args.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn no_rewrite_when_argv_is_bare() {
        assert_eq!(rewrite_argv_for_path_as_command(argv(&[])), argv(&[]));
    }

    #[test]
    fn no_rewrite_when_first_is_known_subcommand() {
        for sub in KNOWN_SUBCOMMANDS {
            let input = argv(&[sub]);
            assert_eq!(rewrite_argv_for_path_as_command(input.clone()), input);
        }
    }

    #[test]
    fn no_rewrite_when_first_starts_with_dash() {
        for flag in ["--help", "-h", "--version", "-v"] {
            let input = argv(&[flag]);
            assert_eq!(rewrite_argv_for_path_as_command(input.clone()), input);
        }
    }

    #[test]
    fn rewrites_path_to_open() {
        assert_eq!(
            rewrite_argv_for_path_as_command(argv(&["~/dev/"])),
            argv(&["open", "~/dev/"]),
        );
        assert_eq!(
            rewrite_argv_for_path_as_command(argv(&["./foo.ts"])),
            argv(&["open", "./foo.ts"]),
        );
    }

    #[test]
    fn rewrites_only_first_positional() {
        // Subsequent positionals are passed through verbatim — the rewrite
        // only injects `open` once at position 1.
        assert_eq!(
            rewrite_argv_for_path_as_command(argv(&["./foo", "bar"])),
            argv(&["open", "./foo", "bar"]),
        );
    }
}
