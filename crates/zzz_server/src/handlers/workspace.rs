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
use fuz_auth::require_void_params;
use fuz_http::{
    JsonrpcError, forbidden, internal_error_with_source, invalid_params, parse_strict_params,
};
use fuz_realtime::notify_to_string;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filer::{FilerConfig, FilerLifetime, SerializableDisknode, WatchStatus};
use crate::handlers::filesystem::{
    ERROR_INVALID_PATH, ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED,
};
use crate::handlers::{App, WorkspaceInfo, not_found_error};

// -- Inputs -----------------------------------------------------------------

/// Input for `workspace_open` / `workspace_close` — twin of
/// `WorkspaceOpenInput` / `WorkspaceCloseInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspacePathInput {
    path: String,
}

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
    /// Whether every directory of the workspace has a file watch —
    /// `degraded` when the OS watch limit left some to periodic rescans.
    watch_status: WatchStatus,
}

// -- Helpers -----------------------------------------------------------------

fn to_normalized_dir(path: &Path) -> Result<String, JsonrpcError> {
    let mut s = path
        .to_str()
        .ok_or_else(|| {
            invalid_params(
                &format!("path is not valid UTF-8: {}", path.display()),
                Some(ERROR_INVALID_PATH),
            )
        })?
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
            Some(ERROR_INVALID_PATH),
        ))
    }
}

/// Map a failure to resolve a `workspace_open` path: a missing path is
/// `not_found`, a non-directory ancestor `invalid_params`, an OS refusal
/// `forbidden`, anything else `internal_error`.
fn open_path_error(path: &str, error: &std::io::Error) -> JsonrpcError {
    use std::io::ErrorKind;

    let dir = display_dir(path);
    match error.kind() {
        ErrorKind::NotFound => not_found_error(
            &format!("failed to open workspace: directory does not exist: {dir}"),
            ERROR_PATH_NOT_FOUND,
        ),
        ErrorKind::NotADirectory => invalid_params(
            &format!("failed to open workspace: not a directory: {dir}"),
            Some(ERROR_NOT_A_DIRECTORY),
        ),
        ErrorKind::PermissionDenied => forbidden(
            &format!("failed to open workspace: permission denied: {dir}"),
            Some(ERROR_PERMISSION_DENIED),
        ),
        _ => internal_error_with_source(&format!("failed to open workspace: {dir}"), error),
    }
}

/// `path` with a trailing `/`, as the workspace is keyed.
fn display_dir(path: &str) -> String {
    let suffix = if path.ends_with('/') { "" } else { "/" };
    format!("{path}{suffix}")
}

// -- Handlers ----------------------------------------------------------------

/// `workspace_list` — read-only snapshot of open workspaces.
///
/// Takes no input (`z.void()`), so any `params` is refused. `async` is
/// required by the `ActionHandler` future-returning shape even though the
/// body has no `.await` points.
#[allow(
    clippy::unused_async,
    reason = "ActionHandler signature requires async"
)]
pub async fn workspace_list(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    require_void_params(&params)?;
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
/// Returns the workspace plus its filer's file index and watch status — on
/// the idempotent path too, so a client re-opening an already-open workspace
/// can seed its tree the same way. A directory whose listing is refused
/// fails with `forbidden` (`permission_denied`), leaving nothing open.
pub async fn workspace_open(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let WorkspacePathInput { path } = parse_strict_params(params)?;
    let path = path.as_str();
    require_absolute(path)?;

    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|e| open_path_error(path, &e))?;

    let meta = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| open_path_error(path, &e))?;
    if !meta.is_dir() {
        return Err(invalid_params(
            &format!(
                "failed to open workspace: not a directory: {}",
                display_dir(path)
            ),
            Some(ERROR_NOT_A_DIRECTORY),
        ));
    }

    let normalized = to_normalized_dir(&canonical)?;

    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_owned();

    let info = WorkspaceInfo {
        path: normalized,
        name,
        opened_at: fuz_sys::rfc3339_now(),
    };

    // Run to completion in its own task, so a caller that goes away mid-open
    // can't leave a filer running for a workspace that never opened.
    let requested = path.to_owned();
    tokio::spawn(open_workspace(app, info, requested))
        .await
        .map_err(|e| internal_error_with_source("failed to open workspace", &e))?
}

/// The body of `workspace_open` once the path is resolved: start the
/// workspace filer, then register the workspace.
async fn open_workspace(
    app: Arc<App>,
    info: WorkspaceInfo,
    requested: String,
) -> Result<Value, JsonrpcError> {
    let key = info.path.clone();

    // Start (or find) the filer before taking the lifecycle lock: its
    // initial scan walks, watches, and reads the whole tree, and opens and
    // closes of other workspaces shouldn't wait on it. A root that can't be
    // listed fails the open here, before anything is registered.
    ensure_workspace_filer(&app, &key)
        .await
        .map_err(|e| open_path_error(&requested, &e))?;

    // Held across the map, scope, and filer steps so a concurrent close can't
    // interleave (see `App::workspace_lifecycle`).
    let _lifecycle = app.workspace_lifecycle.lock().await;

    let (workspace, is_new) = {
        let mut workspaces = app.workspaces.write();
        match workspaces.entry(key) {
            Entry::Occupied(entry) => (entry.get().clone(), false),
            Entry::Vacant(entry) => (entry.insert(info).clone(), true),
        }
    };

    // A close of this workspace that ran between the start above and the
    // lock stopped the filer, so ensure it again — a dedup hit otherwise.
    // `start_filer` only returns once a registered filer has finished its
    // initial scan, so the returned files always come from a completed scan.
    if let Err(e) = ensure_workspace_filer(&app, &workspace.path).await {
        if is_new {
            app.workspaces.write().remove(&workspace.path);
        }
        return Err(open_path_error(&requested, &e));
    }
    app.scoped_fs.add_path(Path::new(&workspace.path));

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
    let watch_status = app.filer_manager.watch_status_for(&workspace.path).await;
    let result = WorkspaceOpenResult {
        workspace,
        files,
        watch_status,
    };
    serde_json::to_value(result).map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// Start the workspace filer for `path` (normalized, trailing `/`), or find
/// the one already running.
async fn ensure_workspace_filer(app: &Arc<App>, path: &str) -> std::io::Result<bool> {
    app.filer_manager
        .start_filer(
            path,
            Arc::clone(app),
            FilerConfig::workspace(path, &app.zzz_dir),
            FilerLifetime::Workspace,
        )
        .await
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
    let WorkspacePathInput { path } = parse_strict_params(params)?;
    let path = path.as_str();
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
