use std::ops::ControlFlow;

use fuz_http::{JsonrpcError, invalid_params};
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::sse::{self, SseEvent};
use super::{
    CompletionHandlerOptions, CompletionMessage, ProgressSender, ProviderName, ProviderStatus,
    ai_provider_error, common,
};

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const PROVIDER: ProviderName = ProviderName::Gemini;
/// The `&str` form (derived from `PROVIDER`) for the error/SSE plumbing.
const PROVIDER_NAME: &str = PROVIDER.as_str();

struct GeminiState {
    client: common::ProviderClient,
    cached_status: Option<ProviderStatus>,
}

/// Google Gemini AI provider.
///
/// Uses the Generative Language REST API directly. SDK is not used to
/// avoid the dependency; the REST surface mirrors the SDK closely. The API
/// key travels in the `x-goog-api-key` header (never the URL, where it would
/// surface in `reqwest` error messages and proxy logs).
pub struct GeminiProvider {
    state: RwLock<GeminiState>,
}

impl GeminiProvider {
    pub fn new(api_key: Option<&str>) -> Self {
        let client = common::ProviderClient::from_api_key(api_key, build_client);
        Self {
            state: RwLock::new(GeminiState {
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
        // The model name is interpolated into the URL path — refuse anything
        // that could change the path or add a query before building it.
        validate_model_name(&options.model)?;

        let client = self.state.read().await.client.require(PROVIDER)?;

        let streaming = progress_sender.is_some();
        let url = build_url(&options.model, streaming);
        let body = build_request_body(options);

        let response =
            common::send_request(client.post(&url).json(&body), PROVIDER_NAME, signal).await?;
        let response =
            common::check_response_status(response, PROVIDER_NAME, signal, parse_api_error).await?;

        let value = if let Some(sender) = progress_sender {
            let mut stream = GeminiStream::default();
            sse::consume_sse_stream(response, PROVIDER_NAME, signal, |event| {
                stream
                    .handle_event(&event, |text| {
                        sender(common::build_text_progress_chunk(text));
                    })
                    .map_err(|message| ai_provider_error(PROVIDER_NAME, &message))
            })
            .await?;
            stream
                .finish()
                .map_err(|message| ai_provider_error(PROVIDER_NAME, &message))?
        } else {
            let api_response = common::read_json_body(response, PROVIDER_NAME, signal).await?;
            build_gemini_value(&api_response)
        };

        Ok(common::build_completion_response(
            PROVIDER_NAME,
            &options.model,
            &value,
        ))
    }
}

// -- Streaming ----------------------------------------------------------------

/// Accumulated state of one `streamGenerateContent` SSE stream.
///
/// Pure (no I/O) so the event handling is unit-testable. Gemini has no
/// terminator event: the stream is complete once a chunk carries a
/// candidate `finishReason` (or a `promptFeedback.blockReason`, when the
/// prompt itself was blocked and no candidate comes). An `{"error": ...}`
/// chunk, or a stream that ends before either, is a failure rather than a
/// truncated success.
#[derive(Debug, Default)]
struct GeminiStream {
    content: String,
    last_response: Option<Value>,
    usage_metadata: Option<Value>,
    completed: bool,
}

impl GeminiStream {
    /// Apply one SSE event, passing each text delta to `on_text`.
    ///
    /// Returns `Break` on the final chunk, or `Err` with the provider's
    /// message on an error chunk.
    fn handle_event(
        &mut self,
        event: &SseEvent,
        mut on_text: impl FnMut(&str),
    ) -> Result<ControlFlow<()>, String> {
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

        let chunk_text = extract_text(&data);
        if !chunk_text.is_empty() {
            self.content.push_str(&chunk_text);
            on_text(&chunk_text);
        }

        if let Some(usage) = data.get("usageMetadata") {
            self.usage_metadata = Some(usage.clone());
        }
        let completed = is_final_chunk(&data);
        self.last_response = Some(data);

        // The final chunk also carries the final `usageMetadata` (recorded
        // above), so stop reading here: a cancel or read error after the
        // response is complete must not turn it into a failure. Safe with the
        // single candidate zzz requests — with `candidateCount > 1`, other
        // candidates could still be streaming.
        if completed {
            self.completed = true;
            return Ok(ControlFlow::Break(()));
        }
        Ok(ControlFlow::Continue(()))
    }

    /// Build the Gemini `value` payload from the accumulated stream.
    ///
    /// Returns `Err` when no chunk carried a `finishReason` or `blockReason`.
    fn finish(self) -> Result<Value, String> {
        if !self.completed {
            return Err(String::from("stream ended before a finishReason"));
        }
        let last_response = self.last_response.as_ref();
        let candidates = last_response
            .and_then(|r| r.get("candidates"))
            .cloned()
            .unwrap_or(Value::Null);
        let function_calls = last_response
            .and_then(extract_function_calls)
            .unwrap_or(Value::Null);
        let prompt_feedback = last_response
            .and_then(|r| r.get("promptFeedback"))
            .cloned()
            .unwrap_or(Value::Null);

        Ok(json!({
            "text": self.content,
            "candidates": candidates,
            "function_calls": function_calls,
            "prompt_feedback": prompt_feedback,
            "usage_metadata": self.usage_metadata.unwrap_or(Value::Null),
        }))
    }
}

/// Whether a stream chunk is terminal: its first candidate has a
/// `finishReason`, or the prompt was blocked outright.
fn is_final_chunk(data: &Value) -> bool {
    let finished = data
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finishReason"))
        .is_some_and(|r| !r.is_null());
    let blocked = data
        .get("promptFeedback")
        .and_then(|f| f.get("blockReason"))
        .is_some_and(|r| !r.is_null());
    finished || blocked
}

// -- Response extraction ------------------------------------------------------

/// Build the `value` payload for the discriminated union — Gemini is the
/// only provider with strictly-typed `value` fields (`text`,
/// `candidates`, `function_calls`, `prompt_feedback`, `usage_metadata`).
fn build_gemini_value(api_response: &Value) -> Value {
    let text = extract_text(api_response);
    let candidates = api_response
        .get("candidates")
        .cloned()
        .unwrap_or(Value::Null);
    let function_calls = extract_function_calls(api_response).unwrap_or(Value::Null);
    let prompt_feedback = api_response
        .get("promptFeedback")
        .cloned()
        .unwrap_or(Value::Null);
    let usage_metadata = api_response
        .get("usageMetadata")
        .cloned()
        .unwrap_or(Value::Null);

    json!({
        "text": text,
        "candidates": candidates,
        "function_calls": function_calls,
        "prompt_feedback": prompt_feedback,
        "usage_metadata": usage_metadata,
    })
}

/// Concatenate text across all parts of the first candidate.
fn extract_text(response: &Value) -> String {
    let Some(parts) = response
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    let mut out = String::new();
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            out.push_str(text);
        }
    }
    out
}

/// Extract function-call parts across all candidates. Returns `None` if
/// no `functionCall` parts are present (lets caller substitute `Null`).
fn extract_function_calls(response: &Value) -> Option<Value> {
    let candidates = response.get("candidates").and_then(Value::as_array)?;
    let mut calls: Vec<Value> = Vec::new();
    for candidate in candidates {
        let Some(parts) = candidate
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for part in parts {
            if let Some(fc) = part.get("functionCall") {
                calls.push(fc.clone());
            }
        }
    }
    if calls.is_empty() {
        None
    } else {
        Some(Value::Array(calls))
    }
}

// -- Request building ---------------------------------------------------------

/// Refuse model names that aren't a plain `[A-Za-z0-9._-]+` identifier.
///
/// The name becomes a URL path segment (`/models/{model}:method`), so a `/`,
/// `?`, `#`, `%`, or `:` could redirect the request to another endpoint.
fn validate_model_name(model: &str) -> Result<(), JsonrpcError> {
    let valid = !model.is_empty()
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(invalid_params(
            &format!("{PROVIDER_NAME}: invalid model name: {model:?}"),
            None,
        ))
    }
}

