use std::io::{Seek, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};

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
pub const ORPHANED_TEMP_FILE_MIN_AGE: std::time::Duration = std::time::Duration::from_hours(1);

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

/// zzz's conventional app-dir and CLI daemon-home name.
pub const ZZZ_DIR_NAME: &str = ".zzz";

/// Names of the directories that hold a user's credentials.
///
/// SSH keys, `GnuPG` keyrings, AWS and Kubernetes credentials, Docker registry
/// logins, and the `pass` store. Refused under every root ([`protected_dir`])
/// and never indexed by a filer.
pub const CREDENTIAL_DIR_NAMES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".password-store",
];

/// Whether `name` (a single path component) is one of
/// [`CREDENTIAL_DIR_NAMES`].
pub fn is_credential_dir_name(name: &str) -> bool {
    CREDENTIAL_DIR_NAMES.contains(&name)
}

/// A directory zzz refuses whatever root covers it ([`protected_dir`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectedDir {
    /// A `.zzz` directory other than the app dir — the CLI's daemon home
    /// (`~/.zzz/`, with `.env` and `bootstrap_token`) or another daemon's
    /// app dir.
    ZzzHome,
    /// A credential directory, named by its entry in
    /// [`CREDENTIAL_DIR_NAMES`].
    Credentials(&'static str),
}

impl ProtectedDir {
    /// The directory's name, as it appears in the path.
    pub const fn name(self) -> &'static str {
        match self {
            Self::ZzzHome => ZZZ_DIR_NAME,
            Self::Credentials(name) => name,
        }
    }

    /// What the directory holds, which is why it's refused.
    pub const fn holds(self) -> &'static str {
        match self {
            Self::ZzzHome => "zzz's own files (secrets, tokens)",
            Self::Credentials(_) => "credentials (keys, tokens)",
        }
    }
}

impl std::fmt::Display for ProtectedDir {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "a {} directory, which holds {}",
            self.name(),
            self.holds()
        )
    }
}

/// The protected directory `path` is, or is inside, if any.
///
/// - **Credential directories**: any component of `path` named in
///   [`CREDENTIAL_DIR_NAMES`], with no exception — the app dir included.
/// - **`.zzz` directories other than the app dir**: any `.zzz` component that
///   isn't part of `zzz_dir`'s own path. The app dir and everything inside it
///   pass, unless a `.zzz` sits below the app dir too.
///
/// Lexical: both paths must name what they spell — canonical, or lexically
/// normalized with symlinks refused along them, as [`ScopedFs`] does — so a
/// symlink can't spell its way around the check.
pub fn protected_dir(path: &Path, zzz_dir: &Path) -> Option<ProtectedDir> {
    let credentials = path.components().find_map(|c| {
        CREDENTIAL_DIR_NAMES
            .iter()
            .copied()
            .find(|name| c.as_os_str() == *name)
    });
    if let Some(name) = credentials {
        return Some(ProtectedDir::Credentials(name));
    }
    path.strip_prefix(zzz_dir)
        .unwrap_or(path)
        .components()
        .any(|c| c.as_os_str() == ZZZ_DIR_NAME)
        .then_some(ProtectedDir::ZzzHome)
}

// -- Saves --------------------------------------------------------------------

/// What a save expects the file it replaces to hold.
///
/// The compare that makes [`ScopedFs::write_file`] a compare-and-swap: unless
/// the file's bytes still hash to `hash`, nothing is written
/// ([`ScopedFsError::DiskChanged`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExpectedContent {
    /// BLAKE3 of the bytes the caller last read and based its write on.
    pub hash: blake3::Hash,
    /// The largest file those bytes can have come from: a larger one is
    /// [`ScopedFsError::DiskChanged`] without being read, and the compare
    /// reads at most one byte past it.
    pub max_size: u64,
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
    /// In a protected directory ([`protected_dir`]) — a credential directory,
    /// or a `.zzz` directory other than the app dir — whatever root covers
    /// it.
    #[error("Path is in {dir}: {path}")]
    ProtectedDirNotAllowed { path: String, dir: ProtectedDir },
    #[error("Path is a symlink which is not allowed: {0}")]
    SymlinkNotAllowed(String),
    /// A directory where a file was expected.
    #[error("Path is a directory: {0}")]
    IsADirectory(String),
    /// A FIFO, socket, or device node where a regular file was expected —
    /// never written (a FIFO would block the write forever) and never
    /// replaced.
    #[error("Path is not a regular file: {0}")]
    NotARegularFile(String),
    /// A new file or directory can't be created because its parent directory
    /// isn't writable.
    #[error("Directory is not writable, can't create: {0}")]
    DirectoryNotWritable(String),
    /// A create-only operation (a new file or directory) found the path taken.
    #[error("Path already exists: {0}")]
    AlreadyExists(String),
    /// The in-place fallback found the path no longer names the file it
    /// opened — replaced or removed externally mid-save — so it wrote
    /// nothing rather than into an unlinked inode.
    #[error("Path was replaced during the save: {0}")]
    ReplacedDuringSave(String),
    /// A save that named the content it replaces ([`ExpectedContent`]) found
    /// other bytes at the path, a file larger than that content could be, or
    /// no file — the file changed on disk since the caller read it — and
    /// wrote nothing.
    #[error("File changed on disk since it was read: {0}")]
    DiskChanged(String),
    /// A rename the filesystem can't do safely — no hard links for its
    /// companions, or no `RENAME_NOREPLACE` — refused rather than risking a
    /// replace or a companion cut off from its file.
    #[error("The filesystem can't rename this safely: {0}")]
    RenameUnsupported(String),
    /// An append found the file at a different size than the offset the
    /// caller expected, and wrote nothing. `size` is the file's current size.
    #[error("File size {size} differs from the expected offset: {path}")]
    OffsetMismatch { path: String, size: u64 },
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
/// relative paths, path traversal, symlinks, credential directories, and
/// `.zzz` directories other than the app dir.
///
/// **Protected directories are refused under every root.** A path that is, or
/// is inside, a credential directory ([`CREDENTIAL_DIR_NAMES`]) or a `.zzz`
/// directory other than `zzz_dir` ([`protected_dir`]) fails every operation
/// with [`ScopedFsError::ProtectedDirNotAllowed`] — reads, writes, appends,
/// creates, deletes, and opens alike — even when a root covers it (a root
/// `~/dev` with a `~/dev/x/.ssh` in it, or the CLI's daemon home `~/.zzz/`
/// under a root that covers it). The check runs on the lexically normalized
/// path the operation acts on, before anything touches the filesystem, so
/// the refusal says nothing about whether the path exists; the symlink checks
/// that follow make that path the one the operation reaches. The app dir and
/// the paths inside it stay usable (unless they're in a credential
/// directory, which the boot refuses).
///
/// The allowed set is a fixed set of permanent roots (`zzz_dir` +
/// `scoped_dirs`, from [`Self::new`]) plus runtime roots for open projects
/// ([`Self::add_path`] / [`Self::remove_path`]). A path is allowed when any
/// root covers it, so overlapping roots compose: removing a runtime root never
/// revokes access a permanent root or another runtime root still grants.
/// Which directories can be roots at all is [`crate::root_policy`]'s rule,
/// checked by the boot and by `project_open` before a root is added.
///
/// **Not a confinement boundary against an authenticated caller.** The allowed
/// set is *mutable at runtime* via [`Self::add_path`], and `project_open`
/// (gated only at `AuthSpec::account_grain(CredentialGate::Any)` — any
/// credential, no role) calls it with the root of a caller-supplied
/// path's project, checked only against the root rules
/// ([`crate::root_policy::RootPolicy`]), not the existing allowlist. So any
/// authenticated caller can widen the scope to any existing directory those
/// rules admit (strictly inside `$HOME`, or in `ZZZ_ROOTS_OUTSIDE_HOME`) and
/// then write beneath it. Read this type as a guard against accidental or buggy writes
/// outside the open projects — not as a sandbox. That is consistent with zzz's
/// posture (an authenticated zzz credential carries local-user authority
/// regardless — see the `terminal_*` actions), but don't mistake the type for a
/// stronger guarantee than it makes.
///
/// NOTE: There is an inherent TOCTOU gap between the symlink check (`lstat`)
/// and the caller's subsequent filesystem operation. A symlink could be
/// created after validation.
#[derive(Debug)]
pub struct ScopedFs {
    /// The app dir, exempt from the `.zzz` refusal ([`protected_dir`]).
    /// Also the first permanent root.
    zzz_dir: PathBuf,
    /// Roots fixed at construction (`zzz_dir` + `scoped_dirs`), each
    /// normalized with a trailing `/`. Never removed —
    /// [`Self::remove_path`] only touches [`Self::dynamic_paths`], so
    /// closing a project rooted at (or containing, or nested in) a
    /// permanent root can't revoke access that root grants.
    ///
    /// Stored as `String` (not `PathBuf`) so `is_path_allowed` doesn't
    /// re-run `to_string_lossy()` on every allowed entry on every fs
    /// operation — the lossy conversion happens once at insert time.
    permanent_paths: Vec<String>,
    /// Roots added at runtime (open projects), same normalization. One
    /// entry per root: [`crate::project_manager::ProjectManager`] sets these
    /// from its one-entry-per-root state at each commit, so no refcount is
    /// needed — overlapping roots are separate entries, and removing one
    /// leaves any other root that covers the same paths in place.
    dynamic_paths: RwLock<Vec<String>>,
    /// Serializes [`Self::append_file`]'s size check and write, so two
    /// appends can't both pass the check and interleave. One lock for every
    /// file: an append is a short write.
    append_lock: Arc<Mutex<()>>,
}

