//! The open projects: their state, and the one path that changes it.
//!
//! [`ProjectManager`] owns which projects are open and what each focuses.
//! Everything else that follows from that — the filers running for them, the
//! `ScopedFs` roots admitting them, what `project_list` and `session_load`
//! report — is derived from that state in one place, [`ProjectManager::commit`]:
//! an open, close, focus, or unfocus computes the next state and commits it,
//! and the commit starts the filers the next state needs, stops or narrows
//! the ones it doesn't, sets the roots, publishes the snapshot readers see,
//! and broadcasts `project_changed` — all under the lock that guards the
//! state, so those stay in step and notifications for one root go out in the
//! order its changes took effect.
//!
//! What a project keeps indexed is [`filers_of`]: a registry's root at its
//! top level, and each focused directory whole. Two projects can keep one
//! directory (a registry's entry that's also open as its own project), so
//! what runs is the union over the open projects, each directory at the
//! deepest any of them indexes it ([`desired_filers`]) — never a count kept
//! by hand.
//!
//! An initial scan walks, watches, and stats a whole tree, so an open or a
//! focus starts its filers *before* taking the lock, where other projects'
//! changes don't wait on it; the commit then finds them running. If the
//! operation fails after that, what it started and the open projects don't
//! keep is released under the lock ([`release`]).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use fuz_realtime::notify_to_string;
use fuz_repos::registry::EntryKind;
use serde::Serialize;

use crate::filer::{FilerConfig, FilerDepth, FilerLifetime, SerializableDisknode, WatchStatus};
use crate::handlers::App;

// -- State ----------------------------------------------------------------------

/// An open project as the manager holds it. [`ProjectInfo`] is its wire
/// projection ([`Self::to_info`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenProject {
    /// The root, canonical, with a trailing `/` — the project's identity.
    pub root: String,
    /// The root's basename.
    pub name: String,
    /// When it was first opened (RFC 3339).
    pub opened_at: String,
    pub kind: OpenKind,
}

/// Which rule rooted an open project ([`crate::project::ProjectKind`]).
///
/// Only a registry has entries and a focus to change; a checkout's or plain
/// directory's one focus is its root, for as long as it's open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenKind {
    Registry {
        /// The registry file as found at the root.
        registry_path: String,
        /// The entries, in the registry's order.
        entries: Vec<OpenEntry>,
        /// The focused entries' dirs (trailing `/`), each indexed whole: the
        /// present entries an open or `repo_focus` focused. May be empty.
        focused: BTreeSet<String>,
    },
    GitRepo,
    PlainDir,
}

/// A registry entry of an open project ([`crate::project::ProjectEntry`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenEntry {
    /// The entry's key in its table.
    pub key: String,
    pub kind: EntryKind,
    /// Where its checkout is (trailing `/`): canonical when present, else
    /// the declared dir under the root.
    pub dir: String,
    pub state: EntryState,
}

/// Where an entry's checkout stands, as the project's last resolve left it
/// ([`crate::project::EntryDir`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryState {
    /// Focusable.
    Present,
    /// Not yet cloned.
    Missing,
    /// Refused alone, for `reason`: `EntryRefusal::reason`, or `invalid_path`
    /// for a present dir whose path isn't UTF-8.
    Refused { reason: &'static str },
}

impl OpenProject {
    /// The focused directories, sorted: a registry's focused entries, or a
    /// checkout's or plain directory's root.
    pub fn focused(&self) -> Vec<&str> {
        match &self.kind {
            OpenKind::Registry { focused, .. } => focused.iter().map(String::as_str).collect(),
            OpenKind::GitRepo | OpenKind::PlainDir => vec![self.root.as_str()],
        }
    }

    /// The project as the wire carries it.
    pub fn to_info(&self) -> ProjectInfo {
        let (kind, registry_path, entries) = match &self.kind {
            OpenKind::Registry {
                registry_path,
                entries,
                ..
            } => (
                ProjectInfoKind::Registry,
                Some(registry_path.clone()),
                entries.iter().map(OpenEntry::to_info).collect(),
            ),
            OpenKind::GitRepo => (ProjectInfoKind::GitRepo, None, Vec::new()),
            OpenKind::PlainDir => (ProjectInfoKind::PlainDir, None, Vec::new()),
        };
        ProjectInfo {
            root: self.root.clone(),
            name: self.name.clone(),
            opened_at: self.opened_at.clone(),
            kind,
            registry_path,
            entries,
            focused: self.focused().into_iter().map(str::to_owned).collect(),
        }
    }
}

impl OpenEntry {
    /// The entry as the wire carries it.
    fn to_info(&self) -> ProjectEntryInfo {
        let (state, reason) = match self.state {
            EntryState::Present => (ProjectEntryState::Present, None),
            EntryState::Missing => (ProjectEntryState::Missing, None),
            EntryState::Refused { reason } => (ProjectEntryState::Refused, Some(reason)),
        };
        ProjectEntryInfo {
            key: self.key.clone(),
            kind: match self.kind {
                EntryKind::Repo => EntryInfoKind::Repo,
                EntryKind::Reference => EntryInfoKind::Reference,
            },
            dir: self.dir.clone(),
            state,
            reason,
        }
    }
}

// -- Wire -----------------------------------------------------------------------

/// An open project — twin of `ProjectInfoJson` in `project.svelte.ts`. Built
/// from an [`OpenProject`], never stored: its flat shape admits states the
/// domain type rules out.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub opened_at: String,
    pub kind: ProjectInfoKind,
    /// The registry file, for a registry project.
    pub registry_path: Option<String>,
    /// A registry's entries, in its order; empty for other kinds.
    pub entries: Vec<ProjectEntryInfo>,
    /// The focused directories (trailing `/`), sorted ([`OpenProject::focused`]).
    pub focused: Vec<String>,
}

/// Which rule rooted a project ([`OpenKind`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectInfoKind {
    Registry,
    GitRepo,
    PlainDir,
}

