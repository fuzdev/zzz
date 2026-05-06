use tokio::sync::RwLock;

use super::{ProviderStatus, PROVIDER_ERROR_NOT_INSTALLED};

struct OllamaState {
    cached_status: Option<ProviderStatus>,
}

/// Ollama local provider stub.
///
/// Full implementation will check local Ollama installation via HTTP client
/// and provide model management + completion support.
pub struct OllamaProvider {
    state: RwLock<OllamaState>,
}

impl OllamaProvider {
    pub fn new() -> Self {
        Self {
            state: RwLock::new(OllamaState {
                cached_status: None,
            }),
        }
    }

    pub async fn load_status(&self, reload: bool) -> ProviderStatus {
        let state = self.state.read().await;
        if !reload && let Some(ref status) = state.cached_status {
            return status.clone();
        }
        drop(state);

        // Stub: always unavailable until Ollama integration is implemented
        let status = ProviderStatus::unavailable("ollama", PROVIDER_ERROR_NOT_INSTALLED);

        let mut state = self.state.write().await;
        state.cached_status = Some(status.clone());
        status
    }
}
