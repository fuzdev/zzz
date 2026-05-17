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
use std::sync::atomic::AtomicBool;

use deadpool_postgres::Pool;
use fuz_http::JsonrpcError;
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::filer::FilerManager;
use crate::provider::{CompletionOptions, ProviderManager};
use crate::pty_manager::PtyManager;
use crate::rpc;
use crate::scoped_fs::ScopedFs;

// Spine surfaces. `crate::auth` / `crate::audit` / `crate::daemon_token`
// / `crate::rate_limiter` were retired in Phase 7 Batch 3; the spine
// types below are the sole auth/audit/rate-limit surface on `App`.
use fuz_actions::ActionRegistry;
use fuz_auth::{
    AccountRouteState, AuditEmitter, BootstrapRouteState, CredentialType, Keyring, RateLimiter,
    RequestActorContext as RequestContext, SharedDaemonTokenState, SocketRevoker,
};
use fuz_http::ParsedProxy;
use fuz_realtime::ConnectionRegistry;

// -- App state (long-lived, shared via Arc) -----------------------------------

/// Server state shared across all requests.
///
/// Constructed once in `main`, wrapped in `Arc`, passed as axum `State`.
pub struct App {
    pub workspaces: RwLock<HashMap<String, WorkspaceInfo>>,
    pub db_pool: Pool,
    pub allowed_origins: Vec<String>,
    pub bootstrap_token_path: Option<String>,
    pub bootstrap_available: AtomicBool,
    pub scoped_fs: ScopedFs,
    pub zzz_dir: String,
    pub scoped_dirs: Vec<String>,
    /// Active file watchers — one per unique directory path, with lifetime tracking.
    pub filer_manager: FilerManager,
    /// PTY terminal manager.
    pub pty_manager: PtyManager,
    /// AI provider manager (Anthropic, `OpenAI`, Gemini, Ollama).
    pub provider_manager: ProviderManager,
    /// Default completion options.
    pub completion_options: CompletionOptions,
    /// Register `_test_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave false.
    pub enable_test_actions: bool,
    /// Per-IP rate limiter on `/login` / `/password`. `Some` iff
    /// `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1` was set at startup; default off
    /// so existing integration tests don't trip the bucket. Spine
    /// `fuz_auth::RateLimiter` (parking_lot, sync) since Phase 7 Batch 3.
    pub login_ip_rate_limiter: Option<Arc<RateLimiter>>,
    /// Per-account-id rate limiter on `/login` / `/password`. Keyed on
    /// canonical `account.id` (post-DB-lookup), not the submitted
    /// identifier — otherwise an attacker could alternate between
    /// username and email to double the bucket.
    pub login_account_rate_limiter: Option<Arc<RateLimiter>>,

    // -- Spine-backed fields ----------------------------------------
    //
    // Sole connection-tracking + auth/audit/daemon-token surface on
    // `App` since Phase 7 sub-batch D + Batch 3 retired the legacy
    // duplicates.

    /// `Arc<ConnectionRegistry>` — the spine's connection-tracking
    /// registry. Sole connection store on `App` since Phase 7 sub-batch D
    /// retired the legacy `App.connections` map.
    pub realtime: Arc<ConnectionRegistry>,
    /// Spine `AuditEmitter` — captured-pool write + listener fan-out.
    /// `emit(input) -> JoinHandle<()>` spawns a detached task; REST
    /// sites `let _ = app.audit.emit(...).await` to keep the row
    /// observable by response time while surviving client disconnects.
    /// RPC handlers push the `JoinHandle` onto `Ctx.pending_effects`
    /// instead so the dispatcher drains the queue before responding.
    pub audit: Arc<AuditEmitter>,
    /// Compiled spine action registry. Holds `PROTOCOL_ACTION_SPECS` +
    /// `auth_adapter::build_account_specs` + `auth_adapter::build_admin_specs`
    /// + zzz-specific specs from `zzz_action_specs::build_*_specs`. Looked
    /// up by `fuz_actions::perform_action` keyed on method name.
    ///
    /// **Wrapped in `OnceLock`** so it can be set after `Arc<App>` is
    /// constructed — the spec builders close over `Arc<App>`, so the
    /// registry can't be built until the App `Arc` exists.
    pub action_registry: std::sync::OnceLock<Arc<ActionRegistry>>,
    /// State for the spine account REST router. Currently held for the
    /// in-progress spine REST mount (Batch 4); the legacy zzz
    /// `account/*` handlers continue to serve the live `/api/account/*`
    /// paths in Batch 3.
    #[allow(dead_code, reason = "Batch 3 — consumed when Batch 4 mounts the spine account router")]
    pub account_route_state: Arc<AccountRouteState>,
    /// State for the spine bootstrap router. See `account_route_state`
    /// for the staged-migration rationale.
    #[allow(dead_code, reason = "Batch 3 — consumed when Batch 4 mounts the spine bootstrap router")]
    pub bootstrap_route_state: Arc<BootstrapRouteState>,
    /// Cookie signing keyring (HMAC-SHA256). Sole keyring on `App`
    /// since Phase 7 Batch 3 retired `crate::auth::Keyring`.
    pub keyring: Arc<Keyring>,
    /// Daemon-token state (`X-Daemon-Token` auth). Sole daemon-token
    /// state on `App` since Phase 7 Batch 3 retired
    /// `crate::daemon_token`. Spine `fuz_auth::SharedDaemonTokenState`
    /// uses `parking_lot::RwLock` — no `.await` inside critical sections.
    pub daemon_token_state: Option<SharedDaemonTokenState>,
    /// Spine allowed-origins list (`Arc<Vec<String>>`). Held alongside
    /// `App.allowed_origins: Vec<String>` because spine route-state
    /// consumers (`AccountRouteState`, `RpcRouteState`, `WsRouteState`)
    /// take `Arc<Vec<String>>` while the legacy REST + RPC origin gate
    /// reads the borrowed `Vec`. Same patterns, different ownership.
    #[allow(dead_code, reason = "Batch 3 — consumed by spine route-state consumers")]
    pub spine_allowed_origins: Arc<Vec<String>>,
    /// Trusted-proxy list (`fuz_http::ParsedProxy`). Behind
    /// `Arc<Vec<…>>` for the spine middleware state shape.
    pub spine_trusted_proxies: Arc<Vec<ParsedProxy>>,
}

