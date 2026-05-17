//! Per-action auth spec — credential type / role gates, origin allowlist,
//! REST credential-channel gate.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use fuz_common::JsonRpcError;
use serde::Serialize;

use super::RequestContext;
use super::resolve::ResolvedAuth;

// -- Credential type ----------------------------------------------------------

/// How the request was authenticated.
///
/// Mirrors `fuz_app`'s `credential_type` context key:
/// - `Session` — cookie-based session (`fuz_session`)
/// - `ApiToken` — `Authorization: Bearer <token>` looked up in `api_token` table
/// - `DaemonToken` — `X-Daemon-Token` header with timing-safe validation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialType {
    Session,
    ApiToken,
    DaemonToken,
}

impl CredentialType {
    /// Wire-format name matching `fuz_app`'s `CREDENTIAL_TYPE_*` literals.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::ApiToken => "api_token",
            Self::DaemonToken => "daemon_token",
        }
    }
}

// -- Per-action auth check ----------------------------------------------------

/// Authentication tier for an action spec — the 401 axis.
///
/// Mirrors `fuz_app`'s `RouteAuth.account` axis collapsed to the two
/// shapes zzz uses today: anonymous (`Public`) or any valid credential
/// (`Authenticated`). Role and credential-type gates are separate axes
/// on [`MethodSpec`], not packed into this enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionAuth {
    /// No auth required.
    Public,
    /// Must have a valid credential of some kind. Refine further with
    /// `MethodSpec.credential_types` / `MethodSpec.roles`.
    Authenticated,
}

/// Spec-derived facts about a method — auth tier, credential-type
/// allowlist, role requirements, and DB-transaction need. Mirrors the
/// `{auth, credential_types, roles, side_effects}` axes of `fuz_app`'s
/// `ActionSpec`. Looked up via [`method_spec`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MethodSpec {
    pub auth: ActionAuth,
    /// `Some(types)` → credential gate restricts to those types
    /// (`credential_type_required` + `required_credential_types` on
    /// failure). `None` → any credential type permitted.
    pub credential_types: Option<&'static [CredentialType]>,
    /// `Some(roles)` → caller must hold one of these roles (any-of)
    /// (`insufficient_permissions` + `required_roles` on failure).
    /// `None` → no role check.
    pub roles: Option<&'static [&'static str]>,
    /// `true` → dispatcher wraps the handler in a DB transaction. Mirrors
    /// `fuz_app`'s `ActionSpec.side_effects` and its `perform_action`
    /// `db.transaction` wrap.
    pub side_effects: bool,
}

/// JSON-RPC error codes for auth failures.
///
/// Matches `fuz_app/src/lib/http/jsonrpc_errors.ts`:
/// - unauthenticated: -32001 → HTTP 401
/// - forbidden: -32002 → HTTP 403
const JSONRPC_UNAUTHENTICATED: i32 = -32001;
const JSONRPC_FORBIDDEN: i32 = -32002;

/// Check per-action auth against a method's [`MethodSpec`].
///
/// Returns `None` if authorized, `Some(error)` if not. Mirrors `fuz_app`'s
/// `check_action_auth_post_authorization` in `perform_action.ts`:
///
/// 1. **401 — authentication**. `Authenticated` requires a context.
/// 2. **403 — credential-type gate**. When `spec.credential_types` is
///    set, the request's credential type must be in the allowlist;
///    failure emits `credential_type_required` + `required_credential_types`.
/// 3. **403 — role gate**. When `spec.roles` is set, the request context
///    must hold one of the named roles; failure emits
///    `insufficient_permissions` + `required_roles`.
///
/// Keeper composes both gates declaratively as
/// `credential_types: ['daemon_token']` + `roles: ['keeper']` —
/// no special-case arm.
pub fn check_action_auth(
    spec: &MethodSpec,
    context: Option<&RequestContext>,
    credential_type: Option<CredentialType>,
) -> Option<JsonRpcError> {
    match spec.auth {
        ActionAuth::Public => {}
        ActionAuth::Authenticated => {
            if context.is_none() {
                return Some(JsonRpcError {
                    code: JSONRPC_UNAUTHENTICATED,
                    message: "unauthenticated".to_owned(),
                    data: None,
                });
            }
        }
    }

    if let Some(required) = spec.credential_types {
        let satisfied = credential_type.is_some_and(|ct| required.contains(&ct));
        if !satisfied {
            let names: Vec<&'static str> = required.iter().map(|c| c.name()).collect();
            return Some(JsonRpcError {
                code: JSONRPC_FORBIDDEN,
                message: "forbidden".to_owned(),
                data: Some(serde_json::json!({
                    "reason": "credential_type_required",
                    "required_credential_types": names,
                })),
            });
        }
    }

    if let Some(required_roles) = spec.roles {
        let has_required =
            context.is_some_and(|ctx| required_roles.iter().any(|r| ctx.has_role(r)));
        if !has_required {
            return Some(JsonRpcError {
                code: JSONRPC_FORBIDDEN,
                message: "forbidden".to_owned(),
                data: Some(serde_json::json!({
                    "reason": "insufficient_permissions",
                    "required_roles": required_roles,
                })),
            });
        }
    }

    None
}

