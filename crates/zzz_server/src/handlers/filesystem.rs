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
use crate::scoped_fs::{ExpectedContent, ScopedFsError, normalize_path};
use crate::transcription::transcript_sidecar_renamed;

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
/// `diskfile_create`, `directory_create`, or `diskfile_rename` found the path
/// taken (`conflict`).
pub const ERROR_ALREADY_EXISTS: &str = "already_exists";
/// A save's in-place fallback found the file replaced or removed externally
/// since it was opened, and wrote nothing (`conflict`).
pub const ERROR_REPLACED_DURING_SAVE: &str = "replaced_during_save";
/// A `diskfile_update` with an `expected_hash` found the file's bytes no
/// longer hashing to it — changed, grown past the read limit, or gone — and
/// wrote nothing (`conflict`).
pub const ERROR_DISK_CHANGED: &str = "disk_changed";
/// An append found the file at a different size than the expected offset,
/// and wrote nothing (`conflict`).
pub const ERROR_OFFSET_MISMATCH: &str = "offset_mismatch";
/// A rename found a job (a transcription) working on the file, or on the
/// path it would take (`conflict`).
pub const ERROR_JOB_ON_FILE: &str = "job_on_file";
/// A rename the filesystem can't do safely — no hard links for its
/// sidecars, as on FAT or exFAT, or no `RENAME_NOREPLACE`, as on some FUSE
/// and NFS — refused, nothing moved (`conflict`).
pub const ERROR_RENAME_UNSUPPORTED: &str = "rename_unsupported";
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
/// and `project_open` of one.
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
/// - `diskfile_create` / `directory_create` over an existing path, a save
///   whose file was replaced mid-save or no longer holds the bytes it
///   expected, or an append at the wrong offset → `conflict` (-32004)
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
        ScopedFsError::DiskChanged(_) => conflict(&message, Some(ERROR_DISK_CHANGED)),
        ScopedFsError::OffsetMismatch { .. } => conflict(&message, Some(ERROR_OFFSET_MISMATCH)),
        ScopedFsError::RenameUnsupported(_) => conflict(&message, Some(ERROR_RENAME_UNSUPPORTED)),
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

/// Input for `diskfile_update` — twin of `DiskfileUpdateInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskfileUpdateInput {
    path: String,
    content: String,
    /// The `hash` of the `diskfile_read` the edit is based on: when present,
    /// the save writes only if the file still holds those bytes. Absent, it
    /// writes whatever is there (recreating a deleted file, or forcing a
    /// write the client can't base on a read).
    #[serde(default, deserialize_with = "crate::handlers::present")]
    expected_hash: Option<String>,
}

/// Output of `diskfile_update` — twin of `DiskfileUpdateOutput`.
#[derive(Serialize, Debug)]
struct DiskfileUpdateOutput {
    /// [`content_hash_hex`] of the bytes written — the base of the caller's
    /// next save, with no read in between.
    hash: String,
}

/// Input for `diskfile_rename` — twin of `DiskfileRenameInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskfileRenameInput {
    path: String,
    name: String,
}

/// A file `diskfile_rename` moved — twin of `DiskfileRenamed`.
#[derive(Serialize)]
struct DiskfileRenamed {
    path: String,
    new_path: String,
}

/// Output of `diskfile_rename` — twin of `DiskfileRenameOutput`.
#[derive(Serialize)]
struct DiskfileRenameOutput {
    renamed: Vec<DiskfileRenamed>,
}

/// Input for `diskfile_create` — twin of `DiskfileCreateInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskfileCreateInput {
    path: String,
    content: String,
}

/// A file's content hash on the wire: BLAKE3, bare 64 lowercase hex (a
/// content digest, not a fact address — so no `blake3:` prefix). The `hash`
/// of `diskfile_read` and `diskfile_update`, and the `expected_hash` a save
/// sends back.
fn content_hash_hex(hash: &blake3::Hash) -> String {
    hash.to_hex().to_string()
}

