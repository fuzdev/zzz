use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use parking_lot::RwLock;

/// Name prefix of the temp files [`ScopedFs::write_file`] stages writes in.
///
/// Staged beside the target, hidden, and ignored by the filer (see
/// [`is_temp_file_name`]) so a staged write is never indexed or broadcast —
/// only the rename that publishes it is.
pub const TEMP_FILE_PREFIX: &str = ".zzz-tmp-";

/// Whether `name` (a single path component) is one of
/// [`ScopedFs::write_file`]'s staging files.
pub fn is_temp_file_name(name: &str) -> bool {
    name.starts_with(TEMP_FILE_PREFIX)
}

/// How old a staging file must be before the filer's walk deletes it as
/// orphaned (left behind by a crash mid-write). A live write finishes in
/// well under this.
pub const ORPHANED_TEMP_FILE_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Whether `name` is exactly a staging-file name [`ScopedFs::write_file`] generates.
///
/// That's [`TEMP_FILE_PREFIX`] + a UUID's 32 lowercase hex digits, so the
/// orphan sweep never matches a user's own `.zzz-tmp-*` file.
pub fn is_staged_write_file_name(name: &str) -> bool {
    name.strip_prefix(TEMP_FILE_PREFIX).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// Normalize a path to a UTF-8 string with a single trailing slash.
///
/// Centralized so [`ScopedFs::new`], [`ScopedFs::add_path`], and
/// [`ScopedFs::remove_path`] all share the same shape — every root is
/// `<utf8>/`.
fn to_normalized_string(path: &Path) -> String {
    let mut s = path.to_string_lossy().into_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

// -- Errors -------------------------------------------------------------------

/// Errors from scoped filesystem operations.
///
/// The variants split by who is at fault, so handlers can map them to
/// distinct JSON-RPC codes: a malformed request, a policy refusal, the wrong
/// kind of file, or an I/O failure (classified by its `ErrorKind`).
#[derive(Debug, thiserror::Error)]
pub enum ScopedFsError {
    /// Not an absolute path, or contains a NUL byte.
    #[error("Path is invalid: {0}")]
    InvalidPath(String),
    /// Outside every allowed root.
    #[error("Path is not allowed: {0}")]
    PathNotAllowed(String),
    #[error("Path is a symlink which is not allowed: {0}")]
    SymlinkNotAllowed(String),
    /// A write targeted an existing directory.
    #[error("Path is a directory: {0}")]
    IsADirectory(String),
    /// A write targeted an existing FIFO, socket, or device node — never
    /// opened (a FIFO would block the write forever) and never replaced.
    #[error("Path is not a regular file: {0}")]
    NotARegularFile(String),
    /// A new file can't be created because its directory isn't writable.
    #[error("Directory is not writable, can't create: {0}")]
    DirectoryNotWritable(String),
    /// A create-only write found the path taken.
    #[error("Path already exists: {0}")]
    AlreadyExists(String),
    /// The in-place fallback found the path no longer names the file it
    /// opened — replaced or removed externally mid-save — so it wrote
    /// nothing rather than into an unlinked inode.
    #[error("Path was replaced during the save: {0}")]
    ReplacedDuringSave(String),
    #[error("{source}: {path}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

impl ScopedFsError {
    fn display(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn io(path: &Path, source: std::io::Error) -> Self {
        Self::Io {
            path: path.to_string_lossy().into_owned(),
            source,
        }
    }
}

// -- ScopedFs -----------------------------------------------------------------

/// Scoping wrapper around filesystem operations.
///
/// Restricts all operations to the currently-allowed directories. Rejects
/// relative paths, path traversal, and symlinks.
///
/// The allowed set is a fixed set of permanent roots (`zzz_dir` +
/// `scoped_dirs`, from [`Self::new`]) plus runtime roots for open workspaces
/// ([`Self::add_path`] / [`Self::remove_path`]). A path is allowed when any
/// root covers it, so overlapping roots compose: removing a runtime root never
/// revokes access a permanent root or another runtime root still grants.
///
/// **Not a confinement boundary against an authenticated caller.** The allowed
/// set is *mutable at runtime* via [`Self::add_path`], and `workspace_open`
/// (gated only at `AuthSpec::authenticated(CredentialGate::Any)` — any
/// credential, no role) calls it with a caller-supplied
/// directory without consulting the existing allowlist. So any authenticated
/// caller can widen the scope to an arbitrary existing directory and then write
/// beneath it. Read this type as a guard against accidental or buggy writes
/// outside the open workspaces — not as a sandbox. That is consistent with zzz's
/// posture (an authenticated zzz credential carries local-user authority
/// regardless — see the `terminal_*` actions), but don't mistake the type for a
/// stronger guarantee than it makes.
///
/// NOTE: There is an inherent TOCTOU gap between the symlink check (`lstat`)
/// and the caller's subsequent filesystem operation. A symlink could be
/// created after validation.
pub struct ScopedFs {
    /// Roots fixed at construction (`zzz_dir` + `scoped_dirs`), each
    /// normalized with a trailing `/`. Never removed —
    /// [`Self::remove_path`] only touches [`Self::dynamic_paths`], so
    /// closing a workspace opened on (or containing, or nested in) a
    /// permanent root can't revoke access that root grants.
    ///
    /// Stored as `String` (not `PathBuf`) so `is_path_allowed` doesn't
    /// re-run `to_string_lossy()` on every allowed entry on every fs
    /// operation — the lossy conversion happens once at insert time.
    permanent_paths: Vec<String>,
    /// Roots added at runtime (open workspaces), same normalization. One
    /// entry per root: the caller (`workspace_open` / `workspace_close`,
    /// serialized by `App::workspace_lifecycle`) keeps these in lockstep
    /// with its own one-entry-per-path map, so no refcount is needed —
    /// overlapping roots are separate entries, and removing one leaves any
    /// other root that covers the same paths in place.
    dynamic_paths: RwLock<Vec<String>>,
}

impl ScopedFs {
    /// Create a new `ScopedFs` with the given permanent directory roots.
    ///
    /// Each path is normalized with a trailing `/` and must be absolute.
    /// These roots are never removed by [`Self::remove_path`].
    pub fn new(paths: Vec<PathBuf>) -> Self {
        let mut permanent_paths: Vec<String> = Vec::with_capacity(paths.len());
        for normalized in paths.into_iter().map(|p| to_normalized_string(&p)) {
            if !permanent_paths.contains(&normalized) {
                permanent_paths.push(normalized);
            }
        }
        Self {
            permanent_paths,
            dynamic_paths: RwLock::new(Vec::new()),
        }
    }

    /// Add a runtime root to the allowed set.
    ///
    /// Returns `false` (no-op) if the exact root is already present, as a
    /// permanent or a runtime root.
    pub fn add_path(&self, path: &Path) -> bool {
        let normalized = to_normalized_string(path);
        if self.permanent_paths.contains(&normalized) {
            return false;
        }
        let mut paths = self.dynamic_paths.write();
        if paths.contains(&normalized) {
            return false;
        }
        paths.push(normalized);
        true
    }

    /// Remove a runtime root from the allowed set.
    ///
    /// Permanent roots are never removed, and paths still covered by another
    /// root (permanent or runtime) stay allowed. Returns `true` if a runtime
    /// root was removed.
    pub fn remove_path(&self, path: &Path) -> bool {
        let normalized = to_normalized_string(path);
        let mut paths = self.dynamic_paths.write();
        if let Some(index) = paths.iter().position(|p| p == &normalized) {
            paths.remove(index);
            true
        } else {
            false
        }
    }

    /// Check if a path falls under one of the allowed directories.
    fn is_path_allowed(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy();
        if self
            .permanent_paths
            .iter()
            .any(|allowed| is_under_root(&path_str, allowed))
        {
            return true;
        }
        self.dynamic_paths
            .read()
            .iter()
            .any(|allowed| is_under_root(&path_str, allowed))
    }

    /// Validate and normalize a path for safe filesystem access.
    ///
    /// - Rejects relative paths and null bytes
    /// - Normalizes path components (resolves `.` and `..`)
    /// - Checks against allowed directories
    /// - Rejects symlinks (target and all parent directories)
    async fn ensure_safe_path(&self, path: &str) -> Result<PathBuf, ScopedFsError> {
        // Reject null bytes
        if path.contains('\0') {
            return Err(ScopedFsError::InvalidPath(path.to_owned()));
        }

        // Must be absolute
        let raw = Path::new(path);
        if !raw.is_absolute() {
            return Err(ScopedFsError::InvalidPath(path.to_owned()));
        }

        // Normalize path (resolve . and .. without touching the filesystem)
        let normalized = normalize_path(raw);

        // Check against allowed paths
        if !self.is_path_allowed(&normalized) {
            return Err(ScopedFsError::PathNotAllowed(
                normalized.to_string_lossy().into_owned(),
            ));
        }

        // Check the target path for symlinks if it exists
        match tokio::fs::symlink_metadata(&normalized).await {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(ScopedFsError::SymlinkNotAllowed(
                        normalized.to_string_lossy().into_owned(),
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // File doesn't exist yet — that's fine for write/mkdir
            }
            Err(e) => return Err(ScopedFsError::io(&normalized, e)),
        }

        // Check all parent directories for symlinks
        let mut current = normalized.as_path();
        while let Some(parent) = current.parent() {
            if parent == Path::new("/") || parent == current {
                break;
            }
            match tokio::fs::symlink_metadata(parent).await {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err(ScopedFsError::SymlinkNotAllowed(
                            parent.to_string_lossy().into_owned(),
                        ));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Parent doesn't exist — will fail at the actual operation
                }
                Err(e) => return Err(ScopedFsError::io(parent, e)),
            }
            current = parent;
        }

        Ok(normalized)
    }

    /// Write `content` to a file, creating parent directories if needed.
    ///
    /// The write is atomic: see [`write_file_atomic`]. Concurrent writes to
    /// the same path never interleave — each stages its own temp file, and
    /// the last rename wins — so no per-path lock is needed.
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation;
    /// [`ScopedFsError::IsADirectory`] / [`ScopedFsError::NotARegularFile`]
    /// for an existing target that isn't a regular file; otherwise
    /// [`ScopedFsError::Io`].
    pub async fn write_file(&self, path: &str, content: String) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        if let Some(parent) = safe_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ScopedFsError::io(parent, e))?;
        }
        // Blocking std I/O on a blocking thread: the write + fsync can take a
        // while, and the task finishes (renaming or cleaning up its temp
        // file) even if the request is dropped mid-write.
        tokio::task::spawn_blocking(move || {
            write_file_atomic_with(&safe_path, |file| file.write_all(content.as_bytes()))
        })
        .await
        .map_err(|e| ScopedFsError::io(Path::new(path), std::io::Error::other(e)))?
    }

    /// Create a new file holding `content`, creating parent directories if
    /// needed — never replacing an existing one.
    ///
    /// The final name is created `O_CREAT | O_EXCL | O_NOFOLLOW`, so the check
    /// and the create are one step: an existing file (or symlink, or anything
    /// else at the path) fails with [`ScopedFsError::AlreadyExists`] and is
    /// left untouched. Not staged like [`Self::write_file`] — a failed write
    /// removes the file it just created, and there's no old content to lose.
    /// A new file gets `0o666` minus the umask.
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation;
    /// [`ScopedFsError::AlreadyExists`]; [`ScopedFsError::DirectoryNotWritable`];
    /// otherwise [`ScopedFsError::Io`].
    pub async fn create_file(&self, path: &str, content: String) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        if let Some(parent) = safe_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ScopedFsError::io(parent, e))?;
        }
        tokio::task::spawn_blocking(move || create_file_exclusive(&safe_path, content.as_bytes()))
            .await
            .map_err(|e| ScopedFsError::io(Path::new(path), std::io::Error::other(e)))?
    }

    /// Remove a file.
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation, otherwise
    /// [`ScopedFsError::Io`] (e.g. `NotFound`, or `IsADirectory` for a
    /// directory).
    pub async fn rm(&self, path: &str) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        tokio::fs::remove_file(&safe_path)
            .await
            .map_err(|e| ScopedFsError::io(&safe_path, e))
    }

    /// Create a directory (recursive). Succeeds if it already exists.
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation, otherwise
    /// [`ScopedFsError::Io`] (e.g. `AlreadyExists` when the path is a file,
    /// `NotADirectory` when an ancestor is).
    pub async fn mkdir(&self, path: &str) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        tokio::fs::create_dir_all(&safe_path)
            .await
            .map_err(|e| ScopedFsError::io(&safe_path, e))
    }
}

