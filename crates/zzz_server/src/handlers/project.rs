//! Project handlers — `project_open`, `project_close`, `project_list`,
//! `repo_focus`, `repo_unfocus`, and `repo_files`.
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
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filer::{SnapshotFiles, WatchStatus};
use crate::handlers::filesystem::{ERROR_INVALID_PATH, ERROR_PERMISSION_DENIED};
use crate::handlers::{App, not_found_error};
use crate::project::{
    EntryDir, Fallback, Project, ProjectError, ProjectKind, ResolveOptions, resolve_project,
};
use crate::project_manager::{
    EntryState, FocusRefused, FocusedFiles, LifecycleError, OpenEntry, OpenFallback, OpenKind,
    OpenProject, Opened, ProjectInfo,
};
use crate::repo_status::{PollRefused, RegistrySource, RepoStatusInfo};

/// `project_close` of a root that isn't an open project (`invalid_params`)
/// — e.g. one a restart forgot, which a client can then drop locally.
pub const ERROR_PROJECT_NOT_OPEN: &str = "project_not_open";

/// `repo_focus` / `repo_unfocus` / `project_status` on a project that isn't
/// a registry (`invalid_params`): a checkout's or plain directory's one focus is its
/// root, kept while it's open.
pub const ERROR_PROJECT_NOT_REGISTRY: &str = "project_not_registry";

/// `repo_focus` / `repo_unfocus` of a directory that's none of the project's
/// registry entries (`invalid_params`).
pub const ERROR_REPO_NOT_IN_PROJECT: &str = "repo_not_in_project";

/// `repo_focus` of a registry entry that isn't present as the project last
/// resolved it: not yet cloned (`not_found`) or refused (`forbidden`).
/// Opening a path in it resolves the registry again.
pub const ERROR_REPO_NOT_PRESENT: &str = "repo_not_present";

/// `repo_files` of a directory the open project doesn't focus
/// (`invalid_params`) — named apart from an empty repo, whose files are `[]`
/// too, so a client pulling a focus that's since been dropped can tell.
pub const ERROR_REPO_NOT_FOCUSED: &str = "repo_not_focused";

/// A requested focus of `project_open` that couldn't be indexed otherwise.
///
/// Not its absence or a refused listing: a cause an open later may get
/// past, where every other refusal holds until the disk or the registry
/// changes.
pub const ERROR_REPO_INDEX_FAILED: &str = "repo_index_failed";

// -- Inputs -----------------------------------------------------------------

/// Input for `project_open` — twin of `ProjectOpenInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectOpenInput {
    path: String,
    /// Registry entry dirs to focus once the open lands, beyond the path's
    /// own — a reopen restoring a project's focus in one call.
    #[serde(default)]
    focus: Vec<String>,
}

/// Input for `project_close` — twin of `ProjectCloseInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectCloseInput {
    root: String,
}

/// Input for `repo_focus`, `repo_unfocus`, and `repo_files` — twin of
/// `RepoFocusInput`, `RepoUnfocusInput`, and `RepoFilesInput`. Both are
/// directory keys as the daemon reports them (a project's `root`, an entry's
/// `dir`); a missing trailing `/` is added.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoInput {
    root: String,
    dir: String,
}

/// Input for `project_status`: an open registry project's root, and whether
/// to re-probe every entry now.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectStatusInput {
    root: String,
    #[serde(default)]
    refresh: bool,
}

#[derive(Serialize)]
struct ProjectStatusResult {
    entries: Vec<RepoStatusInfo>,
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
    files: SnapshotFiles,
    /// Whether every indexed directory of the project has a file watch —
    /// `degraded` when the OS watch limit left some to periodic rescans.
    watch_status: WatchStatus,
    /// Each requested focus that didn't land, and why.
    refused: Vec<FocusRefusal>,
    /// Whether this open created the project, rather than merging into one
    /// already open ([`Opened::opened`]).
    opened: bool,
}

#[derive(Serialize)]
struct ProjectCloseResult {
    /// The close's rev — the closed project's last ([`ProjectInfo::rev`]).
    rev: u64,
}

/// A requested focus of a `project_open` that didn't land — twin of
/// `ProjectFocusRefusal`.
#[derive(Serialize)]
struct FocusRefusal {
    dir: String,
    reason: &'static str,
}

#[derive(Serialize)]
struct RepoFocusResult {
    project: ProjectInfo,
    /// The focused repo's index alone — the rest of the project the client
    /// already holds, and its focus changes nothing there.
    files: SnapshotFiles,
    /// Over every indexed directory of the project, as `project_open`'s.
    watch_status: WatchStatus,
}

