use std::ops::ControlFlow;
use std::time::Duration;

use fuz_http::JsonrpcError;
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::{
    CompletionHandlerOptions, CompletionMessage, PROVIDER_ERROR_NOT_INSTALLED, ProgressSender,
    ProviderStatus, ai_provider_error, common, ndjson,
};

const API_BASE: &str = "http://127.0.0.1:11434";
const PROVIDER_NAME: &str = "ollama";
const STATUS_TIMEOUT: Duration = Duration::from_millis(1500);

struct OllamaState {
    cached_status: Option<ProviderStatus>,
    client: reqwest::Client,
}

/// Ollama local AI provider.
///
/// Talks to a locally-running Ollama daemon at `127.0.0.1:11434`. No
/// auth — relies on loopback isolation. Streaming is NDJSON.
pub struct OllamaProvider {
    state: RwLock<OllamaState>,
}

impl OllamaProvider {
    pub fn new() -> Self {
        Self {
            state: RwLock::new(OllamaState {
                cached_status: None,
                client: common::build_client_with_headers(reqwest::header::HeaderMap::new()),
            }),
        }
    }

    pub async fn load_status(&self, reload: bool) -> ProviderStatus {
        let client = {
            let state = self.state.read().await;
            if !reload && let Some(ref status) = state.cached_status {
                return status.clone();
            }
            state.client.clone()
        };

        let status = match client
            .get(format!("{API_BASE}/api/tags"))
            .timeout(STATUS_TIMEOUT)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => ProviderStatus::available(PROVIDER_NAME),
            Ok(response) => ProviderStatus::unavailable(
                PROVIDER_NAME,
                &format!("ollama responded with {}", response.status()),
            ),
            Err(_) => ProviderStatus::unavailable(PROVIDER_NAME, PROVIDER_ERROR_NOT_INSTALLED),
        };

