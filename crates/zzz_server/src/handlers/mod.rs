//! Per-request handlers, dispatch table, and the long-lived `App` server state.
//!
//! Submodules group handlers by domain so navigation matches the action-spec
//! layout in `fuz_app` and `zzz`. The dispatch table here is the single
//! source of truth for which methods exist.

mod account;
mod admin;
mod filesystem;
mod provider;
mod terminal;
mod workspace;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64};

use axum::extract::ws::Utf8Bytes;
use deadpool_postgres::Pool;
use fuz_http::JsonrpcError;
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::audit::AuditEmitter;
use crate::auth::{self, CredentialType, Keyring, RequestContext};
use crate::daemon_token::SharedDaemonTokenState;
use crate::filer::FilerManager;
use crate::provider::{CompletionOptions, ProviderManager};
use crate::proxy::ParsedProxy;
use crate::pty_manager::PtyManager;
use crate::rate_limiter::RateLimiter;
use crate::rpc;
use crate::scoped_fs::ScopedFs;

// Spine-side type aliases — Phase 7 Batch 5 additive wiring. These pull
// the new spine-backed types into the handler module's namespace without
// touching the legacy `App` field names; both shapes coexist until the
// later batches retire the zzz-local impls.
use fuz_actions::ActionRegistry;
use fuz_auth::{AccountRouteState, AuditEmitter as SpineAuditEmitter, BootstrapRouteState};
use fuz_http::ParsedProxy as SpineParsedProxy;
use fuz_realtime::ConnectionRegistry;

// -- Connection tracking types ------------------------------------------------

/// Unique ID for a WebSocket connection, allocated via `App::next_connection_id`.
pub type ConnectionId = u64;

/// Handle to a connected WebSocket client — messages sent here are forwarded to the WS sink.
///
/// `Utf8Bytes` wraps `bytes::Bytes`, so per-recipient sends share a single
/// underlying buffer (refcount bump on `Clone`) instead of allocating a
/// fresh `String` per recipient. This is the win on broadcast — a
/// `filer_change` event with K subscribers used to do K `String::clone`s
/// of the same JSON; now it does one alloc + K refcount bumps.
pub type ConnectionSender = mpsc::UnboundedSender<Utf8Bytes>;

/// Metadata for an active WebSocket connection.
///
/// Tracks the channel sender plus auth context for targeted revocation:
/// - `token_hash`: blake3 hash of the session token (for session-level revocation)
/// - `account_id`: account UUID (for account-level revocation on logout/password change)
/// - `api_token_id`: `api_token.id` for bearer-authenticated connections (for
///   per-token revocation on `token_revoke` without tearing down the account's
///   other sockets)
pub struct ConnectionInfo {
    pub sender: ConnectionSender,
    pub token_hash: Option<String>,
    pub account_id: Option<uuid::Uuid>,
    pub api_token_id: Option<String>,
}

// -- App state (long-lived, shared via Arc) -----------------------------------

