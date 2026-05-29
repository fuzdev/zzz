//! Filesystem handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` provides the `ScopedFs` reach-through.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::JsonrpcError;
use serde_json::Value;

use crate::handlers::App;
use crate::rpc;

pub async fn diskfile_update(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
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

    app.scoped_fs
        .write_file(path, content)
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to write file: {e}")))?;

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
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;
    if !path.starts_with('/') {
        return Err(rpc::invalid_params("path must be absolute"));
    }

    app.scoped_fs
        .rm(path)
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to delete file: {e}")))?;

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
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'path' parameter"))?;
    if !path.starts_with('/') {
        return Err(rpc::invalid_params("path must be absolute"));
    }

    app.scoped_fs
        .mkdir(path)
        .await
        .map_err(|e| rpc::internal_error(&format!("failed to create directory: {e}")))?;

    Ok(Value::Null)
}
