//! Core handlers — `ping` (public health check) and `session_load`
//! (authenticated initial-state load).
//!
//! Spine-backed signature: `(Value, ActionContext<'_>, Arc<App>) ->
//! Result<Value, JsonrpcError>` — `Result<ActionOutput, JsonrpcError>` for
//! `session_load`, whose large output is serialized once by the transport.
//! `ping` is public (no auth); `session_load` is authenticated and returns the
//! session snapshot (open projects, the file trees and their roots,
//! `scoped_dirs`, the daemon's home, provider status, the caller's terminals
//! and jobs, and the server instance id) — loaded at boot and again after every reconnect to resync.

use std::path::Path;
use std::sync::Arc;

use fuz_actions::{ActionContext, ActionOutput};
use fuz_http::{JsonrpcError, internal_error_with_source, invalid_params, parse_strict_params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filer::{FilerSnapshot, SnapshotFiles};
use crate::handlers::{App, caller_account_id};
use crate::job_manager::JobSnapshot;
use crate::project_manager::{OpenProject, ProjectInfo};

#[derive(Serialize)]
struct PingResult {
    ping_id: Value,
}

/// Input for `_testing_emit_notifications` — twin of
/// `TestingEmitNotificationsInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestingEmitNotificationsInput {
    #[serde(deserialize_with = "fuz_http::deserialize_wire_int")]
    count: u64,
}

#[derive(Serialize)]
struct TestingEmitNotificationsResult {
    count: u64,
}

/// Twin of `SessionLoadData` in `action_specs.ts`.
#[derive(Serialize)]
struct SessionLoadData {
    /// Every indexed file's metadata, grouped by filer dir ([`SnapshotFiles`]).
    files: SnapshotFiles,
    /// The filer roots `files` covers, so a client can drop the files it has
    /// under them that `files` lacks.
    file_roots: Vec<String>,
    zzz_dir: String,
    scoped_dirs: Vec<String>,
    /// The daemon's home directory (canonical, trailing `/`), which a `~`
    /// in a path the client is given expands to; `None` when the daemon
    /// has none it can use.
    home_dir: Option<String>,
    provider_status: Vec<Value>,
    projects: Vec<ProjectInfo>,
    /// The project manager's rev when `projects` was read: every project
    /// change up to it is in them, and none after — so a client can drop a
    /// project the snapshot doesn't list only when what it holds of it is no
    /// newer. `files` are read after it, outside the lock: a change committed
    /// between can show in them, and on a socket its `project_changed`
    /// arrives before this reply.
    projects_rev: u64,
    /// The caller's live terminals.
    terminal_ids: Vec<String>,
    /// The caller's jobs, oldest first.
    jobs: Vec<JobSnapshot>,
    server_instance_id: String,
}

/// The non-file part of a `session_load` response, budgeted on top of the
/// files' size hint (roots, dirs, projects, provider status, terminal ids).
const SESSION_LOAD_OVERHEAD: usize = 4096;

#[derive(Serialize)]
struct SessionLoadResult {
    data: SessionLoadData,
}

