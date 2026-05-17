//! Admin RPC handlers.
//!
//! Mirrors `fuz_app`'s `admin_actions.ts` `session_revoke_all_handler` and
//! `token_revoke_all_handler`. Admin operates on a *target* account
//! (`input.account_id`); the self-service surface in `account.rs` always
//! targets the caller's own account.
//!
//! ## Wire shape
//!
//! Audit `event_type` is plain `session_revoke_all` / `token_revoke_all` —
//! the same type the self-service handlers emit. The distinguisher is
//! `target_account_id`: self-service emits with `target_account_id: null`
//! (the row is about the caller's own account); admin emits with
//! `target_account_id: <target>` and the admin's own id in `account_id`.
//! The audit listener in `audit::listeners::register` uses
//! `target_account_id.or(account_id)` so a single listener handles both
//! shapes.
//!
//! ## Eager handler-side WS close
//!
//! Like the self-service revoke handlers, this calls
//! `close_sockets_for_account` synchronously BEFORE the audit emit, so
//! revocation lands on the live WS even if the audit INSERT later fails
//! (DB hiccup, pool exhausted). The audit listener also calls
//! `close_sockets_for_account` on the materialized row — the second pass
//! is a no-op because `close_sockets_for_*` is idempotent.
//!
//! ## Credential gate
//!
//! Admin handlers are deliberately *not* restricted to session cookies
//! (`MethodSpec.credential_types` is `None` for these methods). Admin CLI
//! scripting via bearer is a legitimate operator workflow — matches
//! `fuz_app`. The role gate (`roles: ['admin']`) is the only check on top
//! of authentication.

use std::future::Future;

use fuz_common::JsonRpcError;
use serde::Serialize;
use serde_json::{Value, json};

use crate::audit::{AuditLogInput, AuditOutcome};
use crate::db;
use crate::rpc;

use super::Ctx;

/// `data.reason` value on the "account not found" failure (mirrors
/// `ERROR_ACCOUNT_NOT_FOUND` in `fuz_app/src/lib/http/error_schemas.ts`).
const ERROR_ACCOUNT_NOT_FOUND: &str = "account_not_found";

#[derive(Serialize)]
struct AdminRevokeAllResult {
    ok: bool,
    count: u64,
}

/// Resolve the authenticated admin's account id.
///
/// `method_spec` already enforced `Authenticated` + `roles: ['admin']`, so
/// `ctx.auth` is `Some` and the actor has the admin grant by the time we
/// get here — this is belt-and-suspenders against a future auth wiring
/// regression.
fn require_admin_account_id(ctx: &Ctx<'_>) -> Result<uuid::Uuid, JsonRpcError> {
    ctx.auth
        .map(|c| c.account.id)
        .ok_or_else(|| rpc::internal_error("missing auth context"))
}

/// Parse `input.account_id` (UUID string) into a `uuid::Uuid`.
fn parse_target_account_id(params: &Value) -> Result<uuid::Uuid, JsonRpcError> {
    let raw = params
        .get("account_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'account_id' parameter"))?;
    uuid::Uuid::parse_str(raw)
        .map_err(|_| rpc::invalid_params("'account_id' is not a valid uuid"))
}

/// Shared skeleton for `admin_session_revoke_all` / `admin_token_revoke_all`.
///
/// Both handlers do the same five things — lookup the target, emit a
/// failure-shape audit row on miss, run a `DELETE ... WHERE account_id = $1`
/// query, eagerly close the target's WS sockets, and emit a success audit
/// row with `{count}` metadata. The only differences are the `event_type`
/// string and the delete query — both passed in as arguments.
///
/// `delete` is a closure (not a function pointer) so the caller can capture
/// the `db` borrow; the helper itself only needs `db` for the lookup.
async fn revoke_all_for_target<F, Fut>(
    event_type: &'static str,
    delete_err_msg: &'static str,
    params: &Value,
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
    delete: F,
) -> Result<Value, JsonRpcError>
where
    F: FnOnce(uuid::Uuid) -> Fut,
    Fut: Future<Output = Result<u64, tokio_postgres::Error>>,
{
    let admin_account_id = require_admin_account_id(ctx)?;
    let target_account_id = parse_target_account_id(params)?;

    let target = db::query_account_by_id(db, &target_account_id)
        .await
        .map_err(|_| rpc::internal_error("account lookup failed"))?;

    if target.is_none() {
        // Failure-shape audit: `target_account_id` stays NULL (the FK to
        // `account` would reject a probe for a non-existent id). The probed
        // value is preserved under `metadata.attempted_account_id` for
        // forensics. Mirrors `fuz_app::admin_actions`.
        let handle = ctx.app.audit.emit(AuditLogInput {
            event_type,
            outcome: Some(AuditOutcome::Failure),
            actor_id: None,
            account_id: Some(admin_account_id),
            target_account_id: None,
            target_actor_id: None,
            ip: ctx.client_ip.clone(),
            metadata: Some(json!({
                "reason": ERROR_ACCOUNT_NOT_FOUND,
                "attempted_account_id": target_account_id.to_string(),
            })),
        });
        ctx.push_pending_effect(handle);
        return Err(rpc::not_found("account", Some(ERROR_ACCOUNT_NOT_FOUND)));
    }

    let count = delete(target_account_id)
        .await
        .map_err(|_| rpc::internal_error(delete_err_msg))?;

    // Eager handler-side close — see module doc-comment. Lands on the live
    // WS even if the audit INSERT later fails. The audit listener fires the
    // same call on the materialized row (idempotent).
    ctx.app.close_sockets_for_account(target_account_id);

    // TOCTOU window — admin B hard-deletes `target_account_id` between the
    // pre-check above and this emit; the FK rejects the row, the audit
    // emitter logs + swallows, the operation goes unaudited. Same posture
    // as fuz_app — not switching to the failure-shape because the FK
    // linkage powers username joins on the admin audit log readers.
    let handle = ctx.app.audit.emit(AuditLogInput {
        event_type,
        outcome: Some(AuditOutcome::Success),
        actor_id: None,
        account_id: Some(admin_account_id),
        target_account_id: Some(target_account_id),
        target_actor_id: None,
        ip: ctx.client_ip.clone(),
        metadata: Some(json!({"count": count})),
    });
    ctx.push_pending_effect(handle);

    serde_json::to_value(AdminRevokeAllResult { ok: true, count })
        .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_admin_session_revoke_all(
    params: &Value,
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    revoke_all_for_target(
        "session_revoke_all",
        "session revoke_all query failed",
        params,
        ctx,
        db,
        // `async move` so the future owns the moved-in `target` Uuid —
        // a plain expression would borrow the closure parameter, which
        // is dropped before the future is awaited (E0515).
        |target| async move { db::query_delete_all_sessions_for_account(db, &target).await },
    )
    .await
}

pub(super) async fn handle_admin_token_revoke_all(
    params: &Value,
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    revoke_all_for_target(
        "token_revoke_all",
        "token revoke_all query failed",
        params,
        ctx,
        db,
        |target| async move { db::query_delete_all_tokens_for_account(db, &target).await },
    )
    .await
}
