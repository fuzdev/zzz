//! What a filer ignores: fixed names under a plain dir, git's answer under a
//! git root, and the git calls behind the second.
//!
//! A filer's [`IgnoreRule`] is decided once, at `start_filer`, from its root
//! alone — never from who asked for the filer, so one filer serves every
//! lifetime and project that shares its root. A root whose own `.git` is a
//! directory or a gitfile by `lstat` (`project::is_checkout`, the resolver's
//! test) indexing its whole tree takes [`IgnoreRule::Git`]; anything else —
//! a plain dir, a registry root indexed at its top level, a git root when
//! git is unusable or its first listing fails — takes
//! [`IgnoreRule::FixedNames`]. A git root falls back to fixed names for the
//! rest of the filer's life when its root stops being the checkout it was
//! (`GitRoot::check_confined`), or when its re-prunes' listings fail several
//! times in a row; it never goes back. A failure short of that keeps the
//! last set until the next re-prune.
//!
//! Under either rule, `.git`, `.zzz`, the credential directories, and
//! `ScopedFs`'s staging files are ignored by name ([`ALWAYS_IGNORED_DIRS`]).
//! Under a git root the rest is git's call: what `git ls-files --others
//! --ignored --exclude-standard --directory` lists at the start, each folded
//! dir confirmed by `git check-ignore` (git folds a dir whose untracked
//! contents are all ignored even when no pattern names it, as zzz's own
//! `.claude/` is), so only confirmed dirs are pruned whole and the rest are
//! walked with their ignored files skipped one by one. A tracked `dist/` is
//! indexed, an untracked `node_modules/` git doesn't ignore is too.

use crate::scoped_fs::ZZZ_DIR_NAME;
use fuz_git::{CallOptions, Git, GitError};
use parking_lot::RwLock;
use std::collections::HashSet;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// -- Names --------------------------------------------------------------------

/// Directory names ignored by every filer under every rule, wherever they
/// appear. `ignored_dirs` (`FilerConfig`) adds specific directories by full
/// path on top of these.
///
/// `.git` is a repo's internals, never its content. `.zzz` is zzz's
/// conventional app-dir and CLI daemon-home name — the daemon home
/// (`~/.zzz/`) holds `.env`, `bootstrap_token`, and `run/`, which must never
/// be indexed or broadcast from a root that covers it, whatever a
/// `.gitignore` says. The credential directories
/// (`scoped_fs::CREDENTIAL_DIR_NAMES`) are ignored the same way, by
/// [`is_always_ignored_name`].
const ALWAYS_IGNORED_DIRS: &[&str] = &[".git", ZZZ_DIR_NAME];

/// Directory names a plain dir's filer ignores besides
/// [`ALWAYS_IGNORED_DIRS`] — the build and dependency output that would
/// swamp an index. Under a git root git decides these instead: a tracked
/// `dist/` is content, and a `.gitignore` names what the repo generates.
const PLAIN_DIR_IGNORED_DIRS: &[&str] = &["node_modules", ".svelte-kit", "target", "dist"];

/// Whether a single path component is ignored under every rule: a name in
/// [`ALWAYS_IGNORED_DIRS`], a credential directory (which `ScopedFs` refuses
/// too), or a `ScopedFs::write_file` staging file (only the rename that
/// publishes a write is indexed and broadcast).
fn is_always_ignored_name(name: &str) -> bool {
    ALWAYS_IGNORED_DIRS.contains(&name)
        || crate::scoped_fs::is_credential_dir_name(name)
        || crate::scoped_fs::is_temp_file_name(name)
}

// -- The rule -----------------------------------------------------------------

/// How a filer decides what it doesn't index (the module docs say which
/// root gets which).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum IgnoreRule {
    /// [`ALWAYS_IGNORED_DIRS`] and [`PLAIN_DIR_IGNORED_DIRS`] by name,
    /// wherever they appear.
    FixedNames,
    /// [`ALWAYS_IGNORED_DIRS`] by name, and the paths git ignores.
    Git(IgnoredSet),
}

/// The absolute paths (no trailing `/`) git ignores under a git root: the
/// folded dirs `check-ignore` confirmed, pruned whole, and the ignored files
/// listed one by one, each ignored alone — kept apart, so a path that was an
/// ignored dir and is now a file (or the other way) isn't taken for the
/// entry it no longer is. Grows as live adds are vetted, and is rebuilt by
/// each re-prune.
///
/// It also holds the unpopulated submodules a vetting found (git refuses to
/// answer for a path inside one), pruned like dirs and never published as
/// ignored; a re-prune forgets them, and the next vetting there finds them
/// again.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct IgnoredSet {
    dirs: HashSet<String>,
    files: HashSet<String>,
    submodules: HashSet<String>,
}

impl IgnoredSet {
    /// Add `path`, as an ignored dir or an ignored file.
    pub(super) fn insert(&mut self, path: String, is_dir: bool) {
        if is_dir {
            self.dirs.insert(path);
        } else {
            self.files.insert(path);
        }
    }

    /// A set of `dirs` and `files`.
    #[cfg(test)]
    pub(super) fn of(dirs: &[&str], files: &[&str]) -> Self {
        let mut set = Self::default();
        for dir in dirs {
            set.insert((*dir).to_owned(), true);
        }
        for file in files {
            set.insert((*file).to_owned(), false);
        }
        set
    }

    /// Add `dir` as an unpopulated submodule's.
    pub(super) fn insert_submodule(&mut self, dir: String) {
        self.submodules.insert(dir);
    }

    pub(super) fn is_empty(&self) -> bool {
        self.dirs.is_empty() && self.files.is_empty() && self.submodules.is_empty()
    }

    /// Whether `dir` is exactly a dir the set prunes.
    fn holds_dir(&self, dir: &str) -> bool {
        self.dirs.contains(dir) || self.submodules.contains(dir)
    }

    /// Whether `path`, or a dir above it below `source_dir`, is in the set.
    pub(super) fn covers(&self, path: &Path, source_dir: &Path) -> bool {
        if path.to_str().is_some_and(|path| self.files.contains(path)) {
            return true;
        }
        path.ancestors()
            .take_while(|dir| *dir != source_dir && dir.starts_with(source_dir))
            .any(|dir| dir.to_str().is_some_and(|dir| self.holds_dir(dir)))
    }

