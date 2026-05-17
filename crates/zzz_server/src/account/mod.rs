//! Account REST routes (status, login, logout, password change).
//!
//! Submodules:
//! - [`status`] — `GET /api/account/status`
//! - [`login`] — `POST /api/account/login`
//! - [`logout`] — `POST /api/account/logout`
//! - [`password`] — `POST /api/account/password`
//!
//! Shared helpers (session token + cookie helpers, password hashing,
//! rate-limit / error responses) live here so each handler module can
//! pull them via `use super::*`.

pub mod login;
pub mod logout;
pub mod password;
pub mod status;

pub use login::login_handler;
pub use logout::logout_handler;
pub use password::password_handler;
pub use status::status_handler;

use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier, SaltString};
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use rand::RngExt;
use serde::{Deserialize, Serialize};

use crate::auth::{self, SESSION_AGE_MAX, SESSION_COOKIE_NAME};

// -- Shared helpers -----------------------------------------------------------

/// Current time in seconds since epoch.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Generate a cryptographically random session token (base64url, 32 bytes).
pub fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Build a signed `Set-Cookie` header value for a session.
pub fn sign_session_cookie(keyring: &auth::Keyring, session_token: &str) -> String {
    let cookie_value = keyring.sign(&format!("{session_token}:{}", now_secs() + SESSION_AGE_MAX));
    format!(
        "{SESSION_COOKIE_NAME}={cookie_value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={SESSION_AGE_MAX}"
    )
}

/// Build a `Set-Cookie` header that clears the session cookie.
pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0")
}

/// Short error response constructor.
pub fn error_json(status: StatusCode, error: &str) -> Response {
    (
        status,
        Json(ErrorBody {
            error: error.to_owned(),
        }),
    )
        .into_response()
}

/// Build a 429 rate-limit-exceeded response with `Retry-After` header.
///
/// Mirrors `fuz_app`'s `rate_limit_exceeded_response` shape:
/// `{error: 'rate_limit_exceeded', retry_after: <secs>}` plus the
/// `Retry-After: <secs>` header so well-behaved clients back off
/// without parsing the body.
pub fn rate_limit_exceeded(retry_after: u64) -> Response {
    let mut headers = HeaderMap::new();
    if let Ok(val) = retry_after.to_string().parse() {
        headers.insert(axum::http::header::RETRY_AFTER, val);
    }
    (
        StatusCode::TOO_MANY_REQUESTS,
        headers,
        Json(RateLimitErrorBody {
            error: "rate_limit_exceeded".to_owned(),
            retry_after,
        }),
    )
        .into_response()
}

#[derive(Serialize)]
struct RateLimitErrorBody {
    error: String,
    retry_after: u64,
}

/// Dummy Argon2 hash for enumeration prevention — run argon2 verify against
/// a known hash when the account doesn't exist, so timing is consistent.
pub const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// -- Types --------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginInput {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct PasswordInput {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Serialize)]
pub struct ErrorBody {
    error: String,
}

#[derive(Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

/// Verify a password against an Argon2 hash on a blocking thread.
///
/// Returns `false` on any error (hash parse failure, wrong password, task panic).
pub async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        let Ok(parsed) = argon2::PasswordHash::new(&hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
    .await
    .unwrap_or(false)
}

/// Hash a password with Argon2id on a blocking thread.
pub async fn hash_password(password: String) -> Result<String, argon2::password_hash::Error> {
    tokio::task::spawn_blocking(move || {
        // Generate 16 random bytes for the salt (standard Argon2 salt size),
        // then encode as base64 for SaltString.
        let mut salt_bytes = [0u8; 16];
        rand::rng().fill(&mut salt_bytes);
        let salt = SaltString::encode_b64(&salt_bytes).map_err(|_| {
            argon2::password_hash::Error::SaltInvalid(
                argon2::password_hash::errors::InvalidValue::Malformed,
            )
        })?;
        let argon2 = Argon2::default();
        let hash = argon2.hash_password(password.as_bytes(), &salt)?;
        Ok(hash.to_string())
    })
    .await
    .unwrap_or(Err(argon2::password_hash::Error::Algorithm))
}
