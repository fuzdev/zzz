//! Terminal handlers. Each terminal is owned by the account that created it
//! (see `pty_manager`).
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` provides the `PtyManager` reach-through.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_auth::{
    AuditEmitter, AuditEventType, AuditLogEvent, deserialize_optional_wire_uuid,
    deserialize_wire_uuid,
};
use fuz_http::{
    JsonrpcError, internal_error, internal_error_with_source, invalid_params, not_found,
    parse_strict_params, queue_overflow,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::handlers::filesystem::ERROR_INVALID_PATH;
use crate::handlers::{App, caller_account_id};
use crate::pty_manager::{PtyManager, TerminalNotFound, TerminalWriteError};

#[derive(Serialize)]
struct TerminalCreateResult {
    terminal_id: String,
}

#[derive(Serialize)]
struct TerminalCloseResult {
    exit_code: Option<i32>,
}

// -- Inputs (twins of the `Terminal*Input` schemas in `action_specs.ts`) ------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalCreateInput {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    /// Accepted for parity with the TS input; the backend doesn't use it.
    #[serde(default, deserialize_with = "deserialize_optional_wire_uuid")]
    #[allow(dead_code, reason = "decoded for input validation only")]
    preset_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalDataSendInput {
    #[serde(deserialize_with = "deserialize_wire_uuid")]
    terminal_id: Uuid,
    data: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalResizeInput {
    #[serde(deserialize_with = "deserialize_wire_uuid")]
    terminal_id: Uuid,
    cols: u64,
    rows: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalCloseInput {
    #[serde(deserialize_with = "deserialize_wire_uuid")]
    terminal_id: Uuid,
    #[serde(default)]
    signal: Option<String>,
}

/// Check a terminal dimension (`cols` / `rows`): an integer in `1..=65535`
/// (the `u16` range of a PTY `winsize`). Out-of-range values are rejected
/// rather than truncated — `65536 as u16` would be `0`.
fn terminal_dimension(value: u64, name: &str) -> Result<u16, JsonrpcError> {
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

/// The signal a `terminal_close` sends: `SIGTERM` (the default) or
/// `SIGKILL` — the twin of `TerminalCloseSignal`. Anything else is refused
/// rather than silently sent as `SIGTERM`.
fn close_signal(signal: Option<&str>) -> Result<i32, JsonrpcError> {
    match signal {
        None | Some("SIGTERM") => Ok(libc::SIGTERM),
        Some("SIGKILL") => Ok(libc::SIGKILL),
        Some(other) => Err(invalid_params(
            &format!("unsupported signal {other:?}: expected \"SIGTERM\" or \"SIGKILL\""),
            None,
        )),
    }
}

/// Check a `terminal_create` `cwd`: absolute, so it never resolves against
/// the daemon's own working directory (`~/.zzz` under the CLI).
fn terminal_cwd(cwd: Option<&str>) -> Result<Option<&str>, JsonrpcError> {
    match cwd {
        Some(cwd) if !std::path::Path::new(cwd).is_absolute() => Err(invalid_params(
            &format!("'cwd' must be an absolute path: {cwd:?}"),
            Some(ERROR_INVALID_PATH),
        )),
        cwd => Ok(cwd),
    }
}

/// The reply for a terminal the caller doesn't own — an unknown id, one that
/// ended, and another account's are all this same `not_found`, so a
/// terminal's existence isn't observable across accounts.
fn terminal_not_found(_: TerminalNotFound) -> JsonrpcError {
    not_found("terminal", None)
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
/// terminals and cancels its jobs.
///
/// The spine already revokes the account's sessions, tokens, and sockets;
/// this ends the processes they were driving. Holds `App` weakly — `App`'s
/// action registry holds the emitter.
pub fn register_account_removal_listener(emitter: &AuditEmitter, app: &Arc<App>) {
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
            let cancelled = app.job_manager.cancel_all_for_account(&app, owner);
            if cancelled > 0 {
                tracing::info!(count = cancelled, event_type = %event.event_type, "audit listener: cancelled jobs");
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
    let TerminalCreateInput {
        command, args, cwd, ..
    } = parse_strict_params(params)?;
    let cwd = terminal_cwd(cwd.as_deref())?;

    let terminal_id = Uuid::new_v4().to_string();

    PtyManager::spawn(Arc::clone(&app), owner, &terminal_id, &command, &args, cwd)
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
    let input: TerminalDataSendInput = parse_strict_params(params)?;

    app.pty_manager
        .write(owner, &input.terminal_id.to_string(), &input.data)
        .await
        .map_err(|e| match e {
            TerminalWriteError::NotFound(e) => terminal_not_found(e),
            TerminalWriteError::InputFull => queue_overflow(&e.to_string()),
        })?;

    Ok(Value::Null)
}

pub async fn terminal_resize(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let owner = caller_account_id(&ctx)?;
    let input: TerminalResizeInput = parse_strict_params(params)?;
    let cols = terminal_dimension(input.cols, "cols")?;
    let rows = terminal_dimension(input.rows, "rows")?;

    app.pty_manager
        .resize(owner, &input.terminal_id.to_string(), cols, rows)
        .await
        .map_err(terminal_not_found)?;

    Ok(Value::Null)
}

pub async fn terminal_close(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let owner = caller_account_id(&ctx)?;
    let input: TerminalCloseInput = parse_strict_params(params)?;
    let signal = close_signal(input.signal.as_deref())?;

    let exit_code = app
        .pty_manager
        .close(owner, &input.terminal_id.to_string(), signal)
        .await
        .map_err(terminal_not_found)?;

    serde_json::to_value(TerminalCloseResult { exit_code })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

#[cfg(test)]
mod tests {
    use fuz_http::JsonrpcErrorCode;
    use serde_json::json;

    use super::*;

    const NIL_UUID: &str = "00000000-0000-0000-0000-000000000000";

    /// Decode `cols` through the strict input, then range-check it.
    fn dimension(value: &Value) -> Result<u16, JsonrpcError> {
        let input: TerminalResizeInput =
            parse_strict_params(json!({ "terminal_id": NIL_UUID, "cols": value, "rows": 24 }))?;
        terminal_dimension(input.cols, "cols")
    }

    fn assert_invalid_params(result: Result<u16, JsonrpcError>) {
        match result {
            Err(e) => assert_eq!(e.code, JsonrpcErrorCode::InvalidParams),
            Ok(v) => panic!("expected invalid_params, got Ok({v})"),
        }
    }

    #[test]
    fn a_missing_terminal_is_a_plain_not_found() {
        let error = terminal_not_found(TerminalNotFound);
        assert_eq!(error.code, JsonrpcErrorCode::NotFound);
        assert_eq!(error.message, "terminal not found");
        assert!(error.data.is_none(), "nothing to tell unknown from foreign");
    }

    #[test]
    fn close_signals_are_sigterm_or_sigkill() {
        assert_eq!(close_signal(None).ok(), Some(libc::SIGTERM));
        assert_eq!(close_signal(Some("SIGTERM")).ok(), Some(libc::SIGTERM));
        assert_eq!(close_signal(Some("SIGKILL")).ok(), Some(libc::SIGKILL));
        for signal in ["SIGINT", "sigkill", "9", "", "SIGHUP"] {
            let error = close_signal(Some(signal)).expect_err(signal);
            assert_eq!(error.code, JsonrpcErrorCode::InvalidParams, "{signal}");
        }
    }

    #[test]
    fn terminal_cwd_must_be_absolute() {
        assert_eq!(terminal_cwd(None).ok(), Some(None));
        assert_eq!(terminal_cwd(Some("/tmp")).ok(), Some(Some("/tmp")));
        for cwd in ["", ".", "tmp", "~/dev", "../x"] {
            let error = terminal_cwd(Some(cwd)).expect_err(cwd);
            assert_eq!(error.code, JsonrpcErrorCode::InvalidParams, "{cwd:?}");
            assert_eq!(
                error.data.as_ref().and_then(|d| d.get("reason")),
                Some(&json!(ERROR_INVALID_PATH)),
                "{cwd:?}"
            );
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
        assert_invalid_params(
            parse_strict_params::<TerminalResizeInput>(json!({ "terminal_id": NIL_UUID }))
                .map(|_| 0),
        );
    }

    #[test]
    fn inputs_are_strict() {
        let create: TerminalCreateInput = parse_strict_params(json!({"command": "sh"})).unwrap();
        assert!(create.args.is_empty() && create.cwd.is_none());
        let create: TerminalCreateInput = parse_strict_params(json!({
            "command": "sh", "args": ["-c", "true"], "cwd": "/tmp", "preset_id": NIL_UUID
        }))
        .unwrap();
        assert_eq!(create.args, ["-c", "true"]);

        for params in [
            json!({"command": "sh", "extra": 1}),
            json!({"command": "sh", "args": null}),
            json!({"command": "sh", "cwd": null}),
            json!({"command": "sh", "preset_id": "not-a-uuid"}),
            json!({"command": "sh", "args": [1]}),
        ] {
            assert!(
                parse_strict_params::<TerminalCreateInput>(params.clone()).is_err(),
                "{params}"
            );
        }
        for params in [
            json!({"terminal_id": "abc", "data": "x"}),
            json!({"terminal_id": NIL_UUID, "data": "x", "extra": true}),
            json!({"terminal_id": NIL_UUID}),
        ] {
            assert!(
                parse_strict_params::<TerminalDataSendInput>(params.clone()).is_err(),
                "{params}"
            );
        }
        let close: TerminalCloseInput =
            parse_strict_params(json!({ "terminal_id": NIL_UUID })).unwrap();
        assert!(close.signal.is_none());
        assert!(
            parse_strict_params::<TerminalCloseInput>(
                json!({ "terminal_id": NIL_UUID, "signal": null })
            )
            .is_err()
        );
    }
}
