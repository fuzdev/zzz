//! Daemon-lifecycle primitives for the zzz CLI.
//!
//! The CLI is a thin client that manages the long-running `zzzd` daemon: it
//! spawns the binary, waits until the child is serving, records a
//! `daemon.json` for discovery, and reads that file back for `status` /
//! `stop`. This module owns the plumbing those handlers share; building the
//! daemon's command line and environment lives in `crate::daemon_launch`.
//!
//! **Identity.** A recorded daemon is identified by the boot id, its pid,
//! **and** its kernel start time (`boot_id` + `pid_start_ticks`, see
//! `crate::procfs`), so a pid the kernel has since reused for an unrelated
//! process — in this boot or after a reboot — reads as "gone": never as the
//! daemon, and never as something to signal. A freshly spawned daemon counts
//! as up only once the child itself holds the listening socket on the port
//! and answers `/health`, so another process already serving the port can't
//! be mistaken for it. (So `ZZZ_SERVER_BIN` must `exec` the server, not fork
//! it: the socket is checked on the spawned pid.)
//!
//! The on-disk record follows the shape of `fuz_app`'s `DaemonInfo`
//! (`{version, pid, port, started, app_version}`) plus `boot_id` and
//! `pid_start_ticks`, which is why `version` is `2`. A record in any other
//! shape (an older zzz's, or a corrupt one) is reported and left alone —
//! never signalled, removed, or overwritten, so a start refuses to run. The
//! OS-level plumbing — signals, RFC-3339 timestamps, crash-safe atomic
//! writes — routes through `fuz_sys`.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::{Duration, Instant};

use fuz_sys::Signal;
use serde::{Deserialize, Serialize};
use tokio::signal::unix::{SignalKind, signal};

use crate::CliError;
use crate::procfs;

/// Production daemon binary name. The CLI spawns and discovers this.
///
/// The single source of truth for the daemon binary name (the `[[bin]]`
/// target of the `zzz_server` crate), named `zzzd` for fuz/fuzd-style
/// symmetry; nothing else in the CLI hardcodes the name.
pub const DAEMON_BIN: &str = "zzzd";

/// Default daemon port when neither `--port`, `ZZZ_PORT`, nor config
/// supplies one. Matches `zzzd`'s own default.
pub const DEFAULT_PORT: u16 = 4460;

/// Parse a daemon port: an integer in `1..=65535` (surrounding whitespace
/// allowed). The one rule for every port source — `--port`, `ZZZ_PORT`, and
/// `zzz_config_port` — matching `zzzd`'s own; the `Err` is argh's
/// `from_str_fn` message.
pub fn parse_port(value: &str) -> Result<u16, String> {
    value
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|&port| port != 0)
        .ok_or_else(|| format!("expected a port in 1..=65535, got `{value}`"))
}

/// Schema version of `daemon.json` — `2` adds `boot_id` and
/// `pid_start_ticks` to the v1 `fuz_app` shape. A record with any other
/// version is reported and ignored.
pub const DAEMON_INFO_VERSION: u32 = 2;

/// How long a start waits for the daemon to serve.
pub const HEALTH_TIMEOUT_MS: u64 = 30_000;

/// Poll interval while waiting for health.
pub const HEALTH_POLL_INTERVAL_MS: u64 = 200;

/// Per-request timeout for a single `/health` probe.
pub const HEALTH_REQUEST_TIMEOUT_MS: u64 = 2_000;

/// How long `stop` (and a restart of an unresponsive daemon) waits for the
/// daemon to exit after `SIGTERM`; also the grace before a spawned child
/// that won't stop is `SIGKILL`ed.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// How long to wait for a `SIGKILL`ed child to be reaped.
const KILL_REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// On-disk daemon record at `~/.zzz/run/daemon.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonInfo {
    /// Schema version ([`DAEMON_INFO_VERSION`]).
    pub version: u32,
    /// Daemon process id.
    pub pid: u32,
    /// The boot the daemon started in (`/proc/sys/kernel/random/boot_id`).
    pub boot_id: String,
    /// Kernel start time of `pid` (clock ticks since boot) — with `boot_id`
    /// and `pid`, the daemon's identity.
    pub pid_start_ticks: u64,
    /// HTTP port the daemon listens on.
    pub port: u16,
    /// ISO-8601 timestamp when the daemon started.
    pub started: String,
    /// `zzz` version that started the daemon.
    pub app_version: String,
}

