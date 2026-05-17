//! Audit-event listeners.
//!
//! Translate audit events into WebSocket socket revocation. Mirrors
//! `fuz_app`'s `create_ws_auth_guard` + `create_ws_logout_closer`
//! composition (`fuz_app/src/lib/actions/transports_ws_auth_guard.ts`).

use std::sync::Arc;

use serde_json::Value;

use crate::audit::{AuditEmitter, AuditLogEvent};
use crate::handlers::App;

/// Register listeners that translate audit events into WebSocket socket
/// revocation. Mirrors `fuz_app`'s `create_ws_auth_guard` +
/// `create_ws_logout_closer` composition (`fuz_app/src/lib/actions/transports_ws_auth_guard.ts`).
///
/// One listener per event type — keeps the matching logic explicit and
/// avoids a per-event match arm cascade behind a single closure. Failure
/// outcomes never trigger socket close: a failed `session_revoke` row
/// carries the caller-submitted `session_id` (attacker-controlled metadata),
/// so acting on it would let an authenticated user disconnect another user
/// by guessing a session hash.
///
/// ## Layering with eager handler-side close
///
/// Revocation-emitting RPC handlers (`account_session_revoke`,
/// `account_session_revoke_all`, `account_token_revoke`) and REST handlers
/// (`/api/account/logout`, `/api/account/password`) call
/// `close_sockets_for_*` synchronously before emitting the audit row.
/// That eager call is the actual revocation guarantee — it lands on the
/// live WS even if the audit INSERT later fails (DB hiccup, pool
/// exhausted). The listeners registered here run on the materialized row
/// and call the same idempotent `close_sockets_for_*` a second time, so
/// they remain the revocation path for any future out-of-band audit
/// emit sites (admin tools, scheduled jobs, SSE-driven flows) where the
/// emitter doesn't have a handler-context to do the eager close.
/// `close_sockets_for_*` returns 0 on the second pass — the duplication
/// is intentional defense-in-depth, not a correctness risk.
pub fn register(emitter: &Arc<AuditEmitter>, app: &Arc<App>) {
    // session_revoke → close_sockets_for_session(metadata.session_id)
    {
        let app = Arc::clone(app);
        emitter.add_listener(Box::new(move |event: &AuditLogEvent| {
            if event.event_type != "session_revoke" || event.outcome != "success" {
                return;
            }
            let Some(meta) = event.metadata.as_ref().and_then(Value::as_object) else {
                return;
            };
            let Some(session_id) = meta.get("session_id").and_then(Value::as_str) else {
                return;
            };
            let closed = app.close_sockets_for_session(session_id);
            if closed > 0 {
                tracing::info!(
                    count = closed,
                    session_id,
                    "audit listener: closed WebSocket connections (session_revoke)"
                );
            }
        }));
    }

    // token_revoke → close_sockets_for_token(metadata.token_id)
    {
        let app = Arc::clone(app);
        emitter.add_listener(Box::new(move |event: &AuditLogEvent| {
            if event.event_type != "token_revoke" || event.outcome != "success" {
                return;
            }
            let Some(meta) = event.metadata.as_ref().and_then(Value::as_object) else {
                return;
            };
            let Some(token_id) = meta.get("token_id").and_then(Value::as_str) else {
                return;
            };
            let closed = app.close_sockets_for_token(token_id);
            if closed > 0 {
                tracing::info!(
                    count = closed,
                    token_id,
                    "audit listener: closed WebSocket connections (token_revoke)"
                );
            }
        }));
    }

    // session_revoke_all / password_change → close_sockets_for_account.
    // Mirrors fuz_app's `ws_disconnect_event_types` collapsed account-wide
    // case. logout is account-wide too — kept separate from the
    // account_wide_event_types set because its emit site is the REST
    // /logout handler (no `target_account_id`, only `account_id`).
    {
        let app = Arc::clone(app);
        emitter.add_listener(Box::new(move |event: &AuditLogEvent| {
            let account_wide = matches!(
                event.event_type.as_str(),
                "session_revoke_all" | "token_revoke_all" | "password_change" | "logout"
            );
            if !account_wide || event.outcome != "success" {
                return;
            }
            let target = event.target_account_id.or(event.account_id);
            let Some(target) = target else {
                return;
            };
            let closed = app.close_sockets_for_account(target);
            if closed > 0 {
                tracing::info!(
                    count = closed,
                    account_id = %target,
                    event_type = %event.event_type,
                    "audit listener: closed WebSocket connections"
                );
            }
        }));
    }
}
