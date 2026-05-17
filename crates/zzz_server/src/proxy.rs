//! Trusted-proxy configuration + client IP resolution.
//!
//! Ports `fuz_app`'s `http/proxy.ts` to Rust: parses trusted-proxy entries
//! (IPv4, IPv6, and CIDR ranges), validates IP literals defensively, and
//! resolves the real client IP from `X-Forwarded-For` by walking
//! right-to-left while skipping trusted proxies and malformed entries.
//!
//! Without this module's middleware mounted on the router, every request
//! keys on the TCP peer IP from `ConnectInfo<SocketAddr>` — fine for
//! direct-bind deployments, but behind a reverse proxy every real client
//! looks like the proxy itself, so the rate-limit bucket trips across all
//! clients and the audit row carries the proxy IP instead of the
//! originator.
//!
//! ## Divergences from `fuz_app`'s `http/proxy.ts`
//!
//! Two deliberate parity inversions, both tightening the Rust side
//! relative to the TS source. Tracked in
//! `grimoire/lore/fuz_app/TODO_PROXY.md` for upstream convergence so
//! the divergences fold rather than persist.
//!
//! 1. **`normalize_ip` canonicalizes IPv6**. The Rust pipeline parses
//!    through `IpAddr::from_str` and re-emits via `addr.to_string()`
//!    (RFC 5952 canonical form), so `::1`, `::01`, `::0001`, and the
//!    fully-expanded `0:0:0:0:0:0:0:1` all produce one rate-limit
//!    bucket / `audit_log.ip` key for one address. The `::ffff:` strip
//!    moves AFTER the parse because Rust's `Ipv6Addr` Display emits
//!    the dotted IPv4-mapped notation for mapped addresses — without
//!    the reordering, `::ffff:0:0` (no dot) and `::ffff:0.0.0.0`
//!    (dotted) would diverge. fuz_app's `normalize_ip` doesn't
//!    canonicalize today, leaving the equivalent-forms-same-bucket
//!    contract un-guaranteed there.
//!
//! 2. **No `Referer` fallback in origin check** (see
//!    `crate::auth::is_request_origin_allowed`). fuz_app's
//!    `verify_request_source` checks `Origin` first then falls back
//!    to `Referer`; the Rust port is Origin-only. Per the Fetch
//!    spec, modern browsers send `Origin` unconditionally on every
//!    unsafe method (POST/PUT/DELETE/PATCH) regardless of
//!    `Referrer-Policy`, so the Referer arm never fires from a real
//!    browser on state-changing routes. Origin-only is the tighter
//!    posture without losing any CSRF protection.
//!
//! ## Strict-IP validation
//!
//! Rust's `std::net::IpAddr::from_str` is materially stricter than the
//! JS helpers `fuz_app`'s TS port defends against — it
//! already rejects bracketed forms (`[::1]:8080`), embedded whitespace
//! (`::1\n`, `::1 `), colon-injection (`attacker:controlled`), and
//! IPv4-with-port (`203.0.113.1:8080`). The two-layer guard inside
//! [`validate_ip_strict`] (character-set filter + parser round-trip)
//! is therefore mostly redundant on Rust, but kept verbatim with the
//! TS port so the rate-limit-key poisoning hole stays closed even if
//! a future refactor swaps the parser. The char-set filter also serves
//! as cheap fast-rejection on the hot path.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use axum::response::Response;

use crate::handlers::App;

// -- Types --------------------------------------------------------------------

/// IP address family. Used to keep CIDR matches from crossing families
/// (`0.0.0.0/0` must not match IPv6 addresses, and vice versa).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpFamily {
    V4,
    V6,
}

/// A parsed trusted-proxy entry — either an exact IP or a CIDR range.
///
/// `Cidr.network` carries the address bits widened to `u128` so IPv4 and
/// IPv6 share one match path. For IPv4 entries the low 32 bits hold the
/// network address; the upper 96 are zero.
#[derive(Debug, Clone)]
pub enum ParsedProxy {
    Ip(IpAddr),
    Cidr {
        network: u128,
        prefix: u8,
        family: IpFamily,
    },
}

/// Errors surfaced by [`parse_proxy_entry`] at server startup.
///
/// Variants mirror the diagnostics in `fuz_app`'s `parse_proxy_entry`
/// (`Invalid proxy IP`, `Invalid CIDR prefix (not a number)`, etc.) so
/// operators porting from the TS deployment see the same messages.
#[derive(Debug, thiserror::Error)]
pub enum ProxyParseError {
    #[error("invalid proxy IP: {0}")]
    InvalidIp(String),
    #[error("invalid CIDR prefix (not a number): {0}")]
    PrefixNaN(String),
    #[error("invalid CIDR prefix (negative): {0}")]
    PrefixNegative(String),
    #[error("invalid CIDR prefix (not an integer): {0}")]
    PrefixNotInteger(String),
    #[error("invalid CIDR prefix for IPv4 (max 32): {0}")]
    PrefixV4OutOfRange(String),
    #[error("invalid CIDR prefix for IPv6 (max 128): {0}")]
    PrefixV6OutOfRange(String),
    #[error("non-network-aligned CIDR (host bits set): {0}")]
    HostBitsSet(String),
    #[error("invalid proxy CIDR: {0}")]
    InvalidCidr(String),
}

/// Resolved client IP, stored in `request.extensions()` by
/// [`client_ip_middleware`]. Handlers read it via the `Extension` extractor.
///
/// Always populated when the middleware runs — when `trusted_proxies` is
/// empty, every connection's TCP peer IP fails `is_trusted_ip`, so the
/// XFF header is ignored and the resolved value is just the normalized
/// connection IP (preserving the Phase 4 direct-bind behavior).
#[derive(Debug, Clone)]
pub struct ClientIp(pub String);

// -- Normalization + validation ----------------------------------------------

