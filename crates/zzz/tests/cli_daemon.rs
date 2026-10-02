//! Binary-level integration tests for the `zzz` CLI's daemon handling.
//!
//! `zzz` is a bin-only crate, so integration tests can't import its
//! modules — they drive the compiled binary (`CARGO_BIN_EXE_zzz`) against an
//! isolated temp `$HOME`. None of these need a real `zzzd` or a database:
//! status read-back and stale / reused-pid / older-zzz records, launch
//! validation (missing UI build / env, port in use, bad paths), early child
//! exit, `init`, and — with a stand-in daemon script (`sh` + `python3`;
//! without `python3` those tests print a visible SKIPPED line and pass) —
//! the full start → status → stop lifecycle in the foreground and detached
//! flows, plus signals during startup, and the opener (a stand-in script
//! recording its arguments; a stub `xdg-open` stands in for the browser).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "integration test: panics are assertion failures by design"
)]

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const fn zzz_bin() -> &'static str {
    env!("CARGO_BIN_EXE_zzz")
}

/// Env vars the CLI reads; cleared so the developer's shell can't leak in.
const CLI_ENV: &[&str] = &[
    "ZZZ_PORT",
    "ZZZ_STATIC_DIR",
    "ZZZ_SERVER_BIN",
    "ZZZ_OPENER",
    "DATABASE_URL",
    "SECRET_FUZ_COOKIE_KEYS",
    "FUZ_ALLOWED_ORIGINS",
    "FUZ_BOOTSTRAP_TOKEN_PATH",
    "PUBLIC_ZZZ_DIR",
    "PUBLIC_ZZZ_SCOPED_DIRS",
    "ZZZ_ENABLE_TEST_ACTIONS",
];

/// A unique temp dir to use as `$HOME` (no `tempfile` dep in this crate).
fn temp_home(tag: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("zzz_cli_it_{}_{tag}_{nonce}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(dir).unwrap()
}

/// `zzz` with `$HOME` set to `home` and the CLI's env cleared.
fn zzz(home: &Path) -> Command {
    let mut command = Command::new(zzz_bin());
    command.env("HOME", home);
    for key in CLI_ENV {
        command.env_remove(key);
    }
    command
}

fn run(command: &mut Command) -> Output {
    command.output().expect("run zzz")
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// A home with `~/.zzz` (and `run/`) created.
fn initialized_home(tag: &str) -> PathBuf {
    let home = temp_home(tag);
    fs::create_dir_all(home.join(".zzz").join("run")).unwrap();
    home
}

/// A home ready to launch: `~/.zzz/static` plus a minimal `~/.zzz/.env`.
fn launchable_home(tag: &str) -> PathBuf {
    let home = initialized_home(tag);
    fs::create_dir_all(home.join(".zzz").join("static")).unwrap();
    fs::write(
        home.join(".zzz").join(".env"),
        "export DATABASE_URL=postgres://localhost/zzz_cli_test\nSECRET_FUZ_COOKIE_KEYS='from-the-env-file-0123456789abcdef'\n",
    )
    .unwrap();
    home
}

fn daemon_json(home: &Path) -> PathBuf {
    home.join(".zzz").join("run").join("daemon.json")
}

fn boot_id() -> String {
    fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .unwrap()
        .trim()
        .to_owned()
}

fn write_daemon_json(home: &Path, pid: u32, pid_start_ticks: u64) {
    fs::write(
        daemon_json(home),
        format!(
            r#"{{"version":2,"pid":{pid},"boot_id":"{}","pid_start_ticks":{pid_start_ticks},"port":59999,"started":"2026-05-30T00:00:00Z","app_version":"test"}}"#,
            boot_id()
        ),
    )
    .unwrap();
}

/// An older zzz's (v1) record, naming `pid`.
fn write_v1_daemon_json(home: &Path, pid: u32) -> String {
    let v1 = format!(r#"{{"version":1,"pid":{pid},"port":4460,"started":"x","app_version":"y"}}"#);
    fs::write(daemon_json(home), &v1).unwrap();
    v1
}

/// Field 22 of `/proc/<pid>/stat`, when `pid` exists.
fn start_ticks_of(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(19)?.parse().ok()
}

fn start_ticks(pid: u32) -> u64 {
    start_ticks_of(pid).unwrap()
}

/// Whether `pid` is a live (non-zombie) process.
fn is_running(pid: u32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        let rest = &stat[stat.rfind(')').unwrap() + 1..];
        !matches!(rest.split_whitespace().next(), Some("Z" | "X"))
    })
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// Write an executable `sh` script.
fn write_script(path: &Path, body: &str) {
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn send_signal(pid: u32, signal: &str) {
    let status = Command::new("kill")
        .args([&format!("-{signal}"), &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success(), "kill -{signal} {pid}");
}

/// Print a SKIPPED line that shows even under libtest's output capture
/// (which only intercepts the `print!` macros).
fn skip(test: &str, reason: &str) {
    let _ = writeln!(std::io::stderr(), "SKIPPED {test}: {reason}");
}

/// Kills whatever a test started — the `zzz` children it holds and every
/// stand-in daemon pid recorded in `pidfile` — and removes the home, even
/// when an assertion fails first.
struct Cleanup {
    home: PathBuf,
    pidfile: PathBuf,
    children: Vec<Child>,
}

impl Cleanup {
    fn new(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            pidfile: home.join("fake_zzzd.pids"),
            children: Vec::new(),
        }
    }

    /// The stand-in daemons started so far, as `(pid, start ticks)`.
    fn daemons(&self) -> Vec<(u32, u64)> {
        fs::read_to_string(&self.pidfile)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let (pid, ticks) = line.trim().split_once(' ')?;
                Some((pid.parse().ok()?, ticks.parse().ok()?))
            })
            .collect()
    }

    /// The stand-in daemon pids started so far.
    fn daemon_pids(&self) -> Vec<u32> {
        self.daemons().into_iter().map(|(pid, _)| pid).collect()
    }

    /// Where the stand-in signals that its signal handlers are installed.
    fn ready_marker(&self) -> PathBuf {
        self.home.join("fake_zzzd.ready")
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        for (pid, ticks) in self.daemons() {
            // only the very process recorded — never a recycled pid
            if start_ticks_of(pid) != Some(ticks) {
                continue;
            }
            // the pid, and its process group (a detached daemon leads its own)
            for target in [pid.to_string(), format!("-{pid}")] {
                let _ = Command::new("kill")
                    .args(["-KILL", "--", &target])
                    .stderr(Stdio::null())
                    .status();
            }
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}

#[test]
fn status_reports_not_running_with_exit_3() {
    let home = temp_home("none");
    let _cleanup = Cleanup::new(&home);
    for args in [&["daemon", "status", "--json"][..], &["status"][..]] {
        let out = run(zzz(&home).args(args));
        assert_eq!(out.status.code(), Some(3), "stderr: {}", stderr(&out));
    }
    let out = run(zzz(&home).args(["daemon", "status", "--json"]));
    let json: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "state": "not_running",
            "running": false,
            "healthy": false,
            "daemon": null,
            "foreign_record": null,
        })
    );
}

