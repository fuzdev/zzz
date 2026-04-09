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
}
