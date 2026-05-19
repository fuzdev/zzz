//! `cargo xtask check-release` — production binaries in the `zzz`
//! workspace (`zzz_server`) must not link `fuz_testing` or `fuz_audit`.
//!
//! Thin wrapper around [`fuz_audit::run_check_release_cli`]; the audit
//! logic lives in the `fuz_audit` crate so every consumer-workspace
//! xtask can adopt the same check via a single function call. See
//! `~/dev/grimoire/lore/fuz_app/TODO_TEST_BINARY_PATTERN.md` §Sanity
//! checks (sanity check #2).
//!
//! # Usage
//!
//! ```sh
//! cargo xtask check-release        # Audit: no production binary depends on fuz_testing
//! ```

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("check-release") => fuz_audit::run_check_release_cli(),
        Some(other) => {
            eprintln!("error: unknown xtask subcommand `{other}`");
            eprintln!("usage: cargo xtask check-release");
            ExitCode::FAILURE
        }
        None => {
            eprintln!("usage: cargo xtask check-release");
            ExitCode::FAILURE
        }
    }
}
