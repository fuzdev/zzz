mod account;
mod auth;
mod bootstrap;
mod daemon_token;
mod db;
mod error;
mod filer;
mod handlers;
mod pty_manager;
mod rpc;
mod scoped_fs;
mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
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
    let bootstrap_available = check_bootstrap_available(&pool, config.bootstrap_token_path.as_ref()).await;

    let allowed_origins = config
        .allowed_origins
        .as_deref()
        .map(auth::parse_allowed_origins)
        .unwrap_or_default();

    let scoped_dir_strings: Vec<String> = config
        .scoped_dirs
        .iter()
        .map(|p| {
            let mut s = std::fs::canonicalize(p)
                .unwrap_or_else(|_| std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()))
                .to_string_lossy()
                .into_owned();
            if !s.ends_with('/') {
                s.push('/');
            }
            s
        })
        .collect();

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
                && let Ok(Some(account_id)) =
                    db::query_keeper_account_id(&client).await
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
    ));

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
        .route("/api/account/sessions", get(account::sessions_list_handler))
        .route("/api/account/sessions/{id}/revoke", post(account::session_revoke_handler))
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

    axum::serve(listener, app)
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
        && let Ok(val) = std::env::var("ZZZ_PORT") {
            if let Ok(p) = val.parse() {
                port = Some(p);
            } else {
                tracing::warn!(value = val.as_str(), "invalid ZZZ_PORT value, ignoring");
            }
        }
    if static_dir.is_none()
        && let Ok(val) = std::env::var("ZZZ_STATIC_DIR") {
            static_dir = Some(PathBuf::from(val));
        }

    // Required env vars
    let database_url = std::env::var("DATABASE_URL").map_err(|_| {
        ServerError::Config("DATABASE_URL is required".to_owned())
    })?;

    let secret_cookie_keys = std::env::var("SECRET_COOKIE_KEYS").map_err(|_| {
        ServerError::Config("SECRET_COOKIE_KEYS is required".to_owned())
    })?;

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
        let p = PathBuf::from(&raw);
        let mut s = std::fs::canonicalize(&p)
            .unwrap_or_else(|_| std::path::absolute(&p).unwrap_or(p))
            .to_string_lossy()
            .into_owned();
        if !s.ends_with('/') {
            s.push('/');
        }
        s
    };

    Ok(Config {
        port: port.unwrap_or(DEFAULT_PORT),
        static_dir,
        database_url,
        secret_cookie_keys,
        bootstrap_token_path,
        allowed_origins,
        scoped_dirs,
        zzz_dir,
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
        .query_opt(
            "SELECT bootstrapped FROM bootstrap_lock WHERE id = 1",
            &[],
        )
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
