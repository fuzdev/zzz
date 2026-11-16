//! `ActionSpec` builders for project methods.
//!
//! Mirrors the three project specs in `src/lib/action_specs.ts`:
//! `project_list` (read-only), `project_open` and `project_close`
//! (side-effects) — each account-grain (`account: required, actor: none`)
//! like its TS spec.
//!
//! ## Side-effects flag
//!
//! `project_open` / `project_close` carry `side_effects: true`, matching
//! their TS specs. They don't touch the DB (project state is in-memory), but
//! they mutate server state, so the flag keeps them off the side-effect-free
//! `GET /api/rpc` path and marks the transactional boundary for audit
//! emission on project mutations.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionOutputHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialGate};
use fuz_http::InputShape;
use serde_json::Value;

use crate::handlers::App;
use crate::handlers::project;

/// Build the project action specs.
///
/// `app` is the long-lived `Arc<App>` from the composition root —
/// cloned once per spec into each handler closure so the handler can
/// reach through to zzz-specific deps (`projects`, `FilerManager`,
/// `ScopedFs`) that `ActionContext` doesn't carry.
#[must_use]
pub fn build_project_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![
        project_list_spec(Arc::clone(&app)),
        project_open_spec(Arc::clone(&app)),
        project_close_spec(app),
    ]
}

fn project_list_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { project::project_list(params, ctx, app).await })
    });
    ActionSpec::read_only(
        "project_list",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Void,
        handler,
    )
}

fn project_open_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionOutputHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { project::project_open(params, ctx, app).await })
    });
    ActionSpec::new_output(
        "project_open",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        true,
        handler,
    )
}

fn project_close_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { project::project_close(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "project_close",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        handler,
    )
}