impl ScopedFs {
    /// Create a new `ScopedFs` whose permanent roots are the app dir
    /// `zzz_dir` and `scoped_dirs`.
    ///
    /// Each path must be absolute and canonical (the `.zzz` refusal compares
    /// `zzz_dir` with paths as they're spelled), and is normalized with a
    /// trailing `/`. These roots are never removed by [`Self::remove_path`].
    pub fn new(zzz_dir: PathBuf, scoped_dirs: &[PathBuf]) -> Self {
        let mut permanent_paths: Vec<String> = Vec::with_capacity(1 + scoped_dirs.len());
        for normalized in std::iter::once(&zzz_dir)
            .chain(scoped_dirs)
            .map(|p| to_normalized_string(p))
        {
            if !permanent_paths.contains(&normalized) {
                permanent_paths.push(normalized);
            }
        }
        Self {
            zzz_dir,
            permanent_paths,
            dynamic_paths: RwLock::new(Vec::new()),
            append_lock: Arc::new(Mutex::new(())),
        }
    }

    /// A `ScopedFs` with no roots at all, which allows nothing — for tests
    /// that need an `App` but never touch files.
    #[cfg(test)]
    pub(crate) fn without_roots() -> Self {
        Self {
            zzz_dir: PathBuf::new(),
            permanent_paths: Vec::new(),
            dynamic_paths: RwLock::new(Vec::new()),
            append_lock: Arc::new(Mutex::new(())),
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
        paths
            .iter()
            .position(|p| p == &normalized)
            .map(|index| paths.remove(index))
            .is_some()
    }

    /// The roots added at runtime, each with a trailing `/`, in the order
    /// they were added.
    pub fn runtime_roots(&self) -> Vec<String> {
        self.dynamic_paths.read().clone()
    }

    /// Whether `root` (trailing `/`) is itself a root, permanent or runtime.
    pub fn has_root(&self, root: &str) -> bool {
        self.permanent_paths.iter().any(|p| p == root)
            || self.dynamic_paths.read().iter().any(|p| p == root)
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
    /// - Rejects protected directories — credential directories and `.zzz`
    ///   directories other than the app dir ([`protected_dir`]) — before
    ///   anything touches the filesystem
    /// - Checks against allowed directories
    /// - Rejects symlinks (target and all parent directories)
    ///
    /// Every operation calls this first, so each refusal here holds for all
    /// of them.
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

        // Credential directories and `.zzz` directories (the CLI's `.env`
        // and `bootstrap_token`) are refused whatever root covers them.
        // Lexical and first, so the refusal is the same whether or not the
        // path exists; the symlink checks below make the normalized path the
        // one acted on.
        if let Some(dir) = protected_dir(&normalized, &self.zzz_dir) {
            return Err(ScopedFsError::ProtectedDirNotAllowed {
                path: normalized.to_string_lossy().into_owned(),
                dir,
            });
        }

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
                // File doesn't exist yet — that's fine for a write or create
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
    /// The write is atomic: see `write_file_atomic_with`. Concurrent writes to
    /// the same path never interleave — each stages its own temp file, and
    /// the last rename wins — so no per-path lock is needed.
    ///
    /// With `expected`, it's a compare-and-swap: the file must exist and its
    /// bytes still hash to `expected.hash`, checked after the content is
    /// staged, right before the rename (and again before an in-place
    /// fallback's truncate), or nothing is written. No parent directory is
    /// created then — the file must already be there. A write landing between
    /// the compare and the rename is still replaced: the compare narrows the
    /// window to that gap, it doesn't close it (no lock spans another
    /// process's write).
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation;
    /// [`ScopedFsError::DiskChanged`] when `expected` doesn't hold;
    /// [`ScopedFsError::IsADirectory`] / [`ScopedFsError::NotARegularFile`]
    /// for an existing target that isn't a regular file; otherwise
    /// [`ScopedFsError::Io`].
    pub async fn write_file(
        &self,
        path: &str,
        content: String,
        expected: Option<ExpectedContent>,
    ) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        if expected.is_none()
            && let Some(parent) = safe_path.parent()
        {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ScopedFsError::io(parent, e))?;
        }
        // Blocking std I/O on a blocking thread: the write + fsync can take a
        // while, and the task finishes (renaming or cleaning up its temp
        // file) even if the request is dropped mid-write.
        tokio::task::spawn_blocking(move || {
            write_file_atomic_with(&safe_path, expected.as_ref(), |file| {
                file.write_all(content.as_bytes())
            })
        })
        .await
        .map_err(|e| ScopedFsError::io(Path::new(path), std::io::Error::other(e)))?
    }

    /// Replace an existing file's content with `source`'s, from its start —
    /// atomically, exactly as [`Self::write_file`] does (same staging, mode
    /// and ownership handling, and in-place fallback). For content that was
    /// produced into a file, like a tool's output.
    ///
    /// # Errors
    ///
    /// As [`Self::write_file`].
    pub async fn write_file_from(
        &self,
        path: &str,
        source: std::fs::File,
    ) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        tokio::task::spawn_blocking(move || {
            write_file_atomic_with(&safe_path, None, |file| {
                // `&File` reads and seeks, so the closure can run again for
                // the in-place fallback
                let mut source = &source;
                source.seek(std::io::SeekFrom::Start(0))?;
                std::io::copy(&mut source, file).map(|_| ())
            })
        })
        .await
        .map_err(|e| ScopedFsError::io(Path::new(path), std::io::Error::other(e)))?
    }

    /// Create a new file holding `content`, creating parent directories if
    /// needed — never replacing an existing one.
    ///
    /// The final name is created `O_CREAT | O_EXCL | O_NOFOLLOW`, so the check
    /// and the create are one step: an existing file, directory, or anything
    /// else at the path fails with [`ScopedFsError::AlreadyExists`] and is
    /// left untouched — except a symlink, which path validation refuses first
    /// ([`ScopedFsError::SymlinkNotAllowed`]; the `O_EXCL` still covers one
    /// appearing after that check). Not staged like [`Self::write_file`] — a
    /// failed write removes the file it just created, and there's no old
    /// content to lose. A new file gets `0o666` minus the umask.
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation;
    /// [`ScopedFsError::AlreadyExists`]; [`ScopedFsError::DirectoryNotWritable`]
    /// when the file's own directory isn't writable; otherwise
    /// [`ScopedFsError::Io`] — including `PermissionDenied` when a missing
    /// parent directory can't be created under a non-writable ancestor.
    pub async fn create_file(
        &self,
        path: &str,
        content: impl AsRef<[u8]> + Send + 'static,
    ) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        if let Some(parent) = safe_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ScopedFsError::io(parent, e))?;
        }
        tokio::task::spawn_blocking(move || create_file_exclusive(&safe_path, content.as_ref()))
            .await
            .map_err(|e| ScopedFsError::io(Path::new(path), std::io::Error::other(e)))?
    }

    /// Append `content` to an existing file, only if the file is currently
    /// `expected_size` bytes long. Returns the new size.
    ///
    /// The size check makes a chunked upload safe to retry and impossible to
    /// interleave: a chunk that already landed, or one sent out of order,
    /// finds a different size and fails with
    /// [`ScopedFsError::OffsetMismatch`] (which carries the current size)
    /// having written nothing. The check and the write happen under one lock,
    /// and the data is fsynced before returning. A write that fails midway
    /// truncates the file back to `expected_size` (best-effort).
    ///
    /// The file is never created — see [`Self::create_file`].
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation;
    /// [`ScopedFsError::OffsetMismatch`]; [`ScopedFsError::NotARegularFile`]
    /// for a FIFO, socket, or device node; otherwise [`ScopedFsError::Io`] —
    /// `NotFound` for a missing file, and `IsADirectory` for a directory,
    /// which the open itself refuses.
    pub async fn append_file(
        &self,
        path: &str,
        expected_size: u64,
        content: impl AsRef<[u8]> + Send + 'static,
    ) -> Result<u64, ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        let append_lock = Arc::clone(&self.append_lock);
        tokio::task::spawn_blocking(move || {
            let _guard = append_lock.lock();
            append_at(&safe_path, expected_size, content.as_ref())
        })
        .await
        .map_err(|e| ScopedFsError::io(Path::new(path), std::io::Error::other(e)))?
    }

    /// Open an existing regular file for reading, returning the handle and
    /// its metadata (`fstat` of the handle, so the two always agree).
    ///
    /// Opened `O_NOFOLLOW | O_NONBLOCK`: a symlink swapped in after path
    /// validation is refused, and a FIFO can't block the open.
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation;
    /// [`ScopedFsError::IsADirectory`] / [`ScopedFsError::NotARegularFile`]
    /// for a target that isn't a regular file; otherwise
    /// [`ScopedFsError::Io`] (e.g. `NotFound`, `PermissionDenied`).
    pub async fn open_file(
        &self,
        path: &str,
    ) -> Result<(std::fs::File, std::fs::Metadata), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        tokio::task::spawn_blocking(move || open_regular_file(&safe_path, false))
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

    /// Create a new directory, creating missing parent directories — never
    /// reusing an existing one.
    ///
    /// Like [`Self::create_file`], the final name must be free: an existing
    /// directory, file, or anything else there fails with
    /// [`ScopedFsError::AlreadyExists`] — except a symlink, which path
    /// validation refuses first ([`ScopedFsError::SymlinkNotAllowed`];
    /// `mkdir(2)` never follows one appearing after that check). `mkdir(2)`
    /// checks and creates in one step. A new directory gets `0o777` minus the
    /// umask.
    ///
    /// # Errors
    ///
    /// The path-validation errors of every `ScopedFs` operation;
    /// [`ScopedFsError::AlreadyExists`]; [`ScopedFsError::DirectoryNotWritable`]
    /// when the new directory's parent isn't writable; otherwise
    /// [`ScopedFsError::Io`] (e.g. `NotADirectory` when an ancestor is a file,
    /// or `PermissionDenied` when a missing parent can't be created under a
    /// non-writable ancestor).
    pub async fn create_dir(&self, path: &str) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        if let Some(parent) = safe_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ScopedFsError::io(parent, e))?;
        }
        tokio::fs::create_dir(&safe_path)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => {
                    ScopedFsError::AlreadyExists(ScopedFsError::display(&safe_path))
                }
                _ if is_not_writable(&e) => {
                    ScopedFsError::DirectoryNotWritable(ScopedFsError::display(&safe_path))
                }
                _ => ScopedFsError::io(&safe_path, e),
            })
    }

    /// Validate a rename of the file at `path` to `new_name` in its own
    /// directory, for [`PreparedRename::apply`] — the validation is async,
    /// the rename itself is blocking, so a caller can run it under a lock of
    /// its own (the job table's, so no job starts on the file meanwhile).
    ///
    /// # Errors
    ///
    /// [`ScopedFsError::InvalidPath`] when `new_name` isn't one plain path
    /// component, or is the file's own name; otherwise the path-validation
    /// errors of every `ScopedFs` operation, for either path.
    pub async fn prepare_rename(
        &self,
        path: &str,
        new_name: &str,
    ) -> Result<PreparedRename, ScopedFsError> {
        if !is_plain_name(new_name) {
            return Err(ScopedFsError::InvalidPath(new_name.to_owned()));
        }
        let from = self.ensure_safe_path(path).await?;
        let (Some(dir), Some(old_name)) = (from.parent(), from.file_name()) else {
            return Err(ScopedFsError::InvalidPath(path.to_owned()));
        };
        if old_name == new_name {
            return Err(ScopedFsError::InvalidPath(new_name.to_owned()));
        }
        let to = self
            .ensure_safe_path(&dir.join(new_name).to_string_lossy())
            .await?;
        Ok(PreparedRename { from, to })
    }
}

