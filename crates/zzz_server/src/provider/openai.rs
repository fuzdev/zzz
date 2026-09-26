use std::ops::ControlFlow;

use fuz_http::JsonrpcError;
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::sse::{self, SseEvent};
use super::{
    CompletionHandlerOptions, CompletionMessage, ProgressSender, ProviderName, ProviderStatus,
    ai_provider_error, common,
};

const API_URL: &str = "https://api.openai.com/v1/chat/completions";
const PROVIDER: ProviderName = ProviderName::Chatgpt;
/// The `&str` form (derived from `PROVIDER`) for the error/SSE plumbing.
const PROVIDER_NAME: &str = PROVIDER.as_str();
const SSE_DONE_MARKER: &str = "[DONE]";

struct OpenAiState {
    client: common::ProviderClient,
    cached_status: Option<ProviderStatus>,
}

/// OpenAI/ChatGPT AI provider.
///
/// Uses the Chat Completions API with optional SSE streaming.
pub struct OpenAiProvider {
    state: RwLock<OpenAiState>,
}

impl OpenAiProvider {
    pub fn new(api_key: Option<&str>) -> Self {
        let client = common::ProviderClient::from_api_key(api_key, build_client);
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
        let client = self.state.read().await.client.require(PROVIDER)?;

        let body = build_request_body(options, progress_sender.is_some());

        let response =
            common::send_request(client.post(API_URL).json(&body), PROVIDER_NAME, signal).await?;
        let response =
            common::check_response_status(response, PROVIDER_NAME, signal, parse_api_error).await?;

        let api_response = if let Some(sender) = progress_sender {
            let mut stream = OpenAiStream::default();
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

/// Accumulated state of one Chat Completions SSE stream.
///
/// Pure (no I/O) so the event handling is unit-testable. A stream only
/// completes on `data: [DONE]`; an `{"error": ...}` chunk or a stream that
/// ends without `[DONE]` is a failure, not a truncated success.
#[derive(Debug, Default)]
struct OpenAiStream {
    content: String,
    completion_id: String,
    finish_reason: Option<String>,
    /// The final usage chunk — sent (with empty `choices`) just before
    /// `[DONE]` because the request sets `stream_options.include_usage`.
    usage: Option<Value>,
    completed: bool,
}

impl OpenAiStream {
    /// Apply one SSE event, passing each text delta to `on_text`.
    ///
    /// Returns `Break` on `[DONE]`, or `Err` with the provider's message on
    /// an error chunk.
    fn handle_event(
        &mut self,
        event: &SseEvent,
        mut on_text: impl FnMut(&str),
    ) -> Result<ControlFlow<()>, String> {
        // OpenAI signals the end of the stream with `data: [DONE]` — not
        // valid JSON, so detect it before parsing.
        if event.data.trim() == SSE_DONE_MARKER {
            self.completed = true;
            return Ok(ControlFlow::Break(()));
        }
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return Ok(ControlFlow::Continue(()));
        };

        if let Some(error) = data.get("error")
            && !error.is_null()
        {
            return Err(
                common::parse_error_message(&data).unwrap_or_else(|| String::from("stream error"))
            );
        }

        if self.completion_id.is_empty()
            && let Some(id) = data.get("id").and_then(Value::as_str)
        {
            id.clone_into(&mut self.completion_id);
        }

        let choice = data.get("choices").and_then(|c| c.get(0));

        if let Some(content) = choice
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(Value::as_str)
            && !content.is_empty()
        {
            self.content.push_str(content);
            on_text(content);
        }

        if let Some(reason) = choice
            .and_then(|c| c.get("finish_reason"))
            .and_then(Value::as_str)
        {
            self.finish_reason = Some(reason.to_owned());
        }

        if let Some(usage) = data.get("usage")
            && !usage.is_null()
        {
            self.usage = Some(usage.clone());
        }

        Ok(ControlFlow::Continue(()))
    }

    /// Build the Chat-Completions-shaped response from the accumulated
    /// stream.
    ///
    /// Returns `Err` when the stream ended without `[DONE]`.
    fn finish(self, model: &str) -> Result<Value, String> {
        if !self.completed {
            return Err(String::from("stream ended before [DONE]"));
        }
        Ok(json!({
            "id": self.completion_id,
            "object": "chat.completion",
            "created": fuz_sys::rfc3339_now(),
            "model": model,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": self.content,
                },
                "finish_reason": self.finish_reason.unwrap_or_else(|| String::from("stop")),
            }],
            "usage": self.usage,
        }))
    }
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

    // Streaming responses carry no usage unless asked for; the API rejects
    // `stream_options` on non-streaming requests.
    if stream {
        obj.insert("stream_options".to_owned(), json!({"include_usage": true}));
    }

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

