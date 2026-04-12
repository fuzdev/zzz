use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::db::{
    AccountRow, ActorRow, PermitRow,
    query_account_by_id, query_actor_by_account, query_permits_for_actor,
    query_session_get_valid, query_session_touch,
    query_validate_api_token, query_api_token_touch,
};
use fuz_common::JsonRpcError;

type HmacSha256 = Hmac<Sha256>;

// -- Keyring ------------------------------------------------------------------

/// Cookie signing keyring.
///
/// First key signs, all keys verify (supports key rotation).
/// Mirrors `fuz_app`'s `src/lib/auth/keyring.ts`.
pub struct Keyring {
    keys: Vec<Vec<u8>>,
}

const KEY_SEPARATOR: &str = "__";
const MIN_KEY_LENGTH: usize = 32;

impl Keyring {
    /// Create a keyring from `SECRET_COOKIE_KEYS` env value.
    ///
    /// Keys are separated by `__`. First key signs, all verify.
    /// Returns `None` if no valid keys.
    pub fn new(env_value: &str) -> Option<Self> {
        let keys: Vec<Vec<u8>> = env_value
            .split(KEY_SEPARATOR)
            .filter(|k| !k.is_empty())
            .map(|k| k.as_bytes().to_vec())
            .collect();

        if keys.is_empty() {
            return None;
        }
        Some(Self { keys })
    }

    /// Validate key configuration. Returns errors if any.
    pub fn validate(env_value: &str) -> Vec<String> {
        let keys: Vec<&str> = env_value
            .split(KEY_SEPARATOR)
            .filter(|k| !k.is_empty())
            .collect();

        if keys.is_empty() {
            return vec!["SECRET_COOKIE_KEYS is required".to_owned()];
        }

        let mut errors = Vec::new();
        for (i, key) in keys.iter().enumerate() {
            if key.len() < MIN_KEY_LENGTH {
                errors.push(format!(
                    "Key {} is too short ({} chars, min {MIN_KEY_LENGTH})",
                    i + 1,
                    key.len()
                ));
            }
        }
        errors
    }

    /// Sign a value with HMAC-SHA256 using the primary (first) key.
    ///
    /// Returns `value.base64(signature)`.
    #[allow(clippy::expect_used)] // HMAC-SHA256 accepts any key length
    pub fn sign(&self, value: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(&self.keys[0]).expect("HMAC key length is always valid");
        mac.update(value.as_bytes());
        let signature = mac.finalize().into_bytes();
        let sig_b64 = BASE64.encode(signature);
        format!("{value}.{sig_b64}")
    }

    /// Verify a signed value. Tries all keys for rotation support.
    ///
    /// Returns `(original_value, key_index)` or `None` if invalid.
    #[allow(clippy::expect_used)] // HMAC-SHA256 accepts any key length
    pub fn verify(&self, signed_value: &str) -> Option<(String, usize)> {
        let dot_index = signed_value.rfind('.')?;
        let value = &signed_value[..dot_index];
        let sig_b64 = &signed_value[dot_index + 1..];

        let signature = BASE64.decode(sig_b64).ok()?;

        for (i, key) in self.keys.iter().enumerate() {
            let mut mac =
                HmacSha256::new_from_slice(key).expect("HMAC key length is always valid");
            mac.update(value.as_bytes());
            if mac.verify_slice(&signature).is_ok() {
                return Some((value.to_owned(), i));
            }
        }
        None
    }
}

// -- Cookie parsing -----------------------------------------------------------

/// Cookie name for session cookies (matches `fuz_app`'s `fuz_session`).
pub const SESSION_COOKIE_NAME: &str = "fuz_session";

/// Cookie max age in seconds (30 days — aligned with `AUTH_SESSION_LIFETIME_MS`).
pub const SESSION_AGE_MAX: u64 = 60 * 60 * 24 * 30;

/// Separator between identity payload and `expires_at` in the cookie value.
const VALUE_SEPARATOR: char = ':';