/// Server state shared across all requests.
///
/// Constructed once in `main`, wrapped in `Arc`, passed as axum `State`.
pub struct App {
    pub workspaces: RwLock<HashMap<String, WorkspaceInfo>>,
    pub db_pool: Pool,
    pub keyring: Keyring,
    pub allowed_origins: Vec<String>,
    pub bootstrap_token_path: Option<String>,
    pub bootstrap_available: AtomicBool,
    pub scoped_fs: ScopedFs,
    pub zzz_dir: String,
    pub scoped_dirs: Vec<String>,
    /// Monotonic counter for assigning unique connection IDs.
    next_connection_id: AtomicU64,
    /// Active WebSocket connections — keyed by `ConnectionId`.
    pub connections: RwLock<HashMap<ConnectionId, ConnectionInfo>>,
    /// Active file watchers — one per unique directory path, with lifetime tracking.
    pub filer_manager: FilerManager,
    /// PTY terminal manager.
    pub pty_manager: PtyManager,
    /// Daemon token state for `X-Daemon-Token` auth.
    pub daemon_token_state: Option<SharedDaemonTokenState>,
    /// AI provider manager (Anthropic, `OpenAI`, Gemini, Ollama).
    pub provider_manager: ProviderManager,
    /// Default completion options.
    pub completion_options: CompletionOptions,
    /// Register `_test_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave false.
    pub enable_test_actions: bool,
    /// Audit emission + listener fan-out. Captured pool-write writes audit
    /// rows out of band; the listener chain routes socket revocation
    /// (`session_revoke`, `password_change`, `logout`, …) — mirrors
    /// `fuz_app`'s `create_ws_auth_guard` + `create_ws_logout_closer`
    /// pattern. Wired in `main.rs` after `App` is constructed so listeners
    /// can capture `Arc<App>`.
    pub audit: Arc<AuditEmitter>,
    /// Per-IP rate limiter on `/login` / `/password`. `Some` iff
    /// `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1` was set at startup; default off
    /// so existing integration tests don't trip the bucket. Mirrors
    /// `fuz_app`'s `ip_rate_limiter` plumbing — handlers check before
    /// argon2 work and on failure record / on success reset.
    pub login_ip_rate_limiter: Option<Arc<RateLimiter>>,
    /// Per-account-id rate limiter on `/login` / `/password`. Keyed on
    /// canonical `account.id` (post-DB-lookup), not the submitted
    /// identifier — otherwise an attacker could alternate between
    /// username and email to double the bucket. Mirrors `fuz_app`'s
    /// `login_account_rate_limiter`.
    pub login_account_rate_limiter: Option<Arc<RateLimiter>>,
    /// Parsed trusted-proxy entries from `ZZZ_TRUSTED_PROXIES`. Read
    /// by `proxy::client_ip_middleware` on every request to decide
    /// whether to trust `X-Forwarded-For`. Empty when the env var is
    /// unset; the middleware then collapses every connection to the
    /// TCP peer IP (Phase 4 direct-bind behavior).
    pub trusted_proxies: Vec<ParsedProxy>,