/// Lowercase + strip `::ffff:` prefix on IPv4-mapped IPv6 + canonicalize
/// IPv6 representations.
///
/// Three-step pipeline:
///
/// 1. ASCII-lowercase. Necessary for both the `::ffff:` strip and the
///    parser round-trip below (consistent input).
/// 2. Strip `::ffff:` when the suffix contains `.` — IPv4-mapped IPv6
///    collapses to plain IPv4 so it matches v4-trusted-proxy entries
///    and rate-limit keys consistently.
/// 3. If the result parses as a real IP, return `IpAddr::to_string()` —
///    RFC 5952 canonical form (lowercase, zero-suppressed, longest-
///    `::`-run preferred). Closes the rate-limit-key poisoning surface
///    where `::1`, `::01`, and `0:0:0:0:0:0:0:1` would otherwise
///    produce three different bucket keys for the same address.
///
/// Idempotent. Safe on non-IP strings — `normalize_ip("unknown")`
/// returns `"unknown"` (the parser-canonicalize step is conditional on
/// successful parse).
///
/// ## Parity divergence with fuz_app
///
/// `fuz_app/src/lib/http/proxy.ts` does NOT canonicalize step 3. The
/// Rust port adds it because the rate-limit-key / audit-`ip` poisoning
/// surface behind a trusted-passthrough proxy is real on both
/// backends; closing it here while we're shipping the Rust port is
/// cheaper than later. Mirror this in fuz_app — tracked in
/// `grimoire/lore/fuz_app/TODO_PROXY.md` and `grimoire/lore/zzz/TODO.md`.
pub fn normalize_ip(ip: &str) -> String {
    let lowered = ip.to_ascii_lowercase();
    // Canonicalize first so equivalent IPv6 forms collapse to RFC 5952
    // BEFORE the `::ffff:` strip. Rust's `Ipv6Addr::Display` emits the
    // dotted IPv4-mapped form (`::ffff:a.b.c.d`) when applicable, so
    // `::ffff:0:0` (no dot) and `::ffff:0.0.0.0` (dotted) both
    // canonicalize to `::ffff:0.0.0.0` before stripping — without that
    // ordering, the dot-bearing input strips and the no-dot input
    // doesn't, diverging the two on the same address.
    let canonical = IpAddr::from_str(&lowered)
        .map_or_else(|_| lowered.clone(), |addr| addr.to_string());
    if let Some(rest) = canonical.strip_prefix("::ffff:")
        && rest.contains('.')
    {
        return rest.to_owned();
    }
    canonical
}

/// Strict IP validity check. Returns the address family on success,
/// `None` on any malformed input.
///
/// Two-layer guard, mirroring `fuz_app`'s `validate_ip_strict`:
///
/// 1. Character-set pre-filter (`0-9a-fA-F.:` only). Rejects port
///    suffixes, bracketed forms, embedded whitespace, control bytes —
///    cheap rejection on the hot path before allocator-touching parse.
/// 2. Round-trip through `IpAddr::from_str`. Confirms the literal
///    parses to a real address.
///
/// On Rust, layer 2 alone catches every shape `fuz_app`'s TS port adds
/// layer 1 to handle (Rust's parser is stricter than JS's).
/// The char-set filter is kept anyway as defense-in-depth + documented
/// intent: future parser-surface drift mustn't silently re-open the
/// rate-limit-key poisoning surface that motivated this guard in the
/// first place.
pub fn validate_ip_strict(ip: &str) -> Option<IpFamily> {
    if ip.is_empty() {
        return None;
    }
    if !ip.chars().all(is_ip_literal_char) {
        return None;
    }
    match IpAddr::from_str(ip) {
        Ok(IpAddr::V4(_)) => Some(IpFamily::V4),
        Ok(IpAddr::V6(_)) => Some(IpFamily::V6),
        Err(_) => None,
    }
}

const fn is_ip_literal_char(c: char) -> bool {
    matches!(c, '0'..='9' | 'a'..='f' | 'A'..='F' | '.' | ':')
}

// -- Parsing ------------------------------------------------------------------

/// Parse a trusted-proxy entry string into a [`ParsedProxy`].
///
/// Accepts plain IPs (`127.0.0.1`, `::1`) and CIDR notation
/// (`10.0.0.0/8`, `fe80::/10`). Plain IPs are normalized (lowercase,
/// `::ffff:` stripped on IPv4-mapped IPv6) and validated. CIDR prefixes
/// are validated against family bounds and the network address must be
/// network-aligned (host bits zero) — a non-aligned entry like
/// `10.0.0.5/8` is almost certainly a config mistake and refusing it
/// surfaces the error at startup instead of producing surprising match
/// results at runtime.
pub fn parse_proxy_entry(entry: &str) -> Result<ParsedProxy, ProxyParseError> {
    let Some(slash_index) = entry.find('/') else {
        let normalized = normalize_ip(entry);
        if validate_ip_strict(&normalized).is_none() {
            return Err(ProxyParseError::InvalidIp(entry.to_owned()));
        }
        let addr = IpAddr::from_str(&normalized)
            .map_err(|_| ProxyParseError::InvalidIp(entry.to_owned()))?;
        return Ok(ParsedProxy::Ip(addr));
    };

    let network_str = &entry[..slash_index];
    let prefix_str = &entry[slash_index + 1..];

    // Match fuz_app's exact prefix-parsing diagnostics: NaN before
    // negative before not-an-integer. The `.parse::<i32>()` already
    // rejects `8.5`, but reparsing the canonical form back to the
    // original input catches inputs like `08` whose canonical form
    // differs from the source — same posture as the TS port. The
    // `i32` intermediate is so negative inputs surface as
    // `PrefixNegative` rather than `PrefixNaN` (a `u8` parse would
    // collapse both into a single "not a number" diagnostic).
    let prefix: i32 = prefix_str
        .parse()
        .map_err(|_| ProxyParseError::PrefixNaN(entry.to_owned()))?;
    if prefix < 0 {
        return Err(ProxyParseError::PrefixNegative(entry.to_owned()));
    }
    if prefix.to_string() != prefix_str {
        return Err(ProxyParseError::PrefixNotInteger(entry.to_owned()));
    }

    let normalized_network = normalize_ip(network_str);
    let Some(family) = validate_ip_strict(&normalized_network) else {
        return Err(ProxyParseError::InvalidCidr(entry.to_owned()));
    };

    match family {
        IpFamily::V4 => {
            if prefix > 32 {
                return Err(ProxyParseError::PrefixV4OutOfRange(entry.to_owned()));
            }
            // Safe: prefix ∈ [0, 32] after the bound check above.
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "prefix bounded to 0..=32"
            )]
            let prefix_u8 = prefix as u8;
            let v4: Ipv4Addr = normalized_network
                .parse()
                .map_err(|_| ProxyParseError::InvalidCidr(entry.to_owned()))?;
            let network = u128::from(u32::from(v4));
            let host_mask: u128 = if prefix_u8 == 32 {
                0
            } else {
                (1u128 << (32 - prefix_u8)) - 1
            };
            if network & host_mask != 0 {
                return Err(ProxyParseError::HostBitsSet(entry.to_owned()));
            }
            Ok(ParsedProxy::Cidr {
                network,
                prefix: prefix_u8,
                family: IpFamily::V4,
            })
        }
        IpFamily::V6 => {
            if prefix > 128 {
                return Err(ProxyParseError::PrefixV6OutOfRange(entry.to_owned()));
            }
            // Safe: prefix ∈ [0, 128] after the bound check above.
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "prefix bounded to 0..=128"
            )]
            let prefix_u8 = prefix as u8;
            let v6: Ipv6Addr = normalized_network
                .parse()
                .map_err(|_| ProxyParseError::InvalidCidr(entry.to_owned()))?;
            let network = u128::from(v6);
            // `1u128 << 128` overflows (debug panic; release wraps,
            // silently accepting non-aligned /0 entries like `fe80::/0`
            // because host_mask collapses to 0). The /0 case has to be
            // special-cased so the shift width stays in [0, 127].
            let host_mask: u128 = match prefix_u8 {
                128 => 0,
                0 => u128::MAX,
                n => (1u128 << (128 - n)) - 1,
            };
            if network & host_mask != 0 {
                return Err(ProxyParseError::HostBitsSet(entry.to_owned()));
            }
            Ok(ParsedProxy::Cidr {
                network,
                prefix: prefix_u8,
                family: IpFamily::V6,
            })
        }
    }
}