/// Build the endpoint URL. `model` must already have passed
/// `validate_model_name`.
fn build_url(model: &str, streaming: bool) -> String {
    if streaming {
        format!("{API_BASE}/{model}:streamGenerateContent?alt=sse")
    } else {
        format!("{API_BASE}/{model}:generateContent")
    }
}

fn build_request_body(options: &CompletionHandlerOptions) -> Value {
    let contents = build_contents(options.completion_messages.as_deref(), &options.prompt);
    let opts = &options.completion_options;

    let mut generation_config = serde_json::Map::new();
    generation_config.insert("maxOutputTokens".to_owned(), json!(opts.output_token_max));
    if let Some(t) = opts.temperature {
        generation_config.insert("temperature".to_owned(), json!(t));
    }
    if let Some(k) = opts.top_k {
        generation_config.insert("topK".to_owned(), json!(k));
    }
    if let Some(p) = opts.top_p {
        generation_config.insert("topP".to_owned(), json!(p));
    }
    if let Some(f) = opts.frequency_penalty {
        generation_config.insert("frequencyPenalty".to_owned(), json!(f));
    }
    if let Some(p) = opts.presence_penalty {
        generation_config.insert("presencePenalty".to_owned(), json!(p));
    }
    if let Some(ref seqs) = opts.stop_sequences
        && !seqs.is_empty()
    {
        generation_config.insert("stopSequences".to_owned(), json!(seqs));
    }

    let mut body = json!({
        "contents": contents,
        "generationConfig": Value::Object(generation_config),
    });

    // The configured system message plus any `system`-role history
    // messages — Gemini has no system role inside `contents`.
    if let Some(system) =
        common::join_system_text(&opts.system_message, options.completion_messages.as_deref())
    {
        let obj = body.as_object_mut().unwrap_or_else(|| unreachable!());
        obj.insert(
            "systemInstruction".to_owned(),
            json!({
                "parts": [{"text": system}],
            }),
        );
    }

    body
}

