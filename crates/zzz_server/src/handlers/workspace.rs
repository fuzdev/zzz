//! Workspace handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` carries the zzz-specific deps the spine
//! `ActionContext` doesn't (`workspaces` map, `FilerManager`, `ScopedFs`,
//! `ConnectionRegistry`-backed broadcast).

use std::path::Path;
use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::{JsonrpcError, internal_error, internal_error_with_source, invalid_params};
use fuz_realtime::notify_to_string;
use serde::Serialize;
use serde_json::Value;

use crate::filer::{FilerConfig, FilerLifetime};
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
    files: Vec<Value>,
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
pub async fn workspace_open(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'path' parameter", None))?;

    let canonical = Path::new(path).canonicalize().map_err(|_| {
        let suffix = if path.ends_with('/') { "" } else { "/" };
        internal_error(&format!(
            "failed to open workspace: directory does not exist: {path}{suffix}"
        ))
    })?;

    if !canonical.is_dir() {
        let suffix = if path.ends_with('/') { "" } else { "/" };
        return Err(internal_error(&format!(
            "failed to open workspace: not a directory: {path}{suffix}"
        )));
    }

    let normalized = to_normalized_dir(&canonical)?;

    let existing = {
        let workspaces = app.workspaces.read();
        workspaces.get(&normalized).cloned()
    };

    if let Some(workspace) = existing {
        let result = WorkspaceOpenResult {
            workspace,
            files: vec![],
        };
        return serde_json::to_value(result)
            .map_err(|e| internal_error_with_source("serialization failed", &e));
    }

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

    let workspace = {
        let mut workspaces = app.workspaces.write();
        workspaces.entry(normalized).or_insert(info).clone()
    };

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

    // Broadcast the workspace_changed notification. Uses the spine
    // `notify_to_string` builder + the legacy `App.broadcast` path —
    // the spine `ConnectionRegistry` broadcast swap lands in a later
    // batch that retires the legacy `connections` map.
    let params_value = serde_json::to_value(WorkspaceChangedParams {
        change_type: "open",
        workspace: &workspace,
    })
    .map_err(|e| internal_error_with_source("notification params serialize failed", &e))?;
    let notification = notify_to_string("workspace_changed", &params_value);
    app.broadcast(&notification);

    let result = WorkspaceOpenResult {
        workspace,
        files: vec![],
    };
    serde_json::to_value(result).map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `workspace_close` — close a workspace directory.
pub async fn workspace_close(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'path' parameter", None))?;

    let mut key = path.to_owned();
    if !key.ends_with('/') {
        key.push('/');
    }

    let removed = {
        let mut workspaces = app.workspaces.write();
        workspaces.remove(&key)
    };

    let Some(workspace) = removed else {
        return Err(invalid_params(&format!("workspace not open: {path}"), None));
    };

    let is_initial_scoped_dir = app.scoped_dirs.contains(&key);
    if !is_initial_scoped_dir {
        app.filer_manager.stop_filer(&key).await;
        app.scoped_fs.remove_path(Path::new(&key));
    }

    let params_value = serde_json::to_value(WorkspaceChangedParams {
        change_type: "close",
        workspace: &workspace,
    })
    .map_err(|e| internal_error_with_source("notification params serialize failed", &e))?;
    let notification = notify_to_string("workspace_changed", &params_value);
    app.broadcast(&notification);

    Ok(Value::Null)
}