// -- Atomic writes ------------------------------------------------------------

/// Replace the file at `path` with what `write` writes — atomically when the
/// directory allows it, in place otherwise.
///
/// **Atomic path.** Stages the content in a new temp file beside `path`
/// (named [`TEMP_FILE_PREFIX`] + a random UUID, created `O_EXCL |
/// O_NOFOLLOW`), fsyncs it, renames it over `path`, then fsyncs the directory
/// (best-effort). So a failed write — `ENOSPC`, `EFBIG`, a crash — leaves the
/// old file untouched (the temp file is removed on error; one orphaned by a
/// crash is swept by the filer, see [`is_staged_write_file_name`]), a
/// concurrent reader or the filer never sees partial content, and concurrent
/// writers can't interleave. The replacement keeps the old file's permission
/// bits (including setuid/setgid/sticky) and, best-effort, its owner and
/// group — `fchown` only succeeds when the daemon may give the file that
/// ownership. It is a new inode: **hardlinks are broken** (the other names
/// keep the old content), and extended attributes and ACLs are not carried
/// over. A new file gets `0o666` minus the umask, like `std::fs::write`.
///
/// **Permission.** An existing target must be writable by the daemon —
/// checked by opening it for writing (no `O_CREAT`, no `O_TRUNC`, so nothing
/// changes), since a rename needs only the directory's write permission and
/// would otherwise replace a read-only file. Refused with a `PermissionDenied`
/// [`ScopedFsError::Io`].
///
/// **In-place fallback (not atomic).** When an existing, writable target
/// can't be replaced by rename — its directory isn't writable (no temp file
/// can be created), or the rename fails with `EBUSY` (a bind-mounted file),
/// `EXDEV`, or `EPERM` (a sticky directory the daemon doesn't own) — the
/// content is written into the file itself: truncate, write, fsync, through
/// the handle the permission check opened (`O_NOFOLLOW | O_NONBLOCK`,
/// re-checked to be a regular file). That's what a plain write always did:
/// a failure midway leaves the file truncated or partial, a reader can see
/// it mid-write, but the inode, mode, owner, and hardlinks are kept. A new
/// file in a non-writable directory fails with
/// [`ScopedFsError::DirectoryNotWritable`].
///
/// An existing target must be a regular file: a directory, FIFO, socket, or
/// device node is refused before anything is opened (a FIFO would otherwise
/// block the write until a reader appears). A symlink is refused too — the
/// caller's `ensure_safe_path` already did, this closes the gap since.
/// Errors name `path`, never the temp file.
///
/// `write` is called once on the atomic path, and again on the in-place
/// fallback if a rename failure sends it there.
fn write_file_atomic_with(
    path: &Path,
    write: impl Fn(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<(), ScopedFsError> {
    let existing = existing_regular_file(path)?;
    let target = match &existing {
        Some(_) => Some(open_for_write_in_place(path)?),
        None => None,
    };

    let dir = path
        .parent()
        .ok_or_else(|| ScopedFsError::InvalidPath(ScopedFsError::display(path)))?;
    let temp_path = dir.join(format!(
        "{TEMP_FILE_PREFIX}{}",
        uuid::Uuid::new_v4().simple()
    ));
    let mut temp = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        // an existing file's exact mode is applied below; `0o600` keeps the
        // staged content private until then
        .mode(if existing.is_some() { 0o600 } else { 0o666 })
        .open(&temp_path)
    {
        Ok(temp) => temp,
        Err(e) if is_not_writable(&e) => {
            return target.map_or_else(
                || {
                    Err(ScopedFsError::DirectoryNotWritable(ScopedFsError::display(
                        path,
                    )))
                },
                |target| write_in_place(target, &write, path),
            );
        }
        Err(e) => return Err(ScopedFsError::io(path, e)),
    };

    let staged = stage(&mut temp, existing.as_ref(), &write);
    drop(temp);
    if let Err(e) = staged {
        remove_temp_file(&temp_path);
        return Err(ScopedFsError::io(path, e));
    }
    if let Err(e) = std::fs::rename(&temp_path, path) {
        remove_temp_file(&temp_path);
        return match target {
            Some(target) if is_rename_refused(&e) => write_in_place(target, &write, path),
            _ => Err(ScopedFsError::io(path, e)),
        };
    }

    // Persist the rename itself. The new content is already durable and in
    // place, so a failure here is logged rather than failing the write.
    if let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all()) {
        tracing::debug!(dir = %dir.display(), error = %e, "failed to fsync directory after write");
    }
    Ok(())
}

/// `lstat` the write target: `None` when it doesn't exist, its metadata when
/// it's a regular file, an error for anything else.
fn existing_regular_file(path: &Path) -> Result<Option<std::fs::Metadata>, ScopedFsError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            let file_type = meta.file_type();
            if file_type.is_symlink() {
                return Err(ScopedFsError::SymlinkNotAllowed(ScopedFsError::display(
                    path,
                )));
            }
            if file_type.is_dir() {
                return Err(ScopedFsError::IsADirectory(ScopedFsError::display(path)));
            }
            if !file_type.is_file() {
                return Err(ScopedFsError::NotARegularFile(ScopedFsError::display(path)));
            }
            Ok(Some(meta))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ScopedFsError::io(path, e)),
    }
}

