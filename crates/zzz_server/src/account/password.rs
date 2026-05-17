//! `POST /api/account/password` — change password, revoke sessions+tokens.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::audit::{AuditLogInput, AuditOutcome, credential_type_value};
use crate::auth;
use crate::db;
use crate::handlers::App;
use crate::proxy::ClientIp;

use super::{
    OkResponse, PasswordInput, clear_session_cookie, error_json, hash_password,
    rate_limit_exceeded, verify_password,
};

/// `POST /password` — change password, revoke all sessions + tokens, close sockets.
///
/// Requires authenticated session.
pub async fn password_handler(
    State(app): State<Arc<App>>,
    Extension(client_ip): Extension<ClientIp>,
    headers: HeaderMap,
    Json(input): Json<PasswordInput>,
) -> Response {
    if !auth::is_request_origin_allowed(&headers, &app.allowed_origins) {
        return error_json(StatusCode::FORBIDDEN, "forbidden_origin");
    }
    match password_inner(&app, client_ip.0, &headers, input).await {
        Ok(response) | Err(response) => response,
    }
}

async fn password_inner(
    app: &App,
    client_ip: String,
    headers: &HeaderMap,
    input: PasswordInput,
) -> Result<Response, Response> {
    // Per-IP rate-limit check before any auth or argon2 work (mirrors
    // fuz_app's password route order). Key is the resolved client IP
    // from the trusted-proxy middleware — same plumbing as `/login`.
    let ip_key = client_ip.clone();
    if let Some(ref limiter) = app.login_ip_rate_limiter {
        let result = limiter.check(&ip_key).await;
        if !result.allowed {
            return Err(rate_limit_exceeded(result.retry_after));
        }
    }

    // Resolve auth
    let resolved = auth::resolve_auth_from_headers(
        headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await
    .ok_or_else(|| error_json(StatusCode::UNAUTHORIZED, "unauthenticated"))?;

    // Spec-level credential-channel gate — only session cookies may
    // change passwords. Bearer/api_token and daemon_token callers get
    // 403 with `credential_type_required` + `required_credential_types`
    // matching fuz_app's `require_credential_types` shape. Shared with
    // the RPC dispatcher's `MethodSpec.credential_types = ['session']`
    // path via `auth::check_action_auth`.
    auth::enforce_session_only(&resolved)?;

    // Validate new password
    if input.new_password.len() < 12 {
        return Err(error_json(
            StatusCode::BAD_REQUEST,
            "new password must be at least 12 characters",
        ));
    }

    let account_id = resolved.context.account.id;
    let account_rate_key = account_id.to_string();

    // Per-account rate-limit check (after auth resolves to canonical
    // account.id, before argon2 verify).
    if let Some(ref limiter) = app.login_account_rate_limiter {
        let result = limiter.check(&account_rate_key).await;
        if !result.allowed {
            return Err(rate_limit_exceeded(result.retry_after));
        }
    }

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

    let credential_type_meta = credential_type_value(Some(resolved.credential_type));

    let verified_hash = account_with_hash.password_hash;

    if !verify_password(input.current_password.clone(), verified_hash.clone()).await {
        // Rate-limit record — both buckets — before the audit emit.
        if let Some(ref limiter) = app.login_ip_rate_limiter {
            limiter.record(&ip_key).await;
        }
        if let Some(ref limiter) = app.login_account_rate_limiter {
            limiter.record(&account_rate_key).await;
        }
        // Wrong-password audit row — mirrors fuz_app's metadata shape: just
        // `credential_type` (no `reason` — `reason` is reserved for the
        // `concurrent_change` verify-write race detected below).
        let _ = app
            .audit
            .emit(AuditLogInput {
                event_type: "password_change",
                outcome: Some(AuditOutcome::Failure),
                actor_id: None,
                account_id: Some(account_id),
                target_account_id: None,
                target_actor_id: None,
                ip: Some(client_ip.clone()),
                metadata: Some(json!({"credential_type": credential_type_meta})),
            })
            .await;
        return Err(error_json(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }

    // Successful verify — reset both rate limiters (well-behaved
    // callers don't carry burn from previous failed attempts).
    if let Some(ref limiter) = app.login_ip_rate_limiter {
        limiter.reset(&ip_key).await;
    }
    if let Some(ref limiter) = app.login_account_rate_limiter {
        limiter.reset(&account_rate_key).await;
    }

    // Hash new password
    let new_hash = hash_password(input.new_password.clone())
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: hashing failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    // Conditional UPDATE keyed on the verified hash — closes the
    // verify-write race with a concurrent password change that already
    // committed against the same starting hash. Mirrors fuz_app's
    // `query_update_account_password` boolean contract.
    let updated = db::query_update_password(&client, &account_id, &new_hash, &verified_hash)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: update failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;
    if !updated {
        // Concurrent-change failure path — rate-limit record matches
        // fuz_app's loser-side behavior. The verify itself succeeded, so
        // bucket the failure cost to discourage tight retry loops.
        if let Some(ref limiter) = app.login_ip_rate_limiter {
            limiter.record(&ip_key).await;
        }
        if let Some(ref limiter) = app.login_account_rate_limiter {
            limiter.record(&account_rate_key).await;
        }
        // A concurrent password change committed first — our
        // `current_password` was correct at read-time but the row's
        // `password_hash` no longer matches. Mirrors fuz_app's
        // `concurrent_change` failure shape; sessions/tokens were already
        // revoked by the winner, so no cookie clear here either.
        let _ = app
            .audit
            .emit(AuditLogInput {
                event_type: "password_change",
                outcome: Some(AuditOutcome::Failure),
                actor_id: None,
                account_id: Some(account_id),
                target_account_id: None,
                target_actor_id: None,
                ip: Some(client_ip.clone()),
                metadata: Some(json!({
                    "reason": "concurrent_change",
                    "credential_type": credential_type_meta,
                })),
            })
            .await;
        return Err(error_json(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }

    let sessions_revoked = db::query_delete_all_sessions_for_account(&client, &account_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: session revocation failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    let tokens_revoked = db::query_delete_all_tokens_for_account(&client, &account_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "password: token revocation failed");
            error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        })?;

    // Eager account-wide socket close — done before the audit emit so
    // revocation lands on the live WS even if the audit INSERT fails
    // (no per-message session revalidation, so a stale `RequestContext`
    // would otherwise outlive the password change until disconnect).
    // The audit listener fires the same call on the materialized row
    // (idempotent). Mirrors fuz_app's `create_ws_auth_guard` for
    // `password_change`.
    app.close_sockets_for_account(account_id);

    let _ = app
        .audit
        .emit(AuditLogInput {
            event_type: "password_change",
            outcome: Some(AuditOutcome::Success),
            actor_id: None,
            account_id: Some(account_id),
            target_account_id: None,
            target_actor_id: None,
            ip: Some(client_ip),
            metadata: Some(json!({
                "sessions_revoked": sessions_revoked,
                "tokens_revoked": tokens_revoked,
                "credential_type": credential_type_meta,
            })),
        })
        .await;

    // Clear cookie
    let mut response_headers = HeaderMap::new();
    if let Ok(val) = clear_session_cookie().parse() {
        response_headers.insert(axum::http::header::SET_COOKIE, val);
    }

    tracing::info!(username = %resolved.context.account.username, "password changed");

    Ok((
        StatusCode::OK,
        response_headers,
        Json(OkResponse { ok: true }),
    )
        .into_response())
}
