mod auth;
mod bootstrap;
mod db;
mod error;
mod handlers;
mod rpc;
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

    let app_state = Arc::new(handlers::App::new(
        pool,
        keyring,
        allowed_origins,
        config.bootstrap_token_path,
        bootstrap_available,
    ));

    let mut app = Router::new()
        .route("/rpc", post(rpc::rpc_handler))
        .route("/ws", get(ws::ws_handler))
        .route("/health", get(health_handler))
        .route("/bootstrap", post(bootstrap::bootstrap_handler))
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

    Ok(Config {
        port: port.unwrap_or(DEFAULT_PORT),
        static_dir,
        database_url,
        secret_cookie_keys,
        bootstrap_token_path,
        allowed_origins,
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
