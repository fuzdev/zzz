//! Terminal handlers. Each terminal is owned by the account that created it
//! (see `pty_manager`).
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` provides the `PtyManager` reach-through.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_auth::{AuditEmitter, AuditEventType, AuditLogEvent};
use fuz_http::{
    JsonrpcError, internal_error, internal_error_with_source, invalid_params, queue_overflow,
    unauthenticated,
};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::handlers::App;
use crate::pty_manager::PtyManager;

#[derive(Serialize)]
struct TerminalCreateResult {
    terminal_id: String,
}

#[derive(Serialize)]
struct TerminalCloseResult {
    exit_code: Option<i32>,
}

/// Read a terminal dimension (`cols` / `rows`) from `params`: an integer in
/// `1..=65535` (the `u16` range of a PTY `winsize`). Out-of-range values are
/// rejected rather than truncated — `65536 as u16` would be `0`.
fn parse_terminal_dimension(params: &Value, name: &str) -> Result<u16, JsonrpcError> {
    let value = params
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid_params(&format!("missing or invalid '{name}' parameter"), None))?;
    u16::try_from(value)
        .ok()
        .filter(|&dimension| dimension >= 1)
        .ok_or_else(|| {
            invalid_params(
                &format!("'{name}' must be between 1 and {}", u16::MAX),
                None,
            )
        })
}

/// The calling account, which owns the terminals it creates. The terminal
/// specs require an account, so a missing one is refused rather than trusted.
fn caller_account_id(ctx: &ActionContext<'_>) -> Result<Uuid, JsonrpcError> {
    ctx.auth
        .account()
        .map(|account| account.id)
        .ok_or_else(unauthenticated)
}

/// The account whose terminals a successful `account_delete` /
/// `account_purge` audit event removes — its `target_account_id`. `None` for
/// any other event, a failure, or a row without a target.
fn removed_terminal_owner(event: &AuditLogEvent) -> Option<Uuid> {
    if event.outcome != "success" {
        return None;
    }
    match AuditEventType::from_wire(&event.event_type)? {
        AuditEventType::AccountDelete | AuditEventType::AccountPurge => event.target_account_id,
        _ => None,
    }
}

/// Registers the audit listener that closes a deleted or purged account's
/// terminals.
///
/// The spine already revokes the account's sessions, tokens, and sockets;
/// this ends the processes they were driving. Holds `App` weakly — `App`'s
/// action registry holds the emitter.
pub fn register_terminal_account_listener(emitter: &AuditEmitter, app: &Arc<App>) {
    let app = Arc::downgrade(app);
    emitter.add_listener(Arc::new(move |event| {
        let app = std::sync::Weak::clone(&app);
        Box::pin(async move {
            let Some(owner) = removed_terminal_owner(&event) else {
                return;
            };
            let Some(app) = app.upgrade() else {
                return;
            };
            let closed = app.pty_manager.close_all_for_account(owner).await;
            if closed > 0 {
                tracing::info!(count = closed, event_type = %event.event_type, "audit listener: closed terminals");
            }
        })
    }));
}

pub async fn terminal_create(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let owner = caller_account_id(&ctx)?;
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'command' parameter", None))?;

    let args: Vec<String> = match params.get("args") {
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|v| {
                v.as_str()
                    .map(String::from)
                    .ok_or_else(|| invalid_params("args must be an array of strings", None))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(Value::Null) | None => vec![],
        _ => return Err(invalid_params("args must be an array of strings", None)),
    };

    let cwd = params.get("cwd").and_then(Value::as_str);

    let terminal_id = Uuid::new_v4().to_string();

    PtyManager::spawn(Arc::clone(&app), owner, &terminal_id, command, &args, cwd)
        .await
        .map_err(|e| internal_error(&format!("failed to create terminal: {e}")))?;

    serde_json::to_value(TerminalCreateResult { terminal_id })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

pub async fn terminal_data_send(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let owner = caller_account_id(&ctx)?;
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'terminal_id' parameter", None))?;

    let data = params
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'data' parameter", None))?;

    app.pty_manager
        .write(owner, terminal_id, data)
        .await
        .map_err(|e| queue_overflow(&e.to_string()))?;

    Ok(Value::Null)
}

pub async fn terminal_resize(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let owner = caller_account_id(&ctx)?;
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'terminal_id' parameter", None))?;

    let cols = parse_terminal_dimension(&params, "cols")?;
    let rows = parse_terminal_dimension(&params, "rows")?;

    app.pty_manager.resize(owner, terminal_id, cols, rows).await;

    Ok(Value::Null)
}

pub async fn terminal_close(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let owner = caller_account_id(&ctx)?;
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'terminal_id' parameter", None))?;

    let signal_str = params
        .get("signal")
        .and_then(Value::as_str)
        .unwrap_or("SIGTERM");

    let signal = match signal_str {
        "SIGKILL" => libc::SIGKILL,
        _ => libc::SIGTERM,
    };

    let exit_code = app
        .pty_manager
        .close(owner, terminal_id, signal)
        .await
        .flatten();

    serde_json::to_value(TerminalCloseResult { exit_code })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

#[cfg(test)]
mod tests {
    use fuz_http::JsonrpcErrorCode;
    use serde_json::json;

    use super::*;

    fn dimension(value: &Value) -> Result<u16, JsonrpcError> {
        parse_terminal_dimension(&json!({ "cols": value }), "cols")
    }

    fn assert_invalid_params(result: Result<u16, JsonrpcError>) {
        match result {
            Err(e) => assert_eq!(e.code, JsonrpcErrorCode::InvalidParams),
            Ok(v) => panic!("expected invalid_params, got Ok({v})"),
        }
    }

    #[test]
    fn dimension_accepts_the_u16_range() {
        assert_eq!(dimension(&json!(1)).ok(), Some(1));
        assert_eq!(dimension(&json!(80)).ok(), Some(80));
        assert_eq!(dimension(&json!(65_535)).ok(), Some(u16::MAX));
    }

    #[test]
    fn dimension_rejects_out_of_range_instead_of_truncating() {
        assert_invalid_params(dimension(&json!(0)));
        assert_invalid_params(dimension(&json!(65_536)));
        assert_invalid_params(dimension(&json!(4_294_967_376_u64)));
    }

    fn audit_event(event_type: &str, outcome: &str, target: Option<Uuid>) -> AuditLogEvent {
        AuditLogEvent {
            id: Uuid::new_v4(),
            seq: 1,
            event_type: event_type.to_owned(),
            outcome: outcome.to_owned(),
            actor_id: None,
            account_id: Some(Uuid::new_v4()),
            target_account_id: target,
            target_actor_id: None,
            ip: None,
            created_at: String::new(),
            metadata: None,
        }
    }

    #[test]
    fn removed_accounts_lose_their_terminals() {
        let target = Uuid::new_v4();
        for event_type in ["account_delete", "account_purge"] {
            assert_eq!(
                removed_terminal_owner(&audit_event(event_type, "success", Some(target))),
                Some(target),
                "{event_type}"
            );
            assert_eq!(
                removed_terminal_owner(&audit_event(event_type, "failure", Some(target))),
                None
            );
            // never the acting account when the target is missing
            assert_eq!(
                removed_terminal_owner(&audit_event(event_type, "success", None)),
                None
            );
        }
        for event_type in [
            "account_undelete",
            "logout",
            "session_revoke_all",
            "custom_thing",
        ] {
            assert_eq!(
                removed_terminal_owner(&audit_event(event_type, "success", Some(target))),
                None,
                "{event_type}"
            );
        }
    }

    #[test]
    fn dimension_rejects_non_integers_and_missing() {
        assert_invalid_params(dimension(&json!(-1)));
        assert_invalid_params(dimension(&json!(80.5)));
        assert_invalid_params(dimension(&json!("80")));
        assert_invalid_params(dimension(&Value::Null));
        assert_invalid_params(parse_terminal_dimension(&json!({}), "rows"));
    }
}
