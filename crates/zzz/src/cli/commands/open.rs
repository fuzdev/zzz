//! `zzz open` — default command.
//!
//! Opens the zzz browser UI, auto-starting the daemon if needed.
//! Handles `zzz`, `zzz <dir>`, and `zzz <file>`.
//!
//! The flow:
//!   1. Require init — `~/.zzz` must exist (`zzz init`).
//!   2. Resolve the path argument, if any: `~` expanded, joined onto the
//!      current directory, canonicalized (so it matches the canonical path
//!      the daemon stores for the workspace). A directory is the workspace;
//!      a file opens its parent directory. A path that doesn't exist is an
//!      error, before any daemon work.
//!   3. Daemon discovery — read `~/.zzz/run/daemon.json`, verify the process
//!      is still the recorded one and `/health` responds; a stale record is
//!      removed, an unresponsive daemon is stopped, and a record this zzz
//!      can't verify (an older zzz's) is an error, never replaced.
//!   4. Auto-start if not running — spawn `zzzd` **detached** (new process
//!      group, log-file stdio), wait until it serves, record `daemon.json`.
//!      This differs from `daemon start`, which runs the server in the
//!      foreground and forwards signals to it.
//!   5. Browser launch (`xdg-open` / `open` / `start`) with a
//!      `?workspace=<dir>` param; the authenticated browser opens the
//!      workspace (the CLI holds no credential for `workspace_open`).

use std::fs;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use argh::FromArgs;

use crate::CliError;
use crate::daemon_launch::DaemonLaunch;
use crate::daemon_lifecycle::{self as dl, DaemonInfo, DaemonState, StartOutcome};

/// Open file or directory in browser (default command).
///
/// Accepts at most one positional path.
#[derive(FromArgs, Debug)]
#[argh(subcommand, name = "open")]
pub struct Open {
    /// path to open — a directory, or a file (opens its directory)
    #[argh(positional)]
    pub path: Option<String>,
}

/// Handle `zzz open` (and the implicit no-subcommand default).
pub async fn cmd_open(args: &Open) -> Result<(), CliError> {
    dl::require_zzz_dir()?;

    let target = match args.path.as_deref() {
        Some(raw) => Some(resolve_target(raw, &std::env::current_dir()?)?),
        None => None,
    };
    if let Some(OpenTarget {
        file: Some(file),
        workspace,
    }) = &target
    {
        println!(
            "{} is a file; opening its directory {workspace}",
            file.display()
        );
    }

    let info = match discover_running_daemon().await? {
        Some(info) => info,
        None => start_daemon_detached().await?,
    };

    let url = build_url(info.port, target.as_ref().map(|t| t.workspace.as_str()));
    println!("opening {url}");
    open_browser(&url).await;
    Ok(())
}

/// A resolved `zzz open` argument.
#[derive(Debug, PartialEq, Eq)]
struct OpenTarget {
    /// Canonical workspace directory, with a trailing `/`.
    workspace: String,
    /// The canonical file, when the argument named one.
    file: Option<PathBuf>,
}

/// Resolve a path argument: expand `~`, join onto `cwd`, canonicalize, and
/// take a file's parent directory as the workspace.
fn resolve_target(raw: &str, cwd: &Path) -> Result<OpenTarget, CliError> {
    let absolute = cwd.join(fuz_sys::expand_tilde(raw));
    let bad_path = |reason: String| CliError::BadPath {
        path: absolute.display().to_string(),
        reason,
    };
    let canonical = fs::canonicalize(&absolute).map_err(|e| {
        bad_path(if e.kind() == std::io::ErrorKind::NotFound {
            "no such file or directory".to_owned()
        } else {
            e.to_string()
        })
    })?;
    let (dir, file) = if canonical.is_dir() {
        (canonical, None)
    } else {
        let parent = canonical
            .parent()
            .ok_or_else(|| bad_path("has no parent directory".to_owned()))?
            .to_path_buf();
        (parent, Some(canonical))
    };
    let mut workspace = dir
        .to_str()
        .ok_or_else(|| bad_path("path is not valid UTF-8".to_owned()))?
        .to_owned();
    if !workspace.ends_with('/') {
        workspace.push('/');
    }
    Ok(OpenTarget { workspace, file })
}

/// The browser URL, with the workspace param when a path was given.
fn build_url(port: u16, workspace: Option<&str>) -> String {
    let mut url = format!("http://localhost:{port}");
    if let Some(workspace) = workspace {
        url.push_str("/workspaces?workspace=");
        url.push_str(&encode_uri_component(workspace));
    }
    url
}

