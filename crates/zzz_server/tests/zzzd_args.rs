//! `zzzd`'s command line and start-failure exit codes, against the real
//! binary: `--help` exits `0` with usage on stdout; an unknown or malformed
//! argument exits `2` with usage on stderr before anything runs; and a
//! configuration failure (here, no `DATABASE_URL`) exits `2` with the error
//! chain on stderr. None of these touches a database, the app dir, or a port.

#![allow(clippy::expect_used)]

use std::process::{Command, Output};

fn zzzd(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_zzzd"))
        .args(args)
        .env_clear()
        .output()
        .expect("spawn zzzd")
}

#[test]
fn help_prints_usage_and_exits_zero() {
    for flag in ["--help", "-h"] {
        let out = zzzd(&[flag]);
        assert_eq!(out.status.code(), Some(0), "{flag}");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert_eq!(
            stdout, "Usage: zzzd [--port <port>] [--static-dir <dir>]\n",
            "{flag}"
        );
    }
}

#[test]
fn a_bad_argument_exits_two_with_usage() {
    for args in [&["serve"][..], &["--port", "0"], &["--static-dir"]] {
        let out = zzzd(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.starts_with("error: "), "{args:?}: {stderr}");
        assert!(stderr.contains("Usage: zzzd "), "{args:?}: {stderr}");
        assert!(out.stdout.is_empty(), "{args:?}: nothing on stdout");
    }
}

#[test]
fn a_config_error_exits_two() {
    let out = zzzd(&[]);
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("error: invalid configuration: DATABASE_URL is unset or blank"),
        "{stderr}"
    );
}
