use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, RwLock};

use deadpool_postgres::Pool;
use fuz_common::JsonRpcError;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::auth::{Keyring, RequestContext};
use crate::daemon_token::SharedDaemonTokenState;
use crate::filer::{FilerConfig, FilerLifetime, FilerManager};
use crate::pty_manager::PtyManager;
use crate::rpc;
use crate::scoped_fs::ScopedFs;

// -- Connection tracking types ------------------------------------------------

/// Unique ID for a WebSocket connection, allocated via `App::next_connection_id`.
pub type ConnectionId = u64;

/// Handle to a connected WebSocket client — messages sent here are forwarded to the WS sink.
pub type ConnectionSender = mpsc::UnboundedSender<String>;

/// Metadata for an active WebSocket connection.
///
/// Tracks the channel sender plus auth context for targeted revocation:
/// - `token_hash`: blake3 hash of the session token (for session-level revocation)
/// - `account_id`: account UUID (for account-level revocation on logout/password change)
pub struct ConnectionInfo {
    pub sender: ConnectionSender,
    pub token_hash: Option<String>,
    pub account_id: Option<uuid::Uuid>,
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
    ) -> ConnectionId {
        let id = self
            .next_connection_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut conns) = self.connections.write() {
            conns.insert(
                id,
                ConnectionInfo {
                    sender,
                    token_hash,
                    account_id,
                },
            );
        }
        id
    }

    /// Remove a connection by ID (called on WS disconnect).
    pub fn remove_connection(&self, id: ConnectionId) {
        if let Ok(mut conns) = self.connections.write() {
            conns.remove(&id);
        }
    }

    /// Broadcast a message to all connected clients.
    pub fn broadcast(&self, message: &str) {
        if let Ok(conns) = self.connections.read() {
            for info in conns.values() {
                let _ = info.sender.send(message.to_owned());
            }
        }
    }

    /// Send a message to a specific connection.
    pub fn send_to(&self, id: ConnectionId, message: &str) {
        if let Ok(conns) = self.connections.read()
            && let Some(info) = conns.get(&id)
        {
            let _ = info.sender.send(message.to_owned());
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
        if let Ok(mut conns) = self.connections.write() {
            conns.retain(|_, info| {
                let matches = info
                    .token_hash
                    .as_deref()
                    .is_some_and(|h| h == target_hash);
                if matches {
                    count += 1;
                }
                !matches // retain = keep non-matching
            });
        }
        count
    }

    /// Close all WebSocket connections for a given account.
    ///
    /// Used on logout, password change, and token revocation.
    /// Returns the number of connections closed.
    pub fn close_sockets_for_account(&self, target_id: uuid::Uuid) -> usize {
        let mut count = 0;
        if let Ok(mut conns) = self.connections.write() {
            conns.retain(|_, info| {
                let matches = info.account_id.is_some_and(|id| id == target_id);
                if matches {
                    count += 1;
                }
                !matches
            });
        }
        count
    }
}

// -- Per-request context (constructed by transport) ---------------------------

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

// -- Notification params ------------------------------------------------------

/// Params for `workspace_changed` `remote_notification`.
///
/// Matches the TypeScript `workspace_changed_action_spec` input schema:
/// `{ type: 'open' | 'close', workspace: WorkspaceInfoJson }`.
#[derive(Serialize)]
struct WorkspaceChangedParams<'a> {
    #[serde(rename = "type")]
    change_type: &'a str,
    workspace: &'a WorkspaceInfo,
}

// -- Typed response structs (avoid json!() macro allocation) ------------------

#[derive(Serialize)]
struct PingResult<'a> {
    ping_id: &'a Value,
}

#[derive(Serialize)]
struct WorkspaceListResult {
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Serialize)]
struct WorkspaceOpenResult {
    workspace: WorkspaceInfo,
    files: Vec<Value>, // always empty — initial files sent via session_load, watcher handles updates
}

