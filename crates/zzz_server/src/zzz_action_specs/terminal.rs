//! `ActionSpec` builders for terminal methods.

use std::sync::Arc;

use fuz_actions::{ActionContext, ActionHandler, ActionSpec};
use fuz_auth::AuthSpec;
use serde_json::Value;

use crate::handlers::App;
use crate::handlers::terminal;

#[must_use]
pub fn build_terminal_specs(app: Arc<App>) -> Vec<ActionSpec> {
    vec![
        terminal_create_spec(Arc::clone(&app)),
        terminal_data_send_spec(Arc::clone(&app)),
        terminal_resize_spec(Arc::clone(&app)),
        terminal_close_spec(app),
    ]
}

fn terminal_create_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { terminal::terminal_create(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("terminal_create", AuthSpec::authenticated(), handler)
}

fn terminal_data_send_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { terminal::terminal_data_send(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("terminal_data_send", AuthSpec::authenticated(), handler)
}

fn terminal_resize_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { terminal::terminal_resize(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("terminal_resize", AuthSpec::authenticated(), handler)
}

fn terminal_close_spec(app: Arc<App>) -> ActionSpec {
    let handler: ActionHandler = Arc::new(move |params: Value, ctx: ActionContext<'_>| {
        let app = Arc::clone(&app);
        Box::pin(async move { terminal::terminal_close(params, ctx, app).await })
    });
    ActionSpec::with_side_effects("terminal_close", AuthSpec::authenticated(), handler)
}
