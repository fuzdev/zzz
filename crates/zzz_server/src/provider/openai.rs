use tokio::sync::RwLock;

use super::{ProviderStatus, PROVIDER_ERROR_NEEDS_API_KEY};

struct OpenAiState {
    api_key: Option<String>,
    cached_status: Option<ProviderStatus>,
}

/// OpenAI/ChatGPT provider stub.
///
/// Full implementation will follow the Anthropic provider pattern.
pub struct OpenAiProvider {
    state: RwLock<OpenAiState>,
}

impl OpenAiProvider {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
            state: RwLock::new(OpenAiState {
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
            ProviderStatus::available("chatgpt")
        } else {
            ProviderStatus::unavailable("chatgpt", PROVIDER_ERROR_NEEDS_API_KEY)
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
}
