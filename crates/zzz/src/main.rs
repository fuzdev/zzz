//! zzz CLI
//!
//! Command-line client for the zzz daemon — Rust counterpart to the
//! Deno-compiled `zzz` binary at `src/lib/zzz/main.ts`.
//!
//! Runs on a `tokio` runtime: the daemon-lifecycle and status handlers do
//! network I/O (spawn `zzz_server`, poll `/health`) and signal handling, so
//! `main` is `#[tokio::main]`. The runtime spins for sync subcommands
//! (`version`/`init`) too, which is cheap enough not to special-case.
//!
//! Arg parsing is argh, with a pre-parse argv rewrite for path-as-command
//! (`zzz ~/dev/` ⇒ `zzz open ~/dev/`).

mod cli;
mod daemon_lifecycle;
mod error;

use argh::FromArgs;

pub use error::CliError;

use crate::cli::commands::{
    daemon::{Daemon, cmd_daemon},
    init::{Init, cmd_init},
    open::{Open, cmd_open},
    status::{Status, cmd_status},
    version::{Version, cmd_version},
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

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e}");
        if let Some(hint) = e.hint() {
            eprintln!("{hint}");
        }
        std::process::exit(e.exit_code());
    }
}

async fn run() -> Result<(), CliError> {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = parse_argv(argv);
    // No subcommand → default to `open` with no path, matching the Deno CLI.
    let Some(sub) = cmd.nested else {
        return cmd_open(&Open { path: None });
    };
    match sub {
        Subcommand::Open(args) => cmd_open(&args),
        Subcommand::Init(args) => cmd_init(&args),
        Subcommand::Daemon(args) => cmd_daemon(args).await,
        Subcommand::Status(args) => cmd_status(&args).await,
        Subcommand::Version(args) => cmd_version(&args),
    }
}

/// Parse argv into `TopLevel`, applying the path-as-command rewrite.
///
/// Mirrors `src/lib/zzz/main.ts`: if the first positional isn't a known
/// subcommand (and isn't a flag), inject `open` so argh routes it to the
/// open handler with the original token as a positional argument. This
/// lets `zzz ~/dev/` behave like `zzz open ~/dev/`.
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
/// `--version` natively. The TS CLI exposes `--version`/`-v` as a global
/// flag; port that as a `#[argh(switch, short = 'v')]` on `TopLevel` when
/// wiring the `version` command's real body (a follow-on to this slice).
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
