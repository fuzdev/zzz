mod account;
mod api_token;
mod audit;
mod auth;
mod bootstrap;
mod daemon_token;
mod db;
mod error;
mod filer;
mod handlers;
mod handlers_v2;
mod perform_action;
mod provider;
mod proxy;
mod pty_manager;
mod rate_limiter;
mod rpc;
mod scoped_fs;
mod ws;
mod zzz_action_specs;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::routing::{get, post};
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

    // Database — required
    let pool = db::create_pool(&config.database_url)?;
    db::run_migrations(&pool).await?;

    // Keyring — required
    let keyring = auth::Keyring::new(&config.secret_cookie_keys).ok_or_else(|| {
        ServerError::Config("SECRET_COOKIE_KEYS is required (no valid keys found)".to_owned())
    })?;

    let errors = auth::Keyring::validate(&config.secret_cookie_keys);
    if !errors.is_empty() {
        return Err(ServerError::Config(format!(
            "SECRET_COOKIE_KEYS validation failed: {}",
            errors.join(", ")
        )));
    }

    // Bootstrap availability check
    let bootstrap_available =
        check_bootstrap_available(&pool, config.bootstrap_token_path.as_ref()).await;

    let allowed_origins = config
        .allowed_origins
        .as_deref()
        .map(auth::parse_allowed_origins)
        .unwrap_or_default();

    // Parse `ZZZ_TRUSTED_PROXIES` once at startup. Empty/unset → empty
    // vec → middleware treats every connection as untrusted (XFF
    // ignored, `client_ip` = TCP peer). Misconfiguration fails fast so
    // the operator sees the error instead of silently leaving a hole.
    let trusted_proxies = match config.trusted_proxies.as_deref() {
        None => Vec::new(),
        Some(raw) => proxy::parse_proxy_list(raw).map_err(|e| {
            ServerError::Config(format!("ZZZ_TRUSTED_PROXIES: {e}"))
        })?,
    };
    if !trusted_proxies.is_empty() {
        tracing::info!(
            count = trusted_proxies.len(),
            "trusted proxies configured — XFF resolution enabled"
        );
    }

    let scoped_dir_strings: Vec<String> =
        config.scoped_dirs.iter().map(|p| resolve_dir(p)).collect();

    // Include zzz_dir first (like Deno: `new ScopedFs([this.zzz_dir, ...this.scoped_dirs])`)
    // Use canonicalized paths, not raw config paths
    let mut scoped_fs_paths: Vec<PathBuf> = Vec::with_capacity(1 + scoped_dir_strings.len());
    scoped_fs_paths.push(PathBuf::from(&config.zzz_dir));
    scoped_fs_paths.extend(scoped_dir_strings.iter().map(PathBuf::from));
    let scoped_fs = scoped_fs::ScopedFs::new(scoped_fs_paths);

    // Daemon token — initialize state, write token to disk
    let daemon_token_state = match daemon_token::init_daemon_token(&config.zzz_dir).await {
        Ok(state) => {
            // Resolve keeper_account_id if an account with keeper role already exists
            if let Ok(client) = pool.get().await
                && let Ok(Some(account_id)) = db::query_keeper_account_id(&client).await
            {
                state.write().await.keeper_account_id = Some(account_id);
                tracing::info!(%account_id, "daemon token: keeper account resolved");
            }
            Some(state)
        }
        Err(e) => {
            tracing::warn!(error = %e, "daemon token init failed — running without daemon token auth");
            None
        }
    };

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
    // env var is unset so the handlers skip the check entirely.
    let (login_ip_rate_limiter, login_account_rate_limiter) = if config.enable_login_rate_limit {
        tracing::info!("login rate limiting enabled (5/15min per-IP, 10/30min per-account)");
        (
            Some(Arc::new(rate_limiter::RateLimiter::new(
                rate_limiter::DEFAULT_LOGIN_IP_RATE_LIMIT,
            ))),
            Some(Arc::new(rate_limiter::RateLimiter::new(
                rate_limiter::DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT,
            ))),
        )
    } else {
        (None, None)
    };

    // Build the bound audit emitter before App — App owns the Arc.
    // Listener registration happens after App construction so listeners
    // can capture the Arc<App> (see `audit::listeners::register` below).
    let audit_emitter = Arc::new(audit::AuditEmitter::new(pool.clone()));

    // -- Spine-backed state (Phase 7 Batch 5 — additive) -----------
    //
    // These pieces are constructed alongside the legacy state and
    // moved into the new `App` fields. They are wired into the new
    // spine RPC dispatch path (via `App.action_registry`); the legacy
    // `/api/rpc` and `/api/ws` routes continue to dispatch through
    // `crate::handlers::dispatch` as today. Later batches retire the
    // legacy duplicates.
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
    // Re-parse trusted proxies into the spine `fuz_http::ParsedProxy`
    // type. Wire-identical to the legacy `crate::proxy::ParsedProxy`
    // per fuz_http's Phase 4 extraction note; the two types are
    // distinct identities only because zzz hasn't yet collapsed its
    // local proxy module.
    let spine_trusted_proxies: Arc<Vec<fuz_http::ParsedProxy>> = Arc::new(
        match config.trusted_proxies.as_deref() {
            None => Vec::new(),
            Some(raw) => fuz_http::parse_proxy_list(raw).map_err(|e| {
                ServerError::Config(format!("ZZZ_TRUSTED_PROXIES (spine reparse): {e}"))
            })?,
        },
    );
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
    // Build a spine daemon-token state parallel to the legacy one when
    // the legacy init succeeded. The two carry independent rotated
    // tokens; the spine path will eventually subsume the legacy one
    // (Batch 3). For Batch 5 they coexist.
    let spine_daemon_token: Option<fuz_auth::SharedDaemonTokenState> =
        if daemon_token_state.is_some() {
            match fuz_auth::init_daemon_token(Path::new(&config.zzz_dir)).await {
                Ok(state) => {
                    if let Ok(client) = pool.get().await
                        && let Ok(Some(account_id)) = db::query_keeper_account_id(&client).await
                    {
                        state.write().keeper_account_id = Some(account_id);
                    }
                    Some(state)
                }
                Err(e) => {
                    tracing::warn!(error = %e, "spine daemon token init failed");
                    None
                }
            }
        } else {
            None
        };
    let account_route_state = Arc::new(fuz_auth::AccountRouteState {
        pool: pool.clone(),
        keyring: Arc::clone(&spine_keyring),
        password_hasher: Arc::clone(&spine_password_hasher),
        audit: Arc::clone(&spine_audit_emitter),
        socket_revoker: Arc::clone(&socket_revoker),
        allowed_origins: Arc::clone(&spine_allowed_origins),
        bootstrap_available: Arc::clone(&bootstrap_available_atomic),
        login_ip_rate_limiter: None,
        login_account_rate_limiter: None,
        daemon_token_state: spine_daemon_token.clone(),
    });
    let bootstrap_route_state = Arc::new(fuz_auth::BootstrapRouteState {
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
    });

    let spine_state = handlers::SpineState {
        realtime: Arc::clone(&realtime),
        audit_emitter: Arc::clone(&spine_audit_emitter),
        account_route_state: Arc::clone(&account_route_state),
        bootstrap_route_state: Arc::clone(&bootstrap_route_state),
        spine_keyring: Arc::clone(&spine_keyring),
        spine_daemon_token: spine_daemon_token.clone(),
        spine_allowed_origins: Arc::clone(&spine_allowed_origins),
        spine_trusted_proxies: Arc::clone(&spine_trusted_proxies),
    };

    let app_state = Arc::new(handlers::App::new(
        pool,
        keyring,
        allowed_origins,
        config.bootstrap_token_path,
        bootstrap_available,
        scoped_fs,
        config.zzz_dir,
        scoped_dir_strings,
        daemon_token_state.clone(),
        provider_manager,
        config.enable_test_actions,
        Arc::clone(&audit_emitter),
        login_ip_rate_limiter,
        login_account_rate_limiter,
        trusted_proxies,
        spine_state,
    ));

    audit::listeners::register(&audit_emitter, &app_state);

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

    // Spawn daemon token rotation task
    let rotation_handle = daemon_token_state.map(daemon_token::spawn_rotation_task);

    let app_state_for_shutdown = Arc::clone(&app_state);

    let mut app = Router::new()
        .route("/api/rpc", get(rpc::rpc_get_handler).post(rpc::rpc_handler))
        .route("/api/ws", get(ws::ws_handler))
        .route("/health", get(health_handler))
        .route("/api/account/bootstrap", post(bootstrap::bootstrap_handler))
        .route("/api/account/status", get(account::status_handler))
        .route("/api/account/login", post(account::login_handler))
        .route("/api/account/logout", post(account::logout_handler))
        .route("/api/account/password", post(account::password_handler))
        // Resolves `client_ip` and stores it on the request before any
        // route handler runs. `from_fn_with_state` carries its own
        // captured `Arc<App>` for the trusted-proxy list, so the layer
        // is independent of the router's `.with_state(...)` below. The
        // `ConnectInfo<SocketAddr>` extractor inside the middleware
        // reads what `into_make_service_with_connect_info` sets at
        // `axum::serve` time.
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&app_state),
            proxy::client_ip_middleware,
        ))
        .with_state(app_state);

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
