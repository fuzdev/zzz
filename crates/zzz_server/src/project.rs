//! Resolving an opened path to the project it belongs to.
//!
//! A project is a root directory and what kind of thing it is. From an
//! opened path (a file opens its parent — a symlink to a file, its target's
//! parent), the first rule that applies decides ([`resolve_project`]):
//!
//! 1. **A registry** — a `repos.toml` found walking up by `fuz_repos`'s
//!    discovery ([`discover_registry`]), placed at the registry root it
//!    belongs to (where a link above a checkout names it, else its own
//!    directory). The walk is bounded: strictly below the home directory, or
//!    within the allowlisted root ([`RootPolicy::outside_home`]) holding the
//!    path, so a registry planted above either is never looked at. Every
//!    candidate must be outside every protected directory, trusted
//!    ([`crate::file_trust`]: the file and every directory from it up to the
//!    home directory or the allowlisted root, that one included) and, when
//!    it's a symlink, confined: its target inside the root it would make,
//!    and named by its link text through no other symlink ([`link_text_path`]).
//!    One that isn't
//!    refuses the open, before the file is read, rather than being skipped,
//!    since a skip would widen the root to a registry further up. The
//!    registry's entries are each canonicalized and confined to the root
//!    ([`EntryDir`]): one that escapes, or isn't a directory, is refused
//!    alone, and the project still resolves. A root that
//!    is inside a checkout of one of its own entries (`fuz_repos`'s
//!    `RootInEntry`, [`entry_holding_root`]) falls through to rule 2.
//! 2. **A git checkout** — the nearest directory at or above the path, inside
//!    the same bound, holding a `.git` (anything that stats, as `fuz_repos`'s
//!    discovery reads one: a directory, or a linked worktree's file).
//! 3. **The directory itself.**
//!
//! Whatever the rule, the root must pass the root rules
//! ([`crate::root_policy`]) and lie outside every protected directory
//! ([`protected_dir`]), as the opened directory must before any walk.
//!
//! A registry's root need not hold the opened path: from a linked worktree,
//! discovery places the registry where the repo's main checkout is linked,
//! anywhere inside the bound.
//!
//! Synchronous and blocking — stat calls, a registry read, and at most a few
//! git calls (discovery from a linked worktree, and the `RootInEntry`
//! check): an async caller runs it on `spawn_blocking`. The [`Git`] runner
//! is the caller's, built over the environment a terminal gets
//! (`Git::with_clean_env(terminal_env(..))`, keeping `HOME`), its version
//! checked once (`Git::check_version`); without git, discovery from a
//! linked worktree and the `RootInEntry` check find nothing.

use std::fs::File;
use std::io::Read as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use fuz_git::Git;
use fuz_repos::discover::{Bound, Candidate, discover_registry, entry_holding_root};
use fuz_repos::registry::{Entry, ValidRegistry};

use crate::file_trust::{Inode, TrustedOwner, Untrusted};
use crate::handlers::filesystem::{
    ERROR_INVALID_PATH, ERROR_NOT_A_DIRECTORY, ERROR_PATH_NOT_FOUND, ERROR_PERMISSION_DENIED,
    ERROR_PROTECTED_DIR_NOT_ALLOWED,
};
use crate::root_policy::{
    ERROR_ROOT_NOT_ALLOWED, ERROR_ROOT_OUTSIDE_HOME, RootPolicy, RootRefusal,
};
use crate::scoped_fs::{ProtectedDir, protected_dir};

/// The largest registry read; a larger one is refused unread.
pub const REGISTRY_MAX_BYTES: u64 = 1024 * 1024;

/// A registry discovery refused as untrusted ([`ProjectError::RegistryUntrusted`]).
pub const ERROR_REGISTRY_UNTRUSTED: &str = "registry_untrusted";

/// A registry that changed while it was checked — an editor's atomic save
/// mid-open, say ([`ProjectError::RegistryReplaced`]); opening again reads
/// the new one.
pub const ERROR_REGISTRY_CHANGED: &str = "registry_changed";

/// A symlinked registry whose target is outside the root it would make, or
/// whose link text may pass through another symlink
/// ([`ProjectError::RegistryNotConfined`], [`ProjectError::RegistryLinkIndirect`]).
pub const ERROR_REGISTRY_NOT_CONFINED: &str = "registry_not_confined";

/// The walk's bound can't be made: the home directory or allowlisted root is
/// gone, or holds a `:` git's ceiling can't name ([`ProjectError::BoundUnusable`]).
pub const ERROR_BOUND_UNUSABLE: &str = "bound_unusable";

/// A registry that can't be opened or read: not a regular file, too large,
/// not UTF-8 ([`ProjectError::RegistryUnreadable`]).
pub const ERROR_REGISTRY_UNREADABLE: &str = "registry_unreadable";

/// A registry that doesn't parse or breaks the registry's integrity rules
/// ([`ProjectError::RegistryInvalid`]).
pub const ERROR_REGISTRY_INVALID: &str = "registry_invalid";

/// A registry entry whose dir resolves outside the project root
/// ([`EntryRefusal::NotConfined`]).
pub const ERROR_ENTRY_NOT_CONFINED: &str = "entry_not_confined";

/// A registry entry whose dir exists but can't be resolved: a dangling
/// symlink, a loop, no permission ([`EntryRefusal::Unresolvable`]).
pub const ERROR_ENTRY_UNRESOLVABLE: &str = "entry_unresolvable";

/// What [`resolve_project`] resolves against.
#[derive(Debug, Clone, Copy)]
pub struct ResolveOptions<'a> {
    /// The root rules: the canonical home directory and the allowlist, which
    /// also bound the registry walk.
    pub root_policy: &'a RootPolicy,
    /// The app dir, exempt from the `.zzz` refusal ([`protected_dir`]).
    pub zzz_dir: &'a Path,
    /// Whose registry files and directories are trusted.
    pub owner: &'a TrustedOwner,
    /// The git runner discovery and the `RootInEntry` check call.
    pub git: &'a Git,
}

/// A resolved project ([`resolve_project`]).
#[derive(Debug)]
pub struct Project {
    /// The project's root directory, canonical.
    pub root: PathBuf,
    /// The directory the open resolved from, canonical: the opened path, or
    /// its parent when it names a file. Not always inside `root` (a linked
    /// worktree's registry, see the module docs).
    pub opened: PathBuf,
    pub kind: ProjectKind,
}

/// Which rule rooted a [`Project`].
#[derive(Debug)]
pub enum ProjectKind {
    /// A registry's root.
    Registry {
        /// The registry file as found at the root — possibly a symlink,
        /// whose target is inside the root.
        path: PathBuf,
        /// Every entry, in the registry's order (`ValidRegistry::entries`),
        /// each with its dir resolved and confined.
        entries: Vec<ProjectEntry>,
    },
    /// The git checkout holding the opened path.
    GitRepo,
    /// The opened directory, in no registry or checkout.
    PlainDir,
}

/// A registry entry and where its checkout is.
#[derive(Debug)]
pub struct ProjectEntry {
    pub entry: Entry,
    pub dir: EntryDir,
}

