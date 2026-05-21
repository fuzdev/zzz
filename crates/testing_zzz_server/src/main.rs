//! `testing_zzz_server` — test-mode `zzz_server` binary.
//!
//! **NEVER ship this in a release.** The binary wires
//! [`fuz_testing::TestingArgon2idHasher`] in place of
//! [`fuz_auth::Argon2idHasher`] so cross-process integration tests get
//! ~1-5 ms argon2 feedback instead of production's ~30-50 ms, and
//! registers the `_testing_reset` RPC action from
//! [`fuz_testing::create_testing_reset_action_spec`] so per-test fixtures
//! can opt into a fresh auth-table + domain-state reset between cases.
//! Three layered guardrails keep this from leaking into production:
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
//!
//! TS-side peers: `../../src/lib/server/testing_server_{deno,node}.ts`
//! over a shared `testing_server_core.ts` cover the same
//! `_testing_reset` wire contract on the TS canonical backend (via
//! `stub_password_deps` — the TS analog of [`TestingArgon2idHasher`]).
//! Together the three test entries span both the cross-language axis
//! (TS vs Rust) and the cross-runtime axis (Deno V8 vs Node V8) on
//! the same wire shape.

use std::sync::Arc;

use fuz_auth::PasswordHasher;
use fuz_testing::{
    ResetStateFn, TestingArgon2idHasher, TestingResetOptions, create_testing_reset_action_spec,
};
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

    // The `_testing_reset` factory closes over `Arc<App>` so the
    // domain-state reset closure can clear zzz workspaces + terminals +
    // the optional scratch dir.
    let extra_specs_factory: zzz_server::ExtraActionSpecsFactory = Box::new(|app, runtime| {
        let app_for_reset = Arc::clone(&app);
        let reset_state: ResetStateFn = Arc::new(move || {
            let app = Arc::clone(&app_for_reset);
            Box::pin(async move {
                // Clear every open workspace. The Rust App stores workspaces
                // as a plain HashMap (no per-path close hook like the TS
                // Backend), so a wholesale clear is the right shape — file
                // watchers attached at boot for `zzz_dir` + `scoped_dirs`
                // stay running (Permanent lifetime). `parking_lot::RwLock`
                // is sync — no await.
                //
                // Cross-impl note: the TS reset closure
                // (`testing_server_core.ts:workspace_close`) fires a
                // `workspace_changed` notification per path as a
                // side-effect of borrowing the production close path. This
                // wholesale `.clear()` does not — cross-process tests
                // don't share WS clients across resets, so the divergence
                // isn't observable. Revisit (add a per-path `close_workspace`
                // hook with notification fanout) when a UI consumer closes
                // individual workspaces from the client, OR a subsystem
                // (search index, semantic analysis) needs per-path
                // cleanup cycles.
                app.workspaces.write().clear();

                // Kill every active terminal. `kill_all()` drains the
                // terminal map and waitpids each entry; the manager
                // itself stays usable for the next test's
                // `terminal_create` calls.
                app.pty_manager.kill_all().await;

                // Optional scoped-FS scratch root: tests that allocate
                // per-case scratch dirs under `ZZZ_TESTING_SCRATCH_DIR`
                // get a clean slate. Unset → no-op. I/O failures here
                // surface as a JSON-RPC error so the per-test fixture
                // sees the reset short-circuit instead of silently
                // running against a half-wiped scratch tree.
                if let Ok(scratch_dir) = std::env::var("ZZZ_TESTING_SCRATCH_DIR")
                    && tokio::fs::metadata(&scratch_dir).await.is_ok()
                {
                    tokio::fs::remove_dir_all(&scratch_dir).await.map_err(|e| {
                        fuz_http::internal_error_with_source("remove scratch dir", &e)
                    })?;
                }

                Ok(())
            })
        });
        let daemon_token_state = runtime.daemon_token_state.expect(
            "testing_zzz_server requires daemon-token rotation to be wired \
             (it provides keeper credentials for _testing_reset)",
        );
        vec![create_testing_reset_action_spec(TestingResetOptions {
            password_hasher: runtime.password_hasher,
            keyring: runtime.keyring,
            daemon_token_state,
            reset_state: Some(reset_state),
        })]
    });

    // Pre-migration hook — wipes the auth-namespace schema when
    // `FUZ_TESTING_RESET_DB_ON_STARTUP=true`, then migrations replay
    // from nothing. Lifts the manual `psql DROP TABLE...` step out of
    // the cross-backend test harness so projects can re-run against a
    // shared PG without operator intervention between sessions.
    // No-op when the env var is unset/false.
    let pre_migration_hook: zzz_server::PreMigrationHook = Box::new(|pool: &fuz_db::Pool| {
        Box::pin(async move {
            let client = pool.get().await.map_err(|e| {
                zzz_server::ServerError::Database(format!(
                    "failed to get client for startup reset: {e}"
                ))
            })?;
            fuz_testing::reset_db_on_startup_if_env_set(&client)
                .await
                .map_err(|e| {
                    zzz_server::ServerError::Database(format!("startup DB reset failed: {e}"))
                })?;
            Ok(())
        })
    });

    if let Err(e) = zzz_server::run_app(zzz_server::RunAppOptions {
        password_hasher,
        default_port: TESTING_DEFAULT_PORT,
        force_test_actions: true,
        extra_action_specs_factory: Some(extra_specs_factory),
        pre_migration_hook: Some(pre_migration_hook),
    })
    .await
    {
        tracing::error!(error = %e, "fatal");
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