/// Return the recorded daemon only when it's running and answering
/// `/health`. A stale record is removed; an alive-but-unresponsive daemon
/// is stopped so the auto-start can take the port.
async fn discover_running_daemon() -> Result<Option<DaemonInfo>, CliError> {
    match dl::get_daemon_state().await {
        DaemonState::Running(info) => Ok(Some(info)),
        DaemonState::Stopped => Ok(None),
        DaemonState::Foreign(record) => Err(record.refuse("start a daemon")),
        DaemonState::Stale(info) => {
            dl::remove_daemon_info_if(&info)?;
            Ok(None)
        }
        DaemonState::Wedged(info) => {
            eprintln!(
                "warning: daemon pid {} on port {} is not responding; restarting",
                info.pid, info.port
            );
            if !dl::terminate(&info).await? {
                return Err(CliError::Daemon(format!(
                    "unresponsive daemon pid {} did not exit within {}s of SIGTERM; stop it manually",
                    info.pid,
                    dl::STOP_TIMEOUT.as_secs()
                )));
            }
            dl::remove_daemon_info_if(&info)?;
            Ok(None)
        }
    }
}

/// Spawn `zzzd` detached, wait until it serves, then record `daemon.json`.
///
/// Detached = a new process group (`process_group(0)`, so the daemon ignores
/// the launching terminal's Ctrl-C) with its stdio captured to
/// `~/.zzz/run/daemon.log` (mode `0600`, truncated per start), and the child
/// is never awaited (a dropped `std::process::Child` is not killed) — so the
/// daemon outlives this CLI invocation. It is process-group-detached, not
/// session-detached: a true `setsid` needs `unsafe`, which the workspace
/// forbids, so the daemon relies on orphaning-to-init plus the separate
/// process group to survive.
///
/// A daemon that exits early (bad config, unreachable database) fails the
/// start at once, with its exit status and the log's tail. Until it serves,
/// the child is this CLI's to clean up: a timeout, an error, or
/// SIGINT/SIGTERM/SIGHUP stops it (`SIGTERM`, then `SIGKILL`) rather than
/// leaving an unrecorded daemon behind. `daemon.json` is written only once
/// it serves, so a concurrent `zzz` never takes a starting daemon for a
/// wedged one.
async fn start_daemon_detached() -> Result<DaemonInfo, CliError> {
    use std::os::unix::fs::PermissionsExt as _;
    use std::os::unix::process::CommandExt as _;

    let launch = DaemonLaunch::prepare(None)?;
    let port = launch.port;
    dl::require_free_port(port, false)?;
    let bin = dl::resolve_server_bin()?;

    let run_dir = launch.cwd.join("run");
    fs::create_dir_all(&run_dir)?;
    let log_path = run_dir.join("daemon.log");
    let log = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&log_path)?;
    // `mode` applies only on create; an existing log is tightened too
    log.set_permissions(fs::Permissions::from_mode(0o600))?;
    let log_err = log.try_clone()?;

    // Read before the spawn, so an unreadable boot id fails with no child.
    let boot_id = dl::current_boot_id()?;
    // Registered before the spawn: the child is in its own process group, so
    // the terminal's Ctrl-C reaches only this process, which must stop it.
    let mut signals = dl::ShutdownSignals::register()?;

    println!("starting daemon on port {port}...");

    let mut child = launch
        .command(&bin)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .process_group(0)
        .spawn()
        .map_err(|e| CliError::Daemon(format!("failed to spawn {}: {e}", bin.display())))?;
    let pid = child.id();
    // Unreaped until this CLI exits, so the pid can't be reused meanwhile.
    let start_ticks = match dl::child_start_ticks(pid) {
        Ok(ticks) => ticks,
        Err(e) => {
            dl::stop_child(pid, dl::STOP_TIMEOUT, Some(&mut signals), || {
                child.try_wait()
            })
            .await;
            return Err(e);
        }
    };

    let failed = |reason: String| {
        let tail = dl::tail_lines(&log_path, 20);
        if !tail.is_empty() {
            eprintln!("{tail}");
        }
        CliError::DaemonStartupFailed {
            port,
            reason,
            log_path: log_path.display().to_string(),
        }
    };
    let raced = tokio::select! {
        outcome = dl::wait_until_serving(pid, port, || child.try_wait()) => Ok(outcome),
        signal = signals.recv() => Err(signal),
    };
    let error = match raced {
        Ok(Ok(StartOutcome::Serving)) => None,
        Ok(Ok(StartOutcome::Exited(status))) => return Err(failed(status.to_string())),
        Ok(Ok(StartOutcome::TimedOut)) => Some(failed(format!(
            "not serving after {}ms",
            dl::HEALTH_TIMEOUT_MS
        ))),
        Ok(Err(e)) => Some(e),
        Err(signal) => Some(CliError::Interrupted { signal }),
    };
    if let Some(error) = error {
        // don't leave an unrecorded daemon behind
        dl::stop_child(pid, dl::STOP_TIMEOUT, Some(&mut signals), || {
            child.try_wait()
        })
        .await;
        return Err(error);
    }

    // Serving — record it while the child handle is still held, so a failed
    // write stops the daemon instead of leaving it running unrecorded.
    let info = DaemonInfo::new(pid, boot_id, start_ticks, port);
    if let Err(e) = dl::write_daemon_info(&info) {
        dl::stop_child(pid, dl::STOP_TIMEOUT, Some(&mut signals), || {
            child.try_wait()
        })
        .await;
        return Err(e);
    }
    // Recorded — release the child handle (std does not kill on drop) so the
    // daemon keeps running after this CLI process exits.
    drop(child);
    println!(
        "daemon running on http://localhost:{port} (logs: {})",
        log_path.display()
    );
    Ok(info)
}

