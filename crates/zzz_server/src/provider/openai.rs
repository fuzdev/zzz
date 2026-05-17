use std::ops::ControlFlow;

use fuz_http::JsonrpcError;
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::{
    CompletionHandlerOptions, CompletionMessage, PROVIDER_ERROR_NEEDS_API_KEY, ProgressSender,
    ProviderStatus, ai_provider_error, common, sse,
};

const API_URL: &str = "https://api.openai.com/v1/chat/completions";
const PROVIDER_NAME: &str = "chatgpt";
const SSE_DONE_MARKER: &str = "[DONE]";

struct OpenAiState {
    client: Option<reqwest::Client>,
    cached_status: Option<ProviderStatus>,
}

/// OpenAI/ChatGPT AI provider.
///
/// Uses the Chat Completions API with optional SSE streaming.
pub struct OpenAiProvider {
    state: RwLock<OpenAiState>,
}

impl OpenAiProvider {
    pub fn new(api_key: Option<String>) -> Self {
        let client = api_key.map(|key| build_client(&key));
        Self {
            state: RwLock::new(OpenAiState {
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
        let client = {
            let state = self.state.read().await;
            state
                .client
                .clone()
                .ok_or_else(|| ai_provider_error(PROVIDER_NAME, PROVIDER_ERROR_NEEDS_API_KEY))?
        };

        let streaming = progress_sender.is_some();
        let body = build_request_body(options, streaming);

        let response = client
            .post(API_URL)
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
    let mut completion_id = String::new();
    let mut finish_reason: Option<String> = None;
    let mut final_usage: Option<Value> = None;

    sse::consume_sse_stream(response, PROVIDER_NAME, signal, |event| {
        // OpenAI signals the end of the stream with `data: [DONE]` — not
        // valid JSON, so detect it before parsing.
        if event.data.trim() == SSE_DONE_MARKER {
            return ControlFlow::Break(());
        }
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return ControlFlow::Continue(());
        };

        if completion_id.is_empty()
            && let Some(id) = data.get("id").and_then(Value::as_str)
        {
            id.clone_into(&mut completion_id);
        }

        let choice = data.get("choices").and_then(|c| c.get(0));

        if let Some(content) = choice
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(Value::as_str)
            && !content.is_empty()
        {
            accumulated_content.push_str(content);
            progress_sender(common::build_text_progress_chunk(content));
        }

        if let Some(reason) = choice
            .and_then(|c| c.get("finish_reason"))
            .and_then(Value::as_str)
        {
            finish_reason = Some(reason.to_owned());
        }

        if let Some(usage) = data.get("usage")
            && !usage.is_null()
        {
            final_usage = Some(usage.clone());
        }

        ControlFlow::Continue(())
    })
    .await?;

    let api_response = json!({
        "id": completion_id,
        "object": "chat.completion",
        "created": fuz_common::rfc3339_now(),
        "model": options.model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": accumulated_content,
            },
            "finish_reason": finish_reason.unwrap_or_else(|| "stop".to_owned()),
        }],
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
    let messages = build_messages(
        &options.completion_options.system_message,
        options.completion_messages.as_deref(),
        &options.prompt,
        &options.model,
    );
    let opts = &options.completion_options;

    let mut body = json!({
        "model": options.model,
        "stream": stream,
        "max_completion_tokens": opts.output_token_max,
        "messages": messages,
    });

    let obj = body.as_object_mut().unwrap_or_else(|| unreachable!());

    if let Some(t) = opts.temperature {
        obj.insert("temperature".to_owned(), json!(t));
    }
    if let Some(p) = opts.top_p {
        obj.insert("top_p".to_owned(), json!(p));
    }
    if let Some(s) = opts.seed {
        obj.insert("seed".to_owned(), json!(s));
    }
    if let Some(f) = opts.frequency_penalty {
        obj.insert("frequency_penalty".to_owned(), json!(f));
    }
    if let Some(p) = opts.presence_penalty {
        obj.insert("presence_penalty".to_owned(), json!(p));
    }
    if let Some(ref seqs) = opts.stop_sequences
        && !seqs.is_empty()
    {
        obj.insert("stop".to_owned(), json!(seqs));
    }

    body
}

fn build_messages(
    system_message: &str,
    completion_messages: Option<&[CompletionMessage]>,
    prompt: &str,
    model: &str,
) -> Vec<Value> {
    let capacity = completion_messages.map_or(0, <[_]>::len) + 2;
    let mut messages = Vec::with_capacity(capacity);

    // Some legacy reasoning models (e.g. o1-mini) reject system messages.
    // TS reference handles this with the same gate.
    if model != "o1-mini" {
        messages.push(json!({
            "role": "system",
            "content": system_message,
        }));
    }

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

// -- HTTP client --------------------------------------------------------------

fn build_client(api_key: &str) -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {api_key}")) {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    common::build_client_with_headers(headers)
}

// -- Error parsing ------------------------------------------------------------

/// Parse an `OpenAI` API error response body.
///
/// `OpenAI` errors look like: `{"error":{"message":"...","type":"...","code":"..."}}`
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
            model: "gpt-4o-mini".to_owned(),
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
        assert!(body.get("top_p").is_none());
        assert!(body.get("seed").is_none());
        assert!(body.get("frequency_penalty").is_none());
        assert!(body.get("presence_penalty").is_none());
        assert!(body.get("stop").is_none());
    }