/// Spine-side fields packaged together so `App::new`'s argument list
/// doesn't keep growing past the existing clippy threshold. Constructed
/// at the composition root (main.rs) and moved into `App`.
pub struct SpineState {
    pub realtime: Arc<ConnectionRegistry>,
    pub audit_emitter: Arc<AuditEmitter>,
    pub account_route_state: Arc<AccountRouteState>,
    pub bootstrap_route_state: Arc<BootstrapRouteState>,
    pub spine_keyring: Arc<Keyring>,
    pub spine_daemon_token: Option<SharedDaemonTokenState>,
    pub spine_allowed_origins: Arc<Vec<String>>,
    pub spine_trusted_proxies: Arc<Vec<ParsedProxy>>,
}

impl App {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        db_pool: Pool,
        allowed_origins: Vec<String>,
        bootstrap_token_path: Option<String>,
        bootstrap_available: bool,
        scoped_fs: ScopedFs,
        zzz_dir: String,
        scoped_dirs: Vec<String>,
        provider_manager: ProviderManager,
        enable_test_actions: bool,
        login_ip_rate_limiter: Option<Arc<RateLimiter>>,
        login_account_rate_limiter: Option<Arc<RateLimiter>>,
        spine: SpineState,
    ) -> Self {
        Self {
            workspaces: RwLock::new(HashMap::new()),
            db_pool,
            allowed_origins,
            bootstrap_token_path,
            bootstrap_available: AtomicBool::new(bootstrap_available),
            scoped_fs,
            zzz_dir,
            scoped_dirs,
            filer_manager: FilerManager::new(),
            pty_manager: PtyManager::new(),
            provider_manager,
            completion_options: CompletionOptions::default(),
            enable_test_actions,
            login_ip_rate_limiter,
            login_account_rate_limiter,
            realtime: spine.realtime,
            audit: spine.audit_emitter,
            action_registry: std::sync::OnceLock::new(),
            account_route_state: spine.account_route_state,
            bootstrap_route_state: spine.bootstrap_route_state,
            keyring: spine.spine_keyring,
            daemon_token_state: spine.spine_daemon_token,
            spine_allowed_origins: spine.spine_allowed_origins,
            spine_trusted_proxies: spine.spine_trusted_proxies,
        }
    }

    /// Broadcast a message to all connected clients.
    ///
    /// Strategy α shim over `App.realtime`. The spine WS handler
    /// registers connections in `App.realtime`
    /// (`Arc<fuz_realtime::ConnectionRegistry>`); existing call sites
    /// (`filer::broadcast_filer_change`, `pty_manager` terminal data /
    /// exited, `handlers::workspace::workspace_changed`,
    /// `handlers_v2::workspace::workspace_*`) stay verbatim through
    /// this shim. Retires when later batches rewrite call sites to
    /// call `App.realtime.broadcast(...)` directly.
    pub fn broadcast(&self, message: &str) {
        let _ = self.realtime.broadcast(message);
    }

    /// Close all WebSocket connections for a given session token hash.
    ///
    /// Phase 7 sub-batch D: shim over `App.realtime`'s `SocketRevoker`
    /// impl (Strategy α). Used for session revocation — the spine
    /// `ConnectionRegistry` drops the matched sender AND cancels the
    /// per-connection signal token, which causes the spine WS loop's
    /// message select to exit and send the 4001 close frame.
    ///
    /// Returns the number of connections closed.
    pub fn close_sockets_for_session(&self, target_hash: &str) -> usize {
        self.realtime.close_sockets_for_session(target_hash)
    }

    /// Close all WebSocket connections bound to a specific `api_token.id`.
    ///
    /// Phase 7 sub-batch D: shim over `App.realtime`'s `SocketRevoker`
    /// impl. Used on `token_revoke` so revoking one API token doesn't
    /// tear down the account's session-authenticated sockets or other
    /// tokens' sockets.
    ///
    /// Returns the number of connections closed.
    pub fn close_sockets_for_token(&self, target_id: &str) -> usize {
        self.realtime.close_sockets_for_token(target_id)
    }

    /// Close all WebSocket connections for a given account.
    ///
    /// Phase 7 sub-batch D: shim over `App.realtime`'s `SocketRevoker`
    /// impl. Used on logout, password change, and bulk token/session
    /// revocation. Returns the number of connections closed.
    pub fn close_sockets_for_account(&self, target_id: uuid::Uuid) -> usize {
        self.realtime.close_sockets_for_account(target_id)
    }
}