impl DaemonInfo {
    /// The record for a daemon that just started serving.
    #[must_use]
    pub fn new(pid: u32, boot_id: String, pid_start_ticks: u64, port: u16) -> Self {
        Self {
            version: DAEMON_INFO_VERSION,
            pid,
            boot_id,
            pid_start_ticks,
            port,
            started: fuz_sys::rfc3339_now(),
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }

    /// Whether the recorded process is still running — this boot, the same
    /// pid with the same start time, not a zombie.
    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.matches(
            procfs::boot_id().as_deref(),
            procfs::process_start_ticks(self.pid),
        )
    }

    /// The identity check behind [`Self::is_alive`], with the current boot id
    /// and the pid's start time injected. An unreadable current boot id
    /// (`None`) is unknown, not a mismatch: the check falls back to pid +
    /// start time, so a live daemon's record never reads as stale (and gets
    /// deleted) just because `/proc/sys/kernel/random/boot_id` can't be read.
    fn matches(&self, current_boot_id: Option<&str>, start_ticks: Option<u64>) -> bool {
        current_boot_id.is_none_or(|boot_id| boot_id == self.boot_id)
            && start_ticks == Some(self.pid_start_ticks)
    }

    /// Whether `other` records the same daemon process.
    fn is_same_process(&self, other: &Self) -> bool {
        self.boot_id == other.boot_id
            && self.pid == other.pid
            && self.pid_start_ticks == other.pid_start_ticks
    }
}

/// `~/.zzz` — the daemon home and CLI state directory. Errors if `$HOME` is
/// unset.
pub fn zzz_dir() -> Result<PathBuf, CliError> {
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .ok_or(CliError::HomeUnset)?;
    Ok(PathBuf::from(home).join(".zzz"))
}

/// `~/.zzz`, which must exist (`zzz init` creates it).
pub fn require_zzz_dir() -> Result<PathBuf, CliError> {
    let dir = zzz_dir()?;
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(CliError::NotInitialized)
    }
}

/// `~/.zzz/run/daemon.json`.
pub fn daemon_info_path() -> Result<PathBuf, CliError> {
    Ok(zzz_dir()?.join("run").join("daemon.json"))
}

/// Parse and validate a `daemon.json` body.
fn parse_daemon_info(content: &str) -> Result<DaemonInfo, String> {
    let info: DaemonInfo = serde_json::from_str(content).map_err(|e| e.to_string())?;
    if info.version != DAEMON_INFO_VERSION {
        return Err(format!(
            "schema version {} (expected {DAEMON_INFO_VERSION})",
            info.version
        ));
    }
    Ok(info)
}

/// What `daemon.json` holds.
#[derive(Debug)]
pub enum DaemonRecord {
    /// No file.
    Absent,
    /// A record this CLI can identify a process from.
    Current(DaemonInfo),
    /// A record it can't — an older zzz's, another version's, or corrupt.
    /// Reported, never acted on: its pid can't be verified, so it's never
    /// signalled, and the file is never removed or overwritten.
    Foreign(ForeignRecord),
}

/// A `daemon.json` this CLI can't use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignRecord {
    /// The pid it names, when it names one.
    pub pid: Option<u32>,
    /// Why it can't be used.
    pub kind: ForeignKind,
}

/// Why a `daemon.json` is a [`ForeignRecord`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForeignKind {
    /// An older schema version — an older zzz's.
    Older,
    /// A newer schema version — a newer zzz's.
    Newer,
    /// Unreadable, or not a record at all (the error).
    Unreadable(String),
}

impl ForeignKind {
    /// The machine-readable name: `older`, `newer`, or `unreadable`.
    #[must_use]
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Older => "older",
            Self::Newer => "newer",
            Self::Unreadable(_) => "unreadable",
        }
    }
}

impl ForeignRecord {
    /// What it is — "from an older zzz", "is unreadable (…)".
    #[must_use]
    pub fn what(&self) -> String {
        match &self.kind {
            ForeignKind::Older => "from an older zzz".to_owned(),
            ForeignKind::Newer => "from a newer zzz".to_owned(),
            ForeignKind::Unreadable(error) => format!("is unreadable ({error})"),
        }
    }

    /// The error refusing `action` ("start a daemon", …) because of this
    /// record.
    #[must_use]
    pub fn refuse(&self, action: &'static str) -> CliError {
        CliError::ForeignRecord {
            action,
            description: self.describe(),
        }
    }

    /// One-line description naming the pid, for warnings and errors.
    #[must_use]
    pub fn describe(&self) -> String {
        let what = self.what();
        self.pid.map_or_else(
            || format!("daemon.json {what} — remove it once no daemon is running"),
            |pid| format!("daemon.json {what} (pid {pid}) — stop it manually"),
        )
    }
}

