//! Filesystem handlers.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` provides the `ScopedFs` reach-through.
//!
//! Inputs decode strictly (`fuz_http::parse_strict_params` + serde
//! `deny_unknown_fields`), matching the strict object input schemas in
//! `src/lib/action_specs.ts`. Failures map to distinct JSON-RPC codes by
//! cause — see [`scoped_fs_error`].

use std::io;
use std::path::Path;
use std::sync::Arc;

use fuz_actions::{ActionContext, ActionOutput};
use fuz_http::{
    JsonrpcError, conflict, forbidden, internal_error, internal_error_with_source, invalid_params,
    parse_strict_params,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filer::system_time_to_ms;
use crate::handlers::{App, not_found_error};
use crate::scoped_fs::{ScopedFsError, normalize_path};

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
/// A new file's or directory's parent directory isn't writable (`forbidden`).
pub const ERROR_DIRECTORY_NOT_WRITABLE: &str = "directory_not_writable";
/// `diskfile_create` or `directory_create` found the path taken (`conflict`).
pub const ERROR_ALREADY_EXISTS: &str = "already_exists";
/// A save's in-place fallback found the file replaced or removed externally
/// since it was opened, and wrote nothing (`conflict`).
pub const ERROR_REPLACED_DURING_SAVE: &str = "replaced_during_save";
/// An append found the file at a different size than the expected offset,
/// and wrote nothing (`conflict`).
pub const ERROR_OFFSET_MISMATCH: &str = "offset_mismatch";
/// The path doesn't exist (`not_found`).
pub const ERROR_PATH_NOT_FOUND: &str = "path_not_found";
/// The path is a directory where a file was expected (`invalid_params`).
pub const ERROR_IS_A_DIRECTORY: &str = "is_a_directory";
/// The path, or an ancestor, is not a directory where one was expected
/// (`invalid_params`).
pub const ERROR_NOT_A_DIRECTORY: &str = "not_a_directory";
/// A FIFO, socket, or device node where a regular file was expected
/// (`invalid_params`).
pub const ERROR_NOT_A_REGULAR_FILE: &str = "not_a_regular_file";
/// A protected directory, or a path inside one (`forbidden`): every
/// `ScopedFs` operation on one ([`ScopedFsError::ProtectedDirNotAllowed`]),
/// and `workspace_open` of one.
///
/// That's a credential directory (`.ssh`, `.gnupg`, `.aws`, `.kube`,
/// `.docker`, `.password-store` — `scoped_fs::CREDENTIAL_DIR_NAMES`) or a
/// `.zzz` directory other than the app dir (the CLI's daemon home `~/.zzz/`,
/// with `.env` and `bootstrap_token`, or another daemon's app dir). The
/// message names which.
pub const ERROR_PROTECTED_DIR_NOT_ALLOWED: &str = "protected_dir_not_allowed";

/// Map a [`ScopedFsError`] to its JSON-RPC error, prefixing the message with
/// `action` (e.g. `failed to write file`).
///
/// - malformed paths and wrong file kinds → `invalid_params` (-32602)
/// - out-of-scope paths, protected directories, symlinks, OS permission
///   refusals, and a non-writable directory for a new file or directory →
///   `forbidden` (-32002)
/// - a missing path → `not_found` (-32003)
/// - `diskfile_create` / `directory_create` over an existing path, or a save
///   whose file was replaced mid-save, or an append at the wrong offset →
///   `conflict` (-32004)
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
        ScopedFsError::ProtectedDirNotAllowed { .. } => {
            forbidden(&message, Some(ERROR_PROTECTED_DIR_NOT_ALLOWED))
        }
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
        ScopedFsError::OffsetMismatch { .. } => conflict(&message, Some(ERROR_OFFSET_MISMATCH)),
        ScopedFsError::Io { source, .. } => match source.kind() {
            ErrorKind::NotFound => not_found_error(&message, ERROR_PATH_NOT_FOUND),
            ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => {
                forbidden(&message, Some(ERROR_PERMISSION_DENIED))
            }
            ErrorKind::IsADirectory => invalid_params(&message, Some(ERROR_IS_A_DIRECTORY)),
            // `AlreadyExists` is `create_dir_all` over an existing
            // non-directory ancestor
            ErrorKind::NotADirectory | ErrorKind::AlreadyExists => {
                invalid_params(&message, Some(ERROR_NOT_A_DIRECTORY))
            }
            ErrorKind::InvalidFilename => invalid_params(&message, Some(ERROR_INVALID_PATH)),
            _ => {
                // not the chain: `ScopedFsError::Io`'s message already carries its cause
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

/// Input for `diskfile_read` / `diskfile_delete` / `directory_create` — twin
/// of `DiskfileReadInput` / `DiskfileDeleteInput` / `DirectoryCreateInput`.
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

// -- Text reads ---------------------------------------------------------------

/// Most bytes `diskfile_read` returns as text: a larger file comes back with
/// `contents: null` and [`UnloadedReason::TooLarge`], and the byte routes
/// serve it instead. Sized so a loaded file's save fits the JSON-RPC message
/// cap ([`crate::RPC_MESSAGE_MAX_BYTES`]) in all but pathological cases.
///
/// TODO @parity: align with `fuz_app`'s equivalent cap when it lands.
const MAX_TEXT_READ_SIZE: u64 = 4 * 1024 * 1024;

/// Why a regular file's contents aren't served as text — twin of
/// `DiskfileUnloadedReason` in `diskfile_types.ts`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum UnloadedReason {
    /// Over [`MAX_TEXT_READ_SIZE`] bytes.
    TooLarge,
    /// Not valid UTF-8.
    NotUtf8,
}

/// An open regular file's contents read as text by [`read_text_contents`].
#[derive(Debug, PartialEq, Eq)]
enum TextContents {
    /// The whole file, valid UTF-8, of at most [`MAX_TEXT_READ_SIZE`] bytes.
    Loaded(String),
    /// Not read as text, and why. `size` is the file's size in bytes as far
    /// as the read saw it: the bytes read for one that isn't UTF-8, and for
    /// one too large the larger of its size when opened and the bytes read
    /// (it may have grown past the limit since).
    Unloaded { reason: UnloadedReason, size: u64 },
}

impl TextContents {
    /// The file's size in bytes: the length of the loaded text, or the size
    /// the unloaded file was read at.
    const fn size(&self) -> u64 {
        match self {
            Self::Loaded(text) => text.len() as u64,
            Self::Unloaded { size, .. } => *size,
        }
    }
}

/// Read an open regular file's contents as text, bounded by
/// [`MAX_TEXT_READ_SIZE`] — the text read behind `diskfile_read`.
///
/// `opened_size` is the handle's size when it was opened (`fstat`): one over
/// the limit isn't read at all. Otherwise the read is sized from it (one past
/// it, to see the end, so the buffer doesn't grow by doubling) and bounded
/// regardless of it, so a file that grew past the limit since is
/// [`UnloadedReason::TooLarge`] after reading at most one byte over.
///
/// The caller opens `file` and checks it's a regular file: `O_NOFOLLOW`, so
/// a symlink swapped in after an `lstat` is refused, and `O_NONBLOCK`, so a
/// FIFO swapped in can't block the open (`ScopedFs::open_file` does both).
/// Blocking — call it on a blocking thread.
///
/// # Errors
///
/// The read's I/O error.
fn read_text_contents(file: std::fs::File, opened_size: u64) -> io::Result<TextContents> {
    use std::io::Read;

    if opened_size > MAX_TEXT_READ_SIZE {
        return Ok(TextContents::Unloaded {
            reason: UnloadedReason::TooLarge,
            size: opened_size,
        });
    }
    let expected = usize::try_from(opened_size).map_err(io::Error::other)?;
    let mut bytes = Vec::with_capacity(expected + 1);
    file.take(MAX_TEXT_READ_SIZE + 1).read_to_end(&mut bytes)?;
    let read = bytes.len() as u64;
    if read > MAX_TEXT_READ_SIZE {
        return Ok(TextContents::Unloaded {
            reason: UnloadedReason::TooLarge,
            size: read.max(opened_size),
        });
    }
    Ok(String::from_utf8(bytes).map_or(
        TextContents::Unloaded {
            reason: UnloadedReason::NotUtf8,
            size: read,
        },
        TextContents::Loaded,
    ))
}

/// Output of `diskfile_read` — twin of `DiskfileReadOutput`.
///
/// `contents` is `null` exactly when `unloaded_reason` isn't. `ctime` and
/// `mtime` are a disknode's: milliseconds since the epoch, `null` when the
/// OS can't say.
#[derive(Serialize, Debug)]
struct DiskfileReadOutput {
    contents: Option<String>,
    unloaded_reason: Option<UnloadedReason>,
    size: u64,
    ctime: Option<f64>,
    mtime: Option<f64>,
}

/// `diskfile_read` — a file's contents as text, with its size and
/// timestamps.
///
/// Any regular file in scope, indexed or not — except one in a protected
/// directory (a credential directory, or a `.zzz` directory other than the
/// app dir), which `ScopedFs` refuses (`protected_dir_not_allowed`) before
/// anything is opened, so the refusal says nothing about whether the file
/// exists.
///
/// One handle serves the whole answer: `ScopedFs::open_file` opens it
/// `O_NOFOLLOW | O_NONBLOCK` and `fstat`s it (regular files only), and the
/// text is read from it by a bounded read ([`read_text_contents`]: at most
/// [`MAX_TEXT_READ_SIZE`] bytes, valid UTF-8, else `contents: null` with the
/// reason). Nothing is cached: every read is of the disk as it is now,
/// whether or not the filer has seen the latest change. The timestamps come
/// from that `fstat`, taken before the read, so a write racing the read
/// leaves them older than the contents, never newer. `size` is the
/// contents' length when they're loaded, so the two always agree.
///
/// Returned as an [`ActionOutput`], so the contents (up to 4 MiB) are
/// serialized once, straight into the response, rather than copied into a
/// `serde_json::Value` first.
///
/// # Errors
///
/// `invalid_params` for a malformed input; otherwise [`scoped_fs_error`]
/// (`path_not_found`, `path_not_allowed`, `protected_dir_not_allowed`,
/// `symlink_not_allowed`, `is_a_directory`, `not_a_regular_file`, …).
pub async fn diskfile_read(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<ActionOutput, JsonrpcError> {
    /// The keys, punctuation, and numbers around the contents.
    const OUTPUT_OVERHEAD: usize = 128;
    const ACTION: &str = "failed to read file";

    let PathInput { path } = parse_strict_params(params)?;
    require_absolute(&path)?;

    let (file, meta) = app
        .scoped_fs
        .open_file(&path)
        .await
        .map_err(|e| scoped_fs_error(ACTION, &e))?;
    let opened_size = meta.len();
    let read = tokio::task::spawn_blocking(move || read_text_contents(file, opened_size))
        .await
        .map_err(|e| internal_error_with_source("diskfile_read", &e))?
        .map_err(|source| {
            scoped_fs_error(
                ACTION,
                &ScopedFsError::Io {
                    path: normalize_path(Path::new(&path))
                        .to_string_lossy()
                        .into_owned(),
                    source,
                },
            )
        })?;

    let size = read.size();
    let size_hint = match &read {
        TextContents::Loaded(text) => text.len(),
        TextContents::Unloaded { .. } => 0,
    } + OUTPUT_OVERHEAD;
    let (contents, unloaded_reason) = match read {
        TextContents::Loaded(text) => (Some(text), None),
        TextContents::Unloaded { reason, .. } => (None, Some(reason)),
    };
    let output = DiskfileReadOutput {
        contents,
        unloaded_reason,
        size,
        ctime: meta.created().ok().and_then(system_time_to_ms),
        mtime: meta.modified().ok().and_then(system_time_to_ms),
    };
    Ok(ActionOutput::serialize(output).with_size_hint(size_hint))
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

/// `directory_create` — create a new directory and any missing parents,
/// never reusing an existing one.
///
/// # Errors
///
/// `invalid_params` for a malformed input; `conflict` (`already_exists`)
/// when the path is taken; otherwise [`scoped_fs_error`].
pub async fn directory_create(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: PathInput = parse_strict_params(params)?;
    require_absolute(&input.path)?;

    app.scoped_fs
        .create_dir(&input.path)
        .await
        .map_err(|e| scoped_fs_error("failed to create directory", &e))?;

    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use fuz_http::JsonrpcErrorCode;
    use serde_json::json;

    use super::*;

    fn io(kind: io::ErrorKind) -> ScopedFsError {
        ScopedFsError::Io {
            path: "/p".to_owned(),
            source: io::Error::from(kind),
        }
    }

    fn reason(error: &JsonrpcError) -> Option<&str> {
        error.data.as_ref()?.get("reason")?.as_str()
    }

    #[test]
    fn text_reads_say_why_they_declined() {
        use std::io::Write as _;

        /// A unique temp dir removed on drop.
        struct TempDir(std::path::PathBuf);
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let tmp =
            TempDir(std::env::temp_dir().join(format!("zzz_text_read_{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(&tmp.0).unwrap();
        let path = |rel: &str| tmp.0.join(rel);

        let max = usize::try_from(MAX_TEXT_READ_SIZE).unwrap();
        std::fs::write(path("ok.txt"), "ok").unwrap();
        std::fs::write(path("empty"), "").unwrap();
        std::fs::write(path("at_limit.txt"), vec![b'x'; max]).unwrap();
        std::fs::write(path("big.txt"), vec![b'x'; max + 10]).unwrap();
        std::fs::write(path("bin"), [0xff, 0xfe]).unwrap();

        let read = |rel: &str| {
            let file = std::fs::File::open(path(rel)).unwrap();
            let size = file.metadata().unwrap().len();
            read_text_contents(file, size).unwrap()
        };
        assert_eq!(read("ok.txt"), TextContents::Loaded("ok".to_owned()));
        assert_eq!(read("empty"), TextContents::Loaded(String::new()));
        let at_limit = read("at_limit.txt");
        assert!(matches!(at_limit, TextContents::Loaded(_)));
        assert_eq!(at_limit.size(), MAX_TEXT_READ_SIZE);
        // over the limit when opened: not read, its size as opened
        assert_eq!(
            read("big.txt"),
            TextContents::Unloaded {
                reason: UnloadedReason::TooLarge,
                size: MAX_TEXT_READ_SIZE + 10,
            }
        );
        assert_eq!(
            read("bin"),
            TextContents::Unloaded {
                reason: UnloadedReason::NotUtf8,
                size: 2,
            }
        );

        // grown past the limit after the open's size was taken: the read
        // stops one byte over and says so
        let mut grown = std::fs::File::create(path("grown.txt")).unwrap();
        grown.write_all(b"x").unwrap();
        let file = std::fs::File::open(path("grown.txt")).unwrap();
        grown.write_all(&vec![b'x'; max + 10]).unwrap();
        assert_eq!(
            read_text_contents(file, 1).unwrap(),
            TextContents::Unloaded {
                reason: UnloadedReason::TooLarge,
                size: MAX_TEXT_READ_SIZE + 1,
            }
        );

        // the wire names
        assert_eq!(
            serde_json::to_value([UnloadedReason::TooLarge, UnloadedReason::NotUtf8]).unwrap(),
            json!(["too_large", "not_utf8"])
        );
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
                ScopedFsError::ProtectedDirNotAllowed {
                    path: "/x".to_owned(),
                    dir: crate::scoped_fs::ProtectedDir::Credentials(".ssh"),
                },
                JsonrpcErrorCode::Forbidden,
                Some(ERROR_PROTECTED_DIR_NOT_ALLOWED),
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
