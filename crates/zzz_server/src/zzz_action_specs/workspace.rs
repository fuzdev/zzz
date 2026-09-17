//! `ActionSpec` builders for workspace methods.
//!
//! Mirrors the three workspace specs in `src/lib/action_specs.ts`:
//! `workspace_list` (read-only, authenticated), `workspace_open`
//! (side-effects, authenticated), `workspace_close` (side-effects,
//! authenticated).
//!
//! ## Side-effects flag
//!
//! `workspace_open` / `workspace_close` carry `side_effects: true`
//! matching `crate::handlers::method_spec`. They don't touch the DB today
//! (workspace state is in-memory) — the flag is preserved for parity
//! with the Deno reference and to keep the eventual transactional-audit
//! boundary intact when audit emission lands on workspace mutations.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialGate};
use fuz_http::JsonrpcError;
use serde_json::Value;

use crate::handlers::App;
use crate::handlers::workspace;

/// Build the workspace action specs.
///
/// `app` is the long-lived `Arc<App>` from the composition root —
/// cloned once per spec into each handler closure so the handler can
/// reach through to zzz-specific deps (`workspaces`, `FilerManager`,
/// `ScopedFs`) that `ActionContext` doesn't carry.
#[must_use]
pub fn build_workspace_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![
        workspace_list_spec(Arc::clone(&app)),
        workspace_open_spec(Arc::clone(&app)),
        workspace_close_spec(app),
    ]
}

fn workspace_list_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { workspace::workspace_list(params, ctx, app).await })
    });
    ActionSpec::read_only(
        "workspace_list",
        AuthSpec::authenticated(CredentialGate::Any),
        handler,
    )
}

fn workspace_open_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { workspace::workspace_open(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "workspace_open",
        AuthSpec::authenticated(CredentialGate::Any),
        handler,
    )
}

fn workspace_close_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { workspace::workspace_close(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "workspace_close",
        AuthSpec::authenticated(CredentialGate::Any),
        handler,
    )
}

// Silence unused-import on JsonrpcError until other zzz_action_specs
// modules land that propagate it through their builder signatures.
#[doc(hidden)]
const _: fn() -> Option<JsonrpcError> = || None;