#[test]
fn status_cleans_up_a_dead_pid_record_in_both_forms() {
    let home = initialized_home("stale");
    let _cleanup = Cleanup::new(&home);
    for args in [&["daemon", "status"][..], &["status", "--json"][..]] {
        // a valid-i32 pid that is not a running process
        write_daemon_json(&home, 2_000_000_000, 1);
        let out = run(zzz(&home).args(args));
        assert_eq!(out.status.code(), Some(3), "stderr: {}", stderr(&out));
        assert!(
            !daemon_json(&home).exists(),
            "{args:?}: stale record removed"
        );
    }
}

#[test]
fn a_reused_pid_is_never_signalled() {
    // The record names this test process's pid with a different start time
    // — a pid the kernel reused. `stop` must treat it as stale, not SIGTERM
    // this process (which would kill the test run).
    let home = initialized_home("reused");
    let _cleanup = Cleanup::new(&home);
    let me = std::process::id();
    write_daemon_json(&home, me, start_ticks(me) + 1);

    let out = run(zzz(&home).args(["daemon", "status", "--json"]));
    assert_eq!(out.status.code(), Some(3));
    assert!(
        stdout(&out).contains("\"running\":false"),
        "{}",
        stdout(&out)
    );

    write_daemon_json(&home, me, start_ticks(me) + 1);
    let out = run(zzz(&home).args(["daemon", "stop"]));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(stdout(&out).contains("stale"), "{}", stdout(&out));
    assert!(!daemon_json(&home).exists());
}

#[test]
fn an_older_zzz_record_is_reported_never_signalled_or_deleted() {
    let home = initialized_home("v1");
    let _cleanup = Cleanup::new(&home);
    // this process's pid: signalling it would kill the test run
    let v1 = write_v1_daemon_json(&home, std::process::id());

    let out = run(zzz(&home).args(["daemon", "stop"]));
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(
        err.contains(&format!(
            "refusing to signal the daemon: daemon.json from an older zzz (pid {}) — stop it manually",
            std::process::id()
        )),
        "{err}"
    );
    assert!(err.contains("remove ~/.zzz/run/daemon.json"), "{err}");
    assert_eq!(fs::read_to_string(daemon_json(&home)).unwrap(), v1);

    // status: unknown (exit 4), said once, record untouched
    let out = run(zzz(&home).args(["daemon", "status"]));
    assert_eq!(out.status.code(), Some(4));
    assert!(
        stdout(&out).starts_with("daemon status unknown: daemon.json from an older zzz"),
        "{}",
        stdout(&out)
    );
    assert!(!stderr(&out).contains("older zzz"), "{}", stderr(&out));
    let out = run(zzz(&home).args(["status", "--json"]));
    assert_eq!(out.status.code(), Some(4));
    let json: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    assert_eq!(json["state"], "unknown");
    assert_eq!(json["foreign_record"]["pid"], std::process::id());
    assert_eq!(json["foreign_record"]["kind"], "older");
    assert_eq!(fs::read_to_string(daemon_json(&home)).unwrap(), v1);
}

#[test]
fn a_start_never_overwrites_an_older_zzz_record() {
    let home = launchable_home("v1start");
    let cleanup = Cleanup::new(&home);
    let v1 = write_v1_daemon_json(&home, 424_242);
    // a daemon that would serve, if it were ever spawned
    let bin = home.join("fake_zzzd");
    write_script(
        &bin,
        &format!("touch '{}'", cleanup.ready_marker().display()),
    );

    for args in [&["daemon", "start"][..], &["open"][..]] {
        let out = run(zzz(&home)
            .args(args)
            .env("PATH", fake_browser_path(&home))
            .env("ZZZ_PORT", free_port().to_string())
            .env("ZZZ_SERVER_BIN", &bin));
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        let err = stderr(&out);
        assert!(
            err.contains(
                "refusing to start a daemon: daemon.json from an older zzz (pid 424242) — stop it manually"
            ),
            "{args:?}: {err}"
        );
        assert!(err.contains("remove ~/.zzz/run/daemon.json"), "{err}");
        assert_eq!(fs::read_to_string(daemon_json(&home)).unwrap(), v1);
        assert!(
            !cleanup.ready_marker().exists(),
            "{args:?}: nothing spawned"
        );
    }
}

#[test]
fn open_requires_init() {
    let home = temp_home("uninit");
    let _cleanup = Cleanup::new(&home);
    let out = run(zzz(&home).arg("open"));
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr(&out).contains("zzz init"), "{}", stderr(&out));
}

#[test]
fn open_expands_tilde_and_rejects_a_missing_path_before_starting() {
    let home = launchable_home("missing");
    let _cleanup = Cleanup::new(&home);
    // quoted, so the shell didn't expand it: the CLI must
    let out = run(zzz(&home).arg("~/does/not/exist"));
    assert_eq!(out.status.code(), Some(1), "stderr: {}", stderr(&out));
    let expected = home.join("does/not/exist").display().to_string();
    assert!(stderr(&out).contains(&expected), "{}", stderr(&out));
    assert!(!daemon_json(&home).exists(), "no daemon started");
    assert!(
        !home.join(".zzz/run/daemon.log").exists(),
        "no spawn attempted"
    );
}

#[test]
fn start_requires_a_ui_build() {
    let home = initialized_home("nostatic");
    let _cleanup = Cleanup::new(&home);
    let out = run(zzz(&home).args(["daemon", "start"]));
    assert_eq!(out.status.code(), Some(2));
    let err = stderr(&out);
    assert!(err.contains("no UI build found"), "{err}");
    assert!(err.contains(".zzz/static"), "{err}");

    // a set-but-missing ZZZ_STATIC_DIR is its own error, not a fallback
    fs::create_dir_all(home.join(".zzz/static")).unwrap();
    let out = run(zzz(&home)
        .args(["daemon", "start"])
        .env("ZZZ_STATIC_DIR", "nope"));
    assert_eq!(out.status.code(), Some(2));
    assert!(
        stderr(&out).contains("ZZZ_STATIC_DIR is not a directory"),
        "{}",
        stderr(&out)
    );
}