/// Percent-encode a string the way JavaScript's `encodeURIComponent` does:
/// every byte except the unreserved set `A-Za-z0-9-_.!~*'()` is escaped.
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => {
                use std::fmt::Write as _;
                // Writing to a String is infallible.
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// Open `url` in the user's browser, trying the platform openers in turn and
/// falling back to printing the URL.
async fn open_browser(url: &str) {
    for opener in ["xdg-open", "open", "start"] {
        let status = tokio::process::Command::new(opener)
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        if matches!(status, Ok(s) if s.success()) {
            return;
        }
    }
    println!("open in browser: {url}");
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

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zzz_open_{}_{tag}_{}",
            std::process::id(),
            fuz_sys::rand::random_hex_suffix()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn dir_string(path: &Path) -> String {
        format!("{}/", path.display())
    }

    #[test]
    fn resolves_relative_and_absolute_directories() {
        let root = temp_dir("dirs");
        fs::create_dir_all(root.join("a/b")).unwrap();
        let expected = OpenTarget {
            workspace: dir_string(&root.join("a/b")),
            file: None,
        };
        assert_eq!(resolve_target("a/b", &root).unwrap(), expected);
        assert_eq!(resolve_target("a/b/", &root).unwrap(), expected);
        assert_eq!(resolve_target("./a/./b/../b", &root).unwrap(), expected);
        let absolute = root.join("a/b");
        assert_eq!(
            resolve_target(absolute.to_str().unwrap(), Path::new("/elsewhere")).unwrap(),
            expected
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_symlinks_to_the_canonical_directory() {
        let root = temp_dir("links");
        fs::create_dir_all(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        assert_eq!(
            resolve_target("link", &root).unwrap().workspace,
            dir_string(&root.join("real"))
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_opens_its_parent_directory() {
        let root = temp_dir("file");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "").unwrap();
        assert_eq!(
            resolve_target("src/main.ts", &root).unwrap(),
            OpenTarget {
                workspace: dir_string(&root.join("src")),
                file: Some(root.join("src/main.ts")),
            }
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_path_is_an_error_naming_the_resolved_path() {
        let root = temp_dir("missing");
        let err = resolve_target("nope", &root).unwrap_err();
        assert!(matches!(err, CliError::BadPath { .. }), "{err}");
        let message = err.to_string();
        assert!(
            message.contains(&root.join("nope").display().to_string()),
            "{message}"
        );
        assert!(message.contains("no such file or directory"), "{message}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn root_keeps_a_single_slash() {
        assert_eq!(resolve_target("/", Path::new("/")).unwrap().workspace, "/");
    }

    #[test]
    fn build_url_encodes_the_workspace() {
        assert_eq!(build_url(4460, None), "http://localhost:4460");
        assert_eq!(
            build_url(4460, Some("/home/a b/")),
            "http://localhost:4460/workspaces?workspace=%2Fhome%2Fa%20b%2F"
        );
    }

    #[test]
    fn encode_uri_component_matches_js_semantics() {
        // Unreserved set passes through untouched.
        assert_eq!(encode_uri_component("aZ09-_.!~*'()"), "aZ09-_.!~*'()");
        // Path separators, spaces, and other bytes are percent-escaped.
        assert_eq!(encode_uri_component("/home/a b"), "%2Fhome%2Fa%20b");
        assert_eq!(encode_uri_component("~/dev/"), "~%2Fdev%2F");
    }
}