/// Where an entry's dir resolves, under the project root.
#[derive(Debug)]
pub enum EntryDir {
    /// Present, at this canonical path strictly inside the root, a
    /// directory. Two entries can resolve to the same directory (a symlinked
    /// entry dir), each `Present`: whatever indexes them dedups by this path.
    Present(PathBuf),
    /// Nothing at the entry's dir — not yet cloned.
    Missing,
    /// Refused alone; the rest of the project stands.
    Refused(EntryRefusal),
}

/// Why an entry's dir is refused ([`EntryDir::Refused`]).
#[derive(Debug, thiserror::Error)]
pub enum EntryRefusal {
    /// It resolves outside the root, or to the root itself — `fuz_repos`
    /// follows a symlinked entry dir, so the confinement is zzz's.
    #[error("{} resolves to {}, outside the project root", path.display(), resolved.display())]
    NotConfined { path: PathBuf, resolved: PathBuf },
    /// It resolves into a protected directory ([`protected_dir`]).
    #[error("{} resolves into {dir}: {}", path.display(), resolved.display())]
    Protected {
        path: PathBuf,
        resolved: PathBuf,
        dir: ProtectedDir,
    },
    /// It resolves to something other than a directory.
    #[error("{} resolves to {}, not a directory", path.display(), resolved.display())]
    NotADirectory { path: PathBuf, resolved: PathBuf },
    /// Something is there that can't be resolved.
    #[error("{} can't be resolved", path.display())]
    Unresolvable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl EntryRefusal {
    /// The stable reason the frontend shows.
    pub const fn reason(&self) -> &'static str {
        match self {
            Self::NotConfined { .. } => ERROR_ENTRY_NOT_CONFINED,
            Self::Protected { .. } => ERROR_PROTECTED_DIR_NOT_ALLOWED,
            Self::NotADirectory { .. } => ERROR_NOT_A_DIRECTORY,
            Self::Unresolvable { .. } => ERROR_ENTRY_UNRESOLVABLE,
        }
    }
}

/// Why a path resolves to no project ([`resolve_project`]).
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    /// The path isn't absolute — it would resolve against the daemon's
    /// working directory.
    #[error("the path must be absolute: {}", path.display())]
    NotAbsolute { path: PathBuf },
    /// The path can't be resolved: missing, a loop, no permission.
    #[error("the path can't be resolved: {}", path.display())]
    Unresolvable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The opened directory or the project root can't be a root
    /// ([`RootPolicy::admit`]).
    #[error("{} can't be a project root", root.display())]
    RootRefused {
        root: PathBuf,
        #[source]
        refusal: RootRefusal,
    },
    /// The opened directory, the project root, or a registry candidate's
    /// directory or link target is, or is inside, a protected directory.
    #[error("{} is in {dir}", path.display())]
    Protected { path: PathBuf, dir: ProtectedDir },
    /// The bound the walk needs can't be made ([`Bound`]): its dir is gone,
    /// or holds a `:` git's ceiling can't name.
    #[error("the walk can't be bounded at {}", dir.display())]
    BoundUnusable {
        dir: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// A registry, or a directory on its way to the bound, can't be opened,
    /// stat'd, or read: not a regular file, larger than
    /// [`REGISTRY_MAX_BYTES`], not UTF-8.
    #[error("the registry can't be read: {}", path.display())]
    RegistryUnreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The file opened isn't the one discovery found there, or the one its
    /// link resolves to — replaced between the walk's look and the open.
    #[error("the registry changed while it was checked: {}", path.display())]
    RegistryReplaced { path: PathBuf },
    /// A symlinked registry whose target is outside the root it would make.
    #[error(
        "the registry {} links outside its root, to {}",
        path.display(),
        target.display()
    )]
    RegistryNotConfined { path: PathBuf, target: PathBuf },
    /// A symlinked registry whose link text doesn't name its target without
    /// passing another symlink ([`link_text_path`]): a `..` that takes back a
    /// component the text added, which may be a symlink, or a text that read
    /// as written names another path. The directories such a link passes are
    /// ones the trust rule wouldn't see.
    #[error(
        "the registry {} may link through another symlink: its text {} doesn't name {} directly",
        path.display(),
        text.display(),
        target.display()
    )]
    RegistryLinkIndirect {
        path: PathBuf,
        /// The link's text, as read.
        text: PathBuf,
        target: PathBuf,
    },
    /// The registry, or a directory from it up to the bound, isn't the
    /// daemon user's alone to write ([`TrustedOwner::check`]).
    #[error("untrusted registry {}: {}", registry.display(), path.display())]
    RegistryUntrusted {
        registry: PathBuf,
        /// The file or directory that failed the check.
        path: PathBuf,
        #[source]
        why: Untrusted,
    },
    /// The registry doesn't parse or breaks its integrity rules.
    #[error("invalid registry {}", path.display())]
    RegistryInvalid {
        path: PathBuf,
        #[source]
        source: fuz_repos::error::Error,
    },
}

impl ProjectError {
    /// The stable reason the frontend shows — the root refusals and path
    /// errors are `project_open`'s too.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NotAbsolute { .. } => ERROR_INVALID_PATH,
            Self::BoundUnusable { .. } => ERROR_BOUND_UNUSABLE,
            Self::Unresolvable { source, .. } => match source.kind() {
                std::io::ErrorKind::NotFound => ERROR_PATH_NOT_FOUND,
                std::io::ErrorKind::PermissionDenied => ERROR_PERMISSION_DENIED,
                _ => ERROR_INVALID_PATH,
            },
            Self::RootRefused { refusal, .. } => {
                if refusal.is_outside_home() {
                    ERROR_ROOT_OUTSIDE_HOME
                } else {
                    ERROR_ROOT_NOT_ALLOWED
                }
            }
            Self::Protected { .. } => ERROR_PROTECTED_DIR_NOT_ALLOWED,
            Self::RegistryUnreadable { .. } => ERROR_REGISTRY_UNREADABLE,
            Self::RegistryReplaced { .. } => ERROR_REGISTRY_CHANGED,
            Self::RegistryUntrusted { .. } => ERROR_REGISTRY_UNTRUSTED,
            Self::RegistryNotConfined { .. } | Self::RegistryLinkIndirect { .. } => {
                ERROR_REGISTRY_NOT_CONFINED
            }
            Self::RegistryInvalid { .. } => ERROR_REGISTRY_INVALID,
        }
    }
}

/// The project `path` belongs to (see the module docs).
///
/// `path` is canonicalized first, so a symlink to a directory opens that
/// directory, and a symlink to a file opens the target's parent, not the
/// link's.
///
/// # Errors
///
/// [`ProjectError`]: a relative or unresolvable path; an opened directory or
/// root the root rules refuse or that is protected; a registry that is
/// untrusted, replaced, unconfined, unreadable, or invalid — the open is
/// refused rather than falling back, so the reason reaches the user.
pub fn resolve_project(path: &Path, options: &ResolveOptions<'_>) -> Result<Project, ProjectError> {
    if !path.is_absolute() {
        return Err(ProjectError::NotAbsolute {
            path: path.to_owned(),
        });
    }
    let unresolvable = |source| ProjectError::Unresolvable {
        path: path.to_owned(),
        source,
    };
    let canonical = path.canonicalize().map_err(unresolvable)?;
    let meta = std::fs::metadata(&canonical).map_err(unresolvable)?;
    let opened = match canonical.parent() {
        Some(parent) if !meta.is_dir() => parent.to_owned(),
        _ => canonical,
    };
    check_root(&opened, options)?;
    let bound = WalkBound::new(&opened, options.root_policy)?;

    let (root, kind) = find_registry(&opened, &bound, options)?.unwrap_or_else(|| {
        nearest_checkout(&opened, &bound).map_or_else(
            || (opened.clone(), ProjectKind::PlainDir),
            |top| (top, ProjectKind::GitRepo),
        )
    });
    // a backstop: the hook checked a registry root, and a checkout or the
    // opened dir is the opened dir or above it, inside the bound
    check_root(&root, options)?;
    Ok(Project { root, opened, kind })
}