#[derive(Serialize)]
struct SessionLoadData {
    files: Vec<crate::filer::SerializableDisknode>,
    zzz_dir: String,
    scoped_dirs: Vec<String>,
    provider_status: Vec<Value>, // always empty — no providers in Rust backend yet
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Serialize)]
struct SessionLoadResult {
    data: SessionLoadData,
}

// -- Path helpers -------------------------------------------------------------

/// Convert a resolved path to a normalized directory string with trailing `/`.
///
/// Rejects non-UTF-8 paths explicitly — no lossy replacement with U+FFFD.
fn to_normalized_dir(path: &Path) -> Result<String, JsonRpcError> {
    let mut s = path
        .to_str()
        .ok_or_else(|| rpc::internal_error("path is not valid UTF-8"))?
        .to_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    Ok(s)
}

// -- Dispatch -----------------------------------------------------------------

/// Route a method to its handler.
///
/// Auth is checked by the transport BEFORE calling dispatch.
/// Match statement dispatch — zero overhead, compiler can inline.
pub async fn dispatch(method: &str, params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    match method {
        "ping" => handle_ping(ctx),
        "session_load" => handle_session_load(ctx).await,
        "workspace_list" => handle_workspace_list(ctx),
        "workspace_open" => handle_workspace_open(params, ctx).await,
        "workspace_close" => handle_workspace_close(params, ctx).await,
        "diskfile_update" => handle_diskfile_update(params, ctx).await,
        "diskfile_delete" => handle_diskfile_delete(params, ctx).await,
        "directory_create" => handle_directory_create(params, ctx).await,
        // provider_load_status — in method_auth as Authenticated, but no handler
        // yet. Falls through to method_not_found until Rust providers land.
        "terminal_create" => handle_terminal_create(params, ctx).await,
        "terminal_data_send" => handle_terminal_data_send(params, ctx).await,
        "terminal_resize" => handle_terminal_resize(params, ctx).await,
        "terminal_close" => handle_terminal_close(params, ctx).await,
        other => Err(rpc::method_not_found(other)),
    }
}

// -- Handlers -----------------------------------------------------------------

fn handle_ping(ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let result = PingResult {
        ping_id: ctx.request_id,
    };
    serde_json::to_value(result).map_err(|_| rpc::internal_error("serialization failed"))
}

async fn handle_session_load(ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let workspaces: Vec<WorkspaceInfo> = {
        let ws = ctx
            .app
            .workspaces
            .read()
            .map_err(|_| rpc::internal_error("lock poisoned"))?;
        ws.values().cloned().collect()
    };

    // Read files from all filer indexes (matches Deno's session_load which
    // iterates backend.filers.entries() — no filesystem walk at call time)
    let files = ctx.app.filer_manager.collect_all_files().await;

    let result = SessionLoadResult {
        data: SessionLoadData {
            files,
            zzz_dir: ctx.app.zzz_dir.clone(),
            scoped_dirs: ctx.app.scoped_dirs.clone(),
            provider_status: vec![],
            workspaces,
        },
    };
    serde_json::to_value(result).map_err(|_| rpc::internal_error("serialization failed"))
}

fn handle_workspace_list(ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    // Clone values under read lock, release before serialization
    let list: Vec<WorkspaceInfo> = {
        let workspaces = ctx
            .app
            .workspaces
            .read()
            .map_err(|_| rpc::internal_error("lock poisoned"))?;
        workspaces.values().cloned().collect()
    };
    let result = WorkspaceListResult { workspaces: list };
    serde_json::to_value(result).map_err(|_| rpc::internal_error("serialization failed"))
}

