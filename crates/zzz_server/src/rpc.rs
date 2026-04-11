use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use fuz_common::{
    JsonRpcError, JSONRPC_INVALID_PARAMS, JSONRPC_INVALID_REQUEST,
    JSONRPC_METHOD_NOT_FOUND, JSONRPC_PARSE_ERROR, JSONRPC_VERSION,
};
use serde::Serialize;
use serde_json::{Map, Value};

// -- JSON-RPC types -----------------------------------------------------------

/// Successful JSON-RPC 2.0 response.
#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    pub result: Value,
}

/// JSON-RPC 2.0 error response (full envelope).
#[derive(Debug, Serialize)]
pub struct JsonRpcErrorResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    pub error: JsonRpcError,
}

// -- Error constructors -------------------------------------------------------

pub fn parse_error() -> JsonRpcError {
    JsonRpcError {
        code: JSONRPC_PARSE_ERROR,
        message: "parse error".to_string(),
        data: None,
    }
}

pub fn invalid_request() -> JsonRpcError {
    JsonRpcError {
        code: JSONRPC_INVALID_REQUEST,
        message: "invalid request".to_string(),
        data: None,
    }
}

pub fn method_not_found(method: &str) -> JsonRpcError {
    JsonRpcError {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: format!("method not found: {method}"),
        data: None,
    }
}

// -- Response builders --------------------------------------------------------

pub fn success_response(id: Value, result: Value) -> Value {
    serde_json::to_value(JsonRpcResponse {
        jsonrpc: JSONRPC_VERSION,
        id,
        result,
    })
    .unwrap_or_default()
}

pub fn error_response(id: Value, error: JsonRpcError) -> Value {
    serde_json::to_value(JsonRpcErrorResponse {
        jsonrpc: JSONRPC_VERSION,
        id,
        error,
    })
    .unwrap_or_default()
}

// -- HTTP status mapping ------------------------------------------------------

/// Map a JSON-RPC error code to an HTTP status code.
///
/// Matches `fuz_app`'s `jsonrpc_error_code_to_http_status` from
/// `fuz_app/src/lib/http/jsonrpc_errors.ts:230-244`.
/// Returns 500 for unrecognized codes.
const fn error_code_to_http_status(code: i32) -> StatusCode {
    match code {
        // -32700, -32600, -32602 → 400
        JSONRPC_PARSE_ERROR | JSONRPC_INVALID_REQUEST | JSONRPC_INVALID_PARAMS => {
            StatusCode::BAD_REQUEST
        }
        JSONRPC_METHOD_NOT_FOUND => StatusCode::NOT_FOUND, // -32601 → 404
        _ => StatusCode::INTERNAL_SERVER_ERROR,            // -32603 and others → 500
    }
}

// -- Dispatch -----------------------------------------------------------------

/// Route a method to its handler.
/// Returns the `result` value on success, or the error object on failure.
fn dispatch_method(method: &str, id: &Value) -> Result<Value, JsonRpcError> {
    match method {
        "ping" => Ok(serde_json::json!({ "ping_id": id })),
        // TODO Phase 2: Replace hardcoded dispatch with SAES trait-based action routing
        other => Err(method_not_found(other)),
    }
}

// -- Message classification ---------------------------------------------------

/// Classification result from `classify_and_dispatch`.
///
/// Transport-agnostic — callers apply transport-specific semantics:
/// - HTTP: `Notification` → reject as `invalid_request`; `Error` → mapped HTTP status
/// - WS: `Notification` → silence (no response sent); `Error` → send envelope
pub enum RpcOutcome {
    /// Successful dispatch — id and result for the response envelope.
    Success { id: Value, result: Value },
    /// Error — id and error object for the error response envelope.
    Error { id: Value, error: JsonRpcError },
    /// Notification (has method, no id) — caller decides behavior.
    Notification,
}