/// Refuses a directory that can't be a root: a protected one, or one the
/// root rules refuse.
fn check_root(dir: &Path, options: &ResolveOptions<'_>) -> Result<(), ProjectError> {
    if let Some(protected) = protected_dir(dir, options.zzz_dir) {
        return Err(ProjectError::Protected {
            path: dir.to_owned(),
            dir: protected,
        });
    }
    options
        .root_policy
        .admit(dir)
        .map_err(|refusal| ProjectError::RootRefused {
            root: dir.to_owned(),
            refusal,
        })
}

/// How far up the walks from an opened directory look: strictly below the
/// home directory, or within the outermost allowlisted root holding it.
#[derive(Debug)]
struct WalkBound {
    bound: Bound,
    inclusive: bool,
}

impl WalkBound {
    /// The bound for `opened`, which the root rules admitted.
    fn new(opened: &Path, policy: &RootPolicy) -> Result<Self, ProjectError> {
        let (dir, inclusive) = if let Some(home) = policy.home()
            && opened.starts_with(home)
            && opened != home
        {
            (home, false)
        } else if let Some(allowed) = policy
            .outside_home()
            .iter()
            .filter(|dir| opened.starts_with(dir))
            .min_by_key(|dir| dir.components().count())
        {
            (allowed.as_path(), true)
        } else {
            // unreachable once `admit` passed, which needs one of the two
            return Err(ProjectError::RootRefused {
                root: opened.to_owned(),
                refusal: RootRefusal::NoHome,
            });
        };
        let bound = if inclusive {
            Bound::within(dir)
        } else {
            Bound::below(dir)
        }
        .map_err(|source| ProjectError::BoundUnusable {
            dir: dir.to_owned(),
            source,
        })?;
        Ok(Self { bound, inclusive })
    }

    /// Whether `dir` (canonical) is inside the bound, as `Bound` compares:
    /// what the walks look at.
    fn contains(&self, dir: &Path) -> bool {
        dir.starts_with(self.bound.dir()) && (self.inclusive || dir != self.bound.dir())
    }

    /// Whether the trust rule checks `dir` (canonical): the bound's dir too,
    /// even below the home directory, as sshd checks the home directory
    /// itself — whoever can write it can move the directories under it.
    fn is_trust_checked(&self, dir: &Path) -> bool {
        dir.starts_with(self.bound.dir())
    }
}

/// Rule 1: the registry discovered from `opened`, read and parsed, with its
/// root and entries — `None` when there is none, or when its root is in a
/// checkout of one of its entries.
fn find_registry(
    opened: &Path,
    bound: &WalkBound,
    options: &ResolveOptions<'_>,
) -> Result<Option<(PathBuf, ProjectKind)>, ProjectError> {
    let accept =
        |c: &Candidate<'_>| vet_candidate(c, bound, options.owner, options.zzz_dir).map(Some);
    let Some((location, file)) =
        discover_registry(opened, Some(&bound.bound), options.git, accept)?
    else {
        return Ok(None);
    };
    let src = read_registry(file, &location.path)?;
    let registry = ValidRegistry::parse(&src, &location.path).map_err(|source| {
        ProjectError::RegistryInvalid {
            path: location.path.clone(),
            source,
        }
    })?;
    let entries = registry.entries();
    if entry_holding_root(&location.root, &entries, Some(&bound.bound), options.git).is_some() {
        return Ok(None);
    }
    let entries = entries
        .into_iter()
        .map(|entry| {
            let dir = confine_entry(&location.root, &entry.dir, options.zzz_dir);
            ProjectEntry { entry, dir }
        })
        .collect();
    Ok(Some((
        location.root,
        ProjectKind::Registry {
            path: location.path,
            entries,
        },
    )))
}

/// The discovery hook: vets a candidate registry and opens it, returning
/// the open file to read.
///
/// Before anything is opened, the candidate's dir, and a symlinked
/// candidate's target, must be outside every protected directory, and the
/// target must be inside that dir (the root it would make), named by the
/// link text through no other symlink ([`link_text_path`],
/// [`ProjectError::RegistryLinkIndirect`]).
/// The open doesn't block (a FIFO swapped in can't hang it) and must be a
/// regular file that is the one discovery saw (`Candidate::file`) and the
/// one the target names. Then the trust rule: the open file, the target's
/// directories up to that dir, and every directory from that dir up to the
/// bound's — the home directory included, as sshd checks it, though the
/// walk never looks there. Any failure is an `Err`, never a skip (see the
/// module docs).
fn vet_candidate(
    c: &Candidate<'_>,
    bound: &WalkBound,
    owner: &TrustedOwner,
    zzz_dir: &Path,
) -> Result<File, ProjectError> {
    let unreadable = |path: &Path, source| ProjectError::RegistryUnreadable {
        path: path.to_owned(),
        source,
    };
    let untrusted = |path: &Path, why| ProjectError::RegistryUntrusted {
        registry: c.path.to_owned(),
        path: path.to_owned(),
        why,
    };
    let protected = |path: &Path| {
        protected_dir(path, zzz_dir).map_or(Ok(()), |dir| {
            Err(ProjectError::Protected {
                path: path.to_owned(),
                dir,
            })
        })
    };
    protected(c.dir)?;
    let target = c.link_target().map_err(|e| unreadable(c.path, e))?;
    if let Some(target) = &target {
        protected(target)?;
        if !target.starts_with(c.dir) {
            return Err(ProjectError::RegistryNotConfined {
                path: c.path.to_owned(),
                target: target.clone(),
            });
        }
        let text = std::fs::read_link(c.path).map_err(|e| unreadable(c.path, e))?;
        if link_text_path(c.dir, &text).as_ref() != Some(target) {
            return Err(ProjectError::RegistryLinkIndirect {
                path: c.path.to_owned(),
                text,
                target: target.clone(),
            });
        }
    }
    let (file, meta) = fuz_sys::secure_file::open_regular_nonblocking(c.path)
        .map_err(|e| unreadable(c.path, e))?;
    let replaced = || ProjectError::RegistryReplaced {
        path: c.path.to_owned(),
    };
    if meta.dev() != c.file.dev || meta.ino() != c.file.ino {
        return Err(replaced());
    }
    if let Some(target) = &target {
        let named = std::fs::metadata(target).map_err(|e| unreadable(target, e))?;
        if named.dev() != meta.dev() || named.ino() != meta.ino() {
            return Err(replaced());
        }
    }
    owner
        .check(Inode::from(&meta))
        .map_err(|why| untrusted(target.as_deref().unwrap_or(c.path), why))?;
    let target_dirs = target
        .as_deref()
        .and_then(Path::parent)
        .into_iter()
        .flat_map(Path::ancestors)
        .take_while(|dir| *dir != c.dir);
    let dirs = c
        .dir
        .ancestors()
        .take_while(|dir| bound.is_trust_checked(dir));
    for dir in target_dirs.chain(dirs) {
        let meta = std::fs::symlink_metadata(dir).map_err(|e| unreadable(dir, e))?;
        owner
            .check(Inode::from(&meta))
            .map_err(|why| untrusted(dir, why))?;
    }
    Ok(file)
}