    // -- Spine-backed fields (Phase 7 Batch 5 — additive) -----------
    //
    // The fields below are populated at startup but most are not yet
    // consumed — Batches 1-4 will retire the legacy duplicates above
    // and rewire the live transports to read these instead. The
    // `#[allow]` on each field documents the staged-migration intent.
    //
    //
    // These fields live alongside the legacy fields above for the
    // duration of the staged Batch 1-5 migration. The new spine-backed
    // pattern dispatches through `action_registry` + `ActionContext`;
    // the legacy `App` reach-through (handler `&App` access via
    // `handlers/{workspace,filesystem,...}::handle_*`) continues to
    // serve the existing live `/api/rpc` and `/api/ws` paths until
    // the later batches retire it.
    //
    /// `Arc<ConnectionRegistry>` — the spine's connection-tracking
    /// registry. Identical posture to the legacy `App.connections` map
    /// + `App.broadcast` / `send_to` methods, but with the cancellation
    /// token plumbed onto each connection (so `SocketRevoker` can cancel
    /// the signal token belt-and-suspenders with the dropped sender).
    /// Constructed at startup; shared across the live transports and
    /// the new spine-backed dispatch path.
    #[allow(dead_code, reason = "Batch 5 additive — consumed when later batches retire the legacy connections map")]
    pub realtime: Arc<ConnectionRegistry>,
    /// Spine `AuditEmitter` — handler-facing audit emit shape that
    /// writes synchronously inside the active transaction (via
    /// `ActionContext::audit_emit`). Distinct from the legacy
    /// `audit: Arc<crate::audit::AuditEmitter>` which is spawn-then-await
    /// (fire-and-forget pool-write). Listener-fan-out is queued on the
    /// `PendingEffects` queue and drained post-commit. Constructed at
    /// startup; threaded through the spine `auth_adapter::build_account_specs`
    /// / `build_admin_specs` paths and via `ActionContext` to per-domain
    /// handlers.
    #[allow(dead_code, reason = "Batch 5 additive — consumed by spine RPC dispatch when later batches mount the spine router")]
    pub audit_emitter: Arc<SpineAuditEmitter>,
    /// Compiled spine action registry. Holds `PROTOCOL_ACTION_SPECS` +
    /// `auth_adapter::build_account_specs` + `auth_adapter::build_admin_specs`
    /// + zzz-specific specs from `zzz_action_specs::build_*_specs`. Looked
    /// up by `fuz_actions::perform_action` keyed on method name.
    ///
    /// **Wrapped in `OnceLock`** so it can be set after `Arc<App>` is
    /// constructed — the spec builders (e.g.
    /// `zzz_action_specs::build_workspace_specs`) close over
    /// `Arc<App>`, so the registry can't be built until the App `Arc`
    /// exists. Mirrors the audit listener registration pattern in
    /// `audit::listeners::register`.
    pub action_registry: std::sync::OnceLock<Arc<ActionRegistry>>,
    /// State for the spine account REST router. Constructed once at
    /// startup, shared with the eventual `fuz_auth::account_router`
    /// mount in main.rs. Currently introduced for the additive Phase 7
    /// migration; the legacy zzz `account/*` handlers continue to serve
    /// the live `/api/account/*` paths until Batch 1 mounts the spine
    /// router.
    #[allow(dead_code, reason = "Batch 5 additive — consumed when Batch 1 mounts the spine account router")]
    pub account_route_state: Arc<AccountRouteState>,
    /// State for the spine bootstrap router. Constructed once at
    /// startup, shared with the eventual `fuz_auth::bootstrap_routes::bootstrap_router`
    /// mount. See `account_route_state` for the staged-migration rationale.
    #[allow(dead_code, reason = "Batch 5 additive — consumed when Batch 1 mounts the spine bootstrap router")]
    pub bootstrap_route_state: Arc<BootstrapRouteState>,
    /// Spine `Keyring` (HMAC-SHA256 cookie signing). Constructed from the
    /// same `SECRET_COOKIE_KEYS` env value as the legacy `keyring` field
    /// above. Two instances coexist for the duration of the migration
    /// (legacy: owned `auth::Keyring` on `App.keyring`; spine: `Arc<fuz_auth::Keyring>`
    /// here) because the legacy account/cookie path reaches through
    /// `app.keyring` while the new spine surface needs an `Arc<fuz_auth::Keyring>`
    /// — different ownership shapes. Underlying keys are identical.
    #[allow(dead_code, reason = "Batch 5 additive — consumed when Batch 3 retires the legacy auth module")]
    pub spine_keyring: Arc<fuz_auth::Keyring>,
    /// Spine daemon token state — different lock kind from the legacy
    /// `daemon_token_state` (parking_lot::RwLock vs tokio::sync::RwLock).
    /// Two instances coexist during the migration; the spine
    /// `AccountRouteState` consumes the spine variant, the legacy auth
    /// pipeline continues to read the tokio variant.
    #[allow(dead_code, reason = "Batch 5 additive — consumed when Batch 3 unifies daemon-token state")]
    pub spine_daemon_token: Option<fuz_auth::SharedDaemonTokenState>,
    /// Spine allowed-origins list. Same patterns as the legacy
    /// `App.allowed_origins`, behind `Arc<Vec<String>>` for the spine
    /// route-state consumers.
    #[allow(dead_code, reason = "Batch 5 additive — consumed when later batches mount spine routers")]
    pub spine_allowed_origins: Arc<Vec<String>>,
    /// Spine trusted-proxy list (`fuz_http::ParsedProxy`). Wire-identical
    /// to the legacy `App.trusted_proxies` (`crate::proxy::ParsedProxy`)
    /// per `fuz_http`'s Phase 4 extraction note; re-parsed at startup so
    /// the spine layer doesn't depend on the legacy `proxy` module's
    /// private type. Behind `Arc<Vec<…>>` for the spine middleware
    /// state shape.
    #[allow(dead_code, reason = "Batch 5 additive — consumed when Batch 2 retires the local proxy module")]
    pub spine_trusted_proxies: Arc<Vec<SpineParsedProxy>>,
}

/// Spine-side fields packaged together so `App::new`'s argument list
/// doesn't keep growing past the existing clippy threshold. Constructed
/// at the composition root (main.rs) and moved into `App`.
pub struct SpineState {
    pub realtime: Arc<ConnectionRegistry>,
    pub audit_emitter: Arc<SpineAuditEmitter>,
    pub account_route_state: Arc<AccountRouteState>,
    pub bootstrap_route_state: Arc<BootstrapRouteState>,
    pub spine_keyring: Arc<fuz_auth::Keyring>,
    pub spine_daemon_token: Option<fuz_auth::SharedDaemonTokenState>,
    pub spine_allowed_origins: Arc<Vec<String>>,
    pub spine_trusted_proxies: Arc<Vec<SpineParsedProxy>>,
}

