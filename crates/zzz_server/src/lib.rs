//! `zzz_server` — Rust backend for zzz.
//!
//! The library entry point [`run_app`] owns the full server lifecycle:
//! env loading, DB pool + migrations, spine state construction,
//! `ActionRegistry` compile, file watchers, daemon-token rotation,
//! route composition, signal handling, and graceful shutdown.
//!
//! The `password_hasher` parameter is the swap point for the
//! test-binary pattern (see
//! `~/dev/grimoire/lore/fuz_app/TODO_TEST_BINARY_PATTERN.md`):
//!
//! - Production wires [`fuz_auth::Argon2idHasher`] from `src/main.rs`.
//! - `testing_zzz_server`'s `main.rs` wires
//!   `fuz_testing::TestingArgon2idHasher` for ~1-5 ms argon2 in
//!   cross-process integration tests.
//!
//! Keeping the lifecycle in the library shrinks each binary's
//! `main.rs` to the hasher selection plus `run_app(...)`.

pub mod error;
pub mod filer;
pub mod handlers;
pub mod provider;
pub mod pty_manager;
pub mod rpc;
pub mod scoped_fs;
pub mod zzz_action_specs;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use futures_util::future::BoxFuture;
use serde::Serialize;
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

/// Wires the post-bootstrap keeper-account id into `spine_daemon_token`
/// so subsequent daemon-token-authenticated calls (notably
/// `_testing_reset` on test binaries) resolve the keeper. `fuz_auth`
/// fires this callback after the bootstrap pipeline creates the keeper.
struct SpineDaemonTokenKeeperResolved {
    state: fuz_auth::SharedDaemonTokenState,
}

impl fuz_auth::BootstrapKeeperResolved for SpineDaemonTokenKeeperResolved {
    fn on_keeper_resolved(&self, account_id: uuid::Uuid) -> BoxFuture<'static, ()> {
        let state = Arc::clone(&self.state);
        Box::pin(async move {
            state.write().keeper_account_id = Some(account_id);
            tracing::info!(%account_id, "daemon token: keeper account set by bootstrap");
        })
    }
}

pub use error::ServerError;

/// Default loopback port. Overridden by `--port` or `ZZZ_PORT`.
pub const DEFAULT_PORT: u16 = 1174;

/// Connection drain timeout on shutdown. Bounds how long the graceful
/// drain waits for in-flight connections before returning. Matches the
/// other spine consumers so operators see consistent shutdown UX.
pub const DEFAULT_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Runtime state surfaced to [`ExtraActionSpecsFactory`] — keyring +
/// password hasher + daemon-token state needed by the test binary's
/// `_testing_reset` action to seed a fresh keeper inline.
///
/// `zzz_server` builds these refs during normal assembly and threads
/// them in here so `fuz_testing` doesn't have to re-derive the
/// production shapes. Production passes no factory and never reads
/// this struct.
#[allow(missing_debug_implementations)] // Arc-of-dyn fields don't auto-derive Debug
pub struct ExtraActionSpecsRuntime {
    /// Argon2 hasher (Test binary swaps in
    /// `fuz_testing::TestingArgon2idHasher` for ~1-5 ms feedback;
    /// production wires `Argon2idHasher`).
    pub password_hasher: Arc<dyn fuz_auth::PasswordHasher>,
    /// Cookie-signing keyring — same instance the live server uses.
    pub keyring: Arc<fuz_auth::keyring::Keyring>,
    /// Daemon-token runtime state — `Some(_)` when daemon-token
    /// rotation is wired (always true on test binaries). `_testing_reset`
    /// refreshes `keeper_account_id` here after re-seeding.
    pub daemon_token_state: Option<fuz_auth::SharedDaemonTokenState>,
    /// Per-app session cookie name (default
    /// [`fuz_auth::SESSION_COOKIE_NAME`]) — `_testing_reset` signs the
    /// seeded keeper's cookie under this so the harness jars it under the
    /// same name the live server reads.
    pub session_cookie_name: &'static str,
}

/// Factory that constructs extra action specs to fold into the
/// registry after the standard zzz specs.
///
/// Production passes `None`. The test binary (`testing_zzz_server`)
/// passes `Some(_)` to inject `_testing_reset` (which captures
/// `Arc<App>` for the consumer-side reset closure). `zzz_server` itself
/// stays clean of any `fuz_testing` dep this way — the factory closes
/// over `fuz_testing` types in the test binary's process only.
///
/// The factory receives an `ExtraActionSpecsRuntime` so it can wire
/// the action-handler's required state (keyring, password hasher,
/// daemon-token state) without re-deriving the production shapes.
pub type ExtraActionSpecsFactory = Box<
    dyn FnOnce(Arc<handlers::App>, ExtraActionSpecsRuntime) -> Vec<fuz_actions::ActionSpec> + Send,
>;