    #[test]
    fn request_body_includes_optional_fields_when_set() {
        let mut o = opts();
        o.completion_options.temperature = Some(0.7);
        o.completion_options.top_p = Some(0.95);
        o.completion_options.seed = Some(42);
        o.completion_options.frequency_penalty = Some(0.1);
        o.completion_options.presence_penalty = Some(-0.2);
        o.completion_options.stop_sequences = Some(vec!["STOP".to_owned()]);
        let body = build_request_body(&o, false);
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["top_p"], 0.95);
        assert_eq!(body["seed"], 42);
        assert_eq!(body["frequency_penalty"], 0.1);
        assert_eq!(body["presence_penalty"], -0.2);
        assert_eq!(body["stop"], json!(["STOP"]));
    }

    #[test]
    fn messages_default_includes_system_then_prompt() {
        let m = build_messages("be brief", None, "hi", "gpt-4o");
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[0]["content"], "be brief");
        assert_eq!(m[1]["role"], "user");
        assert_eq!(m[1]["content"], "hi");
    }

    #[test]
    fn messages_omits_system_for_o1_mini() {
        let m = build_messages("ignored", None, "hi", "o1-mini");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["role"], "user");
    }

    #[test]
    fn messages_passes_history_through() {
        let history = vec![
            CompletionMessage {
                role: "user".to_owned(),
                content: "prior q".to_owned(),
            },
            CompletionMessage {
                role: "assistant".to_owned(),
                content: "prior a".to_owned(),
            },
        ];
        let m = build_messages("sys", Some(&history), "now", "gpt-4o");
        assert_eq!(m.len(), 4);
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[1]["role"], "user");
        assert_eq!(m[1]["content"], "prior q");
        assert_eq!(m[2]["role"], "assistant");
        assert_eq!(m[2]["content"], "prior a");
        assert_eq!(m[3]["content"], "now");
    }

    #[test]
    fn parse_api_error_extracts_message() {
        let body = r#"{"error":{"message":"bad key","type":"invalid_request_error"}}"#;
        assert_eq!(parse_api_error(body).as_deref(), Some("bad key"));
    }

    #[test]
    fn parse_api_error_returns_none_on_malformed_input() {
        assert!(parse_api_error("garbage").is_none());
        assert!(parse_api_error(r#"{"error":"string-not-object"}"#).is_none());
    }
}
