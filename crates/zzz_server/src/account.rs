use std::sync::Arc;

use argon2::password_hash::{PasswordHasher, PasswordVerifier, SaltString};
use base64::Engine;
use argon2::Argon2;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rand::RngExt;
use serde::{Deserialize, Serialize};

use crate::auth::{self, SESSION_AGE_MAX, SESSION_COOKIE_NAME};
use crate::db;
use crate::handlers::App;

// -- Shared helpers -----------------------------------------------------------

/// Current time in seconds since epoch.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Generate a cryptographically random session token (base64url, 32 bytes).
pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Build a signed `Set-Cookie` header value for a session.
pub fn sign_session_cookie(keyring: &auth::Keyring, session_token: &str) -> String {
    let cookie_value = keyring.sign(&format!(
        "{session_token}:{}",
        now_secs() + SESSION_AGE_MAX
    ));
    format!(
        "{SESSION_COOKIE_NAME}={cookie_value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={SESSION_AGE_MAX}"
    )
}

/// Build a `Set-Cookie` header that clears the session cookie.
fn clear_session_cookie() -> String {
    format!(
        "{SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    )
}

/// Short error response constructor.
fn error_json(status: StatusCode, error: &str) -> Response {
    (
        status,
        Json(ErrorBody {
            error: error.to_owned(),
        }),
    )
        .into_response()
}

/// Dummy Argon2 hash for enumeration prevention — run argon2 verify against
/// a known hash when the account doesn't exist, so timing is consistent.
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// -- Types --------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginInput {
    username: String,
    password: String,
}

#[derive(Deserialize)]
pub struct PasswordInput {
    current_password: String,
    new_password: String,
}

#[derive(Serialize)]
struct LoginSuccess {
    ok: bool,
    username: String,
    account_id: String,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Serialize)]
struct SessionInfo {
    id: String,
    account_id: String,
    created_at: String,
    last_seen_at: String,
    expires_at: String,
}

#[derive(Serialize)]
struct SessionsListResponse {
    sessions: Vec<SessionInfo>,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Serialize)]
struct RevokeResponse {
    ok: bool,
    revoked: bool,
}

// -- GET /status --------------------------------------------------------------

/// Response for authenticated status check.
#[derive(Serialize)]
struct StatusSuccess {
    account: StatusAccount,
    permits: Vec<StatusPermit>,
}

#[derive(Serialize)]
struct StatusAccount {
    id: String,
    username: String,
}

#[derive(Serialize)]
struct StatusPermit {
    role: String,
}

/// Response for unauthenticated status check (401).
#[derive(Serialize)]
struct StatusUnauthenticated {
    error: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    bootstrap_available: Option<bool>,
}

/// `GET /status` — current account info or 401 with bootstrap status.
///
/// Mirrors `fuz_app`'s `create_account_status_route_spec`:
/// - 200 with account + permits if authenticated
/// - 401 with optional `bootstrap_available` if not
pub async fn status_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> Response {
    // Try to resolve auth
    let resolved = auth::resolve_auth_from_headers(
        &headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await;

    match resolved {
        Some(r) => {
            let account = StatusAccount {
                id: r.context.account.id.to_string(),
                username: r.context.account.username.clone(),
            };
            let permits: Vec<StatusPermit> = r
                .context
                .permits
                .iter()
                .map(|p| StatusPermit {
                    role: p.role.clone(),
                })
                .collect();
            Json(StatusSuccess { account, permits }).into_response()
        }
        None => {
            let bootstrap = if app
                .bootstrap_available
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                Some(true)
            } else {
                None
            };
            (
                StatusCode::UNAUTHORIZED,
                Json(StatusUnauthenticated {
                    error: "authentication_required",
                    bootstrap_available: bootstrap,
                }),
            )
                .into_response()
        }
    }
}

// -- POST /login --------------------------------------------------------------

/// `POST /login` — authenticate with username + password, create session.
///
/// Mirrors `fuz_app`'s `login_account` from `account_routes.ts`:
/// - Case-insensitive username lookup
/// - Argon2 password verification
/// - Enumeration prevention (dummy hash on missing account)
/// - Session creation + signed cookie
pub async fn login_handler(
    State(app): State<Arc<App>>,
    Json(input): Json<LoginInput>,
) -> Response {
    match login_inner(&app, input).await {
        Ok(response) | Err(response) => response,
    }
}