/// Async hook fired between pool creation and migrations.
///
/// Production passes `None`. The test binary (`testing_zzz_server`)
/// passes `Some(_)` to fire `fuz_testing::reset_db_on_startup_if_env_set`
/// — env-gated schema wipe so cross-process tests don't have to drop
/// the DB manually between runs. `zzz_server` itself stays clean of
/// any `fuz_testing` dep this way — the hook closes over
/// `fuz_testing` symbols in the test binary's process only.
///
/// The hook receives a borrowed `Pool` reference; cloning is cheap
/// (`Arc` internally) when the hook needs an owned handle. Errors
/// surface as a [`ServerError::Database`] so the test binary's
/// startup chain fails the same way a real migration error would.
pub type PreMigrationHook = Box<
    dyn FnOnce(
            &fuz_db::Pool,
        ) -> std::pin::Pin<
            Box<dyn Future<Output = Result<(), ServerError>> + Send + '_>,
        > + Send,
>;

/// Options for [`run_app`].
///
/// Named fields rather than positional params so future swap points
/// can land additively without churning every call site. The
/// `extra_action_specs_factory` slot already follows that pattern —
/// adding a second factory or a config override (e.g., a test-only
/// notify decorator) would be one new named field plus a `Default`
/// fallback.
pub struct RunAppOptions {
    /// Production-vs-test password hasher swap point.
    /// Production: [`fuz_auth::Argon2idHasher`]. Test binary:
    /// `fuz_testing::TestingArgon2idHasher`.
    pub password_hasher: Arc<dyn fuz_auth::PasswordHasher>,
    /// Default port when neither `--port` nor `ZZZ_PORT` is supplied.
    /// Production: [`DEFAULT_PORT`] (1174). Test binary: 1175 so the
    /// two can run side-by-side without colliding.
    pub default_port: u16,
    /// Override the `ZZZ_ENABLE_TEST_ACTIONS` env-parsed flag.
    /// Production: `false`. Test binary: `true` so the `_testing_*`
    /// registry branch fires regardless of operator env.
    pub force_test_actions: bool,
    /// Factory injecting extra action specs after the standard zzz set.
    /// Production: `None`. Test binary: `Some(_)` so
    /// `fuz_testing::create_testing_reset_action_spec` can register
    /// without dragging `fuz_testing` into the production dep graph
    /// (the `cargo xtask check-release` audit blocks that).
    pub extra_action_specs_factory: Option<ExtraActionSpecsFactory>,
    /// Hook fired after pool creation, **before** migrations run.
    /// Production: `None`. Test binary: `Some(_)` to wire
    /// `fuz_testing::reset_db_on_startup_if_env_set` so per-process
    /// startup can wipe the auth-namespace schema and let migrations
    /// replay from nothing.
    pub pre_migration_hook: Option<PreMigrationHook>,
}