/// Classify and process a parsed JSON value as a JSON-RPC message.
///
/// Distinguishes between:
/// - Request (has `method` + valid `id`) → dispatch and return `Success`/`Error`
/// - Notification (has `method`, no `id`) → return `Notification`
/// - Invalid (missing `method`, bad `jsonrpc`, non-object, null id) → return `Error`
///
/// Id validation matches `fuz_app`: id must be string or number (excludes null,
/// following MCP). Non-object values always get `id: null` (matching
/// `create_rpc_endpoint`'s safeParse failure path, not `ActionPeer`'s
/// `to_jsonrpc_message_id`).
// TODO Phase 2: Support batch requests (JSON arrays)
pub fn classify_and_dispatch(value: &Value) -> RpcOutcome {
    let Some(obj) = value.as_object() else {
        // Non-object body: fuz_app returns id: null (safeParse fails, no object to extract from)
        return RpcOutcome::Error {
            id: Value::Null,
            error: invalid_request(),
        };
    };

    // Validate jsonrpc version
    let jsonrpc = obj.get("jsonrpc").and_then(Value::as_str);
    if jsonrpc != Some(JSONRPC_VERSION) {
        let id = extract_id(obj);
        return RpcOutcome::Error {
            id,
            error: invalid_request(),
        };
    }

    // Must have method
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        let id = extract_id(obj);
        return RpcOutcome::Error {
            id,
            error: invalid_request(),
        };
    };

    // No `id` field → notification (caller decides behavior)
    let Some(id_val) = obj.get("id") else {
        return RpcOutcome::Notification;
    };

    // Validate id is string or number (fuz_app's JsonrpcRequestId excludes null, per MCP)
    let id = if id_val.is_string() || id_val.is_number() {
        id_val.clone()
    } else {
        // null, bool, array, object ids → invalid request (safeParse would fail)
        return RpcOutcome::Error {
            id: Value::Null,
            error: invalid_request(),
        };
    };

    // Dispatch request
    match dispatch_method(method, &id) {
        Ok(result) => RpcOutcome::Success { id, result },
        Err(err) => RpcOutcome::Error { id, error: err },
    }
}

/// Extract `id` from a JSON-RPC message object for error responses.
///
/// Matches `fuz_app`'s safeParse failure path: extracts id only if it's
/// a string or number, otherwise returns null.
fn extract_id(obj: &Map<String, Value>) -> Value {
    match obj.get("id") {
        Some(id) if id.is_string() || id.is_number() => id.clone(),
        _ => Value::Null,
    }
}

// -- HTTP handler -------------------------------------------------------------

/// Axum handler for `POST /rpc`.
///
/// Applies HTTP-specific transport semantics:
/// - Parse errors → full JSON-RPC envelope, HTTP 400
/// - Notifications → rejected as `invalid_request`, HTTP 400
/// - Error responses → HTTP status mapped from JSON-RPC error code
// TODO Phase 2: Add request/response tracing middleware
pub async fn rpc_handler(body: Bytes) -> Response {
    // 1. Parse body as generic JSON value
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        tracing::debug!("JSON parse error");
        // Full envelope (matches fuz_app), HTTP 400
        return (
            StatusCode::BAD_REQUEST,
            Json(error_response(Value::Null, parse_error())),
        )
            .into_response();
    };

    tracing::debug!(
        method = value.get("method").and_then(|v| v.as_str()).unwrap_or("<none>"),
        "rpc request"
    );

    // 2. Classify and dispatch, then apply HTTP transport semantics
    match classify_and_dispatch(&value) {
        RpcOutcome::Success { id, result } => Json(success_response(id, result)).into_response(),
        RpcOutcome::Error { id, error } => {
            let status = error_code_to_http_status(error.code);
            (status, Json(error_response(id, error))).into_response()
        }
        RpcOutcome::Notification => {
            // HTTP requires id — reject notifications (fuz_app's safeParse enforces this)
            let error = invalid_request();
            let status = error_code_to_http_status(error.code);
            (status, Json(error_response(Value::Null, error))).into_response()
        }
    }
}