async fn handle_workspace_open(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    // 1. Extract path from params (zero-copy — no from_value clone)
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;

    // 2. Canonicalize and validate directory
    //    Error messages include trailing / to match Deno's resolved path format
    let canonical = Path::new(path).canonicalize().map_err(|_| {
        let suffix = if path.ends_with('/') { "" } else { "/" };
        rpc::internal_error(&format!(
            "failed to open workspace: directory does not exist: {path}{suffix}"
        ))
    })?;

    if !canonical.is_dir() {
        let suffix = if path.ends_with('/') { "" } else { "/" };
        return Err(rpc::internal_error(&format!(
            "failed to open workspace: not a directory: {path}{suffix}"
        )));
    }

    // 3. Normalize — absolute, UTF-8 validated, trailing /
    let normalized = to_normalized_dir(&canonical)?;

    // 4. Fast path — return existing workspace (read lock, released before serialization)
    let existing = {
        let workspaces = ctx
            .app
            .workspaces
            .read()
            .map_err(|_| rpc::internal_error("lock poisoned"))?;
        workspaces.get(&normalized).cloned()
    };

    if let Some(workspace) = existing {
        let result = WorkspaceOpenResult {
            workspace,
            files: vec![],
        };
        return serde_json::to_value(result)
            .map_err(|_| rpc::internal_error("serialization failed"));
    }

    // 5. Create new workspace entry (write lock, released before serialization)
    // UTF-8 already validated by to_normalized_dir
    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_owned();

    let info = WorkspaceInfo {
        path: normalized.clone(),
        name,
        opened_at: fuz_common::rfc3339_now(),
    };

    // entry() handles the double-check naturally — if another thread inserted
    // between our read and write locks, or_insert returns the existing entry
    let workspace = {
        let mut workspaces = ctx
            .app
            .workspaces
            .write()
            .map_err(|_| rpc::internal_error("lock poisoned"))?;
        workspaces.entry(normalized).or_insert(info).clone()
    };

    // Add to ScopedFs so diskfile_update/diskfile_delete/directory_create can
    // write inside the newly opened workspace (mirrors Deno backend.ts:284)
    ctx.app.scoped_fs.add_path(Path::new(&workspace.path));

    // Start file watcher for the new workspace (deduplicates — reuses existing filer)
    if let Err(e) = ctx
        .app
        .filer_manager
        .start_filer(
            &workspace.path,
            Arc::clone(&ctx.app_arc),
            FilerConfig::workspace(&ctx.app.zzz_dir),
            FilerLifetime::Workspace,
        )
        .await
    {
        tracing::warn!(path = %workspace.path, error = %e, "failed to start file watcher");
    }

    // Broadcast workspace_changed notification to all connected clients
    let notification = rpc::notification(
        "workspace_changed",
        serde_json::to_value(&WorkspaceChangedParams {
            change_type: "open",
            workspace: &workspace,
        })
        .unwrap_or_default(),
    );
    ctx.app.broadcast(&notification);

    let result = WorkspaceOpenResult {
        workspace,
        files: vec![],
    };
    serde_json::to_value(result).map_err(|_| rpc::internal_error("serialization failed"))
}

async fn handle_workspace_close(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;

    // Clients send the normalized path from workspace_open — no filesystem
    // calls needed, just ensure trailing / for consistent HashMap lookup
    let mut key = path.to_owned();
    if !key.ends_with('/') {
        key.push('/');
    }

    let removed = {
        let mut workspaces = ctx
            .app
            .workspaces
            .write()
            .map_err(|_| rpc::internal_error("lock poisoned"))?;
        workspaces.remove(&key)
    };

    let Some(workspace) = removed else {
        return Err(rpc::invalid_params(&format!(
            "workspace not open: {path}"
        )));
    };

    // Only stop the filer and remove ScopedFs entry if this wasn't an initial
    // scoped_dir — those filers and ScopedFs entries persist even after close
    // (mirrors Deno backend.ts:330-341)
    let is_initial_scoped_dir = ctx.app.scoped_dirs.contains(&key);
    if !is_initial_scoped_dir {
        ctx.app.filer_manager.stop_filer(&key).await;
        ctx.app.scoped_fs.remove_path(Path::new(&key));
    }

    // Broadcast workspace_changed notification to all connected clients
    let notification = rpc::notification(
        "workspace_changed",
        serde_json::to_value(&WorkspaceChangedParams {
            change_type: "close",
            workspace: &workspace,
        })
        .unwrap_or_default(),
    );
    ctx.app.broadcast(&notification);

    Ok(Value::Null)
}

