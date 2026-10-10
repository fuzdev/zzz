//! `zzz_server` — Rust backend for zzz.
//!
//! The library entry point [`run_app`] owns the full server lifecycle:
//! env loading, DB pool + migrations, spine state construction,
//! `ActionRegistry` compile, file watchers, daemon-token rotation,
//! route composition, signal handling, the auth cleanup task, and
//! graceful shutdown.
//!
//! The `password_hasher` parameter is the swap point for the
//! test-binary pattern (fast argon2 via a pluggable hasher):
//!
//! - Production wires [`fuz_auth::Argon2idHasher`] from `src/main.rs`.
//! - `testing_zzz_server`'s `main.rs` wires
//!   `fuz_testing::TestingArgon2idHasher` for ~1-5 ms argon2 in
//!   cross-process integration tests.
//!
//! Keeping the lifecycle in the library shrinks each binary's
//! `main.rs` to the hasher selection plus `run_app(...)`.

pub mod error;
pub mod file_bytes;
pub mod filer;
pub mod handlers;
pub mod job_manager;
pub mod media;
pub mod provider;
pub mod pty_manager;
pub mod scoped_fs;
pub mod static_files;
pub mod tool;
pub mod transcription;
pub mod utf8_stream;
pub mod zzz_action_specs;

use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tokio::net::TcpListener;

pub use error::ServerError;

/// Default loopback bind address (port 4460).
///
/// `--port` or `ZZZ_PORT` override the port; the host stays loopback. The
/// port matches the `zzz` CLI's daemon default so a directly-run `zzzd` and a
/// CLI-spawned daemon bind the same port.
pub const DEFAULT_ADDR: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 4460);

/// Prefix of zzz's session cookie name; the daemon's port completes it (see
/// [`session_cookie_name_for_port`]).
pub const SESSION_COOKIE_NAME_PREFIX: &str = "zzz_session_";

/// The session cookie name for a daemon listening on `port`:
/// `zzz_session_<port>`.
///
/// Browsers scope cookies by host, not port, so with one fixed name every zzz
/// daemon on `localhost` — the installed one, `cargo xtask dev`, a test
/// binary — would read and overwrite the same cookie, and logging into one
/// would log you out of the others. A per-port name keeps each daemon's
/// session its own.
#[must_use]
pub fn session_cookie_name_for_port(port: u16) -> String {
    format!("{SESSION_COOKIE_NAME_PREFIX}{port}")
}

/// Cap on one JSON-RPC message, in bytes, on both transports.
///
/// It's the `/api/rpc` request body limit and the `/api/ws` inbound message
/// (and frame) limit — one value so the two transports can't drift. The
/// frontend's twin of the same name
/// (`src/lib/rpc_message_limit.ts`) refuses a larger request before sending,
/// since an oversized WebSocket message closes the socket rather than getting
/// an error reply; the cross-backend filesystem suite pins the two together.
///
/// 16 MiB, above the spine's 1 MiB default, so saving a file the filer loads
/// (at most 4 MiB) fits in all but pathological cases — JSON escapes a
/// control character to 6 bytes, so a file dense with them can exceed the
/// cap, and the client guard then refuses the save cleanly — and so a long
/// `completion_create` history fits.
///
/// **Memory.** The larger cap is not confined to authenticated callers on
/// HTTP: `/api/rpc` buffers and parses the body before auth, and `ping` is
/// public, so any local process can make zzzd buffer up to 16 MiB per
/// concurrent request. On the WebSocket (authenticated at upgrade) each
/// socket can have up to 128 dispatches in flight, a ceiling of about 2 GiB
/// of buffered messages per authenticated socket. Acceptable only because
/// the bind is loopback-only and zzz is single-operator (see the root
/// CLAUDE.md § Security posture); the account, bootstrap, and signup routes
/// keep the 1 MiB default.
pub const RPC_MESSAGE_MAX_BYTES: usize = 16 * 1024 * 1024;

/// zzz's concrete instantiation of [`fuz_actions::ExtraActionSpecsFactory`]
/// over [`handlers::App`] — extra specs folded in after the standard zzz set.
///
/// Production passes `None`; the `testing_zzz_server` binary passes `Some(_)`
/// to inject `_testing_reset`, closing over `fuz_testing` types in its own
/// process so the production graph stays clean.
pub type ExtraActionSpecsFactory = fuz_actions::ExtraActionSpecsFactory<handlers::App>;

/// zzz's concrete instantiation of [`fuz_actions::PreMigrationHook`].
///
/// Production passes `None`; the `testing_zzz_server` binary passes `Some(_)`
/// to fire `fuz_testing::reset_db_on_startup_if_env_set` (env-gated schema
/// wipe). Errors surface as [`ServerError::Database`].
pub type PreMigrationHook = fuz_actions::PreMigrationHook<ServerError>;

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
    /// Default bind address when neither `--port` nor `ZZZ_PORT` supplies a
    /// port. The host stays this address's host (loopback); only the port is
    /// overridable. Production: [`DEFAULT_ADDR`] (`127.0.0.1:4460`). Test
    /// binary: `127.0.0.1:4462` so the two can run side-by-side.
    pub default_addr: SocketAddr,
    /// Bounds the graceful-shutdown connection drain. Pass
    /// [`fuz_http::DEFAULT_DRAIN_TIMEOUT`] unless a consumer needs a different
    /// bound — the other spine consumers all pass that shared default.
    pub drain_timeout: std::time::Duration,
    /// Override the `ZZZ_ENABLE_TEST_ACTIONS` env-parsed flag.
    /// Production: `false`. Test binary: `true` so the `_testing_*`
    /// registry branch fires regardless of operator env.
    pub force_test_actions: bool,
    /// Whether the spine's rate limiters are built.
    /// Production: [`fuz_auth::RateLimiterMode::Enforced`] — always on,
    /// matching `fuz_forge_server` + `mageguild_server` and the fuz defaults.
    /// Test binary: `DisabledForTesting` so the cross-backend auth suite's
    /// repeated logins don't trip the bucket.
    pub rate_limiters: fuz_auth::RateLimiterMode,
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
    /// Daemon-token state for `X-Daemon-Token` auth. Production: `None`.
    /// Test binary: `Some(_)` so `_testing_reset` resolves the keeper.
    ///
    /// zzz mounts **no** daemon-token credential in production. Nothing sends
    /// the header — the browser UI authenticates with session cookies, and a
    /// browser request carries `Origin`/`Referer`, which
    /// `fuz_auth::is_browser_context` refuses for this credential anyway — so
    /// the only effect of mounting it was writing a keeper-grade secret into
    /// `<zzz_dir>/run/daemon_token` on a 30-second timer. Its producer
    /// (`fuz_testing::init_daemon_token`) is confined to `fuz_testing` by dep
    /// graph, so this crate cannot construct one even by mistake.
    pub daemon_token_state: Option<fuz_auth::SharedDaemonTokenState>,
}

impl std::fmt::Debug for RunAppOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunAppOptions")
            .field("default_addr", &self.default_addr)
            .field("drain_timeout", &self.drain_timeout)
            .field("force_test_actions", &self.force_test_actions)
            .field("rate_limiters", &self.rate_limiters)
            .finish_non_exhaustive()
    }
}

