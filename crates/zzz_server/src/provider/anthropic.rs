use std::ops::ControlFlow;

use fuz_http::JsonrpcError;
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::{
    CompletionHandlerOptions, CompletionMessage, PROVIDER_ERROR_NEEDS_API_KEY, ProgressSender,
    ProviderStatus, ai_provider_error, common, sse,
};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const PROVIDER_NAME: &str = "claude";

// -- Provider state -----------------------------------------------------------

struct AnthropicState {
    client: Option<reqwest::Client>,
    cached_status: Option<ProviderStatus>,
}

/// Anthropic/Claude AI provider.
///
/// Uses the Messages API with optional SSE streaming.
/// State is behind `tokio::sync::RwLock` because:
/// - `set_api_key` writes from keeper RPC handlers
/// - `load_status` reads and caches status
pub struct AnthropicProvider {
    state: RwLock<AnthropicState>,
}

impl AnthropicProvider {
    pub fn new(api_key: Option<String>) -> Self {
        let client = api_key.map(|key| build_client(&key));
        Self {
            state: RwLock::new(AnthropicState {
                client,
                cached_status: None,
            }),
        }
    }

    pub async fn load_status(&self, reload: bool) -> ProviderStatus {
        let state = self.state.read().await;
        if !reload && let Some(ref status) = state.cached_status {
            return status.clone();
        }
        // Drop read lock before acquiring write lock
        let has_client = state.client.is_some();
        drop(state);

        let status = if has_client {
            ProviderStatus::available(PROVIDER_NAME)
        } else {
            ProviderStatus::unavailable(PROVIDER_NAME, PROVIDER_ERROR_NEEDS_API_KEY)
        };

        let mut state = self.state.write().await;
        state.cached_status = Some(status.clone());
        status
    }

    pub async fn set_api_key(&self, key: Option<String>) {
        let mut state = self.state.write().await;
        state.client = key.as_deref().map(build_client);
        state.cached_status = None;
    }

    pub async fn complete(
        &self,
        options: &CompletionHandlerOptions,
        progress_sender: Option<&ProgressSender>,
        signal: &CancellationToken,
    ) -> Result<Value, JsonrpcError> {
        // Clone the client (cheap — internally Arc'd) and release the lock
        // before the HTTP call. This avoids blocking set_api_key for the
        // duration of a potentially long-running streaming response.
        let client = {
            let state = self.state.read().await;
            state
                .client
                .clone()
                .ok_or_else(|| ai_provider_error(PROVIDER_NAME, PROVIDER_ERROR_NEEDS_API_KEY))?
        };

        let streaming = progress_sender.is_some();
        let body = build_request_body(options, streaming);

        let response: reqwest::Response = client
            .post(API_URL)
            .json(&body)
            .send()
            .await
            .map_err(|e: reqwest::Error| ai_provider_error(PROVIDER_NAME, &e.to_string()))?;

        let response =
            common::check_response_status(response, PROVIDER_NAME, parse_api_error).await?;

        if let (true, Some(sender)) = (streaming, progress_sender) {
            handle_streaming_response(response, options, sender, signal).await
        } else {
            handle_non_streaming_response(response, options).await
        }
    }
}

async fn handle_non_streaming_response(
    response: reqwest::Response,
    options: &CompletionHandlerOptions,
) -> Result<Value, JsonrpcError> {
    let api_response: Value = response
        .json::<Value>()
        .await
        .map_err(|e: reqwest::Error| {
            ai_provider_error(PROVIDER_NAME, &format!("failed to parse response: {e}"))
        })?;

    Ok(common::build_completion_response(
        PROVIDER_NAME,
        &options.model,
        &api_response,
    ))
}

async fn handle_streaming_response(
    response: reqwest::Response,
    options: &CompletionHandlerOptions,
    progress_sender: &ProgressSender,
    signal: &CancellationToken,
) -> Result<Value, JsonrpcError> {
    let mut accumulated_content = String::new();
    let mut message_id = String::new();
    let mut final_usage: Option<Value> = None;
    let mut stop_reason = String::from("end_turn");

    sse::consume_sse_stream(response, PROVIDER_NAME, signal, |event| {
        let Some(event_type) = event.event_type.as_deref() else {
            return ControlFlow::Continue(());
        };
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return ControlFlow::Continue(());
        };
        match event_type {
            "message_start" => {
                if let Some(id) = data
                    .get("message")
                    .and_then(|m| m.get("id"))
                    .and_then(Value::as_str)
                {
                    id.clone_into(&mut message_id);
                }
            }
            "content_block_delta" => {
                if let Some(text) = data
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                {
                    accumulated_content.push_str(text);
                    progress_sender(common::build_text_progress_chunk(text));
                }
            }
            "message_delta" => {
                if let Some(sr) = data
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(Value::as_str)
                {
                    sr.clone_into(&mut stop_reason);
                }
                if let Some(usage) = data.get("usage") {
                    final_usage = Some(usage.clone());
                }
            }
            _ => {}
        }
        ControlFlow::Continue(())
    })
    .await?;

    let api_response = json!({
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": accumulated_content}],
        "model": options.model,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": final_usage,
    });

    Ok(common::build_completion_response(
        PROVIDER_NAME,
        &options.model,
        &api_response,
    ))
}

// -- Request building ---------------------------------------------------------

