use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;

use fuz_auth::{AuditLogInput, AuditOutcome, hash_session_token};
use fuz_http::{ClientIp, is_request_origin_allowed};

use crate::account::{generate_session_token, hash_password, sign_session_cookie};
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
    (
        status,
        Json(BootstrapErrorBody {
            error: error.to_owned(),
        }),
    )
        .into_response()
}

// -- Handler ------------------------------------------------------------------

/// `POST /bootstrap` — one-shot endpoint to create the first admin account.
///
/// Mirrors `fuz_app`'s `bootstrap_routes.ts` / `bootstrap_account.ts`:
/// 1. Read and timing-safe-compare bootstrap token
/// 2. Hash password with Argon2
/// 3. In a transaction: acquire bootstrap lock, create account + actor + role grants
/// 4. Create session + set cookie
/// 5. Delete token file
pub async fn bootstrap_handler(
    State(app): State<Arc<App>>,
    Extension(client_ip): Extension<ClientIp>,
    headers: HeaderMap,
    Json(input): Json<BootstrapInput>,
) -> Response {
    if !is_request_origin_allowed(&headers, &app.allowed_origins) {
        return error_json(StatusCode::FORBIDDEN, "forbidden_origin");
    }
    match bootstrap_inner(&app, client_ip.0, input).await {
        Ok(response) | Err(response) => response,
    }
}

/// Emit a `bootstrap` failure audit row with `metadata: {error: <reason>}`.
///
/// Mirrors `fuz_app`'s `bootstrap_routes.ts` failure emit shape. Awaited so
/// the row is observable by integration tests after the response settles.
/// `account_id` is always `None` on failure — bootstrap creates the
/// account, so a failed bootstrap has no account to reference.
async fn emit_bootstrap_failure(app: &App, client_ip: &str, error: &str) {
    // `emit(input).await` — detached spawn survives client disconnect,
    // .await keeps the row observable for the post-response test query.
    let _ = app
        .audit
        .emit(AuditLogInput {
            event_type: "bootstrap",
            outcome: Some(AuditOutcome::Failure),
            actor_id: None,
            account_id: None,
            target_account_id: None,
            target_actor_id: None,
            ip: Some(client_ip.to_owned()),
            metadata: Some(json!({"error": error})),
        })
        .await;
}