/// Run the `zzz_server` lifecycle to completion.
///
/// Parses CLI args + env, opens the DB pool, runs migrations, builds
/// every spine subsystem, mounts the routes, binds the listener, and
/// blocks on graceful shutdown (Ctrl-C / SIGTERM): every live WebSocket is
/// closed with 1001 (going away) and every audit stream ended, then in-flight
/// requests drain. Returns once all connections have closed (or at the drain
/// timeout) and jobs and PTYs are torn down.
///
/// The spine's auth cleanup ([`fuz_auth::spawn_auth_cleanup`]) runs beside
/// the server — expired sessions deleted and the connections they opened
/// closed, expired role-grant offers audited once — a pass once the listener
/// is bound, then one every [`fuz_auth::DEFAULT_AUTH_CLEANUP_INTERVAL`], so a
/// socket or audit stream outlives its session's expiry by at most one
/// interval. It stops when shutdown begins and is joined before this returns.
///
/// Every configuration knob lives on [`RunAppOptions`]; everything
/// not explicitly named there flows from CLI args or the process
/// environment.
///
/// # Errors
///
/// Returns [`ServerError`] for env/config validation failures, DB
/// connectivity / migration failures, listener bind failures, and serve
/// errors (`fuz_http::serve_with_shutdown` returns none in practice).
pub async fn run_app(options: RunAppOptions) -> Result<(), ServerError> {
    let RunAppOptions {
        password_hasher,
        default_addr,
        drain_timeout,
        force_test_actions,
        rate_limiters,
        extra_action_specs_factory,
        pre_migration_hook,
        daemon_token_state: spine_daemon_token,
    } = options;
    let mut config = parse_config(default_addr)?;
    if force_test_actions {
        config.enable_test_actions = true;
    }
    // The spine's route states take the cookie name as `&'static str`; the
    // name is fixed for the life of the process, so leak its one allocation.
    let session_cookie_name: &'static str =
        session_cookie_name_for_port(config.bind_addr.port()).leak();

    // Database — required. Spine `fuz_db::create_pool` builds the
    // deadpool-postgres pool; `fuz_db::run_migrations` runs the auth DDL
    // tracked under the reserved `fuz_auth` namespace.
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
    // (constructed below as `spine_keyring`) is the sole keyring on `App`.
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

    let scoped_dir_strings = std::mem::take(&mut config.scoped_dirs);

    // Permanent roots: zzz_dir first, then scoped_dirs — canonicalized paths,
    // not raw config paths
    let mut scoped_fs_paths: Vec<PathBuf> = Vec::with_capacity(1 + scoped_dir_strings.len());
    scoped_fs_paths.push(PathBuf::from(&config.zzz_dir));
    scoped_fs_paths.extend(scoped_dir_strings.iter().map(PathBuf::from));
    let scoped_fs = scoped_fs::ScopedFs::new(scoped_fs_paths);

    // AI providers — read API keys from env (empty counts as unset),
    // construct ProviderManager
    let anthropic_key = provider::read_api_key_env("SECRET_ANTHROPIC_API_KEY");
    let openai_key = provider::read_api_key_env("SECRET_OPENAI_API_KEY");
    let google_key = provider::read_api_key_env("SECRET_GOOGLE_API_KEY");
    let mut provider_manager = provider::ProviderManager::new();
    provider_manager.add(provider::Provider::Anthropic(
        provider::anthropic::AnthropicProvider::new(anthropic_key.as_deref()),
    ));
    provider_manager.add(provider::Provider::OpenAi(
        provider::openai::OpenAiProvider::new(openai_key.as_deref()),
    ));
    provider_manager.add(provider::Provider::Gemini(
        provider::gemini::GeminiProvider::new(google_key.as_deref()),
    ));

    if config.enable_test_actions {
        tracing::info!(
            "test actions enabled — `_testing_*` methods registered on live dispatchers"
        );
    }

    // Per-IP + per-account rate limiters on `/login` and `/password`, always
    // on in production — matching `fuz_forge_server` + `mageguild_server` and
    // the fuz defaults (`DEFAULT_LOGIN_IP_RATE_LIMIT` 5/15min,
    // `DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT` 10/30min). The test binary passes
    // `RateLimiterMode::DisabledForTesting` so the cross-backend auth suite's
    // repeated logins don't trip the bucket. Spine `fuz_auth::RateLimiter`
    // (parking_lot, sync).
    let login_ip_rate_limiter = rate_limiters.limiter(fuz_auth::DEFAULT_LOGIN_IP_RATE_LIMIT);
    let login_account_rate_limiter =
        rate_limiters.limiter(fuz_auth::DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT);

    // Per-account rate limiter shared across admin RPC methods and the
    // role-grant-offer surface. Mirrors fuz_app's
    // `default_action_account_rate_limit` (1200 / 15min per actor) —
    // bounds paginated admin-side scraping pressure per the TS posture in
    // `admin_action_specs.ts` (every admin spec but the read-only
    // `app_settings_get` carries `rate_limit: 'account'`) and offer-spam /
    // account-existence-oracle pressure on `role_grant_offer_create`, whose spec in
    // `role_grant_offer_action_specs.ts` declares the same. Always-on (no env
    // gate); the production cap sits far above the cross-backend test
    // suite's request volume.
    //
    // One pair serves every surface that consults it: the spine's auth spec
    // set charges these buckets inside its handler closures, and the
    // dispatcher charges the same ones for protocol + zzz-owned specs via
    // `ActionSpec::with_rate_limit`, across both the HTTP RPC and WS
    // transports. Sharing is the contract rather than a convenience — fuz_app
    // threads one `action_account_rate_limiter` through `create_app_server`
    // into both transports, so a second instance hands a caller two
    // independent budgets where the TS spine gives one.
    //
    // The IP axis is live: `peer/ping` comes in with `PROTOCOL_ACTION_SPECS`
    // declaring `RateLimitClass::Ip`, so every anonymous call to it spends the
    // IP bucket at the shared spine default (600 / 15 min). zzz is local-first
    // on a loopback-fixed bind, so that budget is per-machine and the axis
    // carries little signal until a zzz grows a reverse proxy or a second
    // account. No spine auth entry declares an IP class, so the auth surface
    // never charges it; passing it there is what makes a future entry that
    // opts in share this bucket instead of getting its own.
    //
    // No zzz-owned spec declares a class, so beyond the auth surface's account
    // charges these sit ready rather than active — the point is that a future
    // `.with_rate_limit(...)` gets a real limiter instead of silently
    // no-op'ing against a `None` axis.
    let action_account_rate_limiter =
        rate_limiters.limiter(fuz_auth::DEFAULT_ACTION_ACCOUNT_RATE_LIMIT);
    let action_ip_rate_limiter = rate_limiters.limiter(fuz_auth::DEFAULT_ACTION_IP_RATE_LIMIT);

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
    // leaving a hole. Sole trusted-proxy state on `App`.
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
    // Refuse to boot (fail loud) on an absent / all-empty allowlist — an empty
    // list silently fails *open* (allow-all), disabling the Origin gate on
    // every REST + RPC + WS handler; see `fuz_http::require_non_empty_origins`.
    // Mirrors the TS `validate_server_env` contract.
    let spine_allowed_origins = Arc::new(
        fuz_http::require_non_empty_origins(config.allowed_origins.as_deref())
            .map_err(|e| ServerError::Config(e.to_string()))?,
    );
    let bootstrap_available_atomic =
        Arc::new(std::sync::atomic::AtomicBool::new(bootstrap_available));
    // Both transports: a revocation handler's direct close must reach the
    // audit streams too, since the SSE listener only fires on a written audit
    // row and the REST `/logout` / `/password` audit write is fail-open.
    let socket_revoker = fuz_realtime::RealtimeRevoker::socket_revoker(&realtime, &audit_sse);
    // Spine daemon-token state — **injected, never constructed here** (see
    // `RunAppOptions::daemon_token_state`). Production is `None`, so the
    // daemon-token leg of `resolve_auth_from_headers` is unreachable and no
    // credential file is written.
    if let Some(ref state) = spine_daemon_token {
        fuz_auth::resolve_keeper_into(state, &pool).await;
    }
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
        session_cookie_name,
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
                    Arc::new(fuz_auth::DaemonTokenKeeperResolved::new(Arc::clone(state)));
                cb
            }),
        }),
        keyring: Arc::clone(&spine_keyring),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        session_cookie_name,
    };

    // Signup route: mounted on the production server so the
    // cross-process integration harness (testing_zzz_server reuses
    // run_app) can mint per-test accounts through production RPC.
    // Open_signup defaults to false in app_settings, so the route is
    // invite-gated at runtime unless an admin flips the flag. The
    // signup handler loads app_settings per request; switch to a
    // cached Arc<RwLock<AppSettings>> shared with the future admin
    // update handler when that lands on Rust.
    let signup_route_state = fuz_auth::SignupRouteState {
        options: Arc::new(fuz_auth::SignupOptions {
            pool: pool.clone(),
            password_hasher: Arc::clone(&spine_password_hasher),
            audit: Arc::clone(&spine_audit_emitter),
            // Own instances, not the login buckets: a signup flood must not
            // spend the budget bounding credential guessing, and vice versa.
            // The spine has no signup-specific defaults — the login ones are
            // the right shape and the TS twin reuses them the same way.
            signup_ip_rate_limiter: rate_limiters.limiter(fuz_auth::DEFAULT_LOGIN_IP_RATE_LIMIT),
            signup_account_rate_limiter: rate_limiters
                .limiter(fuz_auth::DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT),
            signup_fail_floor_ms: fuz_auth::DEFAULT_SIGNUP_FAIL_FLOOR_MS,
            signup_fail_jitter_ms: fuz_auth::DEFAULT_SIGNUP_FAIL_JITTER_MS,
        }),
        keyring: Arc::clone(&spine_keyring),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        session_cookie_name,
    };

    let mut app = handlers::App::new(
        pool,
        scoped_fs,
        config.zzz_dir,
        scoped_dir_strings,
        provider_manager,
        config.enable_test_actions,
        Arc::clone(&realtime),
    );
    app.tools = config.tools;
    let app_state = Arc::new(app);

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
    // ## Layering with handler-side close
    //
    // Revocation-emitting handlers close sockets themselves too: the RPC
    // ones (`account_session_revoke`, `account_session_revoke_all`,
    // `account_token_revoke`, the admin revoke-alls, account delete/purge)
    // once their transaction commits — never before, or a client told
    // "revoked" could recheck its session before the deletion is visible —
    // and the REST ones (`/api/account/logout`, `/api/account/password`)
    // inline, on their autocommit client. The listeners run on the
    // materialized row and call the same idempotent `close_sockets_for_*`
    // a second time; the duplication is intentional defense-in-depth.
    fuz_auth::register_socket_revocation_listeners(&spine_audit_emitter, &socket_revoker);
    // A deleted or purged account's terminals end with its sockets.
    handlers::terminal::register_account_removal_listener(&spine_audit_emitter, &app_state);

    // SSE half of the audit fan-out — every audit row becomes one `data:`
    // frame on each open `/api/admin/audit/stream` subscription, and a
    // successful account-wide revocation drops that account's streams. Mirrors
    // `fuz_app`'s `create_audit_log_sse`; the socket-revocation listeners above
    // close through the same fan-out revoker, so they reach these streams too.
    fuz_realtime::register_audit_sse_listener(&spine_audit_emitter, &audit_sse);

    // Compile the spine action registry — must run after `Arc<App>` is
    // constructed because the zzz-specific spec builders capture
    // `Arc::clone(&app_state)` into per-spec handler closures.
    //
    // Composition order: protocol (heartbeat + peer/ping), then
    // `fuz_auth` placeholder adapters (account + admin self-service),
    // then zzz-specific specs (`core`, `workspace`, `filesystem`,
    // `terminal`, `provider`).
    let mut all_specs: Vec<fuz_actions::ActionSpec> = fuz_actions::PROTOCOL_ACTION_SPECS();
    all_specs.extend(fuz_actions::auth_adapter::build_auth_spec_set(
        Arc::clone(&spine_audit_emitter),
        Arc::clone(&socket_revoker),
        action_account_rate_limiter.clone(),
        action_ip_rate_limiter.clone(),
        Arc::new(fuz_auth::AdminOfferAuthorize),
        Arc::new(fuz_auth::RoleRegistry::default()),
    ));
    all_specs.extend(zzz_action_specs::build_zzz_owned_specs(&app_state));
    if app_state.enable_test_actions {
        all_specs.extend(zzz_action_specs::build_testing_specs(Arc::clone(
            &app_state,
        )));
    }
    if let Some(factory) = extra_action_specs_factory {
        let runtime = fuz_actions::ExtraActionSpecsRuntime {
            password_hasher: Arc::clone(&spine_password_hasher),
            keyring: Arc::clone(&spine_keyring),
            daemon_token_state: spine_daemon_token.clone(),
            session_cookie_name,
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

    // Start the permanent file watchers at startup: zzz_dir, then each of
    // scoped_dirs. zzz_dir uses FilerConfig::zzz_dir() (no ignored dirs);
    // scoped_dirs use workspace config (ignoring zzz_dir when nested inside).
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
                filer::FilerConfig::workspace(dir, &app_state.zzz_dir),
                filer::FilerLifetime::Permanent,
            )
            .await
        {
            Ok(_) => tracing::info!(path = %dir, "started scoped_dir filer"),
            Err(e) => tracing::warn!(path = %dir, error = %e, "failed to start scoped_dir filer"),
        }
    }

    let app_state_for_shutdown = Arc::clone(&app_state);

    // -- Spine RPC + WS routes -------------------------------------
    //
    // The spine `ActionRegistry` dispatcher is mounted at `/api/rpc`
    // and the spine WS handler at `/api/ws` — the single namespace
    // per the ecosystem's pre-stable posture (no `/v2` suffix, no
    // compat shim, no deprecation period). The boot-compiled
    // `ActionRegistry` (protocol + auth_adapter + zzz-specific
    // specs) is the sole dispatcher for `/api/rpc` and `/api/ws`
    // traffic.
    //
    // `app.broadcast` is shimmed onto `App.realtime`
    // (see `handlers/mod.rs`).
    //
    // Middleware: every spine router below carries its own
    // `fuz_http::client_ip_middleware` layer over `spine_trusted_proxies` —
    // RPC, WS, the three `/api/account/*` REST routers, and the admin audit
    // stream. The layer is mounted unconditionally, including when
    // `ZZZ_TRUSTED_PROXIES` is unset and the set is empty: the middleware
    // always populates `ClientIp`, and an empty set is the *more* conservative
    // configuration, not a disabled one — every connection then fails
    // `is_trusted_ip`, so the spoofable `X-Forwarded-For` is ignored and the
    // real TCP peer is recorded. Omitting the layer is what would degrade
    // behavior: `ClientIp` would be absent, so the IP-keyed limiters
    // (`login_ip_rate_limiter`, `signup_ip_rate_limiter`,
    // `action_ip_rate_limiter`) would bucket every caller under one shared
    // `fuz_http::UNRESOLVED_CLIENT_IP` key, and each bearer touch of
    // `api_token` would record that same sentinel as `last_used_ip` instead of
    // the real address.
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
        session_cookie_name,
        account_rate_limiter: action_account_rate_limiter.clone(),
        ip_rate_limiter: action_ip_rate_limiter.clone(),
    };
    let spine_rpc_router = fuz_actions::create_rpc_router(spine_rpc_state)
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ))
        // `RPC_MESSAGE_MAX_BYTES` (16 MiB) request-body cap, shared with the
        // `/api/ws` message cap below; larger and binary content goes over
        // the file byte routes (`file_bytes`). The POST handler reads
        // the body through axum's `Bytes` extractor, which applies axum's own
        // 2 MiB `DefaultBodyLimit` — raised to the same cap, so the tower
        // limit is the one that decides.
        .layer(axum::extract::DefaultBodyLimit::max(RPC_MESSAGE_MAX_BYTES))
        .layer(fuz_http::body_limit_layer(RPC_MESSAGE_MAX_BYTES));

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
        session_cookie_name,
        account_rate_limiter: action_account_rate_limiter,
        ip_rate_limiter: action_ip_rate_limiter,
        // No role gate: zzz is single-operator by configuration
        // (`open_signup` defaults false, so every account is operator-minted)
        // and so every authenticated account is that operator. That default is
        // the weaker half of the argument, though — flip it and the gate still
        // wouldn't help, because the socket adds no privilege the account
        // doesn't already hold. The RPC surface is itself wide open by
        // recorded decision: the `any_credential_surface` census in
        // `crate::zzz_action_specs` documents that every zzz-owned spec is
        // `CredentialGate::Any`, mutations included, so any credential that
        // could open a socket can already `terminal_create` and read the same
        // stream over RPC. A role gate here would narrow nothing while that
        // posture stands; it becomes the right move in the same breath as
        // narrowing that census (a second account, a reverse proxy). Zzz has
        // no TS server to twin against (Rust-only), so this preserves the
        // shipped behavior exactly.
        required_roles: Vec::new(),
    };
    // Same cap as the `/api/rpc` body (`RPC_MESSAGE_MAX_BYTES`); an
    // oversized message closes the socket.
    let spine_ws_router =
        fuz_actions::register_action_ws_with_message_limit(spine_ws_state, RPC_MESSAGE_MAX_BYTES)
            .layer(axum::middleware::from_fn_with_state(
                Arc::clone(&spine_trusted_proxies),
                fuz_http::client_ip_middleware,
            ));

    // Spine account REST router: mounts `/status`, `/login`, `/logout`,
    // `/password` under `/api/account`.
    // `fuz_http::client_ip_middleware` is wrapped on the router so
    // `Extension<fuz_http::ClientIp>` is populated for every account
    // route (rate-limit keys + audit_log.ip).
    let spine_account_router = fuz_auth::account_router(account_route_state)
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ))
        .layer(fuz_http::body_limit_layer(
            fuz_http::DEFAULT_BODY_LIMIT_BYTES,
        ));

    // Spine bootstrap router: mounts `/bootstrap` at the router root, so
    // nesting under `/api/account` produces `/api/account/bootstrap`.
    let spine_bootstrap_router =
        fuz_auth::bootstrap_routes::bootstrap_router(bootstrap_route_state)
            .layer(axum::middleware::from_fn_with_state(
                Arc::clone(&spine_trusted_proxies),
                fuz_http::client_ip_middleware,
            ))
            .layer(fuz_http::body_limit_layer(
                fuz_http::DEFAULT_BODY_LIMIT_BYTES,
            ));

    // Spine signup router: mounts `/signup` at the router root, so
    // nesting under `/api/account` produces `/api/account/signup`.
    // Same client_ip_middleware layer so audit_log.ip on success +
    // failure rows reflects the resolved client IP rather than the
    // proxy peer.
    let spine_signup_router = fuz_auth::signup_routes::signup_router(signup_route_state)
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ))
        .layer(fuz_http::body_limit_layer(
            fuz_http::DEFAULT_BODY_LIMIT_BYTES,
        ));

    // Spine audit-log SSE stream: `GET /api/admin/audit/stream` — the shared
    // `fuz_realtime::audit_stream_router`, mounted with the spine defaults
    // (admin role, session-only credential gate, and a close-on-revoke keyed
    // by each audit event's declared `RevocationScope`), wired to the
    // `audit_sse` registry the listener above fans rows into. Carries its own
    // `origin_layer` so the origin allowlist gates it like every other zzz
    // handler, and the same `client_ip_middleware` as every other spine
    // router: it writes no `audit_log.ip`, but credential resolution runs the
    // bearer leg *before* the channel gate refuses it, and that leg's
    // `api_token` touch writes `last_used_ip = $2` unconditionally — the
    // statement has no "leave the column alone" form — so without the layer
    // every bearer attempt on the stream would stamp the
    // `fuz_http::UNRESOLVED_CLIENT_IP` sentinel over the real address.
    let mut audit_stream_state = fuz_realtime::AuditStreamRouteState::new(
        app_state.db_pool.clone(),
        Arc::clone(&spine_keyring),
        spine_daemon_token.clone(),
        Arc::clone(&audit_sse),
    );
    audit_stream_state.session_cookie_name = session_cookie_name;
    let spine_audit_stream_router = fuz_realtime::audit_stream_router(audit_stream_state)
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&spine_allowed_origins),
            fuz_http::origin_layer,
        ));

    // File byte routes (`file_bytes::FILE_BYTES_PATH`): hand-written, outside
    // the action system, so they carry the gates the RPC router gets from the
    // spine — the Origin allowlist, the client-IP middleware (the bearer
    // leg's `api_token` touch records it), and a body cap. The handlers
    // authenticate before they read a body.
    let file_bytes_router = file_bytes::file_bytes_router(file_bytes::FileBytesRouteState {
        app: Arc::clone(&app_state),
        keyring: Arc::clone(&spine_keyring),
        daemon_token_state: spine_daemon_token.clone(),
        session_cookie_name,
    })
    .layer(axum::middleware::from_fn_with_state(
        Arc::clone(&spine_trusted_proxies),
        fuz_http::client_ip_middleware,
    ))
    .layer(axum::middleware::from_fn_with_state(
        Arc::clone(&spine_allowed_origins),
        fuz_http::origin_layer,
    ))
    .layer(fuz_http::body_limit_layer(
        file_bytes::FILE_BYTES_MAX_BODY_BYTES,
    ));

    // A new top-level backend route (beside `/api` and `/health`) must also be
    // added to `static_files::BACKEND_PATH_PREFIXES`, or its unknown subpaths
    // get the SPA shell.
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
        .merge(spine_audit_stream_router)
        // File byte routes — absolute path too.
        .merge(file_bytes_router);

    // The built frontend, as the fallback behind every backend route: exact
    // files, then prerendered pages, then the SPA shell — see `static_files`.
    // Without a static dir (dev, where Vite serves the frontend) unmatched
    // paths get axum's empty 404.
    if let Some(ref dir) = config.static_dir {
        tracing::info!(dir = %dir.display(), "serving static files");
        app = app.fallback_service(static_files::static_router(dir));
    }

    let addr = config.bind_addr;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|source| ServerError::Bind { addr, source })?;

    tracing::info!("zzz_server listening on {addr}");

    // Signal handling, the shutdown close of every live WebSocket (a 1001
    // close) and audit stream, and the graceful drain come from the spine
    // (`fuz_http::lifecycle`) — the SIGINT/SIGTERM → `CancellationToken`
    // → close → drain dance is shared with the other spine consumers. zzz's
    // own teardown (the cleanup task, jobs, PTY cleanup) runs after the drain
    // returns.
    let shutdown = fuz_http::shutdown_token();

    // Migrations have run, so the cleanup's startup pass can start now. It
    // audits through the spine emitter, so expiry events reach the admin
    // audit streams, and closes each swept session's connections through the
    // revoker the revocation handlers hold (WS sockets and audit streams).
    let auth_cleanup = fuz_auth::spawn_auth_cleanup(
        fuz_auth::AuthCleanupOptions {
            pool: app_state_for_shutdown.db_pool.clone(),
            audit: spine_audit_emitter,
            socket_revoker: Arc::clone(&socket_revoker),
        },
        fuz_auth::DEFAULT_AUTH_CLEANUP_INTERVAL,
        shutdown.clone(),
    );

    // The same revoker reaches both live transports (the `/api/ws` registry
    // and the audit-stream SSE registry), so shutdown closes them through it.
    let served = fuz_http::serve_with_shutdown(
        listener,
        app,
        shutdown.clone(),
        socket_revoker.as_ref(),
        drain_timeout,
    )
    .await;

    // `serve_with_shutdown` returns only once the token has fired, so the
    // cleanup task is already stopping.
    if let Err(e) = auth_cleanup.await {
        tracing::warn!(error = %e, "the auth cleanup task failed");
    }

    // Stop jobs (killing their tool processes) and clean up spawned terminal
    // processes before exiting, ahead of the `?` on `served`
    app_state_for_shutdown.job_manager.cancel_all().await;
    app_state_for_shutdown.pty_manager.kill_all().await;
    served.map_err(ServerError::Serve)?;

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
    pub bind_addr: SocketAddr,
    pub static_dir: Option<PathBuf>,
    pub database_url: String,
    pub secret_cookie_keys: String,
    pub bootstrap_token_path: Option<String>,
    pub allowed_origins: Option<String>,
    /// `PUBLIC_ZZZ_SCOPED_DIRS`, resolved (canonical, trailing `/`) and
    /// checked by [`check_scoped_dirs`].
    pub scoped_dirs: Vec<String>,
    pub zzz_dir: String,
    /// Register `_testing_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave unset.
    pub enable_test_actions: bool,
    /// Comma-separated trusted-proxy entries (IPs and CIDR ranges).
    /// Unset/empty → no XFF trust → `client_ip` falls back to the TCP
    /// peer IP on every request. Set when running behind a reverse
    /// proxy so login rate-limit keys and `audit_log.ip` reflect the
    /// originating client. Parsed eagerly in `run()`; invalid entries
    /// fail startup.
    pub trusted_proxies: Option<String>,
    /// The local tools found at boot (`ffmpeg`, whisper.cpp and its model).
    pub tools: tool::Tools,
}