fn build_request_body(options: &CompletionHandlerOptions, stream: bool) -> Value {
    let messages = build_messages(options.completion_messages.as_deref(), &options.prompt);
    let opts = &options.completion_options;

    let mut body = json!({
        "model": options.model,
        "max_tokens": opts.output_token_max,
        "stream": stream,
        "messages": messages,
    });

    let obj = body.as_object_mut().unwrap_or_else(|| unreachable!());

    if !opts.system_message.is_empty() {
        obj.insert("system".to_owned(), json!(opts.system_message));
    }
    if let Some(t) = opts.temperature {
        obj.insert("temperature".to_owned(), json!(t));
    }
    if let Some(k) = opts.top_k {
        obj.insert("top_k".to_owned(), json!(k));
    }
    if let Some(p) = opts.top_p {
        obj.insert("top_p".to_owned(), json!(p));
    }
    if let Some(ref seqs) = opts.stop_sequences
        && !seqs.is_empty()
    {
        obj.insert("stop_sequences".to_owned(), json!(seqs));
    }

    body
}

/// Convert `CompletionMessage[]` + prompt into the Anthropic messages format.
///
/// Filters out system role messages (system is passed as a separate field).
/// Appends the prompt as a final user message.
fn build_messages(completion_messages: Option<&[CompletionMessage]>, prompt: &str) -> Vec<Value> {
    let capacity = completion_messages.map_or(0, <[_]>::len) + 1; // +1 for prompt
    let mut messages: Vec<Value> = Vec::with_capacity(capacity);

    if let Some(msgs) = completion_messages {
        for msg in msgs {
            if msg.role == "system" {
                continue;
            }
            messages.push(json!({
                "role": msg.role,
                "content": [{"type": "text", "text": msg.content}],
            }));
        }
    }

    messages.push(json!({
        "role": "user",
        "content": [{"type": "text", "text": prompt}],
    }));

    messages
}

// -- HTTP client --------------------------------------------------------------

fn build_client(api_key: &str) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(val) = reqwest::header::HeaderValue::from_str(api_key) {
        headers.insert("x-api-key", val);
    }
    headers.insert(
        "anthropic-version",
        reqwest::header::HeaderValue::from_static(API_VERSION),
    );
    common::build_client_with_headers(headers)
}

// -- Error parsing ------------------------------------------------------------

/// Parse an Anthropic API error response body.
///
/// Anthropic errors look like: `{"type":"error","error":{"type":"...","message":"..."}}`
fn parse_api_error(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::CompletionOptions;

    fn opts() -> CompletionHandlerOptions {
        CompletionHandlerOptions {
            model: "claude-3-haiku".to_owned(),
            completion_options: CompletionOptions::default(),
            completion_messages: None,
            prompt: "hi".to_owned(),
        }
    }

    #[test]
    fn request_body_includes_stream_flag() {
        let body = build_request_body(&opts(), true);
        assert_eq!(body["stream"], true);
        let body = build_request_body(&opts(), false);
        assert_eq!(body["stream"], false);
    }

    #[test]
    fn request_body_omits_optional_fields_when_none() {
        let body = build_request_body(&opts(), false);
        assert!(body.get("temperature").is_none());
        assert!(body.get("top_k").is_none());
        assert!(body.get("top_p").is_none());
        assert!(body.get("stop_sequences").is_none());
        // system_message defaults to "" — skipped
        assert!(body.get("system").is_none());
    }

    #[test]
    fn request_body_includes_optional_fields_when_set() {
        let mut o = opts();
        o.completion_options.temperature = Some(0.5);
        o.completion_options.top_p = Some(0.9);
        o.completion_options.top_k = Some(40);
        o.completion_options.system_message = "be concise".to_owned();
        o.completion_options.stop_sequences = Some(vec!["END".to_owned()]);
        let body = build_request_body(&o, false);
        assert_eq!(body["temperature"], 0.5);
        assert_eq!(body["top_p"], 0.9);
        assert_eq!(body["top_k"], 40);
        assert_eq!(body["system"], "be concise");
        assert_eq!(body["stop_sequences"], json!(["END"]));
    }

    #[test]
    fn request_body_omits_empty_stop_sequences() {
        let mut o = opts();
        o.completion_options.stop_sequences = Some(vec![]);
        let body = build_request_body(&o, false);
        assert!(body.get("stop_sequences").is_none());
    }

    #[test]
    fn messages_appends_prompt_as_user() {
        let m = build_messages(None, "hello");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["role"], "user");
        assert_eq!(m[0]["content"][0]["text"], "hello");
        assert_eq!(m[0]["content"][0]["type"], "text");
    }

    #[test]
    fn messages_filters_system_role() {
        let history = vec![
            CompletionMessage {
                role: "system".to_owned(),
                content: "ignored".to_owned(),
            },
            CompletionMessage {
                role: "assistant".to_owned(),
                content: "prior".to_owned(),
            },
        ];
        let m = build_messages(Some(&history), "now");
        // assistant kept + prompt appended; system dropped
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["role"], "assistant");
        assert_eq!(m[0]["content"][0]["text"], "prior");
        assert_eq!(m[1]["role"], "user");
        assert_eq!(m[1]["content"][0]["text"], "now");
    }

    #[test]
    fn parse_api_error_extracts_message() {
        let body = r#"{"type":"error","error":{"type":"x","message":"key invalid"}}"#;
        assert_eq!(parse_api_error(body).as_deref(), Some("key invalid"));
    }

    #[test]
    fn parse_api_error_returns_none_on_malformed_input() {
        assert!(parse_api_error("not json").is_none());
        assert!(parse_api_error(r#"{"no":"error"}"#).is_none());
        assert!(parse_api_error(r#"{"error":{"type":"x"}}"#).is_none());
    }
}
