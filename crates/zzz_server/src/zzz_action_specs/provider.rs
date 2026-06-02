//! `ActionSpec` builders for AI provider methods.
//!
//! - `provider_load_status` — authenticated read.
//! - `provider_update_api_key` — keeper (`daemon_token` + keeper role),
//!   side-effects.
//! - `completion_create` — authenticated write. The notify routing lives in
//!   `handlers::provider::completion_create`: `Arc<ConnectionRegistry>::send_to(conn_id, …)`
//!   routes streaming `completion_progress` notifications to the originating
//!   WS socket via `ctx.connection_id`.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialType};
use serde_json::Value;

use crate::handlers::App;
use crate::handlers::provider;

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
        Box::pin(async move { provider::provider_load_status(params, ctx, app).await })
    });
    ActionSpec::read_only("provider_load_status", AuthSpec::authenticated(), handler)
}

fn provider_update_api_key_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { provider::provider_update_api_key(params, ctx, app).await })
    });
    let keeper_auth = AuthSpec::authenticated_gated(Some(DAEMON_TOKEN_ONLY), Some(KEEPER_ROLE));
    ActionSpec::with_side_effects("provider_update_api_key", keeper_auth, handler)
}

fn completion_create_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { provider::completion_create(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("completion_create", AuthSpec::authenticated(), handler)
}