#[test]
fn start_requires_the_database_and_cookie_env() {
    let home = initialized_home("noenv");
    let _cleanup = Cleanup::new(&home);
    fs::create_dir_all(home.join(".zzz/static")).unwrap();
    let out = run(zzz(&home).args(["daemon", "start"]));
    assert_eq!(out.status.code(), Some(2));
    let err = stderr(&out);
    assert!(
        err.contains("DATABASE_URL, SECRET_FUZ_COOKIE_KEYS"),
        "{err}"
    );
    assert!(err.contains(".zzz/.env"), "{err}");
}

#[test]
fn skipped_env_lines_warn_by_number_without_echoing() {
    let home = initialized_home("badenv");
    let _cleanup = Cleanup::new(&home);
    fs::write(
        home.join(".zzz/.env"),
        "\u{feff}DATABASE_URL=postgres://x\nSECRET_FUZ_COOKIE_KEYS topsecretvalue\n",
    )
    .unwrap();
    let out = run(zzz(&home).args(["daemon", "start"]));
    let err = stderr(&out);
    assert!(err.contains("skipped line(s) 2"), "{err}");
    assert!(!err.contains("topsecretvalue"), "{err}");
}

#[test]
fn a_port_in_use_hints_only_at_flags_the_command_has() {
    let home = launchable_home("busy");
    let _cleanup = Cleanup::new(&home);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let out = run(zzz(&home).args(["daemon", "start", "--port", &port.to_string()]));
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(
        err.contains(&format!("port {port} is already in use")),
        "{err}"
    );
    assert!(err.contains("`--port`"), "{err}");
    assert!(!daemon_json(&home).exists());

    // `zzz` has no --port: the hint doesn't offer one
    let out = run(zzz(&home).arg("open").env("ZZZ_PORT", port.to_string()));
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(
        err.contains(&format!("port {port} is already in use")),
        "{err}"
    );
    assert!(err.contains("ZZZ_PORT"), "{err}");
    assert!(!err.contains("--port"), "{err}");
}

#[test]
fn invalid_ports_are_errors_at_every_source() {
    let home = launchable_home("badport");
    let _cleanup = Cleanup::new(&home);

    // the flag (argh rejects it before anything runs)
    for args in [
        &["daemon", "start", "--port", "0"][..],
        &["daemon", "start", "--port", "65536"][..],
        &["init", "--port", "0"][..],
    ] {
        let out = run(zzz(&home).args(args));
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(
            stderr(&out).contains("expected a port in 1..=65535"),
            "{args:?}: {}",
            stderr(&out)
        );
    }

    // ZZZ_PORT
    let out = run(zzz(&home).args(["daemon", "start"]).env("ZZZ_PORT", "0"));
    assert_eq!(out.status.code(), Some(2));
    assert!(
        stderr(&out).contains("ZZZ_PORT: expected a port"),
        "{}",
        stderr(&out)
    );

    // config.json: an invalid port, or a file that doesn't parse, names the file
    let config = home.join(".zzz/config.json");
    for content in [r#"{"zzz_config_port": 0}"#, "{\"zzz_config_port\": 4460,}"] {
        fs::write(&config, content).unwrap();
        let out = run(zzz(&home).args(["daemon", "start"]));
        assert_eq!(out.status.code(), Some(2), "{content}");
        let err = stderr(&out);
        assert!(err.contains(&config.display().to_string()), "{err}");
    }
    assert!(!daemon_json(&home).exists());
}

#[test]
fn the_launch_reports_env_overrides_and_strips_test_actions() {
    let home = launchable_home("envnote");
    let _cleanup = Cleanup::new(&home);
    fs::write(
        home.join(".zzz/.env"),
        "DATABASE_URL=postgres://file-value\nSECRET_FUZ_COOKIE_KEYS=file-keys-0123456789abcdef0123\nZZZ_ENABLE_TEST_ACTIONS=true\n",
    )
    .unwrap();
    let bin = home.join("fake_zzzd");
    write_script(
        &bin,
        "echo \"fake zzzd: test_actions=${ZZZ_ENABLE_TEST_ACTIONS-unset}\" >&2\nexit 3",
    );
    for process_value in [None, Some("1")] {
        let mut command = zzz(&home);
        command
            .args(["daemon", "start", "--port", &free_port().to_string()])
            .env("ZZZ_SERVER_BIN", &bin)
            .env("DATABASE_URL", "postgres://process-value")
            // the same value as the file's isn't an override
            .env("SECRET_FUZ_COOKIE_KEYS", "file-keys-0123456789abcdef0123");
        if let Some(value) = process_value {
            command.env("ZZZ_ENABLE_TEST_ACTIONS", value);
        }
        let out = run(&mut command);
        let err = stderr(&out);
        assert!(
            err.contains(&format!(
                "note: the environment overrides DATABASE_URL from {}",
                home.join(".zzz/.env").display()
            )),
            "{err}"
        );
        // names only, never values
        assert!(
            !err.contains("process-value") && !err.contains("file-value"),
            "{err}"
        );
        assert!(
            err.contains("warning: ignoring ZZZ_ENABLE_TEST_ACTIONS"),
            "{err}"
        );
        assert!(err.contains("fake zzzd: test_actions=unset"), "{err}");
    }
}

#[test]
fn the_daemon_binary_is_never_taken_from_the_current_directory() {
    let home = launchable_home("cwdbin");
    let _cleanup = Cleanup::new(&home);
    // `zzz` alone in a directory, so there's no `zzzd` beside it whatever
    // the build state (a hard link where possible: the same inode, cheap)
    let bin_dir = home.join("cli");
    fs::create_dir_all(&bin_dir).unwrap();
    let lone_zzz = bin_dir.join("zzz");
    if fs::hard_link(zzz_bin(), &lone_zzz).is_err() {
        fs::copy(zzz_bin(), &lone_zzz).unwrap();
    }
    // an untrusted checkout, with its own `target/debug/zzzd` — and `.` on
    // the PATH
    let checkout = home.join("checkout");
    fs::create_dir_all(checkout.join("target/debug")).unwrap();
    let marker = home.join("untrusted_ran");
    let untrusted = format!("touch '{}'", marker.display());
    write_script(&checkout.join("target/debug/zzzd"), &untrusted);
    write_script(&checkout.join("zzzd"), &untrusted);

    let mut command = Command::new(&lone_zzz);
    command.env("HOME", &home);
    for key in CLI_ENV {
        command.env_remove(key);
    }
    let out = run(command
        .args(["daemon", "start", "--port", &free_port().to_string()])
        .current_dir(&checkout)
        .env(
            "PATH",
            format!(".::target/debug:{}", home.join("empty").display()),
        ));
    assert_eq!(out.status.code(), Some(2), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("can't find the zzzd daemon binary"),
        "{}",
        stderr(&out)
    );
    assert!(!marker.exists(), "ran the checkout's zzzd");
}

