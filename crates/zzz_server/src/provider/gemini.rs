use std::ops::ControlFlow;

use fuz_http::JsonrpcError;
use serde_json::{Value, json};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::{
    CompletionHandlerOptions, CompletionMessage, PROVIDER_ERROR_NEEDS_API_KEY, ProgressSender,
    ProviderStatus, ai_provider_error, common, sse,
};

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const PROVIDER_NAME: &str = "gemini";

struct GeminiState {
    api_key: Option<String>,
    cached_status: Option<ProviderStatus>,
}

/// Google Gemini AI provider.
///
/// Uses the Generative Language REST API directly. SDK is not used to
/// avoid the dependency; the REST surface mirrors the SDK closely.
pub struct GeminiProvider {
    /// Client carries no auth headers (Gemini puts the key in the URL),
    /// so it's stable for the provider's lifetime and lives outside the
    /// `RwLock` to avoid serializing clone-out behind status writes.
    client: reqwest::Client,
    state: RwLock<GeminiState>,
}

impl GeminiProvider {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
            client: build_client(),
            state: RwLock::new(GeminiState {
                api_key,
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
        state.api_key = key;
        state.cached_status = None;
    }

    pub async fn complete(
        &self,
        options: &CompletionHandlerOptions,
        progress_sender: Option<&ProgressSender>,
        signal: &CancellationToken,
    ) -> Result<Value, JsonrpcError> {
        let api_key = {
            let state = self.state.read().await;
            state
                .api_key
                .clone()
                .ok_or_else(|| ai_provider_error(PROVIDER_NAME, PROVIDER_ERROR_NEEDS_API_KEY))?
        };
        let client = self.client.clone();

        let streaming = progress_sender.is_some();
        let url = build_url(&options.model, &api_key, streaming);
        let body = build_request_body(options);

        let response = client
            .post(&url)
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
    let value = build_gemini_value(&api_response);
    Ok(common::build_completion_response(
        PROVIDER_NAME,
        &options.model,
        &value,
    ))
}

async fn handle_streaming_response(
    response: reqwest::Response,
    options: &CompletionHandlerOptions,
    progress_sender: &ProgressSender,
    signal: &CancellationToken,
) -> Result<Value, JsonrpcError> {
    let mut accumulated_content = String::new();
    let mut last_response: Option<Value> = None;
    let mut usage_metadata: Option<Value> = None;

    sse::consume_sse_stream(response, PROVIDER_NAME, signal, |event| {
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return ControlFlow::Continue(());
        };

        let chunk_text = extract_text(&data);
        if !chunk_text.is_empty() {
            accumulated_content.push_str(&chunk_text);
            progress_sender(common::build_text_progress_chunk(&chunk_text));
        }

        if let Some(usage) = data.get("usageMetadata") {
            usage_metadata = Some(usage.clone());
        }
        last_response = Some(data);

        ControlFlow::Continue(())
    })
    .await?;

    let candidates = last_response
        .as_ref()
        .and_then(|r| r.get("candidates"))
        .cloned()
        .unwrap_or(Value::Null);
    let function_calls = last_response
        .as_ref()
        .and_then(extract_function_calls)
        .unwrap_or(Value::Null);
    let prompt_feedback = last_response
        .as_ref()
        .and_then(|r| r.get("promptFeedback"))
        .cloned()
        .unwrap_or(Value::Null);

    let value = json!({
        "text": accumulated_content,
        "candidates": candidates,
        "function_calls": function_calls,
        "prompt_feedback": prompt_feedback,
        "usage_metadata": usage_metadata.unwrap_or(Value::Null),
    });

    Ok(common::build_completion_response(
        PROVIDER_NAME,
        &options.model,
        &value,
    ))
}

// -- Response extraction ------------------------------------------------------

/// Build the `value` payload for the discriminated union — Gemini is the
/// only provider with strictly-typed `value` fields (`text`,
/// `candidates`, `function_calls`, `prompt_feedback`, `usage_metadata`).
fn build_gemini_value(api_response: &Value) -> Value {
    let text = extract_text(api_response);
    let candidates = api_response.get("candidates").cloned().unwrap_or(Value::Null);
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

fn build_url(model: &str, api_key: &str, streaming: bool) -> String {
    let method = if streaming {
        "streamGenerateContent"
    } else {
        "generateContent"
    };
    if streaming {
        format!("{API_BASE}/{model}:{method}?alt=sse&key={api_key}")
    } else {
        format!("{API_BASE}/{model}:{method}?key={api_key}")
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

    if !opts.system_message.is_empty() {
        let obj = body.as_object_mut().unwrap_or_else(|| unreachable!());
        obj.insert(
            "systemInstruction".to_owned(),
            json!({
                "parts": [{"text": opts.system_message}],
            }),
        );
    }

    body
}

fn build_contents(completion_messages: Option<&[CompletionMessage]>, prompt: &str) -> Vec<Value> {
    let capacity = completion_messages.map_or(0, <[_]>::len) + 1;
    let mut contents = Vec::with_capacity(capacity);

    if let Some(msgs) = completion_messages {
        for msg in msgs {
            let role = if msg.role == "user" { "user" } else { "model" };
            contents.push(json!({
                "role": role,
                "parts": [{"text": msg.content}],
            }));
        }
    }

    contents.push(json!({
        "role": "user",
        "parts": [{"text": prompt}],
    }));

    contents
}

// -- HTTP client --------------------------------------------------------------

fn build_client() -> reqwest::Client {
    common::build_client_with_headers(reqwest::header::HeaderMap::new())
}

// -- Error parsing ------------------------------------------------------------

/// Parse a Gemini API error response body.
///
/// Gemini errors look like: `{"error":{"code":...,"message":"...","status":"..."}}`
fn parse_api_error(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(String::from)
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

    #[test]
    fn url_streaming_uses_sse_endpoint() {
        let url = build_url("gemini-1.5-flash", "KEY", true);
        assert!(url.contains(":streamGenerateContent"));
        assert!(url.contains("alt=sse"));
        assert!(url.contains("key=KEY"));
    }

    #[test]
    fn url_non_streaming_uses_basic_endpoint() {
        let url = build_url("gemini-1.5-flash", "KEY", false);
        assert!(url.contains(":generateContent"));
        assert!(!url.contains("streamGenerateContent"));
        assert!(!url.contains("alt=sse"));
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