async fn login_inner(app: &App, input: LoginInput) -> Result<Response, Response> {
    if input.username.is_empty() {
        return Err(error_json(StatusCode::BAD_REQUEST, "username required"));
    }

    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "login: db pool error");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // Case-insensitive username lookup
    let account_with_hash = db::query_account_with_password_hash(&client, &input.username)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "login: account query failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    // Verify password (or run against dummy hash for enumeration prevention)
    let (password_hash, account) = match account_with_hash {
        Some(row) => (row.password_hash.clone(), Some(row)),
        None => (DUMMY_HASH.to_owned(), None),
    };

    let password_valid = verify_password(input.password.clone(), password_hash).await;

    let Some(account) = account.filter(|_| password_valid) else {
        return Err(error_json(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    };

    // Create session
    let session_token = generate_session_token();
    let token_hash = auth::hash_session_token(&session_token);
    db::query_create_session(&client, &token_hash, &account.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "login: session creation failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    // Build response with session cookie
    let cookie = sign_session_cookie(&app.keyring, &session_token);
    let mut headers = HeaderMap::new();
    if let Ok(val) = cookie.parse() {
        headers.insert(axum::http::header::SET_COOKIE, val);
    }

    tracing::info!(username = %input.username, "login successful");

    Ok((
        StatusCode::OK,
        headers,
        Json(LoginSuccess {
            ok: true,
            username: account.username,
            account_id: account.id.to_string(),
        }),
    )
        .into_response())
}

/// Verify a password against an Argon2 hash on a blocking thread.
///
/// Returns `false` on any error (hash parse failure, wrong password, task panic).
async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        let Ok(parsed) = argon2::PasswordHash::new(&hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
    .await
    .unwrap_or(false)
}

// -- POST /logout -------------------------------------------------------------

/// `POST /logout` — invalidate current session, close WebSocket connections.
///
/// Requires authenticated session (cookie). First real caller for
/// `close_sockets_for_session`.
pub async fn logout_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> Response {
    match logout_inner(&app, &headers).await {
        Ok(response) | Err(response) => response,
    }
}

async fn logout_inner(app: &App, headers: &HeaderMap) -> Result<Response, Response> {
    // Resolve session from cookie
    let resolved = auth::resolve_auth_from_headers(
        headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await
    .ok_or_else(|| error_json(StatusCode::UNAUTHORIZED, "unauthenticated"))?;

    // Only cookie sessions can be logged out
    if resolved.credential_type != auth::CredentialType::Session {
        return Err(error_json(StatusCode::BAD_REQUEST, "session_required"));
    }

    let token_hash = resolved.token_hash.as_deref().ok_or_else(|| {
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "logout: db pool error");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // Delete session from DB
    db::query_delete_session(&client, token_hash)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "logout: session deletion failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    // Close WebSocket connections for this session
    let closed = app.close_sockets_for_session(token_hash);
    if closed > 0 {
        tracing::info!(count = closed, "logout: closed WebSocket connections");
    }

    // Clear cookie
    let mut response_headers = HeaderMap::new();
    if let Ok(val) = clear_session_cookie().parse() {
        response_headers.insert(axum::http::header::SET_COOKIE, val);
    }

    tracing::info!(username = %resolved.context.account.username, "logout successful");

    Ok((StatusCode::OK, response_headers, Json(OkResponse { ok: true })).into_response())
}

// -- POST /password -----------------------------------------------------------

/// `POST /password` — change password, revoke all sessions + tokens, close sockets.
///
/// Requires authenticated session.
pub async fn password_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(input): Json<PasswordInput>,
) -> Response {
    match password_inner(&app, &headers, input).await {
        Ok(response) | Err(response) => response,
    }
}

async fn password_inner(
    app: &App,
    headers: &HeaderMap,
    input: PasswordInput,
) -> Result<Response, Response> {
    // Resolve auth
    let resolved = auth::resolve_auth_from_headers(
        headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await
    .ok_or_else(|| error_json(StatusCode::UNAUTHORIZED, "unauthenticated"))?;

    if resolved.credential_type != auth::CredentialType::Session {
        return Err(error_json(StatusCode::BAD_REQUEST, "session_required"));
    }

    // Validate new password
    if input.new_password.len() < 12 {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "new password must be at least 12 characters",
        ));
    }

    let account_id = resolved.context.account.id;

    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "password: db pool error");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // Verify current password
    let account_with_hash = db::query_account_with_password_hash_by_id(&client, &account_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: account query failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?
        .ok_or_else(|| error_json(StatusCode::UNAUTHORIZED, "invalid_credentials"))?;

    if !verify_password(input.current_password.clone(), account_with_hash.password_hash).await {
        return Err(error_json(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }

    // Hash new password
    let new_hash = hash_password(input.new_password.clone()).await.map_err(|e| {
        tracing::error!(error = %e, "password: hashing failed");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // Update password, revoke all sessions + API tokens for this account
    db::query_update_password(&client, &account_id, &new_hash)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: update failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    db::query_delete_all_sessions_for_account(&client, &account_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: session revocation failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    db::query_delete_all_tokens_for_account(&client, &account_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: token revocation failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    // Close all WebSocket connections for this account
    let closed = app.close_sockets_for_account(account_id);
    if closed > 0 {
        tracing::info!(count = closed, "password change: closed WebSocket connections");
    }

    // Clear cookie
    let mut response_headers = HeaderMap::new();
    if let Ok(val) = clear_session_cookie().parse() {
        response_headers.insert(axum::http::header::SET_COOKIE, val);
    }

    tracing::info!(username = %resolved.context.account.username, "password changed");

    Ok((StatusCode::OK, response_headers, Json(OkResponse { ok: true })).into_response())
}

/// Hash a password with Argon2id on a blocking thread.
pub async fn hash_password(password: String) -> Result<String, argon2::password_hash::Error> {
    tokio::task::spawn_blocking(move || {
        // Generate 16 random bytes for the salt (standard Argon2 salt size),
        // then encode as base64 for SaltString.
        let mut salt_bytes = [0u8; 16];
        rand::rng().fill(&mut salt_bytes);
        let salt = SaltString::encode_b64(&salt_bytes)
            .map_err(|_| argon2::password_hash::Error::SaltInvalid(argon2::password_hash::errors::InvalidValue::Malformed))?;
        let argon2 = Argon2::default();
        let hash = argon2.hash_password(password.as_bytes(), &salt)?;
        Ok(hash.to_string())
    })
    .await
    .unwrap_or(Err(argon2::password_hash::Error::Algorithm))
}

// -- GET /sessions ------------------------------------------------------------

/// `GET /sessions` — list all sessions for the authenticated account.
pub async fn sessions_list_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> Response {
    match sessions_list_inner(&app, &headers).await {
        Ok(response) | Err(response) => response,
    }
}

async fn sessions_list_inner(app: &App, headers: &HeaderMap) -> Result<Response, Response> {
    let resolved = auth::resolve_auth_from_headers(
        headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await
    .ok_or_else(|| error_json(StatusCode::UNAUTHORIZED, "unauthenticated"))?;

    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "sessions list: db pool error");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    let rows = db::query_sessions_for_account(&client, &resolved.context.account.id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "sessions list: query failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    let account_id_str = resolved.context.account.id.to_string();
    let sessions: Vec<SessionInfo> = rows
        .into_iter()
        .map(|r| SessionInfo {
            id: r.id,
            account_id: account_id_str.clone(),
            created_at: r.created_at,
            last_seen_at: r.last_seen_at,
            expires_at: r.expires_at,
        })
        .collect();

    Ok(Json(SessionsListResponse { sessions }).into_response())
}

// -- POST /sessions/:id/revoke ------------------------------------------------

/// `POST /sessions/:id/revoke` — revoke a specific session (scoped to own account).
pub async fn session_revoke_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Response {
    match session_revoke_inner(&app, &headers, &session_id).await {
        Ok(response) | Err(response) => response,
    }
}

async fn session_revoke_inner(
    app: &App,
    headers: &HeaderMap,
    session_id: &str,
) -> Result<Response, Response> {
    let resolved = auth::resolve_auth_from_headers(
        headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await
    .ok_or_else(|| error_json(StatusCode::UNAUTHORIZED, "unauthenticated"))?;

    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "session revoke: db pool error");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // Delete session — scoped to the authenticated account
    let deleted = db::query_delete_session_for_account(
        &client,
        session_id,
        &resolved.context.account.id,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "session revoke: delete failed");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    if !deleted {
        // Idempotent — session already gone or belongs to another account
        return Ok(Json(RevokeResponse { ok: true, revoked: false }).into_response());
    }

    // Close WebSocket connections for this session
    let closed = app.close_sockets_for_session(session_id);
    if closed > 0 {
        tracing::info!(count = closed, "session revoke: closed WebSocket connections");
    }

    Ok(Json(RevokeResponse { ok: true, revoked: true }).into_response())
}

// -- POST /tokens/:id/revoke --------------------------------------------------

/// `POST /tokens/:id/revoke` — revoke a specific API token (scoped to own account).
///
/// Mirrors fuz_app's `/tokens/:id/revoke` route. Deletes the token and closes
/// the bearer-authenticated WS sockets bound to it, leaving the account's
/// session-authenticated sockets and other tokens' sockets untouched.
pub async fn token_revoke_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(token_id): Path<String>,
) -> Response {
    match token_revoke_inner(&app, &headers, &token_id).await {
        Ok(response) | Err(response) => response,
    }
}

async fn token_revoke_inner(
    app: &App,
    headers: &HeaderMap,
    token_id: &str,
) -> Result<Response, Response> {
    let resolved = auth::resolve_auth_from_headers(
        headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await
    .ok_or_else(|| error_json(StatusCode::UNAUTHORIZED, "unauthenticated"))?;

    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "token revoke: db pool error");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    let deleted = db::query_revoke_api_token_for_account(
        &client,
        token_id,
        &resolved.context.account.id,
    )
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "token revoke: delete failed");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    if !deleted {
        // Idempotent — token already gone or belongs to another account
        return Ok(Json(RevokeResponse { ok: true, revoked: false }).into_response());
    }

    // Close the bearer-authenticated WS sockets tied to this token
    let closed = app.close_sockets_for_token(token_id);
    if closed > 0 {
        tracing::info!(count = closed, "token revoke: closed WebSocket connections");
    }

    Ok(Json(RevokeResponse { ok: true, revoked: true }).into_response())
}
