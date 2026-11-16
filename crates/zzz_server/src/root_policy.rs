//! Which directories can be roots of zzz's scoped filesystem.
//!
//! A root is a directory `ScopedFs` grants access beneath: an open workspace
//! (`workspace_open`, and so `zzz <path>`), a `PUBLIC_ZZZ_SCOPED_DIRS` entry,
//! or the app dir. [`RootPolicy`] decides which directories qualify:
//!
//! - **Never** `/`, the home directory itself or any ancestor of it, or
//!   anything under the kernel's pseudo-filesystems ([`PSEUDO_FS_DIRS`]) —
//!   whatever else is configured.
//! - **Strictly inside the home directory** otherwise, or at or inside a
//!   directory named in [`ROOTS_OUTSIDE_HOME_VAR`].
//!
//! So a workspace can't take in the whole home directory (`~/.ssh` and every
//! other dotfile with it), the whole filesystem, or `/proc/<pid>/environ` (the
//! daemon's own environment, with its secrets); a directory outside the home
//! directory needs the operator to name it.
//!
//! The app dir is exempt from the home-directory rule — it's the operator's
//! own configuration and zzz's own directory, a permanent root wherever it
//! is — but not from the floor ([`RootPolicy::check_floor`]).
//!
//! The rule is lexical, so it holds for the canonical paths (symlinks
//! resolved) it's given: the home directory is canonicalized at boot, and
//! `workspace_open` passes the canonical path. A boot entry — an allowlist
//! entry or scoped dir — is canonicalized too, unless it doesn't exist yet:
//! then it's checked as spelled, and a `..` in it refuses the boot, since
//! the OS would read that through whatever the directory before it becomes.
//! A scoped dir is checked again on its canonical path when its filer
//! starts. An allowlist entry spelled through a symlink admits no canonical
//! root, since none is spelled through one; a scoped dir missing at boot that
//! it admits as spelled is refused by that re-check.

use std::path::{Path, PathBuf};

/// The env var naming directories, outside the home directory, that roots
/// may be at or inside — comma-separated absolute paths, read like
/// `PUBLIC_ZZZ_SCOPED_DIRS`.
pub const ROOTS_OUTSIDE_HOME_VAR: &str = "ZZZ_ROOTS_OUTSIDE_HOME";

/// The kernel's pseudo-filesystems, never a root or inside one: `/proc`
/// (every process's environment and memory, the daemon's own secrets among
/// them), `/sys`, and `/dev`.
pub const PSEUDO_FS_DIRS: &[&str] = &["/proc", "/sys", "/dev"];

/// Why a directory can't be a root.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RootRefusal {
    /// `/` itself.
    #[error("the filesystem root / can't be a root")]
    FilesystemRoot,
    /// The home directory, or an ancestor of it — it would take in every
    /// file of the home directory, credentials included.
    #[error("the home directory {home} and its ancestors can't be roots")]
    HomeOrAncestor { home: String },
    /// At or under one of [`PSEUDO_FS_DIRS`].
    #[error("{dir} is a kernel pseudo-filesystem and can't hold a root")]
    PseudoFilesystem { dir: &'static str },
    /// Outside the home directory and not in the allowlist.
    #[error(
        "roots must be inside the home directory {home} unless {ROOTS_OUTSIDE_HOME_VAR} names them"
    )]
    OutsideHome { home: String },
    /// The home directory couldn't be resolved, and the root isn't in the
    /// allowlist.
    #[error(
        "the home directory couldn't be resolved, so only directories {ROOTS_OUTSIDE_HOME_VAR} names can be roots"
    )]
    NoHome,
}

impl RootRefusal {
    /// Whether naming the directory in [`ROOTS_OUTSIDE_HOME_VAR`] would admit
    /// it — the operator's fix — rather than its being refused outright.
    #[must_use]
    pub const fn is_outside_home(&self) -> bool {
        matches!(self, Self::OutsideHome { .. } | Self::NoHome)
    }
}

