use std::collections::HashMap;
use std::sync::Arc;

use fuz_pty::{Pty, ReadResult, WaitResult};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::handlers::App;
use crate::rpc;

// -- Notification params ------------------------------------------------------

#[derive(Serialize)]
struct TerminalDataParams<'a> {
    terminal_id: &'a str,
    data: &'a str,
}

#[derive(Serialize)]
struct TerminalExitedParams<'a> {
    terminal_id: &'a str,
    exit_code: Option<i32>,
}

// -- Per-terminal state -------------------------------------------------------

/// State for a single spawned terminal.
struct TerminalEntry {
    pty: Pty,
    /// Cancel the async read loop before killing the process.
    cancel: CancellationToken,
}

// -- PtyManager ---------------------------------------------------------------

/// Manages spawned PTY processes keyed by `terminal_id` (UUID string).
///
/// Held in `App`, shared via `Arc`. Each terminal has an async read loop
/// that broadcasts `terminal_data` notifications and sends `terminal_exited`
/// when the process exits.
pub struct PtyManager {
    terminals: RwLock<HashMap<String, TerminalEntry>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            terminals: RwLock::new(HashMap::new()),
        }
    }

    /// Spawn a new PTY process and start its async read loop.
    pub async fn spawn(
        &self,
        terminal_id: &str,
        command: &str,
        args: &[String],
        cwd: Option<&str>,
        app: Arc<App>,
    ) -> Result<(), String> {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let pty = Pty::spawn(command, &arg_refs, cwd, 80, 24)
            .map_err(|e| e.to_string())?;

        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();
        let tid = terminal_id.to_owned();

        // Capture fd and pid for the read loop — it uses raw values, not a
        // Pty struct, because the TerminalEntry owns the Pty (and its close).
        let read_fd = pty.master_fd;
        let read_pid = pty.pid;

        {
            let mut terminals = self.terminals.write().await;
            terminals.insert(
                terminal_id.to_owned(),
                TerminalEntry { pty, cancel },
            );
        }

        tokio::spawn(async move {
            read_loop(read_fd, read_pid, &tid, cancel_clone, app).await;
        });

        Ok(())
    }

    /// Write data to a terminal's stdin. Silently no-ops if terminal not found.
    pub async fn write(&self, terminal_id: &str, data: &str) {
        let terminals = self.terminals.read().await;
        if let Some(entry) = terminals.get(terminal_id) {
            let _ = entry.pty.write(data.as_bytes());
        }
    }

    /// Resize a terminal's PTY window. Silently no-ops if terminal not found.
    pub async fn resize(&self, terminal_id: &str, cols: u16, rows: u16) {
        let terminals = self.terminals.read().await;
        if let Some(entry) = terminals.get(terminal_id) {
            let _ = entry.pty.resize(cols, rows);
        }
    }

    /// Kill a terminal process and return its exit code.
    ///
    /// Returns `None` if the `terminal_id` doesn't exist.
    pub async fn kill(&self, terminal_id: &str, signal: i32) -> Option<Option<i32>> {
        let entry = {
            let mut terminals = self.terminals.write().await;
            terminals.remove(terminal_id)?
        };

        // Cancel the read loop first — it checks cancellation before each read,
        // so it will exit before we close the fd below.
        entry.cancel.cancel();

        // Send signal (process may already be dead)
        let _ = entry.pty.kill(signal);

        // Give process time to exit (matching Deno's 50ms wait)
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let exit_code = match entry.pty.waitpid() {
            WaitResult::Exited(code) => Some(code),
            WaitResult::StillRunning => None,
        };

        let _ = entry.pty.close();

        Some(exit_code)
    }

    /// Kill all terminals. Called on shutdown.
    pub async fn destroy(&self) {
        let entries: Vec<(String, TerminalEntry)> = {
            let mut terminals = self.terminals.write().await;
            terminals.drain().collect()
        };

        for (tid, entry) in entries {
            tracing::info!(terminal_id = %tid, "destroying terminal");
            entry.cancel.cancel();
            let _ = entry.pty.kill(libc::SIGTERM);
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let _ = entry.pty.waitpid();
            let _ = entry.pty.close();
        }
    }
}

impl std::fmt::Debug for PtyManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtyManager").finish_non_exhaustive()
    }
}

// -- Async read loop ----------------------------------------------------------

/// Poll the PTY master fd for output and broadcast to WebSocket clients.
///
/// Uses raw fd/pid values — does NOT own the fd. The `TerminalEntry` in the
/// map owns the `Pty` and is responsible for `close()`. On natural exit (EOF),
/// this loop removes the entry from the map and closes it. On cancellation
/// (from `kill`), the caller already removed the entry — this loop just exits.
async fn read_loop(
    master_fd: i32,
    pid: i32,
    terminal_id: &str,
    cancel: CancellationToken,
    app: Arc<App>,
) {
    let read_pty = Pty { master_fd, pid };
    let mut buf = [0u8; 8192];

    loop {
        if cancel.is_cancelled() {
            return;
        }

        match read_pty.read(&mut buf) {
            ReadResult::Data(n) => {
                let data = String::from_utf8_lossy(&buf[..n]);
                if !data.is_empty() {
                    let notification = rpc::notification(
                        "terminal_data",
                        serde_json::to_value(&TerminalDataParams {
                            terminal_id,
                            data: &data,
                        })
                        .unwrap_or(Value::Null),
                    );
                    app.broadcast(&notification);
                }
            }
            ReadResult::WouldBlock => {
                // No data — yield and retry after 10ms (matching Deno behavior)
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = tokio::time::sleep(std::time::Duration::from_millis(10)) => {},
                }
            }
            ReadResult::Eof => {
                tracing::info!(terminal_id, "terminal EOF");
                let exit_code = match read_pty.waitpid() {
                    WaitResult::Exited(code) => Some(code),
                    WaitResult::StillRunning => None,
                };

                let notification = rpc::notification(
                    "terminal_exited",
                    serde_json::to_value(&TerminalExitedParams {
                        terminal_id,
                        exit_code,
                    })
                    .unwrap_or(Value::Null),
                );
                app.broadcast(&notification);

                // Remove and close the terminal entry (natural exit cleanup).
                // If kill() already removed it, this is a no-op.
                let removed = app.pty_manager.terminals.write().await.remove(terminal_id);
                if let Some(entry) = removed {
                    let _ = entry.pty.close();
                }

                return;
            }
        }
    }
}
