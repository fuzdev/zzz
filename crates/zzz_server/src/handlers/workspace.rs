//! Workspace handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` carries the zzz-specific deps the spine
//! `ActionContext` doesn't (`workspaces` map, `FilerManager`, `ScopedFs`,
//! `ConnectionRegistry`-backed broadcast).

use std::collections::hash_map::Entry;
use std::path::Path;
use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::{JsonrpcError, internal_error, internal_error_with_source, invalid_params};
use fuz_realtime::notify_to_string;
use serde::Serialize;
use serde_json::Value;

use crate::filer::{FilerConfig, FilerLifetime, SerializableDisknode};
use crate::handlers::{App, WorkspaceInfo};

// -- Notification params -----------------------------------------------------

#[derive(Serialize)]
struct WorkspaceChangedParams<'a> {
    #[serde(rename = "type")]
    change_type: &'a str,
    workspace: &'a WorkspaceInfo,
}

// -- Typed response structs --------------------------------------------------

#[derive(Serialize)]
struct WorkspaceListResult {
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Serialize)]
struct WorkspaceOpenResult {
    workspace: WorkspaceInfo,
    /// The workspace filer's index — the frontend seeds its file tree from
    /// this, since the filer's initial scan broadcasts nothing.
    files: Vec<SerializableDisknode>,
}

// -- Helpers -----------------------------------------------------------------

fn to_normalized_dir(path: &Path) -> Result<String, JsonrpcError> {
    let mut s = path
        .to_str()
        .ok_or_else(|| internal_error("path is not valid UTF-8"))?
        .to_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    Ok(s)
}

/// Reject an empty or relative workspace path. Without this, `""` would
/// become the key `/` on close, and a relative path would canonicalize
/// against the daemon's working directory on open.
fn require_absolute(path: &str) -> Result<(), JsonrpcError> {
    if Path::new(path).is_absolute() {
        Ok(())
    } else {
        Err(invalid_params(
            &format!("path must be absolute: {path:?}"),
            None,
        ))
    }
}

// -- Handlers ----------------------------------------------------------------