// -- Filesystem handlers ------------------------------------------------------

async fn handle_diskfile_update(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;
    if !path.starts_with('/') {
        return Err(rpc::invalid_params("path must be absolute"));
    }
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'content' parameter"))?;

    ctx.app
        .scoped_fs
        .write_file(path, content)
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to write file: {e}")))?;

    Ok(Value::Null)
}

async fn handle_diskfile_delete(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;
    if !path.starts_with('/') {
        return Err(rpc::invalid_params("path must be absolute"));
    }

    ctx.app
        .scoped_fs
        .rm(path)
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to delete file: {e}")))?;

    Ok(Value::Null)
}

async fn handle_directory_create(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;
    if !path.starts_with('/') {
        return Err(rpc::invalid_params("path must be absolute"));
    }

    ctx.app
        .scoped_fs
        .mkdir(path)
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to create directory: {e}")))?;

    Ok(Value::Null)
}

// -- Terminal handlers --------------------------------------------------------

#[derive(Serialize)]
struct TerminalCreateResult {
    terminal_id: String,
}

#[derive(Serialize)]
struct TerminalCloseResult {
    exit_code: Option<i32>,
}

async fn handle_terminal_create(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'command' parameter"))?;

    let args: Vec<String> = match params.get("args") {
        Some(Value::Array(arr)) => arr
            .iter()
            .map(|v| {
                v.as_str()
                    .map(String::from)
                    .ok_or_else(|| rpc::invalid_params("args must be an array of strings"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(Value::Null) | None => vec![],
        _ => return Err(rpc::invalid_params("args must be an array of strings")),
    };

    let cwd = params.get("cwd").and_then(Value::as_str);

    let terminal_id = uuid::Uuid::new_v4().to_string();

    ctx.app
        .pty_manager
        .spawn(&terminal_id, command, &args, cwd, Arc::clone(&ctx.app_arc))
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to create terminal: {e}")))?;

    serde_json::to_value(TerminalCreateResult { terminal_id })
        .map_err(|_| rpc::internal_error("serialization failed"))
}

async fn handle_terminal_data_send(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'terminal_id' parameter"))?;

    let data = params
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'data' parameter"))?;

    // No-ops silently if terminal doesn't exist (matching Deno behavior)
    ctx.app.pty_manager.write(terminal_id, data).await;

    Ok(Value::Null)
}

async fn handle_terminal_resize(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'terminal_id' parameter"))?;

    let cols = params
        .get("cols")
        .and_then(Value::as_u64)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'cols' parameter"))?;

    let rows = params
        .get("rows")
        .and_then(Value::as_u64)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'rows' parameter"))?;

    // No-ops silently if terminal doesn't exist; resize failures are non-fatal
    #[expect(clippy::cast_possible_truncation, reason = "terminal dimensions fit u16")]
    {
        ctx.app
            .pty_manager
            .resize(terminal_id, cols as u16, rows as u16)
            .await;
    }

    Ok(Value::Null)
}

async fn handle_terminal_close(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    let terminal_id = params
        .get("terminal_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'terminal_id' parameter"))?;

    let signal_str = params
        .get("signal")
        .and_then(Value::as_str)
        .unwrap_or("SIGTERM");

    let signal = match signal_str {
        "SIGKILL" => libc::SIGKILL,
        _ => libc::SIGTERM, // default to SIGTERM
    };

    // Returns {exit_code: null} if terminal doesn't exist (matching Deno behavior)
    let exit_code = ctx
        .app
        .pty_manager
        .kill(terminal_id, signal)
        .await
        .flatten();

    serde_json::to_value(TerminalCloseResult { exit_code })
        .map_err(|_| rpc::internal_error("serialization failed"))
}
