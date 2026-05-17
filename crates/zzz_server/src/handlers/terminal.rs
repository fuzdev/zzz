//! Terminal handlers — PTY spawn, write, resize, close.

use std::sync::Arc;

use fuz_common::JsonRpcError;
use serde::Serialize;
use serde_json::Value;

use crate::rpc;

use super::Ctx;

#[derive(Serialize)]
struct TerminalCreateResult {
    terminal_id: String,
}

#[derive(Serialize)]
struct TerminalCloseResult {
    exit_code: Option<i32>,
}

pub(super) async fn handle_terminal_create(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'command' parameter"))?;

    let args: Vec<String> = match params.get("args") {
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|v| {
                v.as_str()
                    .map(String::from)
                    .ok_or_else(|| rpc::invalid_params("args must be an array of strings"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(Value::Null) | None => vec![],
        _ => return Err(rpc::invalid_params("args must be an array of strings")),
    };

    let cwd = params.get("cwd").and_then(Value::as_str);

    let terminal_id = uuid::Uuid::new_v4().to_string();

    ctx.app
        .pty_manager
        .spawn(&terminal_id, command, &args, cwd, Arc::clone(&ctx.app_arc))
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to create terminal: {e}")))?;

    serde_json::to_value(TerminalCreateResult { terminal_id })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

pub(super) async fn handle_terminal_data_send(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'terminal_id' parameter"))?;

    let data = params
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'data' parameter"))?;

    // No-ops silently if terminal doesn't exist (matching Deno behavior)
    ctx.app.pty_manager.write(terminal_id, data).await;

    Ok(Value::Null)
}

pub(super) async fn handle_terminal_resize(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'terminal_id' parameter"))?;

    let cols = params
        .get("cols")
        .and_then(Value::as_u64)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'cols' parameter"))?;

    let rows = params
        .get("rows")
        .and_then(Value::as_u64)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'rows' parameter"))?;

    #[expect(
        clippy::cast_possible_truncation,
        reason = "terminal dimensions fit u16"
    )]
    {
        ctx.app
            .pty_manager
            .resize(terminal_id, cols as u16, rows as u16)
            .await;
    }

    Ok(Value::Null)
}

pub(super) async fn handle_terminal_close(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'terminal_id' parameter"))?;

    let signal_str = params
        .get("signal")
        .and_then(Value::as_str)
        .unwrap_or("SIGTERM");

    let signal = match signal_str {
        "SIGKILL" => libc::SIGKILL,
        _ => libc::SIGTERM,
    };

    let exit_code = ctx
        .app
        .pty_manager
        .kill(terminal_id, signal)
        .await
        .flatten();

    serde_json::to_value(TerminalCloseResult { exit_code })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}