/// Per-method spec lookup — single source of truth for the four
/// dispatch-relevant axes (`auth`, `credential_types`, `roles`,
/// `side_effects`). Mirrors `fuz_app`'s `ActionSpec` shape; one match
/// keeps the row for a method readable end-to-end instead of fanning
/// across parallel functions.
///
/// **Gate rationale**:
///
/// - **`credential_types: ['session']`** on the four account-mutation
///   methods (`account_token_create`, `account_token_revoke`,
///   `account_session_revoke`, `account_session_revoke_all`) closes
///   the bearer-self-service threat: a leaked `api_token` can't mint
///   sibling tokens, revoke its siblings, or lock the user out by
///   revoking sessions. Admin equivalents (`admin_session_revoke_all`,
///   `admin_token_revoke_all`) are deliberately *not* credential-gated —
///   admin CLI scripting via bearer is a legitimate operator workflow.
///   The role gate (`roles: ['admin']`) is the only check above
///   `Authenticated` for admin methods. The REST `POST /api/account/password`
///   route enforces the same session-only gate at its own handler
///   (see `account::password_inner`).
///
/// - **`credential_types: ['daemon_token']` + `roles: ['keeper']`** on
///   `provider_update_api_key` composes the keeper requirement: the
///   credential must come over the filesystem-readable daemon-token
///   channel AND the account must hold the keeper role grant. Matches
///   `fuz_app`'s keeper shape (`{roles: ['keeper'], credential_types: ['daemon_token']}`).
#[allow(clippy::match_same_arms)] // Read-only auth'd reads and the unknown-method catch-all
// share the same MethodSpec shape but are conceptually distinct;
// keeping the unknown-method arm explicit makes the
// "fail-closed: unknown methods still require auth"
// invariant visible at the call site.
pub fn method_spec(method: &str) -> MethodSpec {
    const SESSION_ONLY: &[CredentialType] = &[CredentialType::Session];
    const DAEMON_TOKEN_ONLY: &[CredentialType] = &[CredentialType::DaemonToken];
    const KEEPER_ROLE: &[&str] = &["keeper"];
    const ADMIN_ROLE: &[&str] = &["admin"];

    let (auth, credential_types, roles, side_effects) = match method {
        // Public — no auth required, no side effects.
        "ping" => (ActionAuth::Public, None, None, false),

        // Authenticated reads — no transaction wrap.
        "session_load"
        | "workspace_list"
        | "provider_load_status"
        | "account_verify"
        | "account_session_list"
        | "account_token_list" => (ActionAuth::Authenticated, None, None, false),

        // Authenticated writes — wrap in db.transaction.
        "workspace_open" | "workspace_close" | "diskfile_update" | "diskfile_delete"
        | "directory_create" | "completion_create" | "terminal_create" | "terminal_data_send"
        | "terminal_resize" | "terminal_close" => (ActionAuth::Authenticated, None, None, true),

        // Authenticated ollama actions — read-only (no DB side effects on the
        // zzz_server side; the Ollama daemon is a separate process).
        "ollama_list" | "ollama_ps" | "ollama_show" | "ollama_pull" | "ollama_delete"
        | "ollama_copy" | "ollama_create" | "ollama_unload" => {
            (ActionAuth::Authenticated, None, None, false)
        }

        // Credential-channel gated account mutations (see fn-level docs).
        "account_token_create"
        | "account_token_revoke"
        | "account_session_revoke"
        | "account_session_revoke_all" => {
            (ActionAuth::Authenticated, Some(SESSION_ONLY), None, true)
        }

        // Keeper — composed credential gate + role gate (see fn-level docs).
        "provider_update_api_key" => (
            ActionAuth::Authenticated,
            Some(DAEMON_TOKEN_ONLY),
            Some(KEEPER_ROLE),
            true,
        ),

        // Admin role-gated mutations — bearer is permitted (no
        // `credential_types` restriction); only `roles: ['admin']` plus
        // `Authenticated` gate access. See fn-level docs.
        "admin_session_revoke_all" | "admin_token_revoke_all" => (
            ActionAuth::Authenticated,
            None,
            Some(ADMIN_ROLE),
            true,
        ),

        // Unknown methods (including `_test_*` when `ZZZ_ENABLE_TEST_ACTIONS`
        // is unset) — will hit method_not_found in dispatch, but require auth
        // so we don't leak method existence to unauthenticated callers. No
        // transaction so method_not_found doesn't pay the cost of one.
        _ => (ActionAuth::Authenticated, None, None, false),
    };

    MethodSpec {
        auth,
        credential_types,
        roles,
        side_effects,
    }
}