#[test]
fn a_bad_server_bin_override_is_a_clear_error() {
    let home = launchable_home("badbin");
    let _cleanup = Cleanup::new(&home);
    let not_executable = home.join("zzzd.txt");
    fs::write(&not_executable, "").unwrap();
    for bin in [home.join("missing_zzzd"), not_executable] {
        let out = run(zzz(&home)
            .args(["daemon", "start", "--port", &free_port().to_string()])
            .env("ZZZ_SERVER_BIN", &bin));
        assert_eq!(out.status.code(), Some(2), "stderr: {}", stderr(&out));
        assert!(
            stderr(&out).contains(&format!(
                "ZZZ_SERVER_BIN is not an executable file: {}",
                bin.display()
            )),
            "{}",
            stderr(&out)
        );
    }
}

#[test]
fn start_reports_an_early_exit_at_once() {
    let home = launchable_home("early");
    let _cleanup = Cleanup::new(&home);
    let bin = home.join("fake_zzzd");
    write_script(
        &bin,
        "echo \"fake zzzd: boom with $DATABASE_URL\" >&2\nexit 3",
    );

    // foreground: the child's stderr is inherited, the error names the
    // status; an empty process value doesn't shadow the file's
    let started = Instant::now();
    let out = run(zzz(&home)
        .args(["daemon", "start", "--port", &free_port().to_string()])
        .env("ZZZ_SERVER_BIN", &bin)
        .env("DATABASE_URL", ""));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "no timeout wait"
    );
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(
        err.contains("fake zzzd: boom with postgres://localhost/zzz_cli_test"),
        "{err}"
    );
    assert!(err.contains("exited before becoming healthy"), "{err}");
    assert!(err.contains("exit status: 3"), "{err}");

    // detached (`zzz open`): the log tail is shown, the error names the log
    let log_path = home.join(".zzz/run/daemon.log");
    fs::write(&log_path, "old log\n").unwrap();
    fs::set_permissions(&log_path, fs::Permissions::from_mode(0o644)).unwrap();
    let out = run(zzz(&home)
        .arg("open")
        .env("ZZZ_PORT", free_port().to_string())
        .env("ZZZ_SERVER_BIN", &bin));
    assert_eq!(out.status.code(), Some(1));
    let err = stderr(&out);
    assert!(err.contains("fake zzzd: boom"), "{err}");
    assert!(err.contains("daemon.log"), "{err}");
    // an existing log is tightened to 0600 too
    let log_mode = fs::metadata(&log_path).unwrap().permissions().mode();
    assert_eq!(log_mode & 0o777, 0o600);
    assert!(!daemon_json(&home).exists());
}

#[test]
fn init_writes_private_files_once() {
    let home = temp_home("init");
    let _cleanup = Cleanup::new(&home);
    let out = run(zzz(&home).args(["init", "--port", "4999"]));
    assert!(out.status.success(), "stderr: {}", stderr(&out));

    let zzz_dir = home.join(".zzz");
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&zzz_dir), 0o700);
    assert_eq!(mode(&zzz_dir.join(".env")), 0o600);
    assert_eq!(mode(&zzz_dir.join("bootstrap_token")), 0o600);
    assert!(zzz_dir.join(".zzz").is_dir(), "app dir");
    assert!(
        fs::read_to_string(zzz_dir.join("config.json"))
            .unwrap()
            .contains("4999")
    );
    let env = fs::read_to_string(zzz_dir.join(".env")).unwrap();
    let key = env
        .lines()
        .find_map(|line| line.strip_prefix("SECRET_FUZ_COOKIE_KEYS="))
        .unwrap();
    assert_eq!(key.len(), 64);
    assert!(key.chars().all(|c| c.is_ascii_hexdigit()));

    // re-running changes nothing, and says an explicit --port wasn't applied
    let out = run(zzz(&home).args(["init", "--port", "5000"]));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("--port 5000 not applied"),
        "{}",
        stderr(&out)
    );
    assert_eq!(fs::read_to_string(zzz_dir.join(".env")).unwrap(), env);
    assert!(
        fs::read_to_string(zzz_dir.join("config.json"))
            .unwrap()
            .contains("4999")
    );

    // a loosened home is left alone, with a warning
    fs::set_permissions(&zzz_dir, fs::Permissions::from_mode(0o755)).unwrap();
    let out = run(zzz(&home).arg("init"));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("accessible to other users"),
        "{}",
        stderr(&out)
    );
    assert_eq!(mode(&zzz_dir), 0o755);
}

#[test]
fn init_recreates_a_missing_bootstrap_token() {
    let home = temp_home("init_token");
    let _cleanup = Cleanup::new(&home);
    let zzz_dir = home.join(".zzz");
    let token_path = zzz_dir.join("bootstrap_token");
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

    let out = run(zzz(&home).arg("init"));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let first_token = fs::read_to_string(&token_path).unwrap();
    assert!(
        !stdout(&out).contains("zzz daemon stop"),
        "a fresh home needs no restart hint: {}",
        stdout(&out)
    );

    // an existing token is kept
    let out = run(zzz(&home).arg("init"));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(fs::read_to_string(&token_path).unwrap(), first_token);

    // consumed by a bootstrap (the daemon deletes it) — or a hand-written
    // `.env` with no token — and the next init mints a fresh one, private
    let env = fs::read_to_string(zzz_dir.join(".env")).unwrap();
    fs::remove_file(&token_path).unwrap();
    let out = run(zzz(&home).arg("init"));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let token = fs::read_to_string(&token_path).unwrap();
    assert_eq!(token.len(), 64);
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(token, first_token);
    assert_eq!(mode(&token_path), 0o600);
    assert_eq!(
        fs::read_to_string(zzz_dir.join(".env")).unwrap(),
        env,
        ".env untouched"
    );
    assert!(
        stdout(&out).contains(&format!("created {}", token_path.display())),
        "{}",
        stdout(&out)
    );
    // zzzd reads bootstrap availability once, at boot — but whether that
    // matters depends on the database, which the CLI can't see
    assert!(
        stdout(&out).contains("only if zzz has no admin account")
            && stdout(&out).contains("`zzz daemon stop`, then `zzz`"),
        "{}",
        stdout(&out)
    );
}

