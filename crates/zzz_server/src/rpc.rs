//! JSON-RPC helpers — error constructors + notification builder.
//!
//! Phase 7 Batch 1 retired the framework half of this module (the envelope
//! dispatch + classification + HTTP handlers `rpc_handler` / `rpc_get_handler`).
//! The spine `fuz_actions::create_rpc_router` mounted at `/api/rpc` now owns
//! the dispatch path.
//!
//! Phase 7 Batch 4 trimmed the surviving surface further — only the helpers
//! consumed by `crate::filer`, `crate::pty_manager`, `crate::handlers_v2/*`,
//! and `crate::provider::*` remain (error constructors used by handlers +
//! the `notification` builder used by broadcast / send_to sites).

use fuz_http::{JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS, JSONRPC_VERSION, JsonrpcError};
use serde::Serialize;

// -- Error constructors -------------------------------------------------------
// Intentional divergence: Rust omits `error.data` for security — Zod validation
// details (field names, types, enum values) can leak schema info to unauthenticated
// callers on public actions. Deno includes them for DX. Future: environment-conditional
// in both backends (include in dev, strip in prod). See `normalize_error_data`
// in integration tests for cross-backend handling.

pub fn invalid_params(detail: &str) -> JsonrpcError {
    JsonrpcError {
        code: JSONRPC_INVALID_PARAMS,
        message: detail.to_string(),
        data: None,
    }
}

pub fn internal_error(detail: &str) -> JsonrpcError {
    JsonrpcError {
        code: JSONRPC_INTERNAL_ERROR,
        message: detail.to_string(),
        data: None,
    }
}

/// Build an `internal_error` AND log the source error at `warn` level.
///
/// Used at handler boundaries that map a `tokio_postgres::Error` /
/// `deadpool_postgres::PoolError` / `serde_json::Error` into the
/// client-facing `-32603` envelope. Logging the underlying cause keeps
/// operators able to debug "X failed" from logs while clients see only
/// the opaque message. Mirrors `tracing::warn!(error = %e, "X failed")`
/// + `internal_error("X failed")` so the two pieces can't drift.
///
/// Use `dyn Display` not generics to keep monomorphization off the 30+
/// call sites — every caller passes the same handful of error types and
/// the boxed-trait dispatch is one indirect call vs. dozens of inlined
/// formatter bodies.
pub fn internal_error_with_source(detail: &str, error: &dyn std::fmt::Display) -> JsonrpcError {
    tracing::warn!(error = %error, "{detail}");
    JsonrpcError {
        code: JSONRPC_INTERNAL_ERROR,
        message: detail.to_string(),
        data: None,
    }
}

// -- Notification builder -----------------------------------------------------

/// JSON-RPC 2.0 notification (no `id` field — server-initiated push).
///
/// Generic over the params type — most callers pass a `&SomeStruct`
/// holding the notification-specific shape.
#[derive(Debug, Serialize)]
struct JsonRpcNotification<'a, T: ?Sized> {
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
    let n = JsonRpcNotification {
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