/// Classify a `daemon.json` body.
fn classify_daemon_record(content: &str) -> DaemonRecord {
    let error = match parse_daemon_info(content) {
        Ok(info) => return DaemonRecord::Current(info),
        Err(error) => error,
    };
    let value: Option<serde_json::Value> = serde_json::from_str(content).ok();
    let field = |key: &str| {
        value
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(serde_json::Value::as_u64)
    };
    let pid = field("pid").and_then(|pid| u32::try_from(pid).ok());
    let kind = match field("version") {
        Some(version) if version < u64::from(DAEMON_INFO_VERSION) => ForeignKind::Older,
        Some(version) if version > u64::from(DAEMON_INFO_VERSION) => ForeignKind::Newer,
        _ => ForeignKind::Unreadable(error),
    };
    DaemonRecord::Foreign(ForeignRecord { pid, kind })
}

/// Read and classify `daemon.json`. An unreadable file (other than missing)
/// is a [`DaemonRecord::Foreign`].
#[must_use]
pub fn read_daemon_record() -> DaemonRecord {
    let Ok(path) = daemon_info_path() else {
        return DaemonRecord::Absent;
    };
    match fs::read_to_string(&path) {
        Ok(content) => classify_daemon_record(&content),
        Err(e) if e.kind() == io::ErrorKind::NotFound => DaemonRecord::Absent,
        Err(e) => DaemonRecord::Foreign(ForeignRecord {
            pid: None,
            kind: ForeignKind::Unreadable(e.to_string()),
        }),
    }
}

/// Atomically write `daemon.json`, creating `run/`. Crash-safe temp → fsync →
/// rename → parent fsync via [`fuz_sys::fs::write_atomic`]; mode `0o644`
/// (the record — pid / port / version — is not secret).
///
/// Never replaces a [`DaemonRecord::Foreign`] record: the start paths refuse
/// one up front ([`CliError::ForeignRecord`]); this is the backstop for one
/// that appeared since.
pub fn write_daemon_info(info: &DaemonInfo) -> Result<(), CliError> {
    let path = daemon_info_path()?;
    if let DaemonRecord::Foreign(record) = read_daemon_record() {
        return Err(record.refuse("start a daemon"));
    }
    if let Some(run_dir) = path.parent() {
        fs::create_dir_all(run_dir)?;
    }
    let mut content =
        serde_json::to_string_pretty(info).map_err(|e| CliError::Daemon(e.to_string()))?;
    content.push('\n');
    fuz_sys::fs::write_atomic(&path, content.as_bytes(), 0o644)?;
    Ok(())
}

