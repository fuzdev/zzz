//! Filesystem handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` provides the `ScopedFs` reach-through.
//!
//! Inputs decode strictly (`fuz_http::parse_strict_params` + serde
//! `deny_unknown_fields`), matching the `z.strictObject` input schemas in
//! `src/lib/action_specs.ts`. Failures map to distinct JSON-RPC codes by
//! cause — see [`scoped_fs_error`].

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::{
    JsonrpcError, conflict, forbidden, internal_error, invalid_params, parse_strict_params,
};
use serde::Deserialize;
use serde_json::Value;

use crate::handlers::{App, not_found_error};
use crate::scoped_fs::ScopedFsError;

// -- Error reasons (`error.data.reason`) --------------------------------------

/// Not an absolute path, or contains a NUL byte (`invalid_params`).
pub const ERROR_INVALID_PATH: &str = "invalid_path";
/// Outside every allowed root (`forbidden`).
pub const ERROR_PATH_NOT_ALLOWED: &str = "path_not_allowed";
/// The path or one of its ancestors is a symlink (`forbidden`).
pub const ERROR_SYMLINK_NOT_ALLOWED: &str = "symlink_not_allowed";
/// The OS refused access, e.g. a write to a file the daemon can't write, or
/// a read-only filesystem (`forbidden`).
pub const ERROR_PERMISSION_DENIED: &str = "permission_denied";
/// A new file's directory isn't writable (`forbidden`).
pub const ERROR_DIRECTORY_NOT_WRITABLE: &str = "directory_not_writable";
/// `diskfile_create` found the path taken (`conflict`).
pub const ERROR_ALREADY_EXISTS: &str = "already_exists";
/// A save's in-place fallback found the file replaced or removed externally
/// since it was opened, and wrote nothing (`conflict`).
pub const ERROR_REPLACED_DURING_SAVE: &str = "replaced_during_save";
/// The path doesn't exist (`not_found`).
pub const ERROR_PATH_NOT_FOUND: &str = "path_not_found";
/// The path is a directory where a file was expected (`invalid_params`).
pub const ERROR_IS_A_DIRECTORY: &str = "is_a_directory";
/// The path, or an ancestor, is not a directory where one was expected
/// (`invalid_params`) — including `directory_create` over an existing file.
pub const ERROR_NOT_A_DIRECTORY: &str = "not_a_directory";
/// A FIFO, socket, or device node where a regular file was expected
/// (`invalid_params`).
pub const ERROR_NOT_A_REGULAR_FILE: &str = "not_a_regular_file";

/// Map a [`ScopedFsError`] to its JSON-RPC error, prefixing the message with
/// `action` (e.g. `failed to write file`).
///
/// - malformed paths and wrong file kinds → `invalid_params` (-32602)
/// - out-of-scope paths, symlinks, OS permission refusals, and a
///   non-writable directory for a new file → `forbidden` (-32002)
/// - a missing path → `not_found` (-32003)
/// - `diskfile_create` over an existing path, or a save whose file was
///   replaced mid-save → `conflict` (-32004)
/// - any other I/O failure → `internal_error` (-32603)
///
/// Each carries its `ERROR_*` constant as `data.reason`, except
/// `internal_error`.
pub fn scoped_fs_error(action: &str, error: &ScopedFsError) -> JsonrpcError {
    use std::io::ErrorKind;

    let message = format!("{action}: {error}");
    match error {
        ScopedFsError::InvalidPath(_) => invalid_params(&message, Some(ERROR_INVALID_PATH)),
        ScopedFsError::PathNotAllowed(_) => forbidden(&message, Some(ERROR_PATH_NOT_ALLOWED)),
        ScopedFsError::SymlinkNotAllowed(_) => forbidden(&message, Some(ERROR_SYMLINK_NOT_ALLOWED)),
        ScopedFsError::IsADirectory(_) => invalid_params(&message, Some(ERROR_IS_A_DIRECTORY)),
        ScopedFsError::NotARegularFile(_) => {
            invalid_params(&message, Some(ERROR_NOT_A_REGULAR_FILE))
        }
        ScopedFsError::DirectoryNotWritable(_) => {
            forbidden(&message, Some(ERROR_DIRECTORY_NOT_WRITABLE))
        }
        ScopedFsError::AlreadyExists(_) => conflict(&message, Some(ERROR_ALREADY_EXISTS)),
        ScopedFsError::ReplacedDuringSave(_) => {
            conflict(&message, Some(ERROR_REPLACED_DURING_SAVE))
        }
        ScopedFsError::Io { source, .. } => match source.kind() {
            ErrorKind::NotFound => not_found_error(&message, ERROR_PATH_NOT_FOUND),
            ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => {
                forbidden(&message, Some(ERROR_PERMISSION_DENIED))
            }
            ErrorKind::IsADirectory => invalid_params(&message, Some(ERROR_IS_A_DIRECTORY)),
            // `AlreadyExists` is `create_dir_all` over an existing
            // non-directory
            ErrorKind::NotADirectory | ErrorKind::AlreadyExists => {
                invalid_params(&message, Some(ERROR_NOT_A_DIRECTORY))
            }
            ErrorKind::InvalidFilename => invalid_params(&message, Some(ERROR_INVALID_PATH)),
            _ => {
                tracing::warn!(error = %error, "{action}");
                internal_error(&message)
            }
        },
    }
}