/// The path the symlink text `text`, found in the physical directory `dir`,
/// names when no symlink sits along it — `None` when that can't be read
/// from the text alone.
///
/// Read without touching the filesystem: `.` is dropped, and a `..` takes
/// off the component before it only when that component is one of `dir`'s
/// own, which are physical (`dir` is canonical), so their parents are what
/// the kernel climbs to. A `..` that would take back a component the text
/// added is `None`: that component may itself be a symlink, and the kernel
/// resolves the `..` from wherever it leads (`a/b/../..` can pass through
/// anywhere and come back). So `../dev/meta/repos.toml` from `dev` is read,
/// and `app/../meta/repos.toml` isn't. An absolute text adds every
/// component it names, so any `..` in it past `/` is `None`.
///
/// When the result equals the link's canonical target, every component the
/// text added resolved as a plain directory or the file itself: the link
/// passes through no other symlink.
fn link_text_path(dir: &Path, text: &Path) -> Option<PathBuf> {
    use std::path::Component;

    let mut path = if text.is_absolute() {
        PathBuf::new()
    } else {
        dir.to_owned()
    };
    // how many of `path`'s last components the text added
    let mut added = 0_usize;
    for component in text.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if added > 0 => return None,
            Component::ParentDir => {
                path.pop();
            }
            Component::RootDir | Component::Prefix(_) => path.push(component),
            Component::Normal(_) => {
                path.push(component);
                added += 1;
            }
        }
    }
    Some(path)
}

/// The text of the vetted registry `file` (found at `path`), at most
/// [`REGISTRY_MAX_BYTES`].
fn read_registry(file: File, path: &Path) -> Result<String, ProjectError> {
    let unreadable = |source| ProjectError::RegistryUnreadable {
        path: path.to_owned(),
        source,
    };
    let mut bytes = Vec::new();
    file.take(REGISTRY_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    if bytes.len() as u64 > REGISTRY_MAX_BYTES {
        return Err(unreadable(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("larger than {REGISTRY_MAX_BYTES} bytes"),
        )));
    }
    String::from_utf8(bytes)
        .map_err(|e| unreadable(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))
}

/// Where the entry dir `name` under `root` resolves ([`EntryDir`]).
fn confine_entry(root: &Path, name: &str, zzz_dir: &Path) -> EntryDir {
    let path = root.join(name);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return EntryDir::Missing,
        Err(source) => return EntryDir::Refused(EntryRefusal::Unresolvable { path, source }),
        Ok(_) => {}
    }
    let resolved = match path.canonicalize() {
        Ok(resolved) => resolved,
        Err(source) => return EntryDir::Refused(EntryRefusal::Unresolvable { path, source }),
    };
    if !resolved.starts_with(root) || resolved == root {
        return EntryDir::Refused(EntryRefusal::NotConfined { path, resolved });
    }
    if let Some(dir) = protected_dir(&resolved, zzz_dir) {
        return EntryDir::Refused(EntryRefusal::Protected {
            path,
            resolved,
            dir,
        });
    }
    match std::fs::metadata(&resolved) {
        Ok(meta) if meta.is_dir() => EntryDir::Present(resolved),
        Ok(_) => EntryDir::Refused(EntryRefusal::NotADirectory { path, resolved }),
        Err(source) => EntryDir::Refused(EntryRefusal::Unresolvable { path, source }),
    }
}