/// Remove `daemon.json` only if it still records `info`'s process — so a
/// record written since by another daemon is left alone. Returns whether
/// the file was removed.
pub fn remove_daemon_info_if(info: &DaemonInfo) -> Result<bool, CliError> {
    let path = daemon_info_path()?;
    let current = match fs::read_to_string(&path) {
        Ok(content) => parse_daemon_info(&content).ok(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if !current.is_some_and(|current| current.is_same_process(info)) {
        return Ok(false);
    }
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Locate the `zzzd` binary to spawn, as an absolute path (the daemon runs
/// with `~/.zzz` as its working directory, so a relative path would resolve
/// against the wrong directory).
///
/// `ZZZ_SERVER_BIN` (blank reads as unset; a relative value resolves against
/// the directory `zzz` runs in, where it was written) > beside the resolved
/// CLI executable (`current_exe`, which follows symlinks — so it also covers
/// a dev build, `target/debug/zzz` beside `target/debug/zzzd`) >
/// `~/.zzz/bin/` > `$PATH`. A candidate must be an executable regular file;
/// one that isn't is skipped. Never the current directory — running `zzz`
/// inside an untrusted checkout must not execute its `target/debug/zzzd`
/// with the user's database URL and cookie key — so relative `$PATH`
/// entries (`.`, or an empty one) are skipped too.
///
/// # Errors
///
/// [`CliError::ServerBinOverrideInvalid`] when `ZZZ_SERVER_BIN` doesn't name
/// an executable file; [`CliError::ServerBinNotFound`] when no candidate
/// exists.
pub fn resolve_server_bin() -> Result<PathBuf, CliError> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    find_server_bin(
        std::env::var_os("ZZZ_SERVER_BIN"),
        exe_dir.as_deref(),
        zzz_dir().ok().as_deref(),
        std::env::var_os("PATH").as_deref(),
        is_executable_file,
    )
}

/// Whether `path` is a regular file (following symlinks) with an execute bit.
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// The search behind [`resolve_server_bin`], with its inputs injected.
/// `is_executable` is only ever asked about absolute paths.
fn find_server_bin(
    override_bin: Option<OsString>,
    exe_dir: Option<&Path>,
    zzz_dir: Option<&Path>,
    path_var: Option<&OsStr>,
    is_executable: impl Fn(&Path) -> bool,
) -> Result<PathBuf, CliError> {
    if let Some(bin) = override_bin.filter(|bin| !bin.to_string_lossy().trim().is_empty()) {
        let bin = PathBuf::from(bin);
        let bin = std::path::absolute(&bin).unwrap_or(bin);
        return if bin.is_absolute() && is_executable(&bin) {
            Ok(bin)
        } else {
            Err(CliError::ServerBinOverrideInvalid {
                path: bin.display().to_string(),
            })
        };
    }
    let path_dirs = path_var.map(std::env::split_paths).into_iter().flatten();
    exe_dir
        .map(Path::to_path_buf)
        .into_iter()
        .chain(zzz_dir.map(|dir| dir.join("bin")))
        .chain(path_dirs)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(DAEMON_BIN))
        .find(|candidate| is_executable(candidate))
        .ok_or(CliError::ServerBinNotFound)
}

/// Send `SIGTERM` to `pid` via [`fuz_sys::send_signal`].
///
/// Callers must have established `pid` is the daemon (an unreaped child, or
/// a record whose [`DaemonInfo::is_alive`] holds). A process that's already
/// gone is not an error; only a failure to *issue* the signal surfaces.
pub fn send_sigterm(pid: u32) -> Result<(), CliError> {
    let raw = i32::try_from(pid).map_err(|_| CliError::Daemon(format!("invalid pid {pid}")))?;
    fuz_sys::send_signal(raw, Signal::SIGTERM)
        .map(|_| ())
        .map_err(|e| CliError::Daemon(format!("failed to signal pid {pid}: {e}")))
}

/// Send `signal` to an unreaped child; a child that's already gone is fine.
fn signal_child(pid: u32, signal: Signal) {
    if let Ok(raw) = i32::try_from(pid) {
        let _ = fuz_sys::send_signal(raw, signal);
    }
}

/// Stop a spawned, unreaped child: `SIGTERM`, wait up to `grace` for it to
/// exit, then `SIGKILL`, and reap it. `try_wait` polls (and reaps) the child.
/// With `signals`, another shutdown signal during the grace period skips
/// straight to `SIGKILL` (a second Ctrl-C means "now"). Returns its exit
/// status, or `None` if it couldn't be reaped in time.
pub async fn stop_child(
    pid: u32,
    grace: Duration,
    mut signals: Option<&mut ShutdownSignals>,
    mut try_wait: impl FnMut() -> io::Result<Option<ExitStatus>>,
) -> Option<ExitStatus> {
    if let Ok(Some(status)) = try_wait() {
        return Some(status);
    }
    signal_child(pid, Signal::SIGTERM);
    let deadline = Instant::now() + grace;
    loop {
        match try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            eprintln!(
                "warning: pid {pid} did not exit within {}s of SIGTERM; killing it",
                grace.as_secs()
            );
            break;
        }
        let tick = tokio::time::sleep(Duration::from_millis(50));
        if let Some(signals) = signals.as_deref_mut() {
            let again = tokio::select! {
                () = tick => false,
                _ = signals.recv() => true,
            };
            if again {
                eprintln!("warning: signalled again; killing pid {pid}");
                break;
            }
        } else {
            tick.await;
        }
    }
    signal_child(pid, Signal::SIGKILL);
    let deadline = Instant::now() + KILL_REAP_TIMEOUT;
    while Instant::now() < deadline {
        match try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => tokio::time::sleep(Duration::from_millis(50)).await,
            Err(_) => return None,
        }
    }
    None
}

/// The shell's exit code for a child's status: its exit code, or 128 + the
/// signal that ended it.
#[must_use]
pub fn exit_code_of(status: ExitStatus) -> u8 {
    use std::os::unix::process::ExitStatusExt as _;
    status.code().map_or_else(
        || {
            status
                .signal()
                .and_then(|signal| u8::try_from(128 + signal).ok())
                .unwrap_or(1)
        },
        |code| u8::try_from(code).unwrap_or(1),
    )
}

/// A shutdown signal the CLI caught.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaughtSignal {
    /// `SIGINT` (Ctrl-C).
    Interrupt,
    /// `SIGTERM`.
    Terminate,
    /// `SIGHUP` (terminal closed).
    Hangup,
}

impl CaughtSignal {
    /// The signal's name, e.g. `SIGINT`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Interrupt => "SIGINT",
            Self::Terminate => "SIGTERM",
            Self::Hangup => "SIGHUP",
        }
    }

    /// The shell's exit code for a command ended by this signal:
    /// 128 + the signal number.
    #[must_use]
    pub const fn exit_code(self) -> u8 {
        128 + match self {
            Self::Hangup => 1,
            Self::Interrupt => 2,
            Self::Terminate => 15,
        }
    }
}

