//! `ActionSpec` builders for the generic job methods.
//!
//! Mirrors `src/lib/action_specs.ts`'s `job_cancel` (`side_effects: true`,
//! `authenticated`). Jobs live in daemon memory; nothing here touches the DB.
//! Each kind of job has its own create action (`transcription_create`, with
//! the media specs); what's here works on any job.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialGate};
use serde_json::Value;

use crate::handlers::App;
use crate::handlers::job;

#[must_use]
pub fn build_job_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![job_cancel_spec(app)]
}

fn job_cancel_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { job::job_cancel(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "job_cancel",
        AuthSpec::authenticated(CredentialGate::Any),
        handler,
    )
}