/// A registry entry of an open project — twin of `ProjectEntryJson`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectEntryInfo {
    pub key: String,
    pub kind: EntryInfoKind,
    pub dir: String,
    pub state: ProjectEntryState,
    /// Why it's refused, for a refused entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

/// A registry's two tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryInfoKind {
    Repo,
    Reference,
}

/// Where an entry's checkout stands ([`EntryState`], its reason aside).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectEntryState {
    Present,
    Missing,
    Refused,
}

/// What a `project_changed` notification reports.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ProjectChange {
    /// Newly open.
    Open,
    /// Already open, and now different: a new focus, or the registry's
    /// entries as resolved again.
    Update,
    Close,
}

#[derive(Serialize)]
struct ProjectChangedParams {
    #[serde(rename = "type")]
    change_type: ProjectChange,
    project: ProjectInfo,
}

/// The directories to index, each with how much of it ([`filers_of`],
/// [`desired_filers`]).
pub type Filers = BTreeMap<String, FilerDepth>;

/// The open projects, keyed by root (trailing `/`).
type Projects = BTreeMap<String, OpenProject>;

/// What readers that don't take the lock see: the state as the last commit
/// left it ([`ProjectManager::published`]).
#[derive(Debug, Default)]
pub struct PublishedProjects {
    /// The open projects, by root.
    pub projects: Vec<OpenProject>,
    /// The directories those projects keep indexed ([`desired_filers`]). A
    /// filer running on any other directory belongs to no open project — a
    /// permanent one, or one an open or focus in flight started.
    pub filers: BTreeSet<String>,
}

/// Why an open, close, focus, or unfocus didn't take effect, or a read of a
/// focus ([`ProjectManager::focused_files`]) was refused.
#[derive(Debug, thiserror::Error)]
pub enum LifecycleError {
    /// The root names no open project.
    #[error("project not open: {root}")]
    NotOpen { root: String },
    /// A read of a directory that's none of the open project's focused
    /// directories.
    #[error("{dir} isn't a focused repo of {root}")]
    NotFocused { root: String, dir: String },
    /// A focus or unfocus on a checkout or plain directory, whose one focus
    /// is its root, kept while it's open.
    #[error("{root} isn't a registry project — its root is its one focus")]
    NotRegistry { root: String },
    /// The directory is none of the registry's entries.
    #[error("{dir} is none of the registry entries of {root}")]
    RepoNotInProject { root: String, dir: String },
    /// A focus on an entry not cloned as the project last resolved it.
    #[error(
        "registry entry {key} isn't cloned at {dir} (opening a path in it resolves the registry again)"
    )]
    RepoMissing { key: String, dir: String },
    /// A focus on an entry the last resolve refused.
    #[error("registry entry {key} at {dir} is refused: {reason}")]
    RepoRefused {
        key: String,
        dir: String,
        reason: &'static str,
    },
    /// A directory the next state needs indexed can't be listed. Nothing
    /// changed.
    #[error("can't index {dir}")]
    Filer {
        dir: String,
        #[source]
        source: std::io::Error,
    },
    /// The change took effect, and its `project_changed` couldn't be built.
    #[error("notification params serialize failed")]
    Notify(#[source] serde_json::Error),
}

/// An open or focus as it landed: the project, and the directories it keeps
/// indexed — whose files the reply carries.
#[derive(Debug)]
pub struct Landed {
    pub project: OpenProject,
    pub filers: Filers,
}

/// A focused directory's index as one commit left it
/// ([`ProjectManager::focused_files`]).
#[derive(Debug)]
pub struct FocusedFiles {
    /// The files of the directory's filer.
    pub files: Vec<SerializableDisknode>,
    /// Over every directory the project keeps indexed, as an open's.
    pub watch_status: WatchStatus,
}

// -- Derivations ----------------------------------------------------------------

/// The filers a project keeps, each a directory key and what it indexes.
///
/// A registry's root at its top level, and every focused directory whole.
/// The root of a checkout or plain directory is its one focused directory.
pub fn filers_of(project: &OpenProject) -> Filers {
    let mut filers: Filers = project
        .focused()
        .into_iter()
        .map(|dir| (dir.to_owned(), FilerDepth::Tree))
        .collect();
    filers
        .entry(project.root.clone())
        .or_insert(FilerDepth::TopLevel);
    filers
}

/// What `projects` keep of each directory: the deepest any of them indexes
/// it.
fn desired_filers<'a>(projects: impl IntoIterator<Item = &'a OpenProject>) -> Filers {
    let mut desired = Filers::new();
    for project in projects {
        deepen(&mut desired, &filers_of(project));
    }
    desired
}

/// Add `more` to `filers`, keeping the deeper of two depths for a directory.
fn deepen(filers: &mut Filers, more: &Filers) {
    for (dir, depth) in more {
        let entry = filers.entry(dir.clone()).or_insert(*depth);
        if *depth == FilerDepth::Tree {
            *entry = FilerDepth::Tree;
        }
    }
}

/// `existing` updated by a fresh resolve of the same root: the fresh kind
/// and entries, and the focused directories of both that the fresh resolve
/// still supports — a present entry's dir for a registry, the root for a
/// checkout or plain directory. So a focus outlives no change of kind (a
/// plain `~/dev` focused on its root, then a registry there) and no entry
/// removed or gone missing.
pub(crate) fn merge_project(existing: &OpenProject, fresh: &OpenProject) -> OpenProject {
    let mut merged = OpenProject {
        opened_at: existing.opened_at.clone(),
        ..fresh.clone()
    };
    // a checkout's or plain directory's one focus is its root, as fresh
    if let OpenKind::Registry {
        entries, focused, ..
    } = &mut merged.kind
    {
        let supported = |dir: &str| {
            entries
                .iter()
                .any(|entry| entry.state == EntryState::Present && entry.dir == dir)
        };
        let kept: Vec<String> = existing
            .focused()
            .into_iter()
            .filter(|dir| supported(dir))
            .map(str::to_owned)
            .collect();
        focused.extend(kept);
    }
    merged
}

