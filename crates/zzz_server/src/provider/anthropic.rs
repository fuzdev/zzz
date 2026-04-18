use fuz_common::JsonRpcError;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::{
    ai_provider_error, CompletionHandlerOptions, CompletionMessage, ProgressSender,
    ProviderStatus, PROVIDER_ERROR_NEEDS_API_KEY,
};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

// -- Provider state -----------------------------------------------------------

struct AnthropicState {
    api_key: Option<String>,
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
        let client = api_key.as_ref().map(|key| build_client(key));
        Self {
            state: RwLock::new(AnthropicState {
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
        // Drop read lock before acquiring write lock
        let has_client = state.client.is_some();
        drop(state);

        let status = if has_client {
            ProviderStatus::available("claude")
        } else {
            ProviderStatus::unavailable("claude", PROVIDER_ERROR_NEEDS_API_KEY)
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
        // Clone the client (cheap — internally Arc'd) and release the lock
        // before the HTTP call. This avoids blocking set_api_key for the
        // duration of a potentially long-running streaming response.
        let client = {
            let state = self.state.read().await;
            state
                .client
                .clone()
                .ok_or_else(|| ai_provider_error("claude", PROVIDER_ERROR_NEEDS_API_KEY))?
        };

        let streaming = options.progress_token.is_some() && progress_sender.is_some();
        let body = build_request_body(options, streaming);

        let response: reqwest::Response = client
            .post(API_URL)
            .json(&body)
            .send()
            .await
            .map_err(|e: reqwest::Error| ai_provider_error("claude", &e.to_string()))?;

        if !response.status().is_success() {
            let error_body: String = response
                .text()
                .await
                .unwrap_or_else(|_: reqwest::Error| String::from("unknown error"));
            let error_msg = parse_api_error(&error_body).unwrap_or(error_body);
            return Err(ai_provider_error("claude", &error_msg));
        }

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
    let api_response: Value = response
        .json::<Value>()
        .await
        .map_err(|e: reqwest::Error| ai_provider_error("claude", &format!("failed to parse response: {e}")))?;

    Ok(build_completion_response(&options.model, &api_response))
}

async fn handle_streaming_response(
    response: reqwest::Response,
    options: &CompletionHandlerOptions,
    progress_sender: &ProgressSender,
    signal: &CancellationToken,
) -> Result<Value, JsonRpcError> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut accumulated_content = String::new();
    let mut message_id = String::new();
    let mut final_usage: Option<Value> = None;
    let mut stop_reason = String::from("end_turn");

    while let Some(chunk) = stream.next().await {
        // Mirrors TS `if (ctx.signal.aborted) break` in ollama_pull/create —
        // bail out of the stream when the request is cancelled (socket close).
        if signal.is_cancelled() {
            break;
        }
        let chunk = chunk.map_err(|e| {
            ai_provider_error("claude", &format!("stream read error: {e}"))
        })?;
        let text = String::from_utf8_lossy(&chunk);
        // Normalize line endings per SSE spec (RFC 8895 §9.2):
        // \r\n → \n, then lone \r → \n
        if text.contains('\r') {
            buffer.push_str(&text.replace("\r\n", "\n").replace('\r', "\n"));
        } else {
            buffer.push_str(&text);
        }

        // Process complete SSE events (separated by \n\n)
        while let Some(boundary) = buffer.find("\n\n") {
            let event_text = buffer[..boundary].to_owned();
            buffer = buffer[boundary + 2..].to_owned();

            if let Some((event_type, data)) = parse_sse_event(&event_text) {
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
                            progress_sender(json!({
                                "message": {
                                    "role": "assistant",
                                    "content": text,
                                }
                            }));
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
            }
        }
    }

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

    Ok(build_completion_response(&options.model, &api_response))
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
fn build_messages(
    completion_messages: Option<&[CompletionMessage]>,
    prompt: &str,
) -> Vec<Value> {
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

// -- Response building --------------------------------------------------------

fn build_completion_response(model: &str, api_response: &Value) -> Value {
    let created = fuz_common::rfc3339_now();
    json!({
        "completion_response": {
            "created": created,
            "provider_name": "claude",
            "model": model,
            "data": {
                "type": "claude",
                "value": api_response,
            },
        },
    })
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
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

// -- SSE parsing --------------------------------------------------------------

/// Parse a single SSE event block into (`event_type`, `parsed_data`).
///
/// An SSE event looks like:
/// ```text
/// event: message_start
/// data: {"type":"message_start","message":{...}}
/// ```
fn parse_sse_event(event_text: &str) -> Option<(&str, Value)> {
    let mut event_type: Option<&str> = None;
    let mut data_lines: Vec<&str> = Vec::new();

    for line in event_text.lines() {
        if let Some(rest) = line.strip_prefix("event: ") {
            event_type = Some(rest.trim());
        } else if let Some(rest) = line.strip_prefix("data: ") {
            data_lines.push(rest);
        }
    }

    let event_type = event_type?;
    if data_lines.is_empty() {
        return None;
    }

    let data_str = data_lines.join("\n");
    let data: Value = serde_json::from_str(&data_str).ok()?;
    Some((event_type, data))
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

