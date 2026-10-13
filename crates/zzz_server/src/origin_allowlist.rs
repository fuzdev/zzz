//! The origin allowlist as `zzzd` reads it at boot: `FUZ_ALLOWED_ORIGINS`,
//! checked entry by entry.
//!
//! `fuz_http` matches an `Origin` against the list and treats an entry it
//! can't read as one that matches nothing, so a mistyped entry (a trailing
//! slash, a missing scheme) leaves every browser request refused with `403`
//! and nothing to say why. This is the loud half of that:
//!
//! - a malformed entry refuses the boot, naming the entry and the shape
//!   expected ([`validate_origin_pattern`]);
//! - a wildcard entry boots with a warning that says what it admits
//!   ([`origin_wildcard_warning`]);
//! - an unset, blank, or empty list refuses the boot, since `fuz_http` reads
//!   an empty list as "allow every origin".
//!
//! The list also decides which `Host` headers the daemon answers to
//! (`fuz_http::host_layer`): loopback names at any port, plus the hosts these
//! entries name. A wildcard widens both checks.
//!
//! Validation covers the shapes listed on [`validate_origin_pattern`]. It
//! doesn't prove an entry matches an origin some browser sends: a hostname a
//! browser would rewrite (an invalid punycode label, say) passes and matches
//! nothing.

use std::net::Ipv6Addr;

use crate::ServerError;

/// The env var holding the list.
pub const ALLOWED_ORIGINS_VAR: &str = "FUZ_ALLOWED_ORIGINS";

/// An origin in the shape expected, for the boot error.
const EXAMPLE_ORIGIN: &str = "http://localhost:4460";

/// The allowlist from `FUZ_ALLOWED_ORIGINS`' value (`None` when unset),
/// logging a warning for each wildcard entry.
///
/// # Errors
///
/// [`ServerError::Config`] when the value is unset or blank (the canonical
/// `fuz_http::EmptyAllowedOrigins` message), or when any entry is malformed —
/// naming the variable, the entry, and the shape expected.
pub fn allowed_origins_from_env(raw: Option<&str>) -> Result<Vec<String>, ServerError> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Err(ServerError::Config(
            fuz_http::EmptyAllowedOrigins.to_string(),
        ));
    };
    let origins = parse_allowed_origins(raw)
        .map_err(|e| ServerError::Config(format!("{ALLOWED_ORIGINS_VAR}: {e}")))?;
    for origin in &origins {
        if let Some(warning) = origin_wildcard_warning(origin) {
            tracing::warn!(origin = %origin, "{ALLOWED_ORIGINS_VAR}: {warning}");
        }
    }
    Ok(origins)
}

/// Parse a set, non-blank `FUZ_ALLOWED_ORIGINS` value into its entries,
/// refusing the whole value when any entry fails [`validate_origin_pattern`].
/// An empty entry (a stray comma) is refused too, so the result is never
/// empty. The error names the entry and the shape expected.
fn parse_allowed_origins(raw: &str) -> Result<Vec<String>, String> {
    raw.split(',')
        .map(|entry| {
            let entry = entry.trim();
            validate_origin_pattern(entry)
                .map(|()| entry.to_owned())
                .map_err(|reason| {
                    format!(
                        "entry '{entry}' is not an origin zzzd can allow: {reason}. Expected \
                         comma-separated `scheme://host[:port]` entries with an http or \
                         https scheme, e.g. `{EXAMPLE_ORIGIN}`"
                    )
                })
        })
        .collect()
}

