//! AI provider handlers — spine-backed signature.
//!
//! Migrates `provider_load_status`, `provider_update_api_key`, and (Phase 7
//! sub-batch C) `completion_create` to the new shape. The `completion_create`
//! reshape routes streaming progress notifications via
//! `Arc<fuz_realtime::ConnectionRegistry>::send_to(conn_id, …)` instead of
//! capturing the legacy `Arc<NotifyFn>` — `ctx.connection_id` carries the
//! per-socket route on WS, `None` on HTTP. HTTP callers omit the progress
//! token (or pass one with no WS counterpart) and receive the full result
//! without intermediate chunks.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::JsonrpcError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::handlers::App;
use crate::provider::{self, CompletionHandlerOptions, ProviderName};
use crate::rpc;

/// Strongly-typed view of the `completion_request` param object.
///
/// Deserialized in one pass from `&Value` (zero JSON-tree cloning).
/// Mirrors the legacy `handlers::provider::CompletionRequestInput`.
#[derive(Deserialize)]
struct CompletionRequestInput {
    provider_name: String,
    model: String,
    prompt: String,
    #[serde(default)]
    completion_messages: Option<Vec<provider::CompletionMessage>>,
}

#[derive(Serialize)]
struct ProviderStatusResult {
    status: provider::ProviderStatus,
}

pub async fn provider_load_status(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let name_str = params
        .get("provider_name")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'provider_name' parameter"))?;

    let provider_name = ProviderName::parse(name_str)
        .ok_or_else(|| rpc::invalid_params(&format!("unknown provider: {name_str}")))?;

    let reload = params
        .get("reload")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let provider = app.provider_manager.require(provider_name)?;
    let status = provider.load_status(reload).await;

    serde_json::to_value(ProviderStatusResult { status })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

pub async fn provider_update_api_key(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let name_str = params
        .get("provider_name")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'provider_name' parameter"))?;

    let provider_name = ProviderName::parse(name_str)
        .ok_or_else(|| rpc::invalid_params(&format!("unknown provider: {name_str}")))?;

    if provider_name == ProviderName::Ollama {
        return Err(rpc::invalid_params("Ollama does not require an API key"));
    }

    let api_key = params
        .get("api_key")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'api_key' parameter"))?;

    let provider = app.provider_manager.require(provider_name)?;
    provider.set_api_key(Some(api_key.to_owned())).await;
    let status = provider.load_status(true).await;

    serde_json::to_value(ProviderStatusResult { status })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

/// Start an AI completion, streaming progress to the originating WS socket.
///
/// On WS: when the caller passes a `_meta.progressToken`, builds a
/// `ProgressSender` closure capturing `Arc<ConnectionRegistry>` + the
/// per-socket `ConnectionId` from `ctx.connection_id`. Each provider chunk
/// is wrapped in a `completion_progress` JSON-RPC notification and routed
/// via `ConnectionRegistry::send_to(conn_id, …)`. The closure is `'static`
/// (the borrowed spine `notify` shape can't be captured into a
/// `ProgressSender: 'static` directly — the per-connection registry route
/// is the right wire for streaming).
///
/// On HTTP: `ctx.connection_id` is `None`, so no streaming. The caller
/// still receives the full result envelope.
///
/// Cancellation: passes `ctx.signal` through to the provider — per-socket
/// on WS (cancelled on disconnect or audit-driven revocation), fresh
/// per-request on HTTP.
pub async fn completion_create(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let request_value = params
        .get("completion_request")
        .ok_or_else(|| rpc::invalid_params("missing 'completion_request' parameter"))?;

    let request = CompletionRequestInput::deserialize(request_value)
        .map_err(|e| rpc::invalid_params(&format!("invalid completion_request: {e}")))?;

    let provider_name = ProviderName::parse(&request.provider_name).ok_or_else(|| {
        rpc::invalid_params(&format!("unknown provider: {}", request.provider_name))
    })?;

    let progress_token = params
        .get("_meta")
        .and_then(|m| m.get("progressToken"))
        .and_then(Value::as_str)
        .map(String::from);

    let completion_options = app.completion_options.clone();

    let handler_options = CompletionHandlerOptions {
        model: request.model,
        completion_options,
        completion_messages: request.completion_messages,
        prompt: request.prompt,
    };

    // Build the per-request `ProgressSender` only when both a progress
    // token and a WS connection are available. On HTTP (`connection_id =
    // None`) or when the caller omitted `_meta.progressToken`, the
    // sender is `None` and the provider runs in non-streaming mode.
    let progress_sender: Option<provider::ProgressSender> = match (
        progress_token.as_ref(),
        ctx.connection_id,
    ) {
        (Some(token), Some(conn_id)) => {
            let realtime = Arc::clone(&app.realtime);
            let token = token.clone();
            let sender: provider::ProgressSender = Box::new(move |chunk: Value| {
                let payload = serde_json::json!({
                    "chunk": chunk,
                    "_meta": { "progressToken": token },
                });
                let wire = rpc::notification("completion_progress", &payload);
                realtime.send_to(conn_id, &wire);
            });
            Some(sender)
        }
        _ => None,
    };

    let provider = app.provider_manager.require(provider_name)?;
    let mut result = provider
        .complete(&handler_options, progress_sender.as_ref(), ctx.signal)
        .await?;

    if let Some(token) = &progress_token
        && let Some(obj) = result.as_object_mut()
    {
        obj.insert(
            "_meta".to_owned(),
            serde_json::json!({"progressToken": token}),
        );
    }

    Ok(result)
}
