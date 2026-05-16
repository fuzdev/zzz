//! Self-service account management handlers.
//!
//! Mirrors `fuz_app`'s `account_actions.ts`: session listing/revocation
//! and API token CRUD scoped to the authenticated account. Every handler
//! is account-scoped — passing another account's session or token id
//! returns `revoked: false` rather than revealing existence.

use fuz_common::JsonRpcError;
use serde::Serialize;
use serde_json::Value;

use crate::api_token::generate_api_token;
use crate::db;
use crate::rpc;

use super::Ctx;

/// Max API tokens per account before the oldest are evicted on create.
///
/// Mirrors `fuz_app`'s `DEFAULT_MAX_TOKENS` (10) from `account_routes.ts`.
const DEFAULT_MAX_TOKENS: i64 = 10;

// -- Response structs ---------------------------------------------------------

/// `SessionAccountJson` shape — matches `fuz_app`'s `to_session_account` output.
#[derive(Serialize)]
struct AccountVerifyResult {
    id: String,
    username: String,
    email: Option<String>,
    email_verified: bool,
    created_at: String,
}

/// Single session entry in `account_session_list` (`AuthSessionJson`).
#[derive(Serialize)]
struct AccountSessionInfo {
    id: String,
    account_id: String,
    created_at: String,
    last_seen_at: String,
    expires_at: String,
}

#[derive(Serialize)]
struct AccountSessionListResult {
    sessions: Vec<AccountSessionInfo>,
}

#[derive(Serialize)]
struct AccountRevokeResult {
    ok: bool,
    revoked: bool,
}

#[derive(Serialize)]
struct AccountSessionRevokeAllResult {
    ok: bool,
    count: u64,
}

#[derive(Serialize)]
struct AccountTokenCreateResult {
    ok: bool,
    token: String,
    id: String,
    name: String,
}

/// `ClientApiTokenJson` shape — `account_id` is a string for wire parity
/// with the Deno backend, which serializes UUIDs as strings.
///
/// Deliberately omits `token_hash`. Adding columns to `api_token` does
/// NOT automatically extend this — see `db::api_token::ApiTokenListRow`.
#[derive(Serialize)]
struct ApiTokenInfo {
    id: String,
    account_id: String,
    name: String,
    expires_at: Option<String>,
    last_used_at: Option<String>,
    last_used_ip: Option<String>,
    created_at: String,
}

#[derive(Serialize)]
struct AccountTokenListResult {
    tokens: Vec<ApiTokenInfo>,
}

// -- Helpers ------------------------------------------------------------------

/// Resolve the authenticated account id, or return an internal error.
///
/// `method_auth` already enforces `Authenticated`, so `ctx.auth` is `Some`
/// by the time we get here — this is belt-and-suspenders against a future
/// auth wiring regression.
fn require_account_id(ctx: &Ctx<'_>) -> Result<uuid::Uuid, JsonRpcError> {
    ctx.auth
        .map(|c| c.account.id)
        .ok_or_else(|| rpc::internal_error("missing auth context"))
}

// -- Handlers -----------------------------------------------------------------