/// Hand-written so the secrets never reach a log line: `database_url` (which
/// can carry a password) and `secret_cookie_keys` print as `[redacted]`.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind_addr", &self.bind_addr)
            .field("static_dir", &self.static_dir)
            .field("database_url", &"[redacted]")
            .field("secret_cookie_keys", &"[redacted]")
            .field("bootstrap_token_path", &self.bootstrap_token_path)
            .field("allowed_origins", &self.allowed_origins)
            .field("scoped_dirs", &self.scoped_dirs)
            .field("zzz_dir", &self.zzz_dir)
            .field("enable_test_actions", &self.enable_test_actions)
            .field("trusted_proxies", &self.trusted_proxies)
            .field("tools", &self.tools)
            .finish()
    }
}

/// The app directory when `PUBLIC_ZZZ_DIR` is unset or empty, relative to
/// the working directory.
pub const DEFAULT_ZZZ_DIR: &str = ".zzz/";

/// An env var's value, `None` when unset.
///
/// # Errors
///
/// [`ServerError::Config`] naming the variable when its value isn't valid
/// UTF-8 — never read as unset, which would silently drop a configured path
/// (e.g. every `PUBLIC_ZZZ_SCOPED_DIRS` entry).
fn env_var_utf8(name: &str) -> Result<Option<String>, ServerError> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(ServerError::Config(format!("{name} is not valid UTF-8")))
        }
    }
}

