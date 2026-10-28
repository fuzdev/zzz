//! `testing_zzz_server` — test-mode `zzz_server` binary.
//!
//! **NEVER ship this in a release.** The binary wires
//! [`fuz_testing::TestingArgon2idHasher`] in place of
//! [`fuz_auth::Argon2idHasher`] so cross-process integration tests get
//! ~1-5 ms argon2 feedback instead of production's ~30-50 ms, and
//! registers the `_testing_reset` RPC action from
//! [`fuz_testing::create_testing_reset_action_spec`] so per-test fixtures
//! can opt into a fresh auth-table + domain-state reset between cases, and
//! `_testing_drain_effects` from
//! [`fuz_testing::create_testing_drain_effects_action_spec`], the barrier
//! that awaits in-flight fire-and-forget audit writes (a signup's, a
//! failure audit, a WebSocket mutation's) before a test reads the audit log.
//! The drain is a real barrier because this binary builds the app's audit
//! emitter with in-flight tracking ([`fuz_testing::testing_backend_options`]);
//! over an untracked emitter it would return at once.
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
use std::process::ExitCode;
use std::sync::Arc;

use fuz_actions::server::SpineRunOptions;
use fuz_testing::{ResetStateFn, testing_backend_options, testing_reset_specs};

/// Default loopback bind address for the testing binary (port 4462).
/// Distinct from the production default (4460) so both binaries can run
/// side-by-side on `localhost` during local development. `ZZZ_PORT` or
/// `--port` override the port; the host stays loopback.
const TESTING_DEFAULT_ADDR: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 4462);

#[tokio::main]
async fn main() -> ExitCode {
    // `--help` or a bad argument exits before the side effects below (app
    // dir, daemon token).
    let args = match zzz_server::parse_process_args("testing_zzzd") {
        Ok(args) => args,
        Err(exit) => return exit,
    };

    // Non-blocking stdout logging so a stalled stdout consumer can't starve
    // the async runtime. `_log_guard` must stay live for the whole process —
    // `main` returns (rather than `std::process::exit`s) so it drops, flushing
    // buffered lines.
    let _log_guard =
        fuz_sys::logging::init_non_blocking_stdout("info,zzz_server=info,testing_zzzd=info");

    // Always-visible startup sentinel — survives any RUST_LOG filter that
    // would suppress `info!`. The sister `WARN: test-mode argon2 hasher
    // active` line is emitted by `TestingArgon2idHasher::new` itself.
    eprintln!("testing_zzzd starting (test-mode argon2 active)");

    // Daemon-token credential for `_testing_reset`. `fuz_testing` owns the only
    // producer of this credential — `zzz_server` cannot mint one — so the test
    // binary constructs it here and injects the handle. The token is static for
    // the process lifetime (the harness reads it once at spawn).
    //
    // Deliberately `init_daemon_token` against `ensure_zzz_dir_from_env` rather than the
    // sibling `init_daemon_token_from_env` the other testing binaries use.
    // That is `run_app`'s own resolution of `PUBLIC_ZZZ_DIR`, so the
    // file lands exactly where the cross-process harness looks —
    // `<zzz_dir>/run/daemon_token` — and there is a single source of truth for
    // the directory. A dedicated `*_DAEMON_TOKEN_DIR` var would be a second one
    // that has to agree with `PUBLIC_ZZZ_DIR` or the harness silently reads a
    // token from the wrong tree. The `_from_env` "unset → behave like
    // production" affordance buys nothing here either: `_testing_reset` always
    // needs the credential, so a failed init is a hard misconfiguration that
    // exits here.
    let zzz_dir = match zzz_server::ensure_zzz_dir_from_env() {
        Ok(dir) => dir,
        Err(e) => return fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code()),
    };
    let daemon_token_state = match fuz_testing::init_daemon_token(std::path::Path::new(&zzz_dir))
        .await
    {
        Ok(state) => state,
        Err(e) => {
            let e =
                fuz_actions::server::StartupError::Config(format!("daemon token init failed: {e}"));
            return fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code());
        }
    };

    // The factory closes over `Arc<App>` so the `_testing_reset`
    // domain-state reset closure can close zzz workspaces + kill terminals +
    // wipe the optional scratch dir.
    let extra_specs_factory: zzz_server::ExtraActionSpecsFactory = Box::new(move |app, runtime| {
        let app_for_reset = Arc::clone(&app);
        // zzz's domain state is in-memory (workspaces + terminals +
        // scratch dir), so the in-tx `ActionDb` handed in by the spine
        // reset is ignored here — only DB-domain consumers (fuz_forge)
        // use it.
        let reset_state: ResetStateFn = Arc::new(move |_db| {
            let app = Arc::clone(&app_for_reset);
            Box::pin(async move {
                // Close every open workspace through the production close
                // path: each workspace's filer is stopped, its `ScopedFs`
                // root removed, and a `workspace_changed` close broadcast —
                // so neither scope nor watchers leak into the next test (an
                // out-of-scope assertion can't pass because an earlier test
                // left a workspace open). The boot-time `zzz_dir` +
                // `scoped_dirs` roots and filers are permanent and stay.
                zzz_server::handlers::workspace::workspace_close_all(&app).await?;

                // Kill every active terminal. `kill_all()` drains the
                // terminal map and waits (bounded) until each child is
                // reaped; the manager itself stays usable for the next
                // test's `terminal_create` calls.
                app.pty_manager.kill_all().await;

                // Stop and forget every job, so none runs into the next test.
                app.job_manager.cancel_all().await;

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
        testing_reset_specs(&runtime, Some(reset_state))
    });

    match zzz_server::run_app(zzz_server::RunAppOptions {
        spine: SpineRunOptions {
            backend: testing_backend_options(daemon_token_state),
            default_addr: TESTING_DEFAULT_ADDR,
            drain_timeout: fuz_http::DEFAULT_DRAIN_TIMEOUT,
        },
        args,
        force_test_actions: true,
        extra_action_specs_factory: Some(extra_specs_factory),
    })
    .await
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fuz_sys::cli::report_failure(&e, e.hint(), e.exit_code()),
    }
}