/// `workspace_list` — read-only snapshot of open workspaces.
///
/// Spine signature: `(Value, ActionContext<'_>)`. `params` is unused
/// (`workspace_list` takes no input); kept in the signature for
/// `ActionHandler` shape uniformity. `async` is required by the
/// `ActionHandler` future-returning shape even though the body has
/// no `.await` points.
#[allow(
    clippy::unused_async,
    reason = "ActionHandler signature requires async"
)]
pub async fn workspace_list(
    _params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let list: Vec<WorkspaceInfo> = {
        let workspaces = app.workspaces.read();
        workspaces.values().cloned().collect()
    };
    let result = WorkspaceListResult { workspaces: list };
    serde_json::to_value(result).map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `workspace_open` — open a workspace directory.
///
/// Side-effects: registers a filer watcher, adds the path to `ScopedFs`,
/// inserts a `WorkspaceInfo` into the in-memory map, broadcasts a
/// `workspace_changed` notification to all connections.
///
/// Returns the workspace plus its filer's file index — on the idempotent
/// path too, so a client re-opening an already-open workspace can seed its
/// tree the same way.
pub async fn workspace_open(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'path' parameter", None))?;
    require_absolute(path)?;

    let canonical = tokio::fs::canonicalize(path).await.map_err(|_| {
        let suffix = if path.ends_with('/') { "" } else { "/" };
        internal_error(&format!(
            "failed to open workspace: directory does not exist: {path}{suffix}"
        ))
    })?;

    let is_dir = tokio::fs::metadata(&canonical)
        .await
        .is_ok_and(|meta| meta.is_dir());
    if !is_dir {
        let suffix = if path.ends_with('/') { "" } else { "/" };
        return Err(internal_error(&format!(
            "failed to open workspace: not a directory: {path}{suffix}"
        )));
    }

    let normalized = to_normalized_dir(&canonical)?;

    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_owned();

    let info = WorkspaceInfo {
        path: normalized.clone(),
        name,
        opened_at: fuz_sys::rfc3339_now(),
    };

    // Held across the map, scope, and filer steps so a concurrent close can't
    // interleave (see `App::workspace_lifecycle`). Opens are serialized too,
    // including a new workspace's initial scan.
    let _lifecycle = app.workspace_lifecycle.lock().await;

    let (workspace, is_new) = {
        let mut workspaces = app.workspaces.write();
        match workspaces.entry(normalized) {
            Entry::Occupied(entry) => (entry.get().clone(), false),
            Entry::Vacant(entry) => (entry.insert(info).clone(), true),
        }
    };

    // Both paths ensure the scope and the filer — an idempotent open also
    // retries a filer that failed to start. `start_filer` dedups and only
    // returns once a registered filer has finished its initial scan, so the
    // returned files always come from a completed scan.
    app.scoped_fs.add_path(Path::new(&workspace.path));
    if let Err(e) = app
        .filer_manager
        .start_filer(
            &workspace.path,
            Arc::clone(&app),
            FilerConfig::workspace(&app.zzz_dir),
            FilerLifetime::Workspace,
        )
        .await
    {
        tracing::warn!(path = %workspace.path, error = %e, "failed to start file watcher");
    }

    if is_new {
        // Broadcast the workspace_changed notification (the spine
        // `notify_to_string` builder + the `App.broadcast` shim over the
        // spine `ConnectionRegistry`).
        let params_value = serde_json::to_value(WorkspaceChangedParams {
            change_type: "open",
            workspace: &workspace,
        })
        .map_err(|e| internal_error_with_source("notification params serialize failed", &e))?;
        let notification = notify_to_string("workspace_changed", &params_value);
        app.broadcast(&notification);
    }

    let files = app.filer_manager.files_for(&workspace.path).await;
    let result = WorkspaceOpenResult { workspace, files };
    serde_json::to_value(result).map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `workspace_close` — close a workspace directory.
///
/// `path` is matched against the open workspaces as given (plus a trailing
/// `/`), then canonicalized — so a non-canonical spelling of an open
/// workspace (`/a/./b`, a symlinked path) closes it too, while a workspace
/// whose directory was deleted can still be closed by its stored path.
pub async fn workspace_close(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'path' parameter", None))?;
    require_absolute(path)?;

    let mut key = path.to_owned();
    if !key.ends_with('/') {
        key.push('/');
    }
    // resolved before the lock — only consulted if `key` itself isn't open
    let canonical_key = tokio::fs::canonicalize(path)
        .await
        .ok()
        .and_then(|canonical| to_normalized_dir(&canonical).ok());

    let lifecycle = app.workspace_lifecycle.lock().await;

    let is_open = app.workspaces.read().contains_key(&key);
    if !is_open && let Some(canonical_key) = canonical_key {
        key = canonical_key;
    }

    let Some(workspace) = release_workspace(&app, &key, &lifecycle).await else {
        return Err(invalid_params(&format!("workspace not open: {path}"), None));
    };

    broadcast_workspace_closed(&app, &workspace)?;

    Ok(Value::Null)
}

/// Close every open workspace through the same path as `workspace_close`.
///
/// Each workspace's filer is stopped, its `ScopedFs` root removed, and a
/// `workspace_changed` close broadcast — restoring the boot-time scope
/// (`zzz_dir` + `scoped_dirs`). Used by the test binary's `_testing_reset`.
///
/// Returns the closed workspaces.
///
/// # Errors
///
/// Returns a JSON-RPC internal error if a notification fails to serialize;
/// every workspace is released before any broadcast, so the scope is
/// restored regardless.
pub async fn workspace_close_all(app: &App) -> Result<Vec<WorkspaceInfo>, JsonrpcError> {
    let lifecycle = app.workspace_lifecycle.lock().await;
    let keys: Vec<String> = app.workspaces.read().keys().cloned().collect();
    let mut closed = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(workspace) = release_workspace(app, &key, &lifecycle).await {
            closed.push(workspace);
        }
    }
    drop(lifecycle);
    for workspace in &closed {
        broadcast_workspace_closed(app, workspace)?;
    }
    Ok(closed)
}

/// Remove the workspace at `key` (normalized, trailing `/`) from the open
/// map and release its filer and `ScopedFs` root. `None` if it isn't open.
///
/// Unconditional on purpose: `FilerManager::stop_filer` keeps permanent
/// filers and `ScopedFs::remove_path` never removes a permanent root, so a
/// workspace opened on `zzz_dir` or a scoped dir — or nested in or containing
/// one — can't revoke the access that root grants.
///
/// The `_lifecycle` guard is proof the caller holds
/// `App::workspace_lifecycle`, keeping the map, scope, and filer in lockstep.
async fn release_workspace(
    app: &App,
    key: &str,
    _lifecycle: &tokio::sync::MutexGuard<'_, ()>,
) -> Option<WorkspaceInfo> {
    let workspace = app.workspaces.write().remove(key)?;
    app.filer_manager.stop_filer(key).await;
    app.scoped_fs.remove_path(Path::new(key));
    Some(workspace)
}

fn broadcast_workspace_closed(app: &App, workspace: &WorkspaceInfo) -> Result<(), JsonrpcError> {
    let params_value = serde_json::to_value(WorkspaceChangedParams {
        change_type: "close",
        workspace,
    })
    .map_err(|e| internal_error_with_source("notification params serialize failed", &e))?;
    let notification = notify_to_string("workspace_changed", &params_value);
    app.broadcast(&notification);
    Ok(())
}