/// Parse a comma-separated string of trusted-proxy entries.
///
/// Empty or whitespace-only entries are skipped silently — operators
/// can leave trailing commas or use empty strings to opt out without
/// startup errors. Any non-empty entry that fails to parse fails the
/// whole call so the misconfiguration surfaces at startup rather than
/// silently leaving a hole in the trust set.
pub fn parse_proxy_list(value: &str) -> Result<Vec<ParsedProxy>, ProxyParseError> {
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(parse_proxy_entry)
        .collect()
}

// -- Matching -----------------------------------------------------------------

fn ip_to_bits(addr: IpAddr) -> u128 {
    match addr {
        IpAddr::V4(v4) => u128::from(u32::from(v4)),
        IpAddr::V6(v6) => u128::from(v6),
    }
}

const fn cidr_contains(ip_bits: u128, network: u128, prefix: u8, total_bits: u8) -> bool {
    // Exact-match prefix (`prefix == total_bits`) yields `shift = 0` —
    // the shift is a no-op and the comparison is over the full value.
    //
    // /0 splits by family: IPv6 /0 produces `shift = 128 - 0 = 128`,
    // which is the `shift >= 128` branch below — u128 right-shift by
    // 128 is UB on some toolchains, so this branch is correctness-
    // critical (not "defensive"). IPv4 /0 produces `shift = 32`; the
    // shift path returns true because IPv4 addresses are stored in the
    // low 32 bits of u128 (upper 96 bits zero by construction in
    // `parse_proxy_entry`), so `ip_bits >> 32` and `network >> 32` are
    // both zero.
    let shift = total_bits - prefix;
    if shift >= 128 {
        return true;
    }
    (ip_bits >> shift) == (network >> shift)
}

/// Check whether `ip` matches any entry in the trusted-proxy list.
///
/// `ip` is normalized and validated before matching — malformed input
/// returns `false` without panicking.
pub fn is_trusted_ip(ip: &str, proxies: &[ParsedProxy]) -> bool {
    let normalized = normalize_ip(ip);
    let Some(family) = validate_ip_strict(&normalized) else {
        return false;
    };
    let Ok(addr) = IpAddr::from_str(&normalized) else {
        return false;
    };
    let ip_bits = ip_to_bits(addr);

    for proxy in proxies {
        match proxy {
            ParsedProxy::Ip(proxy_ip) => {
                if *proxy_ip == addr {
                    return true;
                }
            }
            ParsedProxy::Cidr {
                network,
                prefix,
                family: cidr_family,
            } => {
                if *cidr_family != family {
                    // Cross-family CIDR matches are always false — `::/0`
                    // is "all IPv6", not "all addresses".
                    continue;
                }
                let total_bits = match family {
                    IpFamily::V4 => 32u8,
                    IpFamily::V6 => 128u8,
                };
                if cidr_contains(ip_bits, *network, *prefix, total_bits) {
                    return true;
                }
            }
        }
    }
    false
}

// -- XFF resolution -----------------------------------------------------------

/// Resolve the real client IP from an `X-Forwarded-For` header value.
///
/// Walks right-to-left, skipping trusted-proxy entries AND any entry
/// that fails strict IP validation. The first untrusted, strictly-valid
/// entry is the client IP. If every walked entry is trusted or
/// malformed, returns the leftmost strictly-valid (likely-trusted)
/// entry; if even that doesn't exist (everything was malformed), returns
/// `None` so the middleware can fall back to the connection IP.
///
/// Skipping malformed entries is the rate-limit-key fix for the
/// "attacker controls XFF and the proxy passes it through" surface —
/// returning a malformed entry as the client IP would let an attacker
/// rotate arbitrary strings to get fresh per-IP rate-limit buckets.
/// Tradeoff: legitimate non-standard proxies that include ports in XFF
/// entries (e.g. `203.0.113.1:8080`) also fail strict validation and
/// collapse to the proxy's connection IP in rate limiting. Standard
/// proxies (nginx, cloud LBs) don't include ports.
pub fn resolve_client_ip(forwarded_for: &str, proxies: &[ParsedProxy]) -> Option<String> {
    let entries: Vec<String> = forwarded_for
        .split(',')
        .filter_map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(normalize_ip(trimmed))
            }
        })
        .collect();
    if entries.is_empty() {
        return None;
    }

    for entry in entries.iter().rev() {
        if validate_ip_strict(entry).is_none() {
            continue;
        }
        if !is_trusted_ip(entry, proxies) {
            return Some(entry.clone());
        }
    }

    // Every entry was trusted or malformed — fall back to the leftmost
    // strictly-valid entry. The middleware logs a misconfiguration warn
    // when it sees this shape (resolved IP is itself trusted).
    for entry in &entries {
        if validate_ip_strict(entry).is_some() {
            return Some(entry.clone());
        }
    }
    None
}

