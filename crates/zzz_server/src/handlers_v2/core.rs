//! Core handlers — `ping` (public health check) and `session_load`
//! (authenticated initial-state load).
//!
//! Spine-backed signature: `(Value, ActionContext<'_>, Arc<App>) ->
//! Result<Value, JsonrpcError>`. `ping` is public (no auth); `session_load`
//! is authenticated and returns the initial state envelope (open workspaces,
//! zzz_dir contents, scoped_dirs, provider status). Wire shape matches the
//! legacy `handlers::handle_ping` / `handle_session_load` byte-for-byte.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_http::JsonrpcError;
use serde::Serialize;
use serde_json::Value;

use crate::handlers::{App, WorkspaceInfo};
use crate::rpc;

#[derive(Serialize)]
struct PingResult {
    ping_id: Value,
}

#[derive(Serialize)]
struct TestEmitNotificationsResult {
    count: u64,
}

#[derive(Serialize)]
struct SessionLoadData {
    files: Vec<crate::filer::SerializableDisknode>,
    zzz_dir: String,
    scoped_dirs: Vec<String>,
    provider_status: Vec<Value>,
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Serialize)]
struct SessionLoadResult {
    data: SessionLoadData,
}

/// `ping` — public health check. Echoes the request id back as `ping_id`.
///
/// `ActionContext.request_id` carries the parsed envelope's id; mirrors
/// the legacy `handle_ping` shape.
#[allow(
    clippy::unused_async,
    reason = "ActionHandler signature requires async"
)]
pub async fn ping(
    _params: Value,
    ctx: ActionContext<'_>,
    _app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let result = PingResult {
        ping_id: ctx.request_id.clone(),
    };
    serde_json::to_value(result)
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

/// `session_load` — authenticated initial-state load.
///
/// Returns the cross-domain envelope the frontend needs at boot:
/// open workspaces, zzz_dir file tree (rescanned for consistency),
/// scoped_dirs, provider status. Mirrors the legacy
/// `handle_session_load` body verbatim.
pub async fn session_load(
    _params: Value,
    _ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let workspaces: Vec<WorkspaceInfo> = {
        let ws = app.workspaces.read();
        ws.values().cloned().collect()
    };

    // Rescan each watched directory before reading the index — notify events
    // are eventually consistent, so a file written immediately before
    // session_load may not yet be in the in-memory index. A fresh walk
    // guarantees a consistent snapshot and removes a flaky race in integration
    // tests (`session_load_returns_nested_files`) where the filer event loop
    // hadn't yet drained the inotify event.
    app.filer_manager.rescan_all().await;
    let files = app.filer_manager.collect_all_files().await;

    let mut provider_status = Vec::new();
    for p in app.provider_manager.all() {
        let status = p.load_status(false).await;
        if let Ok(v) = serde_json::to_value(&status) {
            provider_status.push(v);
        }
    }

    let result = SessionLoadResult {
        data: SessionLoadData {
            files,
            zzz_dir: app.zzz_dir.clone(),
            scoped_dirs: app.scoped_dirs.clone(),
            provider_status,
            workspaces,
        },
    };
    serde_json::to_value(result)
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}

/// `_test_emit_notifications` — test-only action used by the integration
/// suite to verify `ctx.notify` socket-scoped routing without a real AI
/// provider. Emits `count` `_test_notification` frames through
/// `ctx.notify`, then returns `{count}`. Gated at registry-compile time
/// by `App.enable_test_actions` (`ZZZ_ENABLE_TEST_ACTIONS=1`).
#[allow(
    clippy::unused_async,
    reason = "ActionHandler signature requires async"
)]
pub async fn test_emit_notifications(
    params: Value,
    ctx: ActionContext<'_>,
    _app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let count = params
        .get("count")
        .and_then(Value::as_u64)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'count' parameter"))?;
    if count > 100 {
        return Err(rpc::invalid_params("count must be <= 100"));
    }
    for i in 0..count {
        (ctx.notify)("_test_notification", &serde_json::json!({"index": i}));
    }
    serde_json::to_value(TestEmitNotificationsResult { count })
        .map_err(|e| rpc::internal_error_with_source("serialization failed", &e))
}
