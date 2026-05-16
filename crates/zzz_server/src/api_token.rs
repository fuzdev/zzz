//! API token generation utilities.
//!
//! Mirrors `fuz_app`'s `src/lib/auth/api_token.ts` so tokens issued by
//! either backend interoperate at the wire level. A token validated by
//! the Deno backend must validate the same way on Rust and vice versa.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngExt;

/// Prefix on every raw token (enables secret scanners to match the literal).
pub const API_TOKEN_PREFIX: &str = "secret_fuz_token_";

/// Prefix on the public token id (e.g. `tok_abC0_d-3xyzA`).
pub const API_TOKEN_ID_PREFIX: &str = "tok_";

/// Number of base64url chars taken from the raw token body for the public id.
const ID_PREFIX_LEN: usize = 12;

/// Number of random bytes encoded into the raw token body (matches `fuz_app`
/// default — 32 bytes / 256 bits of entropy).
const TOKEN_ENTROPY_BYTES: usize = 32;

/// A freshly generated API token.
pub struct GeneratedApiToken {
    /// Raw token — shown to the user exactly once. Wire format:
    /// `secret_fuz_token_<base64url(32 bytes, no padding)>`.
    pub token: String,
    /// Public id — wire format: `tok_<first 12 chars of base64url body>`.
    pub id: String,
    /// `blake3` hex digest of `token` — what gets stored in `api_token.token_hash`.
    pub token_hash: String,
}

/// Generate a new API token.
///
/// Byte-compatible with `fuz_app`'s `generate_api_token` so tokens issued on
/// either backend round-trip through the other's `query_validate_api_token`.
pub fn generate_api_token() -> GeneratedApiToken {
    let mut bytes = [0u8; TOKEN_ENTROPY_BYTES];
    rand::rng().fill(&mut bytes);
    let raw = URL_SAFE_NO_PAD.encode(bytes);
    let token = format!("{API_TOKEN_PREFIX}{raw}");
    let token_hash = blake3::hash(token.as_bytes()).to_hex().to_string();
    let id_body: String = raw.chars().take(ID_PREFIX_LEN).collect();
    let id = format!("{API_TOKEN_ID_PREFIX}{id_body}");
    GeneratedApiToken {
        token,
        id,
        token_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_matches_fuz_app_shape() {
        let g = generate_api_token();

        // Raw token: prefix + 32-byte base64url body (43 chars unpadded).
        assert!(g.token.starts_with(API_TOKEN_PREFIX));
        let body = &g.token[API_TOKEN_PREFIX.len()..];
        assert_eq!(body.len(), 43, "body of 32 random bytes base64url-encoded");
        assert!(
            body.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );

        // Public id: tok_ + 12 chars of body.
        assert!(g.id.starts_with(API_TOKEN_ID_PREFIX));
        assert_eq!(g.id.len(), API_TOKEN_ID_PREFIX.len() + ID_PREFIX_LEN);
        assert_eq!(&g.id[API_TOKEN_ID_PREFIX.len()..], &body[..ID_PREFIX_LEN]);

        // Hash: blake3 hex of the full token.
        assert_eq!(g.token_hash.len(), 64);
        assert_eq!(
            g.token_hash,
            blake3::hash(g.token.as_bytes()).to_hex().to_string()
        );
    }

    #[test]
    fn generated_tokens_are_unique() {
        let a = generate_api_token();
        let b = generate_api_token();
        assert_ne!(a.token, b.token);
        assert_ne!(a.id, b.id);
        assert_ne!(a.token_hash, b.token_hash);
    }
}
