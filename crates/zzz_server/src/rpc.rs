use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use fuz_common::{
    JsonRpcError, JSONRPC_INVALID_REQUEST, JSONRPC_METHOD_NOT_FOUND, JSONRPC_PARSE_ERROR,
    JSONRPC_VERSION,
};
use serde::Serialize;
use serde_json::{Map, Value};

// -- JSON-RPC types -----------------------------------------------------------
//
// zzz defines its own envelope types rather than using `fuz_common::JsonRpcResponse`
// because zzz classifies arbitrary JSON-RPC messages via Value (notifications return
// Value::Null, parse errors return bare error objects). fuz_common's single response
// type targets typed request/response. The error object type IS shared from fuz_common.

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

fn success_response(id: Value, result: Value) -> Value {
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

// -- Message processing -------------------------------------------------------

/// Classify and process a parsed JSON value as a JSON-RPC message.
///
/// Distinguishes between:
/// - Request (has `method` + `id`) → dispatch and return response
/// - Notification (has `method`, no `id`) → return `Value::Null` (no response)
/// - Invalid (missing `method` or bad `jsonrpc`) → return error envelope
///
/// This matches the Deno `ActionPeer.#receive_message()` classification.
// TODO Phase 2: Support batch requests (JSON arrays)
pub fn process_message(value: &Value) -> Value {
    let Some(obj) = value.as_object() else {
        // Match Deno: to_jsonrpc_message_id uses the raw value as id for strings/numbers
        let id = if value.is_string() || value.is_number() {
            value.clone()
        } else {
            Value::Null
        };
        return error_response(id, invalid_request());
    };

    // Validate jsonrpc version
    let jsonrpc = obj.get("jsonrpc").and_then(Value::as_str);
    if jsonrpc != Some(JSONRPC_VERSION) {
        let id = extract_id(obj);
        return error_response(id, invalid_request());
    }

    // Must have method
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        let id = extract_id(obj);
        return error_response(id, invalid_request());
    };

    // No `id` field → notification (no response)
    let id = match obj.get("id") {
        Some(id_val) => id_val.clone(),
        None => return Value::Null,
    };

    // Dispatch request
    match dispatch_method(method, &id) {
        Ok(result) => success_response(id, result),
        Err(err) => error_response(id, err),
    }
}

/// Extract `id` from a JSON-RPC message object, defaulting to `null`.
fn extract_id(obj: &Map<String, Value>) -> Value {
    obj.get("id").cloned().unwrap_or(Value::Null)
}

// -- HTTP handler -------------------------------------------------------------

/// Axum handler for `POST /rpc`.
// TODO Phase 2: Add request/response tracing middleware
pub async fn rpc_handler(body: Bytes) -> Response {
    // 1. Parse body as generic JSON value
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        tracing::debug!("JSON parse error");
        // Match Deno behaviour: bare error object, status 400
        return (StatusCode::BAD_REQUEST, Json(parse_error())).into_response();
    };

    tracing::debug!(
        method = value.get("method").and_then(|v| v.as_str()).unwrap_or("<none>"),
        "rpc request"
    );

    // 2. Process and return (always status 200, matching Deno behaviour)
    let response = process_message(&value);
    Json(response).into_response()
}
