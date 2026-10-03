//! Long-lived `App` server state, the per-domain RPC handlers, and the
//! `App.broadcast` / `close_sockets_for_*` connection shims.
//!
//! The per-domain handler modules (`core`, `filesystem`, `provider`,
//! `terminal`, `workspace`) hold the zzz-specific RPC handlers in the spine
//! signature `(params: Value, ctx: ActionContext<'_>, app: Arc<App>) ->
//! Result<Value, JsonrpcError>`. They are registered into
//! `App.action_registry` via `crate::zzz_action_specs::build_*_specs`, which
//! own the `Arc<App>` and clone it into each per-spec handler closure — the
//! source of the zzz-specific deps (`PtyManager`, `FilerManager`,
//! `ProviderManager`, the workspaces map) that don't live on `ActionContext`.
//!
//! Auth, dispatch, and the JSON-RPC / WS routes come from the spine
//! (`fuz_actions::perform_action` plus the route states built in `main.rs`).
//! `App.realtime` is the sole connection-tracking surface; it drives the
//! `broadcast` / `close_sockets_for_*` shims called from `filer.rs` and
//! `workspace.rs`, and `pty_manager.rs` sends terminal notifications through
//! it to the owning account only (`send_to_account`). `WorkspaceInfo` is the value type
//! consumed by `workspace`.

pub mod core;
pub mod filesystem;
pub mod provider;
pub mod terminal;
pub mod workspace;

use std::collections::HashMap;
use std::sync::Arc;

use deadpool_postgres::Pool;
use parking_lot::RwLock;
use serde::Serialize;

use crate::filer::FilerManager;
use crate::provider::{CompletionOptions, ProviderManager};
use crate::pty_manager::PtyManager;
use crate::scoped_fs::ScopedFs;

use fuz_actions::{ActionContext, ActionRegistry};
use fuz_http::{JsonrpcError, unauthenticated};
use fuz_realtime::ConnectionRegistry;
use uuid::Uuid;

// -- App state (long-lived, shared via Arc) -----------------------------------

/// Server state shared across all requests.
///
/// Constructed once in `run_app`, wrapped in `Arc`, passed into the spec
/// builders + the spine RPC / WS route states.
pub struct App {
    /// Minted when the app starts — `session_load` returns it as
    /// `server_instance_id`, so a client that sees it change knows the daemon
    /// restarted (its terminals and runtime workspaces are gone).
    pub instance_id: Uuid,
    pub workspaces: RwLock<HashMap<String, WorkspaceInfo>>,
    /// Serializes `workspace_open` / `workspace_close`. Each spans the
    /// `workspaces` map, `ScopedFs`, and the workspace filer across await
    /// points; interleaved, an open could re-add scope and a watcher for a
    /// workspace a concurrent close just removed. A new workspace's initial
    /// scan runs before `workspace_open` takes it, so a large tree doesn't
    /// hold up other opens and closes.
    pub workspace_lifecycle: tokio::sync::Mutex<()>,
    pub db_pool: Pool,
    pub scoped_fs: ScopedFs,
    pub zzz_dir: String,
    pub scoped_dirs: Vec<String>,
    /// Active file watchers — one per unique directory path, with lifetime
    /// tracking.
    pub filer_manager: FilerManager,
    /// PTY terminal manager.
    pub pty_manager: PtyManager,
    /// AI provider manager (Anthropic, `OpenAI`, Gemini).
    pub provider_manager: ProviderManager,
    /// Completion options for every request — always
    /// `CompletionOptions::default()`, since `completion_create` accepts no
    /// options.
    pub completion_options: CompletionOptions,
    /// Register `_testing_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave false.
    /// Read in `run_app` at registry-compile time to conditionally
    /// extend the spec set via `zzz_action_specs::build_testing_specs`.
    pub enable_test_actions: bool,
    /// `Arc<ConnectionRegistry>` — the spine's connection-tracking
    /// registry. Sole connection store on `App`; drives the `broadcast`
    /// shim below.
    pub realtime: Arc<ConnectionRegistry>,
    /// Compiled spine action registry. Holds the protocol specs +
    /// `auth_adapter::build_auth_spec_set` plus the zzz-specific specs from
    /// `zzz_action_specs::build_*_specs`.
    ///
    /// **Wrapped in `OnceLock`** so it can be set after `Arc<App>` is
    /// constructed — the spec builders close over `Arc<App>`, so the
    /// registry can't be built until the App `Arc` exists.
    pub action_registry: std::sync::OnceLock<Arc<ActionRegistry>>,
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("instance_id", &self.instance_id)
            .field("zzz_dir", &self.zzz_dir)
            .field("scoped_dirs", &self.scoped_dirs)
            .field("enable_test_actions", &self.enable_test_actions)
            .finish_non_exhaustive()
    }
}

impl App {
    pub fn new(
        db_pool: Pool,
        scoped_fs: ScopedFs,
        zzz_dir: String,
        scoped_dirs: Vec<String>,
        provider_manager: ProviderManager,
        enable_test_actions: bool,
        realtime: Arc<ConnectionRegistry>,
    ) -> Self {
        Self {
            instance_id: Uuid::new_v4(),
            workspaces: RwLock::new(HashMap::new()),
            workspace_lifecycle: tokio::sync::Mutex::new(()),
            db_pool,
            scoped_fs,
            zzz_dir,
            scoped_dirs,
            filer_manager: FilerManager::new(),
            pty_manager: PtyManager::new(),
            provider_manager,
            completion_options: CompletionOptions::default(),
            enable_test_actions,
            realtime,
            action_registry: std::sync::OnceLock::new(),
        }
    }

    /// Broadcast a message to all connected clients.
    ///
    /// Shim over `App.realtime`. The spine WS handler registers
    /// connections in `App.realtime` (`Arc<fuz_realtime::ConnectionRegistry>`);
    /// call sites (`filer::broadcast_filer_change`, `workspace::workspace_*`)
    /// broadcast through this shim. Terminal output is per-account, so
    /// `pty_manager` uses `realtime.send_to_account` instead.
    pub fn broadcast(&self, message: &str) {
        let _ = self.realtime.broadcast(message);
    }
}

// -- Errors -------------------------------------------------------------------

/// The calling account. For specs that require an account, so a missing one
/// is refused rather than trusted.
///
/// # Errors
///
/// `unauthenticated` when the request carries no account.
pub fn caller_account_id(ctx: &ActionContext<'_>) -> Result<Uuid, JsonrpcError> {
    ctx.auth
        .account()
        .map(|account| account.id)
        .ok_or_else(unauthenticated)
}

/// A `not_found` (-32003) error with a caller-supplied `message` and
/// `data.reason`.
///
/// `fuz_http::not_found` fixes the message to `"{resource} not found"`; the
/// filesystem and workspace handlers keep their `failed to …: …` messages
/// (which name the path) across every code, so they build the error here.
#[cold]
pub fn not_found_error(message: &str, reason: &str) -> JsonrpcError {
    JsonrpcError {
        code: fuz_http::JsonrpcErrorCode::NotFound,
        message: message.to_owned(),
        data: Some(serde_json::json!({ "reason": reason })),
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