/// The rule deciding which directories can be roots (see the module docs).
///
/// The default has no home directory and an empty allowlist, so it admits
/// nothing: what an `App` gets until the boot sets the configured one.
#[derive(Debug, Clone, Default)]
pub struct RootPolicy {
    /// The home directory, canonical — `None` when it couldn't be resolved
    /// ([`resolve_home`]).
    home: Option<PathBuf>,
    /// [`ROOTS_OUTSIDE_HOME_VAR`]'s directories, canonical, each passing
    /// [`Self::check_floor`].
    outside_home: Vec<PathBuf>,
}

impl RootPolicy {
    /// A policy over the canonical home directory `home` (`None` when there
    /// is none — see [`resolve_home`]) and the canonical allowlist
    /// `outside_home`.
    ///
    /// # Errors
    ///
    /// The first allowlist entry the floor refuses ([`Self::check_floor`]),
    /// with why: an allowlist can't widen what may never be a root.
    pub fn new(
        home: Option<PathBuf>,
        outside_home: Vec<PathBuf>,
    ) -> Result<Self, (PathBuf, RootRefusal)> {
        let policy = Self {
            home,
            outside_home: Vec::new(),
        };
        for dir in &outside_home {
            policy
                .check_floor(dir)
                .map_err(|refusal| (dir.clone(), refusal))?;
        }
        Ok(Self {
            outside_home,
            ..policy
        })
    }

    /// The home directory roots must be inside, if one was resolved.
    #[must_use]
    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// The allowlisted directories outside the home directory
    /// ([`ROOTS_OUTSIDE_HOME_VAR`]), canonical.
    #[must_use]
    pub fn outside_home(&self) -> &[PathBuf] {
        &self.outside_home
    }

    /// The directories that never hold a root, allowlisted or not: `/`, the
    /// home directory and its ancestors, and the pseudo-filesystems.
    ///
    /// # Errors
    ///
    /// The [`RootRefusal`] naming which.
    pub fn check_floor(&self, root: &Path) -> Result<(), RootRefusal> {
        if root.parent().is_none() {
            return Err(RootRefusal::FilesystemRoot);
        }
        if let Some(dir) = PSEUDO_FS_DIRS.iter().find(|dir| root.starts_with(dir)) {
            return Err(RootRefusal::PseudoFilesystem { dir });
        }
        if let Some(home) = &self.home
            && home.starts_with(root)
        {
            return Err(RootRefusal::HomeOrAncestor {
                home: home.display().to_string(),
            });
        }
        Ok(())
    }

    /// Whether `root` (canonical) can be a root: past the floor
    /// ([`Self::check_floor`]), and strictly inside the home directory or at
    /// or inside an allowlisted directory.
    ///
    /// # Errors
    ///
    /// The [`RootRefusal`] naming why not.
    pub fn admit(&self, root: &Path) -> Result<(), RootRefusal> {
        self.check_floor(root)?;
        // the floor refused the home directory itself, so this is strictly
        // inside it
        if self
            .home
            .as_ref()
            .is_some_and(|home| root.starts_with(home))
            || self.outside_home.iter().any(|dir| root.starts_with(dir))
        {
            return Ok(());
        }
        Err(self
            .home
            .as_ref()
            .map_or(RootRefusal::NoHome, |home| RootRefusal::OutsideHome {
                home: home.display().to_string(),
            }))
    }
}

