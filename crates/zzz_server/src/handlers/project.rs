//! Project handlers — `project_open`, `project_close`, `project_list`,
//! `repo_focus`, `repo_unfocus`, and the `project_changed` notification.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`; the
//! closure-captured `Arc<App>` carries the zzz-specific deps the spine
//! `ActionContext` doesn't (`projects` map, `FilerManager`, `ScopedFs`,
//! `ConnectionRegistry`-backed broadcast).
//!
//! An open path resolves to its project ([`crate::project::resolve_project`]):
//! a registry's root, a git checkout, or the directory itself. The project's
//! root is one `ScopedFs` root, and its files are indexed by filers on what
//! is **focused**: opening a path focuses the repo holding it — the registry
//! entry containing it, or a checkout's or a plain directory's root — and
//! `repo_focus` / `repo_unfocus` focus a registry's entries one by one. Focus
//! is daemon-wide, kept until it's unfocused or the project closes; a
//! checkout's or plain directory's root stays focused while it's open. A
//! registry's root itself is indexed only at its top level (its loose files):
//! its subdirectories are its repos, and an unfocused one isn't indexed at
//! all.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use fuz_actions::{ActionContext, ActionOutput};
use fuz_http::{
    JsonrpcError, JsonrpcErrorCode, forbidden, internal_error_with_source, invalid_params,
    parse_strict_params,
};
use fuz_realtime::notify_to_string;
use fuz_repos::registry::EntryKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filer::{
    FilerConfig, FilerDepth, FilerLifetime, SerializableDisknode, WatchStatus,
    disknodes_json_size_hint,
};
use crate::handlers::filesystem::{ERROR_INVALID_PATH, ERROR_PERMISSION_DENIED};
use crate::handlers::{
    App, EntryInfoKind, EntryState, ProjectEntryInfo, ProjectInfo, ProjectInfoKind, not_found_error,
};
use crate::project::{
    EntryDir, Project, ProjectError, ProjectKind, ResolveOptions, resolve_project,
};

/// `project_close` of a root that isn't an open project (`invalid_params`)
/// — e.g. one a restart forgot, which a client can then drop locally.
pub const ERROR_PROJECT_NOT_OPEN: &str = "project_not_open";

/// `project_open` of a path whose project root can never be a root
/// (`forbidden`): `/`, the daemon's home directory or an ancestor of it, or a
/// directory under `/proc`, `/sys`, or `/dev` ([`crate::root_policy`]).
pub const ERROR_ROOT_NOT_ALLOWED: &str = "root_not_allowed";

/// `project_open` of a path outside the daemon's home directory that
/// `ZZZ_ROOTS_OUTSIDE_HOME` doesn't name (`forbidden`) — the operator can
/// allow it there ([`crate::root_policy`]).
pub const ERROR_ROOT_OUTSIDE_HOME: &str = "root_outside_home";

/// `repo_focus` / `repo_unfocus` on a project that isn't a registry
/// (`invalid_params`): a checkout's or plain directory's one focus is its
/// root, kept while it's open.
pub const ERROR_PROJECT_NOT_REGISTRY: &str = "project_not_registry";

/// `repo_focus` / `repo_unfocus` of a directory that's none of the project's
/// registry entries (`invalid_params`).
pub const ERROR_REPO_NOT_IN_PROJECT: &str = "repo_not_in_project";

/// `repo_focus` of a registry entry that isn't present as the project last
/// resolved it: not yet cloned (`not_found`) or refused (`forbidden`).
/// Opening a path in it resolves the registry again.
pub const ERROR_REPO_NOT_PRESENT: &str = "repo_not_present";

// -- Inputs -----------------------------------------------------------------

/// Input for `project_open` — twin of `ProjectOpenInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectOpenInput {
    path: String,
}

/// Input for `project_close` — twin of `ProjectCloseInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectCloseInput {
    root: String,
}

/// Input for `repo_focus` and `repo_unfocus` — twin of `RepoFocusInput` and
/// `RepoUnfocusInput`. Both are directory keys as the daemon reports them
/// (a project's `root`, an entry's `dir`); a missing trailing `/` is added.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoInput {
    root: String,
    dir: String,
}

// -- Notification params -----------------------------------------------------

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
struct ProjectChangedParams<'a> {
    #[serde(rename = "type")]
    change_type: ProjectChange,
    project: &'a ProjectInfo,
}

// -- Typed response structs --------------------------------------------------

#[derive(Serialize)]
struct ProjectListResult {
    projects: Vec<ProjectInfo>,
}

#[derive(Serialize)]
struct ProjectOpenResult {
    project: ProjectInfo,
    /// The directory the open focused (trailing `/`), or `None` when it
    /// focused none — a registry's root, or a directory in no entry.
    focus: Option<String>,
    /// The index of every filer of the project — the frontend seeds its file
    /// tree from this, since a filer's initial scan broadcasts nothing.
    files: Vec<SerializableDisknode>,
    /// Whether every indexed directory of the project has a file watch —
    /// `degraded` when the OS watch limit left some to periodic rescans.
    watch_status: WatchStatus,
}

#[derive(Serialize)]
struct RepoFocusResult {
    project: ProjectInfo,
    /// The index of every filer of the project, the newly focused repo's
    /// included — as `project_open` returns it.
    files: Vec<SerializableDisknode>,
    watch_status: WatchStatus,
}

#[derive(Serialize)]
struct RepoUnfocusResult {
    project: ProjectInfo,
}

// -- Helpers -----------------------------------------------------------------

/// `path` as a directory key: UTF-8, with a trailing `/`. `None` when it
/// isn't UTF-8.
fn to_dir_key(path: &Path) -> Option<String> {
    let mut s = path.to_str()?.to_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    Some(s)
}

fn non_utf8_error(path: &Path) -> JsonrpcError {
    invalid_params(
        &format!(
            "failed to open project: path is not valid UTF-8: {}",
            path.display()
        ),
        Some(ERROR_INVALID_PATH),
    )
}

/// The JSON-RPC error for a path that resolves to no project, carrying
/// [`ProjectError::reason`] as `data.reason`: `invalid_params` for a path
/// or registry that can't be used as given, `not_found` for a missing path,
/// `forbidden` for what the root rules, the protected directories, or the
/// trust rule refuse, `conflict` for a registry replaced mid-open (opening
/// again reads the new one), and an internal error for an unusable bound.
fn open_error(error: &ProjectError) -> JsonrpcError {
    let message = format!(
        "failed to open project: {}",
        fuz_sys::cli::format_error_chain(error)
    );
    let reason = error.reason();
    match error {
        ProjectError::Unresolvable { source, .. }
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            not_found_error(&message, reason)
        }
        ProjectError::Unresolvable { source, .. }
            if source.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            forbidden(&message, Some(reason))
        }
        ProjectError::NotAbsolute { .. }
        | ProjectError::Unresolvable { .. }
        | ProjectError::RegistryUnreadable { .. }
        | ProjectError::RegistryInvalid { .. } => invalid_params(&message, Some(reason)),
        ProjectError::RootRefused { .. }
        | ProjectError::Protected { .. }
        | ProjectError::RegistryUntrusted { .. }
        | ProjectError::RegistryNotConfined { .. }
        | ProjectError::RegistryLinkIndirect { .. } => forbidden(&message, Some(reason)),
        ProjectError::RegistryReplaced { .. } => fuz_http::conflict(&message, Some(reason)),
        ProjectError::BoundUnusable { .. } => JsonrpcError {
            code: JsonrpcErrorCode::InternalError,
            message,
            data: Some(serde_json::json!({ "reason": reason })),
        },
    }
}

/// `key` as a directory key: with a trailing `/`.
fn with_trailing_slash(mut key: String) -> String {
    if !key.ends_with('/') {
        key.push('/');
    }
    key
}

