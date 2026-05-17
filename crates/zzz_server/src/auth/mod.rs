//! Authentication surface — keyring, per-request resolution, per-action specs.
//!
//! Submodules:
//! - [`keyring`] — cookie signing, session-token parsing/hashing
//! - [`resolve`] — per-request auth pipeline (daemon-token → cookie → bearer)
//! - [`spec`] — `ActionAuth` / `CredentialType` / `MethodSpec` + origin
//!   allowlist + REST credential-channel gate

pub mod keyring;
pub mod resolve;
pub mod spec;

pub use keyring::*;
pub use resolve::*;
pub use spec::*;

use crate::db::{
    AccountRow, ActorRow, RoleGrantRow, query_account_by_id, query_actor_by_account,
    query_role_grants_for_actor, query_session_get_valid, query_session_touch,
};

// -- Auth errors --------------------------------------------------------------

/// Errors from building a request context (pool or query failures).
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("pool error: {0}")]
    Pool(#[from] deadpool_postgres::PoolError),
    #[error("query error: {0}")]
    Query(#[from] tokio_postgres::Error),
}

// -- Request context ----------------------------------------------------------

/// Authenticated request context — account + actor + active role grants.
///
/// Built from a valid session cookie. Passed to handlers via `Ctx`.
///
/// `#[allow(dead_code)]` on `actor`: loaded during
/// `build_request_context` (it's the bridge to role grants), but no
/// downstream handler reads `ctx.auth.actor.{id,name}` yet — the 11
/// audit-emit sites in `handlers/account.rs` + `account/*.rs` all pass
/// `actor_id: None`. Future plumbing will fill that field from
/// `ctx.auth.actor.id` to match `fuz_app`'s emit shape; keeping the data
/// loaded means handler refactors don't need to re-thread the query.
/// Same precedent as `audit::AuditLogEvent` (`audit/mod.rs:71`).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct RequestContext {
    pub account: AccountRow,
    pub actor: ActorRow,
    pub role_grants: Vec<RoleGrantRow>,
}

impl RequestContext {
    /// Check if this context has an active role grant for the given role.
    pub fn has_role(&self, role: &str) -> bool {
        self.role_grants.iter().any(|p| p.role == role)
    }
}

/// Build a `RequestContext` from a session token.
///
/// Pipeline: cookie → verify signature → hash token → session lookup →
/// account → actor → role grants.
pub async fn build_request_context(
    pool: &deadpool_postgres::Pool,
    session_token: &str,
) -> Result<Option<RequestContext>, AuthError> {
    let client = pool.get().await?;

    // Hash token → look up session
    let token_hash = hash_session_token(session_token);
    let session = query_session_get_valid(&client, &token_hash).await?;

    let Some(session) = session else {
        return Ok(None);
    };

    // Build context: account → actor → role grants
    let account = query_account_by_id(&client, &session.account_id).await?;

    let Some(account) = account else {
        return Ok(None);
    };

    let actor = query_actor_by_account(&client, &account.id).await?;

    let Some(actor) = actor else {
        return Ok(None);
    };

    let role_grants = query_role_grants_for_actor(&client, &actor.id).await?;

    // Touch session (fire-and-forget — don't block the request)
    let touch_pool = pool.clone();
    let touch_hash = token_hash.clone();
    tokio::spawn(async move {
        if let Ok(client) = touch_pool.get().await
            && let Err(e) = query_session_touch(&client, &touch_hash).await
        {
            tracing::warn!(error = %e, "session touch failed");
        }
    });

    Ok(Some(RequestContext {
        account,
        actor,
        role_grants,
    }))
}