/// An env var's value, with unset, empty, and whitespace-only all reading as
/// unset — so an exported-but-empty path var falls back to its default
/// rather than resolving to the working directory or `/`.
///
/// # Errors
///
/// As [`env_var_utf8`].
fn env_non_empty(name: &str) -> Result<Option<String>, ServerError> {
    Ok(non_empty(env_var_utf8(name)?))
}

/// Parse a port from `--port` or `ZZZ_PORT` (named by `source`).
///
/// # Errors
///
/// [`ServerError::Config`] for anything but an integer in `1..=65535` — an
/// invalid port refuses to boot rather than falling back to the default.
fn parse_port(source: &str, value: &str) -> Result<u16, ServerError> {
    value
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|&port| port != 0)
        .ok_or_else(|| {
            ServerError::Config(format!(
                "invalid {source} {value:?}: expected a port in 1..=65535"
            ))
        })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Resolve a path to an absolute, canonical, normalized directory string
/// with trailing `/`. Tries `canonicalize` (resolves symlinks, requires path
/// to exist), falls back to `absolute` (no I/O). Used for the scoped dirs and,
/// through [`ensure_app_dir`], the app directory.
///
/// # Errors
///
/// Returns [`ServerError::Config`] for an empty path or one that can't be
/// made absolute — never a silent fallback, which would collapse to `/` (a
/// permanent scoped root, and a filer, over the whole filesystem).
fn resolve_dir(path: &Path) -> Result<String, ServerError> {
    if path.as_os_str().is_empty() {
        return Err(ServerError::Config("empty directory path".to_owned()));
    }
    let resolved = std::fs::canonicalize(path)
        .or_else(|_| std::path::absolute(path))
        .map_err(|e| ServerError::Config(format!("can't resolve {}: {e}", path.display())))?;
    let mut s = resolved
        .to_str()
        .ok_or_else(|| {
            ServerError::Config(format!(
                "{} resolves to a path that isn't valid UTF-8: {}",
                path.display(),
                resolved.display()
            ))
        })?
        .to_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    Ok(s)
}