/// Inner bootstrap logic — uses `Result<Response, Response>` so early returns
/// via `?` produce error responses without repeating the pattern at every step.
async fn bootstrap_inner(
    app: &App,
    client_ip: String,
    input: BootstrapInput,
) -> Result<Response, Response> {
    // Short-circuit if no bootstrap configured
    let Some(ref token_path) = app.bootstrap_token_path else {
        emit_bootstrap_failure(app, &client_ip, "bootstrap_not_configured").await;
        return Err(error_json(
            StatusCode::NOT_FOUND,
            "bootstrap_not_configured",
        ));
    };

    // Check bootstrap lock (quick check before token comparison)
    if !app
        .bootstrap_available
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        emit_bootstrap_failure(app, &client_ip, "already_bootstrapped").await;
        return Err(error_json(StatusCode::FORBIDDEN, "already_bootstrapped"));
    }

    // 1. Read and verify bootstrap token
    let Ok(expected_token) = tokio::fs::read_to_string(token_path)
        .await
        .map(|t| t.trim().to_owned())
    else {
        emit_bootstrap_failure(app, &client_ip, "token_file_missing").await;
        return Err(error_json(StatusCode::NOT_FOUND, "token_file_missing"));
    };

    if !timing_safe_eq(input.token.as_bytes(), expected_token.as_bytes()) {
        emit_bootstrap_failure(app, &client_ip, "invalid_token").await;
        return Err(error_json(StatusCode::UNAUTHORIZED, "invalid_token"));
    }

    // 2. Validate + canonicalize input. Username gets `trim() + to_lowercase()`
    // here so the stored account row has the canonical form login looks up
    // against (`db::query_account_with_password_hash` uses
    // `LOWER(username) = LOWER($1)` — case-tolerant but NOT whitespace-
    // tolerant). Without this canonicalization, an operator bootstrapping
    // with `" Admin"` would create an account that no subsequent login can
    // find. Matches the boundary canonicalization in `login_inner`.
    let canonical_username = input.username.trim().to_lowercase();
    if canonical_username.is_empty() || input.password.len() < 12 {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "invalid input: username required, password min 12 chars",
        ));
    }

    // 3. Hash password with Argon2 (CPU-intensive, before transaction)
    let password_hash = hash_password(input.password.clone()).await.map_err(|e| {
        tracing::error!(error = %e, "password hashing failed");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // 4. Transaction: lock + create account + actor + role grants + session
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
            return Err(error_json(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal error",
            ));
        }
    };
    if lock_row.is_none() {
        let _ = client.execute("ROLLBACK", &[]).await;
        app.bootstrap_available
            .store(false, std::sync::atomic::Ordering::Relaxed);
        // Verify-write race loser: another bootstrap committed first.
        // Pre-check at the head of this function already emits when
        // `bootstrap_available` is false on entry; this site emits for
        // the racy case where two requests both passed the pre-check
        // but only one's UPDATE matched. Matches fuz_app's
        // `bootstrap_routes.ts` which emits at both sites.
        emit_bootstrap_failure(app, &client_ip, "already_bootstrapped").await;
        return Err(error_json(StatusCode::FORBIDDEN, "already_bootstrapped"));
    }

    // Create account + actor + role grants + session (all in one helper)
    let (account, actor, session_token) =
        match do_bootstrap_creates(&client, &canonical_username, &password_hash).await {
            Ok(result) => result,
            Err(e) => {
                let _ = client.execute("ROLLBACK", &[]).await;
                tracing::error!(error = %e, "bootstrap transaction failed");
                return Err(error_json(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal error",
                ));
            }
        };

    // Commit
    if let Err(e) = client.execute("COMMIT", &[]).await {
        tracing::error!(error = %e, "transaction commit failed");
        return Err(error_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error",
        ));
    }

    // Mark bootstrap as no longer available
    app.bootstrap_available
        .store(false, std::sync::atomic::Ordering::Relaxed);

    // Set keeper_account_id on daemon token state (if enabled). Spine
    // `fuz_auth::SharedDaemonTokenState` uses `parking_lot::RwLock` —
    // sync `.write()` (no `.await`).
    if let Some(ref daemon_state) = app.daemon_token_state {
        let mut state = daemon_state.write();
        state.keeper_account_id = Some(account.id);
        tracing::info!("daemon token keeper_account_id set to {}", account.id);
    }

    // 5. Delete token file (after commit — best effort)
    if let Err(e) = tokio::fs::remove_file(token_path).await {
        tracing::error!(error = %e, path = %token_path, "CRITICAL: failed to delete bootstrap token file");
    }

    // 6. Build session cookie
    let cookie = sign_session_cookie(app.keyring.as_ref(), &session_token);
    let mut headers = HeaderMap::new();
    if let Ok(val) = cookie.parse() {
        headers.insert(axum::http::header::SET_COOKIE, val);
    }

    // 7. Success audit — mirrors fuz_app's emit shape: actor + account ids,
    // metadata null. No credential_type (bootstrap is pre-auth).
    // `emit(input).await` — cancel-safe detached spawn.
    let _ = app
        .audit
        .emit(AuditLogInput {
            event_type: "bootstrap",
            outcome: Some(AuditOutcome::Success),
            actor_id: Some(actor.id),
            account_id: Some(account.id),
            target_account_id: None,
            target_actor_id: None,
            ip: Some(client_ip),
            metadata: None,
        })
        .await;

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

/// Execute account/actor/role-grant/session creation within an open transaction.
///
/// `username` is expected canonical (`trim + lowercase`) — see
/// `bootstrap_inner` for the boundary canonicalization. Stored verbatim
/// in both `account.username` and `actor.name`.
async fn do_bootstrap_creates(
    client: &(impl deadpool_postgres::GenericClient + ?Sized),
    username: &str,
    password_hash: &str,
) -> Result<(db::AccountRow, db::ActorRow, String), tokio_postgres::Error> {
    let account = db::query_create_account(client, username, password_hash).await?;
    let actor = db::query_create_actor(client, &account.id, username).await?;
    db::query_create_role_grant(client, &actor.id, "keeper").await?;
    db::query_create_role_grant(client, &actor.id, "admin").await?;

    let session_token = generate_session_token();
    let token_hash = hash_session_token(&session_token);
    db::query_create_session(client, token_hash.as_str(), &account.id).await?;

    Ok((account, actor, session_token))
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
