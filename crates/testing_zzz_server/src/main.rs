//! `testing_zzz_server` — test-mode `zzz_server` binary.
//!
//! **NEVER ship this in a release.** The binary wires
//! [`fuz_testing::TestingArgon2idHasher`] in place of
//! [`fuz_auth::Argon2idHasher`] so cross-process integration tests get
//! ~1-5 ms argon2 feedback instead of production's ~30-50 ms. Three
//! layered guardrails keep this from leaking into production:
//!
//! 1. The `testing_` prefix is enforced by `fuz_release`'s manifest
//!    filter (`is_test_binary_name` rejects any binary name starting
//!    with `testing_`).
//! 2. `cargo xtask check-release` walks `cargo metadata` and asserts
//!    no production binary's package depends on `fuz_testing`. The
//!    `testing_zzz_server` crate is a separate package, so the
//!    sibling `zzz_server` package stays clean of `fuz_testing`.
//! 3. `TestingArgon2idHasher::new` logs `WARN: test-mode argon2 hasher
//!    active` at construction — a sentinel for log-scraping audits.
//!
//! Otherwise structurally identical to `zzz_server`'s production
//! `main.rs`: same tracing init, same lifecycle, same shutdown.
//! Production defaults to port 1174 (`zzz_server::DEFAULT_PORT`); this
//! binary defaults to 1175 so a developer running both locally doesn't
//! collide. Override via `ZZZ_PORT` or `--port` exactly as the
//! production binary supports.

use std::sync::Arc;

use fuz_auth::PasswordHasher;
use fuz_testing::TestingArgon2idHasher;
use tracing_subscriber::EnvFilter;

/// Default loopback port for the testing binary. Distinct from the
/// production default (1174) so both binaries can run side-by-side on
/// `localhost` during local development. The cross-process harness can
/// override via `ZZZ_PORT` or `--port` anyway.
const TESTING_DEFAULT_PORT: u16 = 1175;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,zzz_server=info,testing_zzz_server=info")),
        )
        .init();

    let password_hasher: Arc<dyn PasswordHasher> = Arc::new(TestingArgon2idHasher::new());

    // Always-visible startup sentinel — survives any RUST_LOG filter that
    // would suppress `info!`. The sister `WARN: test-mode argon2 hasher
    // active` line is emitted by `TestingArgon2idHasher::new` itself.
    eprintln!("testing_zzz_server starting (test-mode argon2 active)");

    if let Err(e) = zzz_server::run_app(password_hasher, TESTING_DEFAULT_PORT).await {
        tracing::error!(error = %e, "fatal");
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
