//! Transport-agnostic dispatch core shared by HTTP RPC (GET + POST) and the
//! per-message WebSocket dispatch loop.
//!
//! Each transport assembles a [`PerformActionInput`] from its wire envelope +
//! connection identity, calls [`perform_action`], and binds the discriminated
//! [`PerformActionResult`] to its wire shape:
//!
//! - HTTP: `(status, Json(success_or_error_envelope))`.
//! - WS: serialize the envelope to text + send over the socket.
//!
//! Mirrors `fuz_app`'s `actions/perform_action.ts` shape. The Rust port is
//! narrower today because the existing Rust pipeline already pulls
//! `method_spec` + `check_action_auth` + transactional dispatch out as
//! reusable building blocks ([`auth::method_spec`], [`auth::check_action_auth`],
//! [`handlers::dispatch`] — the latter routes side-effecting actions through
//! its internal `dispatch_with_tx`). This module is the single shim that
//! sequences those steps so each transport stops open-coding the same six
//! lines.
//!
//! The TS port additionally owns input validation, the authorization phase,
//! rate limiting, and DEV output validation inside `perform_action`. Those
//! land on Rust as later phases — keeping this iteration narrow preserves
//! byte-identical responses on every existing integration test.

use std::sync::Arc;

use axum::http::StatusCode;
use fuz_http::JsonrpcError;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::auth::{CredentialType, RequestContext, check_action_auth, method_spec};
use crate::handlers::{self, App, Ctx, NotifyFn};
use crate::rpc::error_code_to_http_status;

/// Per-call inputs assembled by each transport before calling [`perform_action`].
///
/// Lifetime `'a` keeps the inputs as borrows so callers don't need to clone
/// the parsed envelope just to hand it to the dispatcher.
pub struct PerformActionInput<'a> {
    pub method: &'a str,
    pub params: &'a Value,
    pub request_id: &'a Value,
    /// Resolved request context; `None` for anonymous callers (public actions).
    pub auth: Option<&'a RequestContext>,
    /// Credential type the request arrived on; `None` for anonymous callers.
    pub credential_type: Option<CredentialType>,
    /// Resolved client IP from `proxy::client_ip_middleware`, captured
    /// per-request on HTTP and once-at-upgrade on WS (per-message XFF
    /// resolution doesn't apply to WS — the header is read at the
    /// upgrade request, not on each frame). Plumbed into `Ctx` so RPC
    /// account handlers can populate `AuditLogInput.ip` matching
    /// `fuz_app`'s `get_client_ip(c)` posture. `None` only on
    /// transports that bypass the middleware (none today).
    pub client_ip: Option<String>,
    /// Send a request-scoped JSON-RPC notification. Socket-scoped on WS,
    /// no-op on HTTP. Mirrors TS `ctx.notify`.
    pub notify: NotifyFn,
    /// Per-request cancellation token. Per-socket on WS (cancelled on
    /// disconnect), fresh per-request on HTTP. Mirrors TS `ctx.signal`.
    pub signal: CancellationToken,
}

/// Discriminated result of [`perform_action`]. HTTP binds `status` directly;
/// WS ignores `status` and only serializes `error` (the JSON-RPC envelope
/// has no transport-status field).
pub enum PerformActionResult {
    Ok(Value),
    Err {
        error: JsonrpcError,
        status: StatusCode,
    },
}

/// Shared dispatch core: method spec lookup → per-action auth (credential +
/// role gates) → dispatch (transactional iff `MethodSpec.side_effects`).
///
/// Errors map to HTTP status via [`error_code_to_http_status`] so the HTTP
/// transport binds the response code without re-mapping. The WS transport
/// discards the status and serializes the JSON-RPC error envelope.
pub async fn perform_action(input: PerformActionInput<'_>, app: &Arc<App>) -> PerformActionResult {
    let PerformActionInput {
        method,
        params,
        request_id,
        auth,
        credential_type,
        client_ip,
        notify,
        signal,
    } = input;

    let spec = method_spec(method);
    if let Some(error) = check_action_auth(&spec, auth, credential_type) {
        let status = error_code_to_http_status(error.code);
        return PerformActionResult::Err { error, status };
    }

    let ctx = Ctx {
        app: app.as_ref(),
        app_arc: Arc::clone(app),
        request_id,
        auth,
        credential_type,
        client_ip,
        notify,
        signal,
        pending_effects: std::sync::Mutex::new(Vec::new()),
    };

    let outcome = handlers::dispatch(method, params, &ctx).await;

    // Drain audit emits + other fire-and-forget effects so the response
    // is consistent with observable DB state (mirrors fuz_app's
    // `pending_effects` flush before the transport sends the response).
    ctx.drain_pending_effects().await;

    match outcome {
        Ok(value) => PerformActionResult::Ok(value),
        Err(error) => {
            let status = error_code_to_http_status(error.code);
            PerformActionResult::Err { error, status }
        }
    }
}