/// Open an existing target for writing without changing it — the
/// writability check, and the handle an in-place write uses. `O_NOFOLLOW`
/// and `O_NONBLOCK` guard against a symlink or FIFO swapped in since the
/// `lstat`, and the handle is re-checked to be a regular file.
fn open_for_write_in_place(path: &Path) -> Result<std::fs::File, ScopedFsError> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| {
            if e.raw_os_error() == Some(libc::ELOOP) {
                ScopedFsError::SymlinkNotAllowed(ScopedFsError::display(path))
            } else {
                ScopedFsError::io(path, e)
            }
        })?;
    let is_file = file
        .metadata()
        .map_err(|e| ScopedFsError::io(path, e))?
        .is_file();
    if !is_file {
        return Err(ScopedFsError::NotARegularFile(ScopedFsError::display(path)));
    }
    Ok(file)
}

/// The non-atomic fallback: truncate `file`, write, fsync.
///
/// First checks that `path` still names `file` (see [`is_still_at`]): if the
/// file was replaced or removed since it was opened — e.g. between the open
/// and a failed rename — writing would land in an inode nobody can reach and
/// still report success, so it fails with
/// [`ScopedFsError::ReplacedDuringSave`] instead.
fn write_in_place(
    mut file: std::fs::File,
    write: &impl Fn(&mut std::fs::File) -> std::io::Result<()>,
    path: &Path,
) -> Result<(), ScopedFsError> {
    if !is_still_at(&file, path).map_err(|e| ScopedFsError::io(path, e))? {
        return Err(ScopedFsError::ReplacedDuringSave(ScopedFsError::display(
            path,
        )));
    }
    tracing::debug!(path = %path.display(), "writing in place, not atomically");
    file.set_len(0)
        .and_then(|()| write(&mut file))
        .and_then(|()| file.sync_all())
        .map_err(|e| ScopedFsError::io(path, e))
}