/// Convert `CompletionMessage[]` + prompt into Gemini `contents`.
///
/// Skips `system`-role messages (`build_request_body` lifts them into
/// `systemInstruction`) and blank messages. Non-user roles map to Gemini's
/// `model`. Appends the prompt as a final user turn. Adjacent same-role
/// messages merge into one content with multiple parts, so gaps in the
/// history (e.g. an excluded errored assistant turn leaving two user
/// messages in a row) can't break Gemini's user/model alternation.
fn build_contents(completion_messages: Option<&[CompletionMessage]>, prompt: &str) -> Vec<Value> {
    let history = completion_messages
        .unwrap_or_default()
        .iter()
        .filter(|m| !common::is_system_message(m) && !common::is_blank(&m.content))
        .map(|m| {
            let role = if m.role == "user" { "user" } else { "model" };
            (role, m.content.as_str())
        });

    let mut contents: Vec<Value> = Vec::new();
    for (role, text) in history.chain(std::iter::once(("user", prompt))) {
        let part = json!({"text": text});
        if let Some(last) = contents.last_mut()
            && last["role"] == role
            && let Some(parts) = last["parts"].as_array_mut()
        {
            parts.push(part);
            continue;
        }
        contents.push(json!({
            "role": role,
            "parts": [part],
        }));
    }

    contents
}

// -- HTTP client --------------------------------------------------------------

fn build_client(api_key: &str) -> Result<reqwest::Client, String> {
    common::build_auth_client(
        reqwest::header::HeaderName::from_static("x-goog-api-key"),
        api_key,
    )
}

// -- Error parsing ------------------------------------------------------------