impl App {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db_pool: Pool,
        keyring: Keyring,
        allowed_origins: Vec<String>,
        bootstrap_token_path: Option<String>,
        bootstrap_available: bool,
        scoped_fs: ScopedFs,
        zzz_dir: String,
        scoped_dirs: Vec<String>,
        daemon_token_state: Option<SharedDaemonTokenState>,
        provider_manager: ProviderManager,
        enable_test_actions: bool,
        audit: Arc<AuditEmitter>,
        login_ip_rate_limiter: Option<Arc<RateLimiter>>,
        login_account_rate_limiter: Option<Arc<RateLimiter>>,
        trusted_proxies: Vec<ParsedProxy>,
        spine: SpineState,
    ) -> Self {
        Self {
            workspaces: RwLock::new(HashMap::new()),
            db_pool,
            keyring,
            allowed_origins,
            bootstrap_token_path,
            bootstrap_available: AtomicBool::new(bootstrap_available),
            scoped_fs,
            zzz_dir,
            scoped_dirs,
            next_connection_id: AtomicU64::new(1),
            connections: RwLock::new(HashMap::new()),
            filer_manager: FilerManager::new(),
            pty_manager: PtyManager::new(),
            daemon_token_state,
            provider_manager,
            completion_options: CompletionOptions::default(),
            enable_test_actions,
            audit,
            login_ip_rate_limiter,
            login_account_rate_limiter,
            trusted_proxies,
            realtime: spine.realtime,
            audit_emitter: spine.audit_emitter,
            action_registry: std::sync::OnceLock::new(),
            account_route_state: spine.account_route_state,
            bootstrap_route_state: spine.bootstrap_route_state,
            spine_keyring: spine.spine_keyring,
            spine_daemon_token: spine.spine_daemon_token,
            spine_allowed_origins: spine.spine_allowed_origins,
            spine_trusted_proxies: spine.spine_trusted_proxies,
        }
    }

    /// Allocate a new connection ID and register the sender with auth metadata.
    ///
    /// Returns the ID — caller must call `remove_connection` on disconnect.
    pub fn add_connection(
        &self,
        sender: ConnectionSender,
        token_hash: Option<String>,
        account_id: Option<uuid::Uuid>,
        api_token_id: Option<String>,
    ) -> ConnectionId {
        let id = self
            .next_connection_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.connections.write().insert(
            id,
            ConnectionInfo {
                sender,
                token_hash,
                account_id,
                api_token_id,
            },
        );
        id
    }

    /// Remove a connection by ID (called on WS disconnect).
    pub fn remove_connection(&self, id: ConnectionId) {
        self.connections.write().remove(&id);
    }

    /// Broadcast a message to all connected clients.
    ///
    /// Builds one `Utf8Bytes` and clones it (refcount bump) per recipient
    /// — N receivers cost one allocation, not N.
    pub fn broadcast(&self, message: &str) {
        let bytes: Utf8Bytes = message.to_owned().into();
        let conns = self.connections.read();
        for info in conns.values() {
            let _ = info.sender.send(bytes.clone());
        }
    }

    /// Send a message to a specific connection.
    pub fn send_to(&self, id: ConnectionId, message: &str) {
        let conns = self.connections.read();
        if let Some(info) = conns.get(&id) {
            let _ = info.sender.send(Utf8Bytes::from(message.to_owned()));
        }
    }

    /// Close all WebSocket connections for a given session token hash.
    ///
    /// Used for session revocation — the sender is dropped, which causes
    /// the WS handler's `notify_rx.recv()` to return `None` and break
    /// the connection loop.
    ///
    /// Returns the number of connections closed.
    pub fn close_sockets_for_session(&self, target_hash: &str) -> usize {
        let mut count = 0;
        self.connections.write().retain(|_, info| {
            let matches = info.token_hash.as_deref().is_some_and(|h| h == target_hash);
            if matches {
                count += 1;
            }
            !matches
        });
        count
    }

    /// Close all WebSocket connections bound to a specific `api_token.id`.
    ///
    /// Used on `token_revoke` so revoking one API token doesn't tear down
    /// the account's session-authenticated sockets or other tokens' sockets.
    ///
    /// Returns the number of connections closed.
    pub fn close_sockets_for_token(&self, target_id: &str) -> usize {
        let mut count = 0;
        self.connections.write().retain(|_, info| {
            let matches = info
                .api_token_id
                .as_deref()
                .is_some_and(|id| id == target_id);
            if matches {
                count += 1;
            }
            !matches
        });
        count
    }

    /// Close all WebSocket connections for a given account.
    ///
    /// Used on logout, password change, and token revocation.
    /// Returns the number of connections closed.
    pub fn close_sockets_for_account(&self, target_id: uuid::Uuid) -> usize {
        let mut count = 0;
        self.connections.write().retain(|_, info| {
            let matches = info.account_id.is_some_and(|id| id == target_id);
            if matches {
                count += 1;
            }
            !matches
        });
        count
    }
}