// -- Origin verification ------------------------------------------------------

/// Inspect a request's `Origin` header against the configured allowlist.
///
/// Returns `true` when:
/// - No `Origin` header was sent (`curl`, CLI, server-side tooling — the
///   primary control on those flows is bearer/daemon-token auth, not
///   origin pinning), OR
/// - The `Origin` is present AND matches `allowed_patterns`.
///
/// Returns `false` only when `Origin` is present AND fails the allowlist.
/// Callers translate `false` into the transport-appropriate 403 response
/// (plain-text on `/api/rpc`, JSON-error on REST routes).
///
/// ## Origin-only by design
///
/// fuz_app's `verify_request_source` currently also falls back to
/// `Referer` when `Origin` is absent. The Rust port intentionally
/// omits the Referer arm — per the Fetch spec, modern browsers send
/// `Origin` unconditionally on every unsafe method (POST/PUT/DELETE/
/// PATCH) regardless of `Referrer-Policy`, so on state-changing routes
/// the Referer fallback never fires from a real browser. It only
/// triggers for non-browser clients (curl, server-to-server) which
/// don't have an auto-attached session cookie anyway, so CSRF isn't
/// the relevant threat there — auth (bearer / daemon token) is the
/// actual control. The fuz_app fallback is mostly inert today; it's
/// tracked for removal in `grimoire/lore/fuz_app/TODO_PROXY.md` so
/// fuz_app converges DOWN to this Origin-only posture rather than
/// Rust adopting the looser shape.
pub fn is_request_origin_allowed(
    headers: &axum::http::HeaderMap,
    allowed_patterns: &[String],
) -> bool {
    match headers.get("origin").and_then(|v| v.to_str().ok()) {
        Some(origin) => check_origin(origin, allowed_patterns),
        None => true,
    }
}

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
            && rest.starts_with(':')
            && rest[1..].chars().all(|c| c.is_ascii_digit())
        {
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

/// Parse `ALLOWED_ORIGINS` env value into a list of patterns.
pub fn parse_allowed_origins(env_value: &str) -> Vec<String> {
    env_value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

// -- REST credential-channel gate ---------------------------------------------

/// 403 body shape for REST routes that enforce a credential-type allowlist.
///
/// Mirrors `fuz_app`'s `require_credential_types` middleware: `{error,
/// required_credential_types}`. The RPC sibling lives in
/// [`check_action_auth`] above — same enum, same wire literal
/// ([`CredentialType::name`]), different envelope (REST is a flat 403 body,
/// RPC is a JSON-RPC `forbidden` error with `data.required_credential_types`).
#[derive(Serialize)]
struct CredentialTypeRequiredBody {
    error: &'static str,
    required_credential_types: &'static [&'static str],
}

/// Build a 403 `credential_type_required` response with the supplied allowlist.
///
/// Co-located with [`check_action_auth`] so the REST and RPC credential
/// gates anchor to the same module.
pub fn credential_type_required_response(required: &'static [&'static str]) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(CredentialTypeRequiredBody {
            error: "credential_type_required",
            required_credential_types: required,
        }),
    )
        .into_response()
}