// -- Renames ------------------------------------------------------------------

/// Whether `name` is one plain path component: not empty, not `.` or `..`,
/// no `/`, `\`, or NUL — the TS `is_plain_file_name`, which a transcript
/// sidecar's source name must pass, so a renamed file's sidecars still name
/// it.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// Whether `a` and `b` name the same file (device and inode), neither
/// followed if a symlink.
fn is_same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

/// Whether a hard link or `RENAME_NOREPLACE` failed because the filesystem
/// doesn't do it (no hard links on FAT or exFAT; no `RENAME_NOREPLACE` on some FUSE and NFS) — or, for `EPERM` from a
/// link, refuses it (`fs.protected_hardlinks`) — rather than for the path.
fn is_unsupported(error: &std::io::Error, from_link: bool) -> bool {
    match error.raw_os_error() {
        Some(code) if code == libc::ENOSYS || code == libc::EOPNOTSUPP => true,
        Some(code) if from_link => code == libc::EPERM,
        Some(code) => code == libc::EINVAL,
        None => false,
    }
}

/// A validated rename of one file within its directory
/// ([`ScopedFs::prepare_rename`]), carrying the file's companions — files
/// beside it whose names derive from its own, like a transcript sidecar.
#[derive(Debug)]
pub struct PreparedRename {
    from: PathBuf,
    to: PathBuf,
}

/// A file a rename moved: its absolute path before and after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Renamed {
    pub from: PathBuf,
    pub to: PathBuf,
}

impl PreparedRename {
    /// The path the file has now.
    #[must_use]
    pub fn from(&self) -> &Path {
        &self.from
    }

    /// The path the file would take.
    #[must_use]
    pub fn to(&self) -> &Path {
        &self.to
    }

