//! Shared helpers used by every provider implementation.
//!
//! - Response shaping: `build_completion_response` wraps a provider's final
//!   payload in the discriminated-union envelope the frontend expects, and
//!   `build_text_progress_chunk` produces the uniform streaming-chunk shape
//!   `{message: {role, content}}` the text-streaming providers emit on every
//!   delta.
//! - HTTP plumbing: the shared `reqwest::Client` builder (with a connect
//!   timeout), cancellable `send_request` / `read_json_body`, and
//!   `reqwest_error_message`, which strips the request URL so nothing in a
//!   query string can leak into a JSON-RPC error message.
//! - Message shaping: `is_blank` and `join_system_text`, used by each
//!   provider's request builder to drop empty messages and to lift `system`
//!   messages out of the conversation history.

use std::time::Duration;

use fuz_http::{JsonrpcError, request_cancelled};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    CompletionMessage, PROVIDER_ERROR_NEEDS_API_KEY, ProviderName, ProviderStatus,
    ai_provider_error,
};

/// Bound on establishing the TCP + TLS connection to a provider API.
///
/// Only the connect phase is bounded — there is deliberately no overall
/// request timeout, because streaming completions legitimately run for
/// minutes. Stalls after connect are covered by cancellation instead.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The message on the `request_cancelled` error a cancelled completion
/// returns.
const CANCELLED_MESSAGE: &str = "completion cancelled";

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

/// Build the shared provider `reqwest::Client` with `headers` as defaults.
///
/// Applies `CONNECT_TIMEOUT`.
///
/// # Errors
///
/// Returns a message when `reqwest` can't build the client (e.g. the TLS
/// backend fails to initialize). There is deliberately no fallback client:
/// one would silently drop the auth headers and the connect timeout.
pub fn build_client_with_headers(headers: HeaderMap) -> Result<reqwest::Client, String> {
    // reqwest uses `rustls-no-provider`; install the `ring` provider first.
    fuz_sys::tls::ensure_crypto_provider();
    reqwest::Client::builder()
        .default_headers(headers)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("failed to build HTTP client: {}", reqwest_error_message(e)))
}

/// Build a header value for a credential, marked sensitive so it's
/// redacted from `Debug` output (and HPACK-indexed as never-cached).
///
/// # Errors
///
/// Returns a message when `value` contains bytes that aren't valid in a
/// header (e.g. a smart quote pasted into `.env`).
pub fn sensitive_header_value(value: &str) -> Result<HeaderValue, String> {
    let mut header = HeaderValue::from_str(value).map_err(|_| {
        String::from("invalid API key: contains characters not allowed in an HTTP header")
    })?;
    header.set_sensitive(true);
    Ok(header)
}

/// Check that an API key is visible ASCII.
///
/// Every provider's keys are; whitespace, control, or non-ASCII characters
/// mean a paste error (e.g. a smart quote in `.env`). `HeaderValue` alone
/// isn't enough: it admits bytes `0x80..=0xFF`, which would go upstream
/// verbatim.
///
/// # Errors
///
/// Returns the client-facing reason when the key is malformed.
pub fn validate_api_key(key: &str) -> Result<(), String> {
    if key.bytes().all(|b| b.is_ascii_graphic()) {
        Ok(())
    } else {
        Err(String::from(
            "invalid API key: contains whitespace, control, or non-ASCII characters",
        ))
    }
}

/// Build a provider client that sends `value` (the API key, or e.g.
/// `Bearer {key}`) as the sensitive `header` on every request.
///
/// # Errors
///
/// Returns a message when the key isn't a valid header value or the client
/// can't be built.
pub fn build_auth_client(header: HeaderName, value: &str) -> Result<reqwest::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(header, sensitive_header_value(value)?);
    build_client_with_headers(headers)
}

/// A provider's configured HTTP client — or why there isn't one.
///
/// Built once at construction from the provider's API key. Making the
/// failure a state (rather than falling back to a header-less client) lets
/// `load_status` report it instead of claiming the provider is available and
/// failing every request upstream.
#[derive(Debug)]
pub enum ProviderClient {
    /// No API key configured.
    Missing,
    /// A key is configured but no usable client could be built from it.
    Invalid(String),
    Ready(reqwest::Client),
}

impl ProviderClient {
    /// Build from an optional API key with the provider's client builder.
    ///
    /// The key is validated first (see `validate_api_key`), so a malformed
    /// key reports why instead of being sent upstream to fail with a 401.
    pub fn from_api_key(
        api_key: Option<&str>,
        build: impl FnOnce(&str) -> Result<reqwest::Client, String>,
    ) -> Self {
        let Some(key) = api_key else {
            return Self::Missing;
        };
        match validate_api_key(key).and_then(|()| build(key)) {
            Ok(client) => Self::Ready(client),
            Err(message) => Self::Invalid(message),
        }
    }