/// Parse a Gemini API error response body.
///
/// Gemini errors look like: `{"error":{"code":...,"message":"...","status":"..."}}`
fn parse_api_error(body: &str) -> Option<String> {
    common::parse_error_message(&serde_json::from_str(body).ok()?)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;
    use crate::provider::CompletionOptions;

    fn opts() -> CompletionHandlerOptions {
        CompletionHandlerOptions {
            model: "gemini-1.5-flash".to_owned(),
            completion_options: CompletionOptions::default(),
            completion_messages: None,
            prompt: "hi".to_owned(),
        }
    }

    fn msg(role: &str, content: &str) -> CompletionMessage {
        CompletionMessage {
            role: role.to_owned(),
            content: content.to_owned(),
        }
    }

    #[test]
    fn url_streaming_uses_sse_endpoint() {
        let url = build_url("gemini-1.5-flash", true);
        assert!(url.contains(":streamGenerateContent"));
        assert!(url.contains("alt=sse"));
        assert!(!url.contains("key="), "the API key never goes in the URL");
    }

    #[test]
    fn url_non_streaming_uses_basic_endpoint() {
        let url = build_url("gemini-1.5-flash", false);
        assert!(url.contains(":generateContent"));
        assert!(!url.contains("streamGenerateContent"));
        assert!(!url.contains('?'));
    }

    #[test]
    fn model_name_accepts_plain_identifiers() {
        for model in ["gemini-2.5-flash", "gemini_1.5-pro-001", "A.b-C_9"] {
            validate_model_name(model).unwrap();
        }
    }

    #[test]
    fn model_name_rejects_path_and_query_characters() {
        for model in [
            "",
            "../tunedModels/x",
            "gemini/..",
            "gemini?key=x",
            "gemini#frag",
            "gemini%2Fx",
            "gemini:generateContent",
            "gemini flash",
            "gémini",
        ] {
            let error = validate_model_name(model).unwrap_err();
            assert_eq!(
                error.code,
                fuz_http::JsonrpcErrorCode::InvalidParams,
                "{model}"
            );
        }
    }

    #[test]
    fn contents_lift_system_messages_and_drop_blank() {
        let history = vec![
            msg("system", "sys"),
            msg("user", "q"),
            msg("assistant", ""),
            msg("assistant", "a"),
        ];
        let c = build_contents(Some(&history), "now");
        assert_eq!(c.len(), 3);
        assert_eq!(c[0]["role"], "user");
        assert_eq!(c[1]["role"], "model");
        assert_eq!(c[1]["parts"][0]["text"], "a");
        assert_eq!(c[2]["parts"][0]["text"], "now");
    }

    #[test]
    fn contents_merge_adjacent_same_role() {
        // an errored assistant turn excluded between two user turns, then two
        // assistant turns, then the prompt after a user turn
        let history = vec![
            msg("user", "q1"),
            msg("user", "q2"),
            msg("assistant", "a1"),
            msg("assistant", "a2"),
            msg("user", "q3"),
        ];
        let c = build_contents(Some(&history), "now");
        assert_eq!(c.len(), 3);
        assert_eq!(c[0]["role"], "user");
        assert_eq!(c[0]["parts"], json!([{"text": "q1"}, {"text": "q2"}]));
        assert_eq!(c[1]["role"], "model");
        assert_eq!(c[1]["parts"], json!([{"text": "a1"}, {"text": "a2"}]));
        assert_eq!(c[2]["role"], "user");
        assert_eq!(c[2]["parts"], json!([{"text": "q3"}, {"text": "now"}]));
    }

    #[test]
    fn contents_merge_across_dropped_messages() {
        // a dropped blank model message between two model messages still
        // leaves them adjacent
        let history = vec![
            msg("user", "q"),
            msg("assistant", "a1"),
            msg("assistant", " "),
        ];
        let c = build_contents(Some(&history), "now");
        assert_eq!(c.len(), 3);
        assert_eq!(c[1]["parts"], json!([{"text": "a1"}]));
    }

    #[test]
    fn request_body_lifts_system_messages_into_system_instruction() {
        let mut o = opts();
        o.completion_options.system_message = "configured".to_owned();
        o.completion_messages = Some(vec![msg("system", "from history"), msg("user", "q")]);
        let body = build_request_body(&o);
        assert_eq!(
            body["systemInstruction"]["parts"][0]["text"],
            "configured\n\nfrom history"
        );
        // system message lifted: only the user turn ("q" + prompt, merged) remains
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
        let parts = contents[0]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert!(
            parts
                .iter()
                .all(|p| !p["text"].as_str().unwrap().contains("from history"))
        );
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
    fn run(events: &[SseEvent]) -> (GeminiStream, Vec<String>, Result<(), String>) {
        let mut stream = GeminiStream::default();
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
            data(r#"{"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"}}]}"#),
            data(
                r#"{"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":9}}"#,
            ),
        ]
    }

    #[test]
    fn stream_completes_on_finish_reason() {
        let (stream, deltas, result) = run(&full_stream());
        result.unwrap();
        assert_eq!(deltas, vec!["Hel", "lo"]);
        let value = stream.finish().unwrap();
        assert_eq!(value["text"], "Hello");
        assert_eq!(value["candidates"][0]["finishReason"], "STOP");
        assert_eq!(value["usage_metadata"]["totalTokenCount"], 9);
    }

    #[test]
    fn stream_breaks_on_final_chunk_keeping_usage() {
        let mut stream = GeminiStream::default();
        let events = full_stream();
        let first = stream.handle_event(&events[0], |_| {}).unwrap();
        assert_eq!(first, ControlFlow::Continue(()));
        let last = stream.handle_event(&events[1], |_| {}).unwrap();
        assert_eq!(last, ControlFlow::Break(()), "stop reading once complete");
        let value = stream.finish().unwrap();
        assert_eq!(value["usage_metadata"]["totalTokenCount"], 9);
    }

    #[test]
    fn stream_completes_on_blocked_prompt() {
        let (stream, deltas, result) =
            run(&[data(r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#)]);
        result.unwrap();
        assert!(deltas.is_empty());
        let value = stream.finish().unwrap();
        assert_eq!(value["prompt_feedback"]["blockReason"], "SAFETY");
    }

    #[test]
    fn stream_error_chunk_is_an_error() {
        let events = vec![
            full_stream().remove(0),
            data(
                r#"{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}"#,
            ),
        ];
        let (_, deltas, result) = run(&events);
        assert_eq!(result.unwrap_err(), "The model is overloaded.");
        assert_eq!(deltas, vec!["Hel"]);
    }

    #[test]
    fn stream_without_finish_reason_is_an_error() {
        let (stream, _, result) = run(&full_stream()[..1]);
        result.unwrap();
        assert!(stream.finish().is_err());
    }

    #[test]
    fn request_body_uses_camelcase_generation_config() {
        let mut o = opts();
        o.completion_options.temperature = Some(0.5);
        o.completion_options.top_k = Some(20);
        o.completion_options.top_p = Some(0.9);
        o.completion_options.frequency_penalty = Some(0.1);
        o.completion_options.presence_penalty = Some(0.2);
        o.completion_options.stop_sequences = Some(vec!["X".to_owned()]);
        let body = build_request_body(&o);
        let cfg = &body["generationConfig"];
        assert!(cfg["maxOutputTokens"].is_number());
        assert_eq!(cfg["temperature"], 0.5);
        assert_eq!(cfg["topK"], 20);
        assert_eq!(cfg["topP"], 0.9);
        assert_eq!(cfg["frequencyPenalty"], 0.1);
        assert_eq!(cfg["presencePenalty"], 0.2);
        assert_eq!(cfg["stopSequences"], json!(["X"]));
    }

    #[test]
    fn request_body_includes_system_instruction_when_present() {
        let mut o = opts();
        o.completion_options.system_message = "be terse".to_owned();
        let body = build_request_body(&o);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be terse");
    }

    #[test]
    fn request_body_omits_system_instruction_when_empty() {
        let body = build_request_body(&opts());
        assert!(body.get("systemInstruction").is_none());
    }

    #[test]
    fn contents_maps_assistant_to_model() {
        let history = vec![
            CompletionMessage {
                role: "user".to_owned(),
                content: "q".to_owned(),
            },
            CompletionMessage {
                role: "assistant".to_owned(),
                content: "a".to_owned(),
            },
        ];
        let c = build_contents(Some(&history), "now");
        assert_eq!(c[0]["role"], "user");
        assert_eq!(c[1]["role"], "model");
        assert_eq!(c[1]["parts"][0]["text"], "a");
        assert_eq!(c[2]["role"], "user");
        assert_eq!(c[2]["parts"][0]["text"], "now");
    }

    #[test]
    fn extract_text_joins_parts() {
        let response = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "hello "},
                        {"text": "world"},
                    ]
                }
            }]
        });
        assert_eq!(extract_text(&response), "hello world");
    }

    #[test]
    fn extract_text_returns_empty_when_missing() {
        assert_eq!(extract_text(&json!({})), "");
        assert_eq!(extract_text(&json!({"candidates": []})), "");
    }

    #[test]
    fn extract_function_calls_returns_some_when_present() {
        let response = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {"text": "calling"},
                        {"functionCall": {"name": "foo", "args": {}}},
                    ]
                }
            }]
        });
        let calls = extract_function_calls(&response).expect("expected calls");
        assert_eq!(calls.as_array().unwrap().len(), 1);
        assert_eq!(calls[0]["name"], "foo");
    }

    #[test]
    fn extract_function_calls_returns_none_when_absent() {
        let response = json!({"candidates": [{"content": {"parts": [{"text": "hi"}]}}]});
        assert!(extract_function_calls(&response).is_none());
    }

    #[test]
    fn gemini_value_uses_snake_case_fields() {
        let api_response = json!({
            "candidates": [{
                "content": {"parts": [{"text": "out"}]}
            }],
            "promptFeedback": {"blocked": false},
            "usageMetadata": {"totalTokenCount": 10},
        });
        let value = build_gemini_value(&api_response);
        assert_eq!(value["text"], "out");
        assert!(value["candidates"].is_array());
        assert_eq!(value["prompt_feedback"]["blocked"], false);
        assert_eq!(value["usage_metadata"]["totalTokenCount"], 10);
        // Absent → Null, not omitted.
        assert!(value["function_calls"].is_null());
    }

    #[test]
    fn parse_api_error_extracts_message() {
        let body = r#"{"error":{"code":400,"message":"bad model","status":"INVALID_ARGUMENT"}}"#;
        assert_eq!(parse_api_error(body).as_deref(), Some("bad model"));
    }

    #[test]
    fn parse_api_error_returns_none_on_malformed_input() {
        assert!(parse_api_error("xxx").is_none());
        assert!(parse_api_error(r#"{"error":{"code":500}}"#).is_none());
    }
}
