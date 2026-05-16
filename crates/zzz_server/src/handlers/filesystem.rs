//! Filesystem handlers — diskfile and directory mutations through `ScopedFs`.

use fuz_common::JsonRpcError;
use serde_json::Value;

use crate::rpc;

use super::Ctx;

pub(super) async fn handle_diskfile_update(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
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

pub(super) async fn handle_diskfile_delete(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
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

pub(super) async fn handle_directory_create(
    params: &Value,
    ctx: &Ctx<'_>,
) -> Result<Value, JsonRpcError> {
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
