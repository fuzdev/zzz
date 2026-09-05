//! Filesystem handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` provides the `ScopedFs` reach-through.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::{JsonrpcError, internal_error, invalid_params};
use serde_json::Value;

use crate::handlers::App;

pub async fn diskfile_update(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'path' parameter", None))?;
    if !path.starts_with('/') {
        return Err(invalid_params("path must be absolute", None));
    }
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'content' parameter", None))?;

    app.scoped_fs
        .write_file(path, content)
        .await
        .map_err(|e| internal_error(&format!("failed to write file: {e}")))?;

    Ok(Value::Null)
}

pub async fn diskfile_delete(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'path' parameter", None))?;
    if !path.starts_with('/') {
        return Err(invalid_params("path must be absolute", None));
    }

    app.scoped_fs
        .rm(path)
        .await
        .map_err(|e| internal_error(&format!("failed to delete file: {e}")))?;

    Ok(Value::Null)
}

pub async fn directory_create(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("missing or invalid 'path' parameter", None))?;
    if !path.starts_with('/') {
        return Err(invalid_params("path must be absolute", None));
    }

    app.scoped_fs
        .mkdir(path)
        .await
        .map_err(|e| internal_error(&format!("failed to create directory: {e}")))?;

    Ok(Value::Null)
}
