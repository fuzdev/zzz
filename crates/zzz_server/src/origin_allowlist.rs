//! The origin allowlist as `zzzd` reads it at boot: `FUZ_ALLOWED_ORIGINS`,
//! parsed by [`fuz_http::AllowedOrigins::parse`].
//!
//! - an unset or blank list, or any malformed entry, refuses the boot, naming
//!   the variable and every refused entry with its reason (the grammar is
//!   `fuz_http`'s, shared with the TS spine);
//! - a wildcard entry boots with a warning that says what it admits
//!   ([`origin_wildcard_warning`]).
//!
//! The list also decides which `Host` headers the daemon answers to
//! (`fuz_http::host_layer`): loopback names at any port, plus the hosts these
//! entries name. A wildcard widens both checks.

use fuz_http::AllowedOrigins;

use fuz_actions::server::StartupError;

/// The env var holding the list.
pub const ALLOWED_ORIGINS_VAR: &str = "FUZ_ALLOWED_ORIGINS";

/// The allowlist from `FUZ_ALLOWED_ORIGINS`' value (`None` when unset),
/// logging a warning for each wildcard entry.
///
/// # Errors
///
/// [`StartupError::Config`] when the value is unset or blank, or when any entry
/// is malformed — naming the variable, each refused entry, and the shape
/// expected.
pub fn allowed_origins_from_env(raw: Option<&str>) -> Result<AllowedOrigins, StartupError> {
    let origins = AllowedOrigins::parse(raw.unwrap_or_default())
        .map_err(|e| StartupError::Config(format!("{ALLOWED_ORIGINS_VAR}: {e}")))?;
    for origin in origins.wildcards() {
        if let Some(warning) = origin_wildcard_warning(origin.as_str()) {
            tracing::warn!(origin = %origin.as_str(), "{ALLOWED_ORIGINS_VAR}: {warning}");
        }
    }
    Ok(origins)
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

    fn patterns(value: &str) -> AllowedOrigins {
        AllowedOrigins::parse(value).unwrap_or_else(|e| panic!("{value}: {e}"))
    }

    fn config_error(raw: Option<&str>) -> String {
        match allowed_origins_from_env(raw) {
            Err(StartupError::Config(message)) => message,
            other => panic!("{raw:?}: expected a config error, got {other:?}"),
        }
    }

    #[test]
    fn exact_origins_are_taken_as_written() {
        let origins =
            allowed_origins_from_env(Some(" http://localhost:4460 , http://127.0.0.1:4460"))
                .unwrap();
        let written: Vec<&str> = origins
            .patterns()
            .iter()
            .map(fuz_http::OriginPattern::as_str)
            .collect();
        assert_eq!(written, ["http://localhost:4460", "http://127.0.0.1:4460"]);
    }

    #[test]
    fn an_unset_or_blank_list_refuses_the_boot() {
        for raw in [None, Some(""), Some("   "), Some("\t\n")] {
            let message = config_error(raw);
            assert!(
                message.starts_with("FUZ_ALLOWED_ORIGINS: no origins supplied"),
                "{raw:?}: {message}"
            );
        }
    }

    #[test]
    fn a_malformed_entry_refuses_the_boot_and_names_itself() {
        // the grammar itself is `fuz_http`'s, pinned there; this pins that a
        // refused entry refuses the boot, named, behind the variable
        for (entry, position) in [
            ("http://localhost:5460/", 1),
            ("localhost:5460", 1),
            ("http://localhost:80", 1),
            ("https://b\u{fc}cher.example", 1),
        ] {
            for (value, position) in [
                (entry.to_owned(), position),
                (format!("http://localhost:4460,{entry}"), position + 1),
            ] {
                let message = config_error(Some(&value));
                assert!(
                    message.starts_with("FUZ_ALLOWED_ORIGINS: ")
                        && message.contains(&format!("entry {position} "))
                        && message.contains("scheme://host[:port]"),
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

    /// The warning for a wildcard entry, checked to be one the matcher takes.
    fn warning(origin: &str) -> String {
        patterns(origin);
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
            let list = patterns(origin);
            for port in ["", ":1", ":5173", ":65535"] {
                let scheme_host = origin.trim_end_matches(":*");
                assert!(list.allows(&format!("{scheme_host}{port}")));
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
            let list = patterns(origin);
            assert!(list.allows(admitted), "{origin}");
            // the `Host` check opens for the same host
            let host = admitted.split_once("://").unwrap().1;
            assert!(list.allows_host(host), "{origin}");
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
            let list = patterns(origin);
            for origin in admitted {
                assert!(list.allows(origin), "{origin}");
                let host = origin.split_once("://").unwrap().1;
                assert!(list.allows_host(host), "{origin}");
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
            let list = patterns(origin);
            assert!(list.allows(admitted), "{origin}");
            let host = admitted.split_once("://").unwrap().1;
            assert!(list.allows_host(host), "{origin}");
        }
    }

    #[test]
    fn every_wildcard_entry_warns_and_boots() {
        let value = "http://localhost:*, https://*.example.com, http://*, http://*:*";
        let origins = allowed_origins_from_env(Some(value)).unwrap();
        assert_eq!(origins.wildcards().count(), 4);
        for origin in origins.patterns() {
            assert!(
                origin_wildcard_warning(origin.as_str()).is_some(),
                "{origin:?}"
            );
        }
    }
}
