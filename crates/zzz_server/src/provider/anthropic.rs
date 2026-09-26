use std::ops::ControlFlow;

use fuz_http::JsonrpcError;
use serde_json::{Map, Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::sse::{self, SseEvent};
use super::{
    CompletionHandlerOptions, CompletionMessage, ProgressSender, ProviderName, ProviderStatus,
    ai_provider_error, common,
};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const PROVIDER: ProviderName = ProviderName::Claude;
/// The `&str` form (derived from `PROVIDER`) for the error/SSE plumbing.
const PROVIDER_NAME: &str = PROVIDER.as_str();

// -- Provider state -----------------------------------------------------------

struct AnthropicState {
    client: common::ProviderClient,
    cached_status: Option<ProviderStatus>,
}

/// Anthropic/Claude AI provider.
///
/// Uses the Messages API with optional SSE streaming.
/// State is behind `tokio::sync::RwLock` because `load_status` reads the
/// client and writes the cached status. The API key itself is set once at
/// construction from the environment and never mutated at runtime.
pub struct AnthropicProvider {
    state: RwLock<AnthropicState>,
}

impl AnthropicProvider {
    pub fn new(api_key: Option<&str>) -> Self {
        let client = common::ProviderClient::from_api_key(api_key, build_client);
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
        // Drop read lock before acquiring write lock.
        let status = state.client.status(PROVIDER);
        drop(state);

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
        // Clone the client (cheap — internally Arc'd) and release the lock
        // before the HTTP call, so a long-running streaming response doesn't
        // hold the lock against a concurrent `load_status` cache write.
        let client = self.state.read().await.client.require(PROVIDER)?;

        let body = build_request_body(options, progress_sender.is_some());

        let response =
            common::send_request(client.post(API_URL).json(&body), PROVIDER_NAME, signal).await?;
        let response =
            common::check_response_status(response, PROVIDER_NAME, signal, parse_api_error).await?;

        let api_response = if let Some(sender) = progress_sender {
            let mut stream = AnthropicStream::default();
            sse::consume_sse_stream(response, PROVIDER_NAME, signal, |event| {
                stream
                    .handle_event(&event, |text| {
                        sender(common::build_text_progress_chunk(text));
                    })
                    .map_err(|message| ai_provider_error(PROVIDER_NAME, &message))
            })
            .await?;
            stream
                .finish(&options.model)
                .map_err(|message| ai_provider_error(PROVIDER_NAME, &message))?
        } else {
            common::read_json_body(response, PROVIDER_NAME, signal).await?
        };

        Ok(common::build_completion_response(
            PROVIDER_NAME,
            &options.model,
            &api_response,
        ))
    }
}

// -- Streaming ----------------------------------------------------------------

/// Accumulated state of one Anthropic Messages SSE stream.
///
/// Pure (no I/O) so the event handling is unit-testable. A stream only
/// completes on `message_stop`; an `error` event or a stream that ends
/// without `message_stop` is a failure, not a truncated success.
#[derive(Debug, Default)]
struct AnthropicStream {
    content: String,
    message_id: String,
    stop_reason: Option<String>,
    /// Usage merged across events — `message_start` carries the input-side
    /// counts, `message_delta` the (cumulative) output-side ones.
    usage: Map<String, Value>,
    completed: bool,
}

impl AnthropicStream {
    /// Apply one SSE event, passing each text delta to `on_text`.
    ///
    /// Returns `Break` on `message_stop`, or `Err` with the provider's
    /// message on an `error` event.
    fn handle_event(
        &mut self,
        event: &SseEvent,
        mut on_text: impl FnMut(&str),
    ) -> Result<ControlFlow<()>, String> {
        let Some(event_type) = event.event_type.as_deref() else {
            return Ok(ControlFlow::Continue(()));
        };
        let data = serde_json::from_str::<Value>(&event.data).ok();
        match event_type {
            "error" => {
                return Err(data
                    .as_ref()
                    .and_then(common::parse_error_message)
                    .unwrap_or_else(|| String::from("stream error")));
            }
            "message_stop" => {
                self.completed = true;
                return Ok(ControlFlow::Break(()));
            }
            _ => {}
        }
        let Some(data) = data else {
            return Ok(ControlFlow::Continue(()));
        };
        match event_type {
            "message_start" => {
                let message = data.get("message");
                if let Some(id) = message.and_then(|m| m.get("id")).and_then(Value::as_str) {
                    id.clone_into(&mut self.message_id);
                }
                if let Some(usage) = message.and_then(|m| m.get("usage")) {
                    self.merge_usage(usage);
                }
            }
            "content_block_delta" => {
                if let Some(text) = data
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                {
                    self.content.push_str(text);
                    on_text(text);
                }
            }
            "message_delta" => {
                if let Some(sr) = data
                    .get("delta")
                    .and_then(|d| d.get("stop_reason"))
                    .and_then(Value::as_str)
                {
                    self.stop_reason = Some(sr.to_owned());
                }
                if let Some(usage) = data.get("usage") {
                    self.merge_usage(usage);
                }
            }
            _ => {}
        }
        Ok(ControlFlow::Continue(()))
    }

    /// Overlay `usage`'s non-null fields onto the accumulated usage.
    fn merge_usage(&mut self, usage: &Value) {
        let Some(fields) = usage.as_object() else {
            return;
        };
        for (key, value) in fields {
            if !value.is_null() {
                self.usage.insert(key.clone(), value.clone());
            }
        }
    }

    /// Build the Messages-API-shaped response from the accumulated stream.
    ///
    /// Returns `Err` when the stream ended without `message_stop`.
    fn finish(self, model: &str) -> Result<Value, String> {
        if !self.completed {
            return Err(String::from("stream ended before message_stop"));
        }
        let usage = if self.usage.is_empty() {
            Value::Null
        } else {
            Value::Object(self.usage)
        };
        Ok(json!({
            "id": self.message_id,
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": self.content}],
            "model": model,
            "stop_reason": self.stop_reason.unwrap_or_else(|| String::from("end_turn")),
            "stop_sequence": null,
            "usage": usage,
        }))
    }
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

    // Anthropic takes the system prompt as a top-level field, not a message,
    // so `system`-role history messages are lifted here alongside the
    // configured one.
    if let Some(system) =
        common::join_system_text(&opts.system_message, options.completion_messages.as_deref())
    {
        obj.insert("system".to_owned(), json!(system));
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
/// Skips `system`-role messages (`build_request_body` lifts them into the
/// top-level `system` field) and blank messages (Anthropic rejects empty
/// text blocks). Appends the prompt as a final user message.
fn build_messages(completion_messages: Option<&[CompletionMessage]>, prompt: &str) -> Vec<Value> {
    let capacity = completion_messages.map_or(0, <[_]>::len) + 1; // +1 for prompt
    let mut messages: Vec<Value> = Vec::with_capacity(capacity);

    for msg in completion_messages.unwrap_or_default() {
        if common::is_system_message(msg) || common::is_blank(&msg.content) {
            continue;
        }
        messages.push(json!({
            "role": msg.role,
            "content": [{"type": "text", "text": msg.content}],
        }));
    }

    messages.push(json!({
        "role": "user",
        "content": [{"type": "text", "text": prompt}],
    }));

    messages
}

// -- HTTP client --------------------------------------------------------------

fn build_client(api_key: &str) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("x-api-key", common::sensitive_header_value(api_key)?);
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
    common::parse_error_message(&serde_json::from_str(body).ok()?)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;
    use crate::provider::CompletionOptions;

    fn msg(role: &str, content: &str) -> CompletionMessage {
        CompletionMessage {
            role: role.to_owned(),
            content: content.to_owned(),
        }
    }

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
        let history = vec![msg("system", "lifted"), msg("assistant", "prior")];
        let m = build_messages(Some(&history), "now");
        // assistant kept + prompt appended; system moved to the top level
        assert_eq!(m.len(), 2);
        assert_eq!(m[0]["role"], "assistant");
        assert_eq!(m[0]["content"][0]["text"], "prior");
        assert_eq!(m[1]["role"], "user");
        assert_eq!(m[1]["content"][0]["text"], "now");
    }

    #[test]
    fn messages_drop_blank_content() {
        let history = vec![
            msg("user", "q"),
            msg("assistant", ""),
            msg("user", "  \n"),
            msg("assistant", "a"),
        ];
        let m = build_messages(Some(&history), "now");
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["content"][0]["text"], "q");
        assert_eq!(m[1]["content"][0]["text"], "a");
        assert_eq!(m[2]["content"][0]["text"], "now");
    }

    #[test]
    fn request_body_lifts_system_messages_into_system_field() {
        let mut o = opts();
        o.completion_options.system_message = "configured".to_owned();
        o.completion_messages = Some(vec![msg("system", "from history"), msg("user", "q")]);
        let body = build_request_body(&o, false);
        assert_eq!(body["system"], "configured\n\nfrom history");
        let messages = body["messages"].as_array().unwrap();
        assert!(messages.iter().all(|m| m["role"] != "system"));
    }

    #[test]
    fn request_body_system_from_history_only() {
        let mut o = opts();
        o.completion_messages = Some(vec![msg("system", "be brief")]);
        let body = build_request_body(&o, false);
        assert_eq!(body["system"], "be brief");
    }

    // -- Streaming --

    fn event(event_type: &str, data: &str) -> SseEvent {
        SseEvent {
            event_type: Some(event_type.to_owned()),
            data: data.to_owned(),
        }
    }

    /// Run `events` through a fresh stream, collecting text deltas. Stops at
    /// the first `Break` or error, like `consume_sse_stream`.
    fn run(events: &[SseEvent]) -> (AnthropicStream, Vec<String>, Result<(), String>) {
        let mut stream = AnthropicStream::default();
        let mut deltas = Vec::new();
        for e in events {
            match stream.handle_event(e, |t| deltas.push(t.to_owned())) {
                Ok(ControlFlow::Continue(())) => {}
                Ok(ControlFlow::Break(())) => break,
                Err(message) => return (stream, deltas, Err(message)),
            }
        }
        (stream, deltas, Ok(()))
    }

    fn full_stream() -> Vec<SseEvent> {
        vec![
            event(
                "message_start",
                r#"{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12,"output_tokens":1}}}"#,
            ),
            event("ping", r#"{"type":"ping"}"#),
            event(
                "content_block_delta",
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}"#,
            ),
            event(
                "content_block_delta",
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}"#,
            ),
            event(
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":7}}"#,
            ),
            event("message_stop", r#"{"type":"message_stop"}"#),
        ]
    }

    #[test]
    fn stream_completes_on_message_stop() {
        let (stream, deltas, result) = run(&full_stream());
        result.unwrap();
        assert_eq!(deltas, vec!["Hel", "lo"]);
        let response = stream.finish("claude-x").unwrap();
        assert_eq!(response["id"], "msg_1");
        assert_eq!(response["content"][0]["text"], "Hello");
        assert_eq!(response["stop_reason"], "max_tokens");
        assert_eq!(response["model"], "claude-x");
    }

    #[test]
    fn stream_merges_input_tokens_from_message_start() {
        let (stream, _, result) = run(&full_stream());
        result.unwrap();
        let response = stream.finish("m").unwrap();
        assert_eq!(response["usage"]["input_tokens"], 12);
        assert_eq!(response["usage"]["output_tokens"], 7);
    }

    #[test]
    fn stream_error_event_is_an_error() {
        let mut events = full_stream();
        events.insert(
            3,
            event(
                "error",
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            ),
        );
        let (_, deltas, result) = run(&events);
        assert_eq!(result.unwrap_err(), "Overloaded");
        // the partial text streamed before the error was still delivered
        assert_eq!(deltas, vec!["Hel"]);
    }

    #[test]
    fn stream_error_event_with_unparseable_data_is_an_error() {
        let (_, _, result) = run(&[event("error", "not json")]);
        assert_eq!(result.unwrap_err(), "stream error");
    }

    #[test]
    fn stream_without_message_stop_is_an_error() {
        let mut events = full_stream();
        events.pop();
        let (stream, _, result) = run(&events);
        result.unwrap();
        assert!(stream.finish("m").is_err());
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
