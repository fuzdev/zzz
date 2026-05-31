//! JSON-RPC notification builder.
//!
//! The spine `fuz_actions::create_rpc_router` mounted at `/api/rpc` owns the
//! dispatch path and `fuz_http` owns the error constructors; this module is
//! just the `notification` builder consumed by `crate::filer`,
//! `crate::pty_manager`, and `crate::handlers::provider` (`broadcast` /
//! `send_to` sites).

use fuz_http::JSONRPC_VERSION;
use serde::Serialize;

// -- Notification builder -----------------------------------------------------

/// JSON-RPC 2.0 notification (no `id` field — server-initiated push).
///
/// Generic over the params type — most callers pass a `&SomeStruct`
/// holding the notification-specific shape.
#[derive(Debug, Serialize)]
struct JsonrpcNotification<'a, T: ?Sized> {
    jsonrpc: &'static str,
    method: &'a str,
    params: &'a T,
}

/// Build a JSON-RPC notification string for broadcasting to WebSocket clients.
///
/// Generic over the params type so callers don't have to round-trip
/// through `serde_json::to_value` first — one serialization, one site of
/// failure handling. Serialization failure is essentially impossible for
/// the in-shape inputs (`serde_json::Value` rejects NaN/Inf, struct
/// derives can't fail), but the warn-and-empty path keeps that contract
/// honest: a future shape slip surfaces in logs instead of silently
/// emitting an empty WS frame.
pub fn notification<T: ?Sized + Serialize>(method: &str, params: &T) -> String {
    let n = JsonrpcNotification {
        jsonrpc: JSONRPC_VERSION,
        method,
        params,
    };
    match serde_json::to_string(&n) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, method, "failed to serialize JSON-RPC notification");
            String::new()
        }
    }
}
