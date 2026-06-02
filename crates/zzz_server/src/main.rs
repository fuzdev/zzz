//! `zzz_server` production binary.
//!
//! Thin entry point — wires [`fuz_auth::Argon2idHasher`] (production
//! argon2 params, ~30-50 ms per hash) and hands off to
//! [`zzz_server::run_app`] which owns the full server lifecycle.
//!
//! The `testing_zzz_server` binary in `crates/testing_zzz_server/`
//! ships the same lifecycle with `fuz_testing::TestingArgon2idHasher`
//! swapped in for ~1-5 ms argon2 during cross-process integration
//! tests.

use std::sync::Arc;

use fuz_auth::PasswordHasher;

#[tokio::main]
async fn main() {
    // Non-blocking stdout logging so a stalled stdout consumer can't starve
    // the async runtime. `_log_guard` must stay live for the whole process.
    let _log_guard = fuz_sys::logging::init_non_blocking_stdout("info");

    let password_hasher: Arc<dyn PasswordHasher> = Arc::new(fuz_auth::Argon2idHasher::new());

    if let Err(e) = zzz_server::run_app(zzz_server::RunAppOptions {
        password_hasher,
        default_port: zzz_server::DEFAULT_PORT,
        force_test_actions: false,
        extra_action_specs_factory: None,
        pre_migration_hook: None,
    })
    .await
    {
        tracing::error!(error = %e, "fatal");
        std::process::exit(1);
    }
}
