//! Core `ActionSpec` builders — `ping` (public) and `session_load`
//! (authenticated), plus the test-only `_testing_emit_notifications`
//! builder gated on `App.enable_test_actions`.
//!
//! Both methods are zzz-namespaced (not in `fuz_actions::PROTOCOL_ACTION_SPECS`
//! / `auth_adapter`), so they ship here. Wire shape matches the legacy
//! `handlers::handle_ping` / `handle_session_load` byte-for-byte.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::AuthSpec;
use serde_json::Value;

use crate::handlers::App;
use crate::handlers_v2::core as core_v2;

/// Build the core action specs (`ping`, `session_load`).
#[must_use]
pub fn build_core_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![ping_spec(Arc::clone(&app)), session_load_spec(app)]
}

fn ping_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { core_v2::ping(params, ctx, app).await })
    });
    ActionSpec::read_only("ping", AuthSpec::public(), handler)
}

fn session_load_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { core_v2::session_load(params, ctx, app).await })
    });
    ActionSpec::read_only("session_load", AuthSpec::authenticated(), handler)
}

/// Build the test-only action specs (`_testing_emit_notifications`). Caller
/// extends the registry input with these only when `enable_test_actions`
/// is set — the gating happens at registry-compile time so production
/// boots never carry the test surface at all.
#[must_use]
pub fn build_testing_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![testing_emit_notifications_spec(app)]
}

fn testing_emit_notifications_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { core_v2::testing_emit_notifications(params, ctx, app).await })
    });
    ActionSpec::read_only(
        "_testing_emit_notifications",
        AuthSpec::authenticated(),
        handler,
    )
}
