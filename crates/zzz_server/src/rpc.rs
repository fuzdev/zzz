//! JSON-RPC helpers — error constructors, notification builder, error-code →
//! HTTP-status mapping.
//!
//! Phase 7 Batch 1 retired the framework half of this module (the envelope
//! dispatch + classification + HTTP handlers `rpc_handler` / `rpc_get_handler`).
//! The spine `fuz_actions::create_rpc_router` mounted at `/api/rpc` now owns
//! the dispatch path. The helpers below survive because they're still
//! consumed by `crate::filer`, `crate::pty_manager`, `crate::handlers/*`,
//! `crate::handlers_v2/*`, and `crate::perform_action` for notification
//! building and error construction.

use fuz_http::{
    JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS, JSONRPC_INVALID_REQUEST,
    JSONRPC_METHOD_NOT_FOUND, JSONRPC_PARSE_ERROR, JSONRPC_VERSION, JsonrpcError,
};
use axum::http::StatusCode;
use serde::Serialize;

// -- Error constructors -------------------------------------------------------
// Intentional divergence: Rust omits `error.data` for security — Zod validation
// details (field names, types, enum values) can leak schema info to unauthenticated
// callers on public actions. Deno includes them for DX. Future: environment-conditional
// in both backends (include in dev, strip in prod). See `normalize_error_data`
// in integration tests for cross-backend handling.

pub fn parse_error() -> JsonrpcError {
    JsonrpcError {
        code: JSONRPC_PARSE_ERROR,
        message: "parse error".to_string(),
        data: None,
    }
}

pub fn invalid_request() -> JsonrpcError {
    JsonrpcError {
        code: JSONRPC_INVALID_REQUEST,
        message: "invalid request".to_string(),
        data: None,
    }
}

pub fn method_not_found(method: &str) -> JsonrpcError {
    JsonrpcError {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: format!("method not found: {method}"),
        data: None,
    }
}

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

/// JSON-RPC `not_found` error code. Mirrors `fuz_app`'s
/// `JSONRPC_ERROR_CODES.not_found` and `auth.rs`'s `JSONRPC_UNAUTHENTICATED`
/// / `JSONRPC_FORBIDDEN` private constants for the same two-axis (401/403)
/// neighbors. Not exported from `fuz_common` because the wider error-code
/// set there is still JSON-RPC 2.0 core only.
const JSONRPC_NOT_FOUND: i32 = -32003;

/// Build a `not_found` JSON-RPC error.
///
/// Wire shape matches `fuz_app`'s `jsonrpc_errors.not_found(resource, {reason})`:
/// - `message = "{resource} not found"`
/// - `data = {reason}` when `reason` is `Some`; omitted otherwise
///
/// Used by handlers that 404 on an input id (admin revoke-all on an unknown
/// account, future invite lookups, etc.). Centralized so the next consumer
/// doesn't redefine the code or drift the message shape.
pub fn not_found(resource: &str, reason: Option<&str>) -> JsonrpcError {
    JsonrpcError {
        code: JSONRPC_NOT_FOUND,
        message: format!("{resource} not found"),
        data: reason.map(|r| serde_json::json!({"reason": r})),
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

// -- HTTP status mapping ------------------------------------------------------

/// Map a JSON-RPC error code to an HTTP status code.
///
/// Matches `fuz_app`'s `jsonrpc_error_code_to_http_status` from
/// `fuz_app/src/lib/http/jsonrpc_errors.ts:230-244`.
/// Returns 500 for unrecognized codes.
pub const fn error_code_to_http_status(code: i32) -> StatusCode {
    match code {
        // -32700, -32600, -32602 → 400
        JSONRPC_PARSE_ERROR | JSONRPC_INVALID_REQUEST | JSONRPC_INVALID_PARAMS => {
            StatusCode::BAD_REQUEST
        }
        JSONRPC_METHOD_NOT_FOUND => StatusCode::NOT_FOUND, // -32601 → 404
        -32001 => StatusCode::UNAUTHORIZED,                // unauthenticated → 401
        -32002 => StatusCode::FORBIDDEN,                   // forbidden → 403
        _ => StatusCode::INTERNAL_SERVER_ERROR,            // -32603 and others → 500
    }
}