/// The shutdown signals a CLI waiting on a daemon handles: `SIGINT`,
/// `SIGTERM`, `SIGHUP`. Registering them replaces the default "terminate",
/// so a signal arriving while a child starts is handled, not fatal.
#[derive(Debug)]
pub struct ShutdownSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
}

impl ShutdownSignals {
    /// Register the handlers (before spawning the child they guard).
    pub fn register() -> io::Result<Self> {
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
        })
    }

    /// Wait for the next signal.
    pub async fn recv(&mut self) -> CaughtSignal {
        tokio::select! {
            _ = self.interrupt.recv() => CaughtSignal::Interrupt,
            _ = self.terminate.recv() => CaughtSignal::Terminate,
            _ = self.hangup.recv() => CaughtSignal::Hangup,
        }
    }
}

/// `SIGTERM` the recorded daemon and wait up to [`STOP_TIMEOUT`] for it to
/// exit. Returns whether it exited. Refuses to signal when the record no
/// longer identifies a live process (returns `true` — it's already gone).
pub async fn terminate(info: &DaemonInfo) -> Result<bool, CliError> {
    if !info.is_alive() {
        return Ok(true);
    }
    send_sigterm(info.pid)?;
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if !info.is_alive() {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(!info.is_alive())
}

/// A `/health` prober: one HTTP client, reused across polls.
#[derive(Debug)]
pub struct HealthProbe {
    client: Option<reqwest::Client>,
}

impl HealthProbe {
    /// Build the client. It ignores `HTTP(S)_PROXY` — the daemon is on
    /// loopback, and a proxy would answer (or fail) in its place.
    #[must_use]
    pub fn new() -> Self {
        // reqwest uses `rustls-no-provider`; install the `ring` provider first.
        fuz_sys::tls::ensure_crypto_provider();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(HEALTH_REQUEST_TIMEOUT_MS))
            .build()
            .ok();
        Self { client }
    }

    /// Probe `http://127.0.0.1:{port}/health` — the address `zzzd` binds —
    /// and require a 2xx `{"status":"ok"}` within the timeout.
    pub async fn check(&self, port: u16) -> bool {
        let Some(client) = &self.client else {
            return false;
        };
        let url = format!("http://{}:{port}/health", Ipv4Addr::LOCALHOST);
        let Ok(response) = client.get(&url).send().await else {
            return false;
        };
        if !response.status().is_success() {
            return false;
        }
        response
            .json::<serde_json::Value>()
            .await
            .is_ok_and(|body| body.get("status").and_then(serde_json::Value::as_str) == Some("ok"))
    }
}

/// Whether nothing is listening on the loopback `port` `zzzd` would bind.
#[must_use]
pub fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// Error unless `port` is free. `port_flag` says whether the command
/// accepts `--port`, for the error's hint.
pub fn require_free_port(port: u16, port_flag: bool) -> Result<(), CliError> {
    if port_is_free(port) {
        Ok(())
    } else {
        Err(CliError::PortInUse { port, port_flag })
    }
}

/// How a start attempt ended.
#[derive(Debug)]
pub enum StartOutcome {
    /// The child holds the listening socket and answers `/health`.
    Serving,
    /// The child exited first.
    Exited(ExitStatus),
    /// Neither within [`HEALTH_TIMEOUT_MS`].
    TimedOut,
}