pub(super) async fn handle_account_verify(
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    let account_id = require_account_id(ctx)?;

    let summary = db::query_account_summary(db, &account_id)
        .await
        .map_err(|_| rpc::internal_error("verify query failed"))?
        .ok_or_else(|| rpc::internal_error("account not found"))?;

    let result = AccountVerifyResult {
        id: summary.id.to_string(),
        username: summary.username,
        email: summary.email,
        email_verified: summary.email_verified,
        created_at: summary.created_at,
    };
    serde_json::to_value(result).map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_account_session_list(
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    let account_id = require_account_id(ctx)?;

    let rows = db::query_sessions_for_account(db, &account_id)
        .await
        .map_err(|_| rpc::internal_error("session list query failed"))?;

    let account_id_str = account_id.to_string();
    let sessions: Vec<AccountSessionInfo> = rows
        .into_iter()
        .map(|r| AccountSessionInfo {
            id: r.id,
            account_id: account_id_str.clone(),
            created_at: r.created_at,
            last_seen_at: r.last_seen_at,
            expires_at: r.expires_at,
        })
        .collect();

    serde_json::to_value(AccountSessionListResult { sessions })
        .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_account_session_revoke(
    params: &Value,
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    let account_id = require_account_id(ctx)?;
    let session_id = params
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'session_id' parameter"))?;

    let deleted = db::query_delete_session_for_account(db, session_id, &account_id)
        .await
        .map_err(|_| rpc::internal_error("session revoke query failed"))?;

    if deleted {
        let closed = ctx.app.close_sockets_for_session(session_id);
        if closed > 0 {
            tracing::info!(
                count = closed,
                "session revoke: closed WebSocket connections"
            );
        }
    }

    // TODO: audit emit `session_revoke` (outcome: deleted ? success : failure).
    // Audit subsystem is a separate Phase 5 quest.

    serde_json::to_value(AccountRevokeResult {
        ok: true,
        revoked: deleted,
    })
    .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_account_session_revoke_all(
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    let account_id = require_account_id(ctx)?;

    let deleted_count = db::query_delete_all_sessions_for_account(db, &account_id)
        .await
        .map_err(|_| rpc::internal_error("session revoke_all query failed"))?;

    // Close every socket on the account — cookie, bearer, and daemon-token —
    // matching fuz_app's `transports_ws_auth_guard` which treats
    // `session_revoke_all` / `token_revoke_all` / `password_change` as
    // account-wide credential invalidation.
    let closed = ctx.app.close_sockets_for_account(account_id);
    if closed > 0 {
        tracing::info!(
            count = closed,
            "session revoke_all: closed WebSocket connections"
        );
    }

    // TODO: audit emit `session_revoke_all` with metadata.count.
    // Audit subsystem is a separate Phase 5 quest.

    serde_json::to_value(AccountSessionRevokeAllResult {
        ok: true,
        count: deleted_count,
    })
    .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_account_token_create(
    params: &Value,
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    let account_id = require_account_id(ctx)?;

    // `name` is optional with a default of "CLI token" (matches fuz_app's
    // `TokenCreateInput.name` default).
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .map_or_else(|| "CLI token".to_owned(), str::to_owned);

    // TODO @security: tighten to Session-only once fuz_app spec field lands
    // (track in grimoire/lore/fuz_app/TODO.md). Allowing bearer-spawn-bearer
    // matches fuz_app today but enables persistence-via-token-spawning if a
    // bearer leaks. Source-of-truth fix lives upstream in fuz_app.

    let generated = generate_api_token();

    db::query_create_api_token(db, &generated.id, &account_id, &name, &generated.token_hash)
        .await
        .map_err(|_| rpc::internal_error("token create query failed"))?;

    // Enforce per-account cap inside the same dispatcher-managed transaction
    // as the INSERT above. A failure rolls the whole `account_token_create`
    // back so we never expose a token row that violates the cap.
    db::query_api_token_enforce_limit(db, &account_id, DEFAULT_MAX_TOKENS)
        .await
        .map_err(|_| rpc::internal_error("token enforce_limit query failed"))?;

    // TODO: audit emit `token_create` with metadata { token_id, name }.
    // Audit subsystem is a separate Phase 5 quest.

    serde_json::to_value(AccountTokenCreateResult {
        ok: true,
        token: generated.token,
        id: generated.id,
        name,
    })
    .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_account_token_list(
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    let account_id = require_account_id(ctx)?;

    let rows = db::query_api_token_list_for_account(db, &account_id)
        .await
        .map_err(|_| rpc::internal_error("token list query failed"))?;

    let tokens: Vec<ApiTokenInfo> = rows
        .into_iter()
        .map(|r| ApiTokenInfo {
            id: r.id,
            account_id: r.account_id.to_string(),
            name: r.name,
            expires_at: r.expires_at,
            last_used_at: r.last_used_at,
            last_used_ip: r.last_used_ip,
            created_at: r.created_at,
        })
        .collect();

    serde_json::to_value(AccountTokenListResult { tokens })
        .map_err(|_| rpc::internal_error("serialization failed"))
}

pub(super) async fn handle_account_token_revoke(
    params: &Value,
    ctx: &Ctx<'_>,
    db: &(impl deadpool_postgres::GenericClient + ?Sized),
) -> Result<Value, JsonRpcError> {
    let account_id = require_account_id(ctx)?;
    let token_id = params
        .get("token_id")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc::invalid_params("missing or invalid 'token_id' parameter"))?;

    let deleted = db::query_revoke_api_token_for_account(db, token_id, &account_id)
        .await
        .map_err(|_| rpc::internal_error("token revoke query failed"))?;

    if deleted {
        let closed = ctx.app.close_sockets_for_token(token_id);
        if closed > 0 {
            tracing::info!(count = closed, "token revoke: closed WebSocket connections");
        }
    }

    // TODO: audit emit `token_revoke` (outcome: deleted ? success : failure).
    // Audit subsystem is a separate Phase 5 quest.

    serde_json::to_value(AccountRevokeResult {
        ok: true,
        revoked: deleted,
    })
    .map_err(|_| rpc::internal_error("serialization failed"))
}