/// Whether `path` still names `file`: the handle's `(dev, ino)` (`fstat`)
/// matches a fresh `lstat` of the path. `Ok(false)` when the path is gone.
fn is_still_at(file: &std::fs::File, path: &Path) -> std::io::Result<bool> {
    let opened = file.metadata()?;
    match std::fs::symlink_metadata(path) {
        Ok(current) => Ok(opened.dev() == current.dev() && opened.ino() == current.ino()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Whether creating a file failed for lack of write permission on its
/// directory (or a read-only filesystem).
fn is_not_writable(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem
    )
}

/// Whether a rename over the target was refused in a way an in-place write
/// can still get around: `EBUSY` (the target is a mount point, e.g. a
/// bind-mounted file), `EXDEV`, `EPERM` (a sticky directory).
fn is_rename_refused(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::EBUSY | libc::EXDEV | libc::EPERM)
    )
}

fn remove_temp_file(temp_path: &Path) {
    if let Err(e) = std::fs::remove_file(temp_path) {
        tracing::warn!(path = %temp_path.display(), error = %e, "failed to remove temp file");
    }
}

/// Fill the staged temp file: carry over the replaced file's ownership and
/// mode, write, fsync.
fn stage(
    file: &mut std::fs::File,
    existing: Option<&std::fs::Metadata>,
    write: &impl Fn(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    if let Some(meta) = existing {
        preserve_ownership(file, meta);
        // after the chown, which can clear setuid/setgid
        file.set_permissions(std::fs::Permissions::from_mode(meta.mode() & 0o7777))?;
    }
    write(file)?;
    file.sync_all()
}

/// Give the staged file `meta`'s owner and group, falling back to the group
/// alone. Best-effort: without the privilege the staged file keeps the
/// daemon's ownership.
fn preserve_ownership(file: &std::fs::File, meta: &std::fs::Metadata) {
    if std::os::unix::fs::fchown(file, Some(meta.uid()), Some(meta.gid())).is_ok() {
        return;
    }
    if let Err(e) = std::os::unix::fs::fchown(file, None, Some(meta.gid())) {
        tracing::debug!(error = %e, "could not preserve the replaced file's group");
    }
}

/// Create `path` exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`) holding
/// `content`, fsyncing it and (best-effort) its directory. See
/// [`ScopedFs::create_file`].
fn create_file_exclusive(path: &Path, content: &[u8]) -> Result<(), ScopedFsError> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o666)
        .open(path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                ScopedFsError::AlreadyExists(ScopedFsError::display(path))
            }
            _ if is_not_writable(&e) => {
                ScopedFsError::DirectoryNotWritable(ScopedFsError::display(path))
            }
            _ => ScopedFsError::io(path, e),
        })?;
    if let Err(e) = file.write_all(content).and_then(|()| file.sync_all()) {
        drop(file);
        // ours — created just above, so nothing else is lost
        if let Err(cleanup) = std::fs::remove_file(path) {
            tracing::warn!(path = %path.display(), error = %cleanup, "failed to remove a partly written new file");
        }
        return Err(ScopedFsError::io(path, e));
    }
    if let Some(dir) = path.parent()
        && let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all())
    {
        tracing::debug!(dir = %dir.display(), error = %e, "failed to fsync directory after create");
    }
    Ok(())
}

