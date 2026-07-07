pub mod anthropic;
pub mod common;
pub mod gemini;
pub mod openai;
pub mod sse;

use std::collections::HashMap;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use fuz_http::{JsonrpcError, internal_error};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

// -- Provider name enum -------------------------------------------------------

/// Known AI provider names.
///
/// Matches the TypeScript `ProviderName = 'claude' | 'chatgpt' | 'gemini'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderName {
    Claude,
    Chatgpt,
    Gemini,
}

impl ProviderName {
    #[allow(dead_code)]
    pub const ALL: [Self; 3] = [Self::Claude, Self::Chatgpt, Self::Gemini];

    /// Parse a wire-format provider name (lowercase) without going through
    /// `serde_json` — avoids allocating a `Value::String` per request.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "chatgpt" => Some(Self::Chatgpt),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    /// The lowercase wire name — the single home for these literals.
    /// `Display`, the serde rename, and each provider's `PROVIDER_NAME`
    /// `&str` all derive from this (the inverse of `parse`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Chatgpt => "chatgpt",
            Self::Gemini => "gemini",
        }
    }
}

impl fmt::Display for ProviderName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

// -- Provider status ----------------------------------------------------------

/// Status of an AI provider.
///
/// Mirrors the TypeScript `ProviderStatus` discriminated union — exactly one of
/// `{name, available: true, checked_at}` or
/// `{name, available: false, error, checked_at}`. Modeling it as an enum makes
/// the impossible combinations (available-with-error, unavailable-without-error)
/// unrepresentable rather than holding them off with private constructors; the
/// custom `Serialize` emits the flat wire shape `available`/`error` describe.
#[derive(Debug, Clone)]
pub enum ProviderStatus {
    Available {
        name: ProviderName,
        checked_at: u64,
    },
    Unavailable {
        name: ProviderName,
        checked_at: u64,
        error: String,
    },
}

impl ProviderStatus {
    pub fn available(name: ProviderName) -> Self {
        Self::Available {
            name,
            checked_at: now_millis(),
        }
    }

    pub fn unavailable(name: ProviderName, error: &str) -> Self {
        Self::Unavailable {
            name,
            checked_at: now_millis(),
            error: error.to_owned(),
        }
    }
}

impl Serialize for ProviderStatus {
    /// Flat wire shape: `{name, available, checked_at}` for the available case,
    /// plus `error` for the unavailable one. Field order matches the prior
    /// struct so the serialized bytes are unchanged.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        match self {
            Self::Available { name, checked_at } => {
                let mut s = serializer.serialize_struct("ProviderStatus", 3)?;
                s.serialize_field("name", name)?;
                s.serialize_field("available", &true)?;
                s.serialize_field("checked_at", checked_at)?;
                s.end()
            }
            Self::Unavailable {
                name,
                checked_at,
                error,
            } => {
                let mut s = serializer.serialize_struct("ProviderStatus", 4)?;
                s.serialize_field("name", name)?;
                s.serialize_field("available", &false)?;
                s.serialize_field("checked_at", checked_at)?;
                s.serialize_field("error", error)?;
                s.end()
            }
        }
    }
}

// -- Completion types ---------------------------------------------------------

/// Options controlling completion generation.
///
/// Server-level defaults (stored on `App`, cloned per-request).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct CompletionOptions {
    pub frequency_penalty: Option<f64>,
    pub output_token_max: u32,
    pub presence_penalty: Option<f64>,
    pub seed: Option<u64>,
    pub stop_sequences: Option<Vec<String>>,
    pub system_message: String,
    pub temperature: Option<f64>,
    pub top_k: Option<u32>,
    pub top_p: Option<f64>,
}

impl Default for CompletionOptions {
    fn default() -> Self {
        Self {
            output_token_max: 8192,
            system_message: String::new(),
            frequency_penalty: None,
            presence_penalty: None,
            seed: None,
            stop_sequences: None,
            temperature: None,
            top_k: None,
            top_p: None,
        }
    }
}

/// A single message in a completion conversation.
///
/// Matches the TypeScript `CompletionMessage = {role: string, content: string}`.
#[derive(Debug, Clone, Deserialize)]
pub struct CompletionMessage {
    pub role: String,
    pub content: String,
}

/// Options passed to a provider's complete method.
///
/// Streaming is keyed off the presence of a `ProgressSender` argument
/// to `complete`, not a field here — the handler builds the sender from
/// the request's `progressToken` and only constructs one when streaming
/// is requested.
pub struct CompletionHandlerOptions {
    pub model: String,
    pub completion_options: CompletionOptions,
    pub completion_messages: Option<Vec<CompletionMessage>>,
    pub prompt: String,
}