#[derive(Serialize)]
struct RepoFilesResult {
    /// The focused repo's index.
    files: SnapshotFiles,
    /// Over every indexed directory of the project, as `project_open`'s.
    watch_status: WatchStatus,
    /// The project's rev when the index was read ([`FocusedFiles::rev`]).
    rev: u64,
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
        LifecycleError::NotFocused { .. } => {
            invalid_params(&error.to_string(), Some(ERROR_REPO_NOT_FOCUSED))
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

/// Why a requested focus of an open didn't land, as `refused[].reason`: the
/// code `repo_focus` refuses the same focus with — `repo_not_in_project`,
/// `repo_not_present` (an entry missing or refused as just resolved, or gone
/// since), `project_not_registry`, `permission_denied` — or
/// `repo_index_failed` for a listing that failed otherwise. An entry
/// replaced by a file since is `repo_not_present` too: the filer finds it
/// gone (`NotFound`), as it does for `repo_focus`, unless it can't watch the
/// entry and fails to list it instead (`NotADirectory`) — which `repo_focus`
/// alone answers as an internal error.
fn focus_refusal_reason(error: &LifecycleError) -> &'static str {
    match error {
        LifecycleError::NotRegistry { .. } => ERROR_PROJECT_NOT_REGISTRY,
        LifecycleError::RepoNotInProject { .. } => ERROR_REPO_NOT_IN_PROJECT,
        LifecycleError::RepoMissing { .. } | LifecycleError::RepoRefused { .. } => {
            ERROR_REPO_NOT_PRESENT
        }
        LifecycleError::Filer { source, .. } => match source.kind() {
            std::io::ErrorKind::PermissionDenied => ERROR_PERMISSION_DENIED,
            // gone since, or replaced by a file — nothing a retry fixes
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => {
                ERROR_REPO_NOT_PRESENT
            }
            _ => ERROR_REPO_INDEX_FAILED,
        },
        // never a per-focus outcome — an open refuses no focus for these
        LifecycleError::NotOpen { .. }
        | LifecycleError::NotFocused { .. }
        | LifecycleError::Notify(_) => ERROR_REPO_INDEX_FAILED,
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

/// A resolved project as the manager holds it, focusing `focus` — which,
/// for a checkout or plain directory, is its root.
fn to_open_project(
    project: &Project,
    focus: Option<&str>,
    opened_at: String,
) -> Result<OpenProject, JsonrpcError> {
    let root = to_dir_key(&project.root).ok_or_else(|| non_utf8_error(&project.root))?;
    let name = project
        .root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_owned();
    let kind = match &project.kind {
        ProjectKind::Registry { path, entries } => {
            let registry_path = path.to_str().ok_or_else(|| non_utf8_error(path))?;
            let entries = entries
                .iter()
                .map(|entry| {
                    // the declared path, as `root` spells it, unless present
                    let declared = format!("{root}{}/", entry.entry.dir.trim_end_matches('/'));
                    let (dir, state) = match &entry.dir {
                        EntryDir::Present(dir) => to_dir_key(dir).map_or(
                            (
                                declared,
                                EntryState::Refused {
                                    reason: ERROR_INVALID_PATH,
                                },
                            ),
                            |dir| (dir, EntryState::Present),
                        ),
                        EntryDir::Missing => (declared, EntryState::Missing),
                        EntryDir::Refused(refusal) => (
                            declared,
                            EntryState::Refused {
                                reason: refusal.reason(),
                            },
                        ),
                    };
                    OpenEntry {
                        key: entry.entry.key.clone(),
                        kind: entry.entry.kind,
                        dir,
                        state,
                    }
                })
                .collect();
            OpenKind::Registry {
                registry_path: registry_path.to_owned(),
                entries,
                focused: focus.map(str::to_owned).into_iter().collect(),
            }
        }
        ProjectKind::GitRepo => OpenKind::GitRepo,
        ProjectKind::PlainDir => OpenKind::PlainDir,
    };
    // shown, not acted on: a registry path that isn't UTF-8 is shown lossily
    // rather than failing the open it didn't root
    let fallback = project.fallback.as_ref().map(|fallback| match fallback {
        Fallback::Unregistered { registry } => OpenFallback::Unregistered {
            registry_path: registry.to_string_lossy().into_owned(),
        },
        Fallback::RegistryRefused { registry, reason } => OpenFallback::RegistryRefused {
            registry_path: registry.to_string_lossy().into_owned(),
            reason,
        },
    });
    Ok(OpenProject {
        root,
        name,
        opened_at,
        kind,
        fallback,
        // the commit reads them from the filers
        ignored: BTreeMap::new(),
        rev: 0,
    })
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
    let projects = app
        .projects
        .published()
        .projects
        .iter()
        .map(OpenProject::to_info)
        .collect();
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
/// `focus` names more registry entry dirs to focus once the open lands — a
/// client reopening a project after a daemon restart restores its whole
/// focus in one call. Each is checked against the registry as just resolved
/// (a present entry, as a reopen keeps a focus) and lands or is refused
/// alone, reported in `refused` with the code `repo_focus` would refuse it
/// with (`focus_refusal_reason`): none of the entries
/// (`repo_not_in_project`), missing, refused, or gone since the resolve
/// (`repo_not_present`), not a registry (`project_not_registry` — a
/// checkout's or plain directory's root is its one focus, so a request for
/// it lands), or unlistable (`permission_denied`, `repo_index_failed`). The
/// kind isn't the client's to know before the resolve, so a focus on a
/// project that's no longer a registry is refused per directory rather than
/// failing the open.
///
/// Returns the project (with the rev it last changed at), the directory the
/// opened path focused, the file index of every filer of the project — each
/// requested focus that landed included, read at the project's rev — the
/// refused focuses, and whether this open created the project (`opened`)
/// rather than merging into one already open; on the idempotent path too,
/// so a client re-opening an open project can seed its tree the same way. A
/// registry entry that's refused (escaping the root, protected,
/// unresolvable, not a directory, in a git dir) is reported in the project's
/// entries; the rest of the project still opens. The root or the opened path's focus
/// that can't be listed fails the open (`forbidden` / `permission_denied`),
/// leaving nothing new open.
///
/// # Errors
///
/// [`ProjectError::reason`] as `data.reason` (`open_error`):
/// `invalid_params` for a malformed input, a relative or invalid path, or a
/// registry that can't be read or doesn't parse; `not_found` for a missing
/// path; `forbidden` for a path the OS refuses, a root the root rules refuse
/// (`root_not_allowed`, `root_outside_home`), a protected directory, or an
/// untrusted or unconfined registry; `conflict` for a registry replaced while
/// it was checked — except a refused registry inside a checkout, which the
/// open falls back past to that checkout, reporting it as the project's
/// `fallback` ([`crate::project::Fallback`]); an internal error for an unusable walk bound, a filer
/// that fails otherwise, or a notification that fails to serialize.
pub async fn project_open(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<ActionOutput, JsonrpcError> {
    let ProjectOpenInput {
        path,
        focus: requested,
    } = parse_strict_params(params)?;

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
    let fresh = to_open_project(&project, focus.as_deref(), fuz_sys::rfc3339_now())?;
    // held for its repo status once the open commits
    let registry = match &project.kind {
        ProjectKind::Registry { entries, .. } => Some(RegistrySource::new(&project.root, entries)),
        ProjectKind::GitRepo | ProjectKind::PlainDir => None,
    };

    // Run to completion in its own task, so a caller that goes away mid-open
    // can't leave filers running for a project that never opened.
    tokio::spawn(open_project(app, fresh, focus, requested, registry))
        .await
        .map_err(|e| internal_error_with_source("failed to open project", &e))?
}

/// The body of `project_open` once the path is resolved.
async fn open_project(
    app: Arc<App>,
    fresh: OpenProject,
    focus: Option<String>,
    requested: Vec<String>,
    registry: Option<RegistrySource>,
) -> Result<ActionOutput, JsonrpcError> {
    let Opened {
        landed,
        opened,
        refused,
    } = app
        .projects
        .open_with_registry(&app, fresh, &requested, registry)
        .await
        .map_err(|e| lifecycle_error(OPEN_PROJECT, &e, None))?;
    for FocusRefused { dir, error } in &refused {
        tracing::debug!(
            path = %dir,
            error = %fuz_sys::cli::format_error_chain(error),
            "a requested focus of an open didn't land"
        );
    }
    let refused = refused
        .iter()
        .map(|FocusRefused { dir, error }| FocusRefusal {
            dir: dir.clone(),
            reason: focus_refusal_reason(error),
        })
        .collect::<Vec<_>>();
    let files = SnapshotFiles::new(landed.files);
    let size_hint = files.json_size_hint()
        + PROJECT_OPEN_OVERHEAD
        + refused
            .iter()
            .map(|refusal| refusal.dir.len() + FOCUS_REFUSAL_OVERHEAD)
            .sum::<usize>();
    let result = ProjectOpenResult {
        project: landed.project.to_info(),
        focus,
        files,
        watch_status: landed.watch_status,
        refused,
        opened,
    };
    Ok(ActionOutput::serialize(result).with_size_hint(size_hint))
}

/// The non-file part of a `project_open`, `repo_focus`, or `repo_files`
/// response, budgeted on top of the files' size hint — the registry's entries
/// included.
const PROJECT_OPEN_OVERHEAD: usize = 16 * 1024;

/// A `refused` entry's JSON beyond its dir — the keys, the reason, the
/// punctuation — budgeted per entry, since a request may ask for any number.
const FOCUS_REFUSAL_OVERHEAD: usize = 64;

/// What fails when an open's filer can't start ([`filer_error`]).
const OPEN_PROJECT: &str = "open project";

/// What fails when a focus's filer can't start ([`filer_error`]).
const FOCUS_REPO: &str = "focus repo";

/// `project_close` — close an open project
/// ([`crate::project_manager::ProjectManager::close`]), returning the
/// close's rev, which a client keeps so no older reply or notification adds
/// the project back.
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
    let closed = tokio::spawn(async move { app.projects.close(&app, &root).await })
        .await
        .map_err(|e| internal_error_with_source("failed to close project", &e))?
        .map_err(|e| lifecycle_error("close project", &e, None))?;
    serde_json::to_value(ProjectCloseResult { rev: closed.rev })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
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
/// repo changes and broadcasts nothing. Returns the project and the focused
/// repo's index alone: the client holds the rest of the project already.
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
    let files = SnapshotFiles::new(landed.files);
    let size_hint = files.json_size_hint() + PROJECT_OPEN_OVERHEAD;
    let result = RepoFocusResult {
        project: landed.project.to_info(),
        files,
        watch_status: landed.watch_status,
    };
    Ok(ActionOutput::serialize(result).with_size_hint(size_hint))
}

/// `repo_files` — the index of a focused repo of an open project.
///
/// What a client that learned of another client's focus from
/// `project_changed`, which carries no files, pulls instead of a whole
/// session snapshot.
///
/// `dir` must be one of the focused directories of the open project at
/// `root` — a registry's focused entry, or a checkout's or plain directory's
/// root. The check and the read happen under the projects' lock
/// ([`crate::project_manager::ProjectManager::focused_files`]), so the reply
/// is the index as one state holds it, never a filer a commit has stopped or
/// narrowed but not yet published — and carries that state's rev, so a
/// client holding a later focus of the repo can drop a read of an earlier
/// one. A focus already dropped is refused rather
/// than answered with no files, which an empty repo would read as; the
/// `project_changed` that dropped it says what changed.
///
/// # Errors
///
/// `invalid_params` for a malformed input, a root that names no open project
/// (`project_not_open`), or a directory the project doesn't focus
/// (`repo_not_focused`).
pub async fn repo_files(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<ActionOutput, JsonrpcError> {
    let RepoInput { root, dir } = parse_strict_params(params)?;
    let (root, dir) = (with_trailing_slash(root), with_trailing_slash(dir));
    read_repo_files(&app, &root, &dir).await
}

/// The body of `repo_files`.
async fn read_repo_files(app: &App, root: &str, dir: &str) -> Result<ActionOutput, JsonrpcError> {
    let FocusedFiles {
        files,
        watch_status,
        rev,
    } = app
        .projects
        .focused_files(app, root, dir)
        .await
        .map_err(|e| lifecycle_error("read repo files", &e, None))?;
    let files = SnapshotFiles::new(files);
    let size_hint = files.json_size_hint() + PROJECT_OPEN_OVERHEAD;
    Ok(ActionOutput::serialize(RepoFilesResult {
        files,
        watch_status,
        rev,
    })
    .with_size_hint(size_hint))
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
    serde_json::to_value(RepoUnfocusResult {
        project: project.to_info(),
    })
    .map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `project_status` — every entry's tier-1 git status for the open registry
/// project at `root` ([`crate::repo_status`]).
///
/// What's known now, with the probes of the stale entries started, never
/// awaited. Refused entries are left out; missing ones say so.
///
/// Read-only: `git status` runs with optional locks off, so it never writes
/// the index.
///
/// # Errors
///
/// `invalid_params` for a malformed input, a root that names no open project
/// (`project_not_open`), or one that isn't a registry
/// (`project_not_registry`).
pub async fn project_status(
    params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let ProjectStatusInput { root, refresh } = parse_strict_params(params)?;
    let root = with_trailing_slash(root);
    let published = app.projects.published();
    // refused without forgetting: an open of the root in flight may have
    // just set what the status reads (`ProjectManager::open_with_registry`)
    let Some(project) = published.projects.iter().find(|p| p.root == root) else {
        return Err(invalid_params(
            &format!("no open project at {root}"),
            Some(ERROR_PROJECT_NOT_OPEN),
        ));
    };
    if !matches!(project.kind, OpenKind::Registry { .. }) {
        return Err(invalid_params(
            &format!("{root} isn't a registry project"),
            Some(ERROR_PROJECT_NOT_REGISTRY),
        ));
    }
    let entries = app
        .repo_status
        .poll(&app.git, &root, refresh)
        .await
        .map_err(|PollRefused::Unknown| {
            invalid_params(
                &format!("no status is held for {root}"),
                Some(ERROR_PROJECT_NOT_OPEN),
            )
        })?;
    serde_json::to_value(ProjectStatusResult { entries })
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
pub async fn project_close_all(app: &Arc<App>) -> Result<Vec<OpenProject>, JsonrpcError> {
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

    use fuz_repos::registry::{EntryKind, ValidRegistry};

    use super::*;
    use crate::filer::FilerDepth;
    use crate::project::{EntryRefusal, ProjectEntry};
    use crate::project_manager::{filers_of, merge_project};
    use crate::root_policy::{ERROR_ROOT_NOT_ALLOWED, ERROR_ROOT_OUTSIDE_HOME};

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
            fallback: None,
        }
    }

    fn plain_project(kind: ProjectKind) -> Project {
        Project {
            root: PathBuf::from("/p"),
            opened: PathBuf::from("/p/sub"),
            kind,
            fallback: None,
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
        let info = to_open_project(&project, Some("/w/app/"), "t".to_owned()).unwrap();
        assert_eq!(
            serde_json::to_value(info.to_info()).unwrap(),
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
                "fallback": null,
                "focused": ["/w/app/"],
                "ignored": {},
                "rev": 0,
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
    fn a_fallback_projects_the_registry_passed_over() {
        let project = Project {
            fallback: Some(Fallback::RegistryRefused {
                registry: PathBuf::from("/w/repos.toml"),
                reason: "registry_untrusted",
            }),
            ..plain_project(ProjectKind::GitRepo)
        };
        let info = to_open_project(&project, Some("/p/"), "t".to_owned()).unwrap();
        assert_eq!(
            serde_json::to_value(info.to_info()).unwrap()["fallback"],
            serde_json::json!({
                "kind": "registry_refused",
                "registry_path": "/w/repos.toml",
                "reason": "registry_untrusted",
            })
        );
        let project = Project {
            fallback: Some(Fallback::Unregistered {
                registry: PathBuf::from("/w/repos.toml"),
            }),
            ..plain_project(ProjectKind::PlainDir)
        };
        let info = to_open_project(&project, Some("/p/"), "t".to_owned()).unwrap();
        assert_eq!(
            info.fallback,
            Some(OpenFallback::Unregistered {
                registry_path: "/w/repos.toml".to_owned()
            })
        );
    }

    #[test]
    fn a_present_entry_reports_where_it_resolves() {
        // a symlinked entry dir resolves elsewhere inside the root
        let project = registry_project("/w", "/w/real/app");
        let info = to_open_project(&project, None, "t".to_owned()).unwrap();
        assert_eq!(info.to_info().entries[0].dir, "/w/real/app/");
        assert!(info.focused().is_empty());
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
            let info = to_open_project(&plain_project(kind), Some("/p/"), "t".to_owned()).unwrap();
            let value = serde_json::to_value(info.to_info()).unwrap();
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
        let first = to_open_project(
            &registry_project("/w/app", "/w/app"),
            Some("/w/app/"),
            "first".to_owned(),
        )
        .unwrap();
        let mut second = to_open_project(
            &registry_project("/w/site", "/w/app"),
            Some("/w/site/"),
            "second".to_owned(),
        )
        .unwrap();
        entries_mut(&mut second)[1].state = EntryState::Present;
        let mut merged = merge_project(&first, &second);
        assert_eq!(merged.focused(), ["/w/app/", "/w/site/"]);
        assert_eq!(merged.opened_at, "first");
        assert_eq!(entries_mut(&mut merged)[1].state, EntryState::Present);
        assert_ne!(merged, first);
        // the same open again changes nothing
        assert_eq!(merge_project(&merged, &second), merged);
        // an open resolving the entries afresh reports them, and a focus on an
        // entry gone missing is dropped
        let site_gone = merge_project(&merged, &first);
        assert_ne!(site_gone, merged);
        assert_eq!(site_gone.focused(), ["/w/app/"]);

        // a plain dir focused on its root, then a registry there: the old
        // focus goes with the kind that supported it
        let plain = to_open_project(
            &Project {
                root: PathBuf::from("/w"),
                opened: PathBuf::from("/w"),
                kind: ProjectKind::PlainDir,
                fallback: None,
            },
            Some("/w/"),
            "plain".to_owned(),
        )
        .unwrap();
        let registry = merge_project(&plain, &first);
        assert_eq!(registry.focused(), ["/w/app/"]);
        assert_eq!(
            filers_of(&registry).into_iter().collect::<Vec<_>>(),
            [
                ("/w/".to_owned(), FilerDepth::TopLevel),
                ("/w/app/".to_owned(), FilerDepth::Tree),
            ]
        );
        // and back: a registry's focus goes when the root is a plain dir again
        assert_eq!(merge_project(&registry, &plain).focused(), ["/w/"]);
    }

    /// The entries of a registry project.
    fn entries_mut(project: &mut OpenProject) -> &mut Vec<OpenEntry> {
        match &mut project.kind {
            OpenKind::Registry { entries, .. } => entries,
            OpenKind::GitRepo | OpenKind::PlainDir => panic!("not a registry"),
        }
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
            Arc::new(fuz_auth::AuditEmitter::new(pool, Arc::default())),
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
    fn registry_info(tmp: &TempDir, focus: &[&str]) -> OpenProject {
        let entry = |key: &str| OpenEntry {
            key: key.to_owned(),
            kind: EntryKind::Repo,
            dir: tmp.key(&format!("w/{key}/")),
            state: EntryState::Present,
        };
        OpenProject {
            root: tmp.key("w/"),
            name: "w".to_owned(),
            opened_at: "t".to_owned(),
            kind: OpenKind::Registry {
                registry_path: tmp.key("w/repos.toml"),
                entries: vec![entry("app"), entry("site")],
                focused: focus
                    .iter()
                    .map(|key| tmp.key(&format!("w/{key}/")))
                    .collect(),
            },
            rev: 0,
            fallback: None,
            ignored: BTreeMap::new(),
        }
    }

    /// The focus of the open project at `root`.
    fn focused_of(app: &App, root: &str) -> Vec<String> {
        app.projects
            .published()
            .projects
            .iter()
            .find(|project| project.root == root)
            .map(|project| project.focused().into_iter().map(str::to_owned).collect())
            .unwrap()
    }

    /// `open_project`'s result as JSON.
    async fn open(app: &Arc<App>, info: OpenProject, focus: Option<String>) -> Value {
        open_requesting(app, info, focus, &[]).await
    }

    /// `open_project`'s result as JSON, `requested` focused besides `focus`.
    async fn open_requesting(
        app: &Arc<App>,
        info: OpenProject,
        focus: Option<String>,
        requested: &[String],
    ) -> Value {
        let output = open_project(Arc::clone(app), info, focus, requested.to_vec(), None)
            .await
            .unwrap();
        let mut out = Vec::new();
        output.write_json(&mut out).unwrap();
        serde_json::from_slice(&out).unwrap()
    }

    /// The paths of a result's files, each its group's dir plus its relative
    /// path ([`SnapshotFiles`]).
    fn file_ids(result: &Value) -> Vec<String> {
        result["files"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|group| {
                let dir = group["dir"].as_str().unwrap();
                group["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(move |file| format!("{dir}{}", file[0].as_str().unwrap()))
            })
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
        let mut nested = to_open_project(
            &Project {
                root: PathBuf::from(tmp.key("w/app")),
                opened: PathBuf::from(tmp.key("w/app")),
                kind: ProjectKind::PlainDir,
                fallback: None,
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

        let before = app.projects.published().rev;
        let closed = project_close_all(&app).await.unwrap();
        assert_eq!(closed.len(), 1);
        // each closed project carries the close's rev, as its broadcast does
        assert!(closed[0].rev > before);
        assert_eq!(closed[0].rev, app.projects.published().rev);
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
        let plain = to_open_project(
            &Project {
                root: PathBuf::from(tmp.key("w")),
                opened: PathBuf::from(tmp.key("w")),
                kind: ProjectKind::PlainDir,
                fallback: None,
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
    async fn an_open_reports_each_requested_focus_that_didnt_land_with_its_reason() {
        let tmp = TempDir::new();
        for rel in ["w/README.md", "w/app/a.txt", "w/site/s.txt"] {
            tmp.write(rel);
        }
        let app = inert_app();
        let (app_dir, site_dir) = (tmp.key("w/app/"), tmp.key("w/site/"));
        let mut info = registry_info(&tmp, &[]);
        let OpenKind::Registry { entries, .. } = &mut info.kind else {
            unreachable!()
        };
        entries.push(OpenEntry {
            key: "keys".to_owned(),
            kind: EntryKind::Reference,
            dir: tmp.key("w/keys/"),
            state: EntryState::Refused {
                reason: "entry_not_confined",
            },
        });
        entries.push(OpenEntry {
            key: "gone".to_owned(),
            kind: EntryKind::Repo,
            dir: tmp.key("w/gone/"),
            state: EntryState::Present,
        });
        let result = open_requesting(
            &app,
            info,
            None,
            &[
                app_dir.clone(),
                tmp.key("w/keys/"),
                tmp.key("w/scratch/"),
                tmp.key("w/gone/"),
                site_dir.clone(),
            ],
        )
        .await;
        assert_eq!(result["focus"], Value::Null);
        assert_eq!(
            result["project"]["focused"],
            serde_json::json!([app_dir, site_dir])
        );
        assert_eq!(
            result["refused"],
            serde_json::json!([
                {"dir": tmp.key("w/keys/"), "reason": ERROR_REPO_NOT_PRESENT},
                {"dir": tmp.key("w/scratch/"), "reason": ERROR_REPO_NOT_IN_PROJECT},
                {"dir": tmp.key("w/gone/"), "reason": ERROR_REPO_NOT_PRESENT},
            ])
        );
        // the files of every focus that landed
        assert_eq!(
            file_ids(&result),
            [
                tmp.key("w/README.md"),
                tmp.key("w/app/a.txt"),
                tmp.key("w/site/s.txt")
            ]
        );
        // an open asking for nothing refuses nothing
        let again = open(&app, registry_info(&tmp, &[]), None).await;
        assert_eq!(again["refused"], serde_json::json!([]));
    }

    #[test]
    fn a_focus_refusal_takes_the_code_repo_focus_would_refuse_with() {
        let filer = |kind: std::io::ErrorKind| LifecycleError::Filer {
            dir: "/w/a/".to_owned(),
            source: std::io::Error::from(kind),
        };
        let cases = [
            (
                LifecycleError::NotRegistry {
                    root: "/p/".to_owned(),
                },
                ERROR_PROJECT_NOT_REGISTRY,
            ),
            (
                LifecycleError::RepoNotInProject {
                    root: "/w/".to_owned(),
                    dir: "/w/x/".to_owned(),
                },
                ERROR_REPO_NOT_IN_PROJECT,
            ),
            (
                LifecycleError::RepoMissing {
                    key: "a".to_owned(),
                    dir: "/w/a/".to_owned(),
                },
                ERROR_REPO_NOT_PRESENT,
            ),
            (
                LifecycleError::RepoRefused {
                    key: "a".to_owned(),
                    dir: "/w/a/".to_owned(),
                    reason: "entry_not_confined",
                },
                ERROR_REPO_NOT_PRESENT,
            ),
            (
                filer(std::io::ErrorKind::PermissionDenied),
                ERROR_PERMISSION_DENIED,
            ),
            (filer(std::io::ErrorKind::NotFound), ERROR_REPO_NOT_PRESENT),
            (
                filer(std::io::ErrorKind::NotADirectory),
                ERROR_REPO_NOT_PRESENT,
            ),
            (filer(std::io::ErrorKind::Other), ERROR_REPO_INDEX_FAILED),
        ];
        for (error, reason) in cases {
            assert_eq!(focus_refusal_reason(&error), reason, "{error:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_open_whose_focus_cant_be_indexed_leaves_nothing_new_open() {
        let tmp = TempDir::new();
        tmp.write("w/README.md");
        let app = inert_app();
        // `site` is gone by the time its filer starts
        let info = registry_info(&tmp, &["site"]);
        let error = open_project(
            Arc::clone(&app),
            info,
            Some(tmp.key("w/site/")),
            vec![],
            None,
        )
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
    ) -> Result<OpenProject, JsonrpcError> {
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
            [tmp.key("w/app/a.txt"), tmp.key("w/app/src/b.txt")],
            "the focused repo alone — not the root's loose files, which the client holds, nor the unfocused `site`"
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
        assert!(project.focused().is_empty(), "a registry may keep no focus");
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
                .focused()
                .is_empty()
        );
        assert!(project_changes(&mut rx).is_empty());
    }

    /// `read_repo_files`' result as JSON.
    async fn repo_files_of(app: &Arc<App>, root: &str, dir: &str) -> Result<Value, JsonrpcError> {
        let output = read_repo_files(app, root, dir).await?;
        let mut out = Vec::new();
        output.write_json(&mut out).unwrap();
        Ok(serde_json::from_slice(&out).unwrap())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repo_files_reads_a_focused_repo_and_refuses_anything_else() {
        let tmp = TempDir::new();
        for rel in [
            "w/README.md",
            "w/app/a.txt",
            "w/app/src/b.txt",
            "w/site/s.txt",
            "p/x.txt",
        ] {
            tmp.write(rel);
        }
        let app = inert_app();
        let root = tmp.key("w/");
        let app_dir = tmp.key("w/app/");
        let site_dir = tmp.key("w/site/");
        open(&app, registry_info(&tmp, &["app"]), Some(app_dir.clone())).await;
        let plain_root = tmp.key("p/");
        let plain = to_open_project(
            &Project {
                root: PathBuf::from(tmp.key("p")),
                opened: PathBuf::from(tmp.key("p")),
                kind: ProjectKind::PlainDir,
                fallback: None,
            },
            Some(&plain_root),
            "t".to_owned(),
        )
        .unwrap();
        open(&app, plain, Some(plain_root.clone())).await;

        let files = repo_files_of(&app, &root, &app_dir).await.unwrap();
        assert_eq!(
            file_ids(&files),
            [tmp.key("w/app/a.txt"), tmp.key("w/app/src/b.txt")],
            "the repo alone, not the root's loose files"
        );
        assert_eq!(files["watch_status"], "full");
        // a checkout's or plain directory's root is its one focus
        let files = repo_files_of(&app, &plain_root, &plain_root).await.unwrap();
        assert_eq!(file_ids(&files), [tmp.key("p/x.txt")]);

        let refused = |root: String, dir: String, expected: &'static str| {
            let app = Arc::clone(&app);
            async move {
                let error = repo_files_of(&app, &root, &dir).await.unwrap_err();
                assert_eq!(error.code, JsonrpcErrorCode::InvalidParams, "{root} {dir}");
                assert_eq!(reason(&error), Some(expected), "{root} {dir}");
            }
        };
        // a present entry that isn't focused, which would otherwise read as empty
        refused(root.clone(), site_dir.clone(), ERROR_REPO_NOT_FOCUSED).await;
        // the registry's root, indexed at its top level alone
        refused(root.clone(), root.clone(), ERROR_REPO_NOT_FOCUSED).await;
        // a dir another open project focuses, asked of a project that doesn't
        refused(root.clone(), plain_root.clone(), ERROR_REPO_NOT_FOCUSED).await;
        refused(tmp.key("none/"), app_dir.clone(), ERROR_PROJECT_NOT_OPEN).await;

        // unfocused, the repo is refused even though a nested project keeps
        // its directory at the top level
        let mut nested = registry_info(&tmp, &[]);
        nested.root.clone_from(&app_dir);
        entries_mut(&mut nested).clear();
        open(&app, nested, None).await;
        unfocus_repo(&app, &root, &app_dir).await.unwrap();
        assert_eq!(
            app.filer_manager.files_for(&app_dir).await.len(),
            1,
            "narrowed"
        );
        refused(root.clone(), app_dir.clone(), ERROR_REPO_NOT_FOCUSED).await;
        refused(app_dir.clone(), app_dir.clone(), ERROR_REPO_NOT_FOCUSED).await;

        // closed, its root names no open project
        app.projects.close(&app, &plain_root).await.unwrap();
        refused(
            plain_root.clone(),
            plain_root.clone(),
            ERROR_PROJECT_NOT_OPEN,
        )
        .await;
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
        let plain = to_open_project(
            &Project {
                root: PathBuf::from(tmp.key("w/app")),
                opened: PathBuf::from(tmp.key("w/app")),
                kind: ProjectKind::PlainDir,
                fallback: None,
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
        entries_mut(&mut nested).clear();
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
        entries_mut(&mut info)[1].state = EntryState::Missing;
        entries_mut(&mut info).push(OpenEntry {
            key: "keys".to_owned(),
            kind: EntryKind::Reference,
            dir: tmp.key("w/keys/"),
            state: EntryState::Refused {
                reason: "entry_not_confined",
            },
        });
        open(&app, info, None).await;
        let plain_root = tmp.key("p/");
        let plain = to_open_project(
            &Project {
                root: PathBuf::from(tmp.key("p")),
                opened: PathBuf::from(tmp.key("p")),
                kind: ProjectKind::PlainDir,
                fallback: None,
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
