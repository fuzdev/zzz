//! Long-lived `App` server state plus the surviving Strategy α
//! `App.broadcast` / `close_sockets_for_*` shims.
//!
//! Phase 7 Batch 4 retired the legacy dispatch surface here:
//! - The per-domain handler submodules (`account`, `admin`, `filesystem`,
//!   `provider`, `terminal`, `workspace`) deleted — `handlers_v2/*` +
//!   `zzz_action_specs/*` cover the spine-backed dispatch path.
//! - `Ctx<'_>` / `NotifyFn` / `dispatch` / `dispatch_with_tx` /
//!   `dispatch_no_tx` / `method_spec` / `check_action_auth` /
//!   `MethodSpec` / `ActionAuth` retired wholesale — `fuz_actions::perform_action`
//!   on the spine route owns the dispatch + auth-check surface.
//! - `App.allowed_origins` / `bootstrap_token_path` / `bootstrap_available` /
//!   `audit` / `keyring` / `daemon_token_state` / `login_*_rate_limiter` /
//!   `account_route_state` / `bootstrap_route_state` / `spine_allowed_origins` /
//!   `spine_trusted_proxies` dropped — those fields moved into the spine
//!   `AccountRouteState` / `BootstrapRouteState` / `RpcRouteState` /
//!   `WsRouteState` built directly in `main.rs`.
//!
//! What survives:
//! - `App` — zzz-specific deps (`workspaces`, `FilerManager`, `PtyManager`,
//!   `ProviderManager`, `ScopedFs`, `zzz_dir`, `scoped_dirs`,
//!   `enable_test_actions`, the boot-compiled `action_registry`).
//! - `App.realtime` — sole connection-tracking surface, drives the
//!   Strategy α `broadcast` / `close_sockets_for_*` shims still called
//!   from `filer.rs` / `pty_manager.rs` / `handlers_v2/workspace.rs`.
//! - `WorkspaceInfo` — value type consumed by `handlers_v2/workspace`.

use std::collections::HashMap;
use std::sync::Arc;

use deadpool_postgres::Pool;
use parking_lot::RwLock;
use serde::Serialize;

use crate::filer::FilerManager;
use crate::provider::{CompletionOptions, ProviderManager};
use crate::pty_manager::PtyManager;
use crate::scoped_fs::ScopedFs;

use fuz_actions::ActionRegistry;
use fuz_realtime::ConnectionRegistry;

// -- App state (long-lived, shared via Arc) -----------------------------------

/// Server state shared across all requests.
///
/// Constructed once in `main`, wrapped in `Arc`, passed into the spec
/// builders + the spine RPC / WS route states.
pub struct App {
    pub workspaces: RwLock<HashMap<String, WorkspaceInfo>>,
    pub db_pool: Pool,
    pub scoped_fs: ScopedFs,
    pub zzz_dir: String,
    pub scoped_dirs: Vec<String>,
    /// Active file watchers — one per unique directory path, with lifetime
    /// tracking.
    pub filer_manager: FilerManager,
    /// PTY terminal manager.
    pub pty_manager: PtyManager,
    /// AI provider manager (Anthropic, `OpenAI`, Gemini, Ollama).
    pub provider_manager: ProviderManager,
    /// Default completion options.
    pub completion_options: CompletionOptions,
    /// Register `_test_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave false.
    /// Read in `main.rs` at registry-compile time to conditionally
    /// extend the spec set via `zzz_action_specs::build_test_specs`.
    pub enable_test_actions: bool,
    /// `Arc<ConnectionRegistry>` — the spine's connection-tracking
    /// registry. Sole connection store on `App`; drives the
    /// `broadcast` / `close_sockets_for_*` shims below.
    pub realtime: Arc<ConnectionRegistry>,
    /// Compiled spine action registry. Holds protocol +
    /// `auth_adapter::build_account_specs` + `build_admin_specs` plus the
    /// zzz-specific specs from `zzz_action_specs::build_*_specs`.
    ///
    /// **Wrapped in `OnceLock`** so it can be set after `Arc<App>` is
    /// constructed — the spec builders close over `Arc<App>`, so the
    /// registry can't be built until the App `Arc` exists.
    pub action_registry: std::sync::OnceLock<Arc<ActionRegistry>>,
}

/// Spine-side fields packaged together so `App::new`'s argument list
/// doesn't grow past the existing clippy threshold. Constructed at the
/// composition root (main.rs) and moved into `App`.
pub struct SpineState {
    pub realtime: Arc<ConnectionRegistry>,
}

impl App {
    pub fn new(
        db_pool: Pool,
        scoped_fs: ScopedFs,
        zzz_dir: String,
        scoped_dirs: Vec<String>,
        provider_manager: ProviderManager,
        enable_test_actions: bool,
        spine: SpineState,
    ) -> Self {
        Self {
            workspaces: RwLock::new(HashMap::new()),
            db_pool,
            scoped_fs,
            zzz_dir,
            scoped_dirs,
            filer_manager: FilerManager::new(),
            pty_manager: PtyManager::new(),
            provider_manager,
            completion_options: CompletionOptions::default(),
            enable_test_actions,
            realtime: spine.realtime,
            action_registry: std::sync::OnceLock::new(),
        }
    }

    /// Broadcast a message to all connected clients.
    ///
    /// Strategy α shim over `App.realtime`. The spine WS handler
    /// registers connections in `App.realtime`
    /// (`Arc<fuz_realtime::ConnectionRegistry>`); existing call sites
    /// (`filer::broadcast_filer_change`, `pty_manager` terminal data /
    /// exited, `handlers_v2::workspace::workspace_*`) stay verbatim
    /// through this shim.
    pub fn broadcast(&self, message: &str) {
        let _ = self.realtime.broadcast(message);
    }
}

// -- Domain types -------------------------------------------------------------

/// Metadata for an open workspace directory.
///
/// Matches the TypeScript `WorkspaceInfoJson` schema:
/// `{ path: string, name: string, opened_at: string }`.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}
