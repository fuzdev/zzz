//! Generic job handlers — what works on any job, whatever its kind.
//!
//! Spine signature `(Value, ActionContext<'_>, Arc<App>)`. Jobs are scoped to
//! the account that created them: another account's job id behaves exactly
//! like an unknown one.

use std::sync::Arc;

use fuz_actions::ActionContext;
use fuz_auth::deserialize_wire_uuid;
use fuz_http::{JsonrpcError, parse_strict_params};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::handlers::{App, caller_account_id, not_found_error};
use crate::job_manager::JobNotFound;

/// No job has this id, for this account (`not_found`).
pub const ERROR_JOB_NOT_FOUND: &str = "job_not_found";

/// Input for `job_cancel` — twin of `JobCancelInput`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobCancelInput {
    #[serde(deserialize_with = "deserialize_wire_uuid")]
    job_id: Uuid,
}

/// `job_cancel` — stop a job.
///
/// A queued one never starts, and the running one has its tool process
/// killed. Cancelling a job that's already over does nothing. The job's
/// `job_changed` notification carries the outcome.
///
/// # Errors
///
/// `invalid_params` for a malformed input; `not_found` (`job_not_found`) for
/// an unknown id or another account's job.
#[allow(
    clippy::unused_async,
    reason = "ActionHandler signature requires async"
)]
pub async fn job_cancel(
    params: Value,
    ctx: ActionContext<'_>,
    app: Arc<App>,
) -> Result<Value, JsonrpcError> {
    let input: JobCancelInput = parse_strict_params(params)?;
    let owner = caller_account_id(&ctx)?;
    app.job_manager
        .cancel(&app, owner, input.job_id)
        .map_err(|JobNotFound| not_found_error("job not found", ERROR_JOB_NOT_FOUND))?;
    Ok(Value::Null)
}
