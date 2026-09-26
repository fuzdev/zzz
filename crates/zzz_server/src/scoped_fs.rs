use std::path::{Component, Path, PathBuf};

use parking_lot::RwLock;

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
#[derive(Debug, thiserror::Error)]
pub enum ScopedFsError {
    #[error("Path is not allowed: {0}")]
    PathNotAllowed(String),
    #[error("Path is a symlink which is not allowed: {0}")]
    SymlinkNotAllowed(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
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
            return Err(ScopedFsError::PathNotAllowed(path.to_owned()));
        }

        // Must be absolute
        let raw = Path::new(path);
        if !raw.is_absolute() {
            return Err(ScopedFsError::PathNotAllowed(path.to_owned()));
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
            Err(e) => return Err(ScopedFsError::Io(e)),
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
                Err(e) => return Err(ScopedFsError::Io(e)),
            }
            current = parent;
        }

        Ok(normalized)
    }

    /// Write content to a file (creates parent directories if needed).
    pub async fn write_file(&self, path: &str, content: &str) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        if let Some(parent) = safe_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&safe_path, content).await?;
        Ok(())
    }

    /// Remove a file.
    pub async fn rm(&self, path: &str) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        tokio::fs::remove_file(&safe_path).await?;
        Ok(())
    }

    /// Create a directory (recursive).
    pub async fn mkdir(&self, path: &str) -> Result<(), ScopedFsError> {
        let safe_path = self.ensure_safe_path(path).await?;
        tokio::fs::create_dir_all(&safe_path).await?;
        Ok(())
    }
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

    #[tokio::test]
    async fn write_file_after_closing_workspace_on_permanent_root() {
        let dir = std::env::temp_dir().join(format!("zzz_scoped_fs_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let fs = ScopedFs::new(vec![dir.clone()]);

        fs.add_path(&dir);
        fs.remove_path(&dir);
        let file = dir.join("a.txt");
        let result = fs.write_file(file.to_str().unwrap(), "content").await;
        let contents = std::fs::read_to_string(&file);
        std::fs::remove_dir_all(&dir).unwrap();

        result.unwrap();
        assert_eq!(contents.unwrap(), "content");
    }
}
