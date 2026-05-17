//! AI provider handlers — status, key updates, completion streaming.

use std::sync::Arc;

use fuz_http::JsonrpcError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider::{self, CompletionHandlerOptions, ProviderName};
use crate::rpc;

use super::Ctx;

/// Strongly-typed view of the `completion_request` param object.
///
/// Deserialized in one pass from `&Value` (zero JSON-tree cloning) — the
/// older field-by-field `as_str()` walk plus a `Value::clone()` on
/// `completion_messages` allocated the entire history subtree per request.
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

pub(super) async fn handle_provider_load_status(
    params: &Value,
    ctx: &Ctx<'_>,
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

    let provider = ctx.app.provider_manager.require(provider_name)?;
    let status = provider.load_status(reload).await;

    serde_json::to_value(ProviderStatusResult { status })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

pub(super) async fn handle_provider_update_api_key(
    params: &Value,
    ctx: &Ctx<'_>,
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

    let provider = ctx.app.provider_manager.require(provider_name)?;
    provider.set_api_key(Some(api_key.to_owned())).await;
    let status = provider.load_status(true).await;

    serde_json::to_value(ProviderStatusResult { status })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

pub(super) async fn handle_completion_create(
    params: &Value,
    ctx: &Ctx<'_>,
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

    let completion_options = ctx.app.completion_options.clone();

    let handler_options = CompletionHandlerOptions {
        model: request.model,
        completion_options,
        completion_messages: request.completion_messages,
        prompt: request.prompt,
    };

    let progress_sender: Option<provider::ProgressSender> = progress_token.as_ref().map(|token| {
        let notify = Arc::clone(&ctx.notify);
        let token = token.clone();
        let sender: provider::ProgressSender = Box::new(move |chunk: Value| {
            notify(
                "completion_progress",
                serde_json::json!({
                    "chunk": chunk,
                    "_meta": { "progressToken": token },
                }),
            );
        });
        sender
    });

    let provider = ctx.app.provider_manager.require(provider_name)?;
    let mut result = provider
        .complete(&handler_options, progress_sender.as_ref(), &ctx.signal)
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
