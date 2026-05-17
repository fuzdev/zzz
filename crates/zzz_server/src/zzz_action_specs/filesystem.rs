//! `ActionSpec` builders for filesystem methods.
//!
//! Mirrors `src/lib/action_specs.ts`'s `diskfile_update`,
//! `diskfile_delete`, `directory_create` (all `side_effects: true`,
//! `authenticated`). None touch the DB today — `side_effects` is set
//! to match the spec and to keep the transactional-audit boundary
//! intact when filesystem audit emission lands.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::AuthSpec;
use serde_json::Value;

use crate::handlers::App;
use crate::handlers_v2::filesystem as filesystem_v2;

#[must_use]
pub fn build_filesystem_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![
        diskfile_update_spec(Arc::clone(&app)),
        diskfile_delete_spec(Arc::clone(&app)),
        directory_create_spec(app),
    ]
}

fn diskfile_update_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem_v2::diskfile_update(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("diskfile_update", AuthSpec::authenticated(), handler)
}

fn diskfile_delete_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem_v2::diskfile_delete(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("diskfile_delete", AuthSpec::authenticated(), handler)
}

fn directory_create_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem_v2::directory_create(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("directory_create", AuthSpec::authenticated(), handler)
}
