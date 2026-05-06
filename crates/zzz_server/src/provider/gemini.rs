use tokio::sync::RwLock;

use super::{ProviderStatus, PROVIDER_ERROR_NEEDS_API_KEY};

struct GeminiState {
    api_key: Option<String>,
    cached_status: Option<ProviderStatus>,
}

/// Google Gemini provider stub.
///
/// Full implementation will follow the Anthropic provider pattern.
pub struct GeminiProvider {
    state: RwLock<GeminiState>,
}

impl GeminiProvider {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
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
            ProviderStatus::available("gemini")
        } else {
            ProviderStatus::unavailable("gemini", PROVIDER_ERROR_NEEDS_API_KEY)
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
