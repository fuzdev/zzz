//! `zzz version` — print version info.

use argh::FromArgs;

use crate::CliError;

/// Show version information.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "version")]
pub struct Version {}

/// Print `zzz v{VERSION}` to stdout.
///
/// Shared by the `version` subcommand and the top-level `--version`/`-v`
/// switch. `CARGO_PKG_VERSION` is the `crates/zzz` package version.
pub fn print_version() {
    println!("zzz v{}", env!("CARGO_PKG_VERSION"));
}

/// Handle `zzz version`.
#[allow(
    clippy::unnecessary_wraps,
    reason = "uniform Result signature for the argh dispatch in main.rs"
)]
pub fn cmd_version(_args: &Version) -> Result<(), CliError> {
    print_version();
    Ok(())
}
