//! Workspace handlers — open, close, and list workspace directories.

use std::path::Path;
use std::sync::Arc;

use fuz_http::JsonrpcError;
use serde::Serialize;
use serde_json::Value;

use crate::filer::{FilerConfig, FilerLifetime};
use crate::rpc;

use super::{Ctx, WorkspaceInfo, to_normalized_dir};

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

// -- Typed response structs ---------------------------------------------------

#[derive(Serialize)]
struct WorkspaceListResult {
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Serialize)]
struct WorkspaceOpenResult {
    workspace: WorkspaceInfo,
    files: Vec<Value>, // always empty — initial files sent via session_load, watcher handles updates
}

// -- Handlers -----------------------------------------------------------------

pub(super) fn handle_workspace_list(ctx: &Ctx<'_>) -> Result<Value, JsonrpcError> {
    let list: Vec<WorkspaceInfo> = {
        let workspaces = ctx.app.workspaces.read();
        workspaces.values().cloned().collect()
    };
    let result = WorkspaceListResult { workspaces: list };
    serde_json::to_value(result).map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

pub(super) async fn handle_workspace_open(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;

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

    let normalized = to_normalized_dir(&canonical)?;

    let existing = {
        let workspaces = ctx.app.workspaces.read();
        workspaces.get(&normalized).cloned()
    };

    if let Some(workspace) = existing {
        let result = WorkspaceOpenResult {
            workspace,
            files: vec![],
        };
        return serde_json::to_value(result)
            .map_err(|e| rpc::internal_error_with_source("serialization failed", &e));
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
        let mut workspaces = ctx.app.workspaces.write();
        workspaces.entry(normalized).or_insert(info).clone()
    };

    ctx.app.scoped_fs.add_path(Path::new(&workspace.path));

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

    let notification = rpc::notification(
        "workspace_changed",
        &WorkspaceChangedParams {
            change_type: "open",
            workspace: &workspace,
        },
    );
    ctx.app.broadcast(&notification);

    let result = WorkspaceOpenResult {
        workspace,
        files: vec![],
    };
    serde_json::to_value(result).map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

pub(super) async fn handle_workspace_close(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;

    let mut key = path.to_owned();
    if !key.ends_with('/') {
        key.push('/');
    }

    let removed = {
        let mut workspaces = ctx.app.workspaces.write();
        workspaces.remove(&key)
    };

    let Some(workspace) = removed else {
        return Err(rpc::invalid_params(&format!("workspace not open: {path}")));
    };

    let is_initial_scoped_dir = ctx.app.scoped_dirs.contains(&key);
    if !is_initial_scoped_dir {
        ctx.app.filer_manager.stop_filer(&key).await;
        ctx.app.scoped_fs.remove_path(Path::new(&key));
    }

    let notification = rpc::notification(
        "workspace_changed",
        &WorkspaceChangedParams {
            change_type: "close",
            workspace: &workspace,
        },
    );
    ctx.app.broadcast(&notification);

    Ok(Value::Null)
}
