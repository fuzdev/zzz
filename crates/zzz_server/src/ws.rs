use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;

use crate::rpc::{self, RpcOutcome};

/// Axum handler for `GET /ws` — upgrades to WebSocket.
// TODO Phase 2: Add connection tracking for broadcast notifications
pub async fn ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_connection)
}

async fn handle_connection(socket: WebSocket) {
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

        // 2. Classify and dispatch, then apply WS transport semantics
        let json = match rpc::classify_and_dispatch(&value) {
            RpcOutcome::Success { id, result } => {
                serde_json::to_string(&rpc::success_response(id, result))
            }
            RpcOutcome::Error { id, error } => {
                serde_json::to_string(&rpc::error_response(id, error))
            }
            RpcOutcome::Notification => continue, // WS: silence — no response sent
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
