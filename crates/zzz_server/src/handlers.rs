use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::RwLock;

use deadpool_postgres::Pool;
use fuz_common::JsonRpcError;
use serde::Serialize;
use serde_json::Value;

use crate::auth::{Keyring, RequestContext};
use crate::rpc;

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
}

impl App {
    pub fn new(
        db_pool: Pool,
        keyring: Keyring,
        allowed_origins: Vec<String>,
        bootstrap_token_path: Option<String>,
        bootstrap_available: bool,
    ) -> Self {
        Self {
            workspaces: RwLock::new(HashMap::new()),
            db_pool,
            keyring,
            allowed_origins,
            bootstrap_token_path,
            bootstrap_available: AtomicBool::new(bootstrap_available),
        }
    }
}

// -- Per-request context (constructed by transport) ---------------------------

/// Per-request context passed to handler functions.
///
/// Borrows `App` and the request id from the parsed envelope.
/// The transport constructs this before calling `dispatch`.
pub struct Ctx<'a> {
    pub app: &'a App,
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
    files: Vec<Value>, // always empty — no file watching in Rust backend yet
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
/// Async to support future handlers that need DB or external I/O.
/// Match statement dispatch — zero overhead, compiler can inline.
#[allow(clippy::unused_async)] // async for forward compat — DB handlers will await
pub async fn dispatch(method: &str, params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
    match method {
        "ping" => handle_ping(ctx),
        "workspace_list" => handle_workspace_list(ctx),
        "workspace_open" => handle_workspace_open(params, ctx),
        "workspace_close" => handle_workspace_close(params, ctx),
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

fn handle_workspace_open(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
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

    let result = WorkspaceOpenResult {
        workspace,
        files: vec![],
    };
    serde_json::to_value(result).map_err(|_| rpc::internal_error("serialization failed"))
}

fn handle_workspace_close(params: &Value, ctx: &Ctx<'_>) -> Result<Value, JsonRpcError> {
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
        workspaces.remove(&key).is_some()
    };

    if !removed {
        return Err(rpc::invalid_params(&format!(
            "workspace not open: {path}"
        )));
    }

    Ok(Value::Null)
}