// -- Per-request context (constructed by transport) ---------------------------

/// Send a request-scoped JSON-RPC notification to the originator.
///
/// On WebSocket: routes to the originating socket via the spine
/// `App.realtime.send_to(...)` path (see
/// `handlers_v2::provider::completion_create`).
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
    /// Resolved client IP from `fuz_http::client_ip_middleware`. Plumbed
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
    if method_spec(method).side_effects {
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

// -- Per-action auth spec -----------------------------------------------------
//
// Moved out of `crate::auth::spec` in Phase 7 Batch 3 — these
// definitions are zzz-specific (the `method_spec` table enumerates the
// zzz method namespace) and have no other consumer beyond
// `dispatch` + `perform_action`. The shared cross-consumer surface
// (origin allowlist, `CredentialType`, REST `credential_type_required`
// envelope) lives in `fuz_http` / `fuz_auth`.

/// Authentication tier for an action spec — the 401 axis.
///
/// Mirrors `fuz_app`'s `RouteAuth.account` axis collapsed to the two
/// shapes zzz uses today: anonymous (`Public`) or any valid credential
/// (`Authenticated`). Role and credential-type gates are separate axes
/// on [`MethodSpec`], not packed into this enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionAuth {
    /// No auth required.
    Public,
    /// Must have a valid credential of some kind. Refine further with
    /// `MethodSpec.credential_types` / `MethodSpec.roles`.
    Authenticated,
}

/// Spec-derived facts about a method — auth tier, credential-type
/// allowlist, role requirements, and DB-transaction need. Mirrors the
/// `{auth, credential_types, roles, side_effects}` axes of `fuz_app`'s
/// `ActionSpec`. Looked up via [`method_spec`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MethodSpec {
    pub auth: ActionAuth,
    /// `Some(types)` → credential gate restricts to those types.
    /// `None` → any credential type permitted.
    pub credential_types: Option<&'static [CredentialType]>,
    /// `Some(roles)` → caller must hold one of these roles (any-of).
    /// `None` → no role check.
    pub roles: Option<&'static [&'static str]>,
    /// `true` → dispatcher wraps the handler in a DB transaction.
    pub side_effects: bool,
}

/// JSON-RPC error codes for auth failures.
const JSONRPC_UNAUTHENTICATED: i32 = -32001;
const JSONRPC_FORBIDDEN: i32 = -32002;

