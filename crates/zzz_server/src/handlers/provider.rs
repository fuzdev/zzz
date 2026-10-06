//! AI provider handlers.
//!
//! `provider_load_status` and `completion_create`.
//!
//! There is no runtime API-key setter. Provider keys come from the process
//! environment (`SECRET_ANTHROPIC_API_KEY` / `SECRET_OPENAI_API_KEY` /
//! `SECRET_GOOGLE_API_KEY`) and nowhere else.
//! `completion_create` routes streaming progress notifications via
//! `Arc<fuz_realtime::ConnectionRegistry>::send_to(conn_id, …)` — `ctx.connection_id`
//! carries the per-socket route on WS, `None` on HTTP. HTTP callers omit the
//! progress token (or pass one with no WS counterpart) and receive the full
//! result without intermediate chunks.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::{
    JsonrpcError, internal_error_with_source, invalid_params, notification, parse_strict_params,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::handlers::App;
use crate::provider::{self, CompletionHandlerOptions, ProviderName};

// -- Inputs (twins of the input schemas in `action_specs.ts`) -----------------

/// Input for `provider_load_status` — twin of `ProviderLoadStatusInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderLoadStatusInput {
    provider_name: String,
    /// Absent means reload — the TS schema defaults it to `true`.
    #[serde(default)]
    reload: Option<bool>,
}

/// Input for `completion_create` — twin of `CompletionCreateInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletionCreateInput {
    completion_request: CompletionRequestInput,
    #[serde(default, rename = "_meta")]
    meta: Option<ProgressMeta>,
}

/// Twin of `CompletionRequest` (strict).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletionRequestInput {
    /// `DatetimeNow` — defaulted client-side; accepted and unused.
    #[serde(default, deserialize_with = "crate::handlers::present")]
    #[allow(dead_code, reason = "decoded for input validation only")]
    created: Option<String>,
    provider_name: String,
    model: String,
    prompt: String,
    #[serde(default, deserialize_with = "crate::handlers::present")]
    completion_messages: Option<Vec<provider::CompletionMessage>>,
}

/// Twin of `ProgressMeta` — a `z.looseObject`, so unknown keys pass.
#[derive(Deserialize)]
struct ProgressMeta {
    #[serde(
        default,
        rename = "progressToken",
        deserialize_with = "crate::handlers::present"
    )]
    progress_token: Option<String>,
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
    let input: ProviderLoadStatusInput = parse_strict_params(params)?;
    let provider_name = ProviderName::parse(&input.provider_name).ok_or_else(|| {
        invalid_params(&format!("unknown provider: {}", input.provider_name), None)
    })?;
    let reload = input.reload.unwrap_or(true);

    let provider = app.provider_manager.require(provider_name)?;
    let status = provider.load_status(reload).await;

    serde_json::to_value(ProviderStatusResult { status })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
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
/// Cancellation: passes `ctx.signal` through to the provider. On WS it's a
/// per-request child of the socket's token — fired alone by a `cancel`
/// notification naming this request, or with the whole socket on disconnect
/// or audit-driven revocation. On HTTP it's fresh per request. The provider races every upstream
/// await (send, body, stream) against it, and a cancelled completion returns
/// `request_cancelled` rather than a truncated success.
///
/// # Errors
///
/// `invalid_params` for a malformed request, an unknown provider, or a blank
/// prompt; `request_cancelled` when cancelled; otherwise the provider's
/// error — including a provider error sent mid-stream and a stream that ends
/// without the provider's terminal event (the frontend keeps any text that
/// already streamed and shows the error alongside it).
pub async fn completion_create(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let CompletionCreateInput {
        completion_request: request,
        meta,
    } = parse_strict_params(params)?;

    let provider_name = ProviderName::parse(&request.provider_name).ok_or_else(|| {
        invalid_params(
            &format!("unknown provider: {}", request.provider_name),
            None,
        )
    })?;

    // An empty prompt would be sent upstream as an empty user message, which
    // providers reject (Anthropic 400s on empty text blocks) — refuse it here
    // with a clear error instead of spending a provider round trip.
    if provider::common::is_blank(&request.prompt) {
        return Err(invalid_params(
            "completion_request.prompt must not be empty",
            None,
        ));
    }

    let progress_token = meta.and_then(|m| m.progress_token);
    if let Some(token) = &progress_token
        && !fuz_auth::is_valid_uuid(token)
    {
        return Err(invalid_params(
            "invalid params: _meta.progressToken must be a uuid",
            None,
        ));
    }

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
    let progress_sender: Option<provider::ProgressSender> =
        match (progress_token.as_ref(), ctx.connection_id) {
            (Some(token), Some(conn_id)) => {
                let realtime = Arc::clone(&app.realtime);
                let token = token.clone();
                let sender: provider::ProgressSender = Box::new(move |chunk: Value| {
                    let payload = serde_json::json!({
                        "chunk": chunk,
                        "_meta": { "progressToken": token },
                    });
                    let wire = notification("completion_progress", &payload);
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