/// The error for a focused or root directory whose filer can't start: its
/// listing refused (`forbidden`), gone (`not_found`), or anything else.
/// `failed` names what failed (`open project`, `focus repo`).
fn filer_error(failed: &str, dir: &str, error: &std::io::Error) -> JsonrpcError {
    let message = format!("failed to {failed}: can't index {dir}: {error}");
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => forbidden(&message, Some(ERROR_PERMISSION_DENIED)),
        std::io::ErrorKind::NotFound => {
            not_found_error(&message, crate::handlers::filesystem::ERROR_PATH_NOT_FOUND)
        }
        _ => internal_error_with_source(&message, error),
    }
}

/// The directory an open of `project` focuses: the deepest present registry
/// entry holding the opened directory — none for the root itself, a
/// directory in no entry, or an opened worktree outside the root — or the
/// root of a checkout or plain directory.
fn focus_of(project: &Project) -> Option<&Path> {
    match &project.kind {
        ProjectKind::Registry { entries, .. } => entries
            .iter()
            .filter_map(|entry| match &entry.dir {
                EntryDir::Present(dir) => Some(dir.as_path()),
                EntryDir::Missing | EntryDir::Refused(_) => None,
            })
            .filter(|dir| project.opened.starts_with(dir))
            .max_by_key(|dir| dir.components().count()),
        ProjectKind::GitRepo | ProjectKind::PlainDir => Some(&project.root),
    }
}

/// A resolved project as the wire carries it, focusing `focus`.
fn to_project_info(
    project: &Project,
    focus: Option<&str>,
    opened_at: String,
) -> Result<ProjectInfo, JsonrpcError> {
    let root = to_dir_key(&project.root).ok_or_else(|| non_utf8_error(&project.root))?;
    let name = project
        .root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_owned();
    let (kind, registry_path, entries) = match &project.kind {
        ProjectKind::Registry { path, entries } => {
            let registry_path = path.to_str().ok_or_else(|| non_utf8_error(path))?;
            let entries = entries
                .iter()
                .map(|entry| {
                    let kind = match entry.entry.kind {
                        EntryKind::Repo => EntryInfoKind::Repo,
                        EntryKind::Reference => EntryInfoKind::Reference,
                    };
                    // the declared path, as `root` spells it, unless present
                    let declared = format!("{root}{}/", entry.entry.dir.trim_end_matches('/'));
                    let (dir, state, reason) = match &entry.dir {
                        EntryDir::Present(dir) => to_dir_key(dir).map_or(
                            (declared, EntryState::Refused, Some(ERROR_INVALID_PATH)),
                            |dir| (dir, EntryState::Present, None),
                        ),
                        EntryDir::Missing => (declared, EntryState::Missing, None),
                        EntryDir::Refused(refusal) => {
                            (declared, EntryState::Refused, Some(refusal.reason()))
                        }
                    };
                    ProjectEntryInfo {
                        key: entry.entry.key.clone(),
                        kind,
                        dir,
                        state,
                        reason,
                    }
                })
                .collect();
            (
                ProjectInfoKind::Registry,
                Some(registry_path.to_owned()),
                entries,
            )
        }
        ProjectKind::GitRepo => (ProjectInfoKind::GitRepo, None, Vec::new()),
        ProjectKind::PlainDir => (ProjectInfoKind::PlainDir, None, Vec::new()),
    };
    Ok(ProjectInfo {
        root,
        name,
        opened_at,
        kind,
        registry_path,
        entries,
        focused: focus.map(str::to_owned).into_iter().collect(),
    })
}

/// The filers a project keeps, each a directory key and what it indexes: a
/// registry's root at its top level, and every focused directory whole.
/// The root of a checkout or plain directory is its one focused directory.
fn filers_of(project: &ProjectInfo) -> BTreeMap<String, FilerDepth> {
    let mut filers: BTreeMap<String, FilerDepth> = project
        .focused
        .iter()
        .map(|dir| (dir.clone(), FilerDepth::Tree))
        .collect();
    filers
        .entry(project.root.clone())
        .or_insert(FilerDepth::TopLevel);
    filers
}

/// `existing` updated by a fresh resolve of the same root: the fresh kind
/// and entries, and the focused directories of both that the fresh resolve
/// still supports — a present entry's dir for a registry, the root for a
/// checkout or plain directory. So a focus outlives no change of kind (a
/// plain `~/dev` focused on its root, then a registry there) and no entry
/// removed or gone missing.
fn merge_project(existing: &ProjectInfo, fresh: &ProjectInfo) -> ProjectInfo {
    let supported = |dir: &&String| match fresh.kind {
        ProjectInfoKind::Registry => fresh
            .entries
            .iter()
            .any(|entry| entry.state == EntryState::Present && &entry.dir == *dir),
        ProjectInfoKind::GitRepo | ProjectInfoKind::PlainDir => **dir == fresh.root,
    };
    let focused: BTreeSet<&String> = existing
        .focused
        .iter()
        .filter(supported)
        .chain(&fresh.focused)
        .collect();
    ProjectInfo {
        focused: focused.into_iter().cloned().collect(),
        opened_at: existing.opened_at.clone(),
        ..fresh.clone()
    }
}

/// Start the filer on `dir` (a directory key), or find the one already
/// running.
async fn ensure_filer(app: &Arc<App>, dir: &str, depth: FilerDepth) -> std::io::Result<bool> {
    let config = match depth {
        FilerDepth::Tree => FilerConfig::tree(dir, &app.zzz_dir),
        FilerDepth::TopLevel => FilerConfig::top_level(dir, &app.zzz_dir),
    };
    app.filer_manager
        .start_filer(dir, Arc::clone(app), config, FilerLifetime::Project)
        .await
}

/// Start every filer in `filers`, failing at the first that can't.
/// `failed` names what fails with it ([`filer_error`]).
async fn ensure_filers(
    app: &Arc<App>,
    filers: &BTreeMap<String, FilerDepth>,
    failed: &str,
) -> Result<(), JsonrpcError> {
    for (dir, depth) in filers {
        ensure_filer(app, dir, *depth)
            .await
            .map_err(|e| filer_error(failed, dir, &e))?;
    }
    Ok(())
}

/// The index of every filer in `filers`, deduplicated by path, and whether
/// each has every directory watched.
async fn files_of(
    app: &App,
    filers: &BTreeMap<String, FilerDepth>,
) -> (Vec<SerializableDisknode>, WatchStatus) {
    let mut files: BTreeMap<String, SerializableDisknode> = BTreeMap::new();
    let mut watch_status = WatchStatus::Full;
    for dir in filers.keys() {
        for file in app.filer_manager.files_for(dir).await {
            files.entry(file.id.clone()).or_insert(file);
        }
        if app.filer_manager.watch_status_for(dir).await == WatchStatus::Degraded {
            watch_status = WatchStatus::Degraded;
        }
    }
    (files.into_values().collect(), watch_status)
}

/// What the open projects keep of each directory: the deepest any of them
/// indexes it.
fn kept_filers(app: &App) -> BTreeMap<String, FilerDepth> {
    let mut kept: BTreeMap<String, FilerDepth> = BTreeMap::new();
    for project in app.projects.read().values() {
        for (dir, depth) in filers_of(project) {
            let entry = kept.entry(dir).or_insert(depth);
            if depth == FilerDepth::Tree {
                *entry = FilerDepth::Tree;
            }
        }
    }
    kept
}

/// Stop each filer in `dirs` that no open project keeps
/// ([`FilerManager::stop_filer`](crate::filer::FilerManager::stop_filer)
/// never stops a permanent one).
///
/// The `_lifecycle` guard is proof the caller holds `App::project_lifecycle`.
async fn stop_unkept_filers<'a>(
    app: &App,
    dirs: impl IntoIterator<Item = &'a String>,
    _lifecycle: &tokio::sync::MutexGuard<'_, ()>,
) {
    let kept = kept_filers(app);
    for dir in dirs {
        if !kept.contains_key(dir) {
            app.filer_manager.stop_filer(dir).await;
        }
    }
}