    /// Rename the file, and each companion `companion_name` finds beside it
    /// (it maps a sibling's name to its new name, or `None` for a file that
    /// isn't one), never replacing anything. Blocking.
    ///
    /// The companions are hard-linked to their new names first, then the
    /// file is renamed — `renameat2(RENAME_NOREPLACE)`, the commit point —
    /// then the companions' old names are removed. Before the commit, a
    /// failure removes the links it made; after it, an old name that can't
    /// be removed is left (logged) — never a companion cut off from its
    /// file, but an extra name, which a file later created at the old name
    /// would pick up until sidecars are checked by their `source.blake3`. A
    /// companion's link already at its new name (a crashed rename's) is
    /// taken, so a retry finishes. Only regular files are companions — a
    /// symlink beside the file isn't one. The directory is fsynced after.
    ///
    /// # Errors
    ///
    /// [`ScopedFsError::IsADirectory`] or [`ScopedFsError::NotARegularFile`]
    /// for anything but a regular file at the path;
    /// [`ScopedFsError::AlreadyExists`] when the new name, or a companion's,
    /// is taken; [`ScopedFsError::RenameUnsupported`] on a filesystem
    /// without hard links or `RENAME_NOREPLACE`;
    /// [`ScopedFsError::DirectoryNotWritable`]; otherwise
    /// [`ScopedFsError::Io`] (`NotFound` for a missing file).
    pub fn apply(
        self,
        companion_name: impl Fn(&str) -> Option<String>,
    ) -> Result<Vec<Renamed>, ScopedFsError> {
        let Self { from, to } = self;
        let meta = std::fs::symlink_metadata(&from).map_err(|e| ScopedFsError::io(&from, e))?;
        if meta.is_dir() {
            return Err(ScopedFsError::IsADirectory(ScopedFsError::display(&from)));
        }
        if !meta.is_file() {
            return Err(ScopedFsError::NotARegularFile(ScopedFsError::display(
                &from,
            )));
        }
        let dir = from
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_path_buf();

        // the companions, found now — under the caller's lock, so none
        // written just before is missed
        let mut companions = Vec::new();
        let entries = std::fs::read_dir(&dir).map_err(|e| ScopedFsError::io(&dir, e))?;
        for entry in entries {
            let entry = entry.map_err(|e| ScopedFsError::io(&dir, e))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(new_name) = companion_name(&name) else {
                continue;
            };
            if !is_plain_name(&new_name) {
                continue;
            }
            let path = entry.path();
            if path == from || !entry.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            companions.push(Renamed {
                from: path,
                to: dir.join(new_name),
            });
        }

        let refused = |path: &Path, e: std::io::Error, from_link: bool| match e.kind() {
            _ if is_unsupported(&e, from_link) => {
                ScopedFsError::RenameUnsupported(ScopedFsError::display(path))
            }
            std::io::ErrorKind::AlreadyExists => {
                ScopedFsError::AlreadyExists(ScopedFsError::display(path))
            }
            _ if is_not_writable(&e) => {
                ScopedFsError::DirectoryNotWritable(ScopedFsError::display(path))
            }
            _ => ScopedFsError::io(path, e),
        };
        // only the links this run made — a taken one (a crashed rename's, or a link the person
        // made) stays as it was
        let unlink_all = |linked: &[Renamed], made: &[bool]| {
            for (link, _) in linked.iter().zip(made).filter(|(_, made)| **made) {
                if let Err(e) = std::fs::remove_file(&link.to) {
                    tracing::warn!(
                        path = %link.to.display(),
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "failed to remove a companion's link after a refused rename"
                    );
                }
            }
        };

        let mut linked: Vec<Renamed> = Vec::with_capacity(companions.len());
        let mut made: Vec<bool> = Vec::with_capacity(companions.len());
        for companion in companions {
            let made_link = match std::fs::hard_link(&companion.from, &companion.to) {
                Ok(()) => true,
                // a link a crashed rename already made (the same file): take it, so a retry
                // finishes the job rather than refusing forever
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists
                        && is_same_file(&companion.from, &companion.to) =>
                {
                    false
                }
                Err(e) => {
                    unlink_all(&linked, &made);
                    return Err(refused(&companion.to, e, true));
                }
            };
            linked.push(companion);
            made.push(made_link);
        }
        if let Err(e) = nix::fcntl::renameat2(
            nix::fcntl::AT_FDCWD,
            &from,
            nix::fcntl::AT_FDCWD,
            &to,
            nix::fcntl::RenameFlags::RENAME_NOREPLACE,
        ) {
            unlink_all(&linked, &made);
            return Err(refused(&to, std::io::Error::from(e), false));
        }
        for companion in &linked {
            if let Err(e) = std::fs::remove_file(&companion.from) {
                tracing::warn!(
                    path = %companion.from.display(),
                    error = %fuz_sys::cli::format_error_chain(&e),
                    "failed to remove a renamed companion's old name"
                );
            }
        }
        if let Err(e) = std::fs::File::open(&dir).and_then(|d| d.sync_all()) {
            tracing::debug!(
                dir = %dir.display(),
                error = %fuz_sys::cli::format_error_chain(&e),
                "failed to fsync directory after a rename"
            );
        }

        let mut renamed = vec![Renamed { from, to }];
        renamed.extend(linked);
        Ok(renamed)
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
/// bits — except setuid and setgid, which zzz always drops (the content
/// changed, so the privilege shouldn't carry over) — and, best-effort, its
/// owner and
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
/// it mid-write, but the inode, mode, owner, and hardlinks are kept (though
/// the kernel may clear setuid/setgid on the write). A new
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
///
/// **Compare (`expected`).** A missing target is
/// [`ScopedFsError::DiskChanged`] at once. Otherwise the target's current
/// bytes are compared ([`check_unchanged`]) as late as each path allows:
/// after the content is staged, right before the rename — the temp file
/// removed if it fails — and on the in-place fallback right before the
/// truncate. What remains is the gap between that compare and the rename
/// (or the truncate): a write landing there is replaced unseen.
fn write_file_atomic_with(
    path: &Path,
    expected: Option<&ExpectedContent>,
    write: impl Fn(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<(), ScopedFsError> {
    let existing = existing_regular_file(path)?;
    if expected.is_some() && existing.is_none() {
        return Err(ScopedFsError::DiskChanged(ScopedFsError::display(path)));
    }
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
                |target| write_in_place(target, expected, &write, path),
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
    // the compare, as late as the atomic path allows: the content is staged
    // and fsynced, so only the rename follows it
    if let Some(expected) = expected
        && let Err(e) = check_unchanged(path, expected)
    {
        remove_temp_file(&temp_path);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&temp_path, path) {
        remove_temp_file(&temp_path);
        return match target {
            Some(target) if is_rename_refused(&e) => write_in_place(target, expected, &write, path),
            _ => Err(ScopedFsError::io(path, e)),
        };
    }

    // Persist the rename itself. The new content is already durable and in
    // place, so a failure here is logged rather than failing the write.
    if let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all()) {
        tracing::debug!(
            dir = %dir.display(),
            error = %fuz_sys::cli::format_error_chain(&e),
            "failed to fsync directory after write"
        );
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
/// `lstat` (errors mapped by [`open_error`]), and the handle is re-checked
/// to be a regular file.
fn open_for_write_in_place(path: &Path) -> Result<std::fs::File, ScopedFsError> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| open_error(path, e))?;
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
///
/// With `expected`, the path's current bytes are compared first
/// ([`check_unchanged`]) — before that inode check, so the inode it confirms
/// is the one the compare read, short of a file swapped out and back between
/// the two.
fn write_in_place(
    mut file: std::fs::File,
    expected: Option<&ExpectedContent>,
    write: &impl Fn(&mut std::fs::File) -> std::io::Result<()>,
    path: &Path,
) -> Result<(), ScopedFsError> {
    if let Some(expected) = expected {
        check_unchanged(path, expected)?;
    }
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

/// The compare of a save with [`ExpectedContent`]: `Ok` only when the regular
/// file at `path` is at most `expected.max_size` bytes and they hash to
/// `expected.hash`; [`ScopedFsError::DiskChanged`] when they don't, or when
/// the file is gone. Opened like every read here (`O_NOFOLLOW |
/// O_NONBLOCK`, regular files only — [`open_regular_file`]), so a symlink or
/// special file swapped in keeps its own error. One over the size isn't read;
/// one that grows past it during the read stops one byte over.
fn check_unchanged(path: &Path, expected: &ExpectedContent) -> Result<(), ScopedFsError> {
    use std::io::Read as _;

    let changed = || ScopedFsError::DiskChanged(ScopedFsError::display(path));
    let (file, meta) = match open_regular_file(path, false) {
        Ok(opened) => opened,
        Err(ScopedFsError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(changed());
        }
        Err(e) => return Err(e),
    };
    if meta.len() > expected.max_size {
        return Err(changed());
    }
    let mut hasher = blake3::Hasher::new();
    let read = std::io::copy(&mut file.take(expected.max_size + 1), &mut hasher)
        .map_err(|e| ScopedFsError::io(path, e))?;
    if read > expected.max_size || hasher.finalize() != expected.hash {
        return Err(changed());
    }
    Ok(())
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
        tracing::warn!(
            path = %temp_path.display(),
            error = %fuz_sys::cli::format_error_chain(&e),
            "failed to remove temp file"
        );
    }
}

/// Fill the staged temp file: carry over the replaced file's ownership and
/// mode (minus setuid/setgid, see [`write_file_atomic_with`]), write, fsync.
fn stage(
    file: &mut std::fs::File,
    existing: Option<&std::fs::Metadata>,
    write: &impl Fn(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    if let Some(meta) = existing {
        preserve_ownership(file, meta);
        file.set_permissions(std::fs::Permissions::from_mode(
            meta.mode() & PRESERVED_MODE_BITS,
        ))?;
    }
    write(file)?;
    file.sync_all()
}

/// The mode bits a replaced file's staged copy keeps: permissions and
/// sticky, never setuid (`0o4000`) or setgid (`0o2000`).
const PRESERVED_MODE_BITS: u32 = 0o1777;

/// Give the staged file `meta`'s owner and group, falling back to the group
/// alone. Best-effort: without the privilege the staged file keeps the
/// daemon's ownership.
fn preserve_ownership(file: &std::fs::File, meta: &std::fs::Metadata) {
    if std::os::unix::fs::fchown(file, Some(meta.uid()), Some(meta.gid())).is_ok() {
        return;
    }
    if let Err(e) = std::os::unix::fs::fchown(file, None, Some(meta.gid())) {
        tracing::debug!(
            error = %fuz_sys::cli::format_error_chain(&e),
            "could not preserve the replaced file's group"
        );
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
            tracing::warn!(
                path = %path.display(),
                error = %fuz_sys::cli::format_error_chain(&cleanup),
                "failed to remove a partly written new file"
            );
        }
        return Err(ScopedFsError::io(path, e));
    }
    if let Some(dir) = path.parent()
        && let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all())
    {
        tracing::debug!(
            dir = %dir.display(),
            error = %fuz_sys::cli::format_error_chain(&e),
            "failed to fsync directory after create"
        );
    }
    Ok(())
}

/// Map an `O_NOFOLLOW | O_NONBLOCK` open's failure on `path` — shared by
/// every open of an existing file here, so they agree.
///
/// `ELOOP` is a symlink (swapped in since path validation). `ENXIO` is what
/// `open(2)` returns for a socket, a FIFO opened for writing with no reader,
/// and a device node with no device behind it — read as
/// [`ScopedFsError::NotARegularFile`] only when an `lstat` confirms the path
/// isn't a regular file, since a filesystem's own open (FUSE, say) can return
/// it for one; then, and for everything else, it's [`ScopedFsError::Io`].
fn open_error(path: &Path, error: std::io::Error) -> ScopedFsError {
    match error.raw_os_error() {
        Some(libc::ELOOP) => ScopedFsError::SymlinkNotAllowed(ScopedFsError::display(path)),
        Some(libc::ENXIO) if std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_file()) => {
            ScopedFsError::NotARegularFile(ScopedFsError::display(path))
        }
        _ => ScopedFsError::io(path, error),
    }
}

/// Open an existing regular file `O_NOFOLLOW | O_NONBLOCK` — for reading, or
/// for appending when `append` — and `fstat` it. A directory, FIFO, socket,
/// or device node is refused; `O_NONBLOCK` keeps a FIFO from blocking the
/// open, and has no effect on a regular file. Open failures map through
/// [`open_error`], so a socket or a reader-less FIFO, which `open(2)` itself
/// refuses with `ENXIO`, is [`ScopedFsError::NotARegularFile`] too.
fn open_regular_file(
    path: &Path,
    append: bool,
) -> Result<(std::fs::File, std::fs::Metadata), ScopedFsError> {
    let mut options = std::fs::OpenOptions::new();
    if append {
        options.append(true);
    } else {
        options.read(true);
    }
    let file = options
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| open_error(path, e))?;
    let meta = file.metadata().map_err(|e| ScopedFsError::io(path, e))?;
    if meta.is_dir() {
        return Err(ScopedFsError::IsADirectory(ScopedFsError::display(path)));
    }
    if !meta.is_file() {
        return Err(ScopedFsError::NotARegularFile(ScopedFsError::display(path)));
    }
    Ok((file, meta))
}

/// Append `content` to the regular file at `path` if it is `expected_size`
/// bytes long, fsyncing the data. See [`ScopedFs::append_file`], which holds
/// the lock that makes the check and the write one step.
fn append_at(path: &Path, expected_size: u64, content: &[u8]) -> Result<u64, ScopedFsError> {
    let (mut file, meta) = open_regular_file(path, true)?;
    let size = meta.len();
    if size != expected_size {
        return Err(ScopedFsError::OffsetMismatch {
            path: ScopedFsError::display(path),
            size,
        });
    }
    if let Err(e) = file.write_all(content).and_then(|()| file.sync_data()) {
        // drop the partial chunk, so a retry at the same offset can succeed
        if let Err(cleanup) = file.set_len(expected_size) {
            tracing::warn!(
                path = %path.display(),
                error = %fuz_sys::cli::format_error_chain(&cleanup),
                "failed to truncate a partly appended file"
            );
        }
        return Err(ScopedFsError::io(path, e));
    }
    Ok(size + content.len() as u64)
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

/// Normalize a path by resolving `.` and `..` components without filesystem
/// access — the path every `ScopedFs` operation checks and acts on.
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
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

    /// A `ScopedFs` whose app dir is the first path, scoping the rest too.
    fn scoped(paths: &[&str]) -> ScopedFs {
        match paths {
            [] => ScopedFs::without_roots(),
            [zzz_dir, scoped_dirs @ ..] => ScopedFs::new(
                PathBuf::from(zzz_dir),
                &scoped_dirs.iter().map(PathBuf::from).collect::<Vec<_>>(),
            ),
        }
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
        // a project rooted at a permanent root is a no-op add, and its close
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
    fn runtime_root_nested_in_permanent_root() {
        let fs = scoped(&["/z/scoped"]);
        assert!(fs.add_path(Path::new("/z/scoped/project")));
        assert!(fs.remove_path(Path::new("/z/scoped/project")));
        assert!(
            allowed(&fs, "/z/scoped/project/a.txt"),
            "still under the permanent root"
        );
    }

    #[test]
    fn permanent_root_nested_in_runtime_root() {
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
        assert!(allowed(&fs, "/w/inner/a.txt"), "outer root still covers it");

        assert!(fs.add_path(Path::new("/w/inner")));
        assert!(fs.remove_path(Path::new("/w")));
        assert!(allowed(&fs, "/w/inner/a.txt"), "inner root still covers it");
        assert!(!allowed(&fs, "/w/a.txt"));
    }

    #[test]
    fn zzz_home_paths_are_every_dotzzz_but_the_app_dirs_own() {
        let app = Path::new("/home/u/.zzz/.zzz");
        for path in [
            "/home/u/.zzz",
            "/home/u/.zzz/run",
            "/w/.zzz",
            "/w/.zzz/inner",
            "/home/u/.zzz/.zzz/sub/.zzz",
            "/home/u/.zzz/other",
        ] {
            assert_eq!(
                protected_dir(Path::new(path), app),
                Some(ProtectedDir::ZzzHome),
                "{path}"
            );
        }
        for path in [
            "/home/u/.zzz/.zzz",
            "/home/u/.zzz/.zzz/state",
            "/home/u",
            "/w/.zzzz",
            "/w/zzz",
            "/",
        ] {
            assert_eq!(protected_dir(Path::new(path), app), None, "{path}");
        }
        // an app dir with no `.zzz` in its path exempts nothing else
        assert_eq!(
            protected_dir(Path::new("/w/.zzz"), Path::new("/w/data")),
            Some(ProtectedDir::ZzzHome)
        );
        assert_eq!(
            protected_dir(Path::new("/w/data"), Path::new("/w/data")),
            None
        );
    }

    #[test]
    fn credential_dirs_are_protected_everywhere() {
        let app = Path::new("/home/u/.zzz/.zzz");
        for name in CREDENTIAL_DIR_NAMES {
            for path in [
                format!("/home/u/{name}"),
                format!("/home/u/{name}/id_ed25519"),
                format!("/w/project/{name}/config"),
                format!("/{name}"),
                // no exception for the app dir
                format!("/home/u/.zzz/.zzz/{name}/x"),
            ] {
                assert_eq!(
                    protected_dir(Path::new(&path), app),
                    Some(ProtectedDir::Credentials(name)),
                    "{path}"
                );
            }
        }
        // whole components only
        for path in [
            "/home/u/.sshx",
            "/home/u/ssh",
            "/home/u/x.ssh",
            "/home/u/.ssh.bak/key",
            "/home/u/.aws-notes",
            "/home/u/docker",
            "/home/u/project/.env",
        ] {
            assert_eq!(protected_dir(Path::new(path), app), None, "{path}");
        }
        // a credential directory wins over a `.zzz` one, wherever it sits
        assert_eq!(
            protected_dir(Path::new("/w/.zzz/.ssh"), app),
            Some(ProtectedDir::Credentials(".ssh"))
        );
        assert_eq!(
            protected_dir(Path::new("/w/.gnupg/.zzz"), app),
            Some(ProtectedDir::Credentials(".gnupg"))
        );
    }

    #[test]
    fn protected_dirs_name_what_they_hold() {
        let error = ScopedFsError::ProtectedDirNotAllowed {
            path: "/h/.ssh/id".to_owned(),
            dir: ProtectedDir::Credentials(".ssh"),
        };
        assert_eq!(
            error.to_string(),
            "Path is in a .ssh directory, which holds credentials (keys, tokens): /h/.ssh/id"
        );
        let error = ScopedFsError::ProtectedDirNotAllowed {
            path: "/h/.zzz/.env".to_owned(),
            dir: ProtectedDir::ZzzHome,
        };
        assert_eq!(
            error.to_string(),
            "Path is in a .zzz directory, which holds zzz's own files (secrets, tokens): /h/.zzz/.env"
        );
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

        /// The temp dir as the app dir and only root.
        fn fs(&self) -> ScopedFs {
            ScopedFs::new(self.0.clone(), &[])
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

    fn make_fifo(path: &Path) {
        let status = std::process::Command::new("mkfifo")
            .arg(path)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().mode() & 0o7777
    }

    /// Companions named `<file name>.<x>.side`, renamed to `<new name>.<x>.side`.
    fn sides(old: &str, new: &str) -> impl Fn(&str) -> Option<String> {
        let (old, new) = (format!("{old}."), format!("{new}."));
        move |name: &str| {
            name.strip_prefix(&old)
                .filter(|rest| rest.rsplit_once('.').is_some_and(|(_, ext)| ext == "side"))
                .map(|rest| format!("{new}{rest}"))
        }
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn rename_moves_the_file_and_its_companions() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let dir = tmp.path("r");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("a.webm"), "audio").unwrap();
        std::fs::write(dir.join("a.webm.m1.side"), "one").unwrap();
        std::fs::write(dir.join("a.webm.m2.side"), "two").unwrap();
        std::fs::write(dir.join("a.webm.other"), "not a companion").unwrap();
        std::fs::create_dir(dir.join("a.webm.d.side")).unwrap();
        let path = dir.join("a.webm");

        let prepared = fs
            .prepare_rename(path.to_str().unwrap(), "b.webm")
            .await
            .unwrap();
        let mut renamed = prepared.apply(sides("a.webm", "b.webm")).unwrap();

        assert_eq!(
            renamed.remove(0),
            Renamed {
                from: path,
                to: dir.join("b.webm")
            },
            "the file first"
        );
        renamed.sort_by(|a, b| a.to.cmp(&b.to));
        assert_eq!(
            renamed,
            ["m1", "m2"].map(|m| Renamed {
                from: dir.join(format!("a.webm.{m}.side")),
                to: dir.join(format!("b.webm.{m}.side")),
            })
        );
        assert_eq!(
            names_in(&dir),
            [
                "a.webm.d.side",
                "a.webm.other",
                "b.webm",
                "b.webm.m1.side",
                "b.webm.m2.side"
            ]
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("b.webm")).unwrap(),
            "audio"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("b.webm.m2.side")).unwrap(),
            "two"
        );
    }

    #[tokio::test]
    async fn rename_skips_symlinks_and_finishes_a_crashed_rename() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let dir = tmp.path("r");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("a.webm");
        std::fs::write(&path, "audio").unwrap();
        std::fs::write(dir.join("a.webm.m.side"), "side").unwrap();
        // a crashed rename's link, already at the companion's new name
        std::fs::hard_link(dir.join("a.webm.m.side"), dir.join("b.webm.m.side")).unwrap();
        // a symlink named like a companion isn't one
        std::os::unix::fs::symlink("/etc/hostname", dir.join("a.webm.s.side")).unwrap();

        let renamed = fs
            .prepare_rename(path.to_str().unwrap(), "b.webm")
            .await
            .unwrap()
            .apply(sides("a.webm", "b.webm"))
            .unwrap();

        assert_eq!(renamed.len(), 2, "{renamed:?}");
        assert_eq!(names_in(&dir), ["a.webm.s.side", "b.webm", "b.webm.m.side"]);
        assert!(
            std::fs::symlink_metadata(dir.join("a.webm.s.side"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "the symlink untouched"
        );
    }

    #[tokio::test]
    async fn a_refused_rename_keeps_a_link_it_took_but_did_not_make() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let dir = tmp.path("r");
        std::fs::create_dir(&dir).unwrap();
        // a hard-linked twin recording, its sidecar linked too — `b.webm`'s real one
        std::fs::write(dir.join("a.webm"), "audio").unwrap();
        std::fs::write(dir.join("a.webm.m.side"), "side").unwrap();
        std::fs::hard_link(dir.join("a.webm"), dir.join("b.webm")).unwrap();
        std::fs::hard_link(dir.join("a.webm.m.side"), dir.join("b.webm.m.side")).unwrap();

        let e = fs
            .prepare_rename(dir.join("a.webm").to_str().unwrap(), "b.webm")
            .await
            .unwrap()
            .apply(sides("a.webm", "b.webm"))
            .unwrap_err();

        assert!(matches!(e, ScopedFsError::AlreadyExists(_)), "{e:?}");
        assert_eq!(
            names_in(&dir),
            ["a.webm", "a.webm.m.side", "b.webm", "b.webm.m.side"],
            "b.webm keeps its sidecar"
        );
    }

    #[tokio::test]
    async fn rename_never_replaces_and_leaves_nothing_behind_when_refused() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let dir = tmp.path("r");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("a.webm");

        // the new name taken: refused, the companion's link undone
        std::fs::write(&path, "audio").unwrap();
        std::fs::write(dir.join("a.webm.m.side"), "side").unwrap();
        std::fs::write(dir.join("b.webm"), "taken").unwrap();
        let prepared = fs
            .prepare_rename(path.to_str().unwrap(), "b.webm")
            .await
            .unwrap();
        let e = prepared.apply(sides("a.webm", "b.webm")).unwrap_err();
        assert!(matches!(e, ScopedFsError::AlreadyExists(_)), "{e:?}");
        assert_eq!(names_in(&dir), ["a.webm", "a.webm.m.side", "b.webm"]);
        assert_eq!(
            std::fs::read_to_string(dir.join("b.webm")).unwrap(),
            "taken"
        );

        // a companion's new name taken: refused before the file moves
        std::fs::remove_file(dir.join("b.webm")).unwrap();
        std::fs::write(dir.join("a.webm.n.side"), "side").unwrap();
        std::fs::write(dir.join("b.webm.n.side"), "taken").unwrap();
        let prepared = fs
            .prepare_rename(path.to_str().unwrap(), "b.webm")
            .await
            .unwrap();
        let e = prepared.apply(sides("a.webm", "b.webm")).unwrap_err();
        assert!(matches!(e, ScopedFsError::AlreadyExists(_)), "{e:?}");
        assert_eq!(
            names_in(&dir),
            ["a.webm", "a.webm.m.side", "a.webm.n.side", "b.webm.n.side"]
        );
    }

