use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

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

/// Secure wrapper around filesystem operations.
///
/// Restricts all operations to specified allowed directories. Rejects
/// relative paths, path traversal, and symlinks. Mirrors the TypeScript
/// `ScopedFs` from `src/lib/server/scoped_fs.ts`.
///
/// NOTE: There is an inherent TOCTOU gap between the symlink check (`lstat`)
/// and the caller's subsequent filesystem operation. A symlink could be
/// created after validation. This is the same caveat as the Deno implementation.
pub struct ScopedFs {
    allowed_paths: RwLock<Vec<PathBuf>>,
}

impl ScopedFs {
    /// Create a new `ScopedFs` with the given allowed directory paths.
    ///
    /// Each path is normalized with a trailing `/` and must be absolute.
    pub fn new(paths: Vec<PathBuf>) -> Self {
        let allowed_paths = paths
            .into_iter()
            .map(|p| {
                let mut s = p.to_string_lossy().into_owned();
                if !s.ends_with('/') {
                    s.push('/');
                }
                PathBuf::from(s)
            })
            .collect();
        Self {
            allowed_paths: RwLock::new(allowed_paths),
        }
    }

    /// Add a path to the allowed set. No-op if already present.
    ///
    /// Mirrors `ScopedFs.add_path` in `src/lib/server/scoped_fs.ts`.
    pub fn add_path(&self, path: &Path) -> bool {
        let normalized = normalize_trailing_slash(path);
        let mut paths = self.allowed_paths.write().expect("ScopedFs lock poisoned");
        if paths.iter().any(|p| p == &normalized) {
            return false;
        }
        paths.push(normalized);
        true
    }

    /// Remove a path from the allowed set.
    ///
    /// Mirrors `ScopedFs.remove_path` in `src/lib/server/scoped_fs.ts`.
    pub fn remove_path(&self, path: &Path) -> bool {
        let normalized = normalize_trailing_slash(path);
        let mut paths = self.allowed_paths.write().expect("ScopedFs lock poisoned");
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
        let paths = self.allowed_paths.read().expect("ScopedFs lock poisoned");
        for allowed in paths.iter() {
            let allowed_str = allowed.to_string_lossy();
            if path_str.starts_with(allowed_str.as_ref())
                || path_str == allowed_str.trim_end_matches('/')
            {
                return true;
            }
        }
        false
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

/// Ensure a path has a trailing `/` for consistent allowed-path comparison.
fn normalize_trailing_slash(path: &Path) -> PathBuf {
    let mut s = path.to_string_lossy().into_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    PathBuf::from(s)
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