// -- Per-request context (constructed by transport) ---------------------------

/// Send a request-scoped JSON-RPC notification to the originator.
///
/// On WebSocket: routes to the originating socket via `app.send_to`.
/// On HTTP: no-ops with a DEV-only warn (HTTP has no return channel for
/// server-pushed notifications).
///
/// Mirrors the TS `ZzzHandlerContext.notify` shape (see
/// `src/lib/server/zzz_action_handlers.ts`).
pub type NotifyFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Per-request context passed to handler functions.
///
/// Borrows `App` and the request id from the parsed envelope.
/// The transport constructs this before calling `dispatch`.
pub struct Ctx<'a> {
    pub app: &'a App,
    /// Clone of the `Arc<App>` — handlers that need to spawn tasks (e.g.
    /// file watchers) can clone this to move into the spawned future.
    pub app_arc: Arc<App>,
    pub request_id: &'a Value,
    pub auth: Option<&'a RequestContext>,
    /// Credential type the request arrived on (Session / `ApiToken` /
    /// `DaemonToken`). `None` for anonymous callers. Mirrors `fuz_app`'s
    /// `ActionContext.credential_type`; populated on every audit emit
    /// from a gated method so forensics survive a future loosening of
    /// the spec gate (see `audit.rs` doc-comment).
    pub credential_type: Option<CredentialType>,
    /// Resolved client IP from `proxy::client_ip_middleware`. Plumbed
    /// onto every `AuditLogInput.ip` emit site in `account.rs` /
    /// `bootstrap.rs` / `handlers/account.rs`, matching `fuz_app`'s
    /// `get_client_ip(c)` posture. `None` on transports that bypass
    /// the middleware (none today — kept optional so a future internal
    /// dispatcher without a request envelope can still build a `Ctx`).
    pub client_ip: Option<String>,
    /// Push a JSON-RPC notification to the originator. Socket-scoped on WS,
    /// no-op on HTTP. Mirrors TS `ctx.notify(method, params)`.
    pub notify: NotifyFn,
    /// Fires on request-level cancellation (WS socket close or HTTP request
    /// drop). Mirrors TS `ctx.signal: AbortSignal`. Distinct from
    /// resource-lifetime tokens (e.g. PTY's per-terminal token).
    pub signal: CancellationToken,
    /// In-flight fire-and-forget tasks (audit emits, session touch, …) the
    /// dispatcher drains before returning a response. Mirrors `fuz_app`'s
    /// `ActionContext.pending_effects`. Stored under `std::sync::Mutex`
    /// so handlers can push without `&mut Ctx` propagating through every
    /// signature.
    pub pending_effects: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Ctx<'_> {
    /// Push a fire-and-forget task onto the pending-effects queue. The
    /// dispatcher drains the queue before returning to the transport.
    pub fn push_pending_effect(&self, handle: tokio::task::JoinHandle<()>) {
        if let Ok(mut q) = self.pending_effects.lock() {
            q.push(handle);
        }
    }

    /// Drain and await every pending effect. Called from `perform_action`
    /// after the handler completes — guarantees audit rows + listener
    /// fan-out are observable by the time the response is sent.
    ///
    /// Errors from individual tasks (panics, cancellations) are logged
    /// and swallowed so one bad effect can't starve the response.
    pub async fn drain_pending_effects(&self) {
        let drained = {
            let Ok(mut q) = self.pending_effects.lock() else {
                return;
            };
            std::mem::take(&mut *q)
        };
        for h in drained {
            if let Err(e) = h.await {
                tracing::warn!(error = %e, "pending effect task failed");
            }
        }
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

// -- Shared helpers -----------------------------------------------------------

/// Convert a resolved path to a normalized directory string with trailing `/`.
///
/// Rejects non-UTF-8 paths explicitly — no lossy replacement with U+FFFD.
pub(in crate::handlers) fn to_normalized_dir(path: &Path) -> Result<String, JsonrpcError> {
    let mut s = path
        .to_str()
        .ok_or_else(|| rpc::internal_error("path is not valid UTF-8"))?
        .to_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    Ok(s)
}

// -- Typed response structs (avoid json!() macro allocation) ------------------

#[derive(Serialize)]
struct PingResult<'a> {
    ping_id: &'a Value,
}