        let mut state = self.state.write().await;
        state.cached_status = Some(status.clone());
        status
    }

    pub async fn complete(
        &self,
        options: &CompletionHandlerOptions,
        progress_sender: Option<&ProgressSender>,
        signal: &CancellationToken,
    ) -> Result<Value, JsonrpcError> {
        let client = {
            let state = self.state.read().await;
            state.client.clone()
        };

        let streaming = progress_sender.is_some();
        let body = build_request_body(options, streaming);

        let response = client
            .post(format!("{API_BASE}/api/chat"))
            .json(&body)
            .send()
            .await
            .map_err(|e| ai_provider_error(PROVIDER_NAME, &e.to_string()))?;

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
    let api_response: Value = response.json::<Value>().await.map_err(|e| {
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
    let mut final_chunk: Option<Value> = None;

    ndjson::consume_ndjson_stream(response, PROVIDER_NAME, signal, |chunk| {
        if let Some(content) = chunk
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            && !content.is_empty()
        {
            accumulated_content.push_str(content);
        }

        // Ollama's chunk shape already matches the CompletionProgressInput
        // schema, so forward it directly rather than rebuilding.
        progress_sender(chunk.clone());

        final_chunk = Some(chunk);
        ControlFlow::Continue(())
    })
    .await?;

    // Merge accumulated text back into the last chunk so the final
    // response carries the full assistant content (matches TS's spread).
    let mut api_response = final_chunk.unwrap_or_else(|| json!({}));
    if let Some(obj) = api_response.as_object_mut() {
        let message = obj
            .entry("message")
            .or_insert_with(|| json!({"role": "assistant", "content": ""}));
        if let Some(msg_obj) = message.as_object_mut() {
            msg_obj.insert("content".to_owned(), json!(accumulated_content));
        }
    }

    Ok(common::build_completion_response(
        PROVIDER_NAME,
        &options.model,
        &api_response,
    ))
}

// -- Request building ---------------------------------------------------------

fn build_request_body(options: &CompletionHandlerOptions, stream: bool) -> Value {
    let messages = build_messages(
        &options.completion_options.system_message,
        options.completion_messages.as_deref(),
        &options.prompt,
    );
    let opts = &options.completion_options;

    let mut ollama_options = serde_json::Map::new();
    ollama_options.insert("num_predict".to_owned(), json!(opts.output_token_max));
    if let Some(t) = opts.temperature {
        ollama_options.insert("temperature".to_owned(), json!(t));
    }
    if let Some(s) = opts.seed {
        ollama_options.insert("seed".to_owned(), json!(s));
    }
    if let Some(k) = opts.top_k {
        ollama_options.insert("top_k".to_owned(), json!(k));
    }
    if let Some(p) = opts.top_p {
        ollama_options.insert("top_p".to_owned(), json!(p));
    }
    if let Some(f) = opts.frequency_penalty {
        ollama_options.insert("frequency_penalty".to_owned(), json!(f));
    }
    if let Some(p) = opts.presence_penalty {
        ollama_options.insert("presence_penalty".to_owned(), json!(p));
    }
    if let Some(ref seqs) = opts.stop_sequences
        && !seqs.is_empty()
    {
        ollama_options.insert("stop".to_owned(), json!(seqs));
    }

    json!({
        "model": options.model,
        "stream": stream,
        "options": Value::Object(ollama_options),
        "messages": messages,
    })
}

fn build_messages(
    system_message: &str,
    completion_messages: Option<&[CompletionMessage]>,
    prompt: &str,
) -> Vec<Value> {
    let capacity = completion_messages.map_or(0, <[_]>::len) + 2;
    let mut messages = Vec::with_capacity(capacity);

    messages.push(json!({
        "role": "system",
        "content": system_message,
    }));

    if let Some(msgs) = completion_messages {
        for msg in msgs {
            messages.push(json!({
                "role": msg.role,
                "content": msg.content,
            }));
        }
    }

    messages.push(json!({
        "role": "user",
        "content": prompt,
    }));

    messages
}

// -- Error parsing ------------------------------------------------------------

/// Parse an Ollama API error response body.
///
/// Ollama errors typically have shape `{"error": "..."}` (string, not
/// object — unlike OpenAI/Anthropic/Gemini).
fn parse_api_error(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("error").and_then(Value::as_str).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::CompletionOptions;

    fn opts() -> CompletionHandlerOptions {
        CompletionHandlerOptions {
            model: "llama3".to_owned(),
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
    fn request_body_uses_options_object_with_snake_case() {
        let mut o = opts();
        o.completion_options.temperature = Some(0.4);
        o.completion_options.seed = Some(123);
        o.completion_options.top_k = Some(40);
        o.completion_options.top_p = Some(0.9);
        o.completion_options.frequency_penalty = Some(0.1);
        o.completion_options.presence_penalty = Some(0.2);
        o.completion_options.stop_sequences = Some(vec!["END".to_owned()]);
        let body = build_request_body(&o, true);
        let oo = &body["options"];
        assert!(oo["num_predict"].is_number());
        assert_eq!(oo["temperature"], 0.4);
        assert_eq!(oo["seed"], 123);
        assert_eq!(oo["top_k"], 40);
        assert_eq!(oo["top_p"], 0.9);
        assert_eq!(oo["frequency_penalty"], 0.1);
        assert_eq!(oo["presence_penalty"], 0.2);
        assert_eq!(oo["stop"], json!(["END"]));
    }

    #[test]
    fn messages_always_open_with_system_close_with_prompt() {
        let history = vec![
            CompletionMessage {
                role: "user".to_owned(),
                content: "earlier".to_owned(),
            },
            CompletionMessage {
                role: "assistant".to_owned(),
                content: "reply".to_owned(),
            },
        ];
        let m = build_messages("sys", Some(&history), "now");
        assert_eq!(m.len(), 4);
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[0]["content"], "sys");
        assert_eq!(m[1]["role"], "user");
        assert_eq!(m[1]["content"], "earlier");
        assert_eq!(m[2]["role"], "assistant");
        assert_eq!(m[3]["role"], "user");
        assert_eq!(m[3]["content"], "now");
    }

    #[test]
    fn messages_with_empty_system_still_emits_system_slot() {
        // Parity with TS: system message always present (even empty),
        // matches `[{role:'system', content: system_message}, ...]`.
        let m = build_messages("", None, "hi");
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[0]["content"], "");
    }

    #[test]
    fn parse_api_error_extracts_string_error() {
        let body = r#"{"error":"model not found"}"#;
        assert_eq!(parse_api_error(body).as_deref(), Some("model not found"));
    }

    #[test]
    fn parse_api_error_returns_none_when_error_missing_or_wrong_shape() {
        assert!(parse_api_error("xxx").is_none());
        assert!(parse_api_error(r#"{"other":"x"}"#).is_none());
        // Object-shaped errors (not the Ollama shape) return None — let
        // the caller fall back to the raw body.
        assert!(parse_api_error(r#"{"error":{"message":"x"}}"#).is_none());
    }
}