/// Input for `diskfile_update` / `diskfile_create` — twin of
/// `DiskfileUpdateInput` / `DiskfileCreateInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskfileWriteInput {
    path: String,
    content: String,
}

/// Input for `diskfile_delete` / `directory_create` — twin of
/// `DiskfileDeleteInput` / `DirectoryCreateInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathInput {
    path: String,
}

/// The TS `DiskfilePath` refinement: an absolute path.
fn require_absolute(path: &str) -> Result<(), JsonrpcError> {
    if path.starts_with('/') {
        Ok(())
    } else {
        Err(invalid_params(
            "path must be absolute",
            Some(ERROR_INVALID_PATH),
        ))
    }
}

/// `diskfile_update` — atomically replace (or create) a file.
///
/// # Errors
///
/// `invalid_params` for a malformed input; otherwise [`scoped_fs_error`].
pub async fn diskfile_update(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: DiskfileWriteInput = parse_strict_params(params)?;
    require_absolute(&input.path)?;

    app.scoped_fs
        .write_file(&input.path, input.content)
        .await
        .map_err(|e| scoped_fs_error("failed to write file", &e))?;

    Ok(Value::Null)
}

/// `diskfile_create` — create a new file, never replacing an existing one
/// (`O_EXCL` on the final name).
///
/// # Errors
///
/// `invalid_params` for a malformed input; `conflict` (`already_exists`)
/// when the path is taken; otherwise [`scoped_fs_error`].
pub async fn diskfile_create(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: DiskfileWriteInput = parse_strict_params(params)?;
    require_absolute(&input.path)?;

    app.scoped_fs
        .create_file(&input.path, input.content)
        .await
        .map_err(|e| scoped_fs_error("failed to create file", &e))?;

    Ok(Value::Null)
}

/// `diskfile_delete` — remove a file.
///
/// # Errors
///
/// `invalid_params` for a malformed input; otherwise [`scoped_fs_error`].
pub async fn diskfile_delete(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: PathInput = parse_strict_params(params)?;
    require_absolute(&input.path)?;

    app.scoped_fs
        .rm(&input.path)
        .await
        .map_err(|e| scoped_fs_error("failed to delete file", &e))?;

    Ok(Value::Null)
}