    /// The entries of `self` that `old` lacks.
    pub(super) fn added_since(&self, old: &Self) -> Self {
        let new = |mine: &HashSet<String>, theirs: &HashSet<String>| {
            mine.difference(theirs).cloned().collect()
        };
        Self {
            dirs: new(&self.dirs, &old.dirs),
            files: new(&self.files, &old.files),
            submodules: new(&self.submodules, &old.submodules),
        }
    }

    /// The dirs the set prunes, submodules included.
    pub(super) fn pruned_dirs(&self) -> impl Iterator<Item = &String> {
        self.dirs.iter().chain(&self.submodules)
    }

    /// The ignored paths, dirs and files alike, sorted — the submodules
    /// aren't git's ignored paths, so they're left out.
    #[cfg(test)]
    pub(super) fn sorted(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.dirs.iter().chain(&self.files).cloned().collect();
        paths.sort_unstable();
        paths
    }

    /// The ignored paths as the wire carries them: relative to `source_dir`
    /// (the root, [`dir_prefix`](super::dir_prefix) form), sorted, each dir
    /// with a trailing `/` so a client can tell a pruned dir from a file
    /// skipped alone, and the root itself, ignored whole, as `./`. The
    /// submodules are left out — they aren't git's ignored paths.
    pub(super) fn relative_sorted(&self, source_dir: &str) -> Vec<String> {
        let root = source_dir.trim_end_matches('/');
        let relative = |path: &String| {
            if path == root {
                return Some(String::new());
            }
            path.strip_prefix(source_dir).map(str::to_owned)
        };
        let dirs = self.dirs.iter().filter_map(relative).map(|mut dir| {
            if dir.is_empty() {
                dir.push('.');
            }
            dir.push('/');
            dir
        });
        let files = self.files.iter().filter_map(relative);
        let mut paths: Vec<String> = dirs.chain(files).collect();
        paths.sort_unstable();
        paths
    }
}

impl IgnoreRule {
    pub(super) const fn is_git(&self) -> bool {
        matches!(self, Self::Git(_))
    }

    /// Whether an entry named `name` is ignored by its name alone.
    pub(super) fn ignores_name(&self, name: &str) -> bool {
        is_always_ignored_name(name)
            || (matches!(self, Self::FixedNames) && PLAIN_DIR_IGNORED_DIRS.contains(&name))
    }

    /// Whether git's answer ignores exactly `path`, a dir or not — the
    /// walk's check per entry, since it never descends into a dir it pruned.
    pub(super) fn ignores_entry(&self, path: &str, is_dir: bool) -> bool {
        match self {
            Self::FixedNames => false,
            Self::Git(set) if is_dir => set.holds_dir(path),
            Self::Git(set) => set.files.contains(path),
        }
    }

    /// Whether `path` is exactly a dir git's answer prunes — an event there
    /// passes the notify callback's filter, so the loop can see the dir
    /// replaced by a file.
    pub(super) fn prunes_dir(&self, path: &Path) -> bool {
        match self {
            Self::FixedNames => false,
            Self::Git(set) => path.to_str().is_some_and(|path| set.holds_dir(path)),
        }
    }
}

/// Check if a path is ignored: not valid UTF-8, an ignored name
/// ([`IgnoreRule::ignores_name`]) among its components below `source_dir`,
/// at or under one of `ignored_dirs`, or — under a git root — at or under a
/// path git ignores.
///
/// Non-UTF-8 paths are skipped entirely rather than indexed under a lossy
/// (U+FFFD) key no client could address. A path is non-UTF-8 when any
/// component is, so everything under a non-UTF-8 directory is skipped too —
/// the walker never descends into one.
///
/// Only checks names after the `source_dir` prefix — root path segments
/// like `/`, `home`, `user` can never match ignored names and are skipped.
/// `ignored_dirs` match by whole components (`Path::starts_with`), so
/// `/w/data` doesn't cover `/w/data2`.
pub(super) fn is_ignored(
    path: &Path,
    source_dir: &Path,
    ignored_dirs: &[PathBuf],
    rule: &IgnoreRule,
) -> bool {
    if path.to_str().is_none() || ignored_dirs.iter().any(|dir| path.starts_with(dir)) {
        return true;
    }
    let suffix = path.strip_prefix(source_dir).unwrap_or(path);
    if suffix
        .components()
        .any(|c| rule.ignores_name(c.as_os_str().to_str().unwrap_or("")))
    {
        return true;
    }
    match rule {
        IgnoreRule::FixedNames => false,
        IgnoreRule::Git(set) => set.covers(path, source_dir),
    }
}

/// What an event's path says about a git root's rule rather than its own
/// indexing — reported even when the path itself is ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum RuleMarker {
    /// A `.gitignore` changed: git's answer may have, anywhere. One git
    /// ignores itself still steers git, so it counts too.
    Gitignore,
    /// A `.git` appeared in (or left) this directory below the root: it
    /// holds a repo of its own now, which isn't indexed.
    RepoDir(PathBuf),
}

/// The [`RuleMarker`] of `path`, under a git root's rule — `None` under
/// fixed names, for the root's own `.git`, and for a path whose directory
/// is itself ignored (git reads no `.gitignore` in an ignored dir).
pub(super) fn rule_marker(
    path: &Path,
    source_dir: &Path,
    ignored_dirs: &[PathBuf],
    rule: &IgnoreRule,
) -> Option<RuleMarker> {
    if !rule.is_git() {
        return None;
    }
    let name = path.file_name()?;
    let parent = path.parent()?;
    if !parent.starts_with(source_dir) || is_ignored(parent, source_dir, ignored_dirs, rule) {
        return None;
    }
    if name == ".gitignore" {
        Some(RuleMarker::Gitignore)
    } else if name == ".git" && parent != source_dir {
        Some(RuleMarker::RepoDir(parent.to_path_buf()))
    } else {
        None
    }
}

