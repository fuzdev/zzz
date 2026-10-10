//! zzz CLI
//!
//! Command-line client for the zzz daemon: starts/discovers it, opens the
//! UI (with a configured opener, else in the browser), and manages its
//! lifecycle.
//!
//! Runs on a `tokio` runtime: the daemon-lifecycle and status handlers do
//! network I/O (spawn `zzzd`, poll `/health`) and signal handling, so
//! `main` is `#[tokio::main]`. The runtime spins for sync subcommands
//! (`version`/`init`) too, which is cheap enough not to special-case.
//!
//! Arg parsing is argh, with a pre-parse argv rewrite for path-as-command
//! (`zzz ~/dev/` ⇒ `zzz open ~/dev/`).

mod cli;
mod daemon_launch;
mod daemon_lifecycle;
mod env_file;
mod error;
mod opener;
mod procfs;

use argh::FromArgs;
use std::ffi::OsString;
use std::process::ExitCode;

pub use error::CliError;

use crate::cli::commands::{
    daemon::{Daemon, cmd_daemon},
    init::{Init, cmd_init},
    open::{Open, cmd_open},
    status::{Status, cmd_status},
    version::{Version, cmd_version, print_version},
};

/// Known subcommand names. Used by `rewrite_argv_for_path_as_command` to
/// decide whether the first positional should be treated as a path
/// argument to `open` (rewrite) or left alone for argh's subcommand
/// matcher to dispatch.
///
/// Includes argh's own `help` token so `zzz help` is left to argh.
const KNOWN_SUBCOMMANDS: &[&str] = &["open", "init", "daemon", "status", "version", "help"];

/// zzz — local-first forge for power users and devs.
#[derive(FromArgs, Debug)]
struct TopLevel {
    /// print version information and exit
    #[argh(switch, short = 'v')]
    version: bool,

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
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            if let Some(hint) = e.hint() {
                eprintln!("{hint}");
            }
            ExitCode::from(e.exit_code())
        }
    }
}

/// Dispatch the parsed command. Most commands succeed with exit 0; the
/// status commands report the daemon's state through their exit code.
async fn run() -> Result<ExitCode, CliError> {
    let Some(cmd) = parse_argv(argv_utf8(std::env::args_os())?)? else {
        // help printed
        return Ok(ExitCode::SUCCESS);
    };
    // `--version` / `-v` short-circuits before any subcommand dispatch (and
    // before the no-subcommand `open` default).
    if cmd.version {
        print_version();
        return Ok(ExitCode::SUCCESS);
    }
    let success = |()| ExitCode::SUCCESS;
    // No subcommand → default to `open` with no path.
    let Some(sub) = cmd.nested else {
        return cmd_open(&Open { path: None }).await.map(success);
    };
    match sub {
        Subcommand::Open(args) => cmd_open(&args).await.map(success),
        Subcommand::Init(args) => cmd_init(&args).map(success),
        Subcommand::Daemon(args) => cmd_daemon(args).await,
        Subcommand::Status(args) => cmd_status(&args).await,
        Subcommand::Version(args) => cmd_version(&args).map(success),
    }
}

/// The arguments as UTF-8 strings. Read with `args_os` so a non-UTF-8
/// argument is a clear error ([`CliError::NonUtf8Arg`]), never a panic: argh
/// parses `&str`s, and the one path zzz takes becomes a UTF-8 workspace path
/// anyway. The program name is exempt — argh only shows it in help, so it's
/// reduced to its file name (as `argh::from_env` does) and decoded lossily,
/// and running zzz by a non-UTF-8 path still works.
fn argv_utf8(args: impl IntoIterator<Item = OsString>) -> Result<Vec<String>, CliError> {
    let mut args = args.into_iter();
    let program = args.next().map_or_else(
        || "zzz".to_owned(),
        |arg0| {
            let path = std::path::PathBuf::from(arg0);
            path.file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
                .into_owned()
        },
    );
    std::iter::once(Ok(program))
        .chain(args.map(|arg| {
            arg.into_string().map_err(|arg| CliError::NonUtf8Arg {
                arg: arg.to_string_lossy().into_owned(),
            })
        }))
        .collect()
}