/// How a stand-in daemon behaves.
#[derive(Default, Clone, Copy)]
struct FakeDaemon {
    /// Seconds to sleep before serving (a slow start).
    delay_secs: u32,
    /// Ignore `SIGTERM` (a daemon that won't stop).
    ignore_sigterm: bool,
    /// Exit with code 7 this many seconds after starting (a crash).
    crash_after_secs: Option<u32>,
}

/// A stand-in `zzzd`: appends `pid start-ticks` to the cleanup pidfile,
/// records its working directory, args, and the env the CLI assembled, then
/// `exec`s a single `python3` process that installs its `SIGTERM` handling
/// (exit 0, like `zzzd`, or ignore), touches the ready marker, optionally
/// sleeps (a slow start) and serves `/health` on `--port`. `None` (with a
/// visible SKIPPED line) when `python3` is missing.
fn write_fake_daemon(
    test: &str,
    cleanup: &Cleanup,
    fake: FakeDaemon,
) -> Option<(PathBuf, PathBuf)> {
    let has_python = Command::new("python3")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !has_python {
        skip(test, "python3 not found (needed for the stand-in daemon)");
        return None;
    }
    let bin = cleanup.home.join("fake_zzzd");
    let record = cleanup.home.join("fake_zzzd.record");
    let on_term = if fake.ignore_sigterm {
        "signal.SIG_IGN"
    } else {
        "lambda *_: os._exit(0)"
    };
    let crash_after = fake
        .crash_after_secs
        .map_or_else(|| "None".to_owned(), |secs| secs.to_string());
    write_script(
        &bin,
        &format!(
            r#"echo "$$ $(cut -d' ' -f22 /proc/$$/stat)" >> '{pidfile}'
{{ pwd -P; echo "args=$*"; echo "DATABASE_URL=$DATABASE_URL"; echo "FUZ_ALLOWED_ORIGINS=$FUZ_ALLOWED_ORIGINS"; echo "PUBLIC_ZZZ_DIR=${{PUBLIC_ZZZ_DIR-unset}}"; }} > '{record}'
exec python3 -c '
import http.server, os, signal, sys, threading, time
signal.signal(signal.SIGTERM, {on_term})
open("{ready}", "w").close()
if {crash_after} is not None:
    threading.Timer({crash_after}, lambda: os._exit(7)).start()
time.sleep({delay})
port = int(sys.argv[sys.argv.index("--port") + 1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"{{\"status\":\"ok\"}}"
        self.send_response(200 if self.path == "/health" else 404)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
' "$@""#,
            pidfile = cleanup.pidfile.display(),
            record = record.display(),
            ready = cleanup.ready_marker().display(),
            delay = fake.delay_secs,
        ),
    );
    Some((bin, record))
}

fn wait_for(mut condition: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for {what}");
}

/// Wait for a spawned `zzz` to exit; returns its output.
fn wait_output(child: Child) -> Output {
    child.wait_with_output().unwrap()
}

/// Proxy env that would break a health probe that honored it.
const DEAD_PROXY: &[(&str, &str)] = &[
    ("HTTP_PROXY", "http://127.0.0.1:9"),
    ("http_proxy", "http://127.0.0.1:9"),
    ("ALL_PROXY", "http://127.0.0.1:9"),
];

#[test]
fn foreground_start_status_stop_with_a_stand_in_daemon() {
    const TEST: &str = "foreground_start_status_stop_with_a_stand_in_daemon";
    let home = launchable_home("fg");
    let mut cleanup = Cleanup::new(&home);
    let Some((bin, record)) = write_fake_daemon(TEST, &cleanup, FakeDaemon::default()) else {
        return;
    };
    fs::create_dir_all(home.join("uibuild")).unwrap();

    // retry on the rare race where the free port is taken before zzz binds
    let mut port = 0;
    for attempt in 0.. {
        port = free_port();
        let start = zzz(&home)
            .args(["daemon", "start", "--port", &port.to_string()])
            .current_dir(&home)
            .env("ZZZ_SERVER_BIN", &bin)
            // relative to where `zzz` runs, not the daemon's ~/.zzz
            .env("ZZZ_STATIC_DIR", "uibuild")
            // the process env wins over ~/.zzz/.env
            .env("DATABASE_URL", "postgres://localhost/from_process_env")
            // blank reads as unset: removed, never passed to zzzd
            .env("PUBLIC_ZZZ_DIR", "")
            .envs(DEAD_PROXY.iter().copied())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        cleanup.children.push(start);
        wait_for(
            || {
                daemon_json(&home).exists()
                    || cleanup
                        .children
                        .last_mut()
                        .unwrap()
                        .try_wait()
                        .unwrap()
                        .is_some()
            },
            "daemon.json or an exit",
        );
        if daemon_json(&home).exists() {
            break;
        }
        let out = wait_output(cleanup.children.pop().unwrap());
        assert!(
            attempt < 3 && stderr(&out).contains("already in use"),
            "start failed: {}",
            stderr(&out)
        );
    }

    let out = run(zzz(&home)
        .args(["daemon", "status", "--json"])
        .envs(DEAD_PROXY.iter().copied()));
    assert_eq!(out.status.code(), Some(0), "stderr: {}", stderr(&out));
    assert!(
        stdout(&out).contains("\"healthy\":true"),
        "{}",
        stdout(&out)
    );

    // the daemon ran in ~/.zzz with --port / --static-dir and the merged env
    let recorded = fs::read_to_string(&record).unwrap();
    let mut lines = recorded.lines();
    assert_eq!(lines.next(), Some(home.join(".zzz").to_str().unwrap()));
    assert_eq!(
        lines.next().unwrap(),
        format!(
            "args=--port {port} --static-dir {}",
            home.join("uibuild").display()
        )
    );
    assert_eq!(
        lines.next(),
        Some("DATABASE_URL=postgres://localhost/from_process_env")
    );
    assert_eq!(
        lines.next().unwrap(),
        format!("FUZ_ALLOWED_ORIGINS=http://localhost:{port},http://127.0.0.1:{port}")
    );
    assert_eq!(lines.next(), Some("PUBLIC_ZZZ_DIR=unset"));

    // a second start is refused while the first runs
    let out = run(zzz(&home).args(["daemon", "start"]));
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("already running"), "{}", stderr(&out));

    let out = run(zzz(&home).args(["daemon", "stop"]));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(stdout(&out).contains("stopped"), "{}", stdout(&out));
    let status = cleanup.children.last_mut().unwrap().wait().unwrap();
    assert!(status.success(), "foreground start exits cleanly: {status}");
    assert!(!daemon_json(&home).exists());
}

/// A path to the browser opener stub, so tests never launch a real browser.
fn fake_browser_path(home: &Path) -> String {
    let fake_path = home.join("fake_path");
    fs::create_dir_all(&fake_path).unwrap();
    write_script(&fake_path.join("xdg-open"), "exit 0");
    format!(
        "{}:{}",
        fake_path.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

#[test]
fn open_auto_starts_a_detached_daemon() {
    const TEST: &str = "open_auto_starts_a_detached_daemon";
    let home = launchable_home("detached");
    let cleanup = Cleanup::new(&home);
    let Some((bin, record)) = write_fake_daemon(TEST, &cleanup, FakeDaemon::default()) else {
        return;
    };
    let path = fake_browser_path(&home);
    let workspace = home.join("project");
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("file.txt"), "").unwrap();

    let mut attempt = 0;
    let out = loop {
        let out = run(zzz(&home)
            .arg("project/file.txt")
            .current_dir(&home)
            .env("PATH", &path)
            .env("ZZZ_PORT", free_port().to_string())
            .env("ZZZ_SERVER_BIN", &bin)
            .envs(DEAD_PROXY.iter().copied()));
        attempt += 1;
        if out.status.success() || attempt > 3 || !stderr(&out).contains("already in use") {
            break out;
        }
    };
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let text = stdout(&out);
    assert!(text.contains("is a file; opening its directory"), "{text}");
    let encoded = format!("{}/", workspace.display()).replace('/', "%2F");
    assert!(
        text.contains(&format!("/workspaces?workspace={encoded}")),
        "{text}"
    );
    assert!(record.exists(), "daemon spawned");

    // the daemon outlives the CLI; discovery finds it, stop ends it
    let out = run(zzz(&home).arg("status"));
    assert_eq!(out.status.code(), Some(0), "stdout: {}", stdout(&out));
    let out = run(zzz(&home).args(["daemon", "stop"]));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert!(!daemon_json(&home).exists());
    for pid in cleanup.daemon_pids() {
        assert!(!is_running(pid), "daemon {pid} stopped");
    }
}

/// A stand-in opener (or browser stub): records its argument count, each
/// argument on its own line, and whether it was given
/// `ZZZ_ENABLE_TEST_ACTIONS`, in `record` — written whole, then renamed into
/// place, so a reader never sees half of it.
fn write_recording_opener(path: &Path, record: &Path) {
    write_script(
        path,
        &format!(
            r#"{{ echo "argc=$#"; for arg in "$@"; do printf 'arg=%s\n' "$arg"; done; echo "test_actions=${{ZZZ_ENABLE_TEST_ACTIONS-unset}}"; }} > '{record}.tmp'
mv '{record}.tmp' '{record}'"#,
            record = record.display(),
        ),
    );
}

/// Wait for a recording opener to run, and take what it recorded.
fn take_record(record: &Path) -> Vec<String> {
    wait_for(|| record.exists(), "the opener to run");
    let lines = fs::read_to_string(record)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    fs::remove_file(record).unwrap();
    lines
}

/// `encodeURIComponent`, as the CLI encodes the workspace param.
fn encode_uri_component(input: &str) -> String {
    input
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => (byte as char).to_string(),
            _ if b"-_.!~*'()".contains(&byte) => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[test]
fn open_runs_the_configured_opener_with_the_url_as_its_final_argument() {
    const TEST: &str = "open_runs_the_configured_opener_with_the_url_as_its_final_argument";
    let home = launchable_home("opener");
    let cleanup = Cleanup::new(&home);
    let Some((bin, _record)) = write_fake_daemon(TEST, &cleanup, FakeDaemon::default()) else {
        return;
    };
    let config = home.join(".zzz/config.json");

    // the browser stub records too, so a fallback to it shows
    let path = fake_browser_path(&home);
    let browser_record = home.join("browser.record");
    write_recording_opener(&home.join("fake_path/xdg-open"), &browser_record);
    let env_record = home.join("env_opener.record");
    write_recording_opener(&home.join("env_opener"), &env_record);
    let config_record = home.join("config_opener.record");
    fs::create_dir_all(home.join(".zzz/bin")).unwrap();
    write_recording_opener(&home.join(".zzz/bin/config_opener"), &config_record);
    let others_are_quiet = |records: &[&PathBuf]| {
        // give a wrongly launched (detached) opener time to record
        std::thread::sleep(Duration::from_millis(300));
        for record in records {
            assert!(!record.exists(), "{} also ran", record.display());
        }
    };

    // a workspace whose URL a shell would mangle, reached through a symlink
    let workspace = home.join("a b's (x) *!$HOME;&");
    fs::create_dir_all(&workspace).unwrap();
    std::os::unix::fs::symlink(&workspace, home.join("link")).unwrap();

    // `ZZZ_OPENER` (relative to where zzz runs): the URL is its one argument
    let mut attempt = 0;
    let (out, port) = loop {
        let port = free_port();
        let out = run(zzz(&home)
            .arg("link")
            .current_dir(&home)
            .env("PATH", &path)
            .env("ZZZ_PORT", port.to_string())
            .env("ZZZ_SERVER_BIN", &bin)
            .env("ZZZ_OPENER", "./env_opener")
            .env("ZZZ_ENABLE_TEST_ACTIONS", "1")
            .envs(DEAD_PROXY.iter().copied()));
        attempt += 1;
        if out.status.success() || attempt > 3 || !stderr(&out).contains("already in use") {
            break (out, port);
        }
    };
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    // the canonical directory, not the symlink
    let workspace_url = format!(
        "http://localhost:{port}/workspaces?workspace={}",
        encode_uri_component(&format!("{}/", workspace.display()))
    );
    assert!(workspace_url.contains("a%20b's%20(x)%20*!%24HOME%3B%26"));
    assert_eq!(
        take_record(&env_record),
        [
            "argc=1".to_owned(),
            format!("arg={workspace_url}"),
            "test_actions=unset".to_owned()
        ]
    );
    others_are_quiet(&[&browser_record, &config_record]);
    let log_mode = fs::metadata(home.join(".zzz/run/opener.log"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(log_mode & 0o777, 0o600);

    // the daemon is running now: every later `zzz` reuses it
    let url = format!("http://localhost:{port}");
    let open = |config_json: Option<&str>, env_opener: Option<&str>| {
        match config_json {
            Some(content) => fs::write(&config, content).unwrap(),
            None => {
                let _ = fs::remove_file(&config);
            }
        }
        let mut command = zzz(&home);
        command
            .current_dir(&home)
            .env("PATH", &path)
            .env("ZZZ_ENABLE_TEST_ACTIONS", "1")
            .envs(DEAD_PROXY.iter().copied());
        if let Some(value) = env_opener {
            command.env("ZZZ_OPENER", value);
        }
        let out = run(&mut command);
        assert!(
            out.status.success(),
            "{config_json:?} {env_opener:?}: {}",
            stderr(&out)
        );
        assert!(stdout(&out).contains(&format!("opening {url}")));
    };
    let bare = [
        "argc=1".to_owned(),
        format!("arg={url}"),
        "test_actions=unset".to_owned(),
    ];

    // an array is the program (relative to ~/.zzz) and its arguments, passed
    // through verbatim, with the URL last; the config beats the environment
    open(
        Some(r#"{"opener": ["bin/config_opener", "--flag", "two words", "$HOME;*", ""]}"#),
        Some("./env_opener"),
    );
    assert_eq!(
        take_record(&config_record),
        [
            "argc=5",
            "arg=--flag",
            "arg=two words",
            "arg=$HOME;*",
            "arg=",
            &format!("arg={url}"),
            "test_actions=unset"
        ]
    );
    others_are_quiet(&[&browser_record, &env_record]);

    // a string is the program alone; `~` expands
    open(Some(r#"{"opener": "~/.zzz/bin/config_opener"}"#), None);
    assert_eq!(take_record(&config_record), bare);
    open(None, Some("~/env_opener"));
    assert_eq!(take_record(&env_record), bare);

    // a blank config value reads as unset: the environment's opener runs
    for blank in [r#"{"opener": "  "}"#, r#"{"opener": null}"#] {
        open(Some(blank), Some("./env_opener"));
        assert_eq!(take_record(&env_record), bare, "{blank}");
        others_are_quiet(&[&browser_record, &config_record]);
    }

    // both blank (or absent): the browser, as without an opener
    for (config_json, env_opener) in [(Some(r#"{"opener": ""}"#), Some(" ")), (None, None)] {
        open(config_json, env_opener);
        assert_eq!(take_record(&browser_record)[..2], bare[..2]);
        others_are_quiet(&[&env_record, &config_record]);
    }

    // an opener that passes validation but can't be executed (no `#!` line):
    // a spawn failure, exit 1, and no fallback to the browser
    let no_shebang = home.join("no_shebang_opener");
    fs::write(&no_shebang, "echo not a program\n").unwrap();
    fs::set_permissions(&no_shebang, fs::Permissions::from_mode(0o755)).unwrap();
    let failing_open = |needle: &str| {
        let out = run(zzz(&home)
            .current_dir(&home)
            .env("PATH", &path)
            .env("ZZZ_OPENER", "./no_shebang_opener")
            .envs(DEAD_PROXY.iter().copied()));
        let err = stderr(&out);
        assert_eq!(out.status.code(), Some(1), "{needle}: {err}");
        assert!(err.contains(needle), "{needle}: {err}");
    };
    failing_open(&format!(
        "failed to run the opener {}: ",
        home.join("./no_shebang_opener").display()
    ));

    // a log that can't be opened is an error naming it
    let log_path = home.join(".zzz/run/opener.log");
    fs::remove_file(&log_path).unwrap();
    fs::create_dir(&log_path).unwrap();
    failing_open(&format!("can't open the log {}: ", log_path.display()));
    others_are_quiet(&[&browser_record, &env_record, &config_record]);

    let out = run(zzz(&home).args(["daemon", "stop"]));
    assert!(out.status.success(), "stderr: {}", stderr(&out));
}

#[test]
fn a_bad_opener_exits_2_without_launching_anything() {
    let home = launchable_home("badopener");
    let cleanup = Cleanup::new(&home);
    let config = home.join(".zzz/config.json");
    // a daemon and a browser that would leave a mark, if either were run
    let bin = home.join("fake_zzzd");
    write_script(
        &bin,
        &format!("touch '{}'", cleanup.ready_marker().display()),
    );
    let path = fake_browser_path(&home);
    let browser_record = home.join("browser.record");
    write_recording_opener(&home.join("fake_path/xdg-open"), &browser_record);
    let good_record = home.join("good_opener.record");
    write_recording_opener(&home.join("good_opener"), &good_record);
    let not_executable = home.join("opener.txt");
    fs::write(&not_executable, "#!/bin/sh\n").unwrap();
    fs::create_dir_all(home.join("project")).unwrap();

    let check = |config_json: Option<&str>, env_opener: Option<&str>, needle: &str| {
        match config_json {
            Some(content) => fs::write(&config, content).unwrap(),
            None => {
                let _ = fs::remove_file(&config);
            }
        }
        for args in [&[][..], &["open", "project"][..]] {
            let mut command = zzz(&home);
            command
                .args(args)
                .current_dir(&home)
                .env("PATH", &path)
                .env("ZZZ_PORT", free_port().to_string())
                .env("ZZZ_SERVER_BIN", &bin);
            if let Some(value) = env_opener {
                command.env("ZZZ_OPENER", value);
            }
            let out = run(&mut command);
            let err = stderr(&out);
            assert_eq!(out.status.code(), Some(2), "{needle}: {err}");
            assert!(err.contains(needle), "{needle}: {err}");
        }
    };
    let config_path = config.display().to_string();
    let in_config = format!("`opener` in {config_path} is not an executable file: ");
    let bad_config = format!("invalid {config_path}: opener: ");

    // a missing program, a file that isn't executable, a directory — from
    // either source
    let missing = home.join("./missing_opener").display().to_string();
    check(
        None,
        Some("./missing_opener"),
        &format!("ZZZ_OPENER is not an executable file: {missing}"),
    );
    check(
        None,
        Some(not_executable.to_str().unwrap()),
        &format!(
            "ZZZ_OPENER is not an executable file: {}",
            not_executable.display()
        ),
    );
    check(
        None,
        Some("./project"),
        "ZZZ_OPENER is not an executable file",
    );
    check(
        Some(r#"{"opener": "bin/missing_opener"}"#),
        None,
        &format!(
            "{in_config}{}",
            home.join(".zzz/bin/missing_opener").display()
        ),
    );
    // a bare name is refused from either source: never searched for on
    // $PATH (`xdg-open` is there), and never run from the directory zzz runs
    // in or from ~/.zzz, though an executable of that name sits in each
    // (`~good_opener` too: only `~` and `~/…` expand)
    write_recording_opener(&home.join(".zzz/good_opener"), &good_record);
    write_recording_opener(&home.join("~good_opener"), &good_record);
    write_recording_opener(&home.join(".zzz/~good_opener"), &good_record);
    for bare in ["xdg-open", "good_opener", "~good_opener"] {
        check(
            None,
            Some(bare),
            &format!("ZZZ_OPENER is not an executable file: {bare}\n"),
        );
        check(
            Some(&format!(r#"{{"opener": ["{bare}", "--flag"]}}"#)),
            None,
            &format!("{in_config}{bare}\n"),
        );
    }
    check(None, Some("good_opener"), "write `./name`");
    check(
        Some(&format!(
            r#"{{"opener": ["{}", "--flag"]}}"#,
            not_executable.display()
        )),
        None,
        &format!("{in_config}{}", not_executable.display()),
    );
    // a bad config opener is no reason to use the environment's good one
    check(
        Some(r#"{"opener": "bin/missing_opener"}"#),
        Some("./good_opener"),
        &in_config,
    );

    // a malformed `opener` names the file
    for (content, reason) in [
        (
            r#"{"opener": 5}"#,
            "expected a program path or an array of strings, got `5`",
        ),
        (
            r#"{"opener": {"program": "good_opener"}}"#,
            "expected a program path",
        ),
        (
            r#"{"opener": []}"#,
            "expected a program, got an empty array",
        ),
        (
            r#"{"opener": ["good_opener", 5]}"#,
            "expected an array of strings, got the element `5`",
        ),
        (
            r#"{"opener": ["", "--flag"]}"#,
            "the program (the array's first element) is blank",
        ),
    ] {
        check(
            Some(content),
            Some("./good_opener"),
            &format!("{bad_config}{reason}"),
        );
    }
    // as does a config that isn't a JSON object
    check(
        Some("[]"),
        Some("./good_opener"),
        &format!("invalid {config_path}: expected a JSON object"),
    );

    std::thread::sleep(Duration::from_millis(300));
    assert!(!cleanup.ready_marker().exists(), "no daemon spawned");
    assert!(!daemon_json(&home).exists(), "no daemon recorded");
    assert!(
        !home.join(".zzz/run/daemon.log").exists(),
        "no spawn attempted"
    );
    assert!(!home.join(".zzz/run/opener.log").exists(), "no opener run");
    assert!(!browser_record.exists(), "no browser fallback");
    assert!(!good_record.exists(), "no opener run");
}

/// Start `zzz <args>` against a slow stand-in daemon, signal the CLI while
/// the daemon is still starting, and check the daemon was stopped and never
/// recorded.
fn signal_during_start(test: &str, args: &[&str], signal: &str, exit_code: i32) {
    let home = launchable_home(test);
    let mut cleanup = Cleanup::new(&home);
    let Some((bin, _record)) = write_fake_daemon(
        test,
        &cleanup,
        FakeDaemon {
            delay_secs: 30,
            ..FakeDaemon::default()
        },
    ) else {
        return;
    };
    let path = fake_browser_path(&home);
    let start = zzz(&home)
        .args(args)
        .env("PATH", &path)
        .env("ZZZ_PORT", free_port().to_string())
        .env("ZZZ_SERVER_BIN", &bin)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let cli_pid = start.id();
    cleanup.children.push(start);
    wait_for(|| !cleanup.daemon_pids().is_empty(), "the daemon to spawn");
    let daemon_pid = cleanup.daemon_pids()[0];

    send_signal(cli_pid, signal);
    let out = wait_output(cleanup.children.pop().unwrap());
    assert_eq!(
        out.status.code(),
        Some(exit_code),
        "stderr: {}",
        stderr(&out)
    );
    assert!(
        stderr(&out).contains(&format!("interrupted by SIG{signal}")),
        "{}",
        stderr(&out)
    );
    assert!(!is_running(daemon_pid), "the starting daemon was stopped");
    assert!(!daemon_json(&home).exists(), "and never recorded");
}

#[test]
fn ctrl_c_during_a_detached_start_stops_the_daemon() {
    signal_during_start(
        "ctrl_c_during_a_detached_start_stops_the_daemon",
        &["open"],
        "INT",
        130,
    );
}

#[test]
fn a_hangup_during_a_foreground_start_stops_the_daemon() {
    signal_during_start(
        "a_hangup_during_a_foreground_start_stops_the_daemon",
        &["daemon", "start"],
        "HUP",
        129,
    );
}

#[test]
fn a_second_signal_kills_a_daemon_that_ignores_sigterm() {
    const TEST: &str = "a_second_signal_kills_a_daemon_that_ignores_sigterm";
    let home = launchable_home("second");
    let mut cleanup = Cleanup::new(&home);
    let Some((bin, _record)) = write_fake_daemon(
        TEST,
        &cleanup,
        FakeDaemon {
            delay_secs: 30,
            ignore_sigterm: true,
            ..FakeDaemon::default()
        },
    ) else {
        return;
    };
    let start = zzz(&home)
        .arg("open")
        .env("PATH", fake_browser_path(&home))
        .env("ZZZ_PORT", free_port().to_string())
        .env("ZZZ_SERVER_BIN", &bin)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let cli_pid = start.id();
    cleanup.children.push(start);
    wait_for(|| !cleanup.daemon_pids().is_empty(), "the daemon to spawn");
    let daemon_pid = cleanup.daemon_pids()[0];
    wait_for(|| cleanup.ready_marker().exists(), "the SIGTERM handler");

    let started = Instant::now();
    send_signal(cli_pid, "INT");
    std::thread::sleep(Duration::from_millis(300));
    send_signal(cli_pid, "INT");
    let out = wait_output(cleanup.children.pop().unwrap());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the second signal skipped the 10s grace"
    );
    assert_eq!(out.status.code(), Some(130), "stderr: {}", stderr(&out));
    assert!(stderr(&out).contains("signalled again"), "{}", stderr(&out));
    assert!(!is_running(daemon_pid), "killed");
}

#[test]
fn foreground_start_exits_with_the_daemons_status() {
    const TEST: &str = "foreground_start_exits_with_the_daemons_status";
    let home = launchable_home("crash");
    let mut cleanup = Cleanup::new(&home);
    let Some((bin, _record)) = write_fake_daemon(
        TEST,
        &cleanup,
        FakeDaemon {
            crash_after_secs: Some(5),
            ..FakeDaemon::default()
        },
    ) else {
        return;
    };
    let start = zzz(&home)
        .args(["daemon", "start", "--port", &free_port().to_string()])
        .env("ZZZ_SERVER_BIN", &bin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    cleanup.children.push(start);
    let out = wait_output(cleanup.children.pop().unwrap());
    // it served (and was recorded) before crashing with code 7
    assert!(stdout(&out).contains("daemon running"), "{}", stdout(&out));
    assert_eq!(out.status.code(), Some(7), "stderr: {}", stderr(&out));
    assert!(
        stderr(&out).contains("zzzd exited (exit status: 7)"),
        "{}",
        stderr(&out)
    );
    assert!(!daemon_json(&home).exists());
}