/// Whether `dir` holds a repo of its own — a `.git` that is a directory, a
/// gitfile (a populated submodule's, a linked worktree's), or a symlink —
/// which a git root's filer neither descends into nor indexes. Any `.git`
/// entry — even one git wouldn't read as a repo (an empty dir, a file that
/// isn't a gitfile, a dangling link) — makes the dir a repo of its own
/// here, so its files aren't indexed though git lists them.
///
/// A symlinked `.git` counts here, unlike `project::is_checkout`, which a
/// root must pass. git itself treats a dir whose `.git` symlink resolves to a
/// repo as a nested repo and lists nothing in it, so the root's ignored
/// listing never covers what's inside: indexing it would index its
/// `node_modules/` and build output whole. The cost is that such a dir is
/// indexed by no filer, since the resolver roots a path inside it at the
/// outer checkout rather than at the dir (it opens without its files).
pub(super) fn is_nested_repo(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok_and(|meta| {
        let file_type = meta.file_type();
        file_type.is_dir() || file_type.is_file() || file_type.is_symlink()
    })
}

/// Whether a directory above `path`, below `source_dir`, holds a repo of its
/// own ([`is_nested_repo`]) — a path the walk never reaches, reported by a
/// watch added before the `.git` appeared, at any depth below it. One
/// `lstat` per directory between `path` and the root.
pub(super) fn is_in_nested_repo(path: &Path, source_dir: &Path) -> bool {
    path.ancestors()
        .skip(1)
        .take_while(|dir| *dir != source_dir && dir.starts_with(source_dir))
        .any(is_nested_repo)
}

// -- The shared rule ----------------------------------------------------------

/// A filer's rule, shared by its event loop (its only writer), its walks,
/// and its notify callback, which runs synchronously on notify's thread and
/// so reads only what's already computed. Readers take an `Arc` snapshot
/// and drop the lock at once; a writer replaces the snapshot, so a walk in
/// flight keeps the rule it started with.
#[derive(Debug, Clone)]
pub(super) struct SharedRule {
    current: Arc<RwLock<Arc<IgnoreRule>>>,
    /// Bumped on every change to the rule — the hook a publisher of the
    /// ignored paths watches.
    version: Arc<AtomicU64>,
}

impl SharedRule {
    pub(super) fn new(rule: IgnoreRule) -> Self {
        Self {
            current: Arc::new(RwLock::new(Arc::new(rule))),
            version: Arc::new(AtomicU64::new(0)),
        }
    }

    /// The rule as it stands.
    pub(super) fn get(&self) -> Arc<IgnoreRule> {
        Arc::clone(&self.current.read())
    }

    /// How many times the rule has changed.
    pub(super) fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// The rule and its version, read together: every change bumps the
    /// version under the write lock, so the two always agree.
    pub(super) fn get_versioned(&self) -> (Arc<IgnoreRule>, u64) {
        let current = self.current.read();
        (Arc::clone(&current), self.version.load(Ordering::Acquire))
    }

    /// Replace the rule, bumping the version when it differs.
    pub(super) fn set(&self, rule: IgnoreRule) {
        let mut current = self.current.write();
        if **current != rule {
            *current = Arc::new(rule);
            self.version.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// Add `more` to a git rule's set (nothing under fixed names), bumping
    /// the version when any entry is new. Returns how many were.
    pub(super) fn extend(&self, more: &IgnoredSet) -> usize {
        let mut current = self.current.write();
        let IgnoreRule::Git(set) = &**current else {
            return 0;
        };
        let new = more.added_since(set);
        let added = new.dirs.len() + new.files.len() + new.submodules.len();
        if added == 0 {
            return 0;
        }
        // clones the set only while a walk holds the old snapshot
        if let IgnoreRule::Git(set) = Arc::make_mut(&mut current) {
            set.dirs.extend(new.dirs);
            set.files.extend(new.files);
            set.submodules.extend(new.submodules);
        }
        self.version.fetch_add(1, Ordering::AcqRel);
        added
    }

    /// Drop `dir` from a git rule's pruned dirs — it's no longer a dir —
    /// bumping the version when it was there.
    pub(super) fn forget_dir(&self, dir: &str) {
        let mut current = self.current.write();
        if !current.prunes_dir(Path::new(dir)) {
            return;
        }
        if let IgnoreRule::Git(set) = Arc::make_mut(&mut current) {
            set.dirs.remove(dir);
            set.submodules.remove(dir);
        }
        self.version.fetch_add(1, Ordering::AcqRel);
    }
}

// -- Git calls ----------------------------------------------------------------

/// The timeout of each listing call (`ls_ignored`, and the `check_ignore`
/// that confirms its folded dirs). wpt (160k tracked files) lists in about
/// 0.3 s warm, so this leaves room for a cold cache on a tree that size.
/// It's also the longest a `.gitignore` git blocks on reading (a FIFO)
/// holds up a listing: the open that starts the filer, or the event loop
/// re-pruning. Each prune lists twice (around its walk), so a burst's
/// vetting can stall the loop for a check, a listing, and the re-prune's
/// listing in turn — about 12 s when git never answers, the first timeout
/// ending each step; a git that answers slowly but in time stalls it longer.
const LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// The timeout of each live `check_ignore`. A burst runs up to `VET_ROUNDS`
/// of them, then up to `VET_MAX_NEW_DIRS` scoped prunes (each listed twice,
/// around its walk: up to four calls under [`LIST_TIMEOUT`]), so a git that
/// answers slowly but in time stalls the loop well past this; the first
/// timeout ends the vetting with a re-prune. A check answers in tens of
/// milliseconds even on wpt; the index git reads is most of that.
const CHECK_TIMEOUT: Duration = Duration::from_secs(2);

/// The most unpopulated submodules one live `check_ignore` drops and asks
/// again without ([`GitRoot::check`]): git names one per refusal, so a
/// burst touching several (a `git submodule deinit` of many, files written
/// into each) takes a call per submodule. Past this the burst re-prunes.
const CHECK_MAX_SUBMODULES: usize = 8;

/// Why git couldn't answer for a git root.
#[derive(Debug, thiserror::Error)]
pub(super) enum IgnoreError {
    /// The dir git would run in isn't the real directory it was — swapped
    /// for a symlink or gone — or the root is no longer a checkout.
    #[error("{0} is no longer the directory it was")]
    Unconfined(String),
    /// A dir to list isn't UTF-8, so its listing couldn't be keyed — never
    /// "nothing ignored".
    #[error("{0} isn't a UTF-8 path")]
    NotUtf8(String),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error("the git call didn't finish")]
    Join(#[source] tokio::task::JoinError),
}

/// What one live vetting found: the paths git ignores, and the
/// unpopulated submodules it refused to answer inside (their paths
/// dropped from the batch, which was asked again without them).
#[derive(Debug, Default)]
pub(super) struct Checked {
    pub(super) ignored: Vec<String>,
    pub(super) submodules: Vec<String>,
}

/// A git root's handle on git: the runner, and the root it's confined to.
#[derive(Debug, Clone)]
pub(super) struct GitRoot {
    git: Arc<Git>,
    /// The root, canonical, without a trailing `/`.
    dir: PathBuf,
    /// Its parent: git's discovery ceiling, so a root that lost its `.git`
    /// never resolves to an enclosing repo.
    parent: PathBuf,
}

impl GitRoot {
    /// The git root at `source_dir` ([`dir_prefix`](super::dir_prefix)
    /// form), when it's a checkout (`project::is_checkout`).
    pub(super) fn at(source_dir: &str, git: Arc<Git>) -> Option<Self> {
        let dir = super::prefix_dir(source_dir).to_path_buf();
        if !crate::project::is_checkout(&dir) {
            return None;
        }
        let parent = dir.parent()?.to_path_buf();
        Some(Self { git, dir, parent })
    }

    pub(super) fn dir(&self) -> &Path {
        &self.dir
    }

    /// `<root>/.git/info/exclude`, the excludes file a filer's watch on
    /// [`real_info_dir`] reports.
    pub(super) fn info_exclude(&self) -> PathBuf {
        self.dir.join(".git/info/exclude")
    }

    fn opts(&self, timeout: Duration) -> CallOptions<'_> {
        CallOptions {
            ceiling: Some(&self.parent),
            timeout: Some(timeout),
            // a bare repo planted in the tree isn't read as one
            refuse_implicit_bare: true,
            ..CallOptions::default()
        }
    }

    /// Re-confine before a spawn: `dir` (the root or a dir below it) is
    /// still a real directory at its canonical path — not swapped for a
    /// symlink git would follow out of the tree — and the root is still a
    /// checkout.
    fn check_confined(&self, dir: &Path) -> Result<(), IgnoreError> {
        let unconfined = || IgnoreError::Unconfined(dir.display().to_string());
        let is_real_dir = std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir());
        let is_canonical = std::fs::canonicalize(dir).is_ok_and(|canonical| canonical == dir);
        if !is_real_dir || !is_canonical || !crate::project::is_checkout(&self.dir) {
            return Err(unconfined());
        }
        Ok(())
    }

