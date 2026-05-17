//! AI provider handlers — spine-backed signature.
//!
//! Migrates `provider_load_status` and `provider_update_api_key` to the
//! new shape. `completion_create` is intentionally NOT migrated in
//! Batch 5: it builds a `ProgressSender: 'static` closure around
//! `ctx.notify` (today `Arc<dyn Fn(&str, Value)>`, the spine's new
//! shape is `&dyn Fn(&str, &Value)` — borrowed). The migration requires
//! routing notifications through `Arc<ConnectionRegistry>` +
//! `ctx.connection_id` (the per-socket route) instead of capturing
//! `notify`, which is a separate small refactor better tackled in a
//! focused pass that also touches the streaming provider plumbing.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::JsonrpcError;
use serde::Serialize;
use serde_json::Value;

use crate::handlers::App;
use crate::provider::{self, ProviderName};
use crate::rpc;

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