/// `directory_create` — create a directory and any missing parents.
///
/// # Errors
///
/// `invalid_params` for a malformed input; otherwise [`scoped_fs_error`].
pub async fn directory_create(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: PathInput = parse_strict_params(params)?;
    require_absolute(&input.path)?;

    app.scoped_fs
        .mkdir(&input.path)
        .await
        .map_err(|e| scoped_fs_error("failed to create directory", &e))?;

    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use fuz_http::JsonrpcErrorCode;
    use serde_json::json;

    use super::*;

    fn io(kind: std::io::ErrorKind) -> ScopedFsError {
        ScopedFsError::Io {
            path: "/p".to_owned(),
            source: std::io::Error::from(kind),
        }
    }

    fn reason(error: &JsonrpcError) -> Option<&str> {
        error.data.as_ref()?.get("reason")?.as_str()
    }

    #[test]
    fn scoped_fs_errors_map_by_cause() {
        use std::io::ErrorKind;

        let cases = [
            (
                ScopedFsError::InvalidPath("x".to_owned()),
                JsonrpcErrorCode::InvalidParams,
                Some(ERROR_INVALID_PATH),
            ),
            (
                ScopedFsError::PathNotAllowed("/x".to_owned()),
                JsonrpcErrorCode::Forbidden,
                Some(ERROR_PATH_NOT_ALLOWED),
            ),
            (
                ScopedFsError::SymlinkNotAllowed("/x".to_owned()),
                JsonrpcErrorCode::Forbidden,
                Some(ERROR_SYMLINK_NOT_ALLOWED),
            ),
            (
                ScopedFsError::IsADirectory("/x".to_owned()),
                JsonrpcErrorCode::InvalidParams,
                Some(ERROR_IS_A_DIRECTORY),
            ),
            (
                ScopedFsError::NotARegularFile("/x".to_owned()),
                JsonrpcErrorCode::InvalidParams,
                Some(ERROR_NOT_A_REGULAR_FILE),
            ),
            (
                ScopedFsError::DirectoryNotWritable("/x".to_owned()),
                JsonrpcErrorCode::Forbidden,
                Some(ERROR_DIRECTORY_NOT_WRITABLE),
            ),
            (
                ScopedFsError::AlreadyExists("/x".to_owned()),
                JsonrpcErrorCode::Conflict,
                Some(ERROR_ALREADY_EXISTS),
            ),
            (
                ScopedFsError::ReplacedDuringSave("/x".to_owned()),
                JsonrpcErrorCode::Conflict,
                Some(ERROR_REPLACED_DURING_SAVE),
            ),
            (
                io(ErrorKind::ReadOnlyFilesystem),
                JsonrpcErrorCode::Forbidden,
                Some(ERROR_PERMISSION_DENIED),
            ),
            (
                io(ErrorKind::NotFound),
                JsonrpcErrorCode::NotFound,
                Some(ERROR_PATH_NOT_FOUND),
            ),
            (
                io(ErrorKind::PermissionDenied),
                JsonrpcErrorCode::Forbidden,
                Some(ERROR_PERMISSION_DENIED),
            ),
            (
                io(ErrorKind::IsADirectory),
                JsonrpcErrorCode::InvalidParams,
                Some(ERROR_IS_A_DIRECTORY),
            ),
            (
                io(ErrorKind::NotADirectory),
                JsonrpcErrorCode::InvalidParams,
                Some(ERROR_NOT_A_DIRECTORY),
            ),
            (
                io(ErrorKind::AlreadyExists),
                JsonrpcErrorCode::InvalidParams,
                Some(ERROR_NOT_A_DIRECTORY),
            ),
            (
                io(ErrorKind::StorageFull),
                JsonrpcErrorCode::InternalError,
                None,
            ),
            (io(ErrorKind::Other), JsonrpcErrorCode::InternalError, None),
        ];
        for (error, code, expected_reason) in cases {
            let mapped = scoped_fs_error("failed to write file", &error);
            assert_eq!(mapped.code, code, "{error:?}");
            assert_eq!(reason(&mapped), expected_reason, "{error:?}");
            assert!(
                mapped.message.starts_with("failed to write file: "),
                "{}",
                mapped.message
            );
        }
    }

    #[test]
    fn inputs_are_strict() {
        let ok: DiskfileWriteInput =
            parse_strict_params(json!({"path": "/a", "content": ""})).unwrap();
        assert_eq!(ok.path, "/a");
        for params in [
            json!({"path": "/a", "content": "", "extra": 1}),
            json!({"path": "/a", "content": null}),
            json!({"path": "/a"}),
            json!({"path": 1, "content": ""}),
        ] {
            let e = parse_strict_params::<DiskfileWriteInput>(params.clone())
                .err()
                .unwrap_or_else(|| panic!("accepted {params}"));
            assert_eq!(e.code, JsonrpcErrorCode::InvalidParams, "{params}");
        }
        for params in [
            json!({"path": "/a", "recursive": true}),
            json!({"path": null}),
        ] {
            assert!(parse_strict_params::<PathInput>(params).is_err());
        }
    }
}