/// The focus of `project` to change — refused when it isn't a registry,
/// whose one focus is its root.
fn focused_mut(project: &mut OpenProject) -> Result<&mut BTreeSet<String>, LifecycleError> {
    match &mut project.kind {
        OpenKind::Registry { focused, .. } => Ok(focused),
        OpenKind::GitRepo | OpenKind::PlainDir => Err(LifecycleError::NotRegistry {
            root: project.root.clone(),
        }),
    }
}

/// The entry of `project` whose checkout is `dir` — refused when `project`
/// isn't a registry or has no such entry.
fn entry_of<'a>(project: &'a OpenProject, dir: &str) -> Result<&'a OpenEntry, LifecycleError> {
    let OpenKind::Registry { entries, .. } = &project.kind else {
        return Err(LifecycleError::NotRegistry {
            root: project.root.clone(),
        });
    };
    entries
        .iter()
        .find(|entry| entry.dir == dir)
        .ok_or_else(|| LifecycleError::RepoNotInProject {
            root: project.root.clone(),
            dir: dir.to_owned(),
        })
}

/// Check that `dir` is a present registry entry of `project` — what a focus
/// can focus.
fn check_focusable(project: &OpenProject, dir: &str) -> Result<(), LifecycleError> {
    let entry = entry_of(project, dir)?;
    match entry.state {
        EntryState::Present => Ok(()),
        EntryState::Missing => Err(LifecycleError::RepoMissing {
            key: entry.key.clone(),
            dir: dir.to_owned(),
        }),
        EntryState::Refused { reason } => Err(LifecycleError::RepoRefused {
            key: entry.key.clone(),
            dir: dir.to_owned(),
            reason,
        }),
    }
}

/// `key` as a directory key: with a trailing `/`.
fn with_trailing_slash(mut key: String) -> String {
    if !key.ends_with('/') {
        key.push('/');
    }
    key
}

// -- Filers ---------------------------------------------------------------------

/// Start every filer in `filers`, or find the ones already running —
/// failing at the first that can't start.
async fn ensure_filers(app: &Arc<App>, filers: &Filers) -> Result<(), LifecycleError> {
    for (dir, depth) in filers {
        let config = match depth {
            FilerDepth::Tree => FilerConfig::tree(dir, &app.zzz_dir),
            FilerDepth::TopLevel => FilerConfig::top_level(dir, &app.zzz_dir),
        };
        app.filer_manager
            .start_filer(dir, Arc::clone(app), config, FilerLifetime::Project)
            .await
            .map_err(|source| LifecycleError::Filer {
                dir: dir.clone(),
                source,
            })?;
    }
    Ok(())
}

/// Release what `was` kept that `now` doesn't: a directory `now` lacks has
/// its filer stopped, and one kept whole that `now` keeps at its top level
/// alone is narrowed to that. Permanent filers (the app dir, the scoped
/// dirs) are left as they are by both.
///
/// Neither can fail: a narrowing whose new filer can't start leaves the
/// whole-tree one, which indexes more than needed, not less.
async fn release(app: &Arc<App>, was: &Filers, now: &Filers) {
    for (dir, depth) in was {
        match now.get(dir) {
            None => {
                app.filer_manager.stop_filer(dir).await;
            }
            Some(FilerDepth::TopLevel) if *depth == FilerDepth::Tree => {
                let config = FilerConfig::top_level(dir, &app.zzz_dir);
                if let Err(e) = app
                    .filer_manager
                    .narrow_filer(dir, Arc::clone(app), config)
                    .await
                {
                    tracing::warn!(
                        path = %dir,
                        error = %fuz_sys::cli::format_error_chain(&e),
                        "failed to narrow a root's filer to its top level; it stays whole"
                    );
                }
            }
            Some(_) => {}
        }
    }
}

// -- Manager --------------------------------------------------------------------

/// The open projects and the lock their changes take — see the module docs.
///
/// Each of [`Self::open`], [`Self::close`], [`Self::close_all`],
/// [`Self::focus`], and [`Self::unfocus`] must run to completion: a commit
/// dropped partway leaves the state, the filers, and the snapshot out of
/// step. The spine cancels a socket's in-flight handlers when it closes, so
/// a caller runs each in its own task.
#[derive(Debug, Default)]
pub struct ProjectManager {
    /// The open projects. Holding this guard is the only way to change
    /// them, to stop or narrow a filer, and to set the `ScopedFs` roots and
    /// [`Self::published`]. A scan before the lock starts or widens filers;
    /// nothing else does without it. A read that must see filers and state
    /// agree takes it too ([`Self::focused_files`]).
    projects: tokio::sync::Mutex<Projects>,
    /// The state as the last commit left it, for readers that don't wait on
    /// the lock.
    published: parking_lot::RwLock<Arc<PublishedProjects>>,
}