/// The app directory: `PUBLIC_ZZZ_DIR` (unset or empty → [`DEFAULT_ZZZ_DIR`])
/// through [`ensure_app_dir`].
///
/// Public so `testing_zzz_server` places its
/// daemon-token file exactly where [`run_app`] resolves the app dir — the
/// cross-process harness reads `<zzz_dir>/run/daemon_token`, so the two must
/// not drift.
///
/// # Errors
///
/// Returns [`ServerError::Config`] when the directory can't be created or
/// resolved, or is the working directory (see [`check_app_dir_is_not_cwd`]).
pub fn ensure_zzz_dir_from_env() -> Result<String, ServerError> {
    let raw = env_non_empty("PUBLIC_ZZZ_DIR")?.unwrap_or_else(|| DEFAULT_ZZZ_DIR.to_owned());
    let zzz_dir = ensure_app_dir(Path::new(&raw))?;
    // an unreadable working directory can't equal the app dir, which resolved
    if let Ok(cwd) = std::env::current_dir() {
        check_app_dir_is_not_cwd(&zzz_dir, &cwd)?;
    }
    Ok(zzz_dir)
}

/// Refuse an app dir that is the daemon's working directory — under the CLI
/// that's the daemon home `~/.zzz/`, whose `.env` and `bootstrap_token` the
/// app dir's filer (which skips `.zzz` only below its root) would index and
/// broadcast. Any other directory is fine, like the default `.zzz`.
///
/// This catches the daemon home only when it's the working directory: an
/// explicit `PUBLIC_ZZZ_DIR` naming `~/.zzz` for a daemon run elsewhere makes
/// the home the app dir all the same, indexing its `.env` — don't.
///
/// # Errors
///
/// [`ServerError::Config`] naming both when `zzz_dir` (resolved) is `cwd`.
fn check_app_dir_is_not_cwd(zzz_dir: &str, cwd: &Path) -> Result<(), ServerError> {
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    if Path::new(zzz_dir) == cwd {
        return Err(ServerError::Config(format!(
            "PUBLIC_ZZZ_DIR resolves to the daemon's working directory {zzz_dir}: the app dir must not be the working directory itself (the default `{DEFAULT_ZZZ_DIR}` is a subdirectory of it), since the working directory holds the daemon's own files (the CLI's `.env` and `bootstrap_token`)"
        )));
    }
    Ok(())
}

