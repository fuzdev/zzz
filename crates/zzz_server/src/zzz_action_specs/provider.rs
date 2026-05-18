//! `ActionSpec` builders for AI provider methods.
//!
//! - `provider_load_status` — authenticated read.
//! - `provider_update_api_key` — keeper (`daemon_token` + keeper role),
//!   side-effects.
//! - `completion_create` — authenticated write (Phase 7 sub-batch C).
//!   The notify reshape lives in `handlers_v2::provider::completion_create`:
//!   `Arc<ConnectionRegistry>::send_to(conn_id, …)` routes streaming
//!   `completion_progress` notifications to the originating WS socket via
//!   `ctx.connection_id`, replacing the legacy `Arc<NotifyFn>` capture.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::{ActionAuth, AuthSpec, CredentialType};
use serde_json::Value;

use crate::handlers::App;
use crate::handlers_v2::provider as provider_v2;

const DAEMON_TOKEN_ONLY: &[CredentialType] = &[CredentialType::DaemonToken];
const KEEPER_ROLE: &[&str] = &["keeper"];

#[must_use]
pub fn build_provider_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![
        provider_load_status_spec(Arc::clone(&app)),
        provider_update_api_key_spec(Arc::clone(&app)),
        completion_create_spec(app),
    ]
}

fn provider_load_status_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { provider_v2::provider_load_status(params, ctx, app).await })
    });
    ActionSpec::read_only("provider_load_status", AuthSpec::authenticated(), handler)
}

fn provider_update_api_key_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { provider_v2::provider_update_api_key(params, ctx, app).await })
    });
    let keeper_auth = AuthSpec {
        auth: ActionAuth::Authenticated,
        credential_types: Some(DAEMON_TOKEN_ONLY),
        roles: Some(KEEPER_ROLE),
    };
    ActionSpec::with_side_effects("provider_update_api_key", keeper_auth, handler)
}

fn completion_create_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { provider_v2::completion_create(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("completion_create", AuthSpec::authenticated(), handler)
}
