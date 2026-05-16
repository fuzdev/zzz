//! AI provider handlers — status, key updates, completion streaming.

use std::sync::Arc;

use fuz_common::JsonRpcError;
use serde::Serialize;
use serde_json::Value;

use crate::provider::{self, CompletionHandlerOptions, ProviderName};
use crate::rpc;

use super::Ctx;

#[derive(Serialize)]
struct ProviderStatusResult {
    status: provider::ProviderStatus,
}

pub(super) async fn handle_provider_load_status(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
    let name_str = params
        .get("provider_name")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'provider_name' parameter"))?;

    let provider_name: ProviderName = serde_json::from_value(Value::String(name_str.to_owned()))
        .map_err(|_| rpc::invalid_params(&format!("unknown provider: {name_str}")))?;

    let reload = params
        .get("reload")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let provider = ctx.app.provider_manager.require(provider_name)?;
    let status = provider.load_status(reload).await;

    serde_json::to_value(ProviderStatusResult { status })
        .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_provider_update_api_key(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
    let name_str = params
        .get("provider_name")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'provider_name' parameter"))?;

    let provider_name: ProviderName = serde_json::from_value(Value::String(name_str.to_owned()))
        .map_err(|_| rpc::invalid_params(&format!("unknown provider: {name_str}")))?;

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
        .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_completion_create(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
    let request = params
        .get("completion_request")
        .ok_or_else(|| rpc::invalid_params("missing 'completion_request' parameter"))?;

    let provider_name_str = request
        .get("provider_name")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing 'provider_name' in completion_request"))?;

    let provider_name: ProviderName =
        serde_json::from_value(Value::String(provider_name_str.to_owned()))
            .map_err(|_| rpc::invalid_params(&format!("unknown provider: {provider_name_str}")))?;

    let model = request
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing 'model' in completion_request"))?
        .to_owned();

    let prompt = request
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing 'prompt' in completion_request"))?
        .to_owned();

    let completion_messages: Option<Vec<provider::CompletionMessage>> = request
        .get("completion_messages")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    let progress_token = params
        .get("_meta")
        .and_then(|m| m.get("progressToken"))
        .and_then(Value::as_str)
        .map(String::from);

    let completion_options = ctx.app.completion_options.clone();

    let handler_options = CompletionHandlerOptions {
        model,
        completion_options,
        completion_messages,
        prompt,
        progress_token: progress_token.clone(),
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
