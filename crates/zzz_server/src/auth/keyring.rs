//! Cookie signing keyring + session-cookie parsing + session-token hashing.
//!
//! Pure crypto / parsing surface — no DB or daemon-token state.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use hmac::{Hmac, Mac};
use sha2::Sha256;

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
            let mut mac = HmacSha256::new_from_slice(key).expect("HMAC key length is always valid");
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
            && let Some(value) = rest.strip_prefix('=')
        {
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
