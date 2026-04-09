use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;

use crate::rpc;

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

        // 1. Parse JSON — on failure send bare error object (matching Deno)
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            tracing::debug!("ws: JSON parse error");
            if let Ok(json) = serde_json::to_string(&rpc::parse_error())
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

        // 2. Process the message (handles request vs notification vs invalid)
        let response = rpc::process_message(&value);

        // Null means notification — no response sent
        if response.is_null() {
            continue;
        }

        // 3. Send response
        if let Ok(json) = serde_json::to_string(&response)
            && tx.send(Message::Text(json.into())).await.is_err()
        {
            tracing::debug!("ws: send failed, client disconnected");
            break;
        }
    }
}