/// After `previous` became `project` (a merge, [`merge_project`]) and the
/// project's filers are ensured, release what `previous` kept that no open
/// project needs any more: a focus the merge dropped is stopped, and a
/// whole-tree filer on a root now indexed at its top level alone is replaced
/// by a top-level one ([`FilerManager::replace_filer`](crate::filer::FilerManager::replace_filer)
/// — the manager never narrows a filer on a start). Neither can fail the
/// open: a replacement that can't start leaves the whole-tree filer, which
/// indexes more than needed, not less.
async fn release_narrowed_filers(
    app: &Arc<App>,
    previous: &ProjectInfo,
    lifecycle: &tokio::sync::MutexGuard<'_, ()>,
) {
    let kept = kept_filers(app);
    let mut dropped = Vec::new();
    for (dir, depth) in filers_of(previous) {
        match kept.get(&dir) {
            None => dropped.push(dir),
            Some(FilerDepth::TopLevel) if depth == FilerDepth::Tree => {
                let config = FilerConfig::top_level(&dir, &app.zzz_dir);
                if let Err(e) = app
                    .filer_manager
                    .replace_filer(&dir, Arc::clone(app), config)
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
    stop_unkept_filers(app, &dropped, lifecycle).await;
}

/// Broadcast a `project_changed`. The `_lifecycle` guard is proof the
/// caller holds `App::project_lifecycle`, so notifications for one root go
/// out in the order its opens and closes took effect — a close's `close`
/// can't land after a racing open's `open`.
fn broadcast_project_changed(
    app: &App,
    change: ProjectChange,
    project: &ProjectInfo,
    _lifecycle: &tokio::sync::MutexGuard<'_, ()>,
) -> Result<(), JsonrpcError> {
    let params_value = serde_json::to_value(ProjectChangedParams {
        change_type: change,
        project,
    })
    .map_err(|e| internal_error_with_source("notification params serialize failed", &e))?;
    let notification = notify_to_string("project_changed", &params_value);
    app.broadcast(&notification);
    Ok(())
}

// -- Handlers ----------------------------------------------------------------

/// `project_list` — read-only snapshot of open projects.
///
/// Takes no input (a void schema): the spec declares `InputShape::Void`, so the
/// dispatcher refuses any declared key before this runs. `async` is required
/// by the `ActionHandler` future-returning shape even though the body has no
/// `.await` points.
///
/// # Errors
///
/// An internal error if the result fails to serialize.
#[expect(
    clippy::unused_async,
    reason = "kept `async` like every other handler, whose spec builder awaits it"
)]
pub async fn project_list(
    _params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let projects: Vec<ProjectInfo> = app.projects.read().values().cloned().collect();
    serde_json::to_value(ProjectListResult { projects })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `project_open` — open the project a path belongs to, focusing the repo
/// holding it (see the module docs).
///
/// The path may name a file (its parent opens) or a directory. It's resolved
/// on a blocking thread ([`resolve_project`]). Side-effects: starts the
/// filers the project now needs, adds its root to `ScopedFs`, records it in
/// the in-memory map, and broadcasts `project_changed` — `open` for a new
/// project, `update` for an open one this changed (a new focus, or its
/// registry's entries as resolved again).
///
/// Returns the project, the directory this open focused, and the file index
/// of every filer of the project — on the idempotent path too, so a client
/// re-opening an open project can seed its tree the same way. A registry
/// entry that's refused (escaping the root, protected, unresolvable, not a
/// directory) is reported in the project's entries; the rest of the project
/// still opens. A focused or root directory that can't be listed fails the
/// open (`forbidden` / `permission_denied`), leaving nothing new open.
///
/// # Errors
///
/// [`ProjectError::reason`] as `data.reason` ([`open_error`]):
/// `invalid_params` for a malformed input, a relative or invalid path, or a
/// registry that can't be read or doesn't parse; `not_found` for a missing
/// path; `forbidden` for a path the OS refuses, a root the root rules refuse
/// (`root_not_allowed`, `root_outside_home`), a protected directory, or an
/// untrusted or unconfined registry; `conflict` for a registry replaced while
/// it was checked; an internal error for an unusable walk bound, a filer
/// that fails otherwise, or a notification that fails to serialize.
pub async fn project_open(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<ActionOutput, JsonrpcError> {
    let ProjectOpenInput { path } = parse_strict_params(params)?;

    let resolving = Arc::clone(&app);
    let project = tokio::task::spawn_blocking(move || {
        resolve_project(
            Path::new(&path),
            &ResolveOptions {
                root_policy: &resolving.root_policy,
                zzz_dir: Path::new(&resolving.zzz_dir),
                owner: &resolving.trusted_owner,
                git: &resolving.git,
            },
        )
    })
    .await
    .map_err(|e| internal_error_with_source("failed to open project", &e))?
    .map_err(|e| open_error(&e))?;

    let focus = match focus_of(&project) {
        Some(dir) => Some(to_dir_key(dir).ok_or_else(|| non_utf8_error(dir))?),
        None => None,
    };
    let fresh = to_project_info(&project, focus.as_deref(), fuz_sys::rfc3339_now())?;

    // Run to completion in its own task, so a caller that goes away mid-open
    // can't leave filers running for a project that never opened.
    tokio::spawn(open_project(app, fresh, focus))
        .await
        .map_err(|e| internal_error_with_source("failed to open project", &e))?
}

/// The body of `project_open` once the path is resolved: start the filers
/// this open needs, then record the project.
async fn open_project(
    app: Arc<App>,
    fresh: ProjectInfo,
    focus: Option<String>,
) -> Result<ActionOutput, JsonrpcError> {
    // Start (or find) the filers before taking the lifecycle lock: their
    // initial scans walk, watch, and stat whole trees, and opens and closes
    // of other projects shouldn't wait on them. A directory that can't be
    // listed fails the open here, before anything is recorded.
    let wanted = filers_of(&fresh);
    if let Err(error) = ensure_filers(&app, &wanted, OPEN_PROJECT).await {
        let lifecycle = app.project_lifecycle.lock().await;
        stop_unkept_filers(&app, wanted.keys(), &lifecycle).await;
        return Err(error);
    }

    // Held across the map, scope, and filer steps so a concurrent close can't
    // interleave (see `App::project_lifecycle`).
    let lifecycle = app.project_lifecycle.lock().await;

    let previous = app.projects.read().get(&fresh.root).cloned();
    let project = previous
        .as_ref()
        .map_or_else(|| fresh.clone(), |existing| merge_project(existing, &fresh));
    app.projects
        .write()
        .insert(project.root.clone(), project.clone());

    // A close that ran between the starts above and the lock stopped the
    // filers it alone kept, so ensure them again — dedup hits otherwise.
    // `start_filer` only returns once a registered filer has finished its
    // initial scan, so the returned files always come from completed scans.
    let filers = filers_of(&project);
    if let Err(error) = ensure_filers(&app, &filers, OPEN_PROJECT).await {
        {
            let mut projects = app.projects.write();
            match &previous {
                Some(previous) => projects.insert(previous.root.clone(), previous.clone()),
                None => projects.remove(&project.root),
            };
        }
        stop_unkept_filers(&app, filers.keys(), &lifecycle).await;
        return Err(error);
    }
    // only once the open can't fail, so a rollback restores `previous` with
    // every filer it kept still running
    if let Some(previous) = &previous {
        release_narrowed_filers(&app, previous, &lifecycle).await;
    }
    app.scoped_fs.add_path(Path::new(&project.root));

    match &previous {
        None => broadcast_project_changed(&app, ProjectChange::Open, &project, &lifecycle)?,
        Some(previous) if !previous.same_as(&project) => {
            broadcast_project_changed(&app, ProjectChange::Update, &project, &lifecycle)?;
        }
        Some(_) => {}
    }
    drop(lifecycle);

    let (files, watch_status) = files_of(&app, &filers).await;
    let size_hint = disknodes_json_size_hint(&files) + PROJECT_OPEN_OVERHEAD;
    let result = ProjectOpenResult {
        project,
        focus,
        files,
        watch_status,
    };
    Ok(ActionOutput::serialize(result).with_size_hint(size_hint))
}

/// The non-file part of a `project_open` or `repo_focus` response, budgeted
/// on top of the files' size hint — the registry's entries included.
const PROJECT_OPEN_OVERHEAD: usize = 16 * 1024;

/// What fails when an open's filer can't start ([`filer_error`]).
const OPEN_PROJECT: &str = "open project";

/// What fails when a focus's filer can't start ([`filer_error`]).
const FOCUS_REPO: &str = "focus repo";

/// `project_close` — close an open project.
///
/// `root` is matched against the open projects as given (plus a trailing
/// `/`), then canonicalized — so a non-canonical spelling of an open root
/// (`/a/./b`, a symlinked path) closes it too, while a project whose root was
/// deleted can still be closed by its stored root.
///
/// # Errors
///
/// `invalid_params` for a malformed input, a relative path, or a root that
/// names no open project (`project_not_open`); an internal error if the
/// close notification fails to serialize.
pub async fn project_close(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let ProjectCloseInput { root } = parse_strict_params(params)?;
    // without this, `""` would become the key `/`
    if !Path::new(&root).is_absolute() {
        return Err(invalid_params(
            &format!("root must be absolute: {root:?}"),
            Some(ERROR_INVALID_PATH),
        ));
    }
    // Run to completion in its own task: the spine cancels a socket's
    // in-flight handlers when it closes, and a close dropped between its map
    // removal and its filer stops would leave filers nothing ever stops.
    tokio::spawn(close_project(app, root))
        .await
        .map_err(|e| internal_error_with_source("failed to close project", &e))??;
    Ok(Value::Null)
}

/// The body of `project_close` once `root` is known absolute.
async fn close_project(app: Arc<App>, root: String) -> Result<(), JsonrpcError> {
    let mut key = with_trailing_slash(root.clone());
    // resolved before the lock — only consulted if `key` itself isn't open
    let canonical_key = tokio::fs::canonicalize(&root)
        .await
        .ok()
        .and_then(|canonical| to_dir_key(&canonical));

    let lifecycle = app.project_lifecycle.lock().await;

    let is_open = app.projects.read().contains_key(&key);
    if !is_open && let Some(canonical_key) = canonical_key {
        key = canonical_key;
    }

    let Some(project) = release_project(&app, &key, &lifecycle).await else {
        return Err(not_open_error(&root));
    };
    let broadcast = broadcast_project_changed(&app, ProjectChange::Close, &project, &lifecycle);
    drop(lifecycle);
    broadcast
}

/// The error for a root that names no open project.
fn not_open_error(root: &str) -> JsonrpcError {
    invalid_params(
        &format!("project not open: {root}"),
        Some(ERROR_PROJECT_NOT_OPEN),
    )
}

/// The entry of `project` whose checkout is `dir` — refused when `project`
/// isn't a registry or has no such entry. `failed` names what fails.
fn entry_of<'a>(
    project: &'a ProjectInfo,
    dir: &str,
    failed: &str,
) -> Result<&'a ProjectEntryInfo, JsonrpcError> {
    if project.kind != ProjectInfoKind::Registry {
        return Err(invalid_params(
            &format!(
                "failed to {failed}: {} isn't a registry project — its root is its one focus",
                project.root
            ),
            Some(ERROR_PROJECT_NOT_REGISTRY),
        ));
    }
    project
        .entries
        .iter()
        .find(|entry| entry.dir == dir)
        .ok_or_else(|| {
            invalid_params(
                &format!(
                    "failed to {failed}: {dir} is none of the registry entries of {}",
                    project.root
                ),
                Some(ERROR_REPO_NOT_IN_PROJECT),
            )
        })
}

/// The error for a repo whose filer can't start: one gone since the registry
/// was last resolved is `repo_not_present` (`not_found`), as a missing entry
/// is; anything else as an open's ([`filer_error`]).
fn focus_filer_error(dir: &str, error: &std::io::Error) -> JsonrpcError {
    if error.kind() == std::io::ErrorKind::NotFound {
        return not_found_error(
            &format!(
                "failed to focus repo: {dir} is gone since the registry was resolved (opening the project again resolves it): {error}"
            ),
            ERROR_REPO_NOT_PRESENT,
        );
    }
    filer_error(FOCUS_REPO, dir, error)
}

/// Check that `dir` is a present registry entry of `project` — what
/// `repo_focus` can focus.
fn check_focusable(project: &ProjectInfo, dir: &str) -> Result<(), JsonrpcError> {
    let entry = entry_of(project, dir, FOCUS_REPO)?;
    match entry.state {
        EntryState::Present => Ok(()),
        EntryState::Missing => Err(not_found_error(
            &format!(
                "failed to focus repo: registry entry {} isn't cloned at {dir} (opening a path in it resolves the registry again)",
                entry.key
            ),
            ERROR_REPO_NOT_PRESENT,
        )),
        EntryState::Refused => Err(forbidden(
            &format!(
                "failed to focus repo: registry entry {} at {dir} is refused: {}",
                entry.key,
                entry.reason.unwrap_or("unknown")
            ),
            Some(ERROR_REPO_NOT_PRESENT),
        )),
    }
}

/// `repo_focus` — focus a registry entry of an open project.
///
/// Its whole tree is then indexed and watched, as opening a path in it would
/// do, without resolving the registry again: the entry must be present as the
/// project's last resolve left it.
///
/// Side-effects: starts the repo's filer, adds it to the project's focus,
/// and broadcasts `project_changed` `update`. Idempotent: focusing a focused
/// repo changes and broadcasts nothing. Returns the project and the index of
/// every filer of the project, like `project_open`.
///
/// # Errors
///
/// `invalid_params` for a malformed input, a root that names no open project
/// (`project_not_open`), a project that isn't a registry
/// (`project_not_registry`), or a directory that's none of its entries
/// (`repo_not_in_project`); `not_found` for an entry not yet cloned or gone
/// since the registry was resolved, and `forbidden` for a refused one
/// (`repo_not_present`); `forbidden` / an internal error for a repo that
/// can't be listed otherwise, leaving the project as it was; an internal
/// error if the notification fails to serialize.
pub async fn repo_focus(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<ActionOutput, JsonrpcError> {
    let RepoInput { root, dir } = parse_strict_params(params)?;
    let (root, dir) = (with_trailing_slash(root), with_trailing_slash(dir));
    // Run to completion in its own task, so a caller that goes away mid-scan
    // can't leave a filer running for a focus that never landed.
    tokio::spawn(focus_repo(app, root, dir))
        .await
        .map_err(|e| internal_error_with_source("failed to focus repo", &e))?
}

/// The body of `repo_focus`: check, start the repo's filer, then record it.
async fn focus_repo(
    app: Arc<App>,
    root: String,
    dir: String,
) -> Result<ActionOutput, JsonrpcError> {
    // checked before the scan, so a refused focus starts nothing
    {
        let projects = app.projects.read();
        let project = projects.get(&root).ok_or_else(|| not_open_error(&root))?;
        check_focusable(project, &dir)?;
    }
    // the scan runs before the lifecycle lock, as an open's does
    if let Err(error) = ensure_filer(&app, &dir, FilerDepth::Tree).await {
        let lifecycle = app.project_lifecycle.lock().await;
        stop_unkept_filers(&app, [&dir], &lifecycle).await;
        return Err(focus_filer_error(&dir, &error));
    }

    let lifecycle = app.project_lifecycle.lock().await;

    // closed meanwhile, or opened again with the entry no longer present
    let checked = app
        .projects
        .read()
        .get(&root)
        .cloned()
        .ok_or_else(|| not_open_error(&root))
        .and_then(|project| check_focusable(&project, &dir).map(|()| project));
    let previous = match checked {
        Ok(previous) => previous,
        Err(error) => {
            // TODO a filer the start above widened from a top level to a whole
            // tree — a nested registry's root, which that project keeps at its
            // top level — stays whole here, since this only stops what no
            // project keeps; narrowing it back needs `release_narrowed_filers`'
            // replace
            stop_unkept_filers(&app, [&dir], &lifecycle).await;
            return Err(error);
        }
    };
    let mut project = previous.clone();
    if !project.focused.contains(&dir) {
        project.focused.push(dir.clone());
        project.focused.sort();
    }
    app.projects
        .write()
        .insert(project.root.clone(), project.clone());

    // an unfocus or close that ran between the start above and the lock
    // stopped the filer, so ensure it again — dedup hits otherwise
    let filers = filers_of(&project);
    if let Err(error) = ensure_filers(&app, &filers, FOCUS_REPO).await {
        app.projects
            .write()
            .insert(previous.root.clone(), previous.clone());
        stop_unkept_filers(&app, filers.keys(), &lifecycle).await;
        return Err(error);
    }
    if !previous.same_as(&project) {
        broadcast_project_changed(&app, ProjectChange::Update, &project, &lifecycle)?;
    }
    drop(lifecycle);

    let (files, watch_status) = files_of(&app, &filers).await;
    let size_hint = disknodes_json_size_hint(&files) + PROJECT_OPEN_OVERHEAD;
    let result = RepoFocusResult {
        project,
        files,
        watch_status,
    };
    Ok(ActionOutput::serialize(result).with_size_hint(size_hint))
}

/// `repo_unfocus` — drop a registry entry from an open project's focus.
///
/// Its filer stops unless another open project keeps it (a nested registry
/// keeping it at its top level narrows it to that), and its files leave the
/// index; no `filer_change` deletes them, so clients release them on the
/// `project_changed` `update`.
///
/// Side-effects: removes the focus and broadcasts `project_changed`
/// `update`. Idempotent: unfocusing an unfocused entry — present or not —
/// changes and broadcasts nothing. A registry may be left with no focus, as
/// opening its root alone leaves it. Returns the project.
///
/// # Errors
///
/// `invalid_params` for a malformed input, a root that names no open project
/// (`project_not_open`), a project that isn't a registry, whose root focus
/// lasts while it's open (`project_not_registry`), or a directory that's
/// none of its entries (`repo_not_in_project`); an internal error if the
/// notification fails to serialize.
pub async fn repo_unfocus(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let RepoInput { root, dir } = parse_strict_params(params)?;
    let (root, dir) = (with_trailing_slash(root), with_trailing_slash(dir));
    // Run to completion in its own task: the spine cancels a socket's
    // in-flight handlers when it closes, and an unfocus dropped mid-release
    // would leave the focus gone, its filer running, and nothing broadcast.
    let project = tokio::spawn(async move { unfocus_repo(&app, &root, &dir).await })
        .await
        .map_err(|e| internal_error_with_source("failed to unfocus repo", &e))??;
    serde_json::to_value(RepoUnfocusResult { project })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// The body of `repo_unfocus`, returning the project as it's left.
async fn unfocus_repo(app: &Arc<App>, root: &str, dir: &str) -> Result<ProjectInfo, JsonrpcError> {
    let lifecycle = app.project_lifecycle.lock().await;

    let previous = app
        .projects
        .read()
        .get(root)
        .cloned()
        .ok_or_else(|| not_open_error(root))?;
    entry_of(&previous, dir, "unfocus repo")?;
    let mut project = previous.clone();
    project.focused.retain(|focused| focused != dir);
    let broadcast = if previous.same_as(&project) {
        Ok(())
    } else {
        app.projects
            .write()
            .insert(project.root.clone(), project.clone());
        release_narrowed_filers(app, &previous, &lifecycle).await;
        broadcast_project_changed(app, ProjectChange::Update, &project, &lifecycle)
    };
    drop(lifecycle);
    broadcast.map(|()| project)
}

/// Close every open project through the same path as `project_close`.
///
/// Each project's filers are stopped, its `ScopedFs` root removed, and a
/// `project_changed` close broadcast — restoring the boot-time scope
/// (`zzz_dir` + `scoped_dirs`). Used by the test binary's `_testing_reset`.
///
/// Returns the closed projects.
///
/// # Errors
///
/// Returns a JSON-RPC internal error if a notification fails to serialize;
/// every project is released before any broadcast, so the scope is restored
/// regardless.
pub async fn project_close_all(app: &App) -> Result<Vec<ProjectInfo>, JsonrpcError> {
    let lifecycle = app.project_lifecycle.lock().await;
    let keys: Vec<String> = app.projects.read().keys().cloned().collect();
    let mut closed = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(project) = release_project(app, &key, &lifecycle).await {
            closed.push(project);
        }
    }
    // every project is released before any broadcast, and every broadcast
    // goes out under the lock (see `project_close`)
    let broadcast = closed.iter().try_for_each(|project| {
        broadcast_project_changed(app, ProjectChange::Close, project, &lifecycle)
    });
    drop(lifecycle);
    broadcast?;
    Ok(closed)
}

/// Remove the project at `key` (a root, trailing `/`) from the open map and
/// release its `ScopedFs` root and the filers no other open project keeps.
/// `None` if it isn't open.
///
/// Unconditional on purpose: `FilerManager::stop_filer` keeps permanent
/// filers and `ScopedFs::remove_path` never removes a permanent root, so a
/// project rooted at `zzz_dir` or a scoped dir — or nested in or containing
/// one — can't revoke the access that root grants.
///
/// The `lifecycle` guard is proof the caller holds `App::project_lifecycle`,
/// keeping the map, scope, and filers in lockstep.
async fn release_project(
    app: &App,
    key: &str,
    lifecycle: &tokio::sync::MutexGuard<'_, ()>,
) -> Option<ProjectInfo> {
    let project = app.projects.write().remove(key)?;
    stop_unkept_filers(app, filers_of(&project).keys(), lifecycle).await;
    app.scoped_fs.remove_path(Path::new(key));
    Some(project)
}

impl ProjectInfo {
    /// Whether `other` reports the same project state — the open time aside,
    /// which a merge keeps.
    fn same_as(&self, other: &Self) -> bool {
        self.root == other.root
            && self.kind == other.kind
            && self.registry_path == other.registry_path
            && self.entries == other.entries
            && self.focused == other.focused
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use fuz_repos::registry::ValidRegistry;

    use super::*;
    use crate::project::{EntryRefusal, ProjectEntry};

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
"#;

    fn reason(error: &JsonrpcError) -> Option<&str> {
        error.data.as_ref()?.get("reason")?.as_str()
    }

    /// A registry project at `/w` opened from `opened`, its entries `app`
    /// present (at `app_dir`), `site` missing, and `keys` refused.
    fn registry_project(opened: &str, app_dir: &str) -> Project {
        let registry = ValidRegistry::parse(REGISTRY, Path::new("/w/repos.toml")).unwrap();
        let entries = registry
            .entries()
            .into_iter()
            .map(|entry| {
                let dir = match entry.key.as_str() {
                    "app" => EntryDir::Present(PathBuf::from(app_dir)),
                    "site" => EntryDir::Missing,
                    _ => EntryDir::Refused(EntryRefusal::NotConfined {
                        path: PathBuf::from("/w/keys"),
                        resolved: PathBuf::from("/elsewhere"),
                    }),
                };
                ProjectEntry { entry, dir }
            })
            .collect();
        Project {
            root: PathBuf::from("/w"),
            opened: PathBuf::from(opened),
            kind: ProjectKind::Registry {
                path: PathBuf::from("/w/repos.toml"),
                entries,
            },
        }
    }

    fn plain_project(kind: ProjectKind) -> Project {
        Project {
            root: PathBuf::from("/p"),
            opened: PathBuf::from("/p/sub"),
            kind,
        }
    }

    #[test]
    fn an_open_focuses_the_entry_holding_the_opened_dir() {
        assert_eq!(
            focus_of(&registry_project("/w/app/src", "/w/app")),
            Some(Path::new("/w/app"))
        );
        assert_eq!(
            focus_of(&registry_project("/w/app", "/w/app")),
            Some(Path::new("/w/app"))
        );
        // the root, an unregistered dir, a sibling sharing a prefix
        for opened in ["/w", "/w/scratch", "/w/application"] {
            assert_eq!(
                focus_of(&registry_project(opened, "/w/app")),
                None,
                "{opened}"
            );
        }
        // a checkout or plain dir focuses its root, wherever it opened from
        for kind in [ProjectKind::GitRepo, ProjectKind::PlainDir] {
            assert_eq!(focus_of(&plain_project(kind)), Some(Path::new("/p")));
        }
    }

    #[test]
    fn a_registry_project_serializes_its_entries_and_focus() {
        let project = registry_project("/w/app/src", "/w/app");
        let info = to_project_info(&project, Some("/w/app/"), "t".to_owned()).unwrap();
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "root": "/w/",
                "name": "w",
                "opened_at": "t",
                "kind": "registry",
                "registry_path": "/w/repos.toml",
                "entries": [
                    {"key": "app", "kind": "repo", "dir": "/w/app/", "state": "present"},
                    {"key": "site", "kind": "repo", "dir": "/w/site/", "state": "missing"},
                    {
                        "key": "keys",
                        "kind": "reference",
                        "dir": "/w/keys/",
                        "state": "refused",
                        "reason": "entry_not_confined",
                    },
                ],
                "focused": ["/w/app/"],
            })
        );
        assert_eq!(
            filers_of(&info).into_iter().collect::<Vec<_>>(),
            [
                ("/w/".to_owned(), FilerDepth::TopLevel),
                ("/w/app/".to_owned(), FilerDepth::Tree),
            ]
        );
    }

    #[test]
    fn a_present_entry_reports_where_it_resolves() {
        // a symlinked entry dir resolves elsewhere inside the root
        let project = registry_project("/w", "/w/real/app");
        let info = to_project_info(&project, None, "t".to_owned()).unwrap();
        assert_eq!(info.entries[0].dir, "/w/real/app/");
        assert!(info.focused.is_empty());
        // unfocused, the registry root is indexed at its top level alone
        assert_eq!(
            filers_of(&info).into_iter().collect::<Vec<_>>(),
            [("/w/".to_owned(), FilerDepth::TopLevel)]
        );
    }

    #[test]
    fn a_checkout_or_plain_dir_indexes_its_root_whole() {
        for (kind, wire) in [
            (ProjectKind::GitRepo, "git_repo"),
            (ProjectKind::PlainDir, "plain_dir"),
        ] {
            let info = to_project_info(&plain_project(kind), Some("/p/"), "t".to_owned()).unwrap();
            let value = serde_json::to_value(&info).unwrap();
            assert_eq!(value["kind"], wire);
            assert_eq!(value["registry_path"], Value::Null);
            assert_eq!(value["entries"], serde_json::json!([]));
            assert_eq!(value["focused"], serde_json::json!(["/p/"]));
            assert_eq!(
                filers_of(&info).into_iter().collect::<Vec<_>>(),
                [("/p/".to_owned(), FilerDepth::Tree)]
            );
        }
    }

    #[test]
    fn a_reopen_merges_focus_and_takes_the_fresh_entries() {
        let first = to_project_info(
            &registry_project("/w/app", "/w/app"),
            Some("/w/app/"),
            "first".to_owned(),
        )
        .unwrap();
        let mut second = to_project_info(
            &registry_project("/w/site", "/w/app"),
            Some("/w/site/"),
            "second".to_owned(),
        )
        .unwrap();
        second.entries[1].state = EntryState::Present;
        let merged = merge_project(&first, &second);
        assert_eq!(merged.focused, ["/w/app/", "/w/site/"]);
        assert_eq!(merged.opened_at, "first");
        assert_eq!(merged.entries[1].state, EntryState::Present);
        assert!(!merged.same_as(&first));
        // the same open again changes nothing
        assert!(merge_project(&merged, &second).same_as(&merged));
        // an open resolving the entries afresh reports them, and a focus on an
        // entry gone missing is dropped
        let site_gone = merge_project(&merged, &first);
        assert!(!site_gone.same_as(&merged));
        assert_eq!(site_gone.focused, ["/w/app/"]);

        // a plain dir focused on its root, then a registry there: the old
        // focus goes with the kind that supported it
        let plain = to_project_info(
            &Project {
                root: PathBuf::from("/w"),
                opened: PathBuf::from("/w"),
                kind: ProjectKind::PlainDir,
            },
            Some("/w/"),
            "plain".to_owned(),
        )
        .unwrap();
        let registry = merge_project(&plain, &first);
        assert_eq!(registry.focused, ["/w/app/"]);
        assert_eq!(
            filers_of(&registry).into_iter().collect::<Vec<_>>(),
            [
                ("/w/".to_owned(), FilerDepth::TopLevel),
                ("/w/app/".to_owned(), FilerDepth::Tree),
            ]
        );
        // and back: a registry's focus goes when the root is a plain dir again
        let mut unregistered = plain;
        unregistered.focused = vec!["/w/".to_owned()];
        assert_eq!(merge_project(&registry, &unregistered).focused, ["/w/"]);
    }

    /// Inert handles: a lazy pool that never connects, no roots, no sockets.
    fn inert_app() -> Arc<App> {
        app_over(Arc::new(fuz_realtime::ConnectionRegistry::new()))
    }

    /// [`inert_app`] broadcasting over `realtime`.
    fn app_over(realtime: Arc<fuz_realtime::ConnectionRegistry>) -> Arc<App> {
        let pool = fuz_db::create_pool(
            "postgres://localhost:1/project_test_unused",
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

    /// The `project_changed` notifications queued on `rx`, each its type and
    /// the focus it reports — other frames (`filer_change`) skipped.
    fn project_changes(rx: &mut fuz_realtime::ConnectionReceiver) -> Vec<(String, Value)> {
        let mut changes = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let message: Value = serde_json::from_str(frame.as_str()).unwrap();
            if message["method"] == "project_changed" {
                let params = &message["params"];
                changes.push((
                    params["type"].as_str().unwrap().to_owned(),
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
                std::env::temp_dir().join(format!("zzz_project_handler_{}", uuid::Uuid::new_v4()));
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

    /// A registry project at `tmp/w/` with `app` and `site` present,
    /// focusing `focus`.
    fn registry_info(tmp: &TempDir, focus: &[&str]) -> ProjectInfo {
        let entry = |key: &str| ProjectEntryInfo {
            key: key.to_owned(),
            kind: EntryInfoKind::Repo,
            dir: tmp.key(&format!("w/{key}/")),
            state: EntryState::Present,
            reason: None,
        };
        ProjectInfo {
            root: tmp.key("w/"),
            name: "w".to_owned(),
            opened_at: "t".to_owned(),
            kind: ProjectInfoKind::Registry,
            registry_path: Some(tmp.key("w/repos.toml")),
            entries: vec![entry("app"), entry("site")],
            focused: focus
                .iter()
                .map(|key| tmp.key(&format!("w/{key}/")))
                .collect(),
        }
    }

    /// `open_project`'s result as JSON.
    async fn open(app: &Arc<App>, info: ProjectInfo, focus: Option<String>) -> Value {
        let output = open_project(Arc::clone(app), info, focus).await.unwrap();
        let mut out = Vec::new();
        output.write_json(&mut out).unwrap();
        serde_json::from_slice(&out).unwrap()
    }

    fn file_ids(result: &Value) -> Vec<&str> {
        result["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["id"].as_str().unwrap())
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_registry_open_indexes_loose_files_and_focused_repos_and_a_close_releases_them() {
        let tmp = TempDir::new();
        for rel in [
            "w/README.md",
            "w/app/a.txt",
            "w/site/s.txt",
            "w/scratch/x.txt",
        ] {
            tmp.write(rel);
        }
        let app = inert_app();
        let root = tmp.key("w/");
        let app_dir = tmp.key("w/app/");
        let site_dir = tmp.key("w/site/");

        let first = open(&app, registry_info(&tmp, &["app"]), Some(app_dir.clone())).await;
        assert_eq!(first["focus"], app_dir.as_str());
        assert_eq!(first["watch_status"], "full");
        // the root's loose files and the focused repo — no unfocused repo, no
        // unregistered dir
        assert_eq!(
            file_ids(&first),
            [tmp.key("w/README.md"), tmp.key("w/app/a.txt")]
        );
        assert!(
            app.scoped_fs
                .open_file(&tmp.key("w/scratch/x.txt"))
                .await
                .is_ok()
        );

        // opening another repo of it adds its focus, keeping the first
        let second = open(&app, registry_info(&tmp, &["site"]), Some(site_dir.clone())).await;
        assert_eq!(
            second["project"]["focused"],
            serde_json::json!([app_dir, site_dir])
        );
        assert_eq!(second["project"]["opened_at"], "t");
        assert_eq!(
            file_ids(&second),
            [
                tmp.key("w/README.md"),
                tmp.key("w/app/a.txt"),
                tmp.key("w/site/s.txt")
            ]
        );
        assert_eq!(app.projects.read().len(), 1);

        // a plain-dir project inside it shares the focused repo's filer
        let mut nested = to_project_info(
            &Project {
                root: PathBuf::from(tmp.key("w/app")),
                opened: PathBuf::from(tmp.key("w/app")),
                kind: ProjectKind::PlainDir,
            },
            Some(&app_dir),
            "t".to_owned(),
        )
        .unwrap();
        nested.name = "app".to_owned();
        open(&app, nested, Some(app_dir.clone())).await;

        let lifecycle = app.project_lifecycle.lock().await;
        let closed = release_project(&app, &root, &lifecycle).await.unwrap();
        assert_eq!(closed.root, root);
        assert!(release_project(&app, &root, &lifecycle).await.is_none());
        drop(lifecycle);
        // the registry's filers stopped, the one the nested project keeps not
        assert!(app.filer_manager.files_for(&root).await.is_empty());
        assert!(app.filer_manager.files_for(&site_dir).await.is_empty());
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 1);
        // its root is out of scope, the nested project's still in
        assert!(
            app.scoped_fs
                .open_file(&tmp.key("w/README.md"))
                .await
                .is_err()
        );
        assert!(
            app.scoped_fs
                .open_file(&tmp.key("w/app/a.txt"))
                .await
                .is_ok()
        );

        assert_eq!(project_close_all(&app).await.unwrap().len(), 1);
        assert!(app.filer_manager.files_for(&app_dir).await.is_empty());
        assert!(app.projects.read().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_plain_root_turned_registry_narrows_its_whole_tree_filer() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/scratch/x.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let root = tmp.key("w/");
        let plain = to_project_info(
            &Project {
                root: PathBuf::from(tmp.key("w")),
                opened: PathBuf::from(tmp.key("w")),
                kind: ProjectKind::PlainDir,
            },
            Some(&root),
            "t".to_owned(),
        )
        .unwrap();
        let first = open(&app, plain, Some(root.clone())).await;
        assert_eq!(file_ids(&first).len(), 3, "the whole tree");

        // the registry appears, and `app` opens
        let second = open(&app, registry_info(&tmp, &["app"]), Some(tmp.key("w/app/"))).await;
        assert_eq!(
            second["project"]["focused"],
            serde_json::json!([tmp.key("w/app/")])
        );
        assert_eq!(
            file_ids(&second),
            [tmp.key("w/README.md"), tmp.key("w/app/a.txt")],
            "the root narrowed to its top level, `scratch` unindexed"
        );
        assert_eq!(app.filer_manager.files_for(&root).await.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_whose_focus_cant_be_indexed_leaves_nothing_new_open() {
        let tmp = TempDir::new();
        tmp.write("w/README.md");
        let app = inert_app();
        // `site` is gone by the time its filer starts
        let info = registry_info(&tmp, &["site"]);
        let error = open_project(Arc::clone(&app), info, Some(tmp.key("w/site/")))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, JsonrpcErrorCode::NotFound);
        assert!(app.projects.read().is_empty());
        assert!(app.filer_manager.files_for(&tmp.key("w/")).await.is_empty());
        assert!(
            app.scoped_fs
                .open_file(&tmp.key("w/README.md"))
                .await
                .is_err()
        );
    }

    /// `focus_repo`'s result as JSON.
    async fn focus(app: &Arc<App>, root: &str, dir: &str) -> Result<Value, JsonrpcError> {
        let output = focus_repo(Arc::clone(app), root.to_owned(), dir.to_owned()).await?;
        let mut out = Vec::new();
        output.write_json(&mut out).unwrap();
        Ok(serde_json::from_slice(&out).unwrap())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_indexes_a_repo_and_an_unfocus_releases_it() {
        let tmp = TempDir::new();
        for rel in [
            "w/README.md",
            "w/app/a.txt",
            "w/app/src/b.txt",
            "w/site/s.txt",
        ] {
            tmp.write(rel);
        }
        let (app, _connection, mut rx) = app_with_socket();
        let root = tmp.key("w/");
        let app_dir = tmp.key("w/app/");
        open(&app, registry_info(&tmp, &[]), None).await;
        assert_eq!(
            project_changes(&mut rx),
            [("open".to_owned(), serde_json::json!([]))]
        );

        let focused = focus(&app, &root, &app_dir).await.unwrap();
        assert_eq!(focused["project"]["focused"], serde_json::json!([app_dir]));
        assert_eq!(focused["watch_status"], "full");
        assert_eq!(
            file_ids(&focused),
            [
                tmp.key("w/README.md"),
                tmp.key("w/app/a.txt"),
                tmp.key("w/app/src/b.txt")
            ],
            "the root's loose files and the focused repo — not the unfocused `site`"
        );
        assert_eq!(
            project_changes(&mut rx),
            [("update".to_owned(), serde_json::json!([app_dir]))]
        );
        assert_eq!(
            app.projects.read()[&root].focused,
            std::slice::from_ref(&app_dir)
        );

        // again: the same reply, nothing changed or broadcast
        let again = focus(&app, &root, &app_dir).await.unwrap();
        assert_eq!(again, focused);
        assert!(project_changes(&mut rx).is_empty());

        // the body takes keys as given — the handler adds the trailing slash —
        // so a dir without one names no entry here
        let project = unfocus_repo(&app, &root, app_dir.trim_end_matches('/'))
            .await
            .unwrap_err();
        assert_eq!(
            reason(&project),
            Some(ERROR_REPO_NOT_IN_PROJECT),
            "keys are exact"
        );
        let project = unfocus_repo(&app, &root, &app_dir).await.unwrap();
        assert!(project.focused.is_empty(), "a registry may keep no focus");
        assert_eq!(
            project_changes(&mut rx),
            [("update".to_owned(), serde_json::json!([]))]
        );
        assert!(
            app.filer_manager.files_for(&app_dir).await.is_empty(),
            "its filer stopped"
        );
        assert_eq!(
            app.filer_manager.files_for(&root).await.len(),
            1,
            "the root's top level stays"
        );
        // again: nothing changed or broadcast
        assert!(
            unfocus_repo(&app, &root, &app_dir)
                .await
                .unwrap()
                .focused
                .is_empty()
        );
        assert!(project_changes(&mut rx).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unfocus_keeps_a_filer_another_project_keeps() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/app/sub/c.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let root = tmp.key("w/");
        let app_dir = tmp.key("w/app/");
        open(&app, registry_info(&tmp, &["app"]), Some(app_dir.clone())).await;
        // a plain-dir project at the repo keeps its whole tree
        let plain = to_project_info(
            &Project {
                root: PathBuf::from(tmp.key("w/app")),
                opened: PathBuf::from(tmp.key("w/app")),
                kind: ProjectKind::PlainDir,
            },
            Some(&app_dir),
            "t".to_owned(),
        )
        .unwrap();
        open(&app, plain, Some(app_dir.clone())).await;

        unfocus_repo(&app, &root, &app_dir).await.unwrap();
        assert_eq!(app.filer_manager.files_for(&app_dir).await.len(), 2);

        // a registry rooted at the repo keeps only its top level: the filer
        // narrows to that
        project_close_all(&app).await.unwrap();
        open(&app, registry_info(&tmp, &["app"]), Some(app_dir.clone())).await;
        let mut nested = registry_info(&tmp, &[]);
        nested.root.clone_from(&app_dir);
        nested.entries.clear();
        open(&app, nested, None).await;
        assert_eq!(
            app.filer_manager.files_for(&app_dir).await.len(),
            2,
            "still whole"
        );
        unfocus_repo(&app, &root, &app_dir).await.unwrap();
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
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_or_unfocus_refuses_what_isnt_a_present_entry() {
        let tmp = TempDir::new();
        tmp.write("w/README.md");
        tmp.write("p/x.txt");
        let (app, _connection, mut rx) = app_with_socket();
        let root = tmp.key("w/");
        let mut info = registry_info(&tmp, &[]);
        info.entries[1].state = EntryState::Missing;
        info.entries.push(ProjectEntryInfo {
            key: "keys".to_owned(),
            kind: EntryInfoKind::Reference,
            dir: tmp.key("w/keys/"),
            state: EntryState::Refused,
            reason: Some("entry_not_confined"),
        });
        open(&app, info, None).await;
        let plain_root = tmp.key("p/");
        let plain = to_project_info(
            &Project {
                root: PathBuf::from(tmp.key("p")),
                opened: PathBuf::from(tmp.key("p")),
                kind: ProjectKind::PlainDir,
            },
            Some(&plain_root),
            "t".to_owned(),
        )
        .unwrap();
        open(&app, plain, Some(plain_root.clone())).await;
        project_changes(&mut rx);

        let cases = [
            (
                tmp.key("none/"),
                tmp.key("w/app/"),
                JsonrpcErrorCode::InvalidParams,
                ERROR_PROJECT_NOT_OPEN,
            ),
            (
                plain_root.clone(),
                plain_root.clone(),
                JsonrpcErrorCode::InvalidParams,
                ERROR_PROJECT_NOT_REGISTRY,
            ),
            (
                root.clone(),
                tmp.key("w/scratch/"),
                JsonrpcErrorCode::InvalidParams,
                ERROR_REPO_NOT_IN_PROJECT,
            ),
            (
                root.clone(),
                root.clone(),
                JsonrpcErrorCode::InvalidParams,
                ERROR_REPO_NOT_IN_PROJECT,
            ),
            (
                root.clone(),
                tmp.key("w/site/"),
                JsonrpcErrorCode::NotFound,
                ERROR_REPO_NOT_PRESENT,
            ),
            (
                root.clone(),
                tmp.key("w/keys/"),
                JsonrpcErrorCode::Forbidden,
                ERROR_REPO_NOT_PRESENT,
            ),
        ];
        for (root, dir, code, expected) in &cases {
            let error = focus(&app, root, dir).await.unwrap_err();
            assert_eq!(error.code, *code, "{dir}");
            assert_eq!(reason(&error), Some(*expected), "{dir}");
        }
        // no filer started for any of them (the two project roots have their own)
        assert!(
            app.filer_manager
                .files_for(&tmp.key("w/scratch/"))
                .await
                .is_empty()
        );
        assert_eq!(app.filer_manager.files_for(&root).await.len(), 1);
        // unfocus refuses the first three alike; a missing or refused entry
        // was never focused, so its unfocus is a no-op
        for (root, dir, _, expected) in &cases[..4] {
            let error = unfocus_repo(&app, root, dir).await.unwrap_err();
            assert_eq!(reason(&error), Some(*expected), "{dir}");
        }
        for (root, dir, _, _) in &cases[4..] {
            assert!(unfocus_repo(&app, root, dir).await.is_ok(), "{dir}");
        }
        assert_eq!(
            app.projects.read()[&plain_root].focused,
            std::slice::from_ref(&plain_root)
        );
        assert!(project_changes(&mut rx).is_empty(), "nothing broadcast");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_that_cant_be_indexed_leaves_the_project_as_it_was() {
        let tmp = TempDir::new();
        tmp.write("w/README.md");
        let (app, _connection, mut rx) = app_with_socket();
        let root = tmp.key("w/");
        // `app` is present as resolved, then gone by the time it's focused
        open(&app, registry_info(&tmp, &[]), None).await;
        project_changes(&mut rx);
        let error = focus(&app, &root, &tmp.key("w/app/")).await.unwrap_err();
        assert_eq!(error.code, JsonrpcErrorCode::NotFound);
        assert_eq!(reason(&error), Some(ERROR_REPO_NOT_PRESENT));
        assert!(
            error
                .message
                .contains("opening the project again resolves it"),
            "{}",
            error.message
        );
        assert!(app.projects.read()[&root].focused.is_empty());
        assert!(project_changes(&mut rx).is_empty());
    }

    #[test]
    fn open_errors_map_by_cause_with_the_resolver_reason() {
        let io = |kind| std::io::Error::from(kind);
        let cases = [
            (
                ProjectError::NotAbsolute {
                    path: PathBuf::from("x"),
                },
                JsonrpcErrorCode::InvalidParams,
                "invalid_path",
            ),
            (
                ProjectError::Unresolvable {
                    path: PathBuf::from("/x"),
                    source: io(std::io::ErrorKind::NotFound),
                },
                JsonrpcErrorCode::NotFound,
                "path_not_found",
            ),
            (
                ProjectError::Unresolvable {
                    path: PathBuf::from("/x"),
                    source: io(std::io::ErrorKind::PermissionDenied),
                },
                JsonrpcErrorCode::Forbidden,
                "permission_denied",
            ),
            (
                ProjectError::RootRefused {
                    root: PathBuf::from("/x"),
                    refusal: crate::root_policy::RootRefusal::FilesystemRoot,
                },
                JsonrpcErrorCode::Forbidden,
                ERROR_ROOT_NOT_ALLOWED,
            ),
            (
                ProjectError::RootRefused {
                    root: PathBuf::from("/x"),
                    refusal: crate::root_policy::RootRefusal::NoHome,
                },
                JsonrpcErrorCode::Forbidden,
                ERROR_ROOT_OUTSIDE_HOME,
            ),
            (
                ProjectError::RegistryUntrusted {
                    registry: PathBuf::from("/x/repos.toml"),
                    path: PathBuf::from("/x"),
                    why: crate::file_trust::Untrusted::WorldWritable { mode: 0o777 },
                },
                JsonrpcErrorCode::Forbidden,
                "registry_untrusted",
            ),
            (
                ProjectError::RegistryReplaced {
                    path: PathBuf::from("/x/repos.toml"),
                },
                JsonrpcErrorCode::Conflict,
                "registry_changed",
            ),
            (
                ProjectError::RegistryUnreadable {
                    path: PathBuf::from("/x/repos.toml"),
                    source: io(std::io::ErrorKind::InvalidData),
                },
                JsonrpcErrorCode::InvalidParams,
                "registry_unreadable",
            ),
            (
                ProjectError::BoundUnusable {
                    dir: PathBuf::from("/x"),
                    source: io(std::io::ErrorKind::NotFound),
                },
                JsonrpcErrorCode::InternalError,
                "bound_unusable",
            ),
        ];
        for (error, code, expected) in cases {
            let mapped = open_error(&error);
            assert_eq!(mapped.code, code, "{error:?}");
            assert_eq!(reason(&mapped), Some(expected), "{error:?}");
            assert!(
                mapped.message.starts_with("failed to open project: "),
                "{}",
                mapped.message
            );
        }
    }

    #[test]
    fn filer_errors_map_by_cause() {
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let error = filer_error(OPEN_PROJECT, "/x/", &denied);
        assert_eq!(
            error.message,
            "failed to open project: can't index /x/: permission denied"
        );
        assert_eq!(error.code, JsonrpcErrorCode::Forbidden);
        assert_eq!(reason(&error), Some(ERROR_PERMISSION_DENIED));
        let gone = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(
            filer_error(FOCUS_REPO, "/x/", &gone).code,
            JsonrpcErrorCode::NotFound
        );
        let other = std::io::Error::other("boom");
        assert_eq!(
            filer_error(OPEN_PROJECT, "/x/", &other).code,
            JsonrpcErrorCode::InternalError
        );
    }
}