/// Rule 2: the nearest directory at or above `opened`, inside the bound,
/// holding a `.git` that stats (followed through symlinks) — what
/// `fuz_repos`'s discovery counts as a checkout.
fn nearest_checkout(opened: &Path, bound: &WalkBound) -> Option<PathBuf> {
    opened
        .ancestors()
        .take_while(|dir| bound.contains(dir))
        .find(|dir| std::fs::metadata(dir.join(".git")).is_ok())
        .map(Path::to_owned)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    /// Two repos and two references, every dir a plain name.
    const REGISTRY: &str = r#"owners = ["me"]

[repos.app]
url = "https://github.com/me/app"
visibility = "public"
purpose = "an app"

[repos.site]
url = "https://github.com/me/site"
visibility = "private"
purpose = "a site"

[references.keys]
url = "https://github.com/them/keys"
purpose = "a reference"

[references.spec]
url = "https://github.com/them/spec"
purpose = "a reference"
"#;

    /// Text a read would refuse: found where a walk must not look, it fails
    /// the resolve.
    const GARBAGE: &str = "this is not [[ toml";

    fn uid() -> u32 {
        nix::unistd::geteuid().as_raw()
    }

    /// A scratch tree with a home directory at `home`, every mode set
    /// explicitly (the umask may leave dirs group-writable), removed on drop.
    struct Fixture {
        tmp: PathBuf,
        allowed: Vec<PathBuf>,
        owner: TrustedOwner,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp =
                std::env::temp_dir().join(format!("zzz_project_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&tmp).unwrap();
            let fixture = Self {
                tmp: tmp.canonicalize().unwrap(),
                allowed: Vec::new(),
                owner: TrustedOwner::new(uid(), None),
            };
            fixture.mkdir("home");
            fixture
        }

        /// A fixture whose `rel` (made) is allowlisted outside the home.
        fn with_allowed(rel: &str) -> Self {
            let mut fixture = Self::new();
            fixture.allowed.push(fixture.mkdir(rel));
            fixture
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.tmp.join(rel)
        }

        /// Makes `rel` and each missing dir above it, `0755`.
        fn mkdir(&self, rel: &str) -> PathBuf {
            let path = self.path(rel);
            let mut dir = self.tmp.clone();
            for part in Path::new(rel).components() {
                dir.push(part);
                if !dir.exists() {
                    std::fs::create_dir(&dir).unwrap();
                    set_mode(&dir, 0o755);
                }
            }
            path
        }

        /// Writes `rel`, `0644`, making its dir.
        fn write(&self, rel: &str, text: &str) -> PathBuf {
            let path = self.path(rel);
            self.mkdir(Path::new(rel).parent().unwrap().to_str().unwrap());
            std::fs::write(&path, text).unwrap();
            set_mode(&path, 0o644);
            path
        }

        fn chmod(&self, rel: &str, mode: u32) {
            set_mode(&self.path(rel), mode);
        }

        /// A symlink at `rel` to `target`, as spelled.
        fn symlink(&self, target: &str, rel: &str) {
            std::os::unix::fs::symlink(target, self.path(rel)).unwrap();
        }

        /// The environment both the fixture's git and the resolver's see.
        fn git_env(&self) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
            vec![
                ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
                ("HOME".into(), self.path("home").into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ]
        }

        /// Runs git in `rel`.
        fn git(&self, rel: &str, args: &[&str]) {
            let out = std::process::Command::new("git")
                .current_dir(self.path(rel))
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@example.com",
                    "-c",
                    "init.defaultBranch=main",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .env_clear()
                .envs(self.git_env())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        fn resolve(&self, rel: &str) -> Result<Project, ProjectError> {
            self.resolve_path(&self.path(rel))
        }

        fn resolve_path(&self, path: &Path) -> Result<Project, ProjectError> {
            let policy = RootPolicy::new(Some(self.path("home")), self.allowed.clone()).unwrap();
            let git = Git::with_clean_env(self.git_env());
            let zzz_dir = self.path("app/.zzz");
            resolve_project(
                path,
                &ResolveOptions {
                    root_policy: &policy,
                    zzz_dir: &zzz_dir,
                    owner: &self.owner,
                    git: &git,
                },
            )
        }

        /// The gid the fixture's files are made with.
        fn gid(&self) -> u32 {
            std::fs::metadata(&self.tmp).unwrap().gid()
        }
    }

    fn set_mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.tmp);
        }
    }

    /// The registry's path and entries, or a panic naming the kind.
    fn registry(project: &Project) -> (&Path, &[ProjectEntry]) {
        match &project.kind {
            ProjectKind::Registry { path, entries } => (path, entries),
            kind => panic!("expected a registry project, got {kind:?}"),
        }
    }

    fn entry<'p>(project: &'p Project, key: &str) -> &'p EntryDir {
        let (_, entries) = registry(project);
        &entries.iter().find(|e| e.entry.key == key).unwrap().dir
    }

    /// The untrusted path and why, or a panic naming the error.
    fn untrusted(result: Result<Project, ProjectError>) -> (PathBuf, Untrusted) {
        match result {
            Err(e @ ProjectError::RegistryUntrusted { .. }) => {
                assert_eq!(e.reason(), ERROR_REGISTRY_UNTRUSTED);
                let ProjectError::RegistryUntrusted { path, why, .. } = e else {
                    unreachable!()
                };
                (path, why)
            }
            other => panic!("expected an untrusted registry, got {other:?}"),
        }
    }

    #[test]
    fn a_registry_above_the_path_roots_the_project() {
        let f = Fixture::new();
        f.write("home/dev/repos.toml", REGISTRY);
        f.mkdir("home/dev/app/src");

        let project = f.resolve("home/dev/app/src").unwrap();
        assert_eq!(project.root, f.path("home/dev"));
        assert_eq!(project.opened, f.path("home/dev/app/src"));
        let (path, entries) = registry(&project);
        assert_eq!(path, f.path("home/dev/repos.toml"));
        let keys: Vec<&str> = entries.iter().map(|e| e.entry.key.as_str()).collect();
        assert_eq!(keys, ["app", "site", "keys", "spec"]);
        assert!(
            matches!(entry(&project, "app"), EntryDir::Present(p) if *p == f.path("home/dev/app"))
        );
        assert!(matches!(entry(&project, "site"), EntryDir::Missing));
    }

    #[test]
    fn a_registry_at_or_above_the_home_directory_is_never_looked_at() {
        let f = Fixture::new();
        // either would fail the resolve if it were read
        f.write("repos.toml", GARBAGE);
        f.write("home/repos.toml", GARBAGE);
        f.mkdir("home/dev/notes");

        let project = f.resolve("home/dev/notes").unwrap();
        assert!(matches!(project.kind, ProjectKind::PlainDir));
        assert_eq!(project.root, f.path("home/dev/notes"));
    }

    #[test]
    fn group_writable_dirs_and_files_are_trusted_only_in_the_private_group() {
        let mut f = Fixture::new();
        f.write("home/dev/ws/repos.toml", REGISTRY);
        f.mkdir("home/dev/ws/app");
        // a dir between the registry and the home directory, and the file
        f.chmod("home/dev", 0o775);
        f.chmod("home/dev/ws/repos.toml", 0o664);

        f.owner = TrustedOwner::new(uid(), Some(f.gid()));
        let project = f.resolve("home/dev/ws/app").unwrap();
        assert_eq!(project.root, f.path("home/dev/ws"));

        // a shared group: the file is refused first
        f.owner = TrustedOwner::new(uid(), None);
        let (path, why) = untrusted(f.resolve("home/dev/ws/app"));
        assert_eq!(path, f.path("home/dev/ws/repos.toml"));
        assert!(matches!(why, Untrusted::GroupWritable { .. }), "{why:?}");
        // then each dir up to the home directory
        f.chmod("home/dev/ws/repos.toml", 0o644);
        let (path, why) = untrusted(f.resolve("home/dev/ws/app"));
        assert_eq!(path, f.path("home/dev"));
        assert!(matches!(why, Untrusted::GroupWritable { .. }), "{why:?}");
        f.chmod("home/dev", 0o755);
        f.chmod("home", 0o775);
        let (path, _) = untrusted(f.resolve("home/dev/ws/app"));
        assert_eq!(path, f.path("home"));
        // nothing above the home directory is checked
        f.chmod("home", 0o755);
        set_mode(&f.tmp, 0o777);
        assert!(f.resolve("home/dev/ws/app").is_ok());
    }

    #[test]
    fn writable_by_others_is_refused_even_in_the_private_group() {
        let mut f = Fixture::new();
        f.owner = TrustedOwner::new(uid(), Some(f.gid()));
        f.write("home/dev/repos.toml", REGISTRY);
        f.mkdir("home/dev/app");

        f.chmod("home/dev/repos.toml", 0o646);
        let (path, why) = untrusted(f.resolve("home/dev/app"));
        assert_eq!(path, f.path("home/dev/repos.toml"));
        assert_eq!(why, Untrusted::WorldWritable { mode: 0o646 });

        f.chmod("home/dev/repos.toml", 0o644);
        f.chmod("home/dev", 0o1777);
        let (path, why) = untrusted(f.resolve("home/dev/app"));
        assert_eq!(path, f.path("home/dev"));
        assert_eq!(why, Untrusted::WorldWritable { mode: 0o1777 });
    }

    #[test]
    fn a_registry_linked_into_a_protected_dir_is_refused_unread() {
        let f = Fixture::new();
        f.write("home/dev/.ssh/repos.toml", GARBAGE);
        f.symlink(".ssh/repos.toml", "home/dev/repos.toml");
        f.mkdir("home/dev/app");

        let e = f.resolve("home/dev/app").unwrap_err();
        assert!(
            matches!(&e, ProjectError::Protected { path, .. } if *path == f.path("home/dev/.ssh/repos.toml")),
            "{e:?}"
        );
        assert_eq!(e.reason(), ERROR_PROTECTED_DIR_NOT_ALLOWED);
    }

    #[test]
    fn a_root_owned_registry_and_chain_are_trusted_under_the_mode_rules() {
        // the fixture's own uid stands in for root's, since only root can
        // `chown` to root; the daemon's uid is another
        let mut f = Fixture::new();
        f.owner = TrustedOwner::new(uid() + 1, None).with_root_uid(uid());
        f.write("home/dev/ws/repos.toml", REGISTRY);
        f.mkdir("home/dev/ws/app");

        let project = f.resolve("home/dev/ws/app").unwrap();
        assert_eq!(project.root, f.path("home/dev/ws"));

        // root's `o+w` registry, or a dir in the chain, is refused
        f.chmod("home/dev/ws/repos.toml", 0o646);
        let (path, why) = untrusted(f.resolve("home/dev/ws/app"));
        assert_eq!(path, f.path("home/dev/ws/repos.toml"));
        assert_eq!(why, Untrusted::WorldWritable { mode: 0o646 });
        f.chmod("home/dev/ws/repos.toml", 0o644);
        f.chmod("home/dev", 0o777);
        let (path, _) = untrusted(f.resolve("home/dev/ws/app"));
        assert_eq!(path, f.path("home/dev"));
        // and `g+w` by a group that isn't the user's private one
        f.chmod("home/dev", 0o775);
        let (path, why) = untrusted(f.resolve("home/dev/ws/app"));
        assert_eq!(path, f.path("home/dev"));
        assert!(matches!(why, Untrusted::GroupWritable { .. }), "{why:?}");
    }

    #[test]
    fn a_registry_owned_by_another_uid_is_refused() {
        let mut f = Fixture::new();
        f.write("home/dev/repos.toml", REGISTRY);
        f.mkdir("home/dev/app");
        f.owner = TrustedOwner::new(uid() + 1, None);

        let (path, why) = untrusted(f.resolve("home/dev/app"));
        assert_eq!(path, f.path("home/dev/repos.toml"));
        assert_eq!(
            why,
            Untrusted::NotOwned {
                uid: uid(),
                expected: uid() + 1
            }
        );
    }

    #[test]
    fn a_symlinked_registry_inside_its_root_is_followed() {
        let f = Fixture::new();
        f.write("home/dev/meta/repos.toml", REGISTRY);
        f.symlink("meta/repos.toml", "home/dev/repos.toml");
        f.mkdir("home/dev/app");

        let project = f.resolve("home/dev/app").unwrap();
        assert_eq!(project.root, f.path("home/dev"));
        assert_eq!(registry(&project).0, f.path("home/dev/repos.toml"));

        // the target's dir is checked too, below the link's
        f.chmod("home/dev/meta", 0o757);
        let (path, _) = untrusted(f.resolve("home/dev/app"));
        assert_eq!(path, f.path("home/dev/meta"));
        // and the target file, named as the target
        f.chmod("home/dev/meta", 0o755);
        f.chmod("home/dev/meta/repos.toml", 0o666);
        let (path, _) = untrusted(f.resolve("home/dev/app"));
        assert_eq!(path, f.path("home/dev/meta/repos.toml"));
    }

    #[test]
    fn a_registry_link_is_followed_only_when_its_text_names_its_target() {
        let f = Fixture::new();
        f.write("home/dev/meta/repos.toml", REGISTRY);
        f.mkdir("home/dev/app");

        // relative or absolute, spelled without another symlink: followed
        f.symlink("meta/repos.toml", "home/dev/repos.toml");
        assert!(f.resolve("home/dev/app").is_ok());
        std::fs::remove_file(f.path("home/dev/repos.toml")).unwrap();
        f.symlink(
            f.path("home/dev/meta/repos.toml").to_str().unwrap(),
            "home/dev/repos.toml",
        );
        assert!(f.resolve("home/dev/app").is_ok());
        // a `..` climbing out of the link's own dir, which is physical
        std::fs::remove_file(f.path("home/dev/repos.toml")).unwrap();
        f.symlink("./../dev/meta/repos.toml", "home/dev/repos.toml");
        assert!(f.resolve("home/dev/app").is_ok());

        let refused = |text: &str| {
            std::fs::remove_file(f.path("home/dev/repos.toml")).unwrap();
            f.symlink(text, "home/dev/repos.toml");
            let e = f.resolve("home/dev/app").unwrap_err();
            assert!(
                matches!(&e, ProjectError::RegistryLinkIndirect { text: t, .. } if *t == Path::new(text)),
                "{text}: {e:?}"
            );
            assert_eq!(e.reason(), ERROR_REGISTRY_NOT_CONFINED, "{text}");
        };

        // a `..` taking back a component the text added, though `app` is a
        // plain dir here: it could be a symlink
        refused("./app/../meta/repos.toml");
        let absolute = f.path("home/dev/app/../meta/repos.toml");
        refused(absolute.to_str().unwrap());

        // through an intermediate symlink, `sub/l` → `../meta`: the dirs it
        // passes are never checked, so it's refused
        f.mkdir("home/dev/sub");
        f.symlink("../meta", "home/dev/sub/l");
        refused("sub/l/repos.toml");
        // and back out of one: `sub/k` → `inner`, then `..`
        f.mkdir("home/dev/sub/inner");
        f.symlink("inner", "home/dev/sub/k");
        f.write("home/dev/sub/meta/repos.toml", REGISTRY);
        refused("sub/k/../meta/repos.toml");
        // out through a world-writable dir outside home and back: `a` →
        // `outside/evil` (`0777`), whose `b` → `home/dev/x/y`
        f.mkdir("outside/evil");
        f.chmod("outside/evil", 0o777);
        f.mkdir("home/dev/x/y");
        f.symlink(f.path("outside/evil").to_str().unwrap(), "home/dev/a");
        f.symlink(f.path("home/dev/x/y").to_str().unwrap(), "outside/evil/b");
        refused("a/b/../../meta/repos.toml");

        // a link to a link is one too
        std::fs::remove_file(f.path("home/dev/repos.toml")).unwrap();
        f.symlink("repos.toml", "home/dev/meta/alias.toml");
        f.symlink("meta/alias.toml", "home/dev/repos.toml");
        let e = f.resolve("home/dev/app").unwrap_err();
        assert!(
            matches!(e, ProjectError::RegistryLinkIndirect { .. }),
            "{e:?}"
        );
    }

    #[test]
    fn a_registry_in_a_checkout_roots_where_a_link_above_names_it() {
        // the `~/dev/repos.toml` → `~/dev/meta/repos.toml` shape: a link to a
        // copy in one of its repos
        let f = Fixture::new();
        f.write("home/dev/meta/repos.toml", REGISTRY);
        f.mkdir("home/dev/meta/.git");
        f.mkdir("home/dev/meta/src");
        f.symlink("meta/repos.toml", "home/dev/repos.toml");

        let project = f.resolve("home/dev/meta/src").unwrap();
        assert_eq!(project.root, f.path("home/dev"));
        assert_eq!(registry(&project).0, f.path("home/dev/repos.toml"));
    }

    #[test]
    fn a_symlinked_registry_leading_outside_its_root_is_refused() {
        let f = Fixture::new();
        f.write("home/elsewhere/repos.toml", REGISTRY);
        f.write("outside/repos.toml", REGISTRY);
        f.mkdir("home/dev/app");
        f.mkdir("home/w/app");
        f.symlink("../elsewhere/repos.toml", "home/dev/repos.toml");
        f.symlink(
            f.path("outside/repos.toml").to_str().unwrap(),
            "home/w/repos.toml",
        );

        for (open, target) in [
            ("home/dev/app", "home/elsewhere/repos.toml"),
            ("home/w/app", "outside/repos.toml"),
        ] {
            let e = f.resolve(open).unwrap_err();
            assert_eq!(e.reason(), ERROR_REGISTRY_NOT_CONFINED, "{open}");
            assert!(
                matches!(&e, ProjectError::RegistryNotConfined { target: t, .. } if *t == f.path(target)),
                "{e:?}"
            );
        }
    }

    #[test]
    fn an_entry_escaping_the_root_is_refused_alone() {
        let f = Fixture::new();
        f.write("home/dev/repos.toml", REGISTRY);
        f.mkdir("home/outside");
        f.mkdir("home/dev/.ssh");
        f.mkdir("home/dev/spec");
        f.symlink("../outside", "home/dev/app");
        f.symlink(".", "home/dev/site");
        f.symlink(".ssh", "home/dev/keys");

        let project = f.resolve("home/dev/spec").unwrap();
        assert_eq!(project.root, f.path("home/dev"));
        for (key, resolved) in [("app", "home/outside"), ("site", "home/dev")] {
            match entry(&project, key) {
                EntryDir::Refused(refusal @ EntryRefusal::NotConfined { resolved: r, .. }) => {
                    assert_eq!(*r, f.path(resolved), "{key}");
                    assert_eq!(refusal.reason(), ERROR_ENTRY_NOT_CONFINED);
                }
                other => panic!("{key}: {other:?}"),
            }
        }
        match entry(&project, "keys") {
            EntryDir::Refused(refusal @ EntryRefusal::Protected { .. }) => {
                assert_eq!(refusal.reason(), ERROR_PROTECTED_DIR_NOT_ALLOWED);
            }
            other => panic!("keys: {other:?}"),
        }
        assert!(
            matches!(entry(&project, "spec"), EntryDir::Present(p) if *p == f.path("home/dev/spec"))
        );

        // a file at an entry's dir, or a link to one, isn't a checkout
        std::fs::remove_file(f.path("home/dev/app")).unwrap();
        f.write("home/dev/app", "");
        std::fs::remove_file(f.path("home/dev/site")).unwrap();
        f.symlink("app", "home/dev/site");
        let project = f.resolve("home/dev/spec").unwrap();
        for key in ["app", "site"] {
            match entry(&project, key) {
                EntryDir::Refused(refusal @ EntryRefusal::NotADirectory { resolved, .. }) => {
                    assert_eq!(*resolved, f.path("home/dev/app"), "{key}");
                    assert_eq!(refusal.reason(), ERROR_NOT_A_DIRECTORY);
                }
                other => panic!("{key}: {other:?}"),
            }
        }

        // a dangling link is something there that can't be resolved
        std::fs::remove_dir(f.path("home/dev/spec")).unwrap();
        f.symlink("gone", "home/dev/spec");
        let project = f.resolve("home/dev").unwrap();
        match entry(&project, "spec") {
            EntryDir::Refused(refusal @ EntryRefusal::Unresolvable { .. }) => {
                assert_eq!(refusal.reason(), ERROR_ENTRY_UNRESOLVABLE);
            }
            other => panic!("spec: {other:?}"),
        }
    }

    #[test]
    fn a_root_in_an_entrys_checkout_falls_back_to_the_nearest_checkout() {
        let f = Fixture::new();
        f.mkdir("home/dev/meta/src");
        f.git("home/dev/meta", &["init", "-q"]);
        f.git(
            "home/dev/meta",
            &["remote", "add", "origin", "https://github.com/me/meta"],
        );
        let own = "owners = [\"me\"]\n\n[repos.meta]\nurl = \"https://github.com/me/meta\"\nvisibility = \"public\"\npurpose = \"the registry's repo\"\n";
        f.write("home/dev/meta/repos.toml", own);

        // `RootInEntry`: the registry would root at a checkout of its own entry
        let project = f.resolve("home/dev/meta/src").unwrap();
        assert!(matches!(project.kind, ProjectKind::GitRepo), "{project:?}");
        assert_eq!(project.root, f.path("home/dev/meta"));

        // a checkout of no entry keeps the registry
        f.git(
            "home/dev/meta",
            &["remote", "set-url", "origin", "https://github.com/me/other"],
        );
        let project = f.resolve("home/dev/meta/src").unwrap();
        assert_eq!(registry(&project).0, f.path("home/dev/meta/repos.toml"));
        assert_eq!(project.root, f.path("home/dev/meta"));
    }

    #[test]
    fn a_linked_worktree_finds_its_main_checkouts_linked_registry() {
        let f = Fixture::new();
        f.write("home/ws/meta/repos.toml", REGISTRY);
        f.git("home/ws/meta", &["init", "-q"]);
        f.git("home/ws/meta", &["add", "repos.toml"]);
        f.git("home/ws/meta", &["commit", "-q", "-m", "registry"]);
        f.symlink("meta/repos.toml", "home/ws/repos.toml");
        f.git("home/ws/meta", &["worktree", "add", "-q", "../../wt"]);
        // the checkout's modes come from the umask
        f.chmod("home/wt", 0o755);
        f.chmod("home/wt/repos.toml", 0o644);

        // the root is where the main checkout's copy is linked, which doesn't
        // hold the opened path
        let project = f.resolve("home/wt").unwrap();
        assert_eq!(project.root, f.path("home/ws"));
        assert_eq!(project.opened, f.path("home/wt"));
        assert_eq!(registry(&project).0, f.path("home/ws/repos.toml"));
    }

    #[test]
    fn a_root_the_rules_refuse_is_refused_wherever_the_open_was() {
        // the worktree jump lands the root in a protected dir the opened
        // path isn't in
        let f = Fixture::new();
        f.write("home/dev/.docker/ws/meta/repos.toml", REGISTRY);
        f.git("home/dev/.docker/ws/meta", &["init", "-q"]);
        f.git("home/dev/.docker/ws/meta", &["add", "repos.toml"]);
        f.git(
            "home/dev/.docker/ws/meta",
            &["commit", "-q", "-m", "registry"],
        );
        f.symlink("meta/repos.toml", "home/dev/.docker/ws/repos.toml");
        f.git(
            "home/dev/.docker/ws/meta",
            &["worktree", "add", "-q", "../../../wt"],
        );
        f.chmod("home/dev/wt", 0o755);
        f.chmod("home/dev/wt/repos.toml", 0o644);
        // in place, the same inode: parsed, it would fail as invalid, quoting
        // a line of it
        std::fs::write(f.path("home/dev/.docker/ws/meta/repos.toml"), GARBAGE).unwrap();

        // refused before the link into it is opened, let alone read
        let e = f.resolve("home/dev/wt").unwrap_err();
        assert!(
            matches!(&e, ProjectError::Protected { path, .. } if *path == f.path("home/dev/.docker/ws")),
            "{e:?}"
        );
        assert_eq!(e.reason(), ERROR_PROTECTED_DIR_NOT_ALLOWED);
    }

    #[test]
    fn a_linked_worktree_without_a_registry_is_its_own_checkout() {
        let f = Fixture::new();
        f.write("home/dev/repo/a.txt", "a");
        f.git("home/dev/repo", &["init", "-q"]);
        f.git("home/dev/repo", &["add", "a.txt"]);
        f.git("home/dev/repo", &["commit", "-q", "-m", "a"]);
        f.git("home/dev/repo", &["worktree", "add", "-q", "../wt"]);
        f.mkdir("home/dev/wt/sub");

        let project = f.resolve("home/dev/wt/sub").unwrap();
        assert!(matches!(project.kind, ProjectKind::GitRepo), "{project:?}");
        assert_eq!(project.root, f.path("home/dev/wt"));
    }

    #[test]
    fn any_git_entry_that_stats_makes_a_checkout() {
        let f = Fixture::new();
        f.mkdir("home/dev/odd/src");
        let out = std::process::Command::new("mkfifo")
            .arg(f.path("home/dev/odd/.git"))
            .output()
            .unwrap();
        assert!(out.status.success());

        let project = f.resolve("home/dev/odd/src").unwrap();
        assert!(matches!(project.kind, ProjectKind::GitRepo), "{project:?}");
        assert_eq!(project.root, f.path("home/dev/odd"));
    }

    #[test]
    fn a_dir_in_no_registry_or_checkout_is_its_own_project() {
        let f = Fixture::new();
        f.mkdir("home/dev/notes/deep");
        // a dotfiles checkout at the home directory is outside the bound
        f.mkdir("home/.git");

        let project = f.resolve("home/dev/notes/deep").unwrap();
        assert!(matches!(project.kind, ProjectKind::PlainDir), "{project:?}");
        assert_eq!(project.root, f.path("home/dev/notes/deep"));
    }

    #[test]
    fn a_file_opens_its_parent() {
        let f = Fixture::new();
        f.write("home/dev/notes/a.md", "a");
        let project = f.resolve("home/dev/notes/a.md").unwrap();
        assert!(matches!(project.kind, ProjectKind::PlainDir));
        assert_eq!(project.opened, f.path("home/dev/notes"));
        assert_eq!(project.root, f.path("home/dev/notes"));

        f.mkdir("home/dev/repo/.git");
        f.write("home/dev/repo/src/lib.rs", "");
        let project = f.resolve("home/dev/repo/src/lib.rs").unwrap();
        assert!(matches!(project.kind, ProjectKind::GitRepo));
        assert_eq!(project.opened, f.path("home/dev/repo/src"));
        assert_eq!(project.root, f.path("home/dev/repo"));
    }

    #[test]
    fn an_allowlisted_root_outside_home_bounds_the_walk_within_it() {
        let f = Fixture::with_allowed("srv");
        // above the allowlisted root: never looked at
        f.write("repos.toml", GARBAGE);
        f.mkdir(".git");
        f.write("srv/repos.toml", REGISTRY);
        f.mkdir("srv/proj/app");

        let project = f.resolve("srv/proj/app").unwrap();
        assert_eq!(project.root, f.path("srv"));
        assert!(matches!(entry(&project, "app"), EntryDir::Missing));

        // the allowlisted root itself is trust-checked
        f.chmod("srv", 0o757);
        let (path, _) = untrusted(f.resolve("srv/proj/app"));
        assert_eq!(path, f.path("srv"));

        // without the registry, a dir in no checkout is its own project
        f.chmod("srv", 0o755);
        std::fs::remove_file(f.path("srv/repos.toml")).unwrap();
        let project = f.resolve("srv/proj/app").unwrap();
        assert!(matches!(project.kind, ProjectKind::PlainDir), "{project:?}");
        assert_eq!(project.root, f.path("srv/proj/app"));
    }

    #[test]
    fn the_root_rules_hold_before_any_walk() {
        let f = Fixture::new();
        f.mkdir("outside");
        f.mkdir("home/.ssh/keys");
        f.mkdir("home/dev");
        let reason = |rel: &str| f.resolve(rel).unwrap_err().reason();

        assert_eq!(reason("home"), ERROR_ROOT_NOT_ALLOWED);
        assert_eq!(reason(""), ERROR_ROOT_NOT_ALLOWED);
        assert_eq!(reason("outside"), ERROR_ROOT_OUTSIDE_HOME);
        assert_eq!(reason("home/.ssh/keys"), ERROR_PROTECTED_DIR_NOT_ALLOWED);
        assert_eq!(reason("home/missing"), ERROR_PATH_NOT_FOUND);
        let relative = f.resolve_path(Path::new("home/dev")).unwrap_err();
        assert!(matches!(relative, ProjectError::NotAbsolute { .. }));
        assert_eq!(relative.reason(), ERROR_INVALID_PATH);
        // a file directly in the home directory opens the home directory
        f.write("home/notes.md", "");
        assert_eq!(reason("home/notes.md"), ERROR_ROOT_NOT_ALLOWED);
    }

    #[test]
    fn a_candidate_whose_open_file_isnt_the_one_found_is_refused() {
        let f = Fixture::new();
        let path = f.write("home/dev/repos.toml", REGISTRY);
        let dir = f.path("home/dev");
        let meta = std::fs::metadata(&path).unwrap();
        let policy = RootPolicy::new(Some(f.path("home")), Vec::new()).unwrap();
        let bound = WalkBound::new(&dir, &policy).unwrap();
        let candidate = |ino| Candidate {
            path: &path,
            dir: &dir,
            kind: fuz_repos::discover::CandidateKind::Nearest,
            file: fuz_repos::discover::FileId {
                dev: meta.dev(),
                ino,
            },
        };

        let zzz_dir = f.path("app/.zzz");
        let vet = |ino| vet_candidate(&candidate(ino), &bound, &f.owner, &zzz_dir);
        assert!(vet(meta.ino()).is_ok());
        // a file swapped in after the walk looked
        let e = vet(meta.ino() + 1).unwrap_err();
        assert!(matches!(e, ProjectError::RegistryReplaced { .. }), "{e:?}");
        assert_eq!(e.reason(), ERROR_REGISTRY_CHANGED);
    }

    #[test]
    fn an_unreadable_or_invalid_registry_refuses_the_open() {
        let f = Fixture::new();
        f.mkdir("home/dev/app");

        f.write("home/dev/repos.toml", GARBAGE);
        let e = f.resolve("home/dev/app").unwrap_err();
        assert!(matches!(e, ProjectError::RegistryInvalid { .. }), "{e:?}");
        assert_eq!(e.reason(), ERROR_REGISTRY_INVALID);
        // parses, but breaks the integrity rules (an owned repo's dir twice)
        let dup = format!(
            "{REGISTRY}\n[repos.app2]\nurl = \"https://github.com/me/app2\"\ndir = \"app\"\nvisibility = \"public\"\npurpose = \"x\"\n"
        );
        f.write("home/dev/repos.toml", &dup);
        assert_eq!(
            f.resolve("home/dev/app").unwrap_err().reason(),
            ERROR_REGISTRY_INVALID
        );

        let big = format!(
            "{REGISTRY}#{}\n",
            "x".repeat(usize::try_from(REGISTRY_MAX_BYTES).unwrap())
        );
        f.write("home/dev/repos.toml", &big);
        let e = f.resolve("home/dev/app").unwrap_err();
        assert!(
            matches!(e, ProjectError::RegistryUnreadable { .. }),
            "{e:?}"
        );
        assert_eq!(e.reason(), ERROR_REGISTRY_UNREADABLE);

        std::fs::write(f.path("home/dev/repos.toml"), b"owners = [\"\xff\"]\n").unwrap();
        assert_eq!(
            f.resolve("home/dev/app").unwrap_err().reason(),
            ERROR_REGISTRY_UNREADABLE
        );
    }
}