/// Enforce the session-only credential-channel gate on a REST route.
///
/// Returns `Ok(())` when the request authenticated via cookie session;
/// `Err(response)` with the 403 [`credential_type_required_response`] for
/// bearer / daemon-token callers. Used by `POST /api/account/password`
/// today; mirrors the RPC-side gate produced by `MethodSpec.credential_types
/// = ['session']` running through [`check_action_auth`].
// `Err` carries an `axum::Response` (~128 bytes) so `?` composes with the
// REST handler's existing `Result<Response, Response>` flow without boxing.
#[allow(clippy::result_large_err)]
pub fn enforce_session_only(resolved: &ResolvedAuth) -> Result<(), Response> {
    if resolved.credential_type == CredentialType::Session {
        Ok(())
    } else {
        Err(credential_type_required_response(&["session"]))
    }
}

#[cfg(test)]
mod origin_tests {
    use super::*;
    use axum::http::HeaderMap;

    fn headers_with_origin(origin: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("origin", origin.parse().unwrap());
        h
    }

    #[test]
    fn allowed_when_no_origin_header() {
        // CLI / curl / server-side tooling — primary control is auth,
        // not origin pinning. Must not 403 these.
        let headers = HeaderMap::new();
        assert!(is_request_origin_allowed(
            &headers,
            &["https://app.example.com".to_owned()]
        ));
    }

    #[test]
    fn allowed_when_empty_patterns() {
        // Empty allowlist = no restriction (matches `check_origin`'s
        // contract). Origin presence shouldn't flip the decision.
        let headers = headers_with_origin("https://anywhere.example.com");
        assert!(is_request_origin_allowed(&headers, &[]));
    }

    #[test]
    fn rejected_when_origin_not_in_patterns() {
        let headers = headers_with_origin("https://evil.example.com");
        assert!(!is_request_origin_allowed(
            &headers,
            &["https://app.example.com".to_owned()]
        ));
    }

    #[test]
    fn allowed_when_origin_exact_match() {
        let headers = headers_with_origin("https://app.example.com");
        assert!(is_request_origin_allowed(
            &headers,
            &["https://app.example.com".to_owned()]
        ));
    }

    #[test]
    fn allowed_when_origin_matches_port_wildcard() {
        let headers = headers_with_origin("http://localhost:5173");
        assert!(is_request_origin_allowed(
            &headers,
            &["http://localhost:*".to_owned()]
        ));
    }

    #[test]
    fn allowed_when_origin_matches_subdomain_wildcard() {
        let headers = headers_with_origin("https://staging.fuz.dev");
        assert!(is_request_origin_allowed(
            &headers,
            &["https://*.fuz.dev".to_owned()]
        ));
    }

    #[test]
    fn allowed_when_origin_header_unparseable() {
        // Headers crate enforces visible-ASCII on insert, so this path
        // is mostly unreachable in production. The helper falls back
        // to "no Origin → allowed" via `.to_str().ok()` returning
        // `None`. Lock that semantic so a future header-type swap
        // doesn't silently flip it.
        let mut h = HeaderMap::new();
        // Insert a bytes value that `to_str()` can't decode.
        h.insert(
            "origin",
            axum::http::HeaderValue::from_bytes(b"\xFF\xFE invalid").unwrap(),
        );
        assert!(is_request_origin_allowed(
            &h,
            &["https://app.example.com".to_owned()]
        ));
    }
}
