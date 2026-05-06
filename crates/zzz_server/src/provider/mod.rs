pub mod anthropic;
pub mod gemini;
pub mod ollama;
pub mod openai;

use std::collections::HashMap;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

use fuz_common::JsonRpcError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::rpc;

// -- Provider name enum -------------------------------------------------------

/// Known AI provider names.
///
/// Matches the TypeScript `ProviderName = 'ollama' | 'claude' | 'chatgpt' | 'gemini'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderName {
    Ollama,
    Claude,
    Chatgpt,
    Gemini,
}

impl ProviderName {
    #[allow(dead_code)]
    pub const ALL: [Self; 4] = [Self::Ollama, Self::Claude, Self::Chatgpt, Self::Gemini];
}

impl fmt::Display for ProviderName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ollama => write!(f, "ollama"),
            Self::Claude => write!(f, "claude"),
            Self::Chatgpt => write!(f, "chatgpt"),
            Self::Gemini => write!(f, "gemini"),
        }
    }
}

// -- Provider status ----------------------------------------------------------

/// Status of an AI provider.
///
/// Matches the TypeScript `ProviderStatus` discriminated union:
/// `{name, available: true, checked_at}` or `{name, available: false, error, checked_at}`.
///
/// When `error` is `None`, the `error` field is omitted from JSON output,
/// producing `{name, available: true, checked_at}`. When `Some`, produces
/// `{name, available: false, error, checked_at}`.
#[derive(Debug, Clone, Serialize)]
pub struct ProviderStatus {
    pub name: String,
    pub available: bool,
    pub checked_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ProviderStatus {
    pub fn available(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            available: true,
            checked_at: now_millis(),
            error: None,
        }
    }

    pub fn unavailable(name: &str, error: &str) -> Self {
        Self {
            name: name.to_owned(),
            available: false,
            checked_at: now_millis(),
            error: Some(error.to_owned()),
        }
    }
}

// -- Completion types ---------------------------------------------------------

/// Options controlling completion generation.
///
/// Matches the TypeScript `CompletionOptions` interface from `backend_provider.ts`.
/// Also serves as server-level defaults (stored on `App`, cloned per-request).
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
pub struct CompletionHandlerOptions {
    pub model: String,
    pub completion_options: CompletionOptions,
    pub completion_messages: Option<Vec<CompletionMessage>>,
    pub prompt: String,
    pub progress_token: Option<String>,
}

/// Callback for sending streaming progress notifications.
///
/// Built by the handler from `ctx.notify` + `progress_token` — providers
/// invoke it with each chunk and never see the underlying transport.
pub type ProgressSender = Box<dyn Fn(Value) + Send + Sync>;

// -- Provider enum ------------------------------------------------------------

/// Enum-dispatched AI provider.
///
/// Uses enum instead of trait objects: exactly 4 providers, known at compile
/// time. Gives exhaustive matching, no heap indirection, simpler lifetimes.
pub enum Provider {
    Anthropic(anthropic::AnthropicProvider),
    OpenAi(openai::OpenAiProvider),
    Gemini(gemini::GeminiProvider),
    Ollama(ollama::OllamaProvider),
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
            Self::Ollama(_) => ProviderName::Ollama,
        }
    }

    pub async fn load_status(&self, reload: bool) -> ProviderStatus {
        match self {
            Self::Anthropic(p) => p.load_status(reload).await,
            Self::OpenAi(p) => p.load_status(reload).await,
            Self::Gemini(p) => p.load_status(reload).await,
            Self::Ollama(p) => p.load_status(reload).await,
        }
    }

    pub async fn set_api_key(&self, key: Option<String>) {
        match self {
            Self::Anthropic(p) => p.set_api_key(key).await,
            Self::OpenAi(p) => p.set_api_key(key).await,
            Self::Gemini(p) => p.set_api_key(key).await,
            Self::Ollama(_) => {}
        }
    }

    pub async fn complete(
        &self,
        options: &CompletionHandlerOptions,
        progress_sender: Option<&ProgressSender>,
        signal: &CancellationToken,
    ) -> Result<Value, JsonRpcError> {
        match self {
            Self::Anthropic(p) => p.complete(options, progress_sender, signal).await,
            Self::OpenAi(_) | Self::Gemini(_) | Self::Ollama(_) => {
                Err(rpc::internal_error(&format!(
                    "{}: not yet implemented in Rust backend",
                    self.name()
                )))
            }
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
    pub fn require(&self, name: ProviderName) -> Result<&Provider, JsonRpcError> {
        self.get(name)
            .ok_or_else(|| rpc::internal_error(&format!("provider not found: {name}")))
    }

    /// Iterate all providers (for `session_load` status collection).
    pub fn all(&self) -> impl Iterator<Item = &Provider> {
        self.providers.values()
    }
}

// -- Error helpers ------------------------------------------------------------

pub const PROVIDER_ERROR_NEEDS_API_KEY: &str = "needs API key";
pub const PROVIDER_ERROR_NOT_INSTALLED: &str = "not installed";

pub fn ai_provider_error(provider_name: &str, message: &str) -> JsonRpcError {
    rpc::internal_error(&format!("{provider_name}: {message}"))
}

// -- Helpers ------------------------------------------------------------------

#[expect(clippy::cast_possible_truncation, reason = "millis won't exceed u64 for centuries")]
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
