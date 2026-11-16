//! Project handlers — `project_open`, `project_close`, `project_list`,
//! `repo_focus`, and `repo_unfocus`.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`. Each parses its
//! input, hands the change to [`crate::project_manager::ProjectManager`] —
//! which owns the open projects, their filers, their `ScopedFs` roots, and
//! the `project_changed` broadcasts — and maps what comes back to the wire.
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

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use fuz_actions::{ActionContext, ActionOutput};
use fuz_http::{
    JsonrpcError, JsonrpcErrorCode, forbidden, internal_error_with_source, invalid_params,
    parse_strict_params,
};
use fuz_repos::registry::EntryKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filer::{SerializableDisknode, WatchStatus, disknodes_json_size_hint};
use crate::handlers::filesystem::{ERROR_INVALID_PATH, ERROR_PERMISSION_DENIED};
use crate::handlers::{App, not_found_error};
use crate::project::{
    EntryDir, Project, ProjectError, ProjectKind, ResolveOptions, resolve_project,
};
use crate::project_manager::{
    EntryInfoKind, EntryState, Filers, LifecycleError, ProjectEntryInfo, ProjectInfo,
    ProjectInfoKind,
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

/// The JSON-RPC error for a change the project manager refused, carrying
/// its reason as `data.reason` where there is one (an internal error — a
/// filer that fails for no nameable cause, a notification that can't be
/// built — has none). `failed` names what failed (`open project`, `focus
/// repo`, …); `focusing` is the directory a focus asked for, whose vanishing
/// since the registry was resolved is `repo_not_present`, as a missing entry
/// is.
fn lifecycle_error(failed: &str, error: &LifecycleError, focusing: Option<&str>) -> JsonrpcError {
    match error {
        LifecycleError::NotOpen { .. } => {
            invalid_params(&error.to_string(), Some(ERROR_PROJECT_NOT_OPEN))
        }
        LifecycleError::NotRegistry { .. } => invalid_params(
            &format!("failed to {failed}: {error}"),
            Some(ERROR_PROJECT_NOT_REGISTRY),
        ),
        LifecycleError::RepoNotInProject { .. } => invalid_params(
            &format!("failed to {failed}: {error}"),
            Some(ERROR_REPO_NOT_IN_PROJECT),
        ),
        LifecycleError::RepoMissing { .. } => not_found_error(
            &format!("failed to {failed}: {error}"),
            ERROR_REPO_NOT_PRESENT,
        ),
        LifecycleError::RepoRefused { .. } => forbidden(
            &format!("failed to {failed}: {error}"),
            Some(ERROR_REPO_NOT_PRESENT),
        ),
        LifecycleError::Filer { dir, source }
            if focusing == Some(dir.as_str()) && source.kind() == std::io::ErrorKind::NotFound =>
        {
            not_found_error(
                &format!(
                    "failed to {failed}: {dir} is gone since the registry was resolved (opening the project again resolves it): {source}"
                ),
                ERROR_REPO_NOT_PRESENT,
            )
        }
        LifecycleError::Filer { dir, source } => filer_error(failed, dir, source),
        LifecycleError::Notify(source) => {
            internal_error_with_source("notification params serialize failed", source)
        }
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

/// The index of every filer in `filers`, deduplicated by path, and whether
/// each has every directory watched.
async fn files_of(app: &App, filers: &Filers) -> (Vec<SerializableDisknode>, WatchStatus) {
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
    let projects = app.projects.published().projects.clone();
    serde_json::to_value(ProjectListResult { projects })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `project_open` — open the project a path belongs to, focusing the repo
/// holding it (see the module docs).
///
/// The path may name a file (its parent opens) or a directory. It's resolved
/// on a blocking thread ([`resolve_project`]), then opened by the project
/// manager ([`crate::project_manager::ProjectManager::open`]): the filers the
/// project now needs start, its root enters `ScopedFs`, and `project_changed`
/// is broadcast — `open` for a new project, `update` for an open one this
/// changed (a new focus, or its registry's entries as resolved again).
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

/// The body of `project_open` once the path is resolved.
async fn open_project(
    app: Arc<App>,
    fresh: ProjectInfo,
    focus: Option<String>,
) -> Result<ActionOutput, JsonrpcError> {
    let landed = app
        .projects
        .open(&app, fresh)
        .await
        .map_err(|e| lifecycle_error(OPEN_PROJECT, &e, None))?;
    let (files, watch_status) = files_of(&app, &landed.filers).await;
    let size_hint = disknodes_json_size_hint(&files) + PROJECT_OPEN_OVERHEAD;
    let result = ProjectOpenResult {
        project: landed.project,
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

/// `project_close` — close an open project
/// ([`crate::project_manager::ProjectManager::close`]).
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
    // in-flight handlers when it closes, and a close dropped partway would
    // leave the project's filers running with nothing to stop them.
    tokio::spawn(async move { app.projects.close(&app, &root).await })
        .await
        .map_err(|e| internal_error_with_source("failed to close project", &e))?
        .map_err(|e| lifecycle_error("close project", &e, None))?;
    Ok(Value::Null)
}

/// `repo_focus` — focus a registry entry of an open project
/// ([`crate::project_manager::ProjectManager::focus`]).
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

/// The body of `repo_focus`.
async fn focus_repo(
    app: Arc<App>,
    root: String,
    dir: String,
) -> Result<ActionOutput, JsonrpcError> {
    let landed = app
        .projects
        .focus(&app, &root, &dir)
        .await
        .map_err(|e| lifecycle_error(FOCUS_REPO, &e, Some(&dir)))?;
    let (files, watch_status) = files_of(&app, &landed.filers).await;
    let size_hint = disknodes_json_size_hint(&files) + PROJECT_OPEN_OVERHEAD;
    let result = RepoFocusResult {
        project: landed.project,
        files,
        watch_status,
    };
    Ok(ActionOutput::serialize(result).with_size_hint(size_hint))
}

/// `repo_unfocus` — drop a registry entry from an open project's focus
/// ([`crate::project_manager::ProjectManager::unfocus`]).
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
    let project = tokio::spawn(async move { app.projects.unfocus(&app, &root, &dir).await })
        .await
        .map_err(|e| internal_error_with_source("failed to unfocus repo", &e))?
        .map_err(|e| lifecycle_error("unfocus repo", &e, None))?;
    serde_json::to_value(RepoUnfocusResult { project })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// Close every open project through the same path as `project_close` —
/// restoring the boot-time scope (`zzz_dir` + `scoped_dirs`). Used by the
/// test binary's `_testing_reset`.
///
/// Returns the closed projects.
///
/// # Errors
///
/// A JSON-RPC internal error if a notification fails to serialize; every
/// project is closed regardless.
pub async fn project_close_all(app: &Arc<App>) -> Result<Vec<ProjectInfo>, JsonrpcError> {
    // in its own task, like every other change: a caller dropped mid-close
    // can't leave the projects half released
    let closing = Arc::clone(app);
    tokio::spawn(async move { closing.projects.close_all(&closing).await })
        .await
        .map_err(|e| internal_error_with_source("failed to close projects", &e))?
        .map_err(|e| lifecycle_error("close project", &e, None))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use fuz_repos::registry::ValidRegistry;

    use super::*;
    use crate::filer::FilerDepth;
    use crate::project::{EntryRefusal, ProjectEntry};
    use crate::project_manager::{filers_of, merge_project};

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

    /// The focus of the open project at `root`.
    fn focused_of(app: &App, root: &str) -> Vec<String> {
        app.projects
            .published()
            .projects
            .iter()
            .find(|project| project.root == root)
            .map(|project| project.focused.clone())
            .unwrap()
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
        assert_eq!(app.projects.published().projects.len(), 1);

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

        let closed = app.projects.close(&app, &root).await.unwrap();
        assert_eq!(closed.root, root);
        assert!(matches!(
            app.projects.close(&app, &root).await,
            Err(LifecycleError::NotOpen { .. })
        ));
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
        assert!(app.projects.published().projects.is_empty());
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
        assert!(app.projects.published().projects.is_empty());
        assert!(app.filer_manager.files_for(&tmp.key("w/")).await.is_empty());
        assert!(
            app.scoped_fs
                .open_file(&tmp.key("w/README.md"))
                .await
                .is_err()
        );
    }

    /// `repo_unfocus`'s body, its refusal as the handler maps it.
    async fn unfocus_repo(
        app: &Arc<App>,
        root: &str,
        dir: &str,
    ) -> Result<ProjectInfo, JsonrpcError> {
        app.projects
            .unfocus(app, root, dir)
            .await
            .map_err(|e| lifecycle_error("unfocus repo", &e, None))
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
        assert_eq!(focused_of(&app, &root), std::slice::from_ref(&app_dir));

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
            focused_of(&app, &plain_root),
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
        assert!(focused_of(&app, &root).is_empty());
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

    #[test]
    fn a_focused_repo_that_vanished_is_not_present_and_any_other_dir_is_not_found() {
        let gone = |dir: &str| LifecycleError::Filer {
            dir: dir.to_owned(),
            source: std::io::Error::from(std::io::ErrorKind::NotFound),
        };
        // the directory the focus asked for, whenever its filer fails
        let error = lifecycle_error(FOCUS_REPO, &gone("/w/app/"), Some("/w/app/"));
        assert_eq!(error.code, JsonrpcErrorCode::NotFound);
        assert_eq!(reason(&error), Some(ERROR_REPO_NOT_PRESENT));
        assert!(
            error.message.contains("/w/app/ is gone"),
            "{}",
            error.message
        );
        // another directory of the project, or an open's
        for focusing in [Some("/w/site/"), None] {
            let error = lifecycle_error(FOCUS_REPO, &gone("/w/app/"), focusing);
            assert_eq!(error.code, JsonrpcErrorCode::NotFound);
            assert_eq!(
                reason(&error),
                Some(crate::handlers::filesystem::ERROR_PATH_NOT_FOUND)
            );
        }
    }
}
