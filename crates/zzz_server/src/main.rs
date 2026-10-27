//! `zzz_server` production binary (`zzzd`).
//!
//! Thin entry point — parses the command line (`--port`, `--static-dir`; the
//! `zzz` CLI launches the daemon with both), wires [`fuz_auth::Argon2idHasher`]
//! (production argon2 params, ~30-50 ms per hash), and hands off to
//! [`zzz_server::run_app`], which owns the full server lifecycle.
//!
//! `--help` prints usage and exits `0`; a bad argument exits `2` with usage on
//! stderr before anything runs. A failed start prints its error chain and a
//! hint, and exits `2` when the operator must fix configuration, `1`
//! otherwise.
//!
//! The `testing_zzz_server` binary in `crates/testing_zzz_server/`
//! ships the same lifecycle with `fuz_testing::TestingArgon2idHasher`
//! swapped in for ~1-5 ms argon2 during cross-process integration
//! tests.

use std::process::ExitCode;
use std::sync::Arc;

use fuz_actions::server::SpineRunOptions;
use fuz_auth::PasswordHasher;

#[tokio::main]
async fn main() -> ExitCode {
    let args = match zzz_server::parse_process_args("zzzd") {
        Ok(args) => args,
        Err(exit) => return exit,
    };

    // Non-blocking stdout logging so a stalled stdout consumer can't starve
    // the async runtime. `_log_guard` must stay live for the whole process —
    // `main` returns (rather than `std::process::exit`s) so it drops, flushing
    // buffered lines.
    let _log_guard = fuz_sys::logging::init_non_blocking_stdout("info");

    let password_hasher: Arc<dyn PasswordHasher> = Arc::new(fuz_auth::Argon2idHasher::new());

    // Production wires no test seams: enforced limiters, no daemon token, no
    // pre-migration hook, no in-flight audit tracking (see
    // `RunAppOptions::spine`).
    match zzz_server::run_app(zzz_server::RunAppOptions {
        spine: SpineRunOptions::production(password_hasher, zzz_server::DEFAULT_ADDR),
        args,
        force_test_actions: false,
        extra_action_specs_factory: None,
    })
    .await
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code()),
    }
}