/// Whether `path` is `root` itself or beneath it.
///
/// `root` always ends in `/` (normalized at insert): `starts_with` covers
/// files and subdirectories, and the bare-directory case matches when `path`
/// equals `root` minus its trailing slash.
fn is_under_root(path: &str, root: &str) -> bool {
    path.starts_with(root)
        || root
            .strip_suffix('/')
            .is_some_and(|trimmed| path == trimmed)
}

/// Normalize a path by resolving `.` and `..` components without filesystem access.
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {} // skip .
            Component::ParentDir => {
                // Pop the last normal component (don't go above root)
                if let Some(Component::Normal(_)) = components.last() {
                    components.pop();
                }
            }
            c => components.push(c),
        }
    }
    components.iter().collect()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::FileTypeExt;

    use super::*;

    fn scoped(paths: &[&str]) -> ScopedFs {
        ScopedFs::new(paths.iter().map(PathBuf::from).collect())
    }

    fn allowed(fs: &ScopedFs, path: &str) -> bool {
        fs.is_path_allowed(Path::new(path))
    }

    #[test]
    fn root_itself_and_descendants_are_allowed() {
        let fs = scoped(&["/z/zzz"]);
        assert!(allowed(&fs, "/z/zzz"));
        assert!(allowed(&fs, "/z/zzz/a.txt"));
        assert!(allowed(&fs, "/z/zzz/sub/b.txt"));
        assert!(
            !allowed(&fs, "/z/zzz_sibling/a.txt"),
            "prefix is per component"
        );
        assert!(!allowed(&fs, "/z/a.txt"));
    }

    #[test]
    fn permanent_root_survives_remove_path() {
        let fs = scoped(&["/z/zzz/", "/z/scoped"]);
        // a workspace opened on a permanent root is a no-op add, and its close
        // must not revoke the root
        assert!(!fs.add_path(Path::new("/z/zzz")));
        assert!(!fs.remove_path(Path::new("/z/zzz")));
        assert!(!fs.remove_path(Path::new("/z/zzz/")));
        assert!(!fs.remove_path(Path::new("/z/scoped")));
        assert!(allowed(&fs, "/z/zzz/a.txt"));
        assert!(allowed(&fs, "/z/scoped/a.txt"));
    }

    #[test]
    fn runtime_root_add_and_remove() {
        let fs = scoped(&["/z/zzz"]);
        assert!(!allowed(&fs, "/w/a.txt"));
        assert!(fs.add_path(Path::new("/w")));
        assert!(!fs.add_path(Path::new("/w/")), "trailing slash normalizes");
        assert!(allowed(&fs, "/w/a.txt"));
        assert!(fs.remove_path(Path::new("/w/")));
        assert!(!allowed(&fs, "/w/a.txt"));
        assert!(!fs.remove_path(Path::new("/w")), "already removed");
    }

    #[test]
    fn workspace_nested_in_permanent_root() {
        let fs = scoped(&["/z/scoped"]);
        assert!(fs.add_path(Path::new("/z/scoped/project")));
        assert!(fs.remove_path(Path::new("/z/scoped/project")));
        assert!(
            allowed(&fs, "/z/scoped/project/a.txt"),
            "still under the permanent root"
        );
    }

    #[test]
    fn permanent_root_nested_in_workspace() {
        let fs = scoped(&["/z/parent/zzz"]);
        assert!(fs.add_path(Path::new("/z/parent")));
        assert!(allowed(&fs, "/z/parent/other.txt"));
        assert!(fs.remove_path(Path::new("/z/parent")));
        assert!(!allowed(&fs, "/z/parent/other.txt"));
        assert!(allowed(&fs, "/z/parent/zzz/a.txt"), "permanent root kept");
    }

    #[test]
    fn overlapping_runtime_roots_are_independent() {
        let fs = scoped(&[]);
        assert!(fs.add_path(Path::new("/w")));
        assert!(fs.add_path(Path::new("/w/inner")));

        assert!(fs.remove_path(Path::new("/w/inner")));
        assert!(
            allowed(&fs, "/w/inner/a.txt"),
            "outer workspace still covers it"
        );

        assert!(fs.add_path(Path::new("/w/inner")));
        assert!(fs.remove_path(Path::new("/w")));
        assert!(
            allowed(&fs, "/w/inner/a.txt"),
            "inner workspace still covers it"
        );
        assert!(!allowed(&fs, "/w/a.txt"));
    }

    #[test]
    fn duplicate_permanent_roots_collapse() {
        let fs = scoped(&["/z/zzz", "/z/zzz/"]);
        assert_eq!(fs.permanent_paths, vec!["/z/zzz/".to_owned()]);
    }

    /// A unique canonical temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zzz_scoped_fs_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        fn fs(&self) -> ScopedFs {
            ScopedFs::new(vec![self.0.clone()])
        }

        /// Entries left behind by staged writes.
        fn temp_files(&self) -> Vec<String> {
            std::fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|name| is_temp_file_name(name))
                .collect()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().mode() & 0o7777
    }

    #[tokio::test]
    async fn write_replaces_atomically_and_keeps_the_mode() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        for mode in [0o640, 0o755, 0o600] {
            let file = tmp.path(&format!("mode_{mode:o}.txt"));
            std::fs::write(&file, "old").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
            let inode_before = std::fs::metadata(&file).unwrap().ino();

            fs.write_file(file.to_str().unwrap(), "new".to_owned())
                .await
                .unwrap();

            assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
            assert_eq!(mode_of(&file), mode, "mode {mode:o} kept");
            assert_ne!(
                std::fs::metadata(&file).unwrap().ino(),
                inode_before,
                "replaced by rename, not rewritten in place"
            );
        }
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[tokio::test]
    async fn write_creates_missing_files_and_parents() {
        let tmp = TempDir::new();
        let file = tmp.path("a/b/new.txt");
        tmp.fs()
            .write_file(file.to_str().unwrap(), "hi".to_owned())
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hi");
    }

    #[test]
    fn a_failed_write_leaves_the_original_and_no_temp_file() {
        let tmp = TempDir::new();
        let file = tmp.path("keep.txt");
        std::fs::write(&file, "original").unwrap();

        // a write that fails midway, like ENOSPC or EFBIG after a partial write
        let result = write_file_atomic_with(&file, |f| {
            f.write_all(b"partial")?;
            Err(std::io::Error::other("simulated ENOSPC"))
        });

        assert!(
            matches!(result, Err(ScopedFsError::Io { .. })),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[tokio::test]
    async fn special_file_targets_are_refused_without_opening_them() {
        let tmp = TempDir::new();
        let fs = tmp.fs();

        let fifo = tmp.path("fifo");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());
        // a FIFO would block the old `tokio::fs::write` until a reader appeared
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            fs.write_file(fifo.to_str().unwrap(), "x".to_owned()),
        )
        .await
        .expect("a FIFO target must not block");
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );
        assert!(
            std::fs::symlink_metadata(&fifo)
                .unwrap()
                .file_type()
                .is_fifo(),
            "the FIFO is left in place"
        );

        let socket = tmp.path("socket");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let result = fs
            .write_file(socket.to_str().unwrap(), "x".to_owned())
            .await;
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );

        let dir = tmp.path("dir");
        std::fs::create_dir(&dir).unwrap();
        let result = fs.write_file(dir.to_str().unwrap(), "x".to_owned()).await;
        assert!(
            matches!(result, Err(ScopedFsError::IsADirectory(_))),
            "{result:?}"
        );
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[test]
    fn a_symlink_swapped_in_after_validation_is_refused() {
        let tmp = TempDir::new();
        let target = tmp.path("target.txt");
        std::fs::write(&target, "untouched").unwrap();
        let link = tmp.path("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let result = write_file_atomic_with(&link, |f| f.write_all(b"x"));
        assert!(
            matches!(result, Err(ScopedFsError::SymlinkNotAllowed(_))),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched");
    }

    #[tokio::test]
    async fn a_write_breaks_hardlinks() {
        // documented trade-off of replace-by-rename
        let tmp = TempDir::new();
        let file = tmp.path("a.txt");
        let other = tmp.path("b.txt");
        std::fs::write(&file, "old").unwrap();
        std::fs::hard_link(&file, &other).unwrap();

        tmp.fs()
            .write_file(file.to_str().unwrap(), "new".to_owned())
            .await
            .unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "old");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_writes_never_interleave() {
        let tmp = TempDir::new();
        let fs = std::sync::Arc::new(tmp.fs());
        let file = tmp.path("f.txt");
        let path = file.to_str().unwrap().to_owned();
        let long = "L".repeat(64 * 1024);
        let short = "S".repeat(10);
        for _ in 0..200 {
            let writes = [long.clone(), short.clone()].map(|content| {
                let fs = std::sync::Arc::clone(&fs);
                let path = path.clone();
                tokio::spawn(async move { fs.write_file(&path, content).await })
            });
            for write in writes {
                write.await.unwrap().unwrap();
            }
            let got = std::fs::read_to_string(&file).unwrap();
            assert!(
                got == long || got == short,
                "mixed content: len {}",
                got.len()
            );
        }
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[tokio::test]
    async fn errors_are_classified() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        assert!(matches!(
            fs.write_file("relative.txt", String::new()).await,
            Err(ScopedFsError::InvalidPath(_))
        ));
        assert!(matches!(
            fs.write_file("/tmp/a\0b", String::new()).await,
            Err(ScopedFsError::InvalidPath(_))
        ));
        assert!(matches!(
            fs.write_file("/definitely/not/in/scope.txt", String::new())
                .await,
            Err(ScopedFsError::PathNotAllowed(_))
        ));
        let missing = tmp.path("missing.txt");
        match fs.rm(missing.to_str().unwrap()).await {
            Err(ScopedFsError::Io { source, .. }) => {
                assert_eq!(source.kind(), std::io::ErrorKind::NotFound);
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
        let file = tmp.path("file.txt");
        std::fs::write(&file, "").unwrap();
        match fs.mkdir(file.to_str().unwrap()).await {
            Err(ScopedFsError::Io { source, .. }) => {
                assert_eq!(source.kind(), std::io::ErrorKind::AlreadyExists);
            }
            other => panic!("expected AlreadyExists, got {other:?}"),
        }
    }

    /// Whether the process can write `path` despite its mode (e.g. root), in
    /// which case permission tests can't observe a refusal.
    fn writable_anyway(path: &Path) -> bool {
        std::fs::OpenOptions::new().write(true).open(path).is_ok()
    }

    fn set_mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[tokio::test]
    async fn a_read_only_file_is_refused_even_in_a_writable_dir() {
        let tmp = TempDir::new();
        let file = tmp.path("ro.txt");
        std::fs::write(&file, "orig").unwrap();
        set_mode(&file, 0o444);
        if writable_anyway(&file) {
            return;
        }

        let result = tmp
            .fs()
            .write_file(file.to_str().unwrap(), "NEW".to_owned())
            .await;

        match result {
            Err(ScopedFsError::Io { path, source }) => {
                assert_eq!(source.kind(), std::io::ErrorKind::PermissionDenied);
                assert_eq!(path, file.to_str().unwrap());
            }
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "orig");
        assert_eq!(mode_of(&file), 0o444);
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[tokio::test]
    async fn a_writable_file_in_a_read_only_dir_is_written_in_place() {
        let tmp = TempDir::new();
        let dir = tmp.path("rodir");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("w.txt");
        std::fs::write(&file, "orig content").unwrap();
        set_mode(&file, 0o664);
        let inode_before = std::fs::metadata(&file).unwrap().ino();
        set_mode(&dir, 0o555);
        let fs = tmp.fs();

        let updated = fs
            .write_file(file.to_str().unwrap(), "NEW".to_owned())
            .await;
        let new_file = dir.join("new.txt");
        let created = fs
            .write_file(new_file.to_str().unwrap(), "x".to_owned())
            .await;
        let content = std::fs::read_to_string(&file).unwrap();
        let inode_after = std::fs::metadata(&file).unwrap().ino();
        let dir_writable_anyway = writable_anyway(&dir.join(".probe"));
        set_mode(&dir, 0o755);

        updated.unwrap();
        assert_eq!(content, "NEW", "truncated, not a mix of old and new");
        assert_eq!(inode_after, inode_before, "written in place");
        assert_eq!(mode_of(&file), 0o664);
        if !dir_writable_anyway {
            match created {
                Err(ScopedFsError::DirectoryNotWritable(path)) => {
                    assert_eq!(path, new_file.to_str().unwrap(), "named by the target");
                }
                other => panic!("expected DirectoryNotWritable, got {other:?}"),
            }
            assert!(!new_file.exists());
        }
    }

    #[test]
    fn the_in_place_fallback_refuses_a_file_replaced_since_it_was_opened() {
        let tmp = TempDir::new();
        let file = tmp.path("w.txt");
        std::fs::write(&file, "orig").unwrap();
        let handle = open_for_write_in_place(&file).unwrap();
        assert!(is_still_at(&handle, &file).unwrap());

        // replaced externally between the open and the fallback
        let replacement = tmp.path("other.txt");
        std::fs::write(&replacement, "theirs").unwrap();
        std::fs::rename(&replacement, &file).unwrap();
        assert!(!is_still_at(&handle, &file).unwrap());

        let result = write_in_place(handle, &|f| f.write_all(b"NEW"), &file);
        assert!(
            matches!(result, Err(ScopedFsError::ReplacedDuringSave(_))),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs");

        // removed outright
        let handle = open_for_write_in_place(&file).unwrap();
        std::fs::remove_file(&file).unwrap();
        let result = write_in_place(handle, &|f| f.write_all(b"NEW"), &file);
        assert!(
            matches!(result, Err(ScopedFsError::ReplacedDuringSave(_))),
            "{result:?}"
        );
        assert!(!file.exists());
    }

    #[test]
    fn errors_name_the_target_not_the_temp_file() {
        let tmp = TempDir::new();
        let file = tmp.path("keep.txt");
        std::fs::write(&file, "original").unwrap();
        let result = write_file_atomic_with(&file, |_| Err(std::io::Error::other("boom")));
        match result {
            Err(error @ ScopedFsError::Io { .. }) => {
                let message = error.to_string();
                assert!(message.ends_with(file.to_str().unwrap()), "{message}");
                assert!(!message.contains(TEMP_FILE_PREFIX), "{message}");
            }
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_file_never_replaces_anything() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let file = tmp.path("sub/new.txt");
        fs.create_file(file.to_str().unwrap(), "first".to_owned())
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "first");

        let again = fs.create_file(file.to_str().unwrap(), String::new()).await;
        assert!(
            matches!(again, Err(ScopedFsError::AlreadyExists(_))),
            "{again:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "first",
            "untouched"
        );

        // a dangling symlink occupies the name too — and isn't followed
        let link = tmp.path("dangling");
        std::os::unix::fs::symlink(tmp.path("nowhere"), &link).unwrap();
        let result = write_create_exclusive_direct(&link);
        assert!(
            matches!(result, Err(ScopedFsError::AlreadyExists(_))),
            "{result:?}"
        );
        assert!(!tmp.path("nowhere").exists());

        let dir = tmp.path("dir");
        std::fs::create_dir(&dir).unwrap();
        let result = fs.create_file(dir.to_str().unwrap(), String::new()).await;
        assert!(
            matches!(result, Err(ScopedFsError::AlreadyExists(_))),
            "{result:?}"
        );
    }

    /// `create_file_exclusive` below the symlink-refusing path validation.
    fn write_create_exclusive_direct(path: &Path) -> Result<(), ScopedFsError> {
        create_file_exclusive(path, b"x")
    }

    #[test]
    fn staged_write_names_match_exactly() {
        let hex = "0123456789abcdef0123456789abcdef";
        assert!(is_staged_write_file_name(&format!(
            "{TEMP_FILE_PREFIX}{hex}"
        )));
        let generated = format!("{TEMP_FILE_PREFIX}{}", uuid::Uuid::new_v4().simple());
        assert!(is_staged_write_file_name(&generated));
        for name in [
            TEMP_FILE_PREFIX.to_owned(),
            format!("{TEMP_FILE_PREFIX}{}", &hex[1..]),
            format!("{TEMP_FILE_PREFIX}{hex}0"),
            format!("{TEMP_FILE_PREFIX}{}", hex.to_uppercase()),
            format!("{TEMP_FILE_PREFIX}notes"),
            format!("x{TEMP_FILE_PREFIX}{hex}"),
        ] {
            assert!(!is_staged_write_file_name(&name), "{name}");
        }
    }

    #[tokio::test]
    async fn write_file_after_closing_workspace_on_permanent_root() {
        let dir = std::env::temp_dir().join(format!("zzz_scoped_fs_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let fs = ScopedFs::new(vec![dir.clone()]);

        fs.add_path(&dir);
        fs.remove_path(&dir);
        let file = dir.join("a.txt");
        let result = fs
            .write_file(file.to_str().unwrap(), "content".to_owned())
            .await;
        let contents = std::fs::read_to_string(&file);
        std::fs::remove_dir_all(&dir).unwrap();

        result.unwrap();
        assert_eq!(contents.unwrap(), "content");
    }
}