/// Refuse a scoped dir that is, or is inside, a `.zzz` directory other than
/// the app dir ([`filer::is_in_zzz_home`]) — its filer would refuse to start
/// (so nothing would be indexed) while it stayed a writable `ScopedFs` root,
/// and `.zzz` directories hold zzz's own files (the CLI's `.env` and
/// `bootstrap_token`). Paths are the resolved forms.
///
/// # Errors
///
/// [`ServerError::Config`] naming `PUBLIC_ZZZ_SCOPED_DIRS` and the first
/// such dir.
fn check_scoped_dirs(scoped_dirs: &[String], zzz_dir: &str) -> Result<(), ServerError> {
    let app_dir = Path::new(zzz_dir);
    scoped_dirs
        .iter()
        .find(|dir| filer::is_in_zzz_home(Path::new(dir), app_dir))
        .map_or(Ok(()), |dir| {
            Err(ServerError::Config(format!(
                "PUBLIC_ZZZ_SCOPED_DIRS entry {dir} is in a .zzz directory other than the app dir {zzz_dir}: .zzz directories hold zzz's own files (secrets, tokens) and can't be scoped"
            )))
        })
}

/// Create the app directory `path` if it doesn't exist, then
/// [`resolve_dir`] it.
///
/// Missing parents are created too, all mode `0700` — the app dir holds
/// runtime state and tokens. Creating first means the result is always
/// canonical, never the `absolute` fallback a missing directory gets.
///
/// # Errors
///
/// Returns [`ServerError::Config`] naming the path when it can't be created
/// (or exists but isn't a directory) or can't be resolved.
fn ensure_app_dir(path: &Path) -> Result<String, ServerError> {
    if path.as_os_str().is_empty() {
        return Err(ServerError::Config("empty directory path".to_owned()));
    }
    fuz_sys::fs::create_dir_all_mode(path, 0o700).map_err(|e| {
        ServerError::Config(format!(
            "can't create app directory {}: {e}",
            path.display()
        ))
    })?;
    resolve_dir(path)
}

/// The daemon's options, printed after the binary's name for `-h` /
/// `--help` ([`report_run_result`]) and quoted by every argument error —
/// shared by `zzzd` and `testing_zzzd`, so it names neither.
pub const OPTIONS: &str = "[--port <port>] [--static-dir <dir>]";

/// Validate the process's command line without acting on it — for a binary
/// that has side effects to do before [`run_app`] (which parses it again), so
/// `--help` or a bad argument exits before any of them.
///
/// # Errors
///
/// As [`parse_args`], including [`ServerError::HelpRequested`].
pub fn check_cli_args() -> Result<(), ServerError> {
    parse_args(std::env::args_os().skip(1)).map(|_| ())
}

/// The process exit for a [`run_app`] (or [`check_cli_args`]) result of the
/// binary named `program`.
///
/// [`ServerError::HelpRequested`] prints `usage: <program> <OPTIONS>` to
/// stdout and exits 0; any other error prints `<program>: <error>` to stderr
/// (e.g. `zzzd: configuration error: …` — the variant names the kind) and
/// exits 1 — synchronously, not through the non-blocking logger, whose
/// buffered lines a `std::process::exit` would drop.
#[must_use]
pub fn report_run_result(result: Result<(), ServerError>, program: &str) -> std::process::ExitCode {
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(ServerError::HelpRequested) => {
            println!("usage: {program} {OPTIONS}");
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{program}: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}

/// Flags parsed from the command line; unset ones fall back to env vars.
#[derive(Debug, Default, PartialEq, Eq)]
struct CliArgs {
    port: Option<u16>,
    static_dir: Option<PathBuf>,
}

/// Parse `zzzd`'s arguments (without the program name). Each flag takes its
/// value as the next argument or after `=` (`--port 4460`, `--port=4460`);
/// a repeated flag's last value wins.
///
/// Read as `OsString`s, so a non-UTF-8 argument never panics: a
/// `--static-dir` path may be any bytes, and anything else that isn't UTF-8
/// is an error.
///
/// # Errors
///
/// [`ServerError::HelpRequested`] for `-h` / `--help`; [`ServerError::Config`]
/// for an unknown flag or stray positional argument, a flag missing its
/// value, an empty `--static-dir`, or an invalid port — never ignored, so a
/// typo can't silently boot with defaults.
fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<CliArgs, ServerError> {
    use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};

    let mut parsed = CliArgs::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        // split `--flag=value` on the bytes, so the value may be any path
        let bytes = arg.as_bytes();
        let (flag_bytes, inline) = match bytes.iter().position(|&b| b == b'=') {
            Some(eq) if bytes.starts_with(b"--") => (
                &bytes[..eq],
                Some(OsString::from_vec(bytes[eq + 1..].to_vec())),
            ),
            _ => (bytes, None),
        };
        let flag = match std::str::from_utf8(flag_bytes) {
            Ok("-h" | "--help") if inline.is_none() => return Err(ServerError::HelpRequested),
            Ok(flag @ ("--port" | "--static-dir")) => flag,
            Ok(_) => {
                return Err(ServerError::Config(format!(
                    "unknown argument {:?} (options: {OPTIONS})",
                    arg.to_string_lossy()
                )));
            }
            Err(_) => {
                return Err(ServerError::Config(format!(
                    "argument {:?} is not valid UTF-8 (options: {OPTIONS})",
                    arg.to_string_lossy()
                )));
            }
        };
        let value = inline.or_else(|| args.next()).ok_or_else(|| {
            ServerError::Config(format!("{flag} requires a value (options: {OPTIONS})"))
        })?;
        if flag == "--port" {
            let value = value
                .to_str()
                .ok_or_else(|| ServerError::Config("--port is not valid UTF-8".to_owned()))?;
            parsed.port = Some(parse_port("--port", value)?);
        } else {
            if value.is_empty() {
                return Err(ServerError::Config(
                    "--static-dir requires a non-empty value".to_owned(),
                ));
            }
            parsed.static_dir = Some(PathBuf::from(value));
        }
    }
    Ok(parsed)
}

/// A required env var's value.
///
/// # Errors
///
/// [`ServerError::Config`] naming the variable when it's unset or blank
/// (empty or whitespace — the same "unset" every other var uses), or not
/// valid UTF-8.
fn env_required(name: &str) -> Result<String, ServerError> {
    env_non_empty(name)?
        .ok_or_else(|| ServerError::Config(format!("{name} is unset or blank (it is required)")))
}

/// Parse the `ZZZ_ENABLE_TEST_ACTIONS` flag from its env value: unset or
/// blank → `false`, else [`fuz_sys::env::parse_stringbool`].
///
/// # Errors
///
/// [`ServerError::Config`] naming the variable for an unrecognized value.
fn parse_test_actions_flag(value: Option<&str>) -> Result<bool, ServerError> {
    let Some(value) = value.filter(|v| !v.trim().is_empty()) else {
        return Ok(false);
    };
    fuz_sys::env::parse_stringbool(value)
        .map_err(|e| ServerError::Config(format!("ZZZ_ENABLE_TEST_ACTIONS: {e}")))
}