/// Parse an `expected_hash`: exactly 64 lowercase hex characters, else
/// `None` — never case-folded (`blake3::Hash::from_hex` alone would take
/// uppercase).
///
/// The grammar of `fuz_crypto`'s `blake3_hex` adapter
/// (`ContentHash::from_lower_hex`), kept local because using it would make
/// `fuz_crypto` a direct dependency and add a conversion to `blake3::Hash`.
fn parse_content_hash(hex: &str) -> Option<blake3::Hash> {
    let well_formed = hex.len() == 64
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if well_formed {
        blake3::Hash::from_hex(hex).ok()
    } else {
        None
    }
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

    /// BLAKE3 of the loaded text's bytes — exactly the bytes read — and
    /// `None` for a file not loaded (one too large isn't read at all).
    fn hash(&self) -> Option<blake3::Hash> {
        match self {
            Self::Loaded(text) => Some(blake3::hash(text.as_bytes())),
            Self::Unloaded { .. } => None,
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
/// `contents` is `null` exactly when `unloaded_reason` isn't, and `hash` is
/// `null` with it — a file that isn't loaded can't be edited, so no save is
/// based on it, and one too large isn't read at all. `ctime` and `mtime` are
/// a disknode's: milliseconds since the epoch, `null` when the OS can't say.
#[derive(Serialize, Debug)]
struct DiskfileReadOutput {
    contents: Option<String>,
    unloaded_reason: Option<UnloadedReason>,
    /// [`content_hash_hex`] of the bytes read — the `contents`, exactly.
    hash: Option<String>,
    size: u64,
    ctime: Option<u64>,
    mtime: Option<u64>,
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
/// contents' length when they're loaded, so the two always agree, and
/// `hash` is the BLAKE3 of the same bytes — what a save based on these
/// contents sends back as its `expected_hash` (`diskfile_update`).
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
    /// The keys, punctuation, numbers, and hash around the contents.
    const OUTPUT_OVERHEAD: usize = 256;
    const ACTION: &str = "failed to read file";

    let PathInput { path } = parse_strict_params(params)?;
    require_absolute(&path)?;

    let (file, meta) = app
        .scoped_fs
        .open_file(&path)
        .await
        .map_err(|e| scoped_fs_error(ACTION, &e))?;
    let opened_size = meta.len();
    let (read, hash) = tokio::task::spawn_blocking(move || {
        read_text_contents(file, opened_size).map(|read| {
            let hash = read.hash();
            (read, hash)
        })
    })
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
        hash: hash.as_ref().map(content_hash_hex),
        size,
        ctime: meta.created().ok().and_then(system_time_to_ms),
        mtime: meta.modified().ok().and_then(system_time_to_ms),
    };
    Ok(ActionOutput::serialize(output).with_size_hint(size_hint))
}

/// `diskfile_update` — atomically replace (or create) a file, returning the
/// `hash` of the bytes written.
///
/// With an `expected_hash` (the `hash` of the `diskfile_read` the edit is
/// based on), it's a compare-and-swap: the file must still be there, at most
/// [`MAX_TEXT_READ_SIZE`] bytes (the largest a read returns as text), and
/// hashing to it — compared after the content is staged, right before the
/// rename ([`ScopedFs::write_file`](crate::scoped_fs::ScopedFs::write_file))
/// — or nothing is written and it fails `conflict` / `disk_changed`. So a
/// write by another process or tab since the caller's read is never
/// replaced unseen, whether or not the filer has reported it yet; one
/// landing between the compare and the rename still is. Without it the save
/// writes whatever is there.
///
/// The hash of the content is taken on the request's task: it's at most a
/// JSON-RPC message's worth of bytes, which the spine has already parsed on
/// the same task.
///
/// # Errors
///
/// `invalid_params` for a malformed input — an `expected_hash` that isn't 64
/// lowercase hex characters included; `conflict` / `disk_changed` as above;
/// otherwise [`scoped_fs_error`].
pub async fn diskfile_update(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: DiskfileUpdateInput = parse_strict_params(params)?;
    require_absolute(&input.path)?;
    let expected = match input.expected_hash.as_deref() {
        None => None,
        Some(hex) => Some(ExpectedContent {
            hash: parse_content_hash(hex).ok_or_else(|| {
                invalid_params(
                    "expected_hash must be 64 lowercase hex characters (a BLAKE3 hash)",
                    None,
                )
            })?,
            max_size: MAX_TEXT_READ_SIZE,
        }),
    };

    let hash = blake3::hash(input.content.as_bytes());
    app.scoped_fs
        .write_file(&input.path, input.content, expected)
        .await
        .map_err(|e| scoped_fs_error("failed to write file", &e))?;

    let output = DiskfileUpdateOutput {
        hash: content_hash_hex(&hash),
    };
    serde_json::to_value(output).map_err(|e| internal_error_with_source("diskfile_update", &e))
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
    let input: DiskfileCreateInput = parse_strict_params(params)?;
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

/// `diskfile_rename` — rename a file within its directory, carrying each
/// transcript sidecar named for it ([`transcript_sidecar_renamed`]), never
/// replacing anything ([`crate::scoped_fs::PreparedRename::apply`]).
///
/// Refused while a job works on the file: a transcription writes its sidecar
/// under the name it was given, so it would be cut off. The check and the
/// rename run under the job table's lock
/// ([`crate::job_manager::JobManager::without_job_on`]), so
/// no job is submitted on the file between them.
///
/// # Errors
///
/// `invalid_params` for a malformed input, a `name` that isn't one plain
/// path component or is the file's own, or a directory; `conflict`
/// (`already_exists`) when the new name, or a sidecar's, is taken;
/// `conflict` (`job_on_file`) while a job works on the file or its new path
/// (a job whose file was deleted would write its sidecar there);
/// `conflict` (`rename_unsupported`) on a filesystem that can't do it
/// safely; otherwise [`scoped_fs_error`].
pub async fn diskfile_rename(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: DiskfileRenameInput = parse_strict_params(params)?;
    require_absolute(&input.path)?;

    let prepared = app
        .scoped_fs
        .prepare_rename(&input.path, &input.name)
        .await
        .map_err(|e| scoped_fs_error("failed to rename file", &e))?;
    let old_name = prepared
        .from()
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let new_name = input.name;
    let jobs = app.job_manager.clone();
    let renamed = tokio::task::spawn_blocking(move || {
        let paths = [prepared.from().to_path_buf(), prepared.to().to_path_buf()];
        jobs.without_job_on(&paths, move || {
            prepared.apply(|name| transcript_sidecar_renamed(name, &old_name, &new_name))
        })
    })
    .await
    .map_err(|e| internal_error_with_source("diskfile_rename", &e))?
    .map_err(|busy| {
        conflict(
            &format!("failed to rename file: {busy}"),
            Some(ERROR_JOB_ON_FILE),
        )
    })?
    .map_err(|e| scoped_fs_error("failed to rename file", &e))?;

    let output = DiskfileRenameOutput {
        renamed: renamed
            .into_iter()
            .map(|r| DiskfileRenamed {
                path: r.from.to_string_lossy().into_owned(),
                new_path: r.to.to_string_lossy().into_owned(),
            })
            .collect(),
    };
    serde_json::to_value(output).map_err(|e| internal_error_with_source("diskfile_rename", &e))
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
        assert_eq!(read("ok.txt").hash(), Some(blake3::hash(b"ok")));
        assert_eq!(read("empty"), TextContents::Loaded(String::new()));
        assert_eq!(read("empty").hash(), Some(blake3::hash(b"")));
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
        // nothing loaded, nothing to base a save on
        assert_eq!(read("bin").hash(), None);
        assert_eq!(read("big.txt").hash(), None);

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
                ScopedFsError::DiskChanged("/x".to_owned()),
                JsonrpcErrorCode::Conflict,
                Some(ERROR_DISK_CHANGED),
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
        let ok: DiskfileUpdateInput =
            parse_strict_params(json!({"path": "/a", "content": ""})).unwrap();
        assert_eq!(ok.path, "/a");
        assert_eq!(ok.expected_hash, None);
        let hex = "ab".repeat(32);
        let ok: DiskfileUpdateInput =
            parse_strict_params(json!({"path": "/a", "content": "", "expected_hash": hex}))
                .unwrap();
        assert_eq!(ok.expected_hash.as_deref(), Some(hex.as_str()));
        for params in [
            json!({"path": "/a", "content": "", "extra": 1}),
            json!({"path": "/a", "content": null}),
            json!({"path": "/a"}),
            json!({"path": 1, "content": ""}),
            // a TS `optional` field: absent, never `null`
            json!({"path": "/a", "content": "", "expected_hash": null}),
            json!({"path": "/a", "content": "", "expected_hash": 1}),
        ] {
            let e = parse_strict_params::<DiskfileUpdateInput>(params.clone())
                .err()
                .unwrap_or_else(|| panic!("accepted {params}"));
            assert_eq!(e.code, JsonrpcErrorCode::InvalidParams, "{params}");
        }
        // create takes no compare
        assert!(
            parse_strict_params::<DiskfileCreateInput>(
                json!({"path": "/a", "content": "", "expected_hash": hex})
            )
            .is_err()
        );
        for params in [
            json!({"path": "/a", "recursive": true}),
            json!({"path": null}),
        ] {
            assert!(parse_strict_params::<PathInput>(params).is_err());
        }
    }

    #[test]
    fn content_hashes_are_bare_lowercase_hex() {
        // BLAKE3 of the empty input, the published test vector
        let empty = "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
        assert_eq!(content_hash_hex(&blake3::hash(b"")), empty);
        assert_eq!(parse_content_hash(empty), Some(blake3::hash(b"")));
        let hash = blake3::hash("héllo".as_bytes());
        assert_eq!(parse_content_hash(&content_hash_hex(&hash)), Some(hash));

        // refused, never folded or trimmed
        for off_form in [
            empty.to_uppercase(),
            format!("blake3:{empty}"),
            format!("{empty} "),
            format!("{empty}0"),
            empty[..63].to_owned(),
            format!("{}g", &empty[..63]),
            String::new(),
        ] {
            assert_eq!(parse_content_hash(&off_form), None, "{off_form:?}");
        }
    }
}
