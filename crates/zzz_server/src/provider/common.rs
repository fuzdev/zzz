//! Shared helpers used by every provider implementation.
//!
//! `build_completion_response` wraps a provider's final payload in the
//! discriminated-union envelope the frontend expects.
//! `build_text_progress_chunk` produces the uniform streaming-chunk shape
//! `{message: {role, content}}` that the three text-streaming providers
//! emit on every delta. Ollama passes its raw NDJSON chunks through
//! directly (they already match the wire schema), so the helper isn't
//! used there.

use fuz_common::JsonRpcError;
use reqwest::header::HeaderMap;
use serde_json::{Value, json};

use super::ai_provider_error;

/// Wrap a provider-native response in the `completion_response` envelope.
///
/// `provider_name` doubles as the `data.type` discriminator — per the TS
/// `ProviderData` schema the two always match.
pub fn build_completion_response(provider_name: &str, model: &str, data_value: &Value) -> Value {
    json!({
        "completion_response": {
            "created": fuz_common::rfc3339_now(),
            "provider_name": provider_name,
            "model": model,
            "data": {
                "type": provider_name,
                "value": data_value,
            },
        },
    })
}

/// Uniform streaming-chunk shape for text-only providers.
///
/// Matches the TS `CompletionProgressInput.chunk` schema's text-delta
/// shape: `{message: {role: 'assistant', content}}`. Ollama emits its
/// own chunk shape (with `done`, `created_at`, etc.) and bypasses this.
pub fn build_text_progress_chunk(content: &str) -> Value {
    json!({
        "message": {
            "role": "assistant",
            "content": content,
        }
    })
}

/// Build a `reqwest::Client` with the given default headers, falling back
/// to a bare client if header construction fails.
pub fn build_client_with_headers(headers: HeaderMap) -> reqwest::Client {
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Pass `response` through on success; on non-2xx, read the body, run
/// `parse_api_error` over it, and return a provider-tagged JSON-RPC
/// error. Each provider's wire format for errors differs (Anthropic,
/// `OpenAI`, Gemini wrap under `error.message`; Ollama uses a plain
/// `error` string), so the parser is supplied per call.
pub async fn check_response_status<F>(
    response: reqwest::Response,
    provider_name: &str,
    parse_api_error: F,
) -> Result<reqwest::Response, JsonRpcError>
where
    F: FnOnce(&str) -> Option<String>,
{
    if response.status().is_success() {
        return Ok(response);
    }
    let error_body = response
        .text()
        .await
        .unwrap_or_else(|_| String::from("unknown error"));
    let error_msg = parse_api_error(&error_body).unwrap_or(error_body);
    Err(ai_provider_error(provider_name, &error_msg))
}