fn parse_config(default_addr: SocketAddr) -> Result<Config, ServerError> {
    let CliArgs {
        mut port,
        mut static_dir,
    } = parse_args(std::env::args_os().skip(1))?;

    // Fall back to env vars for port/static_dir
    if port.is_none()
        && let Some(val) = env_non_empty("ZZZ_PORT")?
    {
        port = Some(parse_port("ZZZ_PORT", &val)?);
    }
    if static_dir.is_none() {
        static_dir = env_non_empty("ZZZ_STATIC_DIR")?.map(PathBuf::from);
    }
    // An empty or missing static dir would serve the working directory (or
    // nothing) as the UI — refuse to boot instead.
    if let Some(dir) = &static_dir
        && !dir.is_dir()
    {
        return Err(ServerError::Config(format!(
            "static dir is not a directory: {}",
            dir.display()
        )));
    }

    // Required env vars
    let database_url = env_required("DATABASE_URL")?;
    let secret_cookie_keys = env_required("SECRET_FUZ_COOKIE_KEYS")?;

    let bootstrap_token_path = env_non_empty("FUZ_BOOTSTRAP_TOKEN_PATH")?;
    let allowed_origins = env_var_utf8("FUZ_ALLOWED_ORIGINS")?;

    let zzz_dir = ensure_zzz_dir_from_env()?;

    // resolved and checked here, before anything touches the DB, so a bad
    // entry is reported without one
    let scoped_dirs: Vec<String> = env_var_utf8("PUBLIC_ZZZ_SCOPED_DIRS")?
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|dir| resolve_dir(Path::new(dir)))
        .collect::<Result<_, _>>()?;
    check_scoped_dirs(&scoped_dirs, &zzz_dir)?;

    let enable_test_actions =
        parse_test_actions_flag(env_var_utf8("ZZZ_ENABLE_TEST_ACTIONS")?.as_deref())?;
    let trusted_proxies = env_var_utf8("ZZZ_TRUSTED_PROXIES")?;
    // a bad override refuses to boot; a tool that's simply absent doesn't
    let tools = tool::Tools::from_env().map_err(ServerError::Config)?;

    Ok(Config {
        bind_addr: SocketAddr::new(
            default_addr.ip(),
            port.unwrap_or_else(|| default_addr.port()),
        ),
        static_dir,
        database_url,
        secret_cookie_keys,
        bootstrap_token_path,
        allowed_origins,
        scoped_dirs,
        zzz_dir,
        enable_test_actions,
        trusted_proxies,
        tools,
    })
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod config_paths {
    //! Path config never collapses to `/`: empty values read as unset, and
    //! `resolve_dir` errors rather than falling back to an empty string.

    use super::*;

    #[test]
    fn empty_and_whitespace_values_read_as_unset() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some(String::new())), None);
        assert_eq!(non_empty(Some(" \t".to_owned())), None);
        assert_eq!(non_empty(Some("x".to_owned())).as_deref(), Some("x"));
    }

    #[test]
    fn session_cookie_name_is_per_port() {
        assert_eq!(session_cookie_name_for_port(4460), "zzz_session_4460");
        assert_ne!(
            session_cookie_name_for_port(4460),
            session_cookie_name_for_port(4461)
        );
    }

    #[test]
    fn invalid_ports_refuse_to_boot() {
        assert_eq!(parse_port("--port", "4460").unwrap(), 4460);
        assert_eq!(parse_port("ZZZ_PORT", " 65535 ").unwrap(), 65535);
        for bad in ["", "0", "65536", "-1", "44x60", "4460.0"] {
            match parse_port("ZZZ_PORT", bad) {
                Err(ServerError::Config(message)) => {
                    assert!(message.contains("ZZZ_PORT"), "{message}");
                }
                other => panic!("{bad:?} should be refused, got {:?}", other.ok()),
            }
        }
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn config_error(result: Result<CliArgs, ServerError>) -> String {
        match result {
            Err(ServerError::Config(message)) => message,
            other => panic!("expected a config error, got {other:?}"),
        }
    }

    #[test]
    fn args_take_separate_and_inline_values() {
        assert_eq!(parse_args(args(&[])).unwrap(), CliArgs::default());
        let expected = CliArgs {
            port: Some(5000),
            static_dir: Some(PathBuf::from("/ui")),
        };
        assert_eq!(
            parse_args(args(&["--port", "5000", "--static-dir", "/ui"])).unwrap(),
            expected
        );
        assert_eq!(
            parse_args(args(&["--port=5000", "--static-dir=/ui"])).unwrap(),
            expected
        );
        // the last of a repeated flag wins; `=` inside a value is kept
        assert_eq!(
            parse_args(args(&["--port", "1", "--port=2", "--static-dir=a=b"])).unwrap(),
            CliArgs {
                port: Some(2),
                static_dir: Some(PathBuf::from("a=b")),
            }
        );
    }

    #[test]
    fn unknown_and_malformed_args_are_refused() {
        for (list, needle) in [
            (&["--prot", "5000"][..], "unknown argument \"--prot\""),
            (&["--prot=5000"][..], "unknown argument \"--prot=5000\""),
            (&["serve"][..], "unknown argument \"serve\""),
            (&["-p", "5000"][..], "unknown argument \"-p\""),
            (&["--help=x"][..], "unknown argument \"--help=x\""),
            (
                &["--bogus"][..],
                "(options: [--port <port>] [--static-dir <dir>])",
            ),
            (&["--port"][..], "--port requires a value"),
            (&["--static-dir"][..], "--static-dir requires a value"),
            (
                &["--static-dir", ""][..],
                "--static-dir requires a non-empty value",
            ),
            (
                &["--static-dir="][..],
                "--static-dir requires a non-empty value",
            ),
            (&["--port=0"][..], "expected a port in 1..=65535"),
            (&["--port", "65536"][..], "expected a port in 1..=65535"),
            (&["--port="][..], "expected a port in 1..=65535"),
        ] {
            let message = config_error(parse_args(args(list)));
            assert!(message.contains(needle), "{list:?}: {message}");
        }
    }

    #[test]
    fn help_is_requested_not_an_error() {
        for list in [&["--help"][..], &["-h"], &["--port", "5000", "-h"]] {
            assert!(
                matches!(parse_args(args(list)), Err(ServerError::HelpRequested)),
                "{list:?}"
            );
        }
        assert_eq!(ServerError::HelpRequested.to_string(), "help requested");
        // a flag's value is never taken for help
        assert_eq!(
            parse_args(args(&["--static-dir", "--help"]))
                .unwrap()
                .static_dir,
            Some(PathBuf::from("--help"))
        );
    }

    #[test]
    fn non_utf8_args_never_panic() {
        use std::os::unix::ffi::OsStringExt as _;
        let bad = || OsString::from_vec(vec![b'x', 0xff]);

        // a static dir may be any bytes, in either form
        let mut inline = b"--static-dir=".to_vec();
        inline.extend([b'x', 0xff]);
        for list in [
            vec![OsString::from("--static-dir"), bad()],
            vec![OsString::from_vec(inline)],
        ] {
            assert_eq!(
                parse_args(list).unwrap().static_dir,
                Some(PathBuf::from(bad()))
            );
        }
        // anything else is a clear error
        let message = config_error(parse_args([bad()]));
        assert!(message.contains("not valid UTF-8"), "{message}");
        let message = config_error(parse_args([OsString::from("--port"), bad()]));
        assert!(message.contains("--port is not valid UTF-8"), "{message}");
    }

    #[test]
    fn blank_test_actions_flag_reads_as_unset() {
        for unset in [None, Some(""), Some("  ")] {
            assert!(!parse_test_actions_flag(unset).unwrap(), "{unset:?}");
        }
        assert!(parse_test_actions_flag(Some("1")).unwrap());
        assert!(parse_test_actions_flag(Some("TRUE")).unwrap());
        assert!(!parse_test_actions_flag(Some("off")).unwrap());
        let Err(ServerError::Config(message)) = parse_test_actions_flag(Some("maybe")) else {
            panic!("an unknown value errors");
        };
        assert!(message.contains("ZZZ_ENABLE_TEST_ACTIONS"), "{message}");
    }

    #[test]
    fn resolve_dir_rejects_an_empty_path() {
        assert!(matches!(
            resolve_dir(Path::new("")),
            Err(ServerError::Config(_))
        ));
    }

    #[test]
    fn resolve_dir_makes_paths_absolute_with_a_trailing_slash() {
        let cwd = std::env::current_dir().unwrap();
        let resolved = resolve_dir(Path::new("no_such_dir_for_resolve_dir")).unwrap();
        assert_eq!(
            resolved,
            format!("{}/no_such_dir_for_resolve_dir/", cwd.display())
        );
        assert_ne!(resolved, "/");
        assert_eq!(resolve_dir(Path::new("/")).unwrap(), "/");
    }

    /// A unique temp dir removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zzz_config_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ensure_app_dir_creates_a_missing_app_dir_with_parents() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new();
        let dir = tmp.0.join("a/b/app");
        let resolved = ensure_app_dir(&dir).unwrap();
        assert_eq!(resolved, format!("{}/", dir.display()));
        let meta = std::fs::metadata(&dir).unwrap();
        assert!(meta.is_dir());
        assert_eq!(meta.permissions().mode() & 0o077, 0);
        // idempotent on an existing dir
        assert_eq!(ensure_app_dir(&dir).unwrap(), resolved);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_app_dir_resolves_through_symlinked_parents() {
        let tmp = TempDir::new();
        std::fs::create_dir(tmp.0.join("real")).unwrap();
        std::os::unix::fs::symlink(tmp.0.join("real"), tmp.0.join("link")).unwrap();
        let resolved = ensure_app_dir(&tmp.0.join("link/app")).unwrap();
        assert_eq!(resolved, format!("{}/", tmp.0.join("real/app").display()));
    }

    #[test]
    fn the_app_dir_must_not_be_the_working_directory() {
        let tmp = TempDir::new();
        let home = tmp.0.join(".zzz");
        let app = ensure_app_dir(&home.join(".zzz")).unwrap();
        let home_dir = ensure_app_dir(&home).unwrap();

        let Err(ServerError::Config(message)) = check_app_dir_is_not_cwd(&home_dir, &home) else {
            panic!("expected the daemon home to be refused as the app dir");
        };
        assert!(message.contains("PUBLIC_ZZZ_DIR"), "{message}");
        assert!(message.contains(&home_dir), "{message}");
        // a subdirectory, the default, is fine
        assert!(check_app_dir_is_not_cwd(&app, &home).is_ok());
        // so is an unrelated directory
        assert!(check_app_dir_is_not_cwd(&app, &tmp.0).is_ok());
    }

    #[test]
    fn scoped_dirs_in_a_zzz_home_refuse_to_boot() {
        let app = "/home/u/.zzz/.zzz/";
        for dir in ["/home/u/.zzz/", "/home/u/.zzz/run/", "/w/.zzz/"] {
            let Err(ServerError::Config(message)) =
                check_scoped_dirs(&["/w/ok/".to_owned(), dir.to_owned()], app)
            else {
                panic!("expected {dir} to be refused");
            };
            assert!(message.contains("PUBLIC_ZZZ_SCOPED_DIRS"), "{message}");
            assert!(message.contains(dir), "{message}");
        }
        let fine = [
            "/home/u/".to_owned(),
            "/home/u/.zzz/.zzz/".to_owned(),
            "/home/u/.zzz/.zzz/state/".to_owned(),
        ];
        assert!(check_scoped_dirs(&fine, app).is_ok());
    }

    #[test]
    fn ensure_app_dir_errors_clearly_when_the_path_is_a_file() {
        let tmp = TempDir::new();
        let file = tmp.0.join("file");
        std::fs::write(&file, "x").unwrap();
        let Err(ServerError::Config(message)) = ensure_app_dir(&file) else {
            panic!("expected a config error");
        };
        assert!(message.contains("can't create app directory"), "{message}");
        assert!(message.contains(&file.display().to_string()), "{message}");
        assert!(matches!(
            ensure_app_dir(Path::new("")),
            Err(ServerError::Config(_))
        ));
    }
}

