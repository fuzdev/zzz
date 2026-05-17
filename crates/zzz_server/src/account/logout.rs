//! `POST /api/account/logout` — invalidate session, close WS connections.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::audit::{AuditLogInput, AuditOutcome};
use crate::auth;
use crate::db;
use crate::handlers::App;
use crate::proxy::ClientIp;

use super::{OkResponse, clear_session_cookie, error_json};

/// `POST /logout` — invalidate current session, close WebSocket connections.
///
/// Requires authenticated session (cookie). First real caller for
/// `close_sockets_for_session`.
pub async fn logout_handler(
    State(app): State<Arc<App>>,
    Extension(client_ip): Extension<ClientIp>,
    headers: HeaderMap,
) -> Response {
    if !auth::is_request_origin_allowed(&headers, &app.allowed_origins) {
        return error_json(StatusCode::FORBIDDEN, "forbidden_origin");
    }
    match logout_inner(&app, client_ip.0, &headers).await {
        Ok(response) | Err(response) => response,
    }
}

async fn logout_inner(
    app: &App,
    client_ip: String,
    headers: &HeaderMap,
) -> Result<Response, Response> {
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

    let token_hash = resolved
        .token_hash
        .as_deref()
        .ok_or_else(|| error_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))?;

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

    // Eager account-wide socket close — matches fuz_app's
    // `create_ws_logout_closer` widening logout from per-session to
    // per-account (cookie, bearer, and daemon-token sockets all
    // invalidated). Done synchronously here so revocation lands on the
    // live WS even if the audit INSERT below fails. The listener in
    // `audit::listeners::register` also fires the same call on
    // the materialized row (idempotent).
    app.close_sockets_for_account(resolved.context.account.id);

    let _ = app
        .audit
        .emit(AuditLogInput {
            event_type: "logout",
            outcome: Some(AuditOutcome::Success),
            actor_id: None,
            account_id: Some(resolved.context.account.id),
            target_account_id: None,
            target_actor_id: None,
            ip: Some(client_ip),
            metadata: None,
        })
        .await;

    // Clear cookie
    let mut response_headers = HeaderMap::new();
    if let Ok(val) = clear_session_cookie().parse() {
        response_headers.insert(axum::http::header::SET_COOKIE, val);
    }

    tracing::info!(username = %resolved.context.account.username, "logout successful");

    Ok((
        StatusCode::OK,
        response_headers,
        Json(OkResponse { ok: true }),
    )
        .into_response())
}