    /// The paths git ignores under `dir` (the root or a dir below it, which
    /// must not be inside an ignored dir): `ls_ignored`, then one
    /// `check_ignore` over its folded dirs, keeping those it confirms and
    /// every listed file. A `dir` git folds whole is the one dir.
    /// Blocking: two git spawns.
    fn prune_blocking(&self, dir: &Path) -> Result<IgnoredSet, IgnoreError> {
        let dir_str = dir
            .to_str()
            .ok_or_else(|| IgnoreError::NotUtf8(dir.display().to_string()))?;
        self.check_confined(dir)?;
        let listed = self.git.ls_ignored(dir, self.opts(LIST_TIMEOUT))?;
        let is_whole = |path: &PathBuf| path.as_os_str().as_bytes() == b"./";
        let mut set = IgnoredSet::default();
        if listed.files.is_empty() && listed.dirs.len() == 1 && is_whole(&listed.dirs[0]) {
            set.insert(dir_str.to_owned(), true);
            return Ok(set);
        }
        // `./` beside contents is a folded dir those contents answer for
        let folded: Vec<&PathBuf> = listed.dirs.iter().filter(|d| !is_whole(d)).collect();
        let confirmed = if folded.is_empty() {
            vec![]
        } else {
            self.check_confined(dir)?;
            self.git
                .check_ignore(dir, &folded, self.opts(LIST_TIMEOUT))?
        };
        let absolute = |rel: &PathBuf| {
            let rel = rel.to_str()?.trim_end_matches('/');
            Some(format!("{dir_str}/{rel}"))
        };
        for path in confirmed.iter().filter_map(absolute) {
            set.insert(path, true);
        }
        for path in listed.files.iter().filter_map(absolute) {
            set.insert(path, false);
        }
        Ok(set)
    }

    /// Which of `paths` (absolute, below the root, never inside a nested
    /// repo or populated submodule) git ignores, in one `check_ignore` — or
    /// more, when git refuses a path inside an unpopulated submodule: git
    /// names one submodule a refusal, so its paths are dropped, it's
    /// reported, and the rest asked again, once per distinct submodule up
    /// to [`CHECK_MAX_SUBMODULES`]. A refusal past that, or one naming a
    /// submodule already dropped, fails. Blocking: one git spawn, plus one
    /// per submodule.
    fn check_blocking(&self, paths: &[String]) -> Result<Checked, IgnoreError> {
        let mut paths: Vec<&String> = paths.iter().collect();
        let mut submodules: Vec<String> = Vec::new();
        let ignored = loop {
            match self.check_once(&paths) {
                Err(IgnoreError::Git(GitError::InSubmodule { stderr, args }))
                    if submodules.len() < CHECK_MAX_SUBMODULES
                        && let Some(submodule) = self.refused_submodule(&stderr)
                        && !submodules.contains(&submodule) =>
                {
                    tracing::debug!(
                        path = %submodule,
                        git = %args,
                        "git refused a path in an unpopulated submodule; leaving it unindexed"
                    );
                    paths.retain(|path| !Path::new(path).starts_with(&submodule));
                    submodules.push(submodule);
                }
                result => break result?,
            }
        };
        Ok(Checked {
            ignored,
            submodules,
        })
    }