// -- Middleware ---------------------------------------------------------------

/// axum middleware that resolves the client IP and stores it on the
/// request via `request.extensions_mut().insert(ClientIp(...))`.
///
/// Three branches mirror `fuz_app`'s `create_proxy_middleware`:
///
/// 1. No `X-Forwarded-For` header → use the normalized connection IP.
/// 2. XFF present but connection from an untrusted IP → ignore the
///    header (spoof-proof) and use the connection IP. Log at `debug`.
/// 3. XFF present and connection from a trusted proxy → walk the
///    header right-to-left. If the resolved entry is itself in the
///    trusted set, log at `warn` (likely misconfiguration).
///
/// Always populates `ClientIp` — when `trusted_proxies` is empty every
/// connection looks untrusted, so the value is the normalized TCP peer
/// IP (matching the Phase 4 direct-bind posture).
pub async fn client_ip_middleware(
    State(app): State<Arc<App>>,
    ConnectInfo(addr): ConnectInfo<std::net::SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    let connection_ip = addr.ip().to_string();
    let forwarded_for = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let proxies = app.trusted_proxies.as_slice();

    let client_ip = match forwarded_for {
        None => normalize_ip(&connection_ip),
        // Empty XFF header — treat as absent. Matches TS
        // `if (!forwarded_for)` falsy semantics; otherwise the
        // trusted-XFF arm would substitute the connection IP via the
        // `None` fall-back inside `resolve_client_ip` and then
        // spuriously fire the "all XFF entries trusted" warn because
        // the substituted connection IP is itself in the trusted set.
        Some(ref ff) if ff.is_empty() => normalize_ip(&connection_ip),
        Some(ref ff) if is_trusted_ip(&connection_ip, proxies) => {
            // Trusted connection — walk the header for the originator.
            // `resolve_client_ip` returns `None` when every entry was
            // malformed; fall back to the connection IP silently in
            // that case (TS skips the misconfiguration warn here too,
            // emitting it only when the resolver actually returned a
            // value that turned out to be trusted itself).
            #[allow(
                clippy::option_if_let_else,
                reason = "explicit None/Some arms read clearer than map_or_else for the warn branch"
            )]
            match resolve_client_ip(ff, proxies) {
                None => normalize_ip(&connection_ip),
                Some(resolved) => {
                    if is_trusted_ip(&resolved, proxies) {
                        tracing::warn!(
                            forwarded_for = ff.as_str(),
                            "all XFF entries are trusted — possible proxy misconfiguration"
                        );
                    }
                    resolved
                }
            }
        }
        Some(_) => {
            // XFF present but connection from an untrusted IP — ignore
            // the spoofable header and key on the TCP peer.
            tracing::debug!(connection_ip, "XFF ignored — connection from untrusted IP");
            normalize_ip(&connection_ip)
        }
    };

    req.extensions_mut().insert(ClientIp(client_ip));
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- normalize_ip ---------------------------------------------------------

    #[test]
    fn normalize_strips_ipv4_mapped_v6_prefix() {
        assert_eq!(normalize_ip("::ffff:127.0.0.1"), "127.0.0.1");
        assert_eq!(normalize_ip("::ffff:10.1.2.3"), "10.1.2.3");
    }

    #[test]
    fn normalize_strips_uppercase_ipv4_mapped_prefix() {
        assert_eq!(normalize_ip("::FFFF:192.168.1.1"), "192.168.1.1");
    }

    #[test]
    fn normalize_preserves_ffff_one_no_dot() {
        // `::ffff:1` is a real IPv6 address (g5 = 0, g6 = 0xffff,
        // g7 = 1), NOT an IPv4-mapped form (which requires g5 =
        // 0xffff). `Ipv6Addr::to_string()` agrees — emits the bare
        // `::ffff:1` not the dotted IPv4-mapped notation. The `.`
        // requirement on strip is what keeps the two cases distinct.
        assert_eq!(normalize_ip("::ffff:1"), "::ffff:1");
    }

    #[test]
    fn normalize_canonicalizes_ipv6_zero_padding() {
        // Rate-limit-key poisoning defense: `::01`, `::0001`, and
        // `::1` are the same address — all three must produce the
        // same bucket key.
        assert_eq!(normalize_ip("::1"), "::1");
        assert_eq!(normalize_ip("::01"), "::1");
        assert_eq!(normalize_ip("::0001"), "::1");
    }

    #[test]
    fn normalize_canonicalizes_ipv6_full_to_compressed() {
        // The fully-expanded form must collapse to the canonical
        // RFC 5952 short form.
        assert_eq!(normalize_ip("0:0:0:0:0:0:0:1"), "::1");
        assert_eq!(normalize_ip("0000:0000:0000:0000:0000:0000:0000:0001"), "::1");
    }

    #[test]
    fn normalize_canonicalizes_ipv6_explicit_double_colon_run() {
        // Multiple zero runs — only one collapses via `::`. Canonical
        // form picks the longest run (RFC 5952). Either `2001::1:0:0:1`
        // or `2001:0:0:0:1::1` could be written by a careless attacker;
        // both must canonicalize to the same form.
        let a = normalize_ip("2001:0:0:0:1:0:0:1");
        let b = normalize_ip("2001::1:0:0:1");
        assert_eq!(a, b);
        // Smoke-check the chosen short form picks the longest run.
        assert_eq!(a, "2001::1:0:0:1");
    }

    #[test]
    fn normalize_ipv4_mapped_collapse_is_order_safe() {
        // The dot-bearing input strips early; the no-dot variant has
        // to canonicalize to the dotted form (Rust's `Ipv6Addr` Display
        // emits IPv4-mapped notation) before stripping. Both must
        // produce the same plain-v4 string.
        assert_eq!(normalize_ip("::ffff:0:0"), "0.0.0.0");
        assert_eq!(normalize_ip("::ffff:0.0.0.0"), "0.0.0.0");
        assert_eq!(normalize_ip("::ffff:7f00:1"), "127.0.0.1");
        assert_eq!(normalize_ip("::ffff:127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn normalize_collapses_equivalent_ipv6_to_same_key() {
        // The rate-limit-key collapse contract: every equivalent
        // representation of the same address must produce one and
        // only one canonical string.
        let forms = [
            "::1",
            "::01",
            "::0001",
            "0:0:0:0:0:0:0:1",
            "0000:0000:0000:0000:0000:0000:0000:0001",
        ];
        let canonical = normalize_ip(forms[0]);
        for form in &forms[1..] {
            assert_eq!(normalize_ip(form), canonical, "drift on {form:?}");
        }
    }

    #[test]
    fn normalize_preserves_strictly_invalid_input_unchanged() {
        // Inputs that fail `IpAddr::from_str` pass through
        // un-canonicalized so the validation layer can reject them.
        // These are all shapes `validate_ip_strict` rejects; preserving
        // the raw string lets the caller surface the original input in
        // diagnostics without losing information.
        assert_eq!(normalize_ip("::1\n"), "::1\n");
        assert_eq!(normalize_ip("[::1]:8080"), "[::1]:8080");
        assert_eq!(normalize_ip("203.0.113.1:8080"), "203.0.113.1:8080");
        assert_eq!(normalize_ip("attacker:controlled"), "attacker:controlled");
    }

    #[test]
    fn normalize_lowercases_ipv6() {
        assert_eq!(normalize_ip("FE80::1"), "fe80::1");
        assert_eq!(normalize_ip("2001:DB8::ABCD"), "2001:db8::abcd");
    }

    #[test]
    fn normalize_passes_plain_ipv4_through() {
        assert_eq!(normalize_ip("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn normalize_is_idempotent() {
        for input in ["::ffff:127.0.0.1", "FE80::1", "127.0.0.1", "::1", "unknown", ""] {
            let once = normalize_ip(input);
            let twice = normalize_ip(&once);
            assert_eq!(once, twice, "not idempotent for {input:?}");
        }
    }

    #[test]
    fn normalize_safe_on_non_ip_strings() {
        assert_eq!(normalize_ip("unknown"), "unknown");
        assert_eq!(normalize_ip(""), "");
    }

    // -- validate_ip_strict ---------------------------------------------------

    #[test]
    fn validate_accepts_well_formed_ipv4() {
        assert_eq!(validate_ip_strict("127.0.0.1"), Some(IpFamily::V4));
        assert_eq!(validate_ip_strict("0.0.0.0"), Some(IpFamily::V4));
        assert_eq!(validate_ip_strict("255.255.255.255"), Some(IpFamily::V4));
    }

    #[test]
    fn validate_accepts_well_formed_ipv6() {
        assert_eq!(validate_ip_strict("::1"), Some(IpFamily::V6));
        assert_eq!(validate_ip_strict("::"), Some(IpFamily::V6));
        assert_eq!(validate_ip_strict("2001:db8::1"), Some(IpFamily::V6));
        assert_eq!(validate_ip_strict("fe80::1"), Some(IpFamily::V6));
        assert_eq!(validate_ip_strict("FE80::1"), Some(IpFamily::V6));
    }

    #[test]
    fn validate_accepts_ipv4_mapped_v6() {
        assert_eq!(validate_ip_strict("::ffff:127.0.0.1"), Some(IpFamily::V6));
    }

    #[test]
    fn validate_rejects_empty() {
        assert_eq!(validate_ip_strict(""), None);
    }

    #[test]
    fn validate_rejects_garbage() {
        assert_eq!(validate_ip_strict("not-an-ip"), None);
        assert_eq!(validate_ip_strict("garbage"), None);
    }

    #[test]
    fn validate_rejects_colon_injection() {
        // distinctRemoteAddr-style misclassification surface from TS port.
        // Rust's parser already rejects, but the char-set + round-trip
        // makes the intent explicit.
        assert_eq!(validate_ip_strict("attacker:controlled"), None);
        assert_eq!(validate_ip_strict("host:port"), None);
        assert_eq!(validate_ip_strict("a:b:c"), None);
    }

    #[test]
    fn validate_rejects_ipv4_with_port() {
        // Hot path: non-standard proxies sending `addr:port` in XFF.
        assert_eq!(validate_ip_strict("203.0.113.1:8080"), None);
    }

    #[test]
    fn validate_rejects_bracketed_host_port() {
        // URL-host form, not a bare IP literal. The char-set filter
        // catches the brackets before any parser layer.
        assert_eq!(validate_ip_strict("[::1]:8080"), None);
        assert_eq!(validate_ip_strict("[2001:db8::1]:8080"), None);
    }

    #[test]
    fn validate_rejects_embedded_whitespace_or_control() {
        assert_eq!(validate_ip_strict("::1\n"), None);
        assert_eq!(validate_ip_strict("::1 "), None);
        assert_eq!(validate_ip_strict(" ::1"), None);
        assert_eq!(validate_ip_strict("127.0.0.1\t"), None);
    }

    // -- parse_proxy_entry ----------------------------------------------------

    #[test]
    fn parse_plain_ipv4() {
        let p = parse_proxy_entry("127.0.0.1").unwrap();
        assert!(matches!(p, ParsedProxy::Ip(IpAddr::V4(_))));
    }

    #[test]
    fn parse_plain_ipv6() {
        let p = parse_proxy_entry("::1").unwrap();
        assert!(matches!(p, ParsedProxy::Ip(IpAddr::V6(_))));
    }

    #[test]
    fn parse_normalizes_ipv4_mapped_to_plain_v4() {
        // `::ffff:127.0.0.1` → `127.0.0.1` so it matches both a plain
        // v4 input and a v4 CIDR proxy.
        let p = parse_proxy_entry("::ffff:127.0.0.1").unwrap();
        assert!(matches!(p, ParsedProxy::Ip(IpAddr::V4(_))));
    }

    #[test]
    fn parse_lowercases_ipv6() {
        let p = parse_proxy_entry("FE80::1").unwrap();
        if let ParsedProxy::Ip(addr) = p {
            assert_eq!(addr.to_string(), "fe80::1");
        } else {
            panic!("expected ParsedProxy::Ip");
        }
    }

    #[test]
    fn parse_ipv4_cidr() {
        let p = parse_proxy_entry("10.0.0.0/8").unwrap();
        assert!(matches!(
            p,
            ParsedProxy::Cidr { prefix: 8, family: IpFamily::V4, .. }
        ));
    }

    #[test]
    fn parse_ipv6_cidr() {
        let p = parse_proxy_entry("fe80::/10").unwrap();
        assert!(matches!(
            p,
            ParsedProxy::Cidr { prefix: 10, family: IpFamily::V6, .. }
        ));
    }

    #[test]
    fn parse_ipv4_slash_zero() {
        let p = parse_proxy_entry("0.0.0.0/0").unwrap();
        assert!(matches!(
            p,
            ParsedProxy::Cidr { prefix: 0, family: IpFamily::V4, network: 0 }
        ));
    }

    #[test]
    fn parse_ipv6_slash_zero() {
        let p = parse_proxy_entry("::/0").unwrap();
        assert!(matches!(
            p,
            ParsedProxy::Cidr { prefix: 0, family: IpFamily::V6, network: 0 }
        ));
    }

    #[test]
    fn parse_ipv4_slash_thirty_two_as_cidr() {
        // Documented behavior: `/32` parses as CIDR, not plain IP.
        let p = parse_proxy_entry("192.168.1.1/32").unwrap();
        assert!(matches!(p, ParsedProxy::Cidr { prefix: 32, .. }));
    }

    #[test]
    fn parse_rejects_invalid_ip() {
        assert!(matches!(
            parse_proxy_entry("hello"),
            Err(ProxyParseError::InvalidIp(_))
        ));
        assert!(matches!(
            parse_proxy_entry(""),
            Err(ProxyParseError::InvalidIp(_))
        ));
    }

    #[test]
    fn parse_rejects_non_aligned_v4_cidr() {
        assert!(matches!(
            parse_proxy_entry("10.0.0.5/8"),
            Err(ProxyParseError::HostBitsSet(_))
        ));
    }

    #[test]
    fn parse_rejects_non_aligned_v6_cidr() {
        assert!(matches!(
            parse_proxy_entry("fe80::1/10"),
            Err(ProxyParseError::HostBitsSet(_))
        ));
    }

    #[test]
    fn parse_rejects_non_aligned_v6_slash_zero() {
        // Regression: prior to the host_mask shift fix, `prefix_u8 = 0`
        // caused `1u128 << 128` to wrap in release mode and produce
        // `host_mask = 0`, which silently accepted any non-zero network
        // as if it were `::/0`. Both `fe80::/0` and `2001:db8::/0`
        // should reject — they're misconfigured.
        assert!(matches!(
            parse_proxy_entry("fe80::/0"),
            Err(ProxyParseError::HostBitsSet(_))
        ));
        assert!(matches!(
            parse_proxy_entry("2001:db8::/0"),
            Err(ProxyParseError::HostBitsSet(_))
        ));
    }

    #[test]
    fn parse_rejects_non_aligned_v4_slash_zero() {
        // v4 path doesn't have the same overflow bug (shifts in u128
        // by at most 32 bits) but symmetry coverage is cheap.
        assert!(matches!(
            parse_proxy_entry("10.0.0.0/0"),
            Err(ProxyParseError::HostBitsSet(_))
        ));
    }

    #[test]
    fn parse_rejects_v4_prefix_over_range() {
        assert!(matches!(
            parse_proxy_entry("10.0.0.0/33"),
            Err(ProxyParseError::PrefixV4OutOfRange(_))
        ));
    }

    #[test]
    fn parse_rejects_v6_prefix_over_range() {
        assert!(matches!(
            parse_proxy_entry("::1/129"),
            Err(ProxyParseError::PrefixV6OutOfRange(_))
        ));
    }

    #[test]
    fn parse_rejects_nan_prefix() {
        assert!(matches!(
            parse_proxy_entry("10.0.0.0/abc"),
            Err(ProxyParseError::PrefixNaN(_))
        ));
    }

    #[test]
    fn parse_rejects_negative_prefix() {
        assert!(matches!(
            parse_proxy_entry("10.0.0.0/-1"),
            Err(ProxyParseError::PrefixNegative(_))
        ));
    }

    #[test]
    fn parse_rejects_empty_prefix() {
        assert!(matches!(
            parse_proxy_entry("10.0.0.0/"),
            Err(ProxyParseError::PrefixNaN(_))
        ));
    }

    #[test]
    fn parse_rejects_invalid_cidr_network() {
        assert!(matches!(
            parse_proxy_entry("not-an-ip/8"),
            Err(ProxyParseError::InvalidCidr(_))
        ));
    }

    // -- parse_proxy_list -----------------------------------------------------

    #[test]
    fn parse_list_empty_string() {
        assert!(parse_proxy_list("").unwrap().is_empty());
    }

    #[test]
    fn parse_list_whitespace_only() {
        assert!(parse_proxy_list("   ").unwrap().is_empty());
    }

    #[test]
    fn parse_list_two_entries() {
        let v = parse_proxy_list("127.0.0.1, 10.0.0.0/8").unwrap();
        assert_eq!(v.len(), 2);
        assert!(matches!(v[0], ParsedProxy::Ip(_)));
        assert!(matches!(v[1], ParsedProxy::Cidr { .. }));
    }

    #[test]
    fn parse_list_tolerates_trailing_comma() {
        let v = parse_proxy_list("127.0.0.1,").unwrap();
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn parse_list_tolerates_leading_whitespace() {
        let v = parse_proxy_list("  127.0.0.1").unwrap();
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn parse_list_tolerates_internal_empty_segments() {
        // `a,,b` and `a, ,b` both collapse to two entries.
        let v = parse_proxy_list("127.0.0.1,,10.0.0.0/8").unwrap();
        assert_eq!(v.len(), 2);
        let v = parse_proxy_list("127.0.0.1, , 10.0.0.0/8").unwrap();
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn parse_list_fails_fast_on_any_bad_entry() {
        // Any invalid entry rejects the whole call — operators see the
        // misconfiguration at startup instead of silently leaving a hole.
        assert!(parse_proxy_list("127.0.0.1, garbage").is_err());
    }

    // -- is_trusted_ip --------------------------------------------------------

    fn proxies(entries: &[&str]) -> Vec<ParsedProxy> {
        entries.iter().map(|e| parse_proxy_entry(e).unwrap()).collect()
    }

    #[test]
    fn trusted_exact_ipv4_match() {
        let p = proxies(&["127.0.0.1"]);
        assert!(is_trusted_ip("127.0.0.1", &p));
        assert!(!is_trusted_ip("127.0.0.2", &p));
    }

    #[test]
    fn trusted_exact_ipv6_match_case_insensitive() {
        // normalize_ip lowercases before exact-match.
        let p = proxies(&["FE80::1"]);
        assert!(is_trusted_ip("fe80::1", &p));
        assert!(is_trusted_ip("FE80::1", &p));
        assert!(is_trusted_ip("Fe80::1", &p));
    }

    #[test]
    fn trusted_v4_cidr_slash_eight() {
        let p = proxies(&["10.0.0.0/8"]);
        assert!(is_trusted_ip("10.0.0.1", &p));
        assert!(is_trusted_ip("10.255.255.255", &p));
        assert!(!is_trusted_ip("11.0.0.1", &p));
        assert!(!is_trusted_ip("9.255.255.255", &p));
    }

    #[test]
    fn trusted_v4_cidr_slash_thirty_two_exact() {
        let p = proxies(&["10.0.0.1/32"]);
        assert!(is_trusted_ip("10.0.0.1", &p));
        assert!(!is_trusted_ip("10.0.0.2", &p));
    }

    #[test]
    fn trusted_v6_cidr_slash_ten() {
        let p = proxies(&["fe80::/10"]);
        assert!(is_trusted_ip("fe80::1", &p));
        assert!(is_trusted_ip("febf::1", &p));
        assert!(!is_trusted_ip("fec0::1", &p));
    }

    #[test]
    fn trusted_cross_family_guard_v4_zero_does_not_match_v6() {
        // 0.0.0.0/0 is "all IPv4", not "all addresses". Must not bleed
        // into IPv6 space.
        let p = proxies(&["0.0.0.0/0"]);
        assert!(!is_trusted_ip("::1", &p));
        assert!(!is_trusted_ip("fe80::1", &p));
        assert!(!is_trusted_ip("2001:db8::1", &p));
    }

    #[test]
    fn trusted_cross_family_guard_v6_zero_does_not_match_v4() {
        let p = proxies(&["::/0"]);
        assert!(!is_trusted_ip("127.0.0.1", &p));
        assert!(!is_trusted_ip("10.0.0.1", &p));
    }

    #[test]
    fn trusted_v4_zero_matches_all_v4() {
        let p = proxies(&["0.0.0.0/0"]);
        assert!(is_trusted_ip("0.0.0.0", &p));
        assert!(is_trusted_ip("1.2.3.4", &p));
        assert!(is_trusted_ip("255.255.255.255", &p));
    }

    #[test]
    fn trusted_v6_zero_matches_all_v6() {
        // Exercises the cidr_contains shift>=128 branch.
        let p = proxies(&["::/0"]);
        assert!(is_trusted_ip("::", &p));
        assert!(is_trusted_ip("::1", &p));
        assert!(is_trusted_ip("fe80::1", &p));
        assert!(is_trusted_ip("2001:db8::1", &p));
    }

    #[test]
    fn trusted_v4_mapped_v6_matches_plain_v4_proxy() {
        // ::ffff:127.0.0.1 normalizes to 127.0.0.1 before matching.
        let p = proxies(&["127.0.0.1"]);
        assert!(is_trusted_ip("::ffff:127.0.0.1", &p));
    }

    #[test]
    fn trusted_v4_mapped_v6_matches_v4_cidr() {
        let p = proxies(&["10.0.0.0/8"]);
        assert!(is_trusted_ip("::ffff:10.1.2.3", &p));
        assert!(!is_trusted_ip("::ffff:11.0.0.1", &p));
    }

    #[test]
    fn trusted_v4_mapped_in_config_matches_plain_v4_input() {
        // parse_proxy_entry normalizes ::ffff:127.0.0.1 → 127.0.0.1
        let p = proxies(&["::ffff:127.0.0.1"]);
        assert!(is_trusted_ip("127.0.0.1", &p));
    }

    #[test]
    fn trusted_malformed_input_returns_false_does_not_panic() {
        // Pre-fix bug surface in the TS port: a CIDR proxy + malformed
        // input could throw inside the binary conversion. Rust uses
        // checked parsing throughout; verify the false-return contract.
        let p = proxies(&["2001:db8::/32"]);
        assert!(!is_trusted_ip("attacker:controlled", &p));
        assert!(!is_trusted_ip("203.0.113.1:8080", &p));
        assert!(!is_trusted_ip("[::1]:8080", &p));
        assert!(!is_trusted_ip("", &p));
        assert!(!is_trusted_ip("not-an-ip", &p));
    }

    #[test]
    fn trusted_empty_proxy_list_returns_false() {
        assert!(!is_trusted_ip("127.0.0.1", &[]));
        assert!(!is_trusted_ip("::1", &[]));
    }

    #[test]
    fn trusted_v4_cidr_slash_sixteen_in_range() {
        let p = proxies(&["10.1.0.0/16"]);
        assert!(is_trusted_ip("10.1.0.1", &p));
        assert!(is_trusted_ip("10.1.255.255", &p));
        assert!(!is_trusted_ip("10.2.0.1", &p));
    }

    // -- resolve_client_ip ----------------------------------------------------

    #[test]
    fn resolve_single_untrusted_entry_returns_it() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("203.0.113.1", &p).as_deref(),
            Some("203.0.113.1")
        );
    }

    #[test]
    fn resolve_single_trusted_entry_returns_it() {
        // All-trusted edge: leftmost-strictly-valid fallback path.
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("127.0.0.1", &p).as_deref(),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn resolve_rightmost_first_strips_trusted_tail() {
        let p = proxies(&["127.0.0.1", "10.0.0.0/8"]);
        assert_eq!(
            resolve_client_ip("203.0.113.1, 10.1.2.3, 127.0.0.1", &p).as_deref(),
            Some("203.0.113.1")
        );
    }

    #[test]
    fn resolve_stops_at_first_untrusted_from_right() {
        // 127.0.0.1 trusted → skip; 198.51.100.7 untrusted → stop.
        // The untrusted (spoofable) entry to the LEFT is intentionally
        // not reached.
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("spoofed, 198.51.100.1, 127.0.0.1", &p).as_deref(),
            Some("198.51.100.1")
        );
    }

    #[test]
    fn resolve_empty_header_returns_none() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(resolve_client_ip("", &p), None);
    }

    #[test]
    fn resolve_whitespace_only_returns_none() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(resolve_client_ip(" , , ", &p), None);
    }

    #[test]
    fn resolve_trims_whitespace_around_entries() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("  203.0.113.1  , 127.0.0.1 ", &p).as_deref(),
            Some("203.0.113.1")
        );
    }

    #[test]
    fn resolve_normalizes_ipv4_mapped_entry() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("::ffff:203.0.113.1, 127.0.0.1", &p).as_deref(),
            Some("203.0.113.1")
        );
    }

    #[test]
    fn resolve_normalizes_uppercase_ipv6_entry() {
        let p = proxies(&["::1"]);
        assert_eq!(
            resolve_client_ip("FE80::ABCD, ::1", &p).as_deref(),
            Some("fe80::abcd")
        );
    }

    #[test]
    fn resolve_skips_malformed_entry_during_walk() {
        // Rate-limit-key poisoning defense — a malformed XFF entry
        // (attacker-controlled) must NOT be returned as the resolved
        // client IP. Walk continues past it.
        let p = proxies(&["127.0.0.1"]);
        // Walk: 127.0.0.1 (trusted, skip) → garbage (malformed, skip)
        // → 198.51.100.7 (valid, untrusted) → stop.
        assert_eq!(
            resolve_client_ip("198.51.100.7, attacker-controlled, 127.0.0.1", &p).as_deref(),
            Some("198.51.100.7")
        );
    }

    #[test]
    fn resolve_skips_port_suffixed_entry() {
        // Port-suffix in XFF (non-standard proxy) fails strict
        // validation. Tradeoff documented in resolve_client_ip's
        // doc-comment: those legitimate clients collapse to the
        // proxy IP in rate limiting.
        let p = proxies(&["127.0.0.1"]);
        // Walk: 127.0.0.1 (trusted, skip) → 203.0.113.1:8080
        // (malformed, skip) → 198.51.100.7 (valid, untrusted) → stop.
        assert_eq!(
            resolve_client_ip("198.51.100.7, 203.0.113.1:8080, 127.0.0.1", &p).as_deref(),
            Some("198.51.100.7")
        );
    }

    #[test]
    fn resolve_skips_colon_injection() {
        // distinctRemoteAddr misclassification surface from TS — Rust's
        // parser rejects but the security argument is preserved.
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("attacker:controlled, 127.0.0.1", &p).as_deref(),
            Some("127.0.0.1") // falls through to leftmost strictly-valid
        );
    }

    #[test]
    fn resolve_skips_bracketed_host_port() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("[::1]:8080, 127.0.0.1", &p).as_deref(),
            Some("127.0.0.1")
        );
    }

    #[test]
    fn resolve_all_malformed_returns_none() {
        // When no entry passes validation the middleware falls back to
        // the connection IP.
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(resolve_client_ip("garbage, also-bad", &p), None);
    }

    #[test]
    fn resolve_all_trusted_returns_leftmost() {
        // Middleware logs the misconfiguration warn on this shape.
        let p = proxies(&["127.0.0.1", "10.0.0.0/8"]);
        assert_eq!(
            resolve_client_ip("10.1.1.1, 10.2.2.2", &p).as_deref(),
            Some("10.1.1.1")
        );
    }

    #[test]
    fn resolve_consecutive_commas_skipped() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("203.0.113.1,,127.0.0.1", &p).as_deref(),
            Some("203.0.113.1")
        );
    }

    #[test]
    fn resolve_handles_ipv6_originator() {
        let p = proxies(&["127.0.0.1"]);
        assert_eq!(
            resolve_client_ip("2001:db8::1, 127.0.0.1", &p).as_deref(),
            Some("2001:db8::1")
        );
    }

    #[test]
    fn resolve_handles_v4_mapped_v6_against_v4_cidr_trust() {
        // ::ffff:10.0.0.1 normalizes to 10.0.0.1 → in 10.0.0.0/8 → skip.
        let p = proxies(&["10.0.0.0/8"]);
        assert_eq!(
            resolve_client_ip("1.2.3.4, ::ffff:10.0.0.1", &p).as_deref(),
            Some("1.2.3.4")
        );
    }

    // -- cidr_contains --------------------------------------------------------

    // These exercise the private helper directly — the public matchers
    // are also tested above but `cidr_contains` has UB-adjacent corners
    // that deserve isolated coverage.

    #[test]
    fn cidr_contains_v4_slash_zero_matches_all() {
        assert!(cidr_contains(0, 0, 0, 32));
        assert!(cidr_contains(0xFFFF_FFFF, 0, 0, 32));
        assert!(cidr_contains(0x0A00_0001, 0, 0, 32));
    }

    #[test]
    fn cidr_contains_v6_slash_zero_matches_all() {
        // Shift = 128 path — must not UB on u128 right-shift.
        assert!(cidr_contains(0, 0, 0, 128));
        assert!(cidr_contains(u128::MAX, 0, 0, 128));
        assert!(cidr_contains(0xfe80_0000_0000_0000_0000_0000_0000_0001, 0, 0, 128));
    }

    #[test]
    fn cidr_contains_exact_match_prefix() {
        // shift = 0 path.
        assert!(cidr_contains(42, 42, 32, 32));
        assert!(!cidr_contains(42, 43, 32, 32));
        assert!(cidr_contains(u128::MAX, u128::MAX, 128, 128));
    }

    #[test]
    fn cidr_contains_v4_slash_twenty_four() {
        // 10.0.0.0/24 = network bits = upper 24 of 32. Stored in low
        // 32 of u128: network = 0x0A00_0000, host range 0..=255.
        let net = 0x0A00_0000u128;
        assert!(cidr_contains(0x0A00_0000, net, 24, 32)); // 10.0.0.0
        assert!(cidr_contains(0x0A00_00FF, net, 24, 32)); // 10.0.0.255
        assert!(!cidr_contains(0x0A00_0100, net, 24, 32)); // 10.0.1.0
        assert!(!cidr_contains(0x0AFF_FFFF, net, 24, 32)); // 10.255.255.255 (out of /24)
    }
}
