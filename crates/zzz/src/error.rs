//! CLI error types.
//!
//! Typed variants grow per handler. The Deno reference at
//! `src/lib/zzz/main.ts` collapses every error to a single `console.log` +
//! `runtime.exit(1)`; the Rust port carries enough structure for
//! per-variant exit codes and hints.

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
    /// The spawned daemon never reported healthy within the timeout.
    #[error("zzz_server did not become healthy within {ms}ms (port {port})")]
    ServerNotHealthy {
        /// Port the daemon was expected to listen on.
        port: u16,
        /// Health-wait timeout in milliseconds.
        ms: u64,
    },
    /// A daemon-lifecycle operation failed (spawn, signal, serialize).
    #[error("daemon error: {0}")]
    Daemon(String),
}

impl CliError {
    /// Process exit code for this error.
    #[must_use]
    pub const fn exit_code(&self) -> i32 {
        match self {
            // Config/environment problems use 2 (matches fuz); everything
            // else is a generic 1.
            Self::HomeUnset => 2,
            Self::Io(_) | Self::ServerNotHealthy { .. } | Self::Daemon(_) => 1,
        }
    }

    /// User-facing hint shown after the error message, when one helps.
    #[must_use]
    pub const fn hint(&self) -> Option<&'static str> {
        match self {
            Self::HomeUnset => Some("set the $HOME environment variable"),
            Self::ServerNotHealthy { .. } => Some(
                "check the daemon output above; ensure DATABASE_URL and SECRET_FUZ_COOKIE_KEYS are set",
            ),
            Self::Io(_) | Self::Daemon(_) => None,
        }
    }
}