/// Parse the session token from a Cookie header value.
///
/// Extracts the `fuz_session` cookie, verifies its HMAC signature,
/// checks expiration, and returns the raw session token.
pub fn parse_session_from_cookies(cookie_header: &str, keyring: &Keyring) -> Option<String> {
    // Find the fuz_session cookie value
    let signed_value = extract_cookie_value(cookie_header, SESSION_COOKIE_NAME)?;

    // Verify signature
    let (value, _key_index) = keyring.verify(signed_value)?;

    // Split on last ':' to get identity and expires_at
    let last_sep = value.rfind(VALUE_SEPARATOR)?;
    let identity = &value[..last_sep];
    let expires_at_str = &value[last_sep + 1..];

    // Check expiration (cookie timestamps are always positive and fit in u64)
    let expires_at: u64 = expires_at_str.parse().ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if expires_at <= now {
        return None;
    }

    // Identity is the raw session token
    if identity.is_empty() {
        return None;
    }

    Some(identity.to_owned())
}

/// Extract a named cookie value from a Cookie header string.
///
/// Handles the `name=value; name2=value2` format.
fn extract_cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some(rest) = trimmed.strip_prefix(name)
            && let Some(value) = rest.strip_prefix('=') {
                return Some(value);
            }
    }
    None
}

/// Hash a session token to its storage key using blake3.
///
/// Mirrors `fuz_app`'s `hash_session_token` from `session_queries.ts`.
pub fn hash_session_token(token: &str) -> String {
    blake3::hash(token.as_bytes()).to_hex().to_string()
}

// -- Auth errors --------------------------------------------------------------

/// Errors from building a request context (pool or query failures).
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("pool error: {0}")]
    Pool(#[from] deadpool_postgres::PoolError),
    #[error("query error: {0}")]
    Query(#[from] tokio_postgres::Error),
}

// -- Credential type ----------------------------------------------------------

/// How the request was authenticated.
///
/// Mirrors `fuz_app`'s `credential_type` context key:
/// - `Session` — cookie-based session (`fuz_session`)
/// - `ApiToken` — `Authorization: Bearer <token>` looked up in `api_token` table
/// - `DaemonToken` — `X-Daemon-Token` header (not yet implemented in Rust)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialType {
    Session,
    ApiToken,
    DaemonToken,
}

// -- Request context ----------------------------------------------------------

/// Authenticated request context — account + actor + active permits.
///
/// Built from a valid session cookie. Passed to handlers via `Ctx`.
#[derive(Debug, Clone)]
pub struct RequestContext {
    pub account: AccountRow,
    pub actor: ActorRow,
    pub permits: Vec<PermitRow>,
}

impl RequestContext {
    /// Check if this context has an active permit for the given role.
    pub fn has_role(&self, role: &str) -> bool {
        self.permits.iter().any(|p| p.role == role)
    }
}

/// Build a `RequestContext` from a session token.
///
/// Pipeline: cookie → verify signature → hash token → session lookup →
/// account → actor → permits.
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

    // Build context: account → actor → permits
    let account = query_account_by_id(&client, &session.account_id).await?;

    let Some(account) = account else {
        return Ok(None);
    };

    let actor = query_actor_by_account(&client, &account.id).await?;

    let Some(actor) = actor else {
        return Ok(None);
    };

    let permits = query_permits_for_actor(&client, &actor.id).await?;

    // Touch session (fire-and-forget — don't block the request)
    let touch_pool = pool.clone();
    let touch_hash = token_hash.clone();
    tokio::spawn(async move {
        if let Ok(client) = touch_pool.get().await
            && let Err(e) = query_session_touch(&client, &touch_hash).await {
                tracing::warn!(error = %e, "session touch failed");
            }
    });

    Ok(Some(RequestContext {
        account,
        actor,
        permits,
    }))
}

// -- Per-action auth check ----------------------------------------------------

/// Auth level for an action spec.
///
/// Mirrors the `auth` field from zzz's `action_specs.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionAuth {
    /// No auth required.
    Public,
    /// Must have a valid session.
    Authenticated,
    /// Must have keeper role. In `fuz_app` this requires `daemon_token`
    /// credential type; the Rust backend checks keeper permit on cookie sessions.
    Keeper,
}

/// JSON-RPC error codes for auth failures.
///
/// Matches `fuz_app/src/lib/http/jsonrpc_errors.ts`:
/// - unauthenticated: -32001 → HTTP 401
/// - forbidden: -32002 → HTTP 403
const JSONRPC_UNAUTHENTICATED: i32 = -32001;
const JSONRPC_FORBIDDEN: i32 = -32002;

