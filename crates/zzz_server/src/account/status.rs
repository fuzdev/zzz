//! `GET /api/account/status` — current account info or 401 with bootstrap flag.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use fuz_auth::resolve_auth_from_headers;

use crate::handlers::App;

/// Response for authenticated status check.
#[derive(Serialize)]
struct StatusSuccess {
    account: StatusAccount,
    role_grants: Vec<StatusRoleGrant>,
}

#[derive(Serialize)]
struct StatusAccount {
    id: String,
    username: String,
}

#[derive(Serialize)]
struct StatusRoleGrant {
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
/// - 200 with account + role grants if authenticated
/// - 401 with optional `bootstrap_available` if not
pub async fn status_handler(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    // Try to resolve auth
    let resolved = resolve_auth_from_headers(
        &headers,
        app.keyring.as_ref(),
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await;

    if let Some(r) = resolved {
        let account = StatusAccount {
            id: r.context.account.id.to_string(),
            username: r.context.account.username.clone(),
        };
        let role_grants: Vec<StatusRoleGrant> = r
            .context
            .role_grants
            .iter()
            .map(|p| StatusRoleGrant {
                role: p.role.clone(),
            })
            .collect();
        Json(StatusSuccess {
            account,
            role_grants,
        })
        .into_response()
    } else {
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