#[cfg(test)]
mod client_ip_posture {
    //! The empty-trusted-proxy posture the spine routers in [`run_app`] rely on.
    //!
    //! `ZZZ_TRUSTED_PROXIES` is unset by default, so every spine router layers
    //! `client_ip_middleware` over an *empty* proxy set. These tests pin what
    //! that combination does — record the real TCP peer, never believe a forged
    //! `X-Forwarded-For` — because it is the whole reason the layer is mounted
    //! unconditionally rather than only when proxies are configured.

    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use axum::Router;
    use axum::body::Body;
    use axum::extract::{ConnectInfo, Extension};
    use axum::http::{Request, StatusCode};
    use axum::middleware::from_fn_with_state;
    use axum::routing::get;
    use fuz_http::{ClientIp, ParsedProxy, client_ip_middleware};
    use tower::ServiceExt;

    /// Drive one request through the composer's empty-set layer shape and
    /// return the `ClientIp` the middleware resolved.
    async fn resolved_client_ip(peer: &str, forwarded_for: Option<&str>) -> String {
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&seen);
        // The same empty vec `run_app` builds when `ZZZ_TRUSTED_PROXIES` is unset.
        let proxies: Arc<Vec<ParsedProxy>> = Arc::new(Vec::new());
        let app = Router::new()
            .route(
                "/ip",
                get(move |Extension(ClientIp(ip)): Extension<ClientIp>| {
                    let sink = Arc::clone(&sink);
                    async move {
                        *sink.lock().expect("sink is uncontended") = Some(ip);
                        StatusCode::OK
                    }
                }),
            )
            .layer(from_fn_with_state(proxies, client_ip_middleware));

        let mut builder = Request::builder().uri("/ip").method("GET");
        if let Some(value) = forwarded_for {
            builder = builder.header("x-forwarded-for", value);
        }
        let mut req = builder.body(Body::empty()).expect("request builds");
        // `fuz_http::serve_with_shutdown` inserts `ConnectInfo` into every
        // request; a `oneshot` has no connection, so plumb the peer by hand.
        req.extensions_mut().insert(ConnectInfo(
            peer.parse::<SocketAddr>().expect("peer parses"),
        ));

        let response = app.oneshot(req).await.expect("router responds");
        // A 500 here would mean the `ClientIp` extension was missing — i.e. the
        // middleware was not mounted.
        assert_eq!(response.status(), StatusCode::OK, "ClientIp was populated");

        seen.lock()
            .expect("sink is uncontended")
            .clone()
            .expect("the middleware always populates ClientIp")
    }

    #[tokio::test]
    async fn no_forwarded_for_resolves_to_the_peer() {
        assert_eq!(
            resolved_client_ip("203.0.113.7:51234", None).await,
            "203.0.113.7"
        );
    }

    #[tokio::test]
    async fn forged_forwarded_for_from_an_untrusted_peer_is_ignored() {
        // With no trusted proxies every peer fails the trust check, so the
        // spoofable header is never believed — a caller cannot mint a fresh
        // per-IP rate-limit bucket by inventing an `X-Forwarded-For`.
        assert_eq!(
            resolved_client_ip("203.0.113.7:51234", Some("198.51.100.9")).await,
            "203.0.113.7"
        );
    }
}