/// The canonical home directory from `home` (`fuz_sys::home_dir()`'s
/// answer: `$HOME`, or the password database's entry when it's unset), or
/// why there is none.
///
/// Refuse, don't guess: a home that is unusable (empty or relative), missing,
/// not a directory, or `/` itself (which would make "inside the home
/// directory" mean anywhere) is no home, and only allowlisted directories can
/// be roots.
///
/// # Errors
///
/// A message naming why the home directory is unusable.
pub fn resolve_home(home: Result<PathBuf, fuz_sys::HomeDirError>) -> Result<PathBuf, String> {
    let home = home.map_err(|e| e.to_string())?;
    let canonical = std::fs::canonicalize(&home).map_err(|e| {
        format!(
            "the home directory {} can't be resolved: {e}",
            home.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "the home directory {} is not a directory",
            home.display()
        ));
    }
    if canonical.parent().is_none() {
        return Err(format!(
            "the home directory {} resolves to /",
            home.display()
        ));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(home: Option<&str>, outside_home: &[&str]) -> RootPolicy {
        RootPolicy::new(
            home.map(PathBuf::from),
            outside_home.iter().map(PathBuf::from).collect(),
        )
        .unwrap()
    }

    fn admit(policy: &RootPolicy, root: &str) -> Result<(), RootRefusal> {
        policy.admit(Path::new(root))
    }

    #[test]
    fn roots_strictly_inside_home_are_admitted() {
        let p = policy(Some("/home/u"), &[]);
        for root in [
            "/home/u/dev",
            "/home/u/dev/x",
            "/home/u/.config",
            "/home/u/a b",
        ] {
            assert_eq!(admit(&p, root), Ok(()), "{root}");
        }
    }

    #[test]
    fn home_its_ancestors_and_slash_are_refused() {
        let p = policy(Some("/home/u"), &[]);
        let home = || RootRefusal::HomeOrAncestor {
            home: "/home/u".to_owned(),
        };
        assert_eq!(admit(&p, "/home/u"), Err(home()));
        assert_eq!(admit(&p, "/home/u/"), Err(home()));
        assert_eq!(admit(&p, "/home"), Err(home()));
        assert_eq!(admit(&p, "/"), Err(RootRefusal::FilesystemRoot));
    }

    #[test]
    fn pseudo_filesystems_are_refused() {
        let p = policy(Some("/home/u"), &[]);
        for (root, dir) in [
            ("/proc", "/proc"),
            ("/proc/1", "/proc"),
            ("/proc/self/cwd", "/proc"),
            ("/sys", "/sys"),
            ("/sys/kernel", "/sys"),
            ("/dev", "/dev"),
            ("/dev/shm", "/dev"),
        ] {
            assert_eq!(
                admit(&p, root),
                Err(RootRefusal::PseudoFilesystem { dir }),
                "{root}"
            );
        }
        // whole components: a sibling named like one is just outside home
        assert!(matches!(
            admit(&p, "/procx"),
            Err(RootRefusal::OutsideHome { .. })
        ));
    }

    #[test]
    fn roots_outside_home_need_the_allowlist() {
        let p = policy(Some("/home/u"), &[]);
        for root in [
            "/tmp/w",
            "/etc",
            "/home/other",
            "/home/u2",
            "/home/u2/x",
            "/mnt/data",
        ] {
            assert_eq!(
                admit(&p, root),
                Err(RootRefusal::OutsideHome {
                    home: "/home/u".to_owned()
                }),
                "{root}"
            );
            assert!(admit(&p, root).unwrap_err().is_outside_home());
        }
    }

    #[test]
    fn allowlisted_directories_and_their_insides_are_admitted() {
        let p = policy(Some("/home/u"), &["/mnt/data", "/tmp"]);
        for root in ["/mnt/data", "/mnt/data/x", "/tmp", "/tmp/w/y"] {
            assert_eq!(admit(&p, root), Ok(()), "{root}");
        }
        // whole components, and not their parents
        for root in ["/mnt/data2", "/mnt", "/mnt/dat"] {
            assert!(
                matches!(admit(&p, root), Err(RootRefusal::OutsideHome { .. })),
                "{root}"
            );
        }
    }

    #[test]
    fn the_floor_holds_against_the_allowlist() {
        // an allowlisted directory can't hold a pseudo-filesystem, home, or `/`
        for (entry, refusal) in [
            ("/", RootRefusal::FilesystemRoot),
            (
                "/home/u",
                RootRefusal::HomeOrAncestor {
                    home: "/home/u".to_owned(),
                },
            ),
            (
                "/home",
                RootRefusal::HomeOrAncestor {
                    home: "/home/u".to_owned(),
                },
            ),
            ("/proc", RootRefusal::PseudoFilesystem { dir: "/proc" }),
            ("/proc/1", RootRefusal::PseudoFilesystem { dir: "/proc" }),
            ("/sys/x", RootRefusal::PseudoFilesystem { dir: "/sys" }),
            ("/dev", RootRefusal::PseudoFilesystem { dir: "/dev" }),
        ] {
            let result =
                RootPolicy::new(Some(PathBuf::from("/home/u")), vec![PathBuf::from(entry)]);
            assert_eq!(
                result.map(|_| ()),
                Err((PathBuf::from(entry), refusal)),
                "{entry}"
            );
        }
        // an allowlisted directory inside home is pointless but harmless
        let p = policy(Some("/home/u"), &["/home/u/dev"]);
        assert_eq!(admit(&p, "/home/u/dev"), Ok(()));
    }

    #[test]
    fn without_a_home_only_the_allowlist_admits() {
        let p = policy(None, &["/srv/w"]);
        assert_eq!(admit(&p, "/srv/w/x"), Ok(()));
        for root in ["/home/u", "/home/u/dev", "/tmp/w"] {
            assert_eq!(admit(&p, root), Err(RootRefusal::NoHome), "{root}");
            assert!(RootRefusal::NoHome.is_outside_home());
        }
        // and the floor still holds
        assert_eq!(admit(&p, "/"), Err(RootRefusal::FilesystemRoot));
        assert_eq!(
            admit(&p, "/proc/1"),
            Err(RootRefusal::PseudoFilesystem { dir: "/proc" })
        );
        // the default admits nothing
        let default = RootPolicy::default();
        assert_eq!(admit(&default, "/home/u/dev"), Err(RootRefusal::NoHome));
    }

    #[test]
    fn refusals_outside_home_are_the_ones_the_allowlist_fixes() {
        assert!(!RootRefusal::FilesystemRoot.is_outside_home());
        assert!(
            !RootRefusal::HomeOrAncestor {
                home: "/h".to_owned()
            }
            .is_outside_home()
        );
        assert!(!RootRefusal::PseudoFilesystem { dir: "/proc" }.is_outside_home());
    }

    /// A temp dir, canonical, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zzz_root_policy_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn symlinked_spellings_resolve_before_the_check() {
        let tmp = TempDir::new();
        let home = tmp.0.join("home");
        std::fs::create_dir_all(home.join("dev")).unwrap();
        std::os::unix::fs::symlink(&home, tmp.0.join("home_link")).unwrap();
        std::os::unix::fs::symlink(&tmp.0, tmp.0.join("tmp_link")).unwrap();
        std::os::unix::fs::symlink("/proc/self", tmp.0.join("proc_link")).unwrap();
        std::os::unix::fs::symlink("/", tmp.0.join("slash_link")).unwrap();

        // a home spelled through a symlink resolves to the directory
        let resolved = resolve_home(Ok(tmp.0.join("home_link"))).unwrap();
        assert_eq!(resolved, home);
        let p = RootPolicy::new(Some(resolved), vec![]).unwrap();

        let canonical = |rel: &str| tmp.0.join(rel).canonicalize().unwrap();
        // the home and its parent, through symlinks, are still refused
        for (rel, ok) in [
            ("home_link", false),
            ("home_link/.", false),
            ("home_link/dev/..", false),
            ("tmp_link", false),
            ("slash_link", false),
            ("proc_link", false),
            ("home_link/dev", true),
            ("tmp_link/home/dev", true),
        ] {
            assert_eq!(p.admit(&canonical(rel)).is_ok(), ok, "{rel}");
        }
    }

    #[test]
    fn unusable_homes_are_no_home() {
        let tmp = TempDir::new();
        std::fs::write(tmp.0.join("file"), "x").unwrap();
        std::os::unix::fs::symlink("/", tmp.0.join("slash_link")).unwrap();
        for home in [
            Err(fuz_sys::HomeDirError::NotFound),
            Err(fuz_sys::HomeDirError::Empty),
            Ok(tmp.0.join("missing")),
            Ok(tmp.0.join("file")),
            Ok(PathBuf::from("/")),
            Ok(tmp.0.join("slash_link")),
        ] {
            let label = format!("{home:?}");
            assert!(resolve_home(home).is_err(), "{label}");
        }
        assert_eq!(resolve_home(Ok(tmp.0.clone())), Ok(tmp.0.clone()));
    }
}