/// `ping` — public health check. Echoes the request id back as `ping_id`.
/// Takes no input (a void schema): the spec declares `InputShape::Void`, so the
/// dispatcher refuses any declared key before this runs.
///
/// `ActionContext.request_id` carries the parsed envelope's id.
///
/// # Errors
///
/// An internal error if the result fails to serialize.
#[expect(
    clippy::unused_async,
    reason = "kept `async` like every other handler, whose spec builder awaits it"
)]
pub async fn ping(
    _params: Value,
    ctx: ActionContext<'_>,
    _app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let result = PingResult {
        ping_id: ctx.request_id.clone(),
    };
    serde_json::to_value(result).map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `session_load` — authenticated initial-state load. Takes no input
/// (a void schema): the spec declares `InputShape::Void`, so the dispatcher
/// refuses any declared key before this runs.
///
/// Returns the cross-domain snapshot the frontend loads at boot and reloads
/// after a reconnect: open projects, the file tree of every permanent filer
/// and every one those projects keep (rescanned for consistency) with its
/// root, `scoped_dirs`, provider status, the caller's
/// live terminal ids, and `App::instance_id`.
///
/// The response carries every indexed file's metadata — not its contents,
/// which a client reads with `diskfile_read` — and a large tree makes it
/// large, so it's handed to the transport to serialize once, with no
/// intermediate `Value` copy.
///
/// # Errors
///
/// `unauthenticated` when the request carries no account.
pub async fn session_load(
    _params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<ActionOutput, JsonrpcError> {
    let owner = caller_account_id(&ctx)?;
    // the projects and the filers they keep, as one commit left them: a
    // filer an open or focus in flight started isn't listed before its
    // project's change is
    let published = app.projects.published();
    let projects: Vec<ProjectInfo> = published
        .projects
        .iter()
        .map(OpenProject::to_info)
        .collect();

    // Rescan each watched directory before reading the index — notify events
    // are eventually consistent, so a file written immediately before
    // session_load may not yet be in the in-memory index. A fresh walk
    // guarantees a consistent snapshot and removes a flaky race in integration
    // tests (`session_load_returns_nested_files`) where the filer event loop
    // hadn't yet drained the inotify event. The rescan runs on each filer's
    // event loop and any differences it finds are broadcast as `filer_change`
    // to every connection, like any other change; concurrent session_loads
    // share one rescan per filer.
    app.filer_manager.rescan_all().await;
    let FilerSnapshot { roots, files } = app.filer_manager.snapshot(&published.filers).await;
    let terminal_ids = app.pty_manager.terminal_ids_for_account(owner).await;
    let jobs = app.job_manager.jobs_for_account(owner);

    let mut provider_status = Vec::new();
    for p in app.provider_manager.all() {
        let status = p.load_status(false).await;
        if let Ok(v) = serde_json::to_value(&status) {
            provider_status.push(v);
        }
    }

    let files = SnapshotFiles::new(files);
    let size_hint = files.json_size_hint() + SESSION_LOAD_OVERHEAD;
    let result = SessionLoadResult {
        data: SessionLoadData {
            files,
            file_roots: roots,
            zzz_dir: app.zzz_dir.clone(),
            scoped_dirs: app.scoped_dirs.clone(),
            home_dir: app
                .root_policy
                .home()
                .and_then(Path::to_str)
                .map(|home| format!("{}/", home.trim_end_matches('/'))),
            provider_status,
            projects,
            projects_rev: published.rev,
            terminal_ids,
            jobs,
            server_instance_id: app.instance_id.to_string(),
        },
    };
    Ok(ActionOutput::serialize(result).with_size_hint(size_hint))
}

/// `_testing_emit_notifications` — test-only action used by the integration
/// suite to verify `ctx.notify` socket-scoped routing without a real AI
/// provider.
///
/// Emits `count` `_testing_notification` frames through `ctx.notify`, then
/// returns `{count}`. Gated at registry-compile time by
/// `App.enable_test_actions` (`ZZZ_ENABLE_TEST_ACTIONS=1`).
///
/// # Errors
///
/// `invalid_params` for a malformed input or a `count` above 100; an internal
/// error if the result fails to serialize.
#[expect(
    clippy::unused_async,
    reason = "kept `async` like every other handler, whose spec builder awaits it"
)]
pub async fn testing_emit_notifications(
    params: Value,
    ctx: ActionContext<'_>,
    _app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let TestingEmitNotificationsInput { count } = parse_strict_params(params)?;
    if count > 100 {
        return Err(invalid_params("count must be <= 100", None));
    }
    for i in 0..count {
        (ctx.notify)("_testing_notification", &serde_json::json!({"index": i}));
    }
    serde_json::to_value(TestingEmitNotificationsResult { count })
        .map_err(|e| internal_error_with_source("serialization failed", &e))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::filer::SerializableDisknode;

    /// A `session_load` result, serialized straight from the structs, has the
    /// shape `SessionLoadData` declares — its files' metadata, no contents.
    #[test]
    fn session_load_result_serializes_to_its_wire_shape() {
        let result = SessionLoadResult {
            data: SessionLoadData {
                files: SnapshotFiles::new(vec![SerializableDisknode::for_test(
                    "/w/a.txt",
                    Some(1),
                    Some(1_500),
                )]),
                file_roots: vec!["/s/".to_owned()],
                zzz_dir: "/z".to_owned(),
                scoped_dirs: vec!["/s".to_owned()],
                home_dir: Some("/h/".to_owned()),
                provider_status: vec![json!({"name": "claude", "available": false})],
                projects: vec![
                    OpenProject {
                        root: "/w/".to_owned(),
                        name: "w".to_owned(),
                        opened_at: "2026-01-01T00:00:00Z".to_owned(),
                        kind: crate::project_manager::OpenKind::PlainDir,
                        fallback: Some(crate::project_manager::OpenFallback::RegistryRefused {
                            registry_path: "/w/repos.toml".to_owned(),
                            reason: "registry_invalid",
                        }),
                        ignored: std::collections::BTreeMap::from([(
                            "/w/".to_owned(),
                            crate::filer::IgnoredPaths {
                                paths: Arc::new(vec!["build/".to_owned(), "a.log".to_owned()]),
                                nested: Arc::new(vec!["vendor/lib/".to_owned()]),
                                resyncs: 2,
                            },
                        )]),
                        rev: 7,
                    }
                    .to_info(),
                ],
                projects_rev: 9,
                terminal_ids: vec!["t1".to_owned()],
                jobs: vec![],
                server_instance_id: "00000000-0000-4000-8000-000000000000".to_owned(),
            },
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({"data": {
                "files": [{"dir": "/w/", "files": [["a.txt", 1, 1_500]]}],
                "file_roots": ["/s/"],
                "zzz_dir": "/z",
                "scoped_dirs": ["/s"],
                "home_dir": "/h/",
                "provider_status": [{"name": "claude", "available": false}],
                "projects": [{
                    "root": "/w/",
                    "name": "w",
                    "opened_at": "2026-01-01T00:00:00Z",
                    "kind": "plain_dir",
                    "registry_path": null,
                    "entries": [],
                    "fallback": {
                        "kind": "registry_refused",
                        "registry_path": "/w/repos.toml",
                        "reason": "registry_invalid",
                    },
                    "focused": ["/w/"],
                    "ignored": {"/w/": {
                        "paths": ["build/", "a.log"],
                        "nested": ["vendor/lib/"],
                        "resyncs": 2,
                    }},
                    "rev": 7,
                }],
                "projects_rev": 9,
                "terminal_ids": ["t1"],
                "jobs": [],
                "server_instance_id": "00000000-0000-4000-8000-000000000000",
            }})
        );
    }
}