    /// One `check_ignore` of `paths` from the root.
    fn check_once(&self, paths: &[&String]) -> Result<Vec<String>, IgnoreError> {
        let rels: Vec<&Path> = paths
            .iter()
            .filter_map(|path| Path::new(path).strip_prefix(&self.dir).ok())
            .collect();
        if rels.is_empty() {
            return Ok(vec![]);
        }
        self.check_confined(&self.dir)?;
        let ignored = self
            .git
            .check_ignore(&self.dir, &rels, self.opts(CHECK_TIMEOUT))?;
        Ok(ignored
            .iter()
            .filter_map(|rel| Some(self.dir.join(rel).to_str()?.to_owned()))
            .collect())
    }

    /// The absolute dir of the submodule git names in refusing a path
    /// inside one — `fatal: Pathspec '<path>' is in submodule '<name>'`
    /// under the runner's `LC_ALL=C`, `<name>` relative to the root —
    /// when it's a plain relative path below the root.
    ///
    /// A path holding a newline can forge the line parsed (the last
    /// `fatal: Pathspec` line), naming another dir below the root as the
    /// submodule. That only leaves that dir unindexed — an omission from
    /// the index the repo's author could cause anyway (a `.gitignore`), not
    /// a path out of the root.
    fn refused_submodule(&self, stderr: &str) -> Option<String> {
        let line = stderr
            .lines()
            .rev()
            .find(|line| line.starts_with("fatal: Pathspec '"))?;
        let (_, rest) = line.rsplit_once("' is in submodule '")?;
        let name = Path::new(rest.strip_suffix('\'')?);
        let is_plain = name.components().next().is_some()
            && name
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)));
        is_plain.then(|| self.dir.join(name).to_str().map(str::to_owned))?
    }

    /// [`Self::prune_blocking`] on a blocking thread.
    pub(super) async fn prune(&self, dir: PathBuf) -> Result<IgnoredSet, IgnoreError> {
        let root = self.clone();
        tokio::task::spawn_blocking(move || root.prune_blocking(&dir))
            .await
            .map_err(IgnoreError::Join)?
    }

    /// [`Self::check_blocking`] on a blocking thread.
    pub(super) async fn check(&self, paths: Vec<String>) -> Result<Checked, IgnoreError> {
        let root = self.clone();
        tokio::task::spawn_blocking(move || root.check_blocking(&paths))
            .await
            .map_err(IgnoreError::Join)?
    }
}

