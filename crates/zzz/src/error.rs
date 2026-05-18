//! CLI error types.
//!
//! Skeleton — variants are added as handlers gain real bodies. The Deno
//! reference at `src/lib/zzz/main.ts:132-136` collapses every error to a
//! single `console.log` + `runtime.exit(1)`; the Rust port will grow
//! typed variants per handler (matching `private_fuz/crates/fuz/src/error.rs`).

use thiserror::Error;

/// Errors that can occur during CLI operations.
#[derive(Debug, Error)]
pub enum CliError {
    /// I/O operation failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    // TODO: add typed variants per command as handlers are implemented
    // (DaemonStartFailed, ConfigDirMissing, OpenBrowserFailed, …).
}

impl CliError {
    /// Process exit code for this error.
    #[allow(clippy::unused_self)] // TODO: per-variant codes once variants exist
    pub const fn exit_code(&self) -> i32 {
        // TODO: per-variant exit codes (matches fuz: 2 for config errors,
        // 1 for everything else).
        1
    }

    /// User-facing hint shown after the error message.
    ///
    /// Returns `Option<&'static str>` for now. If hints ever need to
    /// interpolate runtime values (PIDs, paths, etc.), switch the return
    /// type to fuz's `HintMessage` enum
    /// (`private_fuz/crates/fuz/src/error.rs:182-195`) which carries
    /// `Static(&'static str) | Owned(String)` and implements `Display` —
    /// keeps the no-alloc fast path while permitting interpolation
    /// where it's actually needed.
    #[allow(clippy::unused_self)] // TODO: per-variant hints once variants exist
    pub const fn hint(&self) -> Option<&'static str> {
        // TODO: per-variant hints (matches fuz's `hint()` shape — static
        // strings preferred, owned only when interpolation is needed).
        None
    }
}