/// Wait for the spawned child `pid` to serve on `port`: it must hold the
/// listening socket itself (so another process answering on the port
/// doesn't count) and answer `/health`. `try_wait` polls the child so an
/// early exit (bad env, unreachable DB) returns at once instead of after
/// the full timeout.
pub async fn wait_until_serving(
    pid: u32,
    port: u16,
    mut try_wait: impl FnMut() -> io::Result<Option<ExitStatus>>,
) -> Result<StartOutcome, CliError> {
    let probe = HealthProbe::new();
    let deadline = Instant::now() + Duration::from_millis(HEALTH_TIMEOUT_MS);
    while Instant::now() < deadline {
        if let Some(status) = try_wait()? {
            return Ok(StartOutcome::Exited(status));
        }
        if procfs::pid_listens_on(pid, port) && probe.check(port).await {
            return Ok(StartOutcome::Serving);
        }
        tokio::time::sleep(Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
    }
    Ok(StartOutcome::TimedOut)
}

/// This boot's id, for a daemon record. Read before spawning, so an
/// unreadable one fails the start before there's a child to clean up.
pub fn current_boot_id() -> Result<String, CliError> {
    procfs::boot_id()
        .ok_or_else(|| CliError::Daemon("can't read /proc/sys/kernel/random/boot_id".to_owned()))
}

/// The kernel start time of a just-spawned, unreaped child (which may have
/// already exited) — with the boot id and its pid, its recorded identity.
pub fn child_start_ticks(pid: u32) -> Result<u64, CliError> {
    procfs::child_start_ticks(pid)
        .ok_or_else(|| CliError::Daemon(format!("can't read the start time of pid {pid}")))
}

/// Resolved liveness of the daemon described by `daemon.json`.
///
/// Collapses the read-record → identify-process → probe-`/health` sequence
/// into one value so each command branches on a single state. The payload
/// carries the `DaemonInfo` for the cases that have one.
#[derive(Debug)]
pub enum DaemonState {
    /// No `daemon.json` — nothing is recorded as running.
    Stopped,
    /// A `daemon.json` this CLI can't identify a process from (an older or
    /// newer zzz's, or corrupt): whether a daemon runs is unknown. Never
    /// signalled, removed, or overwritten.
    Foreign(ForeignRecord),
    /// `daemon.json` records a process that is gone (its pid is dead, a
    /// zombie, or reused by another process).
    Stale(DaemonInfo),
    /// The recorded process is alive but not answering `/health` (wedged,
    /// or shutting down).
    Wedged(DaemonInfo),
    /// The recorded process is alive and answering `/health`.
    Running(DaemonInfo),
}

/// Classify the recorded daemon's liveness. Probes `/health` only when the
/// recorded process is alive, so a stale record costs no network round-trip.
pub async fn get_daemon_state() -> DaemonState {
    let info = match read_daemon_record() {
        DaemonRecord::Absent => return DaemonState::Stopped,
        DaemonRecord::Foreign(record) => return DaemonState::Foreign(record),
        DaemonRecord::Current(info) => info,
    };
    if !info.is_alive() {
        return DaemonState::Stale(info);
    }
    if HealthProbe::new().check(info.port).await {
        DaemonState::Running(info)
    } else {
        DaemonState::Wedged(info)
    }
}

/// The last `max_lines` lines of the file at `path` (empty when unreadable).
#[must_use]
pub fn tail_lines(path: &Path, max_lines: usize) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return String::new();
    };
    let lines: Vec<&str> = content.lines().collect();
    lines[lines.len().saturating_sub(max_lines)..].join("\n")
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

    fn info(pid: u32, pid_start_ticks: u64) -> DaemonInfo {
        DaemonInfo {
            version: DAEMON_INFO_VERSION,
            pid,
            boot_id: procfs::boot_id().unwrap(),
            pid_start_ticks,
            port: 4460,
            started: "2026-05-30T12:00:00Z".to_owned(),
            app_version: "0.0.1".to_owned(),
        }
    }

    #[test]
    fn daemon_info_round_trips_and_matches_wire_shape() {
        let info = info(4242, 987_654);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": 2,
                "pid": 4242,
                "boot_id": info.boot_id,
                "pid_start_ticks": 987_654,
                "port": 4460,
                "started": "2026-05-30T12:00:00Z",
                "app_version": "0.0.1",
            })
        );
        assert_eq!(parse_daemon_info(&json.to_string()).unwrap(), info);
    }

    #[test]
    fn parse_daemon_info_rejects_other_versions_and_v1_shape() {
        let v1 = r#"{"version":1,"pid":1,"port":4460,"started":"x","app_version":"y"}"#;
        assert!(parse_daemon_info(v1).is_err(), "v1 lacks pid_start_ticks");
        let v3 = r#"{"version":3,"pid":1,"boot_id":"b","pid_start_ticks":5,"port":4460,"started":"x","app_version":"y"}"#;
        let err = parse_daemon_info(v3).unwrap_err();
        assert!(err.contains("schema version 3"), "{err}");
        assert!(parse_daemon_info("not json").is_err());
    }

    #[test]
    fn foreign_records_name_their_pid_and_kind() {
        let foreign = |content: &str| match classify_daemon_record(content) {
            DaemonRecord::Foreign(record) => record,
            other => panic!("expected foreign, got {other:?}"),
        };
        let v1 = foreign(r#"{"version":1,"pid":77,"port":4460,"started":"x","app_version":"y"}"#);
        assert_eq!(v1.pid, Some(77));
        assert_eq!(
            v1.describe(),
            "daemon.json from an older zzz (pid 77) — stop it manually"
        );
        assert_eq!(v1.kind.name(), "older");
        let v3 = foreign(r#"{"version":3,"pid":78}"#);
        assert_eq!(v3.what(), "from a newer zzz");
        assert_eq!(v3.kind.name(), "newer");
        let corrupt = foreign("{nope");
        assert_eq!(corrupt.pid, None);
        assert_eq!(corrupt.kind.name(), "unreadable");
        assert!(
            corrupt.what().starts_with("is unreadable"),
            "{}",
            corrupt.what()
        );

        let current = serde_json::to_string(&info(1, 2)).unwrap();
        assert!(matches!(
            classify_daemon_record(&current),
            DaemonRecord::Current(_)
        ));
    }

    #[test]
    fn identity_is_boot_pid_and_start_time() {
        let me = std::process::id();
        let ticks = procfs::process_start_ticks(me).unwrap();
        assert!(info(me, ticks).is_alive());
        // same pid, different start time: a reused pid is not the daemon
        assert!(!info(me, ticks + 1).is_alive());
        assert!(!info(4_000_000_000, ticks).is_alive());
        // a record from another boot is not the daemon
        let other_boot = DaemonInfo {
            boot_id: "00000000-0000-0000-0000-000000000000".to_owned(),
            ..info(me, ticks)
        };
        assert!(!other_boot.is_alive());
        assert!(!other_boot.is_same_process(&info(me, ticks)));

        assert!(info(me, ticks).is_same_process(&info(me, ticks)));
        assert!(!info(me, ticks).is_same_process(&info(me, ticks + 1)));
        assert!(!info(me, ticks).is_same_process(&info(me + 1, ticks)));
    }

    #[test]
    fn an_unreadable_boot_id_falls_back_to_pid_and_start_time() {
        let record = info(42, 7);
        let boot = record.boot_id.clone();
        assert!(record.matches(Some(&boot), Some(7)));
        assert!(!record.matches(Some("another-boot"), Some(7)));
        // unknown boot: pid + start time still decide, so a live record isn't stale
        assert!(record.matches(None, Some(7)));
        assert!(!record.matches(None, Some(8)));
        assert!(!record.matches(None, None));
    }

    #[test]
    fn parse_port_accepts_only_1_to_65535() {
        assert_eq!(parse_port("4460"), Ok(4460));
        assert_eq!(parse_port(" 65535 "), Ok(65535));
        assert_eq!(parse_port("1"), Ok(1));
        for bad in ["0", "65536", "-1", "", "http", "44.6"] {
            let err = parse_port(bad).unwrap_err();
            assert!(
                err.contains("expected a port in 1..=65535"),
                "{bad:?}: {err}"
            );
        }
    }

    #[test]
    fn server_bin_search_order_never_uses_the_current_directory() {
        use std::cell::RefCell;

        let exe = Path::new("/opt/zzz/bin");
        let home = Path::new("/home/u/.zzz");
        // relative entries (`.`, empty, `target/debug`) would resolve against
        // the current directory: never even asked about
        let path_var = OsString::from(".::target/debug:/usr/local/bin:/usr/bin");
        let asked: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
        let find = |present: &[&str]| {
            asked.borrow_mut().clear();
            find_server_bin(None, Some(exe), Some(home), Some(&path_var), |path| {
                assert!(path.is_absolute(), "asked about {}", path.display());
                asked.borrow_mut().push(path.to_path_buf());
                present.iter().any(|p| path == Path::new(p))
            })
        };

        let all = [
            "/opt/zzz/bin/zzzd",
            "/home/u/.zzz/bin/zzzd",
            "/usr/local/bin/zzzd",
            "/usr/bin/zzzd",
        ];
        assert_eq!(find(&all).unwrap(), Path::new("/opt/zzz/bin/zzzd"));
        assert_eq!(find(&all[1..]).unwrap(), Path::new("/home/u/.zzz/bin/zzzd"));
        assert_eq!(find(&all[2..]).unwrap(), Path::new("/usr/local/bin/zzzd"));
        // a candidate that isn't executable is skipped, not the end of the search
        assert_eq!(find(&all[3..]).unwrap(), Path::new("/usr/bin/zzzd"));
        assert!(matches!(find(&[]), Err(CliError::ServerBinNotFound)));
        assert_eq!(*asked.borrow(), all.map(PathBuf::from));
    }

    #[test]
    fn server_bin_override_wins_but_must_be_executable() {
        let exe = Path::new("/opt/zzz/bin");
        let with_override = |value: &str, executable: bool| {
            find_server_bin(Some(OsString::from(value)), Some(exe), None, None, |path| {
                executable || path == Path::new("/opt/zzz/bin/zzzd")
            })
        };
        assert_eq!(
            with_override("/x/zzzd", true).unwrap(),
            Path::new("/x/zzzd")
        );
        // relative: against the current directory, made absolute
        let relative = with_override("rel/zzzd", true).unwrap();
        assert_eq!(relative, std::env::current_dir().unwrap().join("rel/zzzd"));
        // missing or not executable: an error naming it, no fallback
        match with_override("/x/zzzd", false) {
            Err(CliError::ServerBinOverrideInvalid { path }) => assert_eq!(path, "/x/zzzd"),
            other => panic!("expected ServerBinOverrideInvalid, got {other:?}"),
        }
        // blank reads as unset
        assert_eq!(
            with_override(" ", false).unwrap(),
            Path::new("/opt/zzz/bin/zzzd")
        );
    }

    #[test]
    fn is_executable_file_needs_a_regular_file_with_an_exec_bit() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("zzz_exec_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("zzzd");
        fs::write(&file, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable_file(&file));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable_file(&file));
        assert!(!is_executable_file(&dir), "a directory");
        assert!(!is_executable_file(&dir.join("missing")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exit_code_of_maps_codes_and_signals() {
        use std::os::unix::process::ExitStatusExt as _;
        assert_eq!(exit_code_of(ExitStatus::from_raw(0)), 0);
        assert_eq!(exit_code_of(ExitStatus::from_raw(7 << 8)), 7);
        // killed by SIGTERM (15), SIGKILL (9)
        assert_eq!(exit_code_of(ExitStatus::from_raw(15)), 143);
        assert_eq!(exit_code_of(ExitStatus::from_raw(9)), 137);
    }

    #[test]
    fn caught_signal_exit_codes_are_128_plus_the_number() {
        assert_eq!(CaughtSignal::Hangup.exit_code(), 129);
        assert_eq!(CaughtSignal::Interrupt.exit_code(), 130);
        assert_eq!(CaughtSignal::Terminate.exit_code(), 143);
    }

    #[test]
    fn port_is_free_detects_a_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        drop(listener);
        assert!(port_is_free(port));
    }

    #[test]
    fn tail_lines_keeps_the_end() {
        let dir = std::env::temp_dir().join(format!("zzz_tail_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log");
        fs::write(&path, "a\nb\nc\nd\n").unwrap();
        assert_eq!(tail_lines(&path, 2), "c\nd");
        assert_eq!(tail_lines(&path, 10), "a\nb\nc\nd");
        assert_eq!(tail_lines(&dir.join("missing"), 2), "");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Serve one HTTP response on an ephemeral loopback port.
    async fn one_shot_server(body: &'static str) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0_u8; 1024];
                let _ = sock.read(&mut buf).await;
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(body.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        (port, server)
    }

    #[tokio::test]
    async fn health_probe_requires_the_zzz_health_body() {
        let (port, server) = one_shot_server("{\"status\":\"ok\"}").await;
        assert!(
            HealthProbe::new().check(port).await,
            "expected healthy for status ok"
        );
        let _ = server.await;

        let (port, server) = one_shot_server("<html>hello</html>").await;
        assert!(
            !HealthProbe::new().check(port).await,
            "a non-zzz 200 is not healthy"
        );
        let _ = server.await;

        // Bind then drop to obtain a port with nothing listening.
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let closed_port = probe.local_addr().unwrap().port();
        drop(probe);
        assert!(!HealthProbe::new().check(closed_port).await, "closed port");
    }

    #[tokio::test]
    async fn wait_until_serving_rejects_a_foreign_listener_and_reports_exit() {
        // Something else answers /health on the port, but the "child" (a
        // process that doesn't hold the socket) exits: the wait reports the
        // exit rather than mistaking the foreign listener for the daemon.
        let (port, server) = one_shot_server("{\"status\":\"ok\"}").await;
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 0.3; exit 7"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let outcome = wait_until_serving(pid, port, || child.try_wait())
            .await
            .unwrap();
        match outcome {
            StartOutcome::Exited(status) => assert_eq!(status.code(), Some(7)),
            other => panic!("expected Exited, got {other:?}"),
        }
        server.abort();
    }

    #[tokio::test]
    async fn stop_child_terminates_then_kills() {
        // exits on SIGTERM
        let mut child = std::process::Command::new("sleep")
            .arg("100")
            .spawn()
            .unwrap();
        let pid = child.id();
        let status = stop_child(pid, Duration::from_secs(5), None, || child.try_wait()).await;
        assert!(status.is_some_and(|s| !s.success()), "{status:?}");

        // ignores SIGTERM: killed after the grace
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap '' TERM; while :; do sleep 0.05; done"])
            .spawn()
            .unwrap();
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(100)); // let the trap install
        let started = Instant::now();
        let status = stop_child(pid, Duration::from_millis(300), None, || child.try_wait()).await;
        assert!(status.is_some(), "reaped");
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
