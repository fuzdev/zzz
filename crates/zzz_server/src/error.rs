use std::net::SocketAddr;

/// Server-level errors for startup and runtime.
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("failed to bind to {addr}")]
    Bind {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
    #[error("server error")]
    Serve(#[source] std::io::Error),
    #[error("database error: {0}")]
    Database(String),
    #[error("configuration error: {0}")]
    Config(String),
    /// `-h` / `--help` was passed: not a failure — the binary prints its
    /// usage and exits 0 ([`crate::report_run_result`]).
    #[error("help requested")]
    HelpRequested,
}