/// Check per-action auth.
///
/// Returns `None` if authorized, `Some(error)` if not.
/// Mirrors `fuz_app`'s `check_action_auth` from `action_rpc.ts` and
/// the keeper check from `register_websocket_actions.ts`.
///
/// Keeper actions require both `daemon_token` credential type AND the
/// keeper role permit — API tokens with keeper permit are rejected.
pub fn check_action_auth(
    auth: ActionAuth,
    context: Option<&RequestContext>,
    credential_type: Option<CredentialType>,
) -> Option<JsonRpcError> {
    match auth {
        ActionAuth::Public => None,
        ActionAuth::Authenticated => {
            if context.is_some() {
                None
            } else {
                Some(JsonRpcError {
                    code: JSONRPC_UNAUTHENTICATED,
                    message: "unauthenticated".to_owned(),
                    data: None,
                })
            }
        }
        ActionAuth::Keeper => {
            let Some(ctx) = context else {
                return Some(JsonRpcError {
                    code: JSONRPC_UNAUTHENTICATED,
                    message: "unauthenticated".to_owned(),
                    data: None,
                });
            };
            // Keeper actions require daemon_token credential type AND keeper role.
            // API tokens and session cookies cannot access keeper actions even if
            // the account has the keeper permit.
            if credential_type != Some(CredentialType::DaemonToken)
                || !ctx.has_role("keeper")
            {
                Some(JsonRpcError {
                    code: JSONRPC_FORBIDDEN,
                    message: "forbidden".to_owned(),
                    data: None,
                })
            } else {
                None
            }
        }
    }
}

/// Get the auth level for a method name.
///
/// Mirrors the `auth` field from each action spec in `action_specs.ts`.
pub fn method_auth(method: &str) -> ActionAuth {
    match method {
        "ping" => ActionAuth::Public,

        // All other implemented methods require authentication
        "workspace_list" | "workspace_open" | "workspace_close" | "session_load"
        | "diskfile_update" | "diskfile_delete" | "directory_create"
        | "completion_create" | "ollama_list" | "ollama_ps" | "ollama_show"
        | "ollama_pull" | "ollama_delete" | "ollama_copy" | "ollama_create"
        | "ollama_unload" | "provider_load_status"
        | "terminal_create" | "terminal_data_send" | "terminal_resize" | "terminal_close" => {
            ActionAuth::Authenticated
        }

        "provider_update_api_key" => ActionAuth::Keeper,

        // Unknown methods — will hit method_not_found in dispatch anyway,
        // but require auth so we don't leak method existence to unauthenticated callers
        _ => ActionAuth::Authenticated,
    }
}

// -- Origin verification ------------------------------------------------------

/// Check if a request origin is allowed.
///
/// Supports patterns: exact match, `http://localhost:*` (any port),
/// `https://*.example.com` (subdomain wildcard).
pub fn check_origin(origin: &str, allowed_patterns: &[String]) -> bool {
    if allowed_patterns.is_empty() {
        return true; // no restriction configured
    }

    for pattern in allowed_patterns {
        if pattern == origin {
            return true;
        }
        // Wildcard port: http://localhost:*
        if let Some(prefix) = pattern.strip_suffix(":*")
            && let Some(rest) = origin.strip_prefix(prefix)
                && rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit()) {
                    return true;
                }
        // Subdomain wildcard: https://*.example.com
        if let Some(suffix) = pattern.strip_prefix("https://*.")
            && let Some(host) = origin.strip_prefix("https://")
                && host.ends_with(suffix)
                    && host.len() > suffix.len()
                    && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
                {
                    return true;
                }
    }
    false
}

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
    /// How this request was authenticated.
    pub credential_type: CredentialType,
}

pub async fn resolve_auth_from_headers(
    headers: &axum::http::HeaderMap,
    keyring: &Keyring,
    pool: &deadpool_postgres::Pool,
) -> Option<ResolvedAuth> {
    // Try cookie auth first
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
    let cookie_header = headers
        .get(axum::http::header::COOKIE)?
        .to_str()
        .ok()?;

    let session_token = parse_session_from_cookies(cookie_header, keyring)?;
    let token_hash = hash_session_token(&session_token);

    match build_request_context(pool, &session_token).await {
        Ok(Some(context)) => Some(ResolvedAuth {
            context,
            token_hash: Some(token_hash),
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

    let permits = match query_permits_for_actor(&client, &actor.id).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "bearer auth permits query failed");
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
            permits,
        },
        token_hash: None, // bearer connections have no session token_hash
        credential_type: CredentialType::ApiToken,
    })
}

/// Parse `ALLOWED_ORIGINS` env value into a list of patterns.
pub fn parse_allowed_origins(env_value: &str) -> Vec<String> {
    env_value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}