/// Check that one allowlist entry is written the way a browser writes an
/// `Origin`, under `fuz_http`'s pattern syntax — `scheme://host[:port]`, where
/// a whole host label or the port may be `*`.
///
/// Refused, each with its reason for the boot error: an empty entry; anything
/// but printable ASCII without spaces; no `scheme://`; a scheme other than
/// http or https; a path, query, fragment, or trailing slash; userinfo; an
/// empty host; a character no hostname holds (a percent-encoding among them);
/// a `*` that isn't a whole label; an IPv4 address not written as four
/// decimal numbers; an IPv6 address unbracketed or not in the form a browser
/// sends; a port that isn't `1..=65535` without leading zeros, or is the
/// scheme's default.
fn validate_origin_pattern(entry: &str) -> Result<(), &'static str> {
    if entry.is_empty() {
        return Err("it is empty (a stray comma?)");
    }
    if !entry.is_ascii() || entry.contains(|c: char| c.is_ascii_whitespace() || c.is_control()) {
        return Err(
            "an origin is printable ASCII with no spaces (an international hostname is \
             written in its punycode form)",
        );
    }
    let Some((scheme, authority)) = entry.split_once("://") else {
        return Err("it has no `scheme://`");
    };
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")) {
        return Err("the scheme is neither http nor https");
    }
    if authority.contains(['/', '?', '#']) {
        return Err(
            "an origin ends at the host or port — no path, query, or fragment, and no \
             trailing slash",
        );
    }
    if authority.contains('@') {
        return Err("an origin carries no userinfo");
    }

    let port = if authority.starts_with('[') {
        let Some(end) = authority.find(']') else {
            return Err("the IPv6 address has no closing `]`");
        };
        let (host, rest) = authority.split_at(end + 1);
        let Ok(address) = host[1..end].parse::<Ipv6Addr>() else {
            return Err("the bracketed host is not an IPv6 address");
        };
        if !host[1..end].eq_ignore_ascii_case(&ipv6_origin_form(address)) {
            return Err(
                "the IPv6 address is not written the way a browser sends it: no leading \
                 zeros, the longest run of zero groups as `::`, no dotted-quad tail",
            );
        }
        match rest.strip_prefix(':') {
            Some(port) => Some(port),
            None if rest.is_empty() => None,
            None => return Err("only `:port` may follow the IPv6 address"),
        }
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
        if host.is_empty() {
            return Err("it has no host");
        }
        if host.contains(':') {
            return Err("an IPv6 address is written in brackets, `[::1]`");
        }
        if host.contains(['%', '\\', '^', '|', '<', '>', '[', ']']) {
            return Err(
                "a hostname holds none of `%`, `\\`, `^`, `|`, `<`, `>`, `[`, `]` (a browser \
                 sends it decoded, with no percent-encoding)",
            );
        }
        if host
            .split('.')
            .any(|label| label.contains('*') && label != "*")
        {
            return Err("a `*` stands for one whole host label, as in `https://*.example.com`");
        }
        if !is_canonical_ipv4_or_name(host) {
            return Err(
                "a host ending in a number is an IPv4 address, which a browser sends as \
                 four decimal numbers 0-255 with no leading zeros and no trailing dot",
            );
        }
        port
    };

    match port {
        None | Some("*") => Ok(()),
        Some(port) => {
            let number = port
                .parse::<u16>()
                .ok()
                .filter(|n| *n != 0 && n.to_string() == port)
                .ok_or("the port is neither a number in 1-65535 (no leading zeros) nor `*`")?;
            let is_default = if scheme.eq_ignore_ascii_case("http") {
                number == 80
            } else {
                number == 443
            };
            if is_default {
                return Err(
                    "it names the scheme's default port, which a browser leaves out of \
                     `Origin` and `Host` — write it without the port",
                );
            }
            Ok(())
        }
    }
}

/// An IPv6 address as a browser serializes it in an origin: lowercase hex
/// groups without leading zeros, the first longest run of two or more zero
/// groups as `::`, and never a dotted-quad tail.
fn ipv6_origin_form(address: Ipv6Addr) -> String {
    use std::fmt::Write as _;

    let groups = address.segments();
    // the first longest run of zero groups, when it is two or more long
    let mut compress: Option<(usize, usize)> = None;
    let mut index = 0;
    while index < groups.len() {
        if groups[index] != 0 {
            index += 1;
            continue;
        }
        let start = index;
        while index < groups.len() && groups[index] == 0 {
            index += 1;
        }
        let len = index - start;
        if len >= 2 && compress.is_none_or(|(_, longest)| len > longest) {
            compress = Some((start, len));
        }
    }

    let mut out = String::new();
    let mut index = 0;
    while index < groups.len() {
        if let Some((start, len)) = compress
            && index == start
        {
            out.push_str(if start == 0 { "::" } else { ":" });
            index += len;
            continue;
        }
        let _ = write!(out, "{:x}", groups[index]);
        index += 1;
        if index < groups.len() {
            out.push(':');
        }
    }
    out
}

