mod error;
mod filer;
mod handlers;
mod handlers_v2;
mod provider;
mod pty_manager;
mod rpc;
mod scoped_fs;
mod zzz_action_specs;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use error::ServerError;
use serde::Serialize;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_http::services::ServeDir;
use tracing_subscriber::EnvFilter;

const DEFAULT_PORT: u16 = 1174;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    if let Err(e) = run().await {
        tracing::error!(error = %e, "fatal");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), ServerError> {
    let config = parse_config()?;

    // Database — required. Spine `fuz_db::create_pool` builds the
    // deadpool-postgres pool; `fuz_db::run_migrations` runs the auth DDL
    // tracked under the reserved `fuz_auth` namespace. Phase 7 Batch 4
    // retired the legacy `crate::db` module (`db::create_pool` /
    // `db::run_migrations` / `db::query_*`) wholesale.
    let pool = fuz_db::create_pool(&config.database_url)
        .map_err(|e| ServerError::Database(format!("failed to create pool: {e}")))?;
    fuz_db::run_migrations(&pool, &[fuz_auth::AUTH_MIGRATIONS])
        .await
        .map_err(|e| ServerError::Database(format!("migration failed: {e}")))?;

    // Validate the cookie keys env early; the spine `fuz_auth::Keyring`
    // (constructed below as `spine_keyring`) is the sole keyring on `App`
    // since Phase 7 Batch 3 retired `crate::auth`.
    let errors = fuz_auth::Keyring::validate(&config.secret_cookie_keys);
    if !errors.is_empty() {
        return Err(ServerError::Config(format!(
            "SECRET_COOKIE_KEYS validation failed: {}",
            errors.join(", ")
        )));
    }

    // Bootstrap availability check — drives the `bootstrap_available_atomic`
    // shared by the spine account router (returned on `/status` 401) and
    // the bootstrap router (gate on `/bootstrap`).
    let bootstrap_available =
        check_bootstrap_available(&pool, config.bootstrap_token_path.as_ref()).await;

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
    provider_manager.add(provider::Provider::Ollama(
        provider::ollama::OllamaProvider::new(),
    ));

    if config.enable_test_actions {
        tracing::info!("test actions enabled — `_test_*` methods registered on live dispatchers");
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

    // Spine connection registry + audit emitter — wired into `App` and
    // mounted into the spine RPC + WS dispatchers below. Listener
    // registration (audit-event → socket revocation) happens after
    // `Arc<App>` is constructed so the socket-revoker capability is
    // available.
    let realtime = Arc::new(fuz_realtime::ConnectionRegistry::new());
    let spine_audit_emitter = Arc::new(fuz_auth::AuditEmitter::new(pool.clone()));
    let spine_keyring = Arc::new(
        fuz_auth::Keyring::new(&config.secret_cookie_keys).ok_or_else(|| {
            ServerError::Config(
                "SECRET_COOKIE_KEYS is required for spine keyring (no valid keys found)".to_owned(),
            )
        })?,
    );
    let spine_password_hasher: Arc<dyn fuz_auth::PasswordHasher> =
        Arc::new(fuz_auth::Argon2idHasher::new());
    // Parse `ZZZ_TRUSTED_PROXIES` into the spine `fuz_http::ParsedProxy`
    // type. Empty/unset → empty vec → middleware treats every connection
    // as untrusted (XFF ignored, `client_ip` = TCP peer). Misconfiguration
    // fails fast so the operator sees the error instead of silently
    // leaving a hole. Sole trusted-proxy state on `App` since Phase 7
    // Batch 2 retired the legacy `crate::proxy` module.
    let spine_trusted_proxies: Arc<Vec<fuz_http::ParsedProxy>> = Arc::new(
        match config.trusted_proxies.as_deref() {
            None => Vec::new(),
            Some(raw) => fuz_http::parse_proxy_list(raw).map_err(|e| {
                ServerError::Config(format!("ZZZ_TRUSTED_PROXIES: {e}"))
            })?,
        },
    );
    if !spine_trusted_proxies.is_empty() {
        tracing::info!(
            count = spine_trusted_proxies.len(),
            "trusted proxies configured — XFF resolution enabled"
        );
    }
    let spine_allowed_origins: Arc<Vec<String>> = Arc::new(
        config
            .allowed_origins
            .as_deref()
            .map(fuz_http::parse_allowed_origins)
            .unwrap_or_default(),
    );
    let bootstrap_available_atomic = Arc::new(std::sync::atomic::AtomicBool::new(
        bootstrap_available,
    ));
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
    };
    let bootstrap_route_state = fuz_auth::BootstrapRouteState {
        deps: Arc::new(fuz_auth::BootstrapDeps {
            pool: pool.clone(),
            password_hasher: Arc::clone(&spine_password_hasher),
            audit: Arc::clone(&spine_audit_emitter),
            bootstrap_available: Arc::clone(&bootstrap_available_atomic),
            bootstrap_token_path: config
                .bootstrap_token_path
                .as_ref()
                .map(PathBuf::from),
            on_keeper_resolved: None,
        }),
        keyring: Arc::clone(&spine_keyring),
        allowed_origins: Arc::clone(&spine_allowed_origins),
    };

    let spine_state = handlers::SpineState {
        realtime: Arc::clone(&realtime),
    };

    let app_state = Arc::new(handlers::App::new(
        pool,
        scoped_fs,
        config.zzz_dir,
        scoped_dir_strings,
        provider_manager,
        config.enable_test_actions,
        spine_state,
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
    register_audit_listeners(&spine_audit_emitter, Arc::clone(&socket_revoker));

    // Compile the spine action registry — must run after `Arc<App>` is
    // constructed because the zzz-specific spec builders capture
    // `Arc::clone(&app_state)` into per-spec handler closures.
    //
    // Composition order: protocol (heartbeat + cancel), then
    // `fuz_auth` placeholder adapters (account + admin self-service),
    // then zzz-specific specs (workspace today; filesystem / terminal /
    // provider / etc. land as their `handlers_v2` modules ship).
    let mut all_specs: Vec<fuz_actions::ActionSpec> =
        fuz_actions::PROTOCOL_ACTION_SPECS();
    all_specs.extend(fuz_actions::auth_adapter::build_account_specs(
        Arc::clone(&spine_audit_emitter),
        Arc::clone(&socket_revoker),
    ));
    all_specs.extend(fuz_actions::auth_adapter::build_admin_specs(
        Arc::clone(&spine_audit_emitter),
        Arc::clone(&socket_revoker),
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
    let action_registry = Arc::new(
        fuz_actions::ActionRegistry::compile(all_specs).map_err(|e| {
            ServerError::Config(format!("ActionRegistry::compile failed: {e}"))
        })?,
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
        spec_count = app_state
            .action_registry
            .get()
            .map_or(0, |r| r.len()),
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
    let registry_for_rpc = Arc::clone(
        app_state
            .action_registry
            .get()
            .ok_or_else(|| {
                ServerError::Config(
                    "action_registry must be set before mounting /api/rpc".to_owned(),
                )
            })?,
    );
    let spine_rpc_state = fuz_actions::RpcRouteState {
        pool: app_state.db_pool.clone(),
        keyring: Arc::clone(&spine_keyring),
        daemon_token_state: spine_daemon_token.clone(),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        registry: registry_for_rpc,
        audit: Arc::clone(&spine_audit_emitter),
        socket_revoker: Arc::clone(&socket_revoker),
    };
    let spine_rpc_router = fuz_actions::create_rpc_router(spine_rpc_state).layer(
        axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ),
    );

    let registry_for_ws = Arc::clone(
        app_state
            .action_registry
            .get()
            .ok_or_else(|| {
                ServerError::Config(
                    "action_registry must be set before mounting /api/ws".to_owned(),
                )
            })?,
    );
    let spine_ws_state = fuz_actions::WsRouteState {
        pool: app_state.db_pool.clone(),
        keyring: Arc::clone(&spine_keyring),
        daemon_token_state: spine_daemon_token.clone(),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        registry: registry_for_ws,
        audit: Arc::clone(&spine_audit_emitter),
        socket_revoker: Arc::clone(&socket_revoker),
        connection_registry: Arc::clone(&realtime),
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
    let spine_account_router = fuz_auth::account_router(account_route_state).layer(
        axum::middleware::from_fn_with_state(
            Arc::clone(&spine_trusted_proxies),
            fuz_http::client_ip_middleware,
        ),
    );

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

    let mut app = Router::new()
        .route("/health", get(health_handler))
        // Spine REST routers — account REST + bootstrap. The order of
        // `.nest("/api/account", ...)` calls doesn't matter because the
        // bootstrap router only exposes `/bootstrap` and account exposes
        // the four other paths. axum merges nests at the same prefix.
        .nest("/api/account", spine_account_router)
        .nest("/api/account", spine_bootstrap_router)
        // Spine RPC + WS — single canonical mount. `create_rpc_router`
        // exposes `/rpc` and `register_action_ws` exposes `/ws`, so
        // nesting at `/api` produces `/api/rpc` and `/api/ws`. Both
        // nested routers carry their own state (`RpcRouteState` /
        // `WsRouteState`) + middleware stack.
        .nest("/api", spine_rpc_router)
        .nest("/api", spine_ws_router);

    if let Some(ref dir) = config.static_dir {
        tracing::info!(dir = %dir.display(), "serving static files");
        app = app.fallback_service(ServeDir::new(dir));
    }

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|source| ServerError::Bind { addr, source })?;

    tracing::info!("zzz_server listening on {addr}");

    let shutdown = CancellationToken::new();
    let shutdown_signal = shutdown.clone();
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        tracing::info!("shutdown signal received");
        shutdown_signal.cancel();
    });

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown.cancelled_owned())
    .await
    .map_err(ServerError::Serve)?;

    // Stop daemon token rotation
    if let Some(handle) = rotation_handle {
        handle.abort();
    }

    // Clean up spawned terminal processes before exiting
    app_state_for_shutdown.pty_manager.destroy().await;

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

struct Config {
    port: u16,
    static_dir: Option<PathBuf>,
    database_url: String,
    secret_cookie_keys: String,
    bootstrap_token_path: Option<String>,
    allowed_origins: Option<String>,
    scoped_dirs: Vec<PathBuf>,
    zzz_dir: String,
    /// Register `_test_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave unset.
    enable_test_actions: bool,
    /// Enable per-IP + per-account rate limiting on `/login` and
    /// `/password`. Set in production via `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1`;
    /// default off so integration tests don't trip the bucket. The
    /// dedicated rate-limit integration test sets it explicitly.
    enable_login_rate_limit: bool,
    /// Comma-separated trusted-proxy entries (IPs and CIDR ranges).
    /// Unset/empty → no XFF trust → `client_ip` falls back to the TCP
    /// peer IP on every request. Set when running behind a reverse
    /// proxy so login rate-limit keys and `audit_log.ip` reflect the
    /// originating client. Parsed eagerly in `run()`; invalid entries
    /// fail startup.
    trusted_proxies: Option<String>,
}

/// Parse a Zod-`stringbool()`-shaped env var: case-insensitive truthy
/// (`true`/`1`/`yes`/`on`/`y`/`enabled`) / falsy
/// (`false`/`0`/`no`/`off`/`n`/`disabled`). Unknown values error so a typo
/// doesn't silently disable the feature.
fn parse_stringbool_env(name: &str) -> Result<bool, ServerError> {
    match std::env::var(name).ok() {
        None => Ok(false),
        Some(v) => match v.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" | "y" | "enabled" => Ok(true),
            "false" | "0" | "no" | "off" | "n" | "disabled" => Ok(false),
            other => Err(ServerError::Config(format!(
                "{name}: expected one of true/1/yes/on/y/enabled/false/0/no/off/n/disabled (case-insensitive), got {other:?}"
            ))),
        },
    }
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

fn parse_config() -> Result<Config, ServerError> {
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

    let secret_cookie_keys = std::env::var("SECRET_COOKIE_KEYS")
        .map_err(|_| ServerError::Config("SECRET_COOKIE_KEYS is required".to_owned()))?;

    let bootstrap_token_path = std::env::var("BOOTSTRAP_TOKEN_PATH").ok();
    let allowed_origins = std::env::var("ALLOWED_ORIGINS").ok();

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
        port: port.unwrap_or(DEFAULT_PORT),
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

/// Register audit-event → WebSocket socket-revocation listeners on the
/// spine [`fuz_auth::AuditEmitter`]. Listener bodies are sync (no
/// `.await` inside) wrapped in `Box::pin(async { ... })` to match the
/// spine's boxed-future listener signature.
fn register_audit_listeners(
    emitter: &Arc<fuz_auth::AuditEmitter>,
    revoker: Arc<dyn fuz_auth::SocketRevoker>,
) {
    // session_revoke → close_sockets_for_session(metadata.session_id)
    {
        let revoker = Arc::clone(&revoker);
        emitter.add_listener(Arc::new(move |event| {
            let revoker = Arc::clone(&revoker);
            Box::pin(async move {
                if event.event_type != "session_revoke" || event.outcome != "success" {
                    return;
                }
                let Some(meta) = event.metadata.as_ref().and_then(serde_json::Value::as_object)
                else {
                    return;
                };
                let Some(session_id) = meta.get("session_id").and_then(serde_json::Value::as_str)
                else {
                    return;
                };
                let closed = revoker.close_sockets_for_session(session_id);
                if closed > 0 {
                    tracing::info!(
                        count = closed,
                        session_id,
                        "audit listener: closed WebSocket connections (session_revoke)"
                    );
                }
            })
        }));
    }

    // token_revoke → close_sockets_for_token(metadata.token_id)
    {
        let revoker = Arc::clone(&revoker);
        emitter.add_listener(Arc::new(move |event| {
            let revoker = Arc::clone(&revoker);
            Box::pin(async move {
                if event.event_type != "token_revoke" || event.outcome != "success" {
                    return;
                }
                let Some(meta) = event.metadata.as_ref().and_then(serde_json::Value::as_object)
                else {
                    return;
                };
                let Some(token_id) = meta.get("token_id").and_then(serde_json::Value::as_str)
                else {
                    return;
                };
                let closed = revoker.close_sockets_for_token(token_id);
                if closed > 0 {
                    tracing::info!(
                        count = closed,
                        token_id,
                        "audit listener: closed WebSocket connections (token_revoke)"
                    );
                }
            })
        }));
    }

    // session_revoke_all / token_revoke_all / password_change / logout →
    // close_sockets_for_account(target_account_id ?? account_id).
    // Mirrors `fuz_app`'s `ws_disconnect_event_types` collapsed
    // account-wide case.
    {
        let revoker = Arc::clone(&revoker);
        emitter.add_listener(Arc::new(move |event| {
            let revoker = Arc::clone(&revoker);
            Box::pin(async move {
                let account_wide = matches!(
                    event.event_type.as_str(),
                    "session_revoke_all" | "token_revoke_all" | "password_change" | "logout"
                );
                if !account_wide || event.outcome != "success" {
                    return;
                }
                let Some(target) = event.target_account_id.or(event.account_id) else {
                    return;
                };
                let closed = revoker.close_sockets_for_account(target);
                if closed > 0 {
                    tracing::info!(
                        count = closed,
                        account_id = %target,
                        event_type = %event.event_type,
                        "audit listener: closed WebSocket connections"
                    );
                }
            })
        }));
    }
}

/// Check if bootstrap is available (token file exists and not yet bootstrapped).
async fn check_bootstrap_available(
    pool: &deadpool_postgres::Pool,
    token_path: Option<&String>,
) -> bool {
    let Some(path) = token_path else {
        return false;
    };

    // Check if token file exists
    if tokio::fs::metadata(path).await.is_err() {
        tracing::info!("bootstrap unavailable: token file not found");
        return false;
    }

    // Check bootstrap_lock table
    let Ok(client) = pool.get().await else {
        return false;
    };

    let Ok(row) = client
        .query_opt("SELECT bootstrapped FROM bootstrap_lock WHERE id = 1", &[])
        .await
    else {
        return false;
    };

    if let Some(row) = row {
        let bootstrapped: bool = row.get(0);
        if bootstrapped {
            tracing::info!("bootstrap unavailable: already bootstrapped");
            return false;
        }
    }

    tracing::info!(path = %path, "bootstrap token available");
    true
}

// -- Shutdown -----------------------------------------------------------------

async fn wait_for_shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };

    #[cfg(unix)]
    {
        let sigterm = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut sig) => {
                    sig.recv().await;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "failed to install SIGTERM handler");
                    std::future::pending::<()>().await;
                }
            }
        };

        tokio::select! {
            () = ctrl_c => {}
            () = sigterm => {}
        }
    }

    #[cfg(not(unix))]
    ctrl_c.await;
}
