//! Core handlers — `ping` (public health check) and `session_load`
//! (authenticated initial-state load).
//!
//! Spine-backed signature: `(Value, ActionContext<'_>, Arc<App>) ->
//! Result<Value, JsonrpcError>` — `Result<ActionOutput, JsonrpcError>` for
//! `session_load`, whose large output is serialized once by the transport.
//! `ping` is public (no auth); `session_load` is authenticated and returns the
//! session snapshot (open workspaces, the file trees and their roots,
//! `scoped_dirs`, provider status, the caller's terminals and jobs, and the
//! server instance id) — loaded at boot and again after every reconnect to resync.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionOutput};
use fuz_auth::require_void_params;
use fuz_http::{JsonrpcError, internal_error_with_source, invalid_params, parse_strict_params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filer::{FilerSnapshot, SerializableDisknode, disknodes_json_size_hint};
use crate::handlers::{App, WorkspaceInfo, caller_account_id};
use crate::job_manager::JobSnapshot;

#[derive(Serialize)]
struct PingResult {
    ping_id: Value,
}

/// Input for `_testing_emit_notifications` — twin of
/// `TestingEmitNotificationsInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestingEmitNotificationsInput {
    count: u64,
}

#[derive(Serialize)]
struct TestingEmitNotificationsResult {
    count: u64,
}

/// Twin of `SessionLoadData` in `action_specs.ts`.
#[derive(Serialize)]
struct SessionLoadData {
    files: Vec<SerializableDisknode>,
    /// The filer roots `files` covers, so a client can drop the files it has
    /// under them that `files` lacks.
    file_roots: Vec<String>,
    zzz_dir: String,
    scoped_dirs: Vec<String>,
    provider_status: Vec<Value>,
    workspaces: Vec<WorkspaceInfo>,
    /// The caller's live terminals.
    terminal_ids: Vec<String>,
    /// The caller's jobs, oldest first.
    jobs: Vec<JobSnapshot>,
    server_instance_id: String,
}

/// The non-file part of a `session_load` response, budgeted on top of the
/// files' size hint (roots, dirs, workspaces, provider status, terminal ids).
const SESSION_LOAD_OVERHEAD: usize = 4096;

#[derive(Serialize)]
struct SessionLoadResult {
    data: SessionLoadData,
}

/// `ping` — public health check. Echoes the request id back as `ping_id`.
/// Takes no input (`z.void()`): an absent `params` or a `{}` is the call, and
/// any declared key is refused.
///
/// `ActionContext.request_id` carries the parsed envelope's id.
#[allow(
    clippy::unused_async,
    reason = "ActionHandler signature requires async"
)]
pub async fn ping(
    params: Value,
    ctx: ActionContext<'_>,
    _app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    require_void_params(&params)?;
    let result = PingResult {
        ping_id: ctx.request_id.clone(),
    };
    serde_json::to_value(result).map_err(|e| internal_error_with_source("serialization failed", &e))
}

/// `session_load` — authenticated initial-state load. Takes no input
/// (`z.void()`): an absent `params` or a `{}` is the call, and any declared key
/// is refused.
///
/// Returns the cross-domain snapshot the frontend loads at boot and reloads
/// after a reconnect: open workspaces, every filer's file tree (rescanned for
/// consistency) with its roots, `scoped_dirs`, provider status, the caller's
/// live terminal ids, and `App::instance_id`.
///
/// The response carries every indexed file's contents, so it's handed to the
/// transport to serialize once: the snapshot shares the index's contents, and
/// no intermediate `Value` copy is made.
pub async fn session_load(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<ActionOutput, JsonrpcError> {
    require_void_params(&params)?;
    let owner = caller_account_id(&ctx)?;
    let workspaces: Vec<WorkspaceInfo> = {
        let ws = app.workspaces.read();
        ws.values().cloned().collect()
    };

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
    let FilerSnapshot { roots, files } = app.filer_manager.snapshot().await;
    let terminal_ids = app.pty_manager.terminal_ids_for_account(owner).await;
    let jobs = app.job_manager.jobs_for_account(owner);

    let mut provider_status = Vec::new();
    for p in app.provider_manager.all() {
        let status = p.load_status(false).await;
        if let Ok(v) = serde_json::to_value(&status) {
            provider_status.push(v);
        }
    }

    let size_hint = disknodes_json_size_hint(&files) + SESSION_LOAD_OVERHEAD;
    let result = SessionLoadResult {
        data: SessionLoadData {
            files,
            file_roots: roots,
            zzz_dir: app.zzz_dir.clone(),
            scoped_dirs: app.scoped_dirs.clone(),
            provider_status,
            workspaces,
            terminal_ids,
            jobs,
            server_instance_id: app.instance_id.to_string(),
        },
    };
    Ok(ActionOutput::serialize(result).with_size_hint(size_hint))
}

/// `_testing_emit_notifications` — test-only action used by the integration
/// suite to verify `ctx.notify` socket-scoped routing without a real AI
/// provider. Emits `count` `_testing_notification` frames through
/// `ctx.notify`, then returns `{count}`. Gated at registry-compile time
/// by `App.enable_test_actions` (`ZZZ_ENABLE_TEST_ACTIONS=1`).
#[allow(
    clippy::unused_async,
    reason = "ActionHandler signature requires async"
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

    /// A `session_load` result, serialized straight from the structs, has the
    /// shape `SessionLoadData` declares.
    #[test]
    fn session_load_result_serializes_to_its_wire_shape() {
        let result = SessionLoadResult {
            data: SessionLoadData {
                files: vec![SerializableDisknode::for_test(
                    "/s/a.txt",
                    Some("a"),
                    Some(1.5),
                )],
                file_roots: vec!["/s/".to_owned()],
                zzz_dir: "/z".to_owned(),
                scoped_dirs: vec!["/s".to_owned()],
                provider_status: vec![json!({"name": "claude", "available": false})],
                workspaces: vec![WorkspaceInfo {
                    path: "/w/".to_owned(),
                    name: "w".to_owned(),
                    opened_at: "2026-01-01T00:00:00Z".to_owned(),
                }],
                terminal_ids: vec!["t1".to_owned()],
                jobs: vec![],
                server_instance_id: "00000000-0000-4000-8000-000000000000".to_owned(),
            },
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({"data": {
                "files": [{
                    "id": "/s/a.txt",
                    "source_dir": "/w/",
                    "contents": "a",
                    "ctime": 1.5,
                    "mtime": 1.5,
                    "dependents": [],
                    "dependencies": [],
                }],
                "file_roots": ["/s/"],
                "zzz_dir": "/z",
                "scoped_dirs": ["/s"],
                "provider_status": [{"name": "claude", "available": false}],
                "workspaces": [{
                    "path": "/w/",
                    "name": "w",
                    "opened_at": "2026-01-01T00:00:00Z",
                }],
                "terminal_ids": ["t1"],
                "jobs": [],
                "server_instance_id": "00000000-0000-4000-8000-000000000000",
            }})
        );
    }
}