/// `<root>/.git/info`, when `.git` and `info` are both real directories by
/// `lstat` — the dir a git root's filer watches besides its walk's, so an
/// `info/exclude` edit re-prunes. `None` for a gitfile root (a linked
/// worktree, a submodule's checkout), which reads `info/exclude` from its
/// common dir — named only by the gitfile and the git dir's `commondir`
/// file, paths the filer would have to follow out of the tree on the repo's
/// word, so it doesn't: there, an `info/exclude` edit takes effect at the
/// next re-prune (a `.gitignore` change, an overflow).
pub(super) fn real_info_dir(root: &Path) -> Option<PathBuf> {
    let git_dir = root.join(".git");
    let info = git_dir.join("info");
    let is_real_dir = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir());
    (is_real_dir(&git_dir) && is_real_dir(&info)).then_some(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filer::core::FilerConfig;
    use crate::filer::dir_prefix;
    use crate::filer::test_support::{
        TempDir, checkout, keys_of, run_git, start, start_git, test_git, wait_for_keys,
        watched_dirs,
    };

    fn git_rule(dirs: &[&str], files: &[&str]) -> IgnoreRule {
        IgnoreRule::Git(IgnoredSet::of(dirs, files))
    }

    #[test]
    fn the_always_names_hold_under_every_rule_and_the_rest_only_under_fixed_names() {
        let git = git_rule(&[], &[]);
        for name in [".git", ".zzz", ".ssh", ".gnupg", ".zzz-tmp-x"] {
            assert!(IgnoreRule::FixedNames.ignores_name(name), "{name}");
            assert!(git.ignores_name(name), "{name}");
        }
        for name in ["node_modules", ".svelte-kit", "target", "dist"] {
            assert!(IgnoreRule::FixedNames.ignores_name(name), "{name}");
            assert!(!git.ignores_name(name), "{name}");
        }
    }

    #[test]
    fn a_git_set_covers_its_paths_and_what_is_under_them() {
        let root = Path::new("/w/");
        let rule = git_rule(&["/w/build"], &["/w/a.log"]);
        let ignored = |p: &str| is_ignored(Path::new(p), root, &[], &rule);
        assert!(ignored("/w/build"));
        assert!(ignored("/w/build/x/y"));
        assert!(ignored("/w/a.log"));
        assert!(!ignored("/w/a.log2"));
        assert!(!ignored("/w/buildx/y"));
        assert!(!ignored("/w/src/a.log"));
        assert!(!ignored("/w/node_modules/x"));
        // the root itself is never covered
        assert!(!is_ignored(
            Path::new("/w"),
            root,
            &[],
            &git_rule(&["/w"], &[])
        ));
        // a file entry covers nothing below it, and the walk asks by type
        assert!(!ignored("/w/a.log/x"));
        assert!(rule.ignores_entry("/w/build", true));
        assert!(!rule.ignores_entry("/w/build", false));
        assert!(rule.ignores_entry("/w/a.log", false));
        assert!(!rule.ignores_entry("/w/a.log", true));
        assert!(rule.prunes_dir(Path::new("/w/build")));
        assert!(!rule.prunes_dir(Path::new("/w/a.log")));
        // the always-names whatever the set says
        assert!(ignored("/w/src/.git/HEAD"));
    }

    #[test]
    fn rule_markers_name_gitignores_and_nested_git_dirs() {
        let root = Path::new("/w/");
        let rule = git_rule(&["/w/build"], &[]);
        let marker = |p: &str| rule_marker(Path::new(p), root, &[], &rule);
        assert_eq!(marker("/w/.gitignore"), Some(RuleMarker::Gitignore));
        assert_eq!(marker("/w/src/.gitignore"), Some(RuleMarker::Gitignore));
        assert_eq!(
            marker("/w/src/.git"),
            Some(RuleMarker::RepoDir(PathBuf::from("/w/src")))
        );
        // the root's own `.git`, a `.gitignore` in an ignored dir, any other name
        assert_eq!(marker("/w/.git"), None);
        assert_eq!(marker("/w/build/.gitignore"), None);
        assert_eq!(marker("/w/src/a.txt"), None);
        assert_eq!(
            rule_marker(
                Path::new("/w/.gitignore"),
                root,
                &[],
                &IgnoreRule::FixedNames
            ),
            None
        );
    }

    #[test]
    fn the_shared_rule_versions_each_change() {
        let shared = SharedRule::new(git_rule(&["/w/a"], &[]));
        assert_eq!(shared.version(), 0);
        assert_eq!(shared.extend(&IgnoredSet::of(&["/w/a"], &[])), 0);
        assert_eq!(shared.version(), 0, "nothing new");
        let held = shared.get();
        assert_eq!(shared.extend(&IgnoredSet::of(&["/w/a"], &["/w/b"])), 1);
        assert_eq!(shared.version(), 1);
        assert_eq!(
            *held,
            git_rule(&["/w/a"], &[]),
            "a held snapshot is unchanged"
        );
        shared.set(git_rule(&["/w/a"], &["/w/b"]));
        assert_eq!(shared.version(), 1, "the same rule");
        // a dir that's a file now leaves the dirs; a file entry isn't a dir
        shared.forget_dir("/w/b");
        assert_eq!(shared.version(), 1);
        shared.forget_dir("/w/a");
        assert_eq!(shared.version(), 2);
        assert_eq!(*shared.get(), git_rule(&[], &["/w/b"]));
        shared.set(IgnoreRule::FixedNames);
        assert_eq!(shared.version(), 3);
        assert_eq!(
            shared.extend(&IgnoredSet::of(&[], &["/w/c"])),
            0,
            "fixed names hold no set"
        );
    }

    #[test]
    fn the_wire_form_is_relative_with_dirs_marked_and_no_submodules() {
        let mut set = IgnoredSet::of(&["/w/build", "/w/src/out"], &["/w/a.log", "/w/src/x.local"]);
        set.insert_submodule("/w/vendor/sub".to_owned());
        assert_eq!(
            set.relative_sorted("/w/"),
            ["a.log", "build/", "src/out/", "src/x.local"]
        );
        // the root ignored whole
        assert_eq!(IgnoredSet::of(&["/w"], &[]).relative_sorted("/w/"), ["./"]);
        let shared = SharedRule::new(IgnoreRule::Git(set));
        let (rule, version) = shared.get_versioned();
        assert_eq!(version, 0);
        assert!(rule.is_git());
    }

    // -- Filers on git roots --------------------------------------------------

    #[test]
    fn a_path_is_in_a_nested_repo_at_any_depth_below_it() {
        let tmp = TempDir::new();
        std::fs::create_dir_all(tmp.path("plain/.git")).unwrap();
        std::fs::create_dir_all(tmp.path("plain/sub/deeper")).unwrap();
        std::fs::create_dir_all(tmp.path("other")).unwrap();
        let in_repo = |rel: &str| is_in_nested_repo(&tmp.path(rel), &tmp.0);
        assert!(in_repo("plain/x"));
        assert!(in_repo("plain/sub/x"));
        assert!(in_repo("plain/sub/deeper/x"));
        // the dir itself, a sibling, and the root's own `.git`
        assert!(!in_repo("plain"));
        assert!(!in_repo("other/x"));
        std::fs::create_dir_all(tmp.path(".git")).unwrap();
        assert!(!in_repo("other/x"));
    }

    #[test]
    fn a_submodule_refusal_names_the_submodule() {
        let tmp = checkout(&[]);
        let root = GitRoot::at(&tmp.root(), test_git()).unwrap();
        let refused = |stderr: &str| root.refused_submodule(stderr);
        assert_eq!(
            refused("fatal: Pathspec './my sub/f.txt' is in submodule 'my sub'"),
            Some(tmp.key("my sub"))
        );
        assert_eq!(
            refused("warning: x\nfatal: Pathspec './a/it's/f' is in submodule 'a/it's'"),
            Some(tmp.key("a/it's"))
        );
        for stderr in [
            "fatal: Pathspec './f' is in submodule '../out'",
            "fatal: Pathspec './f' is in submodule '/abs'",
            "fatal: Pathspec './f' is in submodule ''",
            "fatal: Pathspec './f' is beyond a symbolic link",
            "",
        ] {
            assert_eq!(refused(stderr), None, "{stderr}");
        }
    }

    /// A dir whose name isn't UTF-8 can't be keyed: its prune fails rather
    /// than answer "nothing ignored".
    #[tokio::test]
    async fn a_non_utf8_dir_fails_to_prune() {
        use std::os::unix::ffi::OsStrExt;
        let tmp = checkout(&[]);
        let dir = tmp.0.join(std::ffi::OsStr::from_bytes(b"bad\xff"));
        std::fs::create_dir(&dir).unwrap();
        let root = GitRoot::at(&tmp.root(), test_git()).unwrap();
        let error = root.prune(dir).await.unwrap_err();
        assert!(matches!(error, IgnoreError::NotUtf8(_)), "{error}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_gitignore_is_honored_with_its_negations() {
        let tmp = checkout(&[
            (
                ".gitignore",
                "build/\n!build/keep.txt\nlogs/*\n!logs/keep.log\n*.local\n",
            ),
            ("build/a.txt", "a"),
            ("build/keep.txt", "k"),
            ("logs/a.log", "l"),
            ("logs/keep.log", "k"),
            ("src/a.ts", "a"),
            ("src/x.local", "x"),
        ]);
        let filer = start_git(&tmp).await;
        assert_eq!(
            keys_of(&filer).await,
            tmp.keys(&[".gitignore", "logs/keep.log", "src/a.ts"])
        );
        assert_eq!(
            filer.ignored_paths(),
            Some(tmp.keys(&["build", "logs/a.log", "src/x.local"]))
        );
        // a pruned dir is never watched; a walked one is
        let watched = watched_dirs(&filer);
        assert!(!watched.contains(&dir_prefix(&tmp.key("build"))));
        assert!(watched.contains(&dir_prefix(&tmp.key("logs"))));
    }

    /// git folds `.claude/` (all its untracked contents are ignored) without
    /// ignoring it: it's walked and watched, so a new file there arrives.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_folded_dir_git_does_not_ignore_stays_watched() {
        let tmp = checkout(&[
            (".gitignore", "*.local.json\n"),
            (".claude/settings.local.json", "{}"),
        ]);
        let filer = start_git(&tmp).await;
        assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore"]));
        assert!(watched_dirs(&filer).contains(&dir_prefix(&tmp.key(".claude"))));
        tmp.write(".claude/notes.md", "n");
        wait_for_keys(&filer, &tmp.keys(&[".gitignore", ".claude/notes.md"])).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_untracked_package_keeps_its_files_and_loses_its_node_modules() {
        let tmp = checkout(&[
            (".gitignore", "node_modules/\n"),
            ("pkg/package.json", "{}"),
            ("pkg/node_modules/dep/index.js", "x"),
        ]);
        let filer = start_git(&tmp).await;
        assert_eq!(
            keys_of(&filer).await,
            tmp.keys(&[".gitignore", "pkg/package.json"])
        );
        assert!(!watched_dirs(&filer).contains(&dir_prefix(&tmp.key("pkg/node_modules"))));
    }

    /// git decides what the fixed names did: a tracked file in an ignored
    /// dir, a tracked `dist/`, and an untracked `node_modules/` no pattern
    /// names are all indexed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tracked_files_and_unignored_build_dirs_are_indexed() {
        let tmp = checkout(&[
            (".gitignore", "vendor/\n"),
            ("vendor/lib.js", "tracked"),
            ("vendor/other.js", "untracked"),
            ("dist/app.js", "tracked"),
            ("node_modules/dep/x.js", "untracked, not ignored"),
            ("target/debug/out", "untracked, not ignored"),
        ]);
        run_git(&tmp.0, &["add", "-f", "vendor/lib.js", "dist/app.js"]);
        let filer = start_git(&tmp).await;
        assert_eq!(
            keys_of(&filer).await,
            tmp.keys(&[
                ".gitignore",
                "dist/app.js",
                "node_modules/dep/x.js",
                "target/debug/out",
                "vendor/lib.js",
            ])
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_always_names_are_ignored_whatever_git_says() {
        let tmp = checkout(&[
            (".gitignore", "!.zzz/\n!.ssh/\n"),
            (".zzz/.env", "SECRET=x"),
            (".ssh/id", "SECRET"),
            ("src/.aws/credentials", "SECRET"),
            ("a.txt", "a"),
        ]);
        let staging = format!("{}{}", crate::scoped_fs::TEMP_FILE_PREFIX, "f".repeat(32));
        tmp.write(&staging, "x");
        let filer = start_git(&tmp).await;
        assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore", "a.txt"]));
        // live, too
        tmp.write(".zzz/token", "SECRET");
        tmp.write("b.txt", "b");
        wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "b.txt"])).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn nested_repos_and_submodules_are_not_indexed() {
        let source = checkout(&[("lib.rs", "x")]);
        run_git(&source.0, &["add", "."]);
        run_git(&source.0, &["commit", "-qm", "init"]);
        let tmp = checkout(&[("a.txt", "a"), ("inner/b.txt", "b"), ("plain/c.txt", "c")]);
        run_git(&tmp.path("inner"), &["init", "-q"]);
        run_git(
            &tmp.0,
            &["submodule", "add", "-q", source.0.to_str().unwrap(), "sub"],
        );
        // a `.git` symlinked to a repo elsewhere: git lists nothing in it
        std::fs::create_dir(tmp.path("linked")).unwrap();
        tmp.write("linked/d.txt", "d");
        std::os::unix::fs::symlink(source.path(".git"), tmp.path("linked/.git")).unwrap();
        let filer = start_git(&tmp).await;
        assert_eq!(
            keys_of(&filer).await,
            tmp.keys(&[".gitmodules", "a.txt", "plain/c.txt"])
        );
        let watched = watched_dirs(&filer);
        for dir in ["inner", "sub", "linked"] {
            assert!(!watched.contains(&dir_prefix(&tmp.key(dir))), "{dir}");
        }
        // a repo made in a watched dir leaves the index
        run_git(&tmp.path("plain"), &["init", "-q"]);
        wait_for_keys(&filer, &tmp.keys(&[".gitmodules", "a.txt"])).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_adds_are_vetted_by_git() {
        let tmp = checkout(&[(".gitignore", "*.log\nout/\n"), ("a.txt", "a")]);
        let filer = start_git(&tmp).await;
        // ignored files, an ignored dir, then a file that isn't: once that
        // one is in, the rest were decided
        tmp.write("b.log", "b");
        tmp.write("src/c.log", "c");
        tmp.write("out/d.txt", "d");
        tmp.write("e.txt", "e");
        wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.txt", "e.txt"])).await;
        let ignored = filer.ignored_paths().unwrap();
        assert!(ignored.contains(&tmp.key("b.log")), "{ignored:?}");
        assert!(!watched_dirs(&filer).contains(&dir_prefix(&tmp.key("out"))));
    }

    /// A directory arriving whole (renamed in) has its ignored paths listed
    /// before its walk.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_new_dir_is_walked_without_its_ignored_subtree() {
        let tmp = checkout(&[(".gitignore", "node_modules/\n*.tmp\n"), ("a.txt", "a")]);
        let filer = start_git(&tmp).await;
        let staging = TempDir::new();
        staging.write("pkg/index.js", "x");
        staging.write("pkg/y.tmp", "x");
        staging.write("pkg/node_modules/dep/z.js", "x");
        staging.write("pkg/lib/w.js", "x");
        std::fs::rename(staging.path("pkg"), tmp.path("pkg")).unwrap();
        wait_for_keys(
            &filer,
            &tmp.keys(&[".gitignore", "a.txt", "pkg/index.js", "pkg/lib/w.js"]),
        )
        .await;
        let watched = watched_dirs(&filer);
        assert!(watched.contains(&dir_prefix(&tmp.key("pkg/lib"))));
        assert!(!watched.contains(&dir_prefix(&tmp.key("pkg/node_modules"))));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_gitignore_edit_re_prunes_both_ways() {
        let tmp = checkout(&[
            (".gitignore", "*.log\n"),
            ("a.log", "a"),
            ("notes/n.md", "n"),
        ]);
        let filer = start_git(&tmp).await;
        assert_eq!(
            keys_of(&filer).await,
            tmp.keys(&[".gitignore", "notes/n.md"])
        );
        let version = filer.ignored_version();
        tmp.write(".gitignore", "notes/\n");
        wait_for_keys(&filer, &tmp.keys(&[".gitignore", "a.log"])).await;
        assert!(filer.ignored_version() > version);
        assert!(!watched_dirs(&filer).contains(&dir_prefix(&tmp.key("notes"))));
        // and a nested `.gitignore` counts too
        tmp.write("sub/.gitignore", "*.md\n");
        tmp.write("sub/x.md", "x");
        tmp.write("sub/y.txt", "y");
        wait_for_keys(
            &filer,
            &tmp.keys(&[".gitignore", "a.log", "sub/.gitignore", "sub/y.txt"]),
        )
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_info_exclude_edit_re_prunes() {
        let tmp = checkout(&[("a.txt", "a"), ("secret.txt", "s")]);
        let filer = start_git(&tmp).await;
        assert_eq!(keys_of(&filer).await, tmp.keys(&["a.txt", "secret.txt"]));
        tmp.write(".git/info/exclude", "secret.txt\n");
        wait_for_keys(&filer, &tmp.keys(&["a.txt"])).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_a_usable_git_a_checkout_keeps_the_fixed_names() {
        let files = [
            (".gitignore", "*.log\n"),
            ("a.log", "a"),
            ("node_modules/x.js", "x"),
        ];
        let expected = |tmp: &TempDir| tmp.keys(&[".gitignore", "a.log"]);
        // no git at all
        let tmp = checkout(&files);
        let filer = start(&tmp, FilerConfig::tree(&tmp.root(), "/nowhere/")).await;
        assert_eq!(keys_of(&filer).await, expected(&tmp));
        assert_eq!(filer.ignored_paths(), None);
        // a git whose first listing fails
        let tmp = checkout(&files);
        let broken = Arc::new(Git::with_clean_env(vec![(
            "PATH".into(),
            "/nonexistent".into(),
        )]));
        let config = FilerConfig {
            git: Some(broken),
            ..FilerConfig::tree(&tmp.root(), "/nowhere/")
        };
        let filer = start(&tmp, config).await;
        assert_eq!(keys_of(&filer).await, expected(&tmp));
        assert_eq!(filer.ignored_paths(), None);
    }

    /// A plain dir, and a registry root indexed at its top level, keep the
    /// fixed names whatever a `.gitignore` says.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn plain_dirs_and_top_level_roots_keep_the_fixed_names() {
        let tmp = TempDir::new();
        tmp.write(".gitignore", "*.log\n");
        tmp.write("a.log", "a");
        tmp.write("dist/x.js", "x");
        let filer = start_git(&tmp).await;
        assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore", "a.log"]));
        assert_eq!(filer.ignored_paths(), None);

        let registry = checkout(&[
            (".gitignore", "*.log\n"),
            ("a.log", "a"),
            ("repo/b.txt", "b"),
        ]);
        let config = FilerConfig {
            git: Some(test_git()),
            ..FilerConfig::top_level(&registry.root(), "/nowhere/")
        };
        let filer = start(&registry, config).await;
        assert_eq!(
            keys_of(&filer).await,
            registry.keys(&[".gitignore", "a.log"])
        );
        assert_eq!(filer.ignored_paths(), None);
    }

    /// A root swapped for a symlink (here, to another checkout) is refused
    /// before git runs, and the filer falls back to fixed names.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_root_swapped_for_a_symlink_falls_back_to_fixed_names() {
        let tmp = checkout(&[(".gitignore", "*.log\n"), ("a.log", "a"), ("b.txt", "b")]);
        let root = GitRoot::at(&tmp.root(), test_git()).unwrap();
        assert!(root.prune(tmp.0.clone()).await.is_ok());

        let elsewhere = checkout(&[("c.txt", "c")]);
        let moved = TempDir::new();
        std::fs::remove_dir(&moved.0).unwrap();
        std::fs::rename(&tmp.0, &moved.0).unwrap();
        std::os::unix::fs::symlink(&elsewhere.0, &tmp.0).unwrap();
        let error = root.prune(tmp.0.clone()).await.unwrap_err();
        assert!(matches!(error, IgnoreError::Unconfined(_)), "{error}");
        let error = root.check(vec![tmp.key("b.txt")]).await.unwrap_err();
        assert!(matches!(error, IgnoreError::Unconfined(_)), "{error}");
        std::fs::remove_file(&tmp.0).unwrap();
        std::fs::rename(&moved.0, &tmp.0).unwrap();

        // a running filer whose re-prune finds it swapped: its watch on
        // the moved root still reports the `.gitignore` edit
        let filer = start_git(&tmp).await;
        assert_eq!(keys_of(&filer).await, tmp.keys(&[".gitignore", "b.txt"]));
        std::fs::rename(&tmp.0, &moved.0).unwrap();
        std::os::unix::fs::symlink(&elsewhere.0, &tmp.0).unwrap();
        std::fs::write(moved.path(".gitignore"), "*.txt\n").unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while filer.ignored_paths().is_some() {
            assert!(tokio::time::Instant::now() < deadline, "no fallback");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        std::fs::remove_file(&tmp.0).unwrap();
        std::fs::rename(&moved.0, &tmp.0).unwrap();
    }
}
