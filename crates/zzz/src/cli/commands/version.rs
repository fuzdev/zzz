//! `zzz version` — print version info.

use argh::FromArgs;

use crate::CliError;

/// Show version information.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "version")]
pub struct Version {}

/// Handle `zzz version`.
///
/// Reference: `src/lib/zzz/cli.ts` `show_version` (delegates to
/// `NAME`/`VERSION` from `src/lib/zzz/build_info.ts`).
#[allow(clippy::needless_pass_by_value, clippy::unnecessary_wraps)] // TODO: drop once implemented
pub fn cmd_version(_args: &Version) -> Result<(), CliError> {
    // TODO: print `zzz v{VERSION}` matching `src/lib/zzz/cli.ts:55-57`.
    // The TS side reads `NAME`/`VERSION` from `build_info.ts`; the Rust
    // port should use `env!("CARGO_PKG_VERSION")` (or a build.rs that
    // embeds a git hash, matching fuz's `FUZ_GIT_INFO` pattern).
    println!("TODO: implement zzz version");
    Ok(())
}
