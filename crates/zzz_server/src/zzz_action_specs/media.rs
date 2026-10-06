//! `ActionSpec` builders for media methods.
//!
//! Mirrors `src/lib/action_specs.ts`'s `media_finalize` and
//! `transcription_create` (`side_effects: true`, `authenticated`). They write
//! files on disk and touch no DB row.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialGate};
use serde_json::Value;

use crate::handlers::App;
use crate::handlers::media;

#[must_use]
pub fn build_media_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![
        media_finalize_spec(Arc::clone(&app)),
        transcription_create_spec(app),
    ]
}

fn transcription_create_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { media::transcription_create(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "transcription_create",
        AuthSpec::authenticated(CredentialGate::Any),
        handler,
    )
}

fn media_finalize_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { media::media_finalize(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "media_finalize",
        AuthSpec::authenticated(CredentialGate::Any),
        handler,
    )
}