/// Convert the configured system message + `CompletionMessage[]` + prompt
/// into the Chat Completions messages format.
///
/// The configured system message is sent only when non-blank; `system`-role
/// history messages pass through in place (the API accepts them anywhere).
/// Blank history messages are dropped. Appends the prompt as a final user
/// message.
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
    if model != "o1-mini" && !common::is_blank(system_message) {
        messages.push(json!({
            "role": "system",
            "content": system_message,
        }));
    }

    for msg in completion_messages.unwrap_or_default() {
        if common::is_blank(&msg.content) {
            continue;
        }
        messages.push(json!({
            "role": msg.role,
            "content": msg.content,
        }));
    }

    messages.push(json!({
        "role": "user",
        "content": prompt,
    }));

    messages
}

// -- HTTP client --------------------------------------------------------------

fn build_client(api_key: &str) -> Result<reqwest::Client, String> {
    common::build_auth_client(reqwest::header::AUTHORIZATION, &format!("Bearer {api_key}"))
}

// -- Error parsing ------------------------------------------------------------

/// Parse an `OpenAI` API error response body.
///
/// `OpenAI` errors look like: `{"error":{"message":"...","type":"...","code":"..."}}`
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
    fn request_body_requests_usage_only_when_streaming() {
        let body = build_request_body(&opts(), true);
        assert_eq!(body["stream_options"]["include_usage"], true);
        let body = build_request_body(&opts(), false);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn messages_omit_blank_system_message() {
        let m = build_messages("", None, "hi", "gpt-4o");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0]["role"], "user");
        let m = build_messages("  \n", None, "hi", "gpt-4o");
        assert_eq!(m.len(), 1);
    }

    #[test]
    fn messages_pass_system_history_through() {
        let history = vec![msg("system", "sys from history"), msg("user", "q")];
        let m = build_messages("", Some(&history), "now", "gpt-4o");
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[0]["content"], "sys from history");
    }

    #[test]
    fn messages_drop_blank_content() {
        let history = vec![
            msg("user", "q"),
            msg("assistant", " "),
            msg("assistant", "a"),
        ];
        let m = build_messages("", Some(&history), "now", "gpt-4o");
        assert_eq!(m.len(), 3);
        assert_eq!(m[0]["content"], "q");
        assert_eq!(m[1]["content"], "a");
        assert_eq!(m[2]["content"], "now");
    }

    // -- Streaming --

    fn data(data: &str) -> SseEvent {
        SseEvent {
            event_type: None,
            data: data.to_owned(),
        }
    }

    /// Run `events` through a fresh stream, collecting text deltas. Stops at
    /// the first `Break` or error, like `consume_sse_stream`.
    fn run(events: &[SseEvent]) -> (OpenAiStream, Vec<String>, Result<(), String>) {
        let mut stream = OpenAiStream::default();
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
            data(
                r#"{"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}],"usage":null}"#,
            ),
            data(r#"{"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"}}],"usage":null}"#),
            data(r#"{"id":"c1","choices":[{"index":0,"delta":{"content":"lo"}}],"usage":null}"#),
            data(
                r#"{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":null}"#,
            ),
            data(
                r#"{"id":"c1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}"#,
            ),
            data("[DONE]"),
        ]
    }

    #[test]
    fn stream_completes_on_done() {
        let (stream, deltas, result) = run(&full_stream());
        result.unwrap();
        assert_eq!(deltas, vec!["Hel", "lo"]);
        let response = stream.finish("gpt-x").unwrap();
        assert_eq!(response["id"], "c1");
        assert_eq!(response["choices"][0]["message"]["content"], "Hello");
        assert_eq!(response["choices"][0]["finish_reason"], "length");
    }

    #[test]
    fn stream_captures_final_usage_chunk() {
        let (stream, _, result) = run(&full_stream());
        result.unwrap();
        let response = stream.finish("m").unwrap();
        assert_eq!(response["usage"]["total_tokens"], 7);
    }

    #[test]
    fn stream_error_chunk_is_an_error() {
        let mut events = full_stream();
        events.insert(
            2,
            data(r#"{"error":{"message":"server overloaded","type":"server_error"}}"#),
        );
        let (_, deltas, result) = run(&events);
        assert_eq!(result.unwrap_err(), "server overloaded");
        assert_eq!(deltas, vec!["Hel"]);
    }

    #[test]
    fn stream_without_done_is_an_error() {
        let mut events = full_stream();
        events.pop();
        let (stream, _, result) = run(&events);
        result.unwrap();
        assert!(stream.finish("m").is_err());
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
