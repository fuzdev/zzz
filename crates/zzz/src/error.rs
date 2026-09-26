//! CLI error types.
//!
//! Typed variants grow per handler, carrying enough structure for
//! per-variant exit codes and user-facing hints.

use thiserror::Error;

/// Errors that can occur during CLI operations.
#[derive(Debug, Error)]
pub enum CliError {
    /// I/O operation failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// `$HOME` is unset, so the `~/.zzz` state directory can't be resolved.
    #[error("$HOME is not set")]
    HomeUnset,
    /// `~/.zzz` does not exist yet — the user hasn't run `zzz init`.
    #[error("zzz is not initialized")]
    NotInitialized,
    /// Required daemon env vars are missing from both the process env and
    /// `~/.zzz/.env`.
    #[error(
        "missing required daemon environment: {vars} (not set in the environment or {env_path})"
    )]
    MissingEnv {
        /// Comma-separated names of the missing variables.
        vars: String,
        /// Path to the daemon env file.
        env_path: String,
    },
    /// A daemon config value is malformed (e.g. a non-numeric `ZZZ_PORT`).
    #[error("invalid config: {0}")]
    InvalidConfig(String),
    /// Neither `ZZZ_STATIC_DIR` nor `~/.zzz/static` names a UI build.
    #[error("no UI build found: {default_dir} does not exist and ZZZ_STATIC_DIR is not set")]
    NoStaticDir {
        /// The default static dir, `~/.zzz/static`.
        default_dir: String,
    },
    /// `ZZZ_STATIC_DIR` is set but is not a directory.
    #[error("ZZZ_STATIC_DIR is not a directory: {path}")]
    StaticDirNotFound {
        /// The resolved `ZZZ_STATIC_DIR` path.
        path: String,
    },
    /// The path given to `zzz open` can't be opened (missing, unreadable,
    /// or not UTF-8).
    #[error("can't open {path}: {reason}")]
    BadPath {
        /// The path as resolved (after `~` expansion and cwd join).
        path: String,
        /// Why — e.g. "no such file or directory".
        reason: String,
    },
    /// The daemon port is already taken by another listener.
    #[error("port {port} is already in use by another process{note}")]
    PortInUse {
        /// The port the daemon would bind.
        port: u16,
        /// Empty, or `; <foreign daemon.json description>` naming the pid of
        /// an older zzz's daemon, the likely holder.
        note: String,
    },
    /// A signal arrived while the daemon was starting; the child was stopped.
    #[error("interrupted by {} while zzzd was starting; stopped it", signal.name())]
    Interrupted {
        /// The signal.
        signal: crate::daemon_lifecycle::CaughtSignal,
    },
    /// `daemon start` found a zzz daemon already running.
    #[error("a zzz daemon is already running (pid {pid}, port {port})")]
    AlreadyRunning {
        /// The running daemon's pid.
        pid: u32,
        /// The running daemon's port.
        port: u16,
    },
    /// The spawned daemon never reported healthy within the timeout.
    #[error("zzzd did not become healthy within {ms}ms (port {port})")]
    ServerNotHealthy {
        /// Port the daemon was expected to listen on.
        port: u16,
        /// Health-wait timeout in milliseconds.
        ms: u64,
    },
    /// The foreground daemon exited before it became healthy. Its stderr is
    /// inherited, so the cause is printed above the error.
    #[error("zzzd exited before becoming healthy ({status})")]
    DaemonExited {
        /// The child's exit status, rendered.
        status: String,
    },
    /// An auto-started (detached) daemon exited or never came up. Its stdio
    /// is captured to a log file (named in the message) rather than the
    /// terminal, so the failure is diagnosable after the CLI exits.
    #[error("daemon failed to start on port {port} ({reason}); see {log_path}")]
    DaemonStartupFailed {
        /// Port the daemon was expected to listen on.
        port: u16,
        /// Why the start failed — the exit status, or a timeout.
        reason: String,
        /// Path to the captured daemon log.
        log_path: String,
    },
    /// A daemon-lifecycle operation failed (spawn, signal, serialize).
    #[error("daemon error: {0}")]
    Daemon(String),
}

impl CliError {
    /// Process exit code for this error (for `ExitCode::from`).
    #[must_use]
    pub const fn exit_code(&self) -> u8 {
        match self {
            // Config/environment problems use 2 (matches fuz); everything
            // else is a generic 1.
            Self::HomeUnset
            | Self::NotInitialized
            | Self::MissingEnv { .. }
            | Self::InvalidConfig(_)
            | Self::NoStaticDir { .. }
            | Self::StaticDirNotFound { .. } => 2,
            // the shell convention: 128 + the signal number
            Self::Interrupted { signal } => signal.exit_code(),
            Self::Io(_)
            | Self::BadPath { .. }
            | Self::PortInUse { .. }
            | Self::AlreadyRunning { .. }
            | Self::ServerNotHealthy { .. }
            | Self::DaemonExited { .. }
            | Self::DaemonStartupFailed { .. }
            | Self::Daemon(_) => 1,
        }
    }

    /// User-facing hint shown after the error message, when one helps.
    #[must_use]
    pub const fn hint(&self) -> Option<&'static str> {
        match self {
            Self::HomeUnset => Some("set the $HOME environment variable"),
            Self::NotInitialized => Some("run `zzz init` first"),
            Self::MissingEnv { .. } => {
                Some("set them in ~/.zzz/.env (`zzz init` writes a template if it's missing)")
            }
            Self::NoStaticDir { .. } => Some(
                "build the frontend (`gro build`) and copy `build/` to ~/.zzz/static, or set ZZZ_STATIC_DIR in ~/.zzz/.env",
            ),
            Self::StaticDirNotFound { .. } => Some(
                "point ZZZ_STATIC_DIR at a built UI (`gro build` output), or unset it to use ~/.zzz/static",
            ),
            Self::PortInUse { .. } => Some(
                "stop the other process, or pick another port (`--port`, ZZZ_PORT in ~/.zzz/.env, or `zzz_config_port` in ~/.zzz/config.json)",
            ),
            Self::AlreadyRunning { .. } => Some("stop it first with `zzz daemon stop`"),
            Self::ServerNotHealthy { .. } | Self::DaemonExited { .. } => {
                Some("check the daemon output above and the settings in ~/.zzz/.env")
            }
            Self::DaemonStartupFailed { .. } => {
                Some("the log names the cause (e.g. an unreachable DATABASE_URL in ~/.zzz/.env)")
            }
            Self::Io(_)
            | Self::Interrupted { .. }
            | Self::InvalidConfig(_)
            | Self::BadPath { .. }
            | Self::Daemon(_) => None,
        }
    }
}