/// Check per-action auth against a method's [`MethodSpec`].
///
/// Returns `None` if authorized, `Some(error)` if not. Mirrors `fuz_app`'s
/// `check_action_auth_post_authorization` in `perform_action.ts`.
pub fn check_action_auth(
    spec: &MethodSpec,
    context: Option<&RequestContext>,
    credential_type: Option<CredentialType>,
) -> Option<JsonrpcError> {
    match spec.auth {
        ActionAuth::Public => {}
        ActionAuth::Authenticated => {
            if context.is_none() {
                return Some(JsonrpcError {
                    code: JSONRPC_UNAUTHENTICATED,
                    message: "unauthenticated".to_owned(),
                    data: None,
                });
            }
        }
    }

    if let Some(required) = spec.credential_types {
        let satisfied = credential_type.is_some_and(|ct| required.contains(&ct));
        if !satisfied {
            let names: Vec<&'static str> = required.iter().map(|c| c.name()).collect();
            return Some(JsonrpcError {
                code: JSONRPC_FORBIDDEN,
                message: "forbidden".to_owned(),
                data: Some(serde_json::json!({
                    "reason": "credential_type_required",
                    "required_credential_types": names,
                })),
            });
        }
    }

    if let Some(required_roles) = spec.roles {
        let has_required =
            context.is_some_and(|ctx| required_roles.iter().any(|r| ctx.has_role(r)));
        if !has_required {
            return Some(JsonrpcError {
                code: JSONRPC_FORBIDDEN,
                message: "forbidden".to_owned(),
                data: Some(serde_json::json!({
                    "reason": "insufficient_permissions",
                    "required_roles": required_roles,
                })),
            });
        }
    }

    None
}

/// Per-method spec lookup — single source of truth for the four
/// dispatch-relevant axes (`auth`, `credential_types`, `roles`,
/// `side_effects`). Mirrors `fuz_app`'s `ActionSpec` shape.
///
/// **Gate rationale**:
///
/// - **`credential_types: ['session']`** on the four account-mutation
///   methods (`account_token_create`, `account_token_revoke`,
///   `account_session_revoke`, `account_session_revoke_all`) closes the
///   bearer-self-service threat. Admin equivalents are deliberately
///   *not* credential-gated — admin CLI scripting via bearer is a
///   legitimate operator workflow. The REST `POST /api/account/password`
///   route enforces the same session-only gate at its own handler.
///
/// - **`credential_types: ['daemon_token']` + `roles: ['keeper']`** on
///   `provider_update_api_key` composes the keeper requirement.
#[allow(clippy::match_same_arms)] // Read-only auth'd reads and the unknown-method catch-all
// share the same MethodSpec shape but are conceptually distinct;
// keeping the unknown-method arm explicit makes the
// "fail-closed: unknown methods still require auth" invariant visible.
pub fn method_spec(method: &str) -> MethodSpec {
    const SESSION_ONLY: &[CredentialType] = &[CredentialType::Session];
    const DAEMON_TOKEN_ONLY: &[CredentialType] = &[CredentialType::DaemonToken];
    const KEEPER_ROLE: &[&str] = &["keeper"];
    const ADMIN_ROLE: &[&str] = &["admin"];

    let (auth, credential_types, roles, side_effects) = match method {
        // Public — no auth required, no side effects.
        "ping" => (ActionAuth::Public, None, None, false),

        // Authenticated reads — no transaction wrap.
        "session_load"
        | "workspace_list"
        | "provider_load_status"
        | "account_verify"
        | "account_session_list"
        | "account_token_list" => (ActionAuth::Authenticated, None, None, false),

        // Authenticated writes — wrap in db.transaction.
        "workspace_open" | "workspace_close" | "diskfile_update" | "diskfile_delete"
        | "directory_create" | "completion_create" | "terminal_create" | "terminal_data_send"
        | "terminal_resize" | "terminal_close" => (ActionAuth::Authenticated, None, None, true),

        // Authenticated ollama actions — read-only (no DB side effects on the
        // zzz_server side; the Ollama daemon is a separate process).
        "ollama_list" | "ollama_ps" | "ollama_show" | "ollama_pull" | "ollama_delete"
        | "ollama_copy" | "ollama_create" | "ollama_unload" => {
            (ActionAuth::Authenticated, None, None, false)
        }

        // Credential-channel gated account mutations.
        "account_token_create"
        | "account_token_revoke"
        | "account_session_revoke"
        | "account_session_revoke_all" => {
            (ActionAuth::Authenticated, Some(SESSION_ONLY), None, true)
        }

        // Keeper — composed credential gate + role gate.
        "provider_update_api_key" => (
            ActionAuth::Authenticated,
            Some(DAEMON_TOKEN_ONLY),
            Some(KEEPER_ROLE),
            true,
        ),

        // Admin role-gated mutations — bearer is permitted (no
        // `credential_types` restriction); only `roles: ['admin']` plus
        // `Authenticated` gate access.
        "admin_session_revoke_all" | "admin_token_revoke_all" => (
            ActionAuth::Authenticated,
            None,
            Some(ADMIN_ROLE),
            true,
        ),

        // Unknown methods (including `_test_*` when `ZZZ_ENABLE_TEST_ACTIONS`
        // is unset) — will hit method_not_found in dispatch, but require auth
        // so we don't leak method existence to unauthenticated callers.
        _ => (ActionAuth::Authenticated, None, None, false),
    };

    MethodSpec {
        auth,
        credential_types,
        roles,
        side_effects,
    }
}
