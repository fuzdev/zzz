//! Per-request auth resolution.
//!
//! `resolve_auth_from_headers` runs the daemon-token → cookie → bearer
//! pipeline, returning a [`ResolvedAuth`] when any leg succeeds.

use crate::daemon_token::SharedDaemonTokenState;
use crate::db::{
    query_account_by_id, query_actor_by_account, query_api_token_touch,
    query_role_grants_for_actor, query_validate_api_token,
};

use super::keyring::{Keyring, hash_session_token, parse_session_from_cookies};
use super::spec::CredentialType;
use super::{RequestContext, build_request_context};

/// Resolve request context from HTTP headers (Cookie header).
///
/// Returns `None` if no session cookie or session is invalid.
/// Used by both HTTP RPC and WebSocket upgrade handlers.
/// Resolved auth context with connection tracking metadata.
pub struct ResolvedAuth {
    pub context: RequestContext,
    /// blake3 hash of the session token (for targeted socket revocation).
    /// `None` for bearer token connections (revocable only via account-level revocation).
    pub token_hash: Option<String>,
    /// `api_token.id` when authenticated via `Authorization: Bearer`.
    /// `None` for session/daemon-token auth. Used for per-token socket
    /// revocation on `token_revoke` audit events.
    pub api_token_id: Option<String>,
    /// How this request was authenticated.
    pub credential_type: CredentialType,
}

pub async fn resolve_auth_from_headers(
    headers: &axum::http::HeaderMap,
    keyring: &Keyring,
    pool: &deadpool_postgres::Pool,
    daemon_token_state: Option<&SharedDaemonTokenState>,
) -> Option<ResolvedAuth> {
    // Try daemon token first (highest priority, matches fuz_app middleware order)
    if let Some(state) = daemon_token_state
        && let Some(resolved) = resolve_daemon_token_from_headers(headers, state, pool).await
    {
        return Some(resolved);
    }

    // Try cookie auth
    if let Some(resolved) = resolve_cookie_from_headers(headers, keyring, pool).await {
        return Some(resolved);
    }

    // Fall back to bearer token auth
    resolve_bearer_from_headers(headers, pool).await
}

/// Resolve auth from cookie session (`fuz_session`).
async fn resolve_cookie_from_headers(
    headers: &axum::http::HeaderMap,
    keyring: &Keyring,
    pool: &deadpool_postgres::Pool,
) -> Option<ResolvedAuth> {
    let cookie_header = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;

    let session_token = parse_session_from_cookies(cookie_header, keyring)?;
    let token_hash = hash_session_token(&session_token);

    match build_request_context(pool, &session_token).await {
        Ok(Some(context)) => Some(ResolvedAuth {
            context,
            token_hash: Some(token_hash),
            api_token_id: None,
            credential_type: CredentialType::Session,
        }),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(error = %e, "cookie auth context build failed");
            None
        }
    }
}

