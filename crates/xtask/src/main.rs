//! `cargo xtask check-release` — production binaries in the `zzz`
//! workspace (`zzz_server`) must not link `fuz_testing` or `fuz_audit`.
//!
//! Thin wrapper around [`fuz_audit::xtask_main`], which owns the
//! env-args dispatch + usage message + unknown-subcommand error path.
//! This is sanity check #2 of the test-binary pattern.

fn main() -> std::process::ExitCode {
    fuz_audit::xtask_main()
}