    /// The provider status this client state implies.
    pub fn status(&self, name: ProviderName) -> ProviderStatus {
        match self {
            Self::Missing => ProviderStatus::unavailable(name, PROVIDER_ERROR_NEEDS_API_KEY),
            Self::Invalid(message) => ProviderStatus::unavailable(name, message),
            Self::Ready(_) => ProviderStatus::available(name),
        }
    }

    /// A clone of the ready client (cheap — internally `Arc`'d).
    ///
    /// # Errors
    ///
    /// Returns a provider-tagged error when no usable client exists.
    pub fn require(&self, name: ProviderName) -> Result<reqwest::Client, JsonrpcError> {
        match self {
            Self::Missing => Err(ai_provider_error(
                name.as_str(),
                PROVIDER_ERROR_NEEDS_API_KEY,
            )),
            Self::Invalid(message) => Err(ai_provider_error(name.as_str(), message)),
            Self::Ready(client) => Ok(client.clone()),
        }
    }
}

/// The error a cancelled completion returns — `request_cancelled`
/// (`-32010`), which the frontend distinguishes from a provider failure.
pub fn cancelled_error() -> JsonrpcError {
    request_cancelled(CANCELLED_MESSAGE)
}

/// Render a `reqwest::Error` for a client-facing message, with the request
/// URL stripped and the source chain appended.
///
/// `reqwest`'s `Display` includes `for url (...)`, which would leak
/// anything in the query string (historically the Gemini API key) into the
/// JSON-RPC error message and from there into the UI.
pub fn reqwest_error_message(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut message = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

/// Send `request`, racing it against `signal`.
///
/// # Errors
///
/// Returns `request_cancelled` when `signal` fires before the response
/// headers arrive, or a provider-tagged error when the request fails.
pub async fn send_request(
    request: reqwest::RequestBuilder,
    provider_name: &str,
    signal: &CancellationToken,
) -> Result<reqwest::Response, JsonrpcError> {
    tokio::select! {
        biased;
        () = signal.cancelled() => Err(cancelled_error()),
        result = request.send() => result
            .map_err(|e| ai_provider_error(provider_name, &reqwest_error_message(e))),
    }
}

/// Read and JSON-decode a (non-streaming) response body, racing it against
/// `signal`.
///
/// # Errors
///
/// Returns `request_cancelled` when `signal` fires first, or a
/// provider-tagged error when the body can't be read or decoded.
pub async fn read_json_body(
    response: reqwest::Response,
    provider_name: &str,
    signal: &CancellationToken,
) -> Result<Value, JsonrpcError> {
    tokio::select! {
        biased;
        () = signal.cancelled() => Err(cancelled_error()),
        result = response.json::<Value>() => result.map_err(|e| {
            ai_provider_error(
                provider_name,
                &format!("failed to parse response: {}", reqwest_error_message(e)),
            )
        }),
    }
}

/// Pass `response` through on success; on non-2xx, read the body, run
/// `parse_api_error` over it, and return a provider-tagged JSON-RPC error.
///
/// Each provider's wire format for errors differs (Anthropic, `OpenAI`,
/// Gemini wrap under `error.message`), so the parser is supplied per call.
///
/// # Errors
///
/// Returns the provider-tagged error for a non-2xx status, or
/// `request_cancelled` when `signal` fires while the error body is read.
pub async fn check_response_status<F>(
    response: reqwest::Response,
    provider_name: &str,
    signal: &CancellationToken,
    parse_api_error: F,
) -> Result<reqwest::Response, JsonrpcError>
where
    F: FnOnce(&str) -> Option<String>,
{
    if response.status().is_success() {
        return Ok(response);
    }
    let error_body = tokio::select! {
        biased;
        () = signal.cancelled() => return Err(cancelled_error()),
        text = response.text() => text.unwrap_or_else(|_| String::from("unknown error")),
    };
    let error_msg = parse_api_error(&error_body).unwrap_or(error_body);
    Err(ai_provider_error(provider_name, &error_msg))
}

/// Extract `error.message` from a provider JSON payload — the error shape
/// all three providers use, both for non-2xx bodies and for errors sent
/// mid-stream.
pub fn parse_error_message(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(String::from)
}

/// Whether `text` is empty or whitespace-only.
///
/// Providers reject (Anthropic) or ignore empty message content, so the
/// request builders drop blank messages.
pub fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// Whether a history message is a system message.
pub fn is_system_message(message: &CompletionMessage) -> bool {
    message.role == "system"
}

/// Combine the configured system message with any `system`-role history
/// messages into one system text, separated by blank lines.
///
/// Blank parts are skipped; returns `None` when nothing remains.
pub fn join_system_text(
    configured: &str,
    completion_messages: Option<&[CompletionMessage]>,
) -> Option<String> {
    let history = completion_messages
        .unwrap_or_default()
        .iter()
        .filter(|m| is_system_message(m))
        .map(|m| m.content.as_str());
    let mut joined = String::new();
    for part in std::iter::once(configured).chain(history) {
        if is_blank(part) {
            continue;
        }
        if !joined.is_empty() {
            joined.push_str("\n\n");
        }
        joined.push_str(part);
    }
    (!joined.is_empty()).then_some(joined)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> CompletionMessage {
        CompletionMessage {
            role: role.to_owned(),
            content: content.to_owned(),
        }
    }

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

    #[test]
    fn sensitive_header_value_is_marked_sensitive() {
        let header = sensitive_header_value("secret").unwrap();
        assert!(header.is_sensitive());
        assert_eq!(header, "secret");
    }

    #[test]
    fn sensitive_header_value_rejects_invalid_bytes() {
        let message = sensitive_header_value("bad\nkey").unwrap_err();
        assert!(message.contains("invalid API key"));
    }

    #[test]
    fn validate_api_key_accepts_visible_ascii() {
        validate_api_key("sk-ant-api03-AbC_123").unwrap();
    }

    #[test]
    fn validate_api_key_rejects_malformed_keys() {
        // a smart quote pasted into `.env`, inner whitespace, control bytes
        for key in ["sk-\u{201C}abc", "sk abc", "sk\tabc", "sk\u{7F}"] {
            assert!(validate_api_key(key).is_err(), "{key:?}");
        }
    }

    #[test]
    fn provider_client_missing_key_needs_api_key() {
        let client = ProviderClient::from_api_key(None, |_| unreachable!());
        let status = serde_json::to_value(client.status(ProviderName::Claude)).unwrap();
        assert_eq!(status["available"], false);
        assert_eq!(status["error"], PROVIDER_ERROR_NEEDS_API_KEY);
        assert!(client.require(ProviderName::Claude).is_err());
    }

    #[test]
    fn provider_client_invalid_key_is_unavailable_with_reason() {
        let client = ProviderClient::from_api_key(Some("sk-\u{201C}abc"), |key| {
            build_auth_client(HeaderName::from_static("x-api-key"), key)
        });
        let status = serde_json::to_value(client.status(ProviderName::Claude)).unwrap();
        assert_eq!(status["available"], false);
        assert!(status["error"].as_str().unwrap().contains("non-ASCII"));
        let error = client.require(ProviderName::Claude).unwrap_err();
        assert!(error.message.contains("invalid API key"));
    }

    #[test]
    fn provider_client_valid_key_is_available() {
        let client = ProviderClient::from_api_key(Some("sk-abc"), |key| {
            build_auth_client(HeaderName::from_static("x-api-key"), key)
        });
        let status = serde_json::to_value(client.status(ProviderName::Claude)).unwrap();
        assert_eq!(status["available"], true);
        assert!(client.require(ProviderName::Claude).is_ok());
    }

    #[tokio::test]
    async fn reqwest_error_message_strips_url() {
        let client = build_client_with_headers(HeaderMap::new()).unwrap();
        // an unsupported scheme fails inside reqwest before any I/O, with the
        // URL attached to the error
        let error = client
            .get("ftp://example.invalid/v1/models?key=SECRET_KEY_123")
            .send()
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("SECRET_KEY_123"),
            "precondition: reqwest's Display includes the URL"
        );
        let message = reqwest_error_message(error);
        assert!(!message.contains("SECRET_KEY_123"), "{message}");
        assert!(!message.contains("example.invalid"), "{message}");
    }

    #[test]
    fn cancelled_error_uses_request_cancelled_code() {
        let error = cancelled_error();
        assert_eq!(error.code, fuz_http::JsonrpcErrorCode::RequestCancelled);
    }

    #[test]
    fn parse_error_message_reads_error_message() {
        let value = json!({"error": {"message": "overloaded"}});
        assert_eq!(parse_error_message(&value).as_deref(), Some("overloaded"));
        assert!(parse_error_message(&json!({"error": "flat"})).is_none());
        assert!(parse_error_message(&json!({})).is_none());
    }

    #[test]
    fn is_blank_detects_whitespace_only() {
        assert!(is_blank(""));
        assert!(is_blank(" \n\t"));
        assert!(!is_blank(" x "));
    }

    #[test]
    fn join_system_text_combines_configured_and_history() {
        let history = vec![
            msg("system", "from history"),
            msg("user", "not system"),
            msg("system", "  "),
            msg("system", "second"),
        ];
        let joined = join_system_text("configured", Some(&history)).unwrap();
        assert_eq!(joined, "configured\n\nfrom history\n\nsecond");
    }

    #[test]
    fn join_system_text_none_when_all_blank() {
        assert!(join_system_text("", None).is_none());
        assert!(join_system_text(" ", Some(&[msg("system", "\n")])).is_none());
    }

    #[test]
    fn join_system_text_history_only() {
        let joined = join_system_text("", Some(&[msg("system", "only")])).unwrap();
        assert_eq!(joined, "only");
    }
}
