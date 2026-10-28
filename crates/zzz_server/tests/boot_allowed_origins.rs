//! `zzzd`'s boot, for each kind of `FUZ_ALLOWED_ORIGINS` value: the real
//! binary, so what's pinned is that the checks run where the daemon starts.
//! A malformed list or opt-in is refused before the daemon creates its app
//! directory; a wildcard without the opt-in is the spine's boot check, which
//! runs after the app directory exists but before anything reaches for the
//! database.
//!
//! No database is needed: a refused list exits first, and the cases that get
//! past the list are pointed at a port nothing listens on.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]

use std::path::PathBuf;
use std::process::{Command, Output};

/// A fresh directory for one test, removed when the guard drops.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "zzz_boot_origins_{label}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Run `zzzd` to its exit with `allowed_origins` as `FUZ_ALLOWED_ORIGINS`
/// (unset for `None`), every other required value present, and a database URL
/// nothing answers at.
fn boot(dir: &TempDir, allowed_origins: Option<&str>) -> Output {
    boot_with_flag(dir, allowed_origins, None)
}

/// [`boot`] with `FUZ_ALLOW_ORIGIN_WILDCARDS` set to `flag` (unset for `None`).
fn boot_with_flag(dir: &TempDir, allowed_origins: Option<&str>, flag: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_zzzd"));
    command
        .current_dir(&dir.0)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("NO_COLOR", "1")
        .env("DATABASE_URL", "postgres://127.0.0.1:1/zzz_boot_origins")
        .env(
            "SECRET_FUZ_COOKIE_KEYS",
            "boot-origins-test-cookie-key-0123456789abcdef",
        )
        .env("PUBLIC_ZZZ_DIR", dir.0.join("app"))
        // a port nothing is asked to bind: boot ends first
        .args(["--port", "4479"]);
    if let Some(value) = allowed_origins {
        command.env("FUZ_ALLOWED_ORIGINS", value);
    }
    if let Some(value) = flag {
        command.env("FUZ_ALLOW_ORIGIN_WILDCARDS", value);
    }
    command.output().expect("zzzd runs")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A refused list: exit 2 (configuration), the message on stderr, and nothing
/// done first.
fn assert_refused(label: &str, allowed_origins: Option<&str>, expected: &[&str]) {
    let dir = TempDir::new(label);
    let output = boot(&dir, allowed_origins);
    let message = stderr(&output);
    assert_eq!(
        output.status.code(),
        Some(2),
        "{allowed_origins:?}: {message}"
    );
    assert!(
        message.starts_with("error: invalid configuration: FUZ_ALLOWED_ORIGINS"),
        "{allowed_origins:?}: {message}"
    );
    for part in expected {
        assert!(message.contains(part), "{allowed_origins:?}: {message}");
    }
    assert!(
        !dir.0.join("app").exists(),
        "{allowed_origins:?}: refused before the app directory is created"
    );
}

#[test]
fn a_trailing_slash_entry_refuses_the_boot() {
    assert_refused(
        "slash",
        Some("http://localhost:5460/"),
        &[
            "entry 1 \"http://localhost:5460/\"",
            "trailing slash",
            "`scheme://host[:port]`",
        ],
    );
}

#[test]
fn a_stray_comma_refuses_the_boot() {
    assert_refused(
        "comma",
        Some("http://localhost:5460,"),
        &["entry 2 \"\"", "stray comma", "`scheme://host[:port]`"],
    );
}

#[test]
fn a_malformed_entry_behind_a_good_one_refuses_the_boot() {
    assert_refused(
        "second",
        Some("http://localhost:4460, localhost:5460"),
        &["entry 2 \"localhost:5460\"", "no `scheme://`"],
    );
}

#[test]
fn an_unset_or_blank_list_refuses_the_boot() {
    for (label, value) in [("unset", None), ("empty", Some("")), ("blank", Some("  "))] {
        assert_refused(label, value, &["no origins supplied"]);
    }
}

/// Past the list: `zzzd` gets as far as the database, which isn't there —
/// exit 1, with the connectivity hint.
fn assert_reaches_the_database(output: &Output, label: &str) {
    let message = stderr(output);
    assert_eq!(output.status.code(), Some(1), "{label}: {message}");
    assert!(
        message.starts_with("error: database error"),
        "{label}: {message}"
    );
    assert!(message.contains("\nhint: "), "{label}: {message}");
}

#[test]
fn an_exact_list_boots_without_a_warning() {
    let dir = TempDir::new("exact");
    let output = boot(&dir, Some("http://localhost:5460, http://127.0.0.1:4460"));
    assert_reaches_the_database(&output, "exact");
    let log = stdout(&output);
    assert!(!log.contains("FUZ_ALLOWED_ORIGINS"), "{log}");
}

const WILDCARD_LIST: &str = "http://localhost:5460, http://localhost:*, https://*.example.com";

#[test]
fn a_wildcard_entry_refuses_the_boot_without_the_opt_in() {
    for (label, flag) in [("wildcard_unset", None), ("wildcard_false", Some("false"))] {
        let dir = TempDir::new(label);
        let output = boot_with_flag(&dir, Some(WILDCARD_LIST), flag);
        let message = stderr(&output);
        assert_eq!(output.status.code(), Some(2), "{label}: {message}");
        assert!(
            message.starts_with(
                "error: invalid configuration: FUZ_ALLOWED_ORIGINS holds a wildcard entry, \
                 refused unless FUZ_ALLOW_ORIGIN_WILDCARDS=true."
            ),
            "{label}: {message}"
        );
        // each wildcard entry, with what it admits on zzzd
        assert!(
            message.contains(
                "`http://localhost:*`: port wildcard: a page served from ANY port on `localhost`"
            ) && message.contains(
                "`https://*.example.com`: host wildcard: a page served from ANY host matching"
            ) && message.contains("On zzzd that includes terminals and file writes.")
                && message.contains("DNS rebinding"),
            "{label}: {message}"
        );
        assert!(
            !message.contains("`http://localhost:5460`"),
            "{label}: {message}"
        );
    }
}

#[test]
fn a_wildcard_entry_boots_with_the_opt_in_and_a_warning_saying_what_it_admits() {
    let dir = TempDir::new("wildcard");
    let output = boot_with_flag(&dir, Some(WILDCARD_LIST), Some("true"));
    assert_reaches_the_database(&output, "wildcard");
    let log = stdout(&output);
    let warnings: Vec<&str> = log
        .lines()
        .filter(|line| line.contains("WARN") && line.contains("FUZ_ALLOWED_ORIGINS: "))
        .collect();
    assert_eq!(warnings.len(), 2, "one per wildcard entry: {log}");
    assert!(
        warnings[0].contains("port wildcard: a page served from ANY port on `localhost`")
            && warnings[0].contains("origin=http://localhost:*"),
        "{log}"
    );
    assert!(
        warnings[1].contains("host wildcard: a page served from ANY host matching")
            && warnings[1].contains("origin=https://*.example.com"),
        "{log}"
    );
}

#[test]
fn a_malformed_opt_in_refuses_the_boot() {
    for value in ["", "1", "TRUE", "yes"] {
        let dir = TempDir::new("flag");
        let output = boot_with_flag(&dir, Some("http://localhost:5460"), Some(value));
        let message = stderr(&output);
        assert_eq!(output.status.code(), Some(2), "{value:?}: {message}");
        assert!(
            message.starts_with(
                "error: invalid configuration: FUZ_ALLOW_ORIGIN_WILDCARDS: expected `true` or \
                 `false`"
            ),
            "{value:?}: {message}"
        );
    }
}
