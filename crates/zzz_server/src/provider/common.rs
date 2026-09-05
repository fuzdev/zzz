//! Shared helpers used by every provider implementation.
//!
//! `build_completion_response` wraps a provider's final payload in the
//! discriminated-union envelope the frontend expects.
//! `build_text_progress_chunk` produces the uniform streaming-chunk shape
//! `{message: {role, content}}` that the text-streaming providers emit on
//! every delta.

use fuz_http::JsonrpcError;
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
            "created": fuz_sys::rfc3339_now(),
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
/// shape: `{message: {role: 'assistant', content}}`.
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
    // reqwest uses `rustls-no-provider`; install the `ring` provider first.
    fuz_sys::tls::ensure_crypto_provider();
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Pass `response` through on success; on non-2xx, read the body, run
/// `parse_api_error` over it, and return a provider-tagged JSON-RPC
/// error. Each provider's wire format for errors differs (Anthropic,
/// `OpenAI`, Gemini wrap under `error.message`), so the parser is supplied
/// per call.
pub async fn check_response_status<F>(
    response: reqwest::Response,
    provider_name: &str,
    parse_api_error: F,
) -> Result<reqwest::Response, JsonrpcError>
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_response_envelope() {
        let value = build_completion_response("claude", "claude-3", &json!({"x": 1}));
        let resp = &value["completion_response"];
        assert_eq!(resp["provider_name"], "claude");
        assert_eq!(resp["model"], "claude-3");
        assert_eq!(resp["data"]["type"], "claude");
        assert_eq!(resp["data"]["value"], json!({"x": 1}));
        assert!(
            resp["created"].is_string(),
            "created should be RFC3339 string"
        );
    }

    #[test]
    fn completion_response_data_type_matches_provider_name() {
        for name in ["claude", "chatgpt", "gemini"] {
            let value = build_completion_response(name, "m", &Value::Null);
            assert_eq!(value["completion_response"]["provider_name"], name);
            assert_eq!(value["completion_response"]["data"]["type"], name);
        }
    }

    #[test]
    fn text_progress_chunk_shape() {
        let chunk = build_text_progress_chunk("hello");
        assert_eq!(chunk["message"]["role"], "assistant");
        assert_eq!(chunk["message"]["content"], "hello");
    }

    #[test]
    fn text_progress_chunk_empty_content_preserved() {
        let chunk = build_text_progress_chunk("");
        assert_eq!(chunk["message"]["content"], "");
    }
}