/// Parse argv into `TopLevel`, applying the path-as-command rewrite.
///
/// If the first positional isn't a known subcommand (and isn't a flag),
/// inject `open` so argh routes it to the open handler with the original
/// token as a positional argument. This lets `zzz ~/dev/` behave like
/// `zzz open ~/dev/`.
///
/// `Ok(None)` when argh printed help (`--help`, `help`), which exits 0; a
/// parse error is [`CliError::Usage`] (exit 2, like every other usage or
/// config error).
fn parse_argv(argv: Vec<String>) -> Result<Option<TopLevel>, CliError> {
    let rewritten = rewrite_argv_for_path_as_command(map_short_help(argv));
    let arg_strs: Vec<&str> = rewritten.iter().map(String::as_str).collect();
    let (cmd_name, args) = arg_strs.split_at(1);
    match TopLevel::from_args(cmd_name, args) {
        Ok(cmd) => Ok(Some(cmd)),
        // argh signals help via Ok(()), parse errors via Err(())
        Err(early_exit) if early_exit.status.is_ok() => {
            println!("{}", early_exit.output);
            Ok(None)
        }
        Err(early_exit) => Err(CliError::Usage(early_exit.output.trim_end().to_owned())),
    }
}

/// Spell `-h` as `--help`, which is all this argh recognizes, so `zzz -h`
/// and `zzz daemon start -h` print help like `--help` does (and like
/// `zzzd -h`). Every `-h` token counts, up to a `--` separator — zzz has no
/// `-h` option or value of its own.
fn map_short_help(mut argv: Vec<String>) -> Vec<String> {
    for arg in argv.iter_mut().skip(1).take_while(|arg| *arg != "--") {
        if arg == "-h" {
            "--help".clone_into(arg);
        }
    }
    argv
}

/// If `argv[1]` looks like a path rather than a known subcommand, inject
/// `open` at position 1 so argh dispatches via the `Open` handler.
///
/// Leaves `-`-prefixed tokens alone (argh handles `--help` natively —
/// [`map_short_help`] spells `-h` that way first — and the `--version` / `-v`
/// switch on `TopLevel` is matched by argh and short-circuited in `run`) and
/// leaves `help` alone (argh's built-in help keyword).
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
#[allow(
    clippy::unwrap_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("zzz")
            .chain(args.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn a_non_utf8_argument_is_an_error_not_a_panic() {
        use std::os::unix::ffi::OsStringExt as _;
        let ok = [OsString::from("/usr/bin/zzz"), OsString::from("~/dev/")];
        assert_eq!(argv_utf8(ok).unwrap(), argv(&["~/dev/"]));
        let bad = [OsString::from("zzz"), OsString::from_vec(vec![b'a', 0xff])];
        let err = argv_utf8(bad).unwrap_err();
        assert!(matches!(err, CliError::NonUtf8Arg { .. }), "{err}");
        assert_eq!(err.to_string(), "argument is not valid UTF-8: a\u{fffd}");
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn a_non_utf8_program_path_is_fine() {
        use std::os::unix::ffi::OsStringExt as _;
        let mut arg0 = b"/tmp/\xff/".to_vec();
        arg0.extend(b"zzz");
        let args = [OsString::from_vec(arg0), OsString::from("status")];
        assert_eq!(argv_utf8(args).unwrap(), argv(&["status"]));
        let mut arg0 = b"/tmp/".to_vec();
        arg0.extend([b'z', 0xff]);
        assert_eq!(
            argv_utf8([OsString::from_vec(arg0)]).unwrap(),
            ["z\u{fffd}"]
        );
    }

    #[test]
    fn usage_errors_exit_2_and_help_is_not_an_error() {
        let err = parse_argv(argv(&["--bogus"])).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)), "{err}");
        assert_eq!(err.to_string(), "Unrecognized argument: --bogus");
        assert_eq!(err.exit_code(), 2);
        let err = parse_argv(argv(&["daemon", "start", "--port", "0"])).unwrap_err();
        assert!(
            err.to_string().contains("expected a port in 1..=65535"),
            "{err}"
        );
        assert!(parse_argv(argv(&["--help"])).unwrap().is_none());
        // this argh knows only `--help`: `-h` is spelled that way first
        assert!(parse_argv(argv(&["-h"])).unwrap().is_none());
        assert!(
            parse_argv(argv(&["daemon", "start", "-h"]))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            map_short_help(argv(&["open", "-h", "--", "-h"])),
            argv(&["open", "--help", "--", "-h"])
        );
        assert!(parse_argv(argv(&["status"])).unwrap().is_some());
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
