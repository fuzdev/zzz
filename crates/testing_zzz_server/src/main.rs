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
//! Production defaults to `127.0.0.1:4460` (`zzz_server::DEFAULT_ADDR`);
//! this binary defaults to `127.0.0.1:4462` so a developer running both
//! locally doesn't collide. Override the port via `ZZZ_PORT` or `--port`
//! exactly as the production binary supports.

use std::net::SocketAddr;
use std::sync::Arc;

use fuz_auth::PasswordHasher;
use fuz_testing::{
    ResetStateFn, TestingArgon2idHasher, TestingResetOptions, create_testing_reset_action_spec,
};

/// Default loopback bind address for the testing binary (port 4462).
/// Distinct from the production default (4460) so both binaries can run
/// side-by-side on `localhost` during local development. `ZZZ_PORT` or
/// `--port` override the port; the host stays loopback.
const TESTING_DEFAULT_ADDR: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 4462);

#[tokio::main]
async fn main() {
    // Non-blocking stdout logging so a stalled stdout consumer can't starve
    // the async runtime. `_log_guard` must stay live for the whole process.
    let _log_guard =
        fuz_sys::logging::init_non_blocking_stdout("info,zzz_server=info,testing_zzzd=info");

    let password_hasher: Arc<dyn PasswordHasher> = Arc::new(TestingArgon2idHasher::new());

    // Always-visible startup sentinel — survives any RUST_LOG filter that
    // would suppress `info!`. The sister `WARN: test-mode argon2 hasher
    // active` line is emitted by `TestingArgon2idHasher::new` itself.
    eprintln!("testing_zzzd starting (test-mode argon2 active)");

    // The `_testing_reset` factory closes over `Arc<App>` so the
    // domain-state reset closure can clear zzz workspaces + terminals +
    // the optional scratch dir.
    let extra_specs_factory: zzz_server::ExtraActionSpecsFactory = Box::new(|app, runtime| {
        let app_for_reset = Arc::clone(&app);
        // zzz's domain state is in-memory (workspaces + terminals +
        // scratch dir), so the in-tx `ActionDb` handed in by the spine
        // reset is ignored here — only DB-domain consumers (fuz_forge)
        // use it.
        let reset_state: ResetStateFn = Arc::new(move |_db| {
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
            session_cookie_name: runtime.session_cookie_name,
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
        default_addr: TESTING_DEFAULT_ADDR,
        drain_timeout: fuz_http::DEFAULT_DRAIN_TIMEOUT,
        force_test_actions: true,
        disable_login_rate_limit: true,
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