/// Run the `zzz_server` lifecycle to completion.
///
/// Parses CLI args + env, opens the DB pool, runs migrations, builds
/// every spine subsystem, mounts the routes, binds the listener, and
/// blocks on graceful shutdown (Ctrl-C / SIGTERM). Returns once all
/// connections have drained and PTYs are torn down.
///
/// Every configuration knob lives on [`RunAppOptions`]; everything
/// not explicitly named there flows from CLI args or the process
/// environment.
///
/// # Errors
///
/// Returns [`ServerError`] for env/config validation failures, DB
/// connectivity / migration failures, listener bind failures, and
/// `axum::serve` errors.
pub async fn run_app(options: RunAppOptions) -> Result<(), ServerError> {
    let RunAppOptions {
        password_hasher,
        default_port,
        force_test_actions,
        extra_action_specs_factory,
        pre_migration_hook,
    } = options;
    let mut config = parse_config(default_port)?;
    if force_test_actions {
        config.enable_test_actions = true;
    }

    // Database — required. Spine `fuz_db::create_pool` builds the
    // deadpool-postgres pool; `fuz_db::run_migrations` runs the auth DDL
    // tracked under the reserved `fuz_auth` namespace. Phase 7 Batch 4
    // retired the legacy `crate::db` module (`db::create_pool` /
    // `db::run_migrations` / `db::query_*`) wholesale.
    let pool = fuz_db::create_pool(&config.database_url)
        .map_err(|e| ServerError::Database(format!("failed to create pool: {e}")))?;
    // Pre-migration hook — test binary uses this slot for the env-gated
    // `fuz_testing::reset_db_on_startup_if_env_set` schema wipe so the
    // migration chain below sees a clean DB. Production passes `None`.
    if let Some(hook) = pre_migration_hook {
        hook(&pool).await?;
    }
    fuz_db::run_migrations(&pool, &[fuz_auth::AUTH_MIGRATIONS])
        .await
        .map_err(|e| ServerError::Database(format!("migration failed: {e}")))?;

    // Validate the cookie keys env early; the spine `fuz_auth::Keyring`
    // (constructed below as `spine_keyring`) is the sole keyring on `App`
    // since Phase 7 Batch 3 retired `crate::auth`.
    let errors = fuz_auth::Keyring::validate(&config.secret_cookie_keys);
    if !errors.is_empty() {
        return Err(ServerError::Config(format!(
            "SECRET_FUZ_COOKIE_KEYS validation failed: {}",
            errors.join(", ")
        )));
    }

    // Bootstrap availability check — drives the `bootstrap_available_atomic`
    // shared by the spine account router (returned on `/status` 401) and
    // the bootstrap router (gate on `/bootstrap`).
    let bootstrap_available =
        fuz_auth::is_bootstrap_available(&pool, config.bootstrap_token_path.as_deref()).await;

    let scoped_dir_strings: Vec<String> =
        config.scoped_dirs.iter().map(|p| resolve_dir(p)).collect();

    // Include zzz_dir first (like Deno: `new ScopedFs([this.zzz_dir, ...this.scoped_dirs])`)
    // Use canonicalized paths, not raw config paths
    let mut scoped_fs_paths: Vec<PathBuf> = Vec::with_capacity(1 + scoped_dir_strings.len());
    scoped_fs_paths.push(PathBuf::from(&config.zzz_dir));
    scoped_fs_paths.extend(scoped_dir_strings.iter().map(PathBuf::from));
    let scoped_fs = scoped_fs::ScopedFs::new(scoped_fs_paths);

    // AI providers — read API keys from env, construct ProviderManager
    let mut provider_manager = provider::ProviderManager::new();
    provider_manager.add(provider::Provider::Anthropic(
        provider::anthropic::AnthropicProvider::new(std::env::var("SECRET_ANTHROPIC_API_KEY").ok()),
    ));
    provider_manager.add(provider::Provider::OpenAi(
        provider::openai::OpenAiProvider::new(std::env::var("SECRET_OPENAI_API_KEY").ok()),
    ));
    provider_manager.add(provider::Provider::Gemini(
        provider::gemini::GeminiProvider::new(std::env::var("SECRET_GOOGLE_API_KEY").ok()),
    ));

    if config.enable_test_actions {
        tracing::info!(
            "test actions enabled — `_testing_*` methods registered on live dispatchers"
        );
    }

    // Per-IP + per-account rate limiters on `/login` and `/password`.
    // Opt-in via `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1`. Mirrors fuz_app's
    // `default_login_ip_rate_limit` (5 / 15min) and
    // `default_login_account_rate_limit` (10 / 30min). `None` when the
    // env var is unset so the handlers skip the check entirely. Spine
    // `fuz_auth::RateLimiter` (parking_lot, sync) since Phase 7 Batch 3.
    let (login_ip_rate_limiter, login_account_rate_limiter) = if config.enable_login_rate_limit {
        tracing::info!("login rate limiting enabled (5/15min per-IP, 10/30min per-account)");
        (
            Some(Arc::new(fuz_auth::RateLimiter::new(
                fuz_auth::DEFAULT_LOGIN_IP_RATE_LIMIT,
            ))),
            Some(Arc::new(fuz_auth::RateLimiter::new(
                fuz_auth::DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT,
            ))),
        )
    } else {
        (None, None)
    };

    // Per-account rate limiter shared across admin RPC methods and the
    // role-grant-offer surface. Mirrors fuz_app's
    // `default_action_account_rate_limit` (1200 / 15min per actor) —
    // bounds paginated admin-side scraping pressure per the TS posture
    // at `admin_action_specs.ts:262..400` (every admin spec carries
    // `rate_limit: 'account'`) and offer-spam / account-existence-oracle
    // pressure on `role_grant_offer_create` per
    // `role_grant_offer_action_specs.ts:211..228`. Always-on (no env
    // gate); the production cap sits far above the cross-backend test
    // suite's request volume.
    let action_account_rate_limiter: Option<Arc<fuz_auth::RateLimiter>> = Some(Arc::new(
        fuz_auth::RateLimiter::new(fuz_auth::RateLimiterOptions {
            max_attempts: 1200,
            window_ms: 15 * 60_000,
        }),
    ));
    // IP-axis action limiter unwired today — TS shape `rate_limit: 'account'`
    // doesn't gate on IP. Leave `None`; lift to a real limiter when a
    // consumer files a need (e.g. a deployment fronted by a CDN where
    // per-account scraping flows from one IP).
    let action_ip_rate_limiter: Option<Arc<fuz_auth::RateLimiter>> = None;

    // Spine connection registry + audit emitter — wired into `App` and
    // mounted into the spine RPC + WS dispatchers below. Listener
    // registration (audit-event → socket revocation) happens after
    // `Arc<App>` is constructed so the socket-revoker capability is
    // available.
    let realtime = Arc::new(fuz_realtime::ConnectionRegistry::new());
    let spine_audit_emitter = Arc::new(fuz_auth::AuditEmitter::new(pool.clone()));
    // SSE half of the realtime surface — the registry of open
    // `GET /api/admin/audit/stream` subscriptions. The audit listener wired
    // alongside the socket-revocation listeners below fans every audit row to
    // these streams and closes account-keyed streams on revocation.
    let audit_sse = Arc::new(fuz_realtime::SseRegistry::new());
    let spine_keyring = Arc::new(
        fuz_auth::Keyring::new(&config.secret_cookie_keys).ok_or_else(|| {
            ServerError::Config(
                "SECRET_FUZ_COOKIE_KEYS is required for spine keyring (no valid keys found)"
                    .to_owned(),
            )
        })?,
    );
    let spine_password_hasher: Arc<dyn fuz_auth::PasswordHasher> = password_hasher;
    // Parse `ZZZ_TRUSTED_PROXIES` into the spine `fuz_http::ParsedProxy`
    // type. Empty/unset → empty vec → middleware treats every connection
    // as untrusted (XFF ignored, `client_ip` = TCP peer). Misconfiguration
    // fails fast so the operator sees the error instead of silently
    // leaving a hole. Sole trusted-proxy state on `App` since Phase 7
    // Batch 2 retired the legacy `crate::proxy` module.
    let spine_trusted_proxies: Arc<Vec<fuz_http::ParsedProxy>> =
        Arc::new(match config.trusted_proxies.as_deref() {
            None => Vec::new(),
            Some(raw) => fuz_http::parse_proxy_list(raw)
                .map_err(|e| ServerError::Config(format!("ZZZ_TRUSTED_PROXIES: {e}")))?,
        });
    if !spine_trusted_proxies.is_empty() {
        tracing::info!(
            count = spine_trusted_proxies.len(),
            "trusted proxies configured — XFF resolution enabled"
        );
    }
    let spine_allowed_origins: Vec<String> = config
        .allowed_origins
        .as_deref()
        .map(fuz_http::parse_allowed_origins)
        .unwrap_or_default();
    // Fail loud: an absent or all-empty allowlist would make
    // `fuz_http::check_origin` allow every origin (empty list = allow-all),
    // silently disabling the origin gate on every REST + RPC + WS handler.
    // Refuse to boot instead — mirrors the TS `validate_server_env` contract.
    if spine_allowed_origins.is_empty() {
        return Err(ServerError::Config(
            "FUZ_ALLOWED_ORIGINS is required and must list at least one origin \
             (an empty allowlist would disable origin checks)"
                .to_string(),
        ));
    }
    let spine_allowed_origins = Arc::new(spine_allowed_origins);
    let bootstrap_available_atomic =
        Arc::new(std::sync::atomic::AtomicBool::new(bootstrap_available));
    let socket_revoker: Arc<dyn fuz_auth::SocketRevoker> =
        Arc::clone(&realtime).into_socket_revoker();
    // Spine daemon-token state — sole daemon-token state on `App` since
    // Phase 7 Batch 3 retired `crate::daemon_token`. Init failure
    // degrades to `None` so the server still serves cookie + bearer auth.
    let spine_daemon_token: Option<fuz_auth::SharedDaemonTokenState> =
        match fuz_auth::init_daemon_token(Path::new(&config.zzz_dir)).await {
            Ok(state) => {
                if let Ok(client) = pool.get().await
                    && let Ok(Some(account_id)) =
                        fuz_auth::actor_queries::query_keeper_account_id(&client).await
                {
                    state.write().keeper_account_id = Some(account_id);
                    tracing::info!(%account_id, "daemon token: keeper account resolved");
                }
                Some(state)
            }
            Err(e) => {
                tracing::warn!(error = %e, "daemon token init failed — running without daemon token auth");
                None
            }
        };
    let account_route_state = fuz_auth::AccountRouteState {
        pool: pool.clone(),
        keyring: Arc::clone(&spine_keyring),
        password_hasher: Arc::clone(&spine_password_hasher),
        audit: Arc::clone(&spine_audit_emitter),
        socket_revoker: Arc::clone(&socket_revoker),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        bootstrap_available: Arc::clone(&bootstrap_available_atomic),
        login_ip_rate_limiter,
        login_account_rate_limiter,
        daemon_token_state: spine_daemon_token.clone(),
        session_cookie_name: fuz_auth::SESSION_COOKIE_NAME,
    };
    let bootstrap_route_state = fuz_auth::BootstrapRouteState {
        options: Arc::new(fuz_auth::BootstrapOptions {
            pool: pool.clone(),
            password_hasher: Arc::clone(&spine_password_hasher),
            audit: Arc::clone(&spine_audit_emitter),
            bootstrap_available: Arc::clone(&bootstrap_available_atomic),
            token_store: config.bootstrap_token_path.as_ref().map(|p| {
                let store: Arc<dyn fuz_auth::BootstrapTokenStore> =
                    Arc::new(fuz_auth::FileBootstrapTokenStore::new(PathBuf::from(p)));
                store
            }),
            on_keeper_resolved: spine_daemon_token.as_ref().map(|state| {
                let cb: Arc<dyn fuz_auth::BootstrapKeeperResolved> =
                    Arc::new(SpineDaemonTokenKeeperResolved {
                        state: Arc::clone(state),
                    });
                cb
            }),
        }),
        keyring: Arc::clone(&spine_keyring),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        session_cookie_name: fuz_auth::SESSION_COOKIE_NAME,
    };

    // Signup route: mounted on the production server so the
    // cross-process integration harness (testing_zzz_server reuses
    // run_app) can mint per-test accounts through production RPC.
    // Open_signup defaults to false in app_settings, so the route is
    // invite-gated at runtime unless an admin flips the flag. The
    // signup handler loads app_settings per request; switch to a
    // cached Arc<RwLock<AppSettings>> shared with the future admin
    // update handler when that lands on Rust.
    //
    // TS parity follow-up: zzz's Deno backend does not mount /signup
    // today (see zzz/src/lib/server/CLAUDE.md). Mount it there too
    // when the TS side catches up to the Rust-side decision so the
    // two backends stay observationally identical at the wire.
    let signup_route_state = fuz_auth::SignupRouteState {
        options: Arc::new(fuz_auth::SignupOptions {
            pool: pool.clone(),
            password_hasher: Arc::clone(&spine_password_hasher),
            audit: Arc::clone(&spine_audit_emitter),
            signup_ip_rate_limiter: None,
            signup_account_rate_limiter: None,
            signup_fail_floor_ms: fuz_auth::DEFAULT_SIGNUP_FAIL_FLOOR_MS,
            signup_fail_jitter_ms: fuz_auth::DEFAULT_SIGNUP_FAIL_JITTER_MS,
        }),
        keyring: Arc::clone(&spine_keyring),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        session_cookie_name: fuz_auth::SESSION_COOKIE_NAME,
    };

    let app_state = Arc::new(handlers::App::new(
        pool,
        scoped_fs,
        config.zzz_dir,
        scoped_dir_strings,
        provider_manager,
        config.enable_test_actions,
        Arc::clone(&realtime),
    ));

    // Register audit-event → WebSocket socket-revocation listeners on
    // the spine `AuditEmitter`. Mirrors `fuz_app`'s
    // `create_ws_auth_guard` + `create_ws_logout_closer` composition.
    //
    // One listener per event type — keeps matching logic explicit and
    // avoids a per-event match cascade in a single closure. Failure
    // outcomes never trigger socket close: a failed `session_revoke` row
    // carries the caller-submitted `session_id` (attacker-controlled
    // metadata), so reacting to it would let an authenticated user
    // disconnect another user by guessing a session hash.
    //
    // ## Layering with eager handler-side close
    //
    // Revocation-emitting RPC handlers (`account_session_revoke`,
    // `account_session_revoke_all`, `account_token_revoke`) and REST
    // handlers (`/api/account/logout`, `/api/account/password`) call
    // `close_sockets_for_*` synchronously before emitting the audit row.
    // That eager call is the actual revocation guarantee — it lands on
    // the live WS even if the audit INSERT later fails. The listeners
    // run on the materialized row and call the same idempotent
    // `close_sockets_for_*` a second time; the duplication is
    // intentional defense-in-depth.
    fuz_auth::register_socket_revocation_listeners(&spine_audit_emitter, &socket_revoker);

    // SSE half of the audit fan-out — every audit row becomes one `data:`
    // frame on each open `/api/admin/audit/stream` subscription, and a
    // successful account-wide revocation drops that account's streams. Mirrors
    // `fuz_app`'s `create_audit_log_sse`; the socket-revocation listeners above
    // are the WS half.
    fuz_realtime::register_audit_sse_listener(&spine_audit_emitter, &audit_sse);

    // Compile the spine action registry — must run after `Arc<App>` is
    // constructed because the zzz-specific spec builders capture
    // `Arc::clone(&app_state)` into per-spec handler closures.
    //
    // Composition order: protocol (heartbeat + cancel), then
    // `fuz_auth` placeholder adapters (account + admin self-service),
    // then zzz-specific specs (`core`, `workspace`, `filesystem`,
    // `terminal`, `provider`).
    let mut all_specs: Vec<fuz_actions::ActionSpec> = fuz_actions::PROTOCOL_ACTION_SPECS();
    all_specs.extend(fuz_actions::auth_adapter::build_auth_spec_set(
        Arc::clone(&spine_audit_emitter),
        Arc::clone(&socket_revoker),
        action_account_rate_limiter.clone(),
        action_ip_rate_limiter.clone(),
    ));
    all_specs.extend(zzz_action_specs::build_core_specs(Arc::clone(&app_state)));
    all_specs.extend(zzz_action_specs::build_workspace_specs(Arc::clone(
        &app_state,
    )));
    all_specs.extend(zzz_action_specs::build_filesystem_specs(Arc::clone(
        &app_state,
    )));
    all_specs.extend(zzz_action_specs::build_terminal_specs(Arc::clone(
        &app_state,
    )));
    all_specs.extend(zzz_action_specs::build_provider_specs(Arc::clone(
        &app_state,
    )));
    if app_state.enable_test_actions {
        all_specs.extend(zzz_action_specs::build_testing_specs(Arc::clone(
            &app_state,
        )));
    }
    if let Some(factory) = extra_action_specs_factory {
        let runtime = ExtraActionSpecsRuntime {
            password_hasher: Arc::clone(&spine_password_hasher),
            keyring: Arc::clone(&spine_keyring),
            daemon_token_state: spine_daemon_token.clone(),
            session_cookie_name: fuz_auth::SESSION_COOKIE_NAME,
        };
        all_specs.extend(factory(Arc::clone(&app_state), runtime));
    }
    let action_registry = Arc::new(
        fuz_actions::ActionRegistry::compile(all_specs)
            .map_err(|e| ServerError::Config(format!("ActionRegistry::compile failed: {e}")))?,
    );
    // Set the action_registry on App via OnceLock. The set call returns
    // Err only if the cell is already populated, which is impossible
    // here because we just constructed the Arc<App>.
    if app_state.action_registry.set(action_registry).is_err() {
        return Err(ServerError::Config(
            "action_registry was already set — unexpected double init".to_owned(),
        ));
    }
    tracing::info!(
        spec_count = app_state.action_registry.get().map_or(0, |r| r.len()),
        "spine action registry compiled"
    );

    // Start file watchers at startup (matches Deno's Backend constructor
    // which calls `this.#start_filer(this.zzz_dir)` then iterates scoped_dirs).
    // zzz_dir uses FilerConfig::zzz_dir() (no .zzz ignore); scoped_dirs use workspace config.
    match app_state
        .filer_manager
        .start_filer(
            &app_state.zzz_dir,
            Arc::clone(&app_state),
            filer::FilerConfig::zzz_dir(),
            filer::FilerLifetime::Permanent,
        )
        .await
    {
        Ok(_) => tracing::info!(path = %app_state.zzz_dir, "started zzz_dir filer"),
        Err(e) => {
            tracing::warn!(path = %app_state.zzz_dir, error = %e, "failed to start zzz_dir filer");
        }
    }

    for dir in &app_state.scoped_dirs {
        if *dir == app_state.zzz_dir {
            continue;
        }
        match app_state
            .filer_manager
            .start_filer(
                dir,
                Arc::clone(&app_state),
                filer::FilerConfig::workspace(&app_state.zzz_dir),
                filer::FilerLifetime::Permanent,
            )
            .await
        {
            Ok(_) => tracing::info!(path = %dir, "started scoped_dir filer"),
            Err(e) => tracing::warn!(path = %dir, error = %e, "failed to start scoped_dir filer"),
        }
    }

    // Spawn daemon-token rotation task on the spine state (matches
    // `fuz_app`'s rotation cadence; the spine `spawn_rotation_task` uses
    // `parking_lot::RwLock` so no async runtime hop per rotation).
    let rotation_handle = spine_daemon_token
        .as_ref()
        .map(|state| fuz_auth::spawn_rotation_task(Arc::clone(state)));

    let app_state_for_shutdown = Arc::clone(&app_state);

    // -- Spine RPC + WS routes -------------------------------------
    //
    // The spine `ActionRegistry` dispatcher is mounted at `/api/rpc`
    // and the spine WS handler at `/api/ws` — the single namespace
    // per the ecosystem's pre-stable posture (no `/v2` suffix, no
    // compat shim, no deprecation period). The 24-spec
    // `ActionRegistry` (2 protocol + 9 auth_adapter + 13
    // zzz-specific) is the sole dispatcher for `/api/rpc` and
    // `/api/ws` traffic; legacy `crate::ws` was retired in Phase 7
    // Batch 1 and the framework half of `rpc.rs` (`rpc_handler` /
    // `rpc_get_handler` / classify) alongside it.
    //
    // Existing call sites (`app.broadcast` /
    // `app.close_sockets_for_*`) are shimmed onto `App.realtime`
    // via Strategy α (see `handlers/mod.rs`).
    //
    // Middleware: each spine router carries its own
    // `fuz_http::client_ip_middleware` layer over
    // `spine_trusted_proxies`. The outer router (`/api/account/*` REST
    // + `/api/account/bootstrap`) also reads `Extension<fuz_http::ClientIp>`
    // since Phase 7 Batch 2 migrated those handlers off the legacy
    // `crate::proxy::ClientIp`; a separate `fuz_http::client_ip_middleware`
    // layer below covers the outer scope.
    let registry_for_rpc = Arc::clone(app_state.action_registry.get().ok_or_else(|| {
        ServerError::Config("action_registry must be set before mounting /api/rpc".to_owned())
    })?);
    let spine_rpc_state = fuz_actions::RpcRouteState {
        pool: app_state.db_pool.clone(),
        keyring: Arc::clone(&spine_keyring),
        daemon_token_state: spine_daemon_token.clone(),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        registry: registry_for_rpc,
        audit: Arc::clone(&spine_audit_emitter),
        socket_revoker: Arc::clone(&socket_revoker),
        // Same `ConnectionRegistry` the WS endpoint populates, so a
        // notification emitted on the HTTP dispatch path reaches the
        // live sockets rather than an empty registry.
        notification_sender: Arc::clone(&realtime).into_notification_sender(),
        session_cookie_name: fuz_auth::SESSION_COOKIE_NAME,
    };
    let spine_rpc_router = fuz_actions::create_rpc_router(spine_rpc_state).layer(
        axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ),
    );

    let registry_for_ws = Arc::clone(app_state.action_registry.get().ok_or_else(|| {
        ServerError::Config("action_registry must be set before mounting /api/ws".to_owned())
    })?);
    let spine_ws_state = fuz_actions::WsRouteState {
        pool: app_state.db_pool.clone(),
        keyring: Arc::clone(&spine_keyring),
        daemon_token_state: spine_daemon_token.clone(),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        registry: registry_for_ws,
        audit: Arc::clone(&spine_audit_emitter),
        socket_revoker: Arc::clone(&socket_revoker),
        notification_sender: Arc::clone(&realtime).into_notification_sender(),
        connection_registry: Arc::clone(&realtime),
        session_cookie_name: fuz_auth::SESSION_COOKIE_NAME,
    };
    let spine_ws_router = fuz_actions::register_action_ws(spine_ws_state).layer(
        axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ),
    );

    // Spine account REST router: mounts `/status`, `/login`, `/logout`,
    // `/password` under `/api/account`. Replaces the legacy
    // `crate::account::*` handlers retired in Phase 7 Batch 4.
    // `fuz_http::client_ip_middleware` is wrapped on the router so
    // `Extension<fuz_http::ClientIp>` is populated for every account
    // route (rate-limit keys + audit_log.ip).
    let spine_account_router =
        fuz_auth::account_router(account_route_state).layer(axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ));

    // Spine bootstrap router: mounts `/bootstrap` at the router root, so
    // nesting under `/api/account` produces `/api/account/bootstrap`.
    // Replaces the legacy `crate::bootstrap::bootstrap_handler`.
    let spine_bootstrap_router = fuz_auth::bootstrap_routes::bootstrap_router(
        bootstrap_route_state,
    )
    .layer(axum::middleware::from_fn_with_state(
        Arc::clone(&spine_trusted_proxies),
        fuz_http::client_ip_middleware,
    ));

    // Spine signup router: mounts `/signup` at the router root, so
    // nesting under `/api/account` produces `/api/account/signup`.
    // Same client_ip_middleware layer so audit_log.ip on success +
    // failure rows reflects the resolved client IP rather than the
    // proxy peer.
    let spine_signup_router = fuz_auth::signup_routes::signup_router(signup_route_state).layer(
        axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ),
    );

    // Spine audit-log SSE stream: `GET /api/admin/audit/stream` — the shared
    // `fuz_realtime::audit_stream_router` (admin-gated, account-keyed close on
    // revocation), wired to the `audit_sse` registry the listener above fans
    // rows into. Carries its own `origin_layer` so the origin allowlist gates
    // it like every other zzz handler; it resolves auth itself and writes no
    // `audit_log.ip`, so no `client_ip` layer is needed.
    let spine_audit_stream_router = fuz_realtime::audit_stream_router(
        fuz_realtime::AuditStreamRouteState::new(
            app_state.db_pool.clone(),
            Arc::clone(&spine_keyring),
            spine_daemon_token.clone(),
            Arc::clone(&audit_sse),
        ),
    )
    .layer(axum::middleware::from_fn_with_state(
        Arc::clone(&spine_allowed_origins),
        fuz_http::origin_layer,
    ));

    let mut app = Router::new()
        .route("/health", get(health_handler))
        // Spine REST routers — account REST + bootstrap. The order of
        // `.nest("/api/account", ...)` calls doesn't matter because the
        // bootstrap router only exposes `/bootstrap` and account exposes
        // the four other paths. axum merges nests at the same prefix.
        .nest("/api/account", spine_account_router)
        .nest("/api/account", spine_bootstrap_router)
        .nest("/api/account", spine_signup_router)
        // Spine RPC + WS — single canonical mount. `create_rpc_router`
        // exposes `/rpc` and `register_action_ws` exposes `/ws`, so
        // nesting at `/api` produces `/api/rpc` and `/api/ws`. Both
        // nested routers carry their own state (`RpcRouteState` /
        // `WsRouteState`) + middleware stack.
        .nest("/api", spine_rpc_router)
        .nest("/api", spine_ws_router)
        // Admin-gated audit-log SSE stream — absolute path, so merge (not nest).
        .merge(spine_audit_stream_router);

    if let Some(ref dir) = config.static_dir {
        tracing::info!(dir = %dir.display(), "serving static files");
        app = app.fallback_service(ServeDir::new(dir));
    }

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|source| ServerError::Bind { addr, source })?;

    tracing::info!("zzz_server listening on {addr}");

    // Signal handling + graceful drain come from the spine
    // (`fuz_http::lifecycle`) — the SIGINT/SIGTERM → `CancellationToken`
    // → drain dance is shared with the other spine consumers. zzz's own
    // teardown (rotation-task abort, PTY cleanup) runs after the drain
    // returns.
    let shutdown = fuz_http::shutdown_token();
    fuz_http::serve_with_shutdown(listener, app, shutdown, DEFAULT_DRAIN_TIMEOUT)
        .await
        .map_err(ServerError::Serve)?;

    // Stop daemon token rotation
    if let Some(handle) = rotation_handle {
        handle.abort();
    }

    // Clean up spawned terminal processes before exiting
    app_state_for_shutdown.pty_manager.kill_all().await;

    tracing::info!("server shutdown complete");
    Ok(())
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

