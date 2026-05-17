//! Core `ActionSpec` builders — `ping` (public) and `session_load`
//! (authenticated).
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
