//! `cargo xtask check-release` — production binaries in the `zzz`
//! workspace (`zzz_server`) must not link `fuz_testing` or `fuz_audit`.
//!
//! Thin wrapper around [`fuz_audit::xtask_main`], which owns the
//! env-args dispatch + usage message + unknown-subcommand error path.
//! See `~/dev/grimoire/lore/fuz_app/TODO_TEST_BINARY_PATTERN.md`
//! §Sanity checks (sanity check #2).

fn main() -> std::process::ExitCode {
    fuz_audit::xtask_main()
}
