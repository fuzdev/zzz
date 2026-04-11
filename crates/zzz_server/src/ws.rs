use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;

use crate::auth::{
    check_action_auth, method_auth, resolve_auth_from_headers, RequestContext,
};
use crate::handlers::{self, App, Ctx};
use crate::rpc::{self, Classified};

/// Axum handler for `GET /ws` — upgrades to WebSocket with auth.
///
/// Authenticates at upgrade time via cookie session. Rejects with 401
/// if unauthenticated. Mirrors `register_websocket_actions.ts`'s
/// `require_auth` middleware.
// TODO Phase 2: Add connection tracking for broadcast notifications
pub async fn ws_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Resolve auth from Cookie header
    let auth_context = resolve_auth_from_headers(&headers, &app.keyring, &app.db_pool).await;

    let Some(auth_context) = auth_context else {
        return (StatusCode::UNAUTHORIZED, "unauthenticated").into_response();
    };

    ws.on_upgrade(move |socket| handle_connection(socket, app, auth_context))
}

async fn handle_connection(socket: WebSocket, app: Arc<App>, auth_context: RequestContext) {
    let (mut tx, mut rx) = socket.split();

    while let Some(Ok(msg)) = rx.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };

        // 1. Parse JSON — on failure send full envelope (matching Deno)
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            tracing::debug!("ws: JSON parse error");
            if let Ok(json) =
                serde_json::to_string(&rpc::error_response(Value::Null, rpc::parse_error()))
                && tx.send(Message::Text(json.into())).await.is_err()
            {
                tracing::debug!("ws: send failed, client disconnected");
                break;
            }
            continue;
        };

        tracing::debug!(
            method = value.get("method").and_then(|v| v.as_str()).unwrap_or("<none>"),
            "ws message"
        );

        // 2. Classify, check per-action auth, then dispatch
        let json = match rpc::classify(&value) {
            Classified::Request { method, id, params } => {
                // Per-action auth check
                let spec_auth = method_auth(method);
                if let Some(auth_error) = check_action_auth(spec_auth, Some(&auth_context)) {
                    serde_json::to_string(&rpc::error_response(id, auth_error))
                } else {
                    let ctx = Ctx {
                        app: &app,
                        request_id: &id,
                        auth: Some(&auth_context),
                    };
                    match handlers::dispatch(method, params, &ctx).await {
                        Ok(result) => serde_json::to_string(&rpc::success_response(id, result)),
                        Err(error) => serde_json::to_string(&rpc::error_response(id, error)),
                    }
                }
            }
            Classified::Invalid { id, error } => {
                serde_json::to_string(&rpc::error_response(id, error))
            }
            Classified::Notification => continue, // WS: silence — no response sent
        };

        // 3. Send response
        if let Ok(json) = json
            && tx.send(Message::Text(json.into())).await.is_err()
        {
            tracing::debug!("ws: send failed, client disconnected");
            break;
        }
    }
}
