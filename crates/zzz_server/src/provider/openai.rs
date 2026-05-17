use std::ops::ControlFlow;

use fuz_common::JsonRpcError;
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
    api_key: Option<String>,
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
        let client = api_key.as_ref().map(|key| build_client(key));
        Self {
            state: RwLock::new(OpenAiState {
                api_key,
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
        let has_key = state.api_key.is_some();
        drop(state);

        let status = if has_key {
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
        state.client = key.as_ref().map(|k| build_client(k));
        state.api_key = key;
        state.cached_status = None;
    }

    pub async fn complete(
        &self,
        options: &CompletionHandlerOptions,
        progress_sender: Option<&ProgressSender>,
        signal: &CancellationToken,
    ) -> Result<Value, JsonRpcError> {
        let client = {
            let state = self.state.read().await;
            state
                .client
                .clone()
                .ok_or_else(|| ai_provider_error(PROVIDER_NAME, PROVIDER_ERROR_NEEDS_API_KEY))?
        };

        let streaming = options.progress_token.is_some() && progress_sender.is_some();
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
) -> Result<Value, JsonRpcError> {
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
) -> Result<Value, JsonRpcError> {
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
