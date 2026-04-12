use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::account::{generate_session_token, hash_password, sign_session_cookie};
use crate::auth;
use crate::db;
use crate::handlers::App;

// -- Types --------------------------------------------------------------------

#[derive(Deserialize)]
pub struct BootstrapInput {
    token: String,
    username: String,
    password: String,
}

#[derive(Serialize)]
struct BootstrapSuccess {
    ok: bool,
    username: String,
}

#[derive(Serialize)]
struct BootstrapErrorBody {
    error: String,
}

/// Short error response constructor.
fn error_json(status: StatusCode, error: &str) -> Response {
    (status, Json(BootstrapErrorBody { error: error.to_owned() })).into_response()
}

// -- Handler ------------------------------------------------------------------

/// `POST /bootstrap` — one-shot endpoint to create the first admin account.
///
/// Mirrors `fuz_app`'s `bootstrap_routes.ts` / `bootstrap_account.ts`:
/// 1. Read and timing-safe-compare bootstrap token
/// 2. Hash password with Argon2
/// 3. In a transaction: acquire bootstrap lock, create account + actor + permits
/// 4. Create session + set cookie
/// 5. Delete token file
pub async fn bootstrap_handler(
    State(app): State<Arc<App>>,
    Json(input): Json<BootstrapInput>,
) -> Response {
    match bootstrap_inner(&app, input).await {
        Ok(response) | Err(response) => response,
    }
}

/// Inner bootstrap logic — uses `Result<Response, Response>` so early returns
/// via `?` produce error responses without repeating the pattern at every step.
async fn bootstrap_inner(app: &App, input: BootstrapInput) -> Result<Response, Response> {
    // Short-circuit if no bootstrap configured
    let Some(ref token_path) = app.bootstrap_token_path else {
        return Err(error_json(StatusCode::NOT_FOUND, "bootstrap_not_configured"));
    };

    // Check bootstrap lock (quick check before token comparison)
    if !app.bootstrap_available.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(error_json(StatusCode::FORBIDDEN, "already_bootstrapped"));
    }

    // 1. Read and verify bootstrap token
    let expected_token = tokio::fs::read_to_string(token_path)
        .await
        .map(|t| t.trim().to_owned())
        .map_err(|_| error_json(StatusCode::NOT_FOUND, "token_file_missing"))?;

    if !timing_safe_eq(input.token.as_bytes(), expected_token.as_bytes()) {
        return Err(error_json(StatusCode::UNAUTHORIZED, "invalid_token"));
    }

    // 2. Validate input
    if input.username.is_empty() || input.password.len() < 12 {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "invalid input: username required, password min 12 chars",
        ));
    }

    // 3. Hash password with Argon2 (CPU-intensive, before transaction)
    let password_hash = hash_password(&input.password).map_err(|e| {
        tracing::error!(error = %e, "password hashing failed");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // 4. Transaction: lock + create account + actor + permits + session
    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "db pool error during bootstrap");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    client.execute("BEGIN", &[]).await.map_err(|e| {
        tracing::error!(error = %e, "transaction begin failed");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // Acquire bootstrap lock atomically
    let lock_row = match client
        .query_opt(
            "UPDATE bootstrap_lock SET bootstrapped = true
             WHERE id = 1 AND bootstrapped = false RETURNING id",
            &[],
        )
        .await
    {
        Ok(row) => row,
        Err(e) => {
            let _ = client.execute("ROLLBACK", &[]).await;
            tracing::error!(error = %e, "bootstrap lock query failed");
            return Err(error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error"));
        }
    };
    if lock_row.is_none() {
        let _ = client.execute("ROLLBACK", &[]).await;
        app.bootstrap_available
            .store(false, std::sync::atomic::Ordering::Relaxed);
        return Err(error_json(StatusCode::FORBIDDEN, "already_bootstrapped"));
    }

    // Create account + actor + permits + session (all in one helper)
    let (account, session_token) =
        match do_bootstrap_creates(&client, &input, &password_hash).await {
            Ok(result) => result,
            Err(e) => {
                let _ = client.execute("ROLLBACK", &[]).await;
                tracing::error!(error = %e, "bootstrap transaction failed");
                return Err(error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error"));
            }
        };

    // Commit
    if let Err(e) = client.execute("COMMIT", &[]).await {
        tracing::error!(error = %e, "transaction commit failed");
        return Err(error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error"));
    }

    // Mark bootstrap as no longer available
    app.bootstrap_available
        .store(false, std::sync::atomic::Ordering::Relaxed);

    // Set keeper_account_id on daemon token state (if enabled)
    if let Some(ref daemon_state) = app.daemon_token_state {
        let mut state = daemon_state.write().await;
        state.keeper_account_id = Some(account.id);
        tracing::info!("daemon token keeper_account_id set to {}", account.id);
    }

    // 5. Delete token file (after commit — best effort)
    if let Err(e) = tokio::fs::remove_file(token_path).await {
        tracing::error!(error = %e, path = %token_path, "CRITICAL: failed to delete bootstrap token file");
    }

    // 6. Build session cookie and return
    let cookie = sign_session_cookie(&app.keyring, &session_token);
    let mut headers = HeaderMap::new();
    if let Ok(val) = cookie.parse() {
        headers.insert(axum::http::header::SET_COOKIE, val);
    }

    tracing::info!(username = %input.username, "bootstrap complete");

    Ok((
        StatusCode::OK,
        headers,
        Json(BootstrapSuccess {
            ok: true,
            username: account.username,
        }),
    )
        .into_response())
}

/// Execute account/actor/permits/session creation within an open transaction.
async fn do_bootstrap_creates(
    client: &deadpool_postgres::Object,
    input: &BootstrapInput,
    password_hash: &str,
) -> Result<(db::AccountRow, String), tokio_postgres::Error> {
    let account = db::query_create_account(client, &input.username, password_hash).await?;
    let actor = db::query_create_actor(client, &account.id, &input.username).await?;
    db::query_grant_permit(client, &actor.id, "keeper").await?;
    db::query_grant_permit(client, &actor.id, "admin").await?;

    let session_token = generate_session_token();
    let token_hash = auth::hash_session_token(&session_token);
    db::query_create_session(client, &token_hash, &account.id).await?;

    Ok((account, session_token))
}

// -- Helpers ------------------------------------------------------------------

/// Timing-safe byte comparison.
fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
