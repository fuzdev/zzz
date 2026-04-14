use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;

use crate::auth::{
    check_action_auth, method_auth, resolve_auth_from_headers, ResolvedAuth,
};
use crate::handlers::{self, App, Ctx};
use crate::rpc::{self, Classified};

/// Axum handler for `GET /ws` — upgrades to WebSocket with auth.
///
/// Authenticates at upgrade time via cookie session. Rejects with 401
/// if unauthenticated. Mirrors `register_websocket_actions.ts`'s
/// `require_auth` middleware.
///
/// On upgrade, registers the connection with auth metadata for targeted
/// socket revocation.
pub async fn ws_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Resolve auth from headers (daemon token → cookie → bearer)
    let resolved = resolve_auth_from_headers(
        &headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await;

    let Some(resolved) = resolved else {
        return (StatusCode::UNAUTHORIZED, "unauthenticated").into_response();
    };

    ws.on_upgrade(move |socket| handle_connection(socket, app, resolved))
}

async fn handle_connection(socket: WebSocket, app: Arc<App>, resolved: ResolvedAuth) {
    let (mut tx, mut rx) = socket.split();

    // Register connection with auth metadata for targeted revocation.
    // Bearer token connections pass None for token_hash — they're revocable
    // only via account-level revocation (matching Deno behavior).
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let account_id = Some(resolved.context.account.id);
    let conn_id = app.add_connection(notify_tx, resolved.token_hash, account_id);
    let auth_context = resolved.context;
    let credential_type = resolved.credential_type;

    loop {
        tokio::select! {
            // Server-initiated message (broadcast or send_to)
            Some(msg) = notify_rx.recv() => {
                if tx.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            // Client message
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { break };
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
                        let spec_auth = method_auth(method);
                        if let Some(auth_error) = check_action_auth(spec_auth, Some(&auth_context), Some(credential_type)) {
                            serde_json::to_string(&rpc::error_response(id, auth_error))
                        } else {
                            let ctx = Ctx {
                                app: &app,
                                app_arc: Arc::clone(&app),
                                request_id: &id,
                                auth: Some(&auth_context),
                                connection_id: Some(conn_id),
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
                    Classified::Notification => continue,
                };

                // 3. Send response
                if let Ok(json) = json
                    && tx.send(Message::Text(json.into())).await.is_err()
                {
                    break;
                }
            }
        }
    }

    // Disconnect: clean up connection tracking
    app.remove_connection(conn_id);
    tracing::debug!(conn_id, "ws: connection closed");
}