/// Callback for sending streaming progress notifications.
///
/// Built by the handler from `ctx.notify` + `progress_token` — providers
/// invoke it with each chunk and never see the underlying transport.
pub type ProgressSender = Box<dyn Fn(Value) + Send + Sync>;

// -- Provider enum ------------------------------------------------------------

/// Enum-dispatched AI provider.
///
/// Uses enum instead of trait objects: exactly 3 providers, known at compile
/// time. Gives exhaustive matching, no heap indirection, simpler lifetimes.
pub enum Provider {
    Anthropic(anthropic::AnthropicProvider),
    OpenAi(openai::OpenAiProvider),
    Gemini(gemini::GeminiProvider),
}

impl fmt::Debug for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Provider({})", self.name())
    }
}

impl Provider {
    pub const fn name(&self) -> ProviderName {
        match self {
            Self::Anthropic(_) => ProviderName::Claude,
            Self::OpenAi(_) => ProviderName::Chatgpt,
            Self::Gemini(_) => ProviderName::Gemini,
        }
    }

    pub async fn load_status(&self, reload: bool) -> ProviderStatus {
        match self {
            Self::Anthropic(p) => p.load_status(reload).await,
            Self::OpenAi(p) => p.load_status(reload).await,
            Self::Gemini(p) => p.load_status(reload).await,
        }
    }

    pub async fn set_api_key(&self, key: Option<String>) {
        match self {
            Self::Anthropic(p) => p.set_api_key(key).await,
            Self::OpenAi(p) => p.set_api_key(key).await,
            Self::Gemini(p) => p.set_api_key(key).await,
        }
    }

    pub async fn complete(
        &self,
        options: &CompletionHandlerOptions,
        progress_sender: Option<&ProgressSender>,
        signal: &CancellationToken,
    ) -> Result<Value, JsonrpcError> {
        match self {
            Self::Anthropic(p) => p.complete(options, progress_sender, signal).await,
            Self::OpenAi(p) => p.complete(options, progress_sender, signal).await,
            Self::Gemini(p) => p.complete(options, progress_sender, signal).await,
        }
    }
}

// -- Provider manager ---------------------------------------------------------

/// Manages all AI providers.
///
/// Constructed once in `main`, stored in `App`.
pub struct ProviderManager {
    providers: HashMap<ProviderName, Provider>,
}

impl fmt::Debug for ProviderManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderManager")
            .field("providers", &self.providers.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl ProviderManager {
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
        }
    }

    pub fn add(&mut self, provider: Provider) {
        self.providers.insert(provider.name(), provider);
    }

    pub fn get(&self, name: ProviderName) -> Option<&Provider> {
        self.providers.get(&name)
    }

    /// Get a provider or return a `method_not_found`-style error.
    pub fn require(&self, name: ProviderName) -> Result<&Provider, JsonrpcError> {
        self.get(name)
            .ok_or_else(|| internal_error(&format!("provider not found: {name}")))
    }

    /// Iterate all providers (for `session_load` status collection).
    pub fn all(&self) -> impl Iterator<Item = &Provider> {
        self.providers.values()
    }
}

// -- Error helpers ------------------------------------------------------------

pub const PROVIDER_ERROR_NEEDS_API_KEY: &str = "needs API key";
pub const PROVIDER_ERROR_NOT_INSTALLED: &str = "not installed";

pub fn ai_provider_error(provider_name: &str, message: &str) -> JsonrpcError {
    internal_error(&format!("{provider_name}: {message}"))
}

// -- Helpers ------------------------------------------------------------------

#[expect(
    clippy::cast_possible_truncation,
    reason = "millis won't exceed u64 for centuries"
)]
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    #[test]
    fn available_serializes_to_flat_wire_shape() {
        let status = ProviderStatus::Available {
            name: ProviderName::Claude,
            checked_at: 42,
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"name": "claude", "available": true, "checked_at": 42}),
        );
    }

    #[test]
    fn unavailable_serializes_with_error() {
        let status = ProviderStatus::Unavailable {
            name: ProviderName::Claude,
            checked_at: 7,
            error: "needs API key".to_owned(),
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "name": "claude",
                "available": false,
                "checked_at": 7,
                "error": "needs API key",
            }),
        );
    }
}
