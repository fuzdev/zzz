use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use fuz_common::{
    JsonRpcError, JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS, JSONRPC_INVALID_REQUEST,
    JSONRPC_METHOD_NOT_FOUND, JSONRPC_PARSE_ERROR, JSONRPC_VERSION,
};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::auth::{check_action_auth, check_origin, method_auth, resolve_auth_from_headers};
use crate::handlers::{self, App, Ctx};

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
// Intentional divergence: Rust omits `error.data` for security — Zod validation
// details (field names, types, enum values) can leak schema info to unauthenticated
// callers on public actions. Deno includes them for DX. Future: environment-conditional
// in both backends (include in dev, strip in prod). See `normalize_error_data`
// in integration tests for cross-backend handling.

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

pub fn invalid_params(detail: &str) -> JsonRpcError {
    JsonRpcError {
        code: JSONRPC_INVALID_PARAMS,
        message: detail.to_string(),
        data: None,
    }
}

pub fn internal_error(detail: &str) -> JsonRpcError {
    JsonRpcError {
        code: JSONRPC_INTERNAL_ERROR,
        message: detail.to_string(),
        data: None,
    }
}

// -- Notification builder -----------------------------------------------------

/// JSON-RPC 2.0 notification (no `id` field — server-initiated push).
#[derive(Debug, Serialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
}

/// Build a JSON-RPC notification string for broadcasting to WebSocket clients.
///
/// Returns the serialized JSON string. On serialization failure (shouldn't
/// happen with valid `Value` inputs), returns an empty string.
pub fn notification(method: &str, params: Value) -> String {
    let n = JsonRpcNotification {
        jsonrpc: JSONRPC_VERSION,
        method: method.to_owned(),
        params,
    };
    serde_json::to_string(&n).unwrap_or_default()
}

// -- Response builders --------------------------------------------------------

pub const fn success_response(id: Value, result: Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: JSONRPC_VERSION,
        id,
        result,
    }
}

pub const fn error_response(id: Value, error: JsonRpcError) -> JsonRpcErrorResponse {
    JsonRpcErrorResponse {
        jsonrpc: JSONRPC_VERSION,
        id,
        error,
    }
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
        -32001 => StatusCode::UNAUTHORIZED,                // unauthenticated → 401
        -32002 => StatusCode::FORBIDDEN,                   // forbidden → 403
        _ => StatusCode::INTERNAL_SERVER_ERROR,            // -32603 and others → 500
    }
}

// -- Message classification ---------------------------------------------------

/// Default params when the JSON-RPC envelope omits the `params` field.
static NULL_PARAMS: Value = Value::Null;

/// Classification result from `classify`.
///
/// Transport-agnostic — callers apply transport-specific semantics:
/// - HTTP: `Notification` → reject as `invalid_request`; error → mapped HTTP status
/// - WS: `Notification` → silence (no response sent); error → send envelope
pub enum Classified<'a> {
    /// Valid request — method, validated id, and params ready for dispatch.
    Request {
        method: &'a str,
        id: Value,
        params: &'a Value,
    },
    /// Error — id and error object for the error response envelope.
    Invalid {
        id: Value,
        error: JsonRpcError,
    },
    /// Notification (has method, no id) — caller decides behavior.
    Notification,
}

/// Classify a parsed JSON value as a JSON-RPC message.
///
/// Distinguishes between:
/// - Request (has `method` + valid `id`) → `Classified::Request`
/// - Notification (has `method`, no `id`) → `Classified::Notification`
/// - Invalid (missing `method`, bad `jsonrpc`, non-object, null id) → `Classified::Invalid`
///
/// Id validation matches `fuz_app`: id must be string or number (excludes null,
/// following MCP). Non-object values always get `id: null` (matching
/// `create_rpc_endpoint`'s safeParse failure path, not `ActionPeer`'s
/// `to_jsonrpc_message_id`).
// TODO Phase 2: Support batch requests (JSON arrays)
pub fn classify(value: &Value) -> Classified<'_> {
    let Some(obj) = value.as_object() else {
        // Non-object body: fuz_app returns id: null (safeParse fails, no object to extract from)
        return Classified::Invalid {
            id: Value::Null,
            error: invalid_request(),
        };
    };

    // Validate jsonrpc version
    let jsonrpc = obj.get("jsonrpc").and_then(Value::as_str);
    if jsonrpc != Some(JSONRPC_VERSION) {
        let id = extract_id(obj);
        return Classified::Invalid {
            id,
            error: invalid_request(),
        };
    }

    // Must have method
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        let id = extract_id(obj);
        return Classified::Invalid {
            id,
            error: invalid_request(),
        };
    };

    // No `id` field → notification (caller decides behavior)
    let Some(id_val) = obj.get("id") else {
        return Classified::Notification;
    };

    // Validate id is string or number (fuz_app's JsonrpcRequestId excludes null, per MCP)
    let id = if id_val.is_string() || id_val.is_number() {
        id_val.clone()
    } else {
        // null, bool, array, object ids → invalid request (safeParse would fail)
        return Classified::Invalid {
            id: Value::Null,
            error: invalid_request(),
        };
    };

    // Extract params (default to Null if absent — handlers validate)
    let params = obj.get("params").unwrap_or(&NULL_PARAMS);

    Classified::Request { method, id, params }
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
/// - Origin verification before processing
/// - Auth context resolution from Cookie header
/// - Per-action auth check before dispatch
/// - Parse errors → full JSON-RPC envelope, HTTP 400
/// - Notifications → rejected as `invalid_request`, HTTP 400
/// - Error responses → HTTP status mapped from JSON-RPC error code
pub async fn rpc_handler(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Origin verification
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok())
        && !check_origin(origin, &app.allowed_origins) {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }

    // 1. Parse body as generic JSON value
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        tracing::debug!("JSON parse error");
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

    // 2. Resolve auth context (daemon token → cookie → bearer → None)
    let resolved = resolve_auth_from_headers(
        &headers,
        &app.keyring,
        &app.db_pool,
        app.daemon_token_state.as_ref(),
    )
    .await;
    let auth_context = resolved.as_ref().map(|r| &r.context);
    let credential_type = resolved.as_ref().map(|r| r.credential_type);

    // 3. Classify, check auth, then dispatch
    match classify(&value) {
        Classified::Request { method, id, params } => {
            // Per-action auth check
            let spec_auth = method_auth(method);
            if let Some(auth_error) = check_action_auth(spec_auth, auth_context, credential_type) {
                let status = error_code_to_http_status(auth_error.code);
                return (status, Json(error_response(id, auth_error))).into_response();
            }

            let ctx = Ctx {
                app: &app,
                app_arc: Arc::clone(&app),
                request_id: &id,
                auth: auth_context,
            };
            match handlers::dispatch(method, params, &ctx).await {
                Ok(result) => Json(success_response(id, result)).into_response(),
                Err(error) => {
                    let status = error_code_to_http_status(error.code);
                    (status, Json(error_response(id, error))).into_response()
                }
            }
        }
        Classified::Invalid { id, error } => {
            let status = error_code_to_http_status(error.code);
            (status, Json(error_response(id, error))).into_response()
        }
        Classified::Notification => {
            // HTTP requires id — reject notifications (fuz_app's safeParse enforces this)
            let error = invalid_request();
            let status = error_code_to_http_status(error.code);
            (status, Json(error_response(Value::Null, error))).into_response()
        }
    }
}
