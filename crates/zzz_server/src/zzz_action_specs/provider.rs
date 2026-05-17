//! `ActionSpec` builders for AI provider methods.
//!
//! Migrates `provider_load_status` (authenticated read) and
//! `provider_update_api_key` (keeper: `daemon_token` + keeper role,
//! side-effects). `completion_create` is deferred — it builds a
//! per-request `ProgressSender: 'static` over the legacy `Arc<NotifyFn>`
//! shape, which the spine's new borrowed `&dyn Fn(&str, &Value)` notify
//! can't satisfy without a separate plumbing change (route via
//! `ctx.connection_id` + `Arc<ConnectionRegistry>`).

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
        provider_update_api_key_spec(app),
    ]
}

fn provider_load_status_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { provider_v2::provider_load_status(params, ctx, app).await })
    });
    ActionSpec::read_only(
        "provider_load_status",
        AuthSpec::authenticated(),
        handler,
    )
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
