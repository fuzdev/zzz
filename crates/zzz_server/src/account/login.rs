//! `POST /api/account/login` — username/password → session cookie.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

use crate::audit::{AuditLogInput, AuditOutcome};
use crate::auth;
use crate::db;
use crate::handlers::App;
use crate::proxy::ClientIp;

use super::{
    DUMMY_HASH, LoginInput, error_json, generate_session_token, rate_limit_exceeded,
    sign_session_cookie, verify_password,
};

#[derive(Serialize)]
struct LoginSuccess {
    ok: bool,
    username: String,
    account_id: String,
}

/// `POST /login` — authenticate with username + password, create session.
///
/// Mirrors `fuz_app`'s `login_account` from `account_routes.ts`:
/// - Case-insensitive username lookup
/// - Argon2 password verification
/// - Enumeration prevention (dummy hash on missing account)
/// - Session creation + signed cookie
pub async fn login_handler(
    State(app): State<Arc<App>>,
    Extension(client_ip): Extension<ClientIp>,
    headers: HeaderMap,
    Json(input): Json<LoginInput>,
) -> Response {
    if !auth::is_request_origin_allowed(&headers, &app.allowed_origins) {
        return error_json(StatusCode::FORBIDDEN, "forbidden_origin");
    }
    match login_inner(&app, client_ip.0, input).await {
        Ok(response) | Err(response) => response,
    }
}

async fn login_inner(
    app: &App,
    client_ip: String,
    input: LoginInput,
) -> Result<Response, Response> {
    if input.username.is_empty() {
        return Err(error_json(StatusCode::BAD_REQUEST, "username required"));
    }

    // Canonicalize the submitted username once at the boundary so the
    // DB lookup and the rate-limit fallback key share one identity.
    // Mirrors fuz_app's `login_routes.ts` (`raw_username.trim().toLowerCase()`
    // on the input before any downstream use).
    //
    // Why upfront: the DB query is `LOWER(username) = LOWER($1)`, which
    // handles case but NOT whitespace. Without trimming first,
    // `"admin"` (DB hit → UUID-bucket) and `" admin"` (DB miss →
    // username-string bucket) would land in TWO different per-account
    // buckets for the same target account. A distributed attacker
    // (per-IP bucket doesn't bite) could alternate to get 2x budget.
    // Canonicalizing at the boundary collapses both into one bucket
    // path (UUID when row exists; the canonical string when it
    // doesn't). The audit row's `metadata.username` carries the
    // canonical form for query consistency.
    let canonical_username = input.username.trim().to_lowercase();
    if canonical_username.is_empty() {
        return Err(error_json(StatusCode::BAD_REQUEST, "username required"));
    }

    // Per-IP rate-limit check before any DB or argon2 work (mirrors
    // fuz_app's login route order). When the limiter is `None` (env var
    // unset), the check is skipped entirely so existing integration
    // tests don't trip the bucket. The IP key is the resolved client IP
    // from `proxy::client_ip_middleware` — the TCP peer IP on direct-
    // bind deployments, or the originator behind a configured trusted
    // proxy. Phase 4 keyed on `addr.ip().to_string()` directly which
    // broke under reverse proxies (every client shared the proxy's
    // bucket).
    let ip_key = client_ip.clone();
    if let Some(ref limiter) = app.login_ip_rate_limiter {
        let result = limiter.check(&ip_key).await;
        if !result.allowed {
            return Err(rate_limit_exceeded(result.retry_after));
        }
    }

    let client = app.db_pool.get().await.map_err(|e| {
        tracing::error!(error = %e, "login: db pool error");
        error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
    })?;

    // Case-insensitive username lookup (post-canonicalization the trim
    // is also applied, so the DB query no longer depends on the user's
    // whitespace conventions).
    let account_with_hash = db::query_account_with_password_hash(&client, &canonical_username)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "login: account query failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    // Per-account rate limit (after DB lookup so the key is canonical
    // `account.id` post-resolution — keying on the submitted identifier
    // would let an attacker alternate username and email to double the
    // bucket). Falls back to the canonicalized username when the
    // account doesn't exist; both arms record on failure below so an
    // attacker can't enumerate accounts by watching for bucket changes
    // either.
    // Snapshot the resolved account id BEFORE the `match` below
    // consumes `account_with_hash`. The failure-audit emit needs this
    // value; reading it out of the original `Option` instead of
    // re-running the DB query (the prior `account_with_hash_id`
    // helper) saves one round-trip per failed login AND guarantees the
    // audit row carries the correct `account_id` even if the second
    // query would have errored out. The FK constraint on `audit_log`
    // forces null when the account didn't exist, which the `None` arm
    // here surfaces directly.
    let resolved_account_id: Option<uuid::Uuid> = account_with_hash.as_ref().map(|r| r.id);

    let account_rate_key = account_with_hash
        .as_ref()
        .map_or_else(|| canonical_username.clone(), |row| row.id.to_string());
    if let Some(ref limiter) = app.login_account_rate_limiter {
        let result = limiter.check(&account_rate_key).await;
        if !result.allowed {
            return Err(rate_limit_exceeded(result.retry_after));
        }
    }

    // Verify password (or run against dummy hash for enumeration prevention)
    let (password_hash, account) = match account_with_hash {
        Some(row) => (row.password_hash.clone(), Some(row)),
        None => (DUMMY_HASH.to_owned(), None),
    };

    let password_valid = verify_password(input.password.clone(), password_hash).await;

    let Some(account) = account.filter(|_| password_valid) else {
        // Failed login — record on both rate limiters, then audit-emit.
        if let Some(ref limiter) = app.login_ip_rate_limiter {
            limiter.record(&ip_key).await;
        }
        if let Some(ref limiter) = app.login_account_rate_limiter {
            limiter.record(&account_rate_key).await;
        }
        // `account_id` is set only when the account existed (FK
        // constraint forces null on unknown-account misses).
        let failure_account_id = resolved_account_id;
        let _ = app
            .audit
            .emit(AuditLogInput {
                event_type: "login",
                outcome: Some(AuditOutcome::Failure),
                actor_id: None,
                account_id: failure_account_id,
                target_account_id: None,
                target_actor_id: None,
                ip: Some(client_ip.clone()),
                // Audit metadata carries the canonical form for query
                // consistency (matches fuz_app's `login_routes.ts`).
                metadata: Some(json!({"username": canonical_username})),
            })
            .await;
        return Err(error_json(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    };

    // Successful login — reset both rate limiters so well-behaved
    // callers don't carry burn from previous failed attempts.
    if let Some(ref limiter) = app.login_ip_rate_limiter {
        limiter.reset(&ip_key).await;
    }
    if let Some(ref limiter) = app.login_account_rate_limiter {
        limiter.reset(&account_rate_key).await;
    }

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

    // Successful login — fire-and-forget audit row, awaited so the
    // response is consistent with observable DB state (integration tests
    // can query the row after the response settles).
    let _ = app
        .audit
        .emit(AuditLogInput {
            event_type: "login",
            outcome: Some(AuditOutcome::Success),
            actor_id: None,
            account_id: Some(account.id),
            target_account_id: None,
            target_actor_id: None,
            ip: Some(client_ip.clone()),
            metadata: None,
        })
        .await;

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