/// False when `host` (no brackets, wildcard labels allowed) is one a browser
/// reads as an IPv4 address and then writes differently. A browser takes any
/// host whose last label is a number — decimal or `0x` hex, one trailing dot
/// aside — for an IPv4 address and sends it as four decimal numbers.
fn is_canonical_ipv4_or_name(host: &str) -> bool {
    let name = host.strip_suffix('.').unwrap_or(host);
    let last = name.rsplit('.').next().unwrap_or(name);
    let hex = last
        .strip_prefix("0x")
        .or_else(|| last.strip_prefix("0X"))
        .is_some_and(|digits| digits.bytes().all(|b| b.is_ascii_hexdigit()));
    let is_number = hex || (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()));
    if !is_number {
        return true;
    }
    // a trailing dot makes a fifth, empty label
    host.split('.').count() == 4
        && host.split('.').all(|label| {
            label == "*"
                || label
                    .parse::<u8>()
                    .is_ok_and(|octet| octet.to_string() == label)
        })
}

/// What a wildcard in a valid allowlist entry admits, for the boot warning;
/// `None` for an exact origin.
///
/// Wildcards are `fuz_http` origin syntax an operator may want, so they are
/// allowed — but each one admits pages `zzzd` does not serve. The forms, as
/// `fuz_http` matches them:
///
/// - **port** (`:*`) — the host at any port, or none;
/// - **host** — each `*` label is any one label, in any position
///   (`https://*.example.com`, `https://example.*`), and a host that is all
///   `*` labels (`http://*`, `https://*.*`) is every host with that many
///   labels — four of them cover every IPv4 address;
/// - **both** (`http://*:*`, `https://*.example.com:*`).
///
/// A bracketed IPv6 host is exact, so it takes only the port form. The
/// `Host` check admits the hosts the same entries name, on either scheme.
fn origin_wildcard_warning(origin: &str) -> Option<String> {
    let (_, authority) = origin.split_once("://")?;
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        (&authority[..=end], authority[end + 1..].strip_prefix(':'))
    } else {
        authority
            .rsplit_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)))
    };
    let any_port = port == Some("*");
    let labels = host.split('.').count();
    let wildcard_labels = if host.starts_with('[') {
        0
    } else {
        host.split('.').filter(|label| *label == "*").count()
    };
    if !any_port && wildcard_labels == 0 {
        return None;
    }

    let hosts = if wildcard_labels == 0 {
        format!("`{host}`")
    } else if wildcard_labels < labels {
        format!("ANY host matching `{host}` (each `*` is any one label)")
    } else {
        let every = match labels {
            1 => "every single-label name, `localhost` included".to_owned(),
            4 => "every IPv4 address and every four-label hostname".to_owned(),
            n => format!("every hostname of {n} labels"),
        };
        format!("ANY host of that shape (no label of `{host}` is fixed: {every})")
    };
    let kind = match (wildcard_labels > 0, any_port) {
        (false, _) => "port wildcard",
        (true, false) => "host wildcard",
        (true, true) => "host and port wildcard",
    };
    let ports = if any_port {
        "ANY port on "
    } else if port.is_some() {
        "that port on "
    } else {
        ""
    };
    let host_gate = if wildcard_labels == 0 {
        format!("The `Host` check answers to {host} at any port too.")
    } else {
        "The `Host` check answers to the same hosts, on either scheme, so a page that \
         re-points a matching domain at this machine (DNS rebinding) passes it."
            .to_owned()
    };
    Some(format!(
        "{kind}: a page served from {ports}{hosts} is an allowed origin. zzzd trusts every \
         such page: one that is same-site with the host you log in at carries the session \
         cookie, and with it can call the API and open the WebSocket — terminals and file \
         writes included. {host_gate} Name exact origins unless every such page is trusted"
    ))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    fn patterns(values: &[&str]) -> Vec<String> {
        values.iter().map(|&v| v.to_owned()).collect()
    }

    fn config_error(raw: Option<&str>) -> String {
        match allowed_origins_from_env(raw) {
            Err(ServerError::Config(message)) => message,
            other => panic!("{raw:?}: expected a config error, got {other:?}"),
        }
    }

    #[test]
    fn exact_origins_are_taken_as_written() {
        assert_eq!(
            allowed_origins_from_env(Some(" http://localhost:4460 , http://127.0.0.1:4460"))
                .unwrap(),
            ["http://localhost:4460", "http://127.0.0.1:4460"]
        );
    }

    #[test]
    fn an_unset_or_blank_list_refuses_the_boot() {
        // an empty list is allow-all in `fuz_http::check_origin`
        for raw in [None, Some(""), Some("   "), Some("\t\n")] {
            let message = config_error(raw);
            assert!(
                message.contains("FUZ_ALLOWED_ORIGINS is required"),
                "{raw:?}: {message}"
            );
        }
    }

    #[test]
    fn no_value_yields_an_empty_allowlist() {
        for value in [
            "",
            " ",
            ",",
            " , ",
            ",,",
            "http://localhost:4460",
            "http://localhost:4460,",
            "/",
            "*",
        ] {
            if let Ok(origins) = allowed_origins_from_env(Some(value)) {
                assert!(!origins.is_empty(), "{value:?}");
            }
        }
    }

    #[test]
    fn valid_origin_patterns_pass() {
        for entry in [
            "http://localhost:5460",
            "HTTP://LocalHost:5460",
            "https://zzz.example.com",
            "https://zzz.example.com:8443",
            // the other scheme's default port is a port like any other
            "http://localhost:443",
            "https://zzz.example.com:80",
            "http://192.168.1.10:5460",
            "http://127.0.0.1:4460",
            "http://[::1]:5460",
            "http://[::1]",
            "http://[2001:db8::1]:5460",
            "http://[2001:DB8::1]:5460",
            "http://[fe80::1:0:0:1]",
            "http://[::ffff:102:304]",
            "http://[1:2:3:4:5:6:7:8]",
            "http://[::]",
            "http://localhost",
            "http://localhost.",
            "https://xn--bcher-kva.example",
            "https://my_host.example",
            // a name whose last label only starts with a digit
            "https://1.2.3.4a",
            "https://0xg.example",
            // the wildcard forms `fuz_http` matches
            "http://localhost:*",
            "http://[::1]:*",
            "https://*.example.com",
            "https://*.*.corp.example.com",
            "https://*.example.com:*",
            "https://example.*",
            "http://192.168.1.*",
            "http://*.168.1.10:5460",
            "http://*",
            "http://*:*",
            "https://*.*",
            "http://*.*.*.*",
        ] {
            assert_eq!(validate_origin_pattern(entry), Ok(()), "{entry}");
        }
    }

    /// Malformed entries, each with a word its reason carries.
    const MALFORMED_ENTRIES: &[(&str, &str)] = &[
        ("", "empty"),
        // the trailing slash a pasted URL carries
        ("http://localhost:5460/", "trailing slash"),
        ("http://localhost:5460/chats", "no path"),
        ("https://zzz.example.com?x=1", "query"),
        ("https://zzz.example.com#top", "fragment"),
        ("localhost:5460", "scheme"),
        ("localhost", "scheme"),
        ("*", "scheme"),
        ("null", "scheme"),
        ("//localhost:5460", "scheme"),
        ("ws://localhost:5460", "neither http nor https"),
        ("file://localhost", "neither http nor https"),
        ("http://", "no host"),
        ("http://:5460", "no host"),
        ("http://user@localhost:5460", "userinfo"),
        ("http://local host:5460", "no spaces"),
        // control characters an env value can hold
        ("http://local\u{7f}host:5460", "no spaces"),
        ("http://local\u{1b}host", "no spaces"),
        ("https://b\u{fc}cher.example", "punycode"),
        ("http://localhost:", "port"),
        ("http://localhost:abc", "port"),
        ("http://localhost:0", "port"),
        ("http://localhost:65536", "port"),
        ("http://localhost:05460", "leading zeros"),
        ("http://localhost:80", "default port"),
        ("https://zzz.example.com:443", "default port"),
        ("https://*foo.example.com", "whole host label"),
        ("http://::1:5460", "brackets"),
        // a percent-encoded host, and characters no hostname holds
        ("https://zzz%2eexample.com", "percent-encoding"),
        ("https://exa%6dple.com", "percent-encoding"),
        ("http://local\\host:5460", "hostname holds none"),
        ("http://a|b", "hostname holds none"),
        ("http://a]:5460", "hostname holds none"),
        // IPv4 addresses a browser rewrites
        ("http://127.1:5460", "IPv4"),
        ("http://127.0.0.01:5460", "IPv4"),
        ("http://0x7f.0.0.1:5460", "IPv4"),
        ("http://127.0.0.0x1", "IPv4"),
        ("http://127.0.0.0X1", "IPv4"),
        ("http://0x", "IPv4"),
        ("http://2130706433", "IPv4"),
        ("http://127.0.0.1.:5460", "IPv4"),
        ("http://256.0.0.1", "IPv4"),
        ("http://1.2.3.4.5", "IPv4"),
        ("http://*.1:5460", "IPv4"),
        // IPv6 addresses a browser rewrites
        (
            "http://[0:0:0:0:0:0:0:1]:5460",
            "the way a browser sends it",
        ),
        ("http://[::0001]:5460", "the way a browser sends it"),
        (
            "http://[2001:db8:0:0:0:0:0:1]",
            "the way a browser sends it",
        ),
        ("http://[::ffff:1.2.3.4]", "the way a browser sends it"),
        ("http://[1:0:0:2:0:0:0:3]", "the way a browser sends it"),
        ("http://[::1", "closing"),
        ("http://[localhost]:5460", "not an IPv6 address"),
        ("http://[::*]:5460", "not an IPv6 address"),
        ("http://[fe80::1%eth0]", "not an IPv6 address"),
        ("http://[::1]5460", "may follow"),
    ];

    #[test]
    fn malformed_origin_patterns_are_refused_with_a_reason() {
        for (entry, word) in MALFORMED_ENTRIES {
            let reason = validate_origin_pattern(entry).expect_err(entry);
            assert!(reason.contains(word), "{entry:?}: {reason}");
        }
    }

    #[test]
    fn a_malformed_entry_refuses_the_boot_and_names_itself() {
        for (entry, _) in MALFORMED_ENTRIES {
            // alone, and hidden behind a good entry
            for value in [entry.to_string(), format!("http://localhost:4460,{entry}")] {
                if value.trim().is_empty() {
                    continue; // blank reads as unset
                }
                let message = config_error(Some(&value));
                assert!(
                    message.starts_with("FUZ_ALLOWED_ORIGINS: ")
                        && message.contains(&format!("entry '{}'", entry.trim()))
                        && message.contains("scheme://host[:port]")
                        && message.contains(EXAMPLE_ORIGIN),
                    "{value:?}: {message}"
                );
            }
        }
    }

    #[test]
    fn a_stray_comma_refuses_the_boot() {
        for value in [
            ",",
            "  , ",
            "http://localhost:4460,",
            ",http://localhost:4460",
            "http://localhost:4460,,http://127.0.0.1:4460",
        ] {
            let message = config_error(Some(value));
            assert!(message.contains("stray comma"), "{value:?}: {message}");
        }
    }

    #[test]
    fn the_example_origin_is_valid() {
        assert_eq!(validate_origin_pattern(EXAMPLE_ORIGIN), Ok(()));
        assert_eq!(origin_wildcard_warning(EXAMPLE_ORIGIN), None);
    }

    #[test]
    fn accepted_exact_patterns_match_themselves_and_refused_ones_match_no_browser_origin() {
        // the validator and `fuz_http`'s matcher agree: a passing exact entry
        // matches itself as an `Origin`, and a refused one doesn't match the
        // origin a browser sends for the address it was written for
        for entry in [
            "http://localhost:5460",
            "https://zzz.example.com",
            "http://[::1]:5460",
            "http://[2001:db8::1]",
            "http://127.0.0.1:4460",
        ] {
            assert_eq!(validate_origin_pattern(entry), Ok(()));
            assert!(fuz_http::check_origin(entry, &patterns(&[entry])));
        }
        for (pattern, origin) in [
            ("http://localhost:5460/", "http://localhost:5460"),
            ("localhost:5460", "http://localhost:5460"),
            ("http://localhost:80", "http://localhost"),
            ("https://*foo.example.com", "https://afoo.example.com"),
            ("http://localhost:05460", "http://localhost:5460"),
            ("http://127.1:5460", "http://127.0.0.1:5460"),
            ("http://127.0.0.1.:5460", "http://127.0.0.1:5460"),
            ("http://[0:0:0:0:0:0:0:1]:5460", "http://[::1]:5460"),
            ("http://[::ffff:1.2.3.4]", "http://[::ffff:102:304]"),
            ("https://exa%6dple.com", "https://example.com"),
        ] {
            assert!(validate_origin_pattern(pattern).is_err(), "{pattern}");
            assert!(
                !fuz_http::check_origin(origin, &patterns(&[pattern])),
                "{pattern}"
            );
        }
    }

    #[test]
    fn ipv6_origin_form_is_the_browser_serialization() {
        for (written, sent) in [
            ("::1", "::1"),
            ("::", "::"),
            ("0:0:0:0:0:0:0:1", "::1"),
            ("2001:DB8:0:0:0:0:0:1", "2001:db8::1"),
            ("1::", "1::"),
            ("1:0:0:0:0:0:0:0", "1::"),
            // a single zero group isn't compressed
            ("1:0:2:3:4:5:6:7", "1:0:2:3:4:5:6:7"),
            // the longest run wins, the first of equals
            ("1:0:0:2:0:0:0:3", "1:0:0:2::3"),
            ("1:0:0:2:3:0:0:4", "1::2:3:0:0:4"),
            // never a dotted-quad tail
            ("::ffff:1.2.3.4", "::ffff:102:304"),
            ("fe80::1:0:0:1", "fe80::1:0:0:1"),
        ] {
            let address: Ipv6Addr = written.parse().unwrap();
            assert_eq!(ipv6_origin_form(address), sent, "{written}");
        }
    }

    /// The warning for a wildcard entry, checked to be one the matcher takes.
    fn warning(origin: &str) -> String {
        assert_eq!(validate_origin_pattern(origin), Ok(()), "{origin}");
        origin_wildcard_warning(origin).unwrap_or_else(|| panic!("{origin} warns"))
    }

    #[test]
    fn exact_origins_carry_no_warning() {
        for origin in [
            "http://localhost:5460",
            "http://127.0.0.1:4460",
            "https://zzz.example.com",
            "http://[::1]:5460",
            "http://[2001:db8::1]",
        ] {
            assert_eq!(origin_wildcard_warning(origin), None, "{origin}");
        }
    }

    #[test]
    fn a_port_wildcard_warning_names_the_host_at_any_port() {
        for (origin, host) in [
            ("http://localhost:*", "localhost"),
            ("http://192.168.1.10:*", "192.168.1.10"),
            ("http://[::1]:*", "[::1]"),
        ] {
            let text = warning(origin);
            assert!(text.starts_with("port wildcard: "), "{origin}: {text}");
            assert!(
                text.contains(&format!("ANY port on `{host}` is an allowed origin")),
                "{origin}: {text}"
            );
            assert!(
                text.contains(&format!(
                    "The `Host` check answers to {host} at any port too"
                )),
                "{origin}: {text}"
            );
            assert!(text.contains("session cookie"), "{origin}: {text}");
            assert!(!text.contains("ANY host"), "{origin}: {text}");
            // and the matcher does what the text says
            let list = patterns(&[origin]);
            for port in ["", ":1", ":5173", ":65535"] {
                let scheme_host = origin.trim_end_matches(":*");
                assert!(fuz_http::check_origin(
                    &format!("{scheme_host}{port}"),
                    &list
                ));
            }
        }
    }

    #[test]
    fn a_host_wildcard_warning_names_every_matching_host() {
        for (origin, pattern_host, admitted, ports) in [
            (
                "https://*.example.com",
                "*.example.com",
                "https://evil.example.com",
                "from ANY host",
            ),
            // not only a leading label
            (
                "https://example.*",
                "example.*",
                "https://example.evil",
                "from ANY host",
            ),
            (
                "http://app.*.test:5460",
                "app.*.test",
                "http://app.evil.test:5460",
                "from that port on ANY host",
            ),
            (
                "http://192.168.1.*",
                "192.168.1.*",
                "http://192.168.1.77",
                "from ANY host",
            ),
        ] {
            let text = warning(origin);
            assert!(text.starts_with("host wildcard: "), "{origin}: {text}");
            assert!(
                text.contains(&format!(
                    "{ports} matching `{pattern_host}` (each `*` is any one label)"
                )),
                "{origin}: {text}"
            );
            assert!(text.contains("DNS rebinding"), "{origin}: {text}");
            assert!(text.contains("session cookie"), "{origin}: {text}");
            assert!(!text.contains("ANY port"), "{origin}: {text}");
            let list = patterns(&[origin]);
            assert!(fuz_http::check_origin(admitted, &list), "{origin}");
            // the `Host` check opens for the same host
            let host = admitted.split_once("://").unwrap().1;
            assert!(fuz_http::check_host(host, &list), "{origin}");
        }
    }

    #[test]
    fn a_whole_host_wildcard_warning_says_no_label_is_fixed() {
        for (origin, shape, admitted) in [
            (
                "http://*",
                "every single-label name, `localhost` included",
                vec!["http://localhost", "http://intranet"],
            ),
            (
                "https://*.*",
                "every hostname of 2 labels",
                vec!["https://evil.example", "https://example.com"],
            ),
            (
                "https://*.*.*",
                "every hostname of 3 labels",
                vec!["https://www.evil.example"],
            ),
            (
                "http://*.*.*.*",
                "every IPv4 address and every four-label hostname",
                vec!["http://10.0.0.7", "http://203.0.113.9", "http://a.b.c.d"],
            ),
        ] {
            let text = warning(origin);
            assert!(text.starts_with("host wildcard: "), "{origin}: {text}");
            assert!(text.contains("ANY host of that shape"), "{origin}: {text}");
            assert!(text.contains("is fixed"), "{origin}: {text}");
            assert!(text.contains(shape), "{origin}: {text}");
            assert!(text.contains("DNS rebinding"), "{origin}: {text}");
            assert!(!text.contains("ANY port"), "{origin}: {text}");
            let list = patterns(&[origin]);
            for origin in admitted {
                assert!(fuz_http::check_origin(origin, &list), "{origin}");
                let host = origin.split_once("://").unwrap().1;
                assert!(fuz_http::check_host(host, &list), "{origin}");
            }
        }
    }

    #[test]
    fn a_host_and_port_wildcard_warning_says_both() {
        for (origin, hosts, admitted) in [
            (
                "https://*.example.com:*",
                "ANY port on ANY host matching `*.example.com`",
                "https://evil.example.com:8443",
            ),
            (
                "http://*:*",
                "ANY port on ANY host of that shape (no label of `*` is fixed: every \
                 single-label name, `localhost` included) is an allowed origin",
                "http://localhost:5173",
            ),
            (
                "http://*.*.*.*:*",
                "ANY port on ANY host of that shape (no label of `*.*.*.*` is fixed: every \
                 IPv4 address",
                "http://192.168.1.10:9000",
            ),
        ] {
            let text = warning(origin);
            assert!(
                text.starts_with("host and port wildcard: "),
                "{origin}: {text}"
            );
            assert!(text.contains(hosts), "{origin}: {text}");
            assert!(text.contains("DNS rebinding"), "{origin}: {text}");
            let list = patterns(&[origin]);
            assert!(fuz_http::check_origin(admitted, &list), "{origin}");
            let host = admitted.split_once("://").unwrap().1;
            assert!(fuz_http::check_host(host, &list), "{origin}");
        }
    }

    #[test]
    fn every_wildcard_entry_warns_and_boots() {
        let value = "http://localhost:*, https://*.example.com, http://*, http://*:*";
        let origins = allowed_origins_from_env(Some(value)).unwrap();
        assert_eq!(origins.len(), 4);
        for origin in &origins {
            assert!(origin_wildcard_warning(origin).is_some(), "{origin}");
        }
    }
}