    #[tokio::test]
    async fn rename_refuses_bad_names_directories_and_missing_files() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let dir = tmp.path("r");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        let path = dir.join("a.txt");
        let path = path.to_str().unwrap();
        for name in ["", ".", "..", "x/y", "../a.txt", "a\0b", "a.txt"] {
            let e = fs.prepare_rename(path, name).await.unwrap_err();
            assert!(
                matches!(e, ScopedFsError::InvalidPath(_)),
                "{name:?}: {e:?}"
            );
        }
        let sub = dir.join("sub");
        let e = fs
            .prepare_rename(sub.to_str().unwrap(), "sub2")
            .await
            .unwrap()
            .apply(|_| None)
            .unwrap_err();
        assert!(matches!(e, ScopedFsError::IsADirectory(_)), "{e:?}");
        let missing = dir.join("missing.txt");
        let e = fs
            .prepare_rename(missing.to_str().unwrap(), "m2.txt")
            .await
            .unwrap()
            .apply(|_| None)
            .unwrap_err();
        assert!(
            matches!(&e, ScopedFsError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound),
            "{e:?}"
        );
        // a protected directory's name is refused as a file name too
        for name in [".ssh", ".zzz"] {
            let e = fs.prepare_rename(path, name).await.unwrap_err();
            assert!(
                matches!(e, ScopedFsError::ProtectedDirNotAllowed { .. }),
                "{name}: {e:?}"
            );
        }
        // a backslash would cut the sidecars off: no name parse reads it back
        let e = fs.prepare_rename(path, "a\\b.txt").await.unwrap_err();
        assert!(matches!(e, ScopedFsError::InvalidPath(_)), "{e:?}");
        // the file itself a symlink: refused
        std::os::unix::fs::symlink(dir.join("a.txt"), dir.join("link.txt")).unwrap();
        let e = fs
            .prepare_rename(dir.join("link.txt").to_str().unwrap(), "l2.txt")
            .await
            .unwrap_err();
        assert!(matches!(e, ScopedFsError::SymlinkNotAllowed(_)), "{e:?}");
        std::fs::remove_file(dir.join("link.txt")).unwrap();
        assert_eq!(names_in(&dir), ["a.txt", "sub"]);
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