// -- Config -------------------------------------------------------------------

/// Validated config built from CLI args + env vars.
pub struct Config {
    pub port: u16,
    pub static_dir: Option<PathBuf>,
    pub database_url: String,
    pub secret_cookie_keys: String,
    pub bootstrap_token_path: Option<String>,
    pub allowed_origins: Option<String>,
    pub scoped_dirs: Vec<PathBuf>,
    pub zzz_dir: String,
    /// Register `_testing_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave unset.
    pub enable_test_actions: bool,
    /// Enable per-IP + per-account rate limiting on `/login` and
    /// `/password`. Set in production via `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1`;
    /// default off so integration tests don't trip the bucket. The
    /// dedicated rate-limit integration test sets it explicitly.
    pub enable_login_rate_limit: bool,
    /// Comma-separated trusted-proxy entries (IPs and CIDR ranges).
    /// Unset/empty → no XFF trust → `client_ip` falls back to the TCP
    /// peer IP on every request. Set when running behind a reverse
    /// proxy so login rate-limit keys and `audit_log.ip` reflect the
    /// originating client. Parsed eagerly in `run()`; invalid entries
    /// fail startup.
    pub trusted_proxies: Option<String>,
}

/// Read a Zod-`stringbool()`-shaped env var via the spine parser
/// ([`fuz_common::env::parse_stringbool`]): case-insensitive truthy
/// (`true`/`1`/`yes`/`on`/`y`/`enabled`) / falsy
/// (`false`/`0`/`no`/`off`/`n`/`disabled`). Unset → `false`; unknown
/// values error so a typo doesn't silently disable the feature.
fn parse_stringbool_env(name: &str) -> Result<bool, ServerError> {
    let Ok(v) = std::env::var(name) else {
        return Ok(false);
    };
    fuz_common::env::parse_stringbool(&v)
        .map_err(|e| ServerError::Config(format!("{name}: {e}")))
}