impl ProjectManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// The open projects and the directories they keep indexed, as the last
    /// commit left them. Never a state in the making: an open is published
    /// only once its filers run and its root is in scope.
    pub fn published(&self) -> Arc<PublishedProjects> {
        Arc::clone(&self.published.read())
    }

    /// The index of `dir`, a focused directory of the open project at
    /// `root` — a registry's focused entry, or a checkout's or plain
    /// directory's root — read under the lock every commit holds.
    ///
    /// A commit stops or narrows filers ([`release`]) before it publishes,
    /// so a check against [`Self::published`] and a read of the filer
    /// outside the lock could pass the check and read a filer already
    /// stopped (no files) or narrowed (a nested registry's top level) — an
    /// answer no state ever held. Under the lock, the check and the read see
    /// one state: no commit is partway, and every filer the state keeps runs
    /// at least as deep as it keeps it.
    ///
    /// Lock order: this mutex, then `FilerManager`'s filer map (read, let go
    /// before the next), then one filer's index (read) — the order a commit
    /// takes them in, through `ensure_filers`, `release`, and
    /// `check_invariants`. Nothing that holds the filer map or an index
    /// takes this mutex (the filers never touch the projects), so the read
    /// can't deadlock against a commit; it waits for one, and a commit waits
    /// for it to clone the index.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`]; [`LifecycleError::NotFocused`] for a
    /// directory the project doesn't focus — refused rather than answered
    /// with no files, which an empty repo would read as.
    pub async fn focused_files(
        &self,
        app: &App,
        root: &str,
        dir: &str,
    ) -> Result<FocusedFiles, LifecycleError> {
        let projects = self.projects.lock().await;
        let project = projects.get(root).ok_or_else(|| LifecycleError::NotOpen {
            root: root.to_owned(),
        })?;
        if !project.focused().contains(&dir) {
            return Err(LifecycleError::NotFocused {
                root: root.to_owned(),
                dir: dir.to_owned(),
            });
        }
        let files = app.filer_manager.files_for(dir).await;
        let mut watch_status = WatchStatus::Full;
        for kept in filers_of(project).keys() {
            if app.filer_manager.watch_status_for(kept).await == WatchStatus::Degraded {
                watch_status = WatchStatus::Degraded;
                break;
            }
        }
        drop(projects);
        Ok(FocusedFiles {
            files,
            watch_status,
        })
    }

    /// Open `fresh` — a project as just resolved, focusing what the open
    /// focuses — or update the open project at its root with it
    /// ([`merge_project`]): the fresh kind and entries, the focus of both.
    ///
    /// Broadcasts `project_changed` — `open` for a new project, `update` for
    /// an open one this changed, nothing for one it didn't.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::Filer`] when the root or a focused directory can't
    /// be listed, leaving nothing new open; [`LifecycleError::Notify`].
    pub async fn open(&self, app: &Arc<App>, fresh: OpenProject) -> Result<Landed, LifecycleError> {
        // the scans run before the lock (see the module docs); a directory
        // that can't be listed fails the open here, before anything is recorded
        let started = filers_of(&fresh);
        if let Err(error) = ensure_filers(app, &started).await {
            let projects = self.projects.lock().await;
            release(app, &started, &desired_filers(projects.values())).await;
            return Err(error);
        }

        let mut projects = self.projects.lock().await;
        let previous = projects.get(&fresh.root);
        let project =
            previous.map_or_else(|| fresh.clone(), |existing| merge_project(existing, &fresh));
        let change = match previous {
            None => Some(ProjectChange::Open),
            Some(previous) if *previous != project => Some(ProjectChange::Update),
            Some(_) => None,
        };
        let mut next = projects.clone();
        next.insert(project.root.clone(), project.clone());
        let changes = change.map(|change| (change, project.clone()));
        self.commit(app, &mut projects, next, &started, changes)
            .await?;
        drop(projects);

        let filers = filers_of(&project);
        Ok(Landed { project, filers })
    }

    /// Close the open project at `root` — matched as given (plus a trailing
    /// `/`), then canonicalized, so a non-canonical spelling of an open root
    /// (`/a/./b`, a symlinked path) closes it too, while a project whose root
    /// was deleted can still be closed by its stored root.
    ///
    /// Its filers stop unless another open project keeps them, its root
    /// leaves scope, and `project_changed` `close` is broadcast. Permanent
    /// filers and roots (the app dir, the scoped dirs) stay, so closing a
    /// project that overlaps one never revokes the access it grants.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`]; [`LifecycleError::Notify`].
    pub async fn close(&self, app: &Arc<App>, root: &str) -> Result<OpenProject, LifecycleError> {
        let mut key = with_trailing_slash(root.to_owned());
        // resolved before the lock — only consulted if `key` itself isn't open
        let canonical_key = tokio::fs::canonicalize(root)
            .await
            .ok()
            .and_then(|canonical| canonical.to_str().map(str::to_owned))
            .map(with_trailing_slash);

        let mut projects = self.projects.lock().await;
        if !projects.contains_key(&key)
            && let Some(canonical_key) = canonical_key
        {
            key = canonical_key;
        }
        let mut next = projects.clone();
        let Some(project) = next.remove(&key) else {
            return Err(LifecycleError::NotOpen {
                root: root.to_owned(),
            });
        };
        let changes = [(ProjectChange::Close, project.clone())];
        self.commit(app, &mut projects, next, &Filers::new(), changes)
            .await?;
        Ok(project)
    }

    /// Close every open project, as [`Self::close`] does each. Every project
    /// is released before any `close` is broadcast.
    ///
    /// Returns the closed projects.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::Notify`] — every project is closed regardless.
    pub async fn close_all(&self, app: &Arc<App>) -> Result<Vec<OpenProject>, LifecycleError> {
        let mut projects = self.projects.lock().await;
        let closed: Vec<OpenProject> = projects.values().cloned().collect();
        let changes: Vec<(ProjectChange, OpenProject)> = closed
            .iter()
            .map(|project| (ProjectChange::Close, project.clone()))
            .collect();
        self.commit(app, &mut projects, Projects::new(), &Filers::new(), changes)
            .await?;
        Ok(closed)
    }

    /// Focus the registry entry at `dir` of the open project at `root`: its
    /// whole tree is then indexed and watched. The entry must be present as
    /// the project's last resolve left it — the registry isn't resolved
    /// again.
    ///
    /// Broadcasts `project_changed` `update`; focusing a focused entry
    /// changes and broadcasts nothing.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`], [`LifecycleError::NotRegistry`],
    /// [`LifecycleError::RepoNotInProject`], [`LifecycleError::RepoMissing`],
    /// [`LifecycleError::RepoRefused`]; [`LifecycleError::Filer`] when the
    /// repo can't be listed, leaving the project as it was;
    /// [`LifecycleError::Notify`].
    pub async fn focus(
        &self,
        app: &Arc<App>,
        root: &str,
        dir: &str,
    ) -> Result<Landed, LifecycleError> {
        let not_open = || LifecycleError::NotOpen {
            root: root.to_owned(),
        };
        // checked before the scan, so a refused focus starts nothing
        {
            let published = self.published();
            let project = published
                .projects
                .iter()
                .find(|project| project.root == root)
                .ok_or_else(not_open)?;
            check_focusable(project, dir)?;
        }
        // the scan runs before the lock, as an open's does
        let started = Filers::from([(dir.to_owned(), FilerDepth::Tree)]);
        if let Err(error) = ensure_filers(app, &started).await {
            let projects = self.projects.lock().await;
            release(app, &started, &desired_filers(projects.values())).await;
            return Err(error);
        }

        self.land_focus(app, root, dir, &started).await
    }

    /// The second half of [`Self::focus`], under the lock: check again that
    /// `dir` is focusable — the project may have closed, or opened again
    /// with the entry no longer present, while the scan ran — and record the
    /// focus. `started` is what the scan started, released if the check
    /// fails.
    async fn land_focus(
        &self,
        app: &Arc<App>,
        root: &str,
        dir: &str,
        started: &Filers,
    ) -> Result<Landed, LifecycleError> {
        let mut projects = self.projects.lock().await;
        let checked = projects
            .get(root)
            .ok_or_else(|| LifecycleError::NotOpen {
                root: root.to_owned(),
            })
            .and_then(|previous| {
                check_focusable(previous, dir)?;
                let mut project = previous.clone();
                focused_mut(&mut project)?.insert(dir.to_owned());
                Ok((previous.clone(), project))
            });
        let (previous, project) = match checked {
            Ok(checked) => checked,
            Err(error) => {
                release(app, started, &desired_filers(projects.values())).await;
                return Err(error);
            }
        };
        let mut next = projects.clone();
        next.insert(project.root.clone(), project.clone());
        let changes = (previous != project).then(|| (ProjectChange::Update, project.clone()));
        self.commit(app, &mut projects, next, started, changes)
            .await?;
        drop(projects);

        let filers = filers_of(&project);
        Ok(Landed { project, filers })
    }

    /// Drop the registry entry at `dir` from the focus of the open project at
    /// `root`. Its filer stops unless another open project keeps it (one
    /// keeping it at its top level narrows it to that).
    ///
    /// Broadcasts `project_changed` `update`; unfocusing an unfocused entry —
    /// present or not — changes and broadcasts nothing. A registry may be
    /// left with no focus.
    ///
    /// Returns the project as it's left.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::NotOpen`], [`LifecycleError::NotRegistry`],
    /// [`LifecycleError::RepoNotInProject`]; [`LifecycleError::Notify`].
    pub async fn unfocus(
        &self,
        app: &Arc<App>,
        root: &str,
        dir: &str,
    ) -> Result<OpenProject, LifecycleError> {
        let mut projects = self.projects.lock().await;
        let previous = projects.get(root).ok_or_else(|| LifecycleError::NotOpen {
            root: root.to_owned(),
        })?;
        entry_of(previous, dir)?;
        let mut project = previous.clone();
        focused_mut(&mut project)?.remove(dir);
        if *previous == project {
            return Ok(project);
        }
        let mut next = projects.clone();
        next.insert(project.root.clone(), project.clone());
        let changes = [(ProjectChange::Update, project.clone())];
        self.commit(app, &mut projects, next, &Filers::new(), changes)
            .await?;
        Ok(project)
    }

    /// Make `next` the open projects. `started` is what the caller's scans
    /// started before taking the lock; `changes` is what to broadcast once
    /// `next` is in effect.
    ///
    /// In order: every filer `next` needs is ensured — a failure there
    /// releases what the operation started and leaves everything as it was;
    /// then `next` replaces the state, the filers it no longer needs are
    /// stopped or narrowed, the roots it drops leave `ScopedFs` and the ones
    /// it adds enter, the snapshot is published, and `changes` go out.
    ///
    /// # Errors
    ///
    /// [`LifecycleError::Filer`], with nothing changed;
    /// [`LifecycleError::Notify`] for the first notification that can't be
    /// built, with `next` in effect and every other one sent.
    async fn commit(
        &self,
        app: &Arc<App>,
        projects: &mut tokio::sync::MutexGuard<'_, Projects>,
        next: Projects,
        started: &Filers,
        changes: impl IntoIterator<Item = (ProjectChange, OpenProject)>,
    ) -> Result<(), LifecycleError> {
        let before = desired_filers(projects.values());
        let after = desired_filers(next.values());

        // a close or unfocus that ran between the caller's scans and the lock
        // stopped the filers it alone kept — dedup hits otherwise
        if let Err(error) = ensure_filers(app, &after).await {
            let mut attempted = after;
            deepen(&mut attempted, started);
            release(app, &attempted, &before).await;
            return Err(error);
        }

        let closed: Vec<String> = projects
            .keys()
            .filter(|root| !next.contains_key(*root))
            .cloned()
            .collect();
        let opened: Vec<String> = next
            .keys()
            .filter(|root| !projects.contains_key(*root))
            .cloned()
            .collect();
        **projects = next;

        let mut was = before;
        deepen(&mut was, started);
        release(app, &was, &after).await;
        for root in &closed {
            app.scoped_fs.remove_path(Path::new(root));
        }
        for root in &opened {
            app.scoped_fs.add_path(Path::new(root));
        }
        *self.published.write() = Arc::new(PublishedProjects {
            projects: projects.values().cloned().collect(),
            filers: after.keys().cloned().collect(),
        });
        #[cfg(debug_assertions)]
        check_invariants(app, projects, &after).await;

        let mut result = Ok(());
        for (change, project) in changes {
            let sent = broadcast_project_changed(app, change, &project);
            if result.is_ok() {
                result = sent;
            }
        }
        result
    }
}