            fs.write_file(file.to_str().unwrap(), "new".to_owned(), None)
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
    async fn write_drops_setuid_and_setgid() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        for (mode, kept) in [(0o4755, 0o755), (0o2755, 0o755), (0o6750, 0o750)] {
            let file = tmp.path(&format!("mode_{mode:o}.sh"));
            std::fs::write(&file, "old").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
            if mode_of(&file) != mode {
                continue; // the filesystem refused the bits (e.g. nosuid)
            }

            fs.write_file(file.to_str().unwrap(), "new".to_owned(), None)
                .await
                .unwrap();

            assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
            assert_eq!(mode_of(&file), kept, "mode {mode:o} → {kept:o}");
        }
    }

    #[tokio::test]
    async fn write_creates_missing_files_and_parents() {
        let tmp = TempDir::new();
        let file = tmp.path("a/b/new.txt");
        tmp.fs()
            .write_file(file.to_str().unwrap(), "hi".to_owned(), None)
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
        let result = write_file_atomic_with(&file, None, |f| {
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
            fs.write_file(fifo.to_str().unwrap(), "x".to_owned(), None),
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
        let dir = std::fs::File::open(socket.parent().unwrap()).unwrap();
        // bind through the dir's fd: a socket's path must fit in `sun_path`,
        // which a long `TMPDIR` overflows
        let _listener = std::os::unix::net::UnixListener::bind(format!(
            "/proc/self/fd/{}/socket",
            std::os::fd::AsRawFd::as_raw_fd(&dir)
        ))
        .unwrap();
        let result = fs
            .write_file(socket.to_str().unwrap(), "x".to_owned(), None)
            .await;
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );

        let dir = tmp.path("dir");
        std::fs::create_dir(&dir).unwrap();
        let result = fs
            .write_file(dir.to_str().unwrap(), "x".to_owned(), None)
            .await;
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

        let result = write_file_atomic_with(&link, None, |f| f.write_all(b"x"));
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
            .write_file(file.to_str().unwrap(), "new".to_owned(), None)
            .await
            .unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "old");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_writes_never_interleave() {
        let tmp = TempDir::new();
        let fs = Arc::new(tmp.fs());
        let file = tmp.path("f.txt");
        let path = file.to_str().unwrap().to_owned();
        let long = "L".repeat(64 * 1024);
        let short = "S".repeat(10);
        for _ in 0..200 {
            let writes = [long.clone(), short.clone()].map(|content| {
                let fs = Arc::clone(&fs);
                let path = path.clone();
                tokio::spawn(async move { fs.write_file(&path, content, None).await })
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
            fs.write_file("relative.txt", String::new(), None).await,
            Err(ScopedFsError::InvalidPath(_))
        ));
        assert!(matches!(
            fs.write_file("/tmp/a\0b", String::new(), None).await,
            Err(ScopedFsError::InvalidPath(_))
        ));
        assert!(matches!(
            fs.write_file("/definitely/not/in/scope.txt", String::new(), None)
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
        match fs.create_dir(file.to_str().unwrap()).await {
            Err(ScopedFsError::AlreadyExists(_)) => {}
            other => panic!("expected AlreadyExists, got {other:?}"),
        }
        // an ancestor that's a file
        match fs.create_dir(file.join("sub").to_str().unwrap()).await {
            Err(ScopedFsError::Io { source, .. }) => {
                assert_eq!(source.kind(), std::io::ErrorKind::NotADirectory);
            }
            other => panic!("expected NotADirectory, got {other:?}"),
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
            .write_file(file.to_str().unwrap(), "NEW".to_owned(), None)
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
            .write_file(file.to_str().unwrap(), "NEW".to_owned(), None)
            .await;
        let new_file = dir.join("new.txt");
        let created = fs
            .write_file(new_file.to_str().unwrap(), "x".to_owned(), None)
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

        let result = write_in_place(handle, None, &|f| f.write_all(b"NEW"), &file);
        assert!(
            matches!(result, Err(ScopedFsError::ReplacedDuringSave(_))),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs");

        // removed outright
        let handle = open_for_write_in_place(&file).unwrap();
        std::fs::remove_file(&file).unwrap();
        let result = write_in_place(handle, None, &|f| f.write_all(b"NEW"), &file);
        assert!(
            matches!(result, Err(ScopedFsError::ReplacedDuringSave(_))),
            "{result:?}"
        );
        assert!(!file.exists());
    }

    fn expect(content: &[u8], max_size: u64) -> ExpectedContent {
        ExpectedContent {
            hash: blake3::hash(content),
            max_size,
        }
    }

    #[tokio::test]
    async fn a_save_with_expected_content_is_a_compare_and_swap() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let file = tmp.path("cas.txt");
        let path = file.to_str().unwrap();
        std::fs::write(&file, "old").unwrap();

        // the bytes it was based on: written
        fs.write_file(path, "new".to_owned(), Some(expect(b"old", 100)))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");

        // based on bytes the file no longer holds: refused, untouched
        let stale = fs
            .write_file(path, "mine".to_owned(), Some(expect(b"old", 100)))
            .await;
        assert!(
            matches!(&stale, Err(ScopedFsError::DiskChanged(p)) if p == path),
            "{stale:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");

        // larger than the content could be: refused without matching the hash
        let over = fs
            .write_file(path, "mine".to_owned(), Some(expect(b"new", 2)))
            .await;
        assert!(
            matches!(over, Err(ScopedFsError::DiskChanged(_))),
            "{over:?}"
        );
        // at the size exactly: compared
        fs.write_file(path, "at".to_owned(), Some(expect(b"new", 3)))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "at");

        // gone: refused, and nothing created — not the file, not its directory
        let gone = tmp.path("sub/gone.txt");
        let result = fs
            .write_file(
                gone.to_str().unwrap(),
                "x".to_owned(),
                Some(expect(b"", 100)),
            )
            .await;
        assert!(
            matches!(result, Err(ScopedFsError::DiskChanged(_))),
            "{result:?}"
        );
        assert!(!tmp.path("sub").exists());

        // no compare: written whatever is there, as before
        fs.write_file(path, "plain".to_owned(), None).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "plain");
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[test]
    fn the_compare_runs_after_staging_right_before_the_rename() {
        let tmp = TempDir::new();
        let file = tmp.path("late.txt");
        std::fs::write(&file, "old").unwrap();
        // an external write landing while the content is staged — after any
        // earlier check would have passed
        let result = write_file_atomic_with(&file, Some(&expect(b"old", 100)), |f| {
            std::fs::write(&file, "theirs")?;
            f.write_all(b"mine")
        });
        assert!(
            matches!(result, Err(ScopedFsError::DiskChanged(_))),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs");
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[test]
    fn a_symlink_or_fifo_swapped_in_before_the_compare_keeps_its_own_error() {
        let tmp = TempDir::new();
        let file = tmp.path("swap.txt");
        let other = tmp.path("other.txt");
        std::fs::write(&other, "elsewhere").unwrap();

        // a symlink swapped in while the content is staged: refused unfollowed
        std::fs::write(&file, "old").unwrap();
        let result = write_file_atomic_with(&file, Some(&expect(b"old", 100)), |f| {
            std::fs::remove_file(&file)?;
            std::os::unix::fs::symlink(&other, &file)?;
            f.write_all(b"mine")
        });
        assert!(
            matches!(result, Err(ScopedFsError::SymlinkNotAllowed(_))),
            "{result:?}"
        );
        assert!(file.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "elsewhere");
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());

        // a FIFO: refused without blocking the compare's open
        std::fs::remove_file(&file).unwrap();
        std::fs::write(&file, "old").unwrap();
        let result = write_file_atomic_with(&file, Some(&expect(b"old", 100)), |f| {
            std::fs::remove_file(&file)?;
            make_fifo(&file);
            f.write_all(b"mine")
        });
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );
        assert!(file.symlink_metadata().unwrap().file_type().is_fifo());
        assert!(tmp.temp_files().is_empty(), "{:?}", tmp.temp_files());
    }

    #[test]
    fn the_in_place_fallback_compares_before_it_truncates() {
        let tmp = TempDir::new();
        let file = tmp.path("w.txt");
        std::fs::write(&file, "orig").unwrap();

        let handle = open_for_write_in_place(&file).unwrap();
        std::fs::write(&file, "theirs").unwrap();
        let result = write_in_place(
            handle,
            Some(&expect(b"orig", 100)),
            &|f| f.write_all(b"NEW"),
            &file,
        );
        assert!(
            matches!(result, Err(ScopedFsError::DiskChanged(_))),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs");

        let handle = open_for_write_in_place(&file).unwrap();
        write_in_place(
            handle,
            Some(&expect(b"theirs", 100)),
            &|f| f.write_all(b"NEW"),
            &file,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "NEW");
    }

    #[test]
    fn errors_name_the_target_not_the_temp_file() {
        let tmp = TempDir::new();
        let file = tmp.path("keep.txt");
        std::fs::write(&file, "original").unwrap();
        let result = write_file_atomic_with(&file, None, |_| Err(std::io::Error::other("boom")));
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

    #[tokio::test]
    async fn create_file_takes_bytes_that_are_not_utf8() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let file = tmp.path("clip.webm");
        let bytes = vec![0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x00];
        fs.create_file(file.to_str().unwrap(), bytes.clone())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }

    #[tokio::test]
    async fn append_writes_only_at_the_expected_size() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let file = tmp.path("grow.bin");
        let path = file.to_str().unwrap();
        fs.create_file(path, Vec::new()).await.unwrap();

        assert_eq!(fs.append_file(path, 0, b"abc".to_vec()).await.unwrap(), 3);
        assert_eq!(fs.append_file(path, 3, b"de".to_vec()).await.unwrap(), 5);
        // an empty chunk is a size check
        assert_eq!(fs.append_file(path, 5, Vec::new()).await.unwrap(), 5);

        // a retried chunk, a skipped one, and one behind all write nothing
        for stale in [3, 9, 0] {
            let result = fs.append_file(path, stale, b"zz".to_vec()).await;
            assert!(
                matches!(result, Err(ScopedFsError::OffsetMismatch { size: 5, .. })),
                "{stale}: {result:?}"
            );
        }
        assert_eq!(std::fs::read(&file).unwrap(), b"abcde");
    }

    #[tokio::test]
    async fn append_never_creates_and_refuses_what_is_not_a_regular_file() {
        let tmp = TempDir::new();
        let fs = tmp.fs();

        let missing = tmp.path("missing.bin");
        let result = fs
            .append_file(missing.to_str().unwrap(), 0, b"x".to_vec())
            .await;
        assert!(
            matches!(&result, Err(ScopedFsError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound),
            "{result:?}"
        );
        assert!(!missing.exists());

        let dir = tmp.path("dir");
        std::fs::create_dir(&dir).unwrap();
        let result = fs
            .append_file(dir.to_str().unwrap(), 0, b"x".to_vec())
            .await;
        assert!(
            matches!(&result, Err(ScopedFsError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::IsADirectory),
            "{result:?}"
        );

        // a FIFO with no reader would block a plain open for writing
        let fifo = tmp.path("fifo");
        make_fifo(&fifo);
        let result = fs
            .append_file(fifo.to_str().unwrap(), 0, b"x".to_vec())
            .await;
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );

        let target = tmp.path("target.bin");
        std::fs::write(&target, b"keep").unwrap();
        let link = tmp.path("link.bin");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let result = fs
            .append_file(link.to_str().unwrap(), 4, b"x".to_vec())
            .await;
        assert!(
            matches!(result, Err(ScopedFsError::SymlinkNotAllowed(_))),
            "{result:?}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");

        let outside = fs.append_file("/etc/hostname", 0, b"x".to_vec()).await;
        assert!(
            matches!(outside, Err(ScopedFsError::PathNotAllowed(_))),
            "{outside:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_appends_at_one_offset_land_exactly_once() {
        let tmp = TempDir::new();
        let fs = Arc::new(tmp.fs());
        let file = tmp.path("race.bin");
        let path = file.to_str().unwrap().to_owned();
        fs.create_file(&path, Vec::new()).await.unwrap();

        let chunk = vec![7_u8; 64 * 1024];
        let tasks: Vec<_> = (0..16)
            .map(|_| {
                let fs = Arc::clone(&fs);
                let path = path.clone();
                let chunk = chunk.clone();
                tokio::spawn(async move { fs.append_file(&path, 0, chunk).await })
            })
            .collect();
        let mut landed = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(size) => {
                    assert_eq!(size, chunk.len() as u64);
                    landed += 1;
                }
                Err(ScopedFsError::OffsetMismatch { size, .. }) => {
                    assert_eq!(size, chunk.len() as u64);
                }
                Err(e) => panic!("unexpected error: {e:?}"),
            }
        }
        assert_eq!(landed, 1);
        assert_eq!(std::fs::read(&file).unwrap(), chunk);
    }

    #[tokio::test]
    async fn open_file_returns_regular_files_only() {
        let tmp = TempDir::new();
        let fs = tmp.fs();

        let file = tmp.path("data.bin");
        std::fs::write(&file, b"hello").unwrap();
        let (mut opened, meta) = fs.open_file(file.to_str().unwrap()).await.unwrap();
        assert_eq!(meta.len(), 5);
        let mut content = Vec::new();
        std::io::Read::read_to_end(&mut opened, &mut content).unwrap();
        assert_eq!(content, b"hello");

        let dir = tmp.path("dir");
        std::fs::create_dir(&dir).unwrap();
        let result = fs.open_file(dir.to_str().unwrap()).await;
        assert!(
            matches!(result, Err(ScopedFsError::IsADirectory(_))),
            "{result:?}"
        );

        let fifo = tmp.path("fifo");
        make_fifo(&fifo);
        let result = fs.open_file(fifo.to_str().unwrap()).await;
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );

        // `open(2)` refuses a socket outright (`ENXIO`), before any `fstat`
        let socket = tmp.path("socket");
        let dir = std::fs::File::open(socket.parent().unwrap()).unwrap();
        // bind through the dir's fd: a socket's path must fit in `sun_path`,
        // which a long `TMPDIR` overflows
        let _listener = std::os::unix::net::UnixListener::bind(format!(
            "/proc/self/fd/{}/socket",
            std::os::fd::AsRawFd::as_raw_fd(&dir)
        ))
        .unwrap();
        let result = fs.open_file(socket.to_str().unwrap()).await;
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );

        let link = tmp.path("link.bin");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let result = fs.open_file(link.to_str().unwrap()).await;
        assert!(
            matches!(result, Err(ScopedFsError::SymlinkNotAllowed(_))),
            "{result:?}"
        );

        let result = fs.open_file(tmp.path("missing").to_str().unwrap()).await;
        assert!(
            matches!(&result, Err(ScopedFsError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound),
            "{result:?}"
        );

        let outside = fs.open_file("/etc/hostname").await;
        assert!(
            matches!(outside, Err(ScopedFsError::PathNotAllowed(_))),
            "{outside:?}"
        );
    }

    #[tokio::test]
    async fn create_dir_never_reuses_anything() {
        let tmp = TempDir::new();
        let fs = tmp.fs();
        let dir = tmp.path("a/b/new");
        fs.create_dir(dir.to_str().unwrap()).await.unwrap();
        assert!(dir.is_dir(), "created with its missing parents");
        std::fs::write(dir.join("kept.txt"), "x").unwrap();

        let again = fs.create_dir(dir.to_str().unwrap()).await;
        assert!(
            matches!(&again, Err(ScopedFsError::AlreadyExists(path)) if path == dir.to_str().unwrap()),
            "{again:?}"
        );
        assert!(dir.join("kept.txt").exists(), "untouched");

        // a symlink at the name is refused by path validation, not followed
        let link = tmp.path("a/b/link");
        std::os::unix::fs::symlink(tmp.path("nowhere"), &link).unwrap();
        let result = fs.create_dir(link.to_str().unwrap()).await;
        assert!(
            matches!(result, Err(ScopedFsError::SymlinkNotAllowed(_))),
            "{result:?}"
        );
        assert!(!tmp.path("nowhere").exists());

        // an existing parent is fine — only the final name must be free
        let sibling = tmp.path("a/b/sibling");
        fs.create_dir(sibling.to_str().unwrap()).await.unwrap();
        assert!(sibling.is_dir());

        let ro = tmp.path("ro");
        std::fs::create_dir(&ro).unwrap();
        set_mode(&ro, 0o555);
        let in_ro = ro.join("sub");
        let result = fs.create_dir(in_ro.to_str().unwrap()).await;
        let ro_writable_anyway = writable_anyway(&ro.join(".probe"));
        set_mode(&ro, 0o755);
        if !ro_writable_anyway {
            assert!(
                matches!(result, Err(ScopedFsError::DirectoryNotWritable(_))),
                "{result:?}"
            );
            assert!(!in_ro.exists());
        }
    }

    // -- protected directories --

    /// The CLI's layout under a temp dir: the temp dir is a scoped root that
    /// covers `home/.zzz/` (a daemon home, holding `.env`), and the app dir is
    /// `home/.zzz/.zzz/`.
    fn daemon_home() -> (TempDir, ScopedFs) {
        let tmp = TempDir::new();
        let app_dir = tmp.path("home/.zzz/.zzz");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(tmp.path("home/.zzz/.env"), "SECRET=x").unwrap();
        let fs = ScopedFs::new(app_dir, std::slice::from_ref(&tmp.0));
        (tmp, fs)
    }

    fn assert_protected_refused<T: std::fmt::Debug>(
        result: &Result<T, ScopedFsError>,
        expected: ProtectedDir,
        op: &str,
        path: &str,
    ) {
        assert!(
            matches!(result, Err(ScopedFsError::ProtectedDirNotAllowed { dir, .. }) if *dir == expected),
            "{op} {path}: {result:?}"
        );
    }

    /// Run every public operation on `path`, each expected to be refused for
    /// the `expected` protected directory. An append is sent at the file's
    /// current size, so only the refusal can stop it.
    async fn assert_every_op_refused_for(fs: &ScopedFs, path: &str, expected: ProtectedDir) {
        let size = std::fs::symlink_metadata(path).map_or(0, |m| m.len());
        let source = std::fs::File::open("/dev/null").unwrap();
        let p = path;
        assert_protected_refused(&fs.open_file(p).await, expected, "open_file", p);
        let result = fs.write_file(p, "new".to_owned(), None).await;
        assert_protected_refused(&result, expected, "write_file", p);
        let result = fs.write_file_from(p, source).await;
        assert_protected_refused(&result, expected, "write_file_from", p);
        let result = fs.create_file(p, b"new".to_vec()).await;
        assert_protected_refused(&result, expected, "create_file", p);
        let result = fs.append_file(p, size, b"new".to_vec()).await;
        assert_protected_refused(&result, expected, "append_file", p);
        assert_protected_refused(&fs.create_dir(p).await, expected, "create_dir", p);
        assert_protected_refused(&fs.rm(p).await, expected, "rm", p);
    }

    async fn assert_every_op_refused(fs: &ScopedFs, path: &str) {
        assert_every_op_refused_for(fs, path, ProtectedDir::ZzzHome).await;
    }

    /// Every entry under `dir`, recursively, as paths relative to it.
    fn tree(dir: &Path) -> Vec<String> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                out.push(path.strip_prefix(root).unwrap().display().to_string());
                if std::fs::symlink_metadata(&path).unwrap().is_dir() {
                    walk(root, &path, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    #[tokio::test]
    async fn every_operation_refuses_a_zzz_home_under_a_root() {
        let (tmp, fs) = daemon_home();
        let root = tmp.0.to_str().unwrap();
        let before = tree(&tmp.0);
        for path in [
            // the daemon home's files, existing or not, and the home itself
            format!("{root}/home/.zzz/.env"),
            format!("{root}/home/.zzz/run/daemon.json"),
            format!("{root}/home/.zzz"),
            format!("{root}/home/.zzz/"),
            // however it's spelled
            format!("{root}/sub/../home/.zzz/.env"),
            format!("{root}/home/./.zzz/./.env"),
            format!("{root}/home/.zzz/.zzz/../.env"),
            // a `.zzz` below the app dir, and another daemon's app dir
            format!("{root}/home/.zzz/.zzz/sub/.zzz/x"),
            format!("{root}/other/.zzz"),
            format!("{root}/other/.zzz/new.txt"),
        ] {
            assert_every_op_refused(&fs, &path).await;
        }
        assert_eq!(tree(&tmp.0), before, "nothing created or removed");
        assert_eq!(
            std::fs::read_to_string(tmp.path("home/.zzz/.env")).unwrap(),
            "SECRET=x",
            "untouched"
        );
    }

    #[tokio::test]
    async fn a_zzz_home_is_refused_before_the_filesystem_is_touched() {
        let (tmp, fs) = daemon_home();
        let root = tmp.0.to_str().unwrap();

        // an existing file and a missing one answer alike, naming the
        // normalized path
        for (path, named) in [
            (format!("{root}/home/.zzz/.env"), "home/.zzz/.env"),
            (format!("{root}/home/.zzz/missing"), "home/.zzz/missing"),
            (format!("{root}/x/../home/.zzz/.env"), "home/.zzz/.env"),
        ] {
            let result = fs.open_file(&path).await;
            assert!(
                matches!(&result, Err(ScopedFsError::ProtectedDirNotAllowed { path: p, dir: ProtectedDir::ZzzHome })
                    if *p == tmp.path(named).to_string_lossy()),
                "{path}: {result:?}"
            );
        }

        // where an `lstat` would fail or a symlink would be refused, the
        // `.zzz` refusal comes first — nothing was looked up
        std::fs::write(tmp.path("file.txt"), "f").unwrap();
        std::os::unix::fs::symlink(tmp.path("home"), tmp.path("home_link")).unwrap();
        for path in [
            format!("{root}/file.txt/.zzz/x"),
            format!("{root}/home_link/.zzz/.env"),
            "/zzz_scoped_fs_test_no_such_root/.zzz/x".to_owned(),
        ] {
            assert_every_op_refused(&fs, &path).await;
        }
        assert!(
            !tmp.path("home/.zzz/new.txt").exists() && !tmp.path("file.txt/.zzz").exists(),
            "nothing created"
        );
    }

    #[tokio::test]
    async fn the_app_dir_stays_usable_inside_a_zzz_home() {
        let (tmp, fs) = daemon_home();
        let app = tmp.path("home/.zzz/.zzz");
        let app = app.to_str().unwrap();

        fs.create_dir(&format!("{app}/recordings")).await.unwrap();
        let file = format!("{app}/recordings/a.txt");
        fs.create_file(&file, b"a".to_vec()).await.unwrap();
        fs.write_file(&file, "b".to_owned(), None).await.unwrap();
        assert_eq!(fs.append_file(&file, 1, b"c".to_vec()).await.unwrap(), 2);
        let (mut opened, _) = fs.open_file(&file).await.unwrap();
        let mut content = String::new();
        std::io::Read::read_to_string(&mut opened, &mut content).unwrap();
        assert_eq!(content, "bc");
        fs.write_file_from(&file, opened).await.unwrap();
        fs.write_file(&format!("{app}/recordings/../b.txt"), "x".to_owned(), None)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(format!("{app}/b.txt")).unwrap(),
            "x"
        );
        fs.rm(&file).await.unwrap();

        // the app dir itself is an ordinary path: taken, not refused
        let again = fs.create_dir(app).await;
        assert!(
            matches!(again, Err(ScopedFsError::AlreadyExists(_))),
            "{again:?}"
        );
    }

    /// A root holding a credential directory of each name, each with a key
    /// file in it, and the app dir beside them.
    fn credential_dirs() -> (TempDir, ScopedFs) {
        let tmp = TempDir::new();
        let app_dir = tmp.path("app");
        std::fs::create_dir_all(&app_dir).unwrap();
        for name in CREDENTIAL_DIR_NAMES {
            std::fs::create_dir_all(tmp.path(&format!("home/{name}"))).unwrap();
            std::fs::write(tmp.path(&format!("home/{name}/key")), "SECRET").unwrap();
        }
        let fs = ScopedFs::new(app_dir, std::slice::from_ref(&tmp.0));
        (tmp, fs)
    }

    #[tokio::test]
    async fn every_operation_refuses_a_credential_dir_under_a_root() {
        let (tmp, fs) = credential_dirs();
        let root = tmp.0.to_str().unwrap();
        std::fs::write(tmp.path("file.txt"), "f").unwrap();
        std::os::unix::fs::symlink(tmp.path("home"), tmp.path("home_link")).unwrap();
        let before = tree(&tmp.0);
        for name in CREDENTIAL_DIR_NAMES {
            let expected = ProtectedDir::Credentials(name);
            for path in [
                // the directory, its files, existing or not
                format!("{root}/home/{name}"),
                format!("{root}/home/{name}/"),
                format!("{root}/home/{name}/key"),
                format!("{root}/home/{name}/missing/new.txt"),
                // however it's spelled
                format!("{root}/x/../home/{name}/key"),
                format!("{root}/home/./{name}/./key"),
                format!("{root}/home/{name}/sub/../key"),
                // one that doesn't exist, under the app dir and nested deep
                format!("{root}/app/{name}"),
                format!("{root}/a/b/{name}/c"),
                // where an `lstat` would fail or a symlink would be refused,
                // or no root covers it, the refusal comes first
                format!("{root}/file.txt/{name}/x"),
                format!("{root}/home_link/{name}/key"),
                format!("/zzz_scoped_fs_test_no_such_root/{name}/x"),
            ] {
                assert_every_op_refused_for(&fs, &path, expected).await;
            }
        }
        assert_eq!(tree(&tmp.0), before, "nothing created or removed");
        for name in CREDENTIAL_DIR_NAMES {
            assert_eq!(
                std::fs::read_to_string(tmp.path(&format!("home/{name}/key"))).unwrap(),
                "SECRET",
                "untouched"
            );
        }

        // an existing file and a missing one answer alike, naming the
        // normalized path
        for (path, named) in [
            (format!("{root}/home/.ssh/key"), "home/.ssh/key"),
            (format!("{root}/home/.ssh/missing"), "home/.ssh/missing"),
            (format!("{root}/x/../home/.ssh/key"), "home/.ssh/key"),
        ] {
            let result = fs.open_file(&path).await;
            assert!(
                matches!(&result, Err(ScopedFsError::ProtectedDirNotAllowed { path: p, dir: ProtectedDir::Credentials(".ssh") })
                    if *p == tmp.path(named).to_string_lossy()),
                "{path}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn names_like_a_credential_dir_stay_usable() {
        let (tmp, fs) = credential_dirs();
        let root = tmp.0.to_str().unwrap();
        for dir in [".sshx", "ssh", "x.ssh", "docker", ".aws-notes"] {
            fs.create_dir(&format!("{root}/{dir}")).await.unwrap();
            let file = format!("{root}/{dir}/a.txt");
            fs.create_file(&file, b"a".to_vec()).await.unwrap();
            fs.write_file(&file, "b".to_owned(), None).await.unwrap();
            fs.open_file(&file).await.unwrap();
            fs.rm(&file).await.unwrap();
        }
        // `.env` files stay readable
        std::fs::write(tmp.path(".env"), "X=1").unwrap();
        fs.open_file(&format!("{root}/.env")).await.unwrap();
    }

    // -- open errors --

    #[test]
    fn open_errors_name_a_special_file_only_when_it_is_one() {
        let tmp = TempDir::new();
        let file = tmp.path("file.txt");
        std::fs::write(&file, "x").unwrap();
        let fifo = tmp.path("fifo");
        make_fifo(&fifo);
        let enxio = || std::io::Error::from_raw_os_error(libc::ENXIO);

        // `ENXIO` from a filesystem's own open of a regular file is an I/O error
        let result = open_error(&file, enxio());
        assert!(
            matches!(&result, ScopedFsError::Io { source, .. }
                if source.raw_os_error() == Some(libc::ENXIO)),
            "{result:?}"
        );
        // and from an open of something else, or of a path gone since, too
        let result = open_error(&tmp.path("missing"), enxio());
        assert!(matches!(result, ScopedFsError::Io { .. }), "{result:?}");
        let result = open_error(&fifo, enxio());
        assert!(
            matches!(result, ScopedFsError::NotARegularFile(_)),
            "{result:?}"
        );
        let result = open_error(&file, std::io::Error::from_raw_os_error(libc::ELOOP));
        assert!(
            matches!(result, ScopedFsError::SymlinkNotAllowed(_)),
            "{result:?}"
        );
    }

    /// Both open sites agree: a FIFO with no reader, swapped in after the
    /// `lstat` a write starts with, fails its open with `ENXIO`.
    #[test]
    fn a_fifo_swapped_in_before_the_write_open_is_not_a_regular_file() {
        let tmp = TempDir::new();
        let fifo = tmp.path("fifo");
        make_fifo(&fifo);
        let result = open_for_write_in_place(&fifo);
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
            "{result:?}"
        );
        let result = open_regular_file(&fifo, true);
        assert!(
            matches!(result, Err(ScopedFsError::NotARegularFile(_))),
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
    async fn write_file_after_closing_a_project_on_permanent_root() {
        let dir = std::env::temp_dir().join(format!("zzz_scoped_fs_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let fs = ScopedFs::new(dir.clone(), &[]);

        fs.add_path(&dir);
        fs.remove_path(&dir);
        let file = dir.join("a.txt");
        let result = fs
            .write_file(file.to_str().unwrap(), "content".to_owned(), None)
            .await;
        let contents = std::fs::read_to_string(&file);
        std::fs::remove_dir_all(&dir).unwrap();

        result.unwrap();
        assert_eq!(contents.unwrap(), "content");
    }
}