#[derive(Serialize)]
struct SessionLoadData {
    files: Vec<crate::filer::SerializableDisknode>,
    zzz_dir: String,
    scoped_dirs: Vec<String>,
    provider_status: Vec<Value>,
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Serialize)]
struct SessionLoadResult {
    data: SessionLoadData,
}

#[derive(Serialize)]
struct TestEmitNotificationsResult {
    count: u64,
}

// -- Dispatch -----------------------------------------------------------------

/// Route a method to its handler.
///
/// Auth is checked by the transport BEFORE calling dispatch.
///
/// Side-effect actions (`MethodSpec.side_effects`) run inside a DB
/// transaction so paired writes commit or roll back atomically — mirroring
/// `fuz_app`'s `perform_action` `db.transaction` wrap. Read-only actions
/// run on a pooled connection (acquired lazily by handlers that need one).
pub async fn dispatch(method: &str, params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonrpcError> {
    if auth::method_spec(method).side_effects {
        dispatch_with_tx(method, params, ctx).await
    } else {
        dispatch_no_tx(method, params, ctx).await
    }
}

/// Dispatch a `side_effects: true` action inside a database transaction.
///
/// Match arms call DB-using handlers with `&tx`; handlers that don't touch
/// the DB (filesystem, terminal, workspace, `completion_create`,
/// `provider_update_api_key`) ignore the active transaction. Commits on
/// `Ok`; rolls back on `Err`. Connection-acquisition or `BEGIN` failures
/// surface as `internal_error` to the caller.
async fn dispatch_with_tx(
    method: &str,
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonrpcError> {
    let mut client = ctx
        .app
        .db_pool
        .get()
        .await
        .map_err(|e| rpc::internal_error_with_source("db pool error", &e))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| rpc::internal_error_with_source("db tx begin failed", &e))?;

    let result = match method {
        "workspace_open" => workspace::handle_workspace_open(params, ctx).await,
        "workspace_close" => workspace::handle_workspace_close(params, ctx).await,
        "diskfile_update" => filesystem::handle_diskfile_update(params, ctx).await,
        "diskfile_delete" => filesystem::handle_diskfile_delete(params, ctx).await,
        "directory_create" => filesystem::handle_directory_create(params, ctx).await,
        "completion_create" => provider::handle_completion_create(params, ctx).await,
        "provider_update_api_key" => provider::handle_provider_update_api_key(params, ctx).await,
        "terminal_create" => terminal::handle_terminal_create(params, ctx).await,
        "terminal_data_send" => terminal::handle_terminal_data_send(params, ctx).await,
        "terminal_resize" => terminal::handle_terminal_resize(params, ctx).await,
        "terminal_close" => terminal::handle_terminal_close(params, ctx).await,
        "account_session_revoke" => account::handle_account_session_revoke(params, ctx, &tx).await,
        "account_session_revoke_all" => account::handle_account_session_revoke_all(ctx, &tx).await,
        "account_token_create" => account::handle_account_token_create(params, ctx, &tx).await,
        "account_token_revoke" => account::handle_account_token_revoke(params, ctx, &tx).await,
        "admin_session_revoke_all" => {
            admin::handle_admin_session_revoke_all(params, ctx, &tx).await
        }
        "admin_token_revoke_all" => admin::handle_admin_token_revoke_all(params, ctx, &tx).await,
        other => Err(rpc::method_not_found(other)),
    };

    match result {
        Ok(value) => {
            tx.commit()
                .await
                .map_err(|e| rpc::internal_error_with_source("db tx commit failed", &e))?;
            Ok(value)
        }
        Err(e) => {
            if let Err(rollback_err) = tx.rollback().await {
                tracing::warn!(error = %rollback_err, method, "db tx rollback failed");
            }
            Err(e)
        }
    }
}

/// Dispatch a `side_effects: false` action without opening a transaction.
///
/// DB-free read-only methods (`ping`, `session_load`, `workspace_list`,
/// `provider_load_status`, `_test_emit_notifications`) skip the pool
/// entirely. The remaining handlers — all `account_*` lookups — share a
/// single pooled client acquired in one place to keep the boilerplate to
/// one site.
async fn dispatch_no_tx(
    method: &str,
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonrpcError> {
    match method {
        "ping" => return handle_ping(ctx),
        "session_load" => return handle_session_load(ctx).await,
        "workspace_list" => return workspace::handle_workspace_list(ctx),
        "provider_load_status" => {
            return provider::handle_provider_load_status(params, ctx).await;
        }
        "_test_emit_notifications" if ctx.app.enable_test_actions => {
            return handle_test_emit_notifications(params, ctx);
        }
        _ => {}
    }

    let client = ctx
        .app
        .db_pool
        .get()
        .await
        .map_err(|e| rpc::internal_error_with_source("db pool error", &e))?;

    match method {
        "account_verify" => account::handle_account_verify(ctx, &client).await,
        "account_session_list" => account::handle_account_session_list(ctx, &client).await,
        "account_token_list" => account::handle_account_token_list(ctx, &client).await,
        other => Err(rpc::method_not_found(other)),
    }
}

// -- Generic handlers ---------------------------------------------------------

fn handle_ping(ctx: &Ctx<'_>) -> Result<Value, JsonrpcError> {
    let result = PingResult {
        ping_id: ctx.request_id,
    };
    serde_json::to_value(result)
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

async fn handle_session_load(ctx: &Ctx<'_>) -> Result<Value, JsonrpcError> {
    let workspaces: Vec<WorkspaceInfo> = {
        let ws = ctx.app.workspaces.read();
        ws.values().cloned().collect()
    };

    // Rescan each watched directory before reading the index — notify events
    // are eventually consistent, so a file written immediately before
    // session_load may not yet be in the in-memory index. A fresh walk
    // guarantees a consistent snapshot and removes a flaky race in integration
    // tests (`session_load_returns_nested_files`) where the filer event loop
    // hadn't yet drained the inotify event.
    ctx.app.filer_manager.rescan_all().await;
    let files = ctx.app.filer_manager.collect_all_files().await;

    // Collect provider status from all registered providers
    let mut provider_status = Vec::new();
    for p in ctx.app.provider_manager.all() {
        let status = p.load_status(false).await;
        if let Ok(v) = serde_json::to_value(&status) {
            provider_status.push(v);
        }
    }

    let result = SessionLoadResult {
        data: SessionLoadData {
            files,
            zzz_dir: ctx.app.zzz_dir.clone(),
            scoped_dirs: ctx.app.scoped_dirs.clone(),
            provider_status,
            workspaces,
        },
    };
    serde_json::to_value(result)
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

/// Test-only: emit `count` `_test_notification` notifications via `ctx.notify`,
/// then return `{count}`. Lets the integration suite verify `ctx.notify`
/// routing (socket-scoped delivery) without a real AI provider.
fn handle_test_emit_notifications(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonrpcError> {
    let count = params
        .get("count")
        .and_then(Value::as_u64)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'count' parameter"))?;
    if count > 100 {
        return Err(rpc::invalid_params("count must be <= 100"));
    }

    for i in 0..count {
        (ctx.notify)("_test_notification", serde_json::json!({"index": i}));
    }

    serde_json::to_value(TestEmitNotificationsResult { count })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}
