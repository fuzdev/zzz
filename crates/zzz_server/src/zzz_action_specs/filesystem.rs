//! `ActionSpec` builders for filesystem methods.
//!
//! Mirrors `src/lib/action_specs.ts`'s `diskfile_read` (read-only) and
//! `diskfile_update`, `diskfile_create`, `diskfile_delete`,
//! `directory_create` (`side_effects: true`), all account-grain. None touch
//! the DB today — `side_effects` is set to match the spec and to keep the
//! transactional-audit boundary intact when filesystem audit emission lands.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionOutputHandler, ActionSpec};
use fuz_auth::{AuthSpec, CredentialGate};
use fuz_http::InputShape;
use serde_json::Value;

use crate::handlers::App;
use crate::handlers::filesystem;

#[must_use]
pub fn build_filesystem_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![
        diskfile_read_spec(Arc::clone(&app)),
        diskfile_update_spec(Arc::clone(&app)),
        diskfile_create_spec(Arc::clone(&app)),
        diskfile_delete_spec(Arc::clone(&app)),
        directory_create_spec(app),
    ]
}

fn diskfile_read_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionOutputHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem::diskfile_read(params, ctx, app).await })
    });
    ActionSpec::new_output(
        "diskfile_read",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        false,
        handler,
    )
}

fn diskfile_update_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem::diskfile_update(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "diskfile_update",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        handler,
    )
}

fn diskfile_create_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem::diskfile_create(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "diskfile_create",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        handler,
    )
}

fn diskfile_delete_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem::diskfile_delete(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "diskfile_delete",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        handler,
    )
}

fn directory_create_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { filesystem::directory_create(params, ctx, app).await })
    });
    ActionSpec::with_side_effects(
        "directory_create",
        AuthSpec::account_grain(CredentialGate::Any),
        InputShape::Object,
        handler,
    )
}