/// Resolve auth from `Authorization: Bearer <token>` header.
///
/// Mirrors `fuz_app`'s `bearer_auth.ts`:
/// - Case-insensitive "Bearer " prefix (RFC 7235 §2.1)
/// - Rejects requests with `Origin` or `Referer` headers (defense-in-depth
///   against browser-initiated bearer usage)
/// - Hashes token with blake3, looks up in `api_token` table
/// - Touches `last_used_at` fire-and-forget
async fn resolve_bearer_from_headers(
    headers: &axum::http::HeaderMap,
    pool: &deadpool_postgres::Pool,
) -> Option<ResolvedAuth> {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;

    // Case-insensitive "Bearer " prefix check (RFC 7235 §2.1)
    if auth_header.len() < 7 || !auth_header[..7].eq_ignore_ascii_case("bearer ") {
        return None;
    }

    // Defense-in-depth: reject bearer tokens from browser contexts
    if headers.contains_key("origin") || headers.contains_key("referer") {
        tracing::debug!("bearer auth rejected: browser context (Origin/Referer present)");
        return None;
    }

    let raw_token = &auth_header[7..];
    if raw_token.is_empty() {
        return None;
    }

    // Hash and look up in api_token table
    let token_hash = blake3::hash(raw_token.as_bytes()).to_hex().to_string();

    let client = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "bearer auth pool error");
            return None;
        }
    };

    let token_row = match query_validate_api_token(&client, &token_hash).await {
        Ok(Some(row)) => row,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!(error = %e, "bearer auth token query failed");
            return None;
        }
    };

    // Build request context from the token's account
    let account = match query_account_by_id(&client, &token_row.account_id).await {
        Ok(Some(a)) => a,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!(error = %e, "bearer auth account query failed");
            return None;
        }
    };

    let actor = match query_actor_by_account(&client, &account.id).await {
        Ok(Some(a)) => a,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!(error = %e, "bearer auth actor query failed");
            return None;
        }
    };

    let role_grants = match query_role_grants_for_actor(&client, &actor.id).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "bearer auth role grants query failed");
            return None;
        }
    };

    // Touch token usage (fire-and-forget)
    let touch_pool = pool.clone();
    let touch_id = token_row.id.clone();
    tokio::spawn(async move {
        if let Ok(client) = touch_pool.get().await
            && let Err(e) = query_api_token_touch(&client, &touch_id).await
        {
            tracing::warn!(error = %e, "api token touch failed");
        }
    });

    Some(ResolvedAuth {
        context: RequestContext {
            account,
            actor,
            role_grants,
        },
        token_hash: None, // bearer connections have no session token_hash
        api_token_id: Some(token_row.id),
        credential_type: CredentialType::ApiToken,
    })
}

/// Header name for daemon token authentication.
const DAEMON_TOKEN_HEADER: &str = "x-daemon-token";

/// Resolve auth from `X-Daemon-Token` header.
///
/// Validates the token against current and previous daemon tokens using
/// timing-safe comparison. If valid, resolves the keeper account from
/// `state.keeper_account_id` and builds a `RequestContext`.
///
/// Mirrors `fuz_app`'s daemon token middleware — daemon token overrides
/// all other auth methods (highest trust: requires filesystem access to read).
async fn resolve_daemon_token_from_headers(
    headers: &axum::http::HeaderMap,
    daemon_state: &SharedDaemonTokenState,
    pool: &deadpool_postgres::Pool,
) -> Option<ResolvedAuth> {
    let token_value = headers.get(DAEMON_TOKEN_HEADER)?.to_str().ok()?;

    if token_value.is_empty() {
        return None;
    }

    // Read lock for validation
    let state = daemon_state.read().await;
    if !crate::daemon_token::validate_daemon_token(token_value, &state) {
        tracing::debug!("daemon token validation failed");
        return None;
    }

    // Valid token — resolve keeper account
    let keeper_account_id = state.keeper_account_id?;
    drop(state); // release read lock before DB queries

    let client = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(error = %e, "daemon token auth pool error");
            return None;
        }
    };

    let account = match query_account_by_id(&client, &keeper_account_id).await {
        Ok(Some(a)) => a,
        Ok(None) => {
            tracing::warn!("daemon token keeper account not found in DB");
            return None;
        }
        Err(e) => {
            tracing::warn!(error = %e, "daemon token account query failed");
            return None;
        }
    };

    let actor = match query_actor_by_account(&client, &account.id).await {
        Ok(Some(a)) => a,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!(error = %e, "daemon token actor query failed");
            return None;
        }
    };

    let role_grants = match query_role_grants_for_actor(&client, &actor.id).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "daemon token role grants query failed");
            return None;
        }
    };

    Some(ResolvedAuth {
        context: RequestContext {
            account,
            actor,
            role_grants,
        },
        token_hash: None, // daemon token connections have no session token_hash
        api_token_id: None,
        credential_type: CredentialType::DaemonToken,
    })
}
