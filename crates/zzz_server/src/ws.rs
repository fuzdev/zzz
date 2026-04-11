use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;

use crate::handlers::{self, App, Ctx};
use crate::rpc::{self, Classified};

/// Axum handler for `GET /ws` — upgrades to WebSocket.
// TODO Phase 2b: Add auth on WS upgrade (cookie session verification)
// TODO Phase 2: Add connection tracking for broadcast notifications
pub async fn ws_handler(State(app): State<Arc<App>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_connection(socket, app))
}

async fn handle_connection(socket: WebSocket, app: Arc<App>) {
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

        // 2. Classify, then dispatch + apply WS transport semantics
        // TODO Phase 2b: resolve auth from upgrade headers, check per-action auth
        let json = match rpc::classify(&value) {
            Classified::Request { method, id, params } => {
                let ctx = Ctx {
                    app: &app,
                    request_id: &id,
                    auth: None, // TODO Phase 2b: WS auth
                };
                match handlers::dispatch(method, params, &ctx).await {
                    Ok(result) => serde_json::to_string(&rpc::success_response(id, result)),
                    Err(error) => serde_json::to_string(&rpc::error_response(id, error)),
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
