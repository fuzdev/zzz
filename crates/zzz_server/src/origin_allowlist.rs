//! The origin allowlist as `zzzd` reads it at boot: `FUZ_ALLOWED_ORIGINS`,
//! parsed by [`fuz_http::AllowedOrigins::parse`].
//!
//! - an unset or blank list, or any malformed entry, refuses the boot, naming
//!   the variable and every refused entry with its reason (the grammar is
//!   `fuz_http`'s, shared with the TS spine);
//! - a wildcard entry boots only with `FUZ_ALLOW_ORIGIN_WILDCARDS=true`: the
//!   spine's boot (`fuz_actions::server::create_app_backend`) refuses it
//!   otherwise, and warns what it admits when admitted, in the text
//!   [`ZZZ_BROWSER_GATES`] shapes.
//!
//! The list also decides which `Host` headers the daemon answers to
//! (`fuz_http::host_layer`): loopback names at any port, plus the hosts these
//! entries name. A wildcard widens both checks.

use fuz_http::{ALLOWED_ORIGINS_VAR, AllowedOrigins};

use fuz_actions::server::{BrowserGateSpec, StartupError};

/// `zzzd`'s browser gates.
///
/// The spine's allowlist var, the `Host` check on (the DNS-rebinding gate a
/// loopback daemon needs, see [`crate::router`]), and what a page the allowlist
/// trusts reaches here, for the wildcard origin text
/// (`fuz_http::origin_wildcard_warning`).
pub const ZZZ_BROWSER_GATES: BrowserGateSpec = BrowserGateSpec {
    allowed_origins_var: ALLOWED_ORIGINS_VAR,
    host_gate: true,
    origin_wildcard_note: Some("On zzzd that includes terminals and file writes."),
    port_wildcard_note: None,
};

/// The allowlist from `FUZ_ALLOWED_ORIGINS`' value (`None` when unset).
///
/// # Errors
///
/// [`StartupError::Config`] when the value is unset or blank, or when any entry
/// is malformed — naming the variable, each refused entry, and the shape
/// expected.
pub fn allowed_origins_from_env(raw: Option<&str>) -> Result<AllowedOrigins, StartupError> {
    AllowedOrigins::parse(raw.unwrap_or_default())
        .map_err(|e| StartupError::Config(format!("{ALLOWED_ORIGINS_VAR}: {e}")))
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

    #[test]
    fn every_wildcard_entry_boots() {
        let value = "http://localhost:*, https://*.example.com, http://*, http://*:*";
        let origins = allowed_origins_from_env(Some(value)).unwrap();
        assert_eq!(origins.wildcards().count(), 4);
    }
}