/// Resolve a path to an absolute, canonical, normalized directory string
/// with trailing `/`. Tries `canonicalize` (resolves symlinks, requires path
/// to exist), falls back to `absolute` (no I/O), falls back to the raw path.
fn resolve_dir(path: &Path) -> String {
    let mut s = std::fs::canonicalize(path)
        .unwrap_or_else(|_| std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()))
        .to_string_lossy()
        .into_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

fn parse_config(default_port: u16) -> Result<Config, ServerError> {
    let mut port: Option<u16> = None;
    let mut static_dir: Option<PathBuf> = None;

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    if let Ok(p) = val.parse() {
                        port = Some(p);
                    } else {
                        tracing::warn!(value = val.as_str(), "invalid --port value, ignoring");
                    }
                }
            }
            "--static-dir" => {
                i += 1;
                if let Some(val) = args.get(i) {
                    static_dir = Some(PathBuf::from(val));
                }
            }
            _ => {}
        }
        i += 1;
    }

    // Fall back to env vars for port/static_dir
    if port.is_none()
        && let Ok(val) = std::env::var("ZZZ_PORT")
    {
        if let Ok(p) = val.parse() {
            port = Some(p);
        } else {
            tracing::warn!(value = val.as_str(), "invalid ZZZ_PORT value, ignoring");
        }
    }
    if static_dir.is_none()
        && let Ok(val) = std::env::var("ZZZ_STATIC_DIR")
    {
        static_dir = Some(PathBuf::from(val));
    }

    // Required env vars
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| ServerError::Config("DATABASE_URL is required".to_owned()))?;

    let secret_cookie_keys = std::env::var("SECRET_FUZ_COOKIE_KEYS")
        .map_err(|_| ServerError::Config("SECRET_FUZ_COOKIE_KEYS is required".to_owned()))?;

    let bootstrap_token_path = std::env::var("FUZ_BOOTSTRAP_TOKEN_PATH").ok();
    let allowed_origins = std::env::var("FUZ_ALLOWED_ORIGINS").ok();

    let scoped_dirs = std::env::var("PUBLIC_ZZZ_SCOPED_DIRS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();

    let zzz_dir = {
        let raw = std::env::var("PUBLIC_ZZZ_DIR").unwrap_or_else(|_| ".zzz/".to_owned());
        resolve_dir(Path::new(&raw))
    };

    let enable_test_actions = parse_stringbool_env("ZZZ_ENABLE_TEST_ACTIONS")?;
    let enable_login_rate_limit = parse_stringbool_env("ZZZ_LOGIN_RATE_LIMIT_ENABLED")?;
    let trusted_proxies = std::env::var("ZZZ_TRUSTED_PROXIES").ok();

    Ok(Config {
        port: port.unwrap_or(default_port),
        static_dir,
        database_url,
        secret_cookie_keys,
        bootstrap_token_path,
        allowed_origins,
        scoped_dirs,
        zzz_dir,
        enable_test_actions,
        enable_login_rate_limit,
        trusted_proxies,
    })
}
