use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;

use tokio_util::sync::CancellationToken;

use crate::auth::{
    check_action_auth, method_auth, resolve_auth_from_headers, ResolvedAuth,
};
use crate::handlers::{self, App, Ctx, NotifyFn};
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

/// Matches `fuz_app`'s `WS_CLOSE_SESSION_REVOKED` (4001). Applied when the
/// connection's sender is dropped by `close_sockets_for_*`, so the client
/// can distinguish revocation from a normal (1000) close.
const WS_CLOSE_SESSION_REVOKED: u16 = 4001;

async fn handle_connection(socket: WebSocket, app: Arc<App>, resolved: ResolvedAuth) {
    let (mut tx, mut rx) = socket.split();

    // Register connection with auth metadata for targeted revocation.
    // Bearer token connections pass None for token_hash — they're revocable
    // only via account-level revocation (matching Deno behavior).
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let account_id = Some(resolved.context.account.id);
    let conn_id = app.add_connection(
        notify_tx,
        resolved.token_hash,
        account_id,
        resolved.api_token_id,
    );
    let auth_context = resolved.context;
    let credential_type = resolved.credential_type;

    // Per-socket cancellation token — drives `ctx.signal` for every request
    // on this socket. Cancelled when the message loop exits (socket close)
    // so streaming handlers (e.g. completion_create SSE loop) can bail out.
    // Mirrors TS `socket_abort_controller` in register_websocket_actions.ts.
    let socket_signal = CancellationToken::new();

    // Build the per-socket `notify` closure once — captures `app_arc` + `conn_id`
    // so each request shares the same delivery path.
    let notify: NotifyFn = {
        let app_arc = Arc::clone(&app);
        Arc::new(move |method: &str, params: Value| {
            let notification = rpc::notification(method, params);
            app_arc.send_to(conn_id, &notification);
        })
    };

    // `true` iff the inner message loop broke because the connection was
    // revoked server-side (sender dropped by `close_sockets_for_*`). We send
    // a 4001 Close frame on exit in that case so the client sees the right code.
    let mut revoked = false;

    loop {
        tokio::select! {
            // Server-initiated message (broadcast or send_to). `None` means
            // the sender was dropped by a revocation path — break and send
            // the 4001 close frame below.
            notify_msg = notify_rx.recv() => {
                let Some(msg) = notify_msg else {
                    revoked = true;
                    break;
                };
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
                                notify: Arc::clone(&notify),
                                signal: socket_signal.clone(),
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

    // Disconnect: cancel any in-flight streaming, drop the connection.
    socket_signal.cancel();
    app.remove_connection(conn_id);
    if revoked {
        let close = Message::Close(Some(CloseFrame {
            code: WS_CLOSE_SESSION_REVOKED,
            reason: "Session revoked".into(),
        }));
        // Best-effort — connection may already be gone.
        let _ = tx.send(close).await;
    }
    tracing::debug!(conn_id, "ws: connection closed");
}
