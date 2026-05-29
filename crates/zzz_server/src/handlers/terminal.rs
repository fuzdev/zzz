//! Terminal handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` provides the `PtyManager` reach-through.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::JsonrpcError;
use serde::Serialize;
use serde_json::Value;

use crate::handlers::App;
use crate::rpc;

#[derive(Serialize)]
struct TerminalCreateResult {
    terminal_id: String,
}

#[derive(Serialize)]
struct TerminalCloseResult {
    exit_code: Option<i32>,
}

pub async fn terminal_create(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
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

    app.pty_manager
        .spawn(&terminal_id, command, &args, cwd, Arc::clone(&app))
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to create terminal: {e}")))?;

    serde_json::to_value(TerminalCreateResult { terminal_id })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

pub async fn terminal_data_send(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'terminal_id' parameter"))?;

    let data = params
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'data' parameter"))?;

    app.pty_manager.write(terminal_id, data).await;

    Ok(Value::Null)
}

pub async fn terminal_resize(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
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
        app.pty_manager
            .resize(terminal_id, cols as u16, rows as u16)
            .await;
    }

    Ok(Value::Null)
}

pub async fn terminal_close(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
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

    let exit_code = app.pty_manager.kill(terminal_id, signal).await.flatten();

    serde_json::to_value(TerminalCloseResult { exit_code })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}