/// Broadcast a `project_changed`. Called only from
/// [`ProjectManager::commit`], under the lock, so notifications for one root
/// go out in the order its changes took effect — a close's `close` can't
/// land after a racing open's `open`.
fn broadcast_project_changed(
    app: &App,
    change: ProjectChange,
    project: &OpenProject,
) -> Result<(), LifecycleError> {
    let params = serde_json::to_value(ProjectChangedParams {
        change_type: change,
        project: project.to_info(),
    })
    .map_err(LifecycleError::Notify)?;
    app.broadcast(&notify_to_string("project_changed", &params));
    Ok(())
}

/// What a commit leaves true, checked in debug builds: every directory the
/// open projects keep has a filer indexing at least that much of it, and the
/// runtime `ScopedFs` roots are exactly the open projects' roots (a root
/// that's also a permanent one stays permanent).
///
/// A filer may run that no project keeps — one an open or focus in flight started
/// before taking the lock — so this doesn't check there are no others; the
/// tests' `assert_settled` does, between operations.
#[cfg(debug_assertions)]
async fn check_invariants(app: &App, projects: &Projects, desired: &Filers) {
    for (dir, depth) in desired {
        let running = app
            .filer_manager
            .depth_of(dir)
            .await
            .map(|(depth, _)| depth);
        debug_assert!(
            running == Some(FilerDepth::Tree) || running == Some(*depth),
            "a commit left {dir} wanted at {depth:?} and running at {running:?}"
        );
    }
    let roots: BTreeSet<&str> = projects.keys().map(String::as_str).collect();
    let runtime = app.scoped_fs.runtime_roots();
    debug_assert!(
        runtime.iter().all(|root| roots.contains(root.as_str())),
        "a commit left a ScopedFs root with no open project: {runtime:?} vs {roots:?}"
    );
    debug_assert!(
        roots.iter().all(|root| app.scoped_fs.has_root(root)),
        "a commit left an open project out of scope: {roots:?} vs {runtime:?}"
    );
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::Value;

    use super::*;

    /// Inert handles: a lazy pool that never connects, no roots, no sockets.
    fn inert_app() -> Arc<App> {
        app_over(Arc::new(fuz_realtime::ConnectionRegistry::new()))
    }

    /// [`inert_app`] broadcasting over `realtime`.
    fn app_over(realtime: Arc<fuz_realtime::ConnectionRegistry>) -> Arc<App> {
        let pool = fuz_db::create_pool(
            "postgres://localhost:1/project_manager_test_unused",
            &fuz_db::PoolOptions::default(),
        )
        .expect("a lazy pool builds without connecting");
        Arc::new(App::new(
            pool.clone(),
            crate::scoped_fs::ScopedFs::without_roots(),
            "/nowhere/".to_owned(),
            vec![],
            crate::provider::ProviderManager::new(),
            false,
            realtime,
            Arc::new(fuz_auth::AuditEmitter::new(pool)),
        ))
    }

    /// [`inert_app`] with one socket, whose frames the receiver takes.
    fn app_with_socket() -> (
        Arc<App>,
        fuz_realtime::Connection,
        fuz_realtime::ConnectionReceiver,
    ) {
        let realtime = Arc::new(fuz_realtime::ConnectionRegistry::new());
        let (sender, receiver) = fuz_realtime::connection_channel(1 << 20);
        let connection = realtime.add_connection(
            sender,
            fuz_realtime::ConnectionIdentity::default(),
            tokio_util::sync::CancellationToken::new(),
        );
        (app_over(realtime), connection, receiver)
    }

    /// The `project_changed` notifications queued on `rx`, each its type, its
    /// root, and the focus it reports — other frames (`filer_change`) skipped.
    fn project_changes(rx: &mut fuz_realtime::ConnectionReceiver) -> Vec<(String, String, Value)> {
        let mut changes = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let message: Value = serde_json::from_str(frame.as_str()).unwrap();
            if message["method"] == "project_changed" {
                let params = &message["params"];
                changes.push((
                    params["type"].as_str().unwrap().to_owned(),
                    params["project"]["root"].as_str().unwrap().to_owned(),
                    params["project"]["focused"].clone(),
                ));
            }
        }
        changes
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zzz_project_manager_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }

        fn key(&self, rel: &str) -> String {
            format!("{}/{rel}", self.0.display())
        }

        fn write(&self, rel: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A registry project at `root` (a key) with an entry per `keys` — each
    /// present at `root/key/` — focusing `focus`.
    fn registry_at(root: &str, keys: &[&str], focus: &[&str]) -> OpenProject {
        let entry = |key: &&str| OpenEntry {
            key: (*key).to_owned(),
            kind: EntryKind::Repo,
            dir: format!("{root}{key}/"),
            state: EntryState::Present,
        };
        OpenProject {
            root: root.to_owned(),
            name: "w".to_owned(),
            opened_at: "t".to_owned(),
            kind: OpenKind::Registry {
                registry_path: format!("{root}repos.toml"),
                entries: keys.iter().map(entry).collect(),
                focused: focus.iter().map(|key| format!("{root}{key}/")).collect(),
            },
        }
    }

    /// A plain-directory project at `root` (a key), focusing its root.
    fn plain_at(root: &str) -> OpenProject {
        OpenProject {
            root: root.to_owned(),
            name: "plain".to_owned(),
            opened_at: "t".to_owned(),
            kind: OpenKind::PlainDir,
        }
    }

    /// With no operation in flight: the project-scoped filers running are
    /// exactly what the open projects keep, each at exactly that depth, and
    /// the published snapshot is the state.
    async fn assert_settled(app: &Arc<App>) {
        let projects = app.projects.projects.lock().await;
        let desired = desired_filers(projects.values());
        assert_eq!(app.filer_manager.project_filers().await, desired);
        let published = app.projects.published();
        assert_eq!(
            published.projects.iter().collect::<Vec<_>>(),
            projects.values().collect::<Vec<_>>(),
        );
        assert_eq!(
            published.filers,
            desired.keys().cloned().collect::<BTreeSet<_>>()
        );
        let mut roots = app.scoped_fs.runtime_roots();
        roots.sort();
        assert_eq!(roots, projects.keys().cloned().collect::<Vec<_>>());
    }

    #[test]
    fn a_checkout_or_plain_dir_keeps_its_root_whole_and_a_registry_its_top_level() {
        assert_eq!(
            filers_of(&plain_at("/w/")).into_iter().collect::<Vec<_>>(),
            [("/w/".to_owned(), FilerDepth::Tree)]
        );
        assert_eq!(
            filers_of(&registry_at("/w/", &["app", "site"], &["app"]))
                .into_iter()
                .collect::<Vec<_>>(),
            [
                ("/w/".to_owned(), FilerDepth::TopLevel),
                ("/w/app/".to_owned(), FilerDepth::Tree),
            ]
        );
    }

    #[test]
    fn the_open_projects_keep_each_directory_at_the_deepest_any_does() {
        // a registry focusing `app`, a plain project at `app`, and a registry
        // rooted at `site` — which the first doesn't focus
        let desired = desired_filers(&[
            registry_at("/w/", &["app", "site"], &["app"]),
            plain_at("/w/app/"),
            registry_at("/w/site/", &[], &[]),
        ]);
        assert_eq!(
            desired.into_iter().collect::<Vec<_>>(),
            [
                ("/w/".to_owned(), FilerDepth::TopLevel),
                ("/w/app/".to_owned(), FilerDepth::Tree),
                ("/w/site/".to_owned(), FilerDepth::TopLevel),
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_close_narrows_a_root_another_project_keeps_at_its_top_level() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        // a registry focusing `app` whole, and a registry rooted at `app`,
        // which keeps only its top level
        app.projects
            .open(&app, registry_at(&root, &["app"], &["app"]))
            .await
            .unwrap();
        app.projects
            .open(&app, registry_at(&app_dir, &[], &[]))
            .await
            .unwrap();
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 2);

        app.projects.close(&app, &root).await.unwrap();
        assert_eq!(
            app.filer_manager
                .files_for(&app_dir)
                .await
                .into_iter()
                .map(|f| f.id)
                .collect::<Vec<_>>(),
            [tmp.key("w/app/a.txt")],
            "narrowed to the nested registry's top level"
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_refused_under_the_lock_narrows_what_its_scan_widened() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &[]))
            .await
            .unwrap();
        app.projects
            .open(&app, registry_at(&app_dir, &[], &[]))
            .await
            .unwrap();

        // a focus whose scan ran — widening the nested registry's top-level
        // filer to the whole tree — and then found the project closed
        let started = Filers::from([(app_dir.clone(), FilerDepth::Tree)]);
        ensure_filers(&app, &started).await.unwrap();
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 2);
        app.projects.close(&app, &root).await.unwrap();
        assert!(matches!(
            app.projects
                .land_focus(&app, &root, &app_dir, &started)
                .await,
            Err(LifecycleError::NotOpen { .. })
        ));
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 1);
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focused_files_read_holds_the_lock_while_it_reads() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &["app"]))
            .await
            .unwrap();

        // the read parks on the index, past its check
        let held = app.filer_manager.hold_index(&app_dir).await;
        let reader = tokio::spawn({
            let (app, root, app_dir) = (Arc::clone(&app), root.clone(), app_dir.clone());
            async move { app.projects.focused_files(&app, &root, &app_dir).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while app.projects.projects.try_lock().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the read takes the lock");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!reader.is_finished(), "the read waits on the index");
        assert!(
            app.projects.projects.try_lock().is_err(),
            "the read holds the lock across its read, so no commit stops the filer between"
        );
        drop(held);
        assert_eq!(reader.await.unwrap().unwrap().files.len(), 2);
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focused_files_read_waits_out_a_commit_partway() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &["app"]))
            .await
            .unwrap();
        let read = app
            .projects
            .focused_files(&app, &root, &app_dir)
            .await
            .unwrap();
        assert_eq!(read.files.len(), 2);

        // an unfocus partway through its commit: under the lock, its filer
        // stopped (`release`), the snapshot not yet published
        let mut projects = app.projects.projects.lock().await;
        let mut next = projects.clone();
        focused_mut(next.get_mut(&root).unwrap())
            .unwrap()
            .remove(&app_dir);
        app.filer_manager.stop_filer(&app_dir).await;
        assert!(
            app.projects.published().projects[0]
                .focused()
                .contains(&app_dir.as_str()),
            "a check against the snapshot would pass here and read no files"
        );
        let reader = tokio::spawn({
            let (app, root, app_dir) = (Arc::clone(&app), root.clone(), app_dir.clone());
            async move { app.projects.focused_files(&app, &root, &app_dir).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!reader.is_finished(), "the read waits on the lock");

        // the commit finishes, and the read sees the state it left
        let update = (ProjectChange::Update, next[&root].clone());
        app.projects
            .commit(&app, &mut projects, next, &Filers::new(), [update])
            .await
            .unwrap();
        drop(projects);
        assert!(matches!(
            reader.await.unwrap(),
            Err(LifecycleError::NotFocused { .. })
        ));
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn each_change_is_broadcast_once_and_a_change_of_nothing_never() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/b.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, site_dir) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/site/"));
        let manager = &app.projects;
        manager
            .open(&app, registry_at(&root, &["app", "site"], &["app"]))
            .await
            .unwrap();
        // an open that changes nothing broadcasts nothing
        manager
            .open(&app, registry_at(&root, &["app", "site"], &["app"]))
            .await
            .unwrap();
        manager.focus(&app, &root, &site_dir).await.unwrap();
        manager.focus(&app, &root, &site_dir).await.unwrap();
        manager.unfocus(&app, &root, &app_dir).await.unwrap();
        manager.unfocus(&app, &root, &app_dir).await.unwrap();
        manager.close(&app, &root).await.unwrap();
        assert!(matches!(
            manager.close(&app, &root).await,
            Err(LifecycleError::NotOpen { .. })
        ));

        let focus = |dirs: &[&String]| serde_json::json!(dirs);
        assert_eq!(
            project_changes(&mut rx),
            [
                ("open".to_owned(), root.clone(), focus(&[&app_dir])),
                (
                    "update".to_owned(),
                    root.clone(),
                    focus(&[&app_dir, &site_dir])
                ),
                ("update".to_owned(), root.clone(), focus(&[&site_dir])),
                ("close".to_owned(), root.clone(), focus(&[&site_dir])),
            ]
        );
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_commit_whose_filer_cant_start_leaves_everything_as_it_was() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir, gone) = (tmp.key("w/"), tmp.key("w/app/"), tmp.key("w/gone/"));
        app.projects
            .open(&app, registry_at(&root, &["app", "gone"], &[]))
            .await
            .unwrap();
        // the registry nested in `app` keeps it at its top level
        app.projects
            .open(&app, registry_at(&app_dir, &[], &[]))
            .await
            .unwrap();
        let filers = app.filer_manager.project_filers().await;
        project_changes(&mut rx);

        // a next state focusing `app` and an entry with no directory: `app`
        // is widened before the missing one fails the commit
        let mut projects = app.projects.projects.lock().await;
        let mut next = projects.clone();
        *focused_mut(next.get_mut(&root).unwrap()).unwrap() =
            BTreeSet::from([app_dir.clone(), gone.clone()]);
        let update = (ProjectChange::Update, next[&root].clone());
        let failed = app
            .projects
            .commit(&app, &mut projects, next, &Filers::new(), [update])
            .await;
        drop(projects);
        assert!(
            matches!(&failed, Err(LifecycleError::Filer { dir, source })
                if dir == &gone && source.kind() == std::io::ErrorKind::NotFound),
            "{failed:?}"
        );
        // nothing recorded, the widened filer narrowed back, nothing broadcast
        assert_eq!(app.filer_manager.project_filers().await, filers);
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 1);
        assert!(project_changes(&mut rx).is_empty());
        assert_settled(&app).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_whose_repo_vanished_after_its_scan_fails_and_broadcasts_nothing() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt"] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let (root, app_dir) = (tmp.key("w/"), tmp.key("w/app/"));
        app.projects
            .open(&app, registry_at(&root, &["app"], &[]))
            .await
            .unwrap();
        project_changes(&mut rx);

        // the focus's scan ran, then an unfocus elsewhere stopped its filer
        // and the repo was deleted, before the focus took the lock
        let started = Filers::from([(app_dir.clone(), FilerDepth::Tree)]);
        ensure_filers(&app, &started).await.unwrap();
        app.filer_manager.stop_filer(&app_dir).await;
        std::fs::remove_dir_all(tmp.0.join("w/app")).unwrap();
        let failed = app
            .projects
            .land_focus(&app, &root, &app_dir, &started)
            .await;
        assert!(
            matches!(&failed, Err(LifecycleError::Filer { dir, source })
                if dir == &app_dir && source.kind() == std::io::ErrorKind::NotFound),
            "{failed:?}"
        );
        assert!(app.projects.published().projects[0].focused().is_empty());
        assert!(project_changes(&mut rx).is_empty());
        assert_settled(&app).await;
    }

    /// A tiny deterministic generator, so a failing interleaving reproduces
    /// from its seed.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            usize::try_from((self.0 >> 33) % (bound as u64)).unwrap()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn interleaved_opens_closes_and_focuses_leave_the_filers_and_scope_the_state_needs() {
        let tmp = TempDir::new();
        for rel in [
            "w/README.md",
            "w/app/a.txt",
            "w/app/sub/c.txt",
            "w/site/b.txt",
            "p/x.txt",
            "p/deep/y.txt",
        ] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (root, app_dir, site_dir, plain) = (
            tmp.key("w/"),
            tmp.key("w/app/"),
            tmp.key("w/site/"),
            tmp.key("p/"),
        );

        let mut landed = 0;
        for seed in 0..12_u64 {
            let mut rng = Lcg(seed);
            let mut tasks = Vec::new();
            for _ in 0..24 {
                let app = Arc::clone(&app);
                let (root, app_dir, site_dir, plain) = (
                    root.clone(),
                    app_dir.clone(),
                    site_dir.clone(),
                    plain.clone(),
                );
                let op = rng.next(9);
                tasks.push(tokio::spawn(async move {
                    let manager = &app.projects;
                    match op {
                        0 => manager
                            .open(&app, registry_at(&root, &["app", "site"], &["app"]))
                            .await
                            .map(drop),
                        1 => manager
                            .open(&app, registry_at(&root, &["app", "site"], &[]))
                            .await
                            .map(drop),
                        // the registry nested in the first one's entry
                        2 => manager
                            .open(&app, registry_at(&app_dir, &[], &[]))
                            .await
                            .map(drop),
                        3 => manager.open(&app, plain_at(&plain)).await.map(drop),
                        4 => manager.focus(&app, &root, &app_dir).await.map(drop),
                        5 => manager.focus(&app, &root, &site_dir).await.map(drop),
                        6 => manager.unfocus(&app, &root, &app_dir).await.map(drop),
                        7 => manager.close(&app, &root).await.map(drop),
                        _ => manager.close(&app, &app_dir).await.map(drop),
                    }
                }));
            }
            for task in tasks {
                match task.await.unwrap() {
                    Ok(()) => landed += 1,
                    // the one refusal the state allows here: the project
                    // closed under a racing operation
                    Err(LifecycleError::NotOpen { .. }) => {}
                    Err(other) => panic!("seed {seed}: {other:?}"),
                }
            }
            assert_settled(&app).await;
        }
        assert!(landed > 0, "the operations ran");

        app.projects.close_all(&app).await.unwrap();
        assert_settled(&app).await;
        assert!(app.filer_manager.project_filers().await.is_empty());
    }
}
