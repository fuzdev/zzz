//! PTY terminal manager — spawns `fuz_pty` processes and drives their I/O.
//!
//! Each terminal gets one tokio task that exclusively owns its PTY master
//! fd (registered with the reactor via `AsyncFd`) and child pid:
//!
//! - **Output** — readiness-driven reads (no polling), decoded with
//!   `Utf8StreamDecoder` so a multibyte character split across reads survives,
//!   and sent as `terminal_data`. The task spends cooperative budget per
//!   chunk, so a flood (`yes`, `cat /dev/urandom`) can't pin a runtime worker.
//!   Reads are paced against what the terminal's clients acknowledge
//!   (`terminal_ack`, see `OutputWindow`): while too much sent output is
//!   unacknowledged the task stops reading the master, the kernel's PTY
//!   buffer fills, and the child blocks in its write.
//! - **Input** — `terminal_data_send` enqueues onto a per-terminal queue
//!   bounded in chunks and bytes (`INPUT_QUEUE_CAPACITY`,
//!   `INPUT_QUEUE_MAX_BYTES`); the task writes each chunk fully (looping on partial writes and
//!   waiting for writability) before the next, so input is never silently
//!   truncated and chunks never interleave. Chunks are written in the order
//!   sends reach the handler — sends on one socket are dispatched
//!   concurrently, so ordering across sends is the client's job.
//! - **Resize** — latest-wins through a `watch` channel.
//! - **Exit** — on EOF the task closes the master, reaps the child (escalating
//!   to `SIGKILL` if it lingers), and sends `terminal_exited` with the
//!   real exit code. On `terminal_close` it signals, closes the master (the
//!   hangup reaches shells that ignore `SIGTERM`), replies with the exit code
//!   if the child exited within a short grace, and keeps reaping in the
//!   background — no zombie outlives its terminal.
//!
//! Children get zzzd's environment minus its secrets and config (see
//! `terminal_env`).
//!
//! **Ownership.** Each terminal belongs to the account that created it: its
//! `terminal_data` / `terminal_exited` notifications reach only that account's
//! sockets, and `write` / `resize` / `close` from any other account act as if
//! the terminal didn't exist — the same `TerminalNotFound` / no-op reply as an
//! unknown id — so its existence isn't observable either.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::hash::Hash;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use fuz_pty::{Pty, PtyError, ReadResult, WaitResult};
use fuz_realtime::{ConnectionId, ConnectionRegistry};
use serde::Serialize;
use tokio::io::unix::AsyncFd;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::{Notify, RwLock, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use uuid::Uuid;

use crate::handlers::App;
use crate::utf8_stream::Utf8StreamDecoder;

// -- Tuning -------------------------------------------------------------------

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

const READ_BUFFER_SIZE: usize = 8192;

/// Max `terminal_data_send` chunks queued per terminal before input is
/// refused with `queue_overflow` (the child isn't reading its input) —
/// bounds the per-chunk overhead of many small sends.
const INPUT_QUEUE_CAPACITY: usize = 256;

/// Max bytes of input held per terminal — queued, or being written — before
/// input is refused with `queue_overflow`. A single chunk larger than this is
/// accepted when nothing is held, so any send the message cap admits is still
/// written in full; a terminal holds at most one such chunk.
const INPUT_QUEUE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// Unacknowledged output above which a paced terminal stops reading its PTY
/// (see `OutputWindow`). Bounds what one terminal keeps queued for a client
/// that acknowledges: this much, plus one read.
const OUTPUT_WINDOW_HIGH_BYTES: u64 = 1024 * 1024;

/// Unacknowledged output at or below which a paused terminal reads again.
/// Below the high mark so a terminal doesn't flip between the two on every
/// ack.
const OUTPUT_WINDOW_LOW_BYTES: u64 = 256 * 1024;

/// How often a paused terminal re-checks that the connections it is pacing
/// against are still open — a closed one stops counting within this long.
///
/// Nothing tells a paused terminal that a connection closed, so this is how
/// long closing the tab a terminal was keeping pace with leaves it blocked
/// for everyone else watching it — hence the bound below.
const PAUSED_RECHECK_INTERVAL: Duration = Duration::from_millis(250);

// A closed consumer must release its terminals sooner than anyone watching
// one would take it for hung.
const _: () = assert!(PAUSED_RECHECK_INTERVAL.as_millis() <= 1000);

/// How long `terminal_close` waits for the requested signal to end the child
/// before closing the master.
const CLOSE_SIGNAL_GRACE: Duration = Duration::from_millis(50);

/// How long `terminal_close` waits after closing the master (which hangs up
/// the session) before replying with an unknown exit code.
const CLOSE_HANGUP_GRACE: Duration = Duration::from_millis(100);

/// How long a closed or hung-up child may linger before `SIGKILL`.
const REAP_KILL_AFTER: Duration = Duration::from_secs(3);

/// How long to keep polling after `SIGKILL` before giving up on the child
/// (it's stuck in uninterruptible sleep — logged, left unreaped).
const REAP_GIVE_UP_AFTER: Duration = Duration::from_secs(2);

const REAP_POLL_MIN: Duration = Duration::from_millis(5);
const REAP_POLL_MAX: Duration = Duration::from_millis(200);

/// Upper bound on `kill_all` — shutdown and `_testing_reset` never hang on a
/// stuck child.
const KILL_ALL_TIMEOUT: Duration = Duration::from_secs(5);

// -- Environment --------------------------------------------------------------

/// Env var name prefixes stripped from a terminal's environment — zzzd's
/// secrets and its own server / frontend / spine config.
const SCRUBBED_ENV_PREFIXES: &[&str] = &["SECRET_", "FUZ_", "ZZZ_", "PUBLIC_ZZZ_"];

/// Exact env var names stripped from a terminal's environment.
const SCRUBBED_ENV_NAMES: &[&str] = &["DATABASE_URL", "PORT"];

/// Whether `name` is withheld from terminal children (see `terminal_env`).
pub fn is_scrubbed_env_name(name: &OsStr) -> bool {
    let name = name.as_bytes();
    SCRUBBED_ENV_NAMES.iter().any(|n| name == n.as_bytes())
        || SCRUBBED_ENV_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix.as_bytes()))
}

/// Build a terminal child's environment from zzzd's (`vars`), dropping
/// secrets and zzzd config: `SECRET_*`, `FUZ_*`, `ZZZ_*`, `PUBLIC_ZZZ_*`,
/// `DATABASE_URL`, and `PORT`.
///
/// Everything else passes through — a terminal is the user's shell, so
/// `PATH`, `HOME`, `SSH_AUTH_SOCK`, `WAYLAND_DISPLAY`, `XDG_*`, etc. must
/// survive. (`fuz_pty` forces `TERM=xterm-256color` on top.)
pub fn terminal_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(name, _)| !is_scrubbed_env_name(name))
        .collect()
}

// -- Notification params ------------------------------------------------------

#[derive(Serialize)]
struct TerminalDataParams<'a> {
    terminal_id: &'a str,
    data: &'a str,
    /// Bytes of `data` (UTF-8) the terminal has sent in total, this chunk
    /// included — the count a `terminal_ack` echoes back.
    sent_bytes: u64,
}

#[derive(Serialize)]
struct TerminalExitedParams<'a> {
    terminal_id: &'a str,
    exit_code: Option<i32>,
}

/// Send `terminal_data` to the owning account's sockets, counting it in the
/// terminal's output window. Returns whether the window now says to stop
/// reading the PTY.
fn send_data(app: &App, owner: Uuid, terminal_id: &str, output: &OutputFlow, data: &str) -> bool {
    if data.is_empty() {
        return false;
    }
    let sent_bytes = output.window.lock().record_sent(data.len());
    let notification = fuz_http::notification(
        "terminal_data",
        &TerminalDataParams {
            terminal_id,
            data,
            sent_bytes,
        },
    );
    app.realtime.send_to_account(owner, &notification);
    output.refresh_paused(&app.realtime)
}

// -- Output pacing ------------------------------------------------------------

/// A terminal's output flow-control window: how much it has sent, and how
/// much of that each acknowledging consumer has taken.
///
/// **Unit.** Bytes of the `terminal_data` payloads (`data`, as UTF-8), summed
/// over the terminal's life. Every `terminal_data` carries the running total
/// as `sent_bytes`, and a `terminal_ack` echoes back the `sent_bytes` of the
/// last chunk the client finished with — so both sides use the server's
/// count, and neither depends on how the other measures a string.
///
/// **Rule.** The terminal is paused — its task stops reading the PTY, so the
/// kernel blocks the child — once the unacknowledged bytes pass `high`, and
/// reads again once they are back to `low` or under.
///
/// - *Unacknowledged* is `sent` minus the **highest** ack among the
///   consumers: the terminal keeps pace with its fastest consumer, so one
///   that falls behind (a hidden tab) can't stall the others. That slower one
///   is still bounded by its socket's outbound queue.
/// - A *consumer* is a connection that has acknowledged this terminal at
///   least once and is still open. A connection that never acknowledges (a
///   raw API client) isn't one, so with no consumers — nobody connected, or
///   only such clients — the terminal is never paused.
/// - Nothing times a consumer out. The only one, or the fastest, that stays
///   open and stops acknowledging keeps the terminal paused until its
///   connection closes; a slower one that stops changes nothing.
/// - Acks are cumulative: a consumer's value only moves up, a repeated or
///   reordered ack changes nothing, and an ack past `sent` counts as `sent`.
///
/// A terminal's id names one process, so a restarted terminal is a new
/// window: an ack for the old id finds no terminal.
///
/// `C` is the consumer's identity — the connection id.
#[derive(Debug)]
struct OutputWindow<C> {
    sent: u64,
    /// Highest ack seen per consumer.
    consumers: HashMap<C, u64>,
    paused: bool,
    high: u64,
    low: u64,
}

impl<C: Copy + Eq + Hash> OutputWindow<C> {
    fn new(high: u64, low: u64) -> Self {
        debug_assert!(low <= high);
        Self {
            sent: 0,
            consumers: HashMap::new(),
            paused: false,
            high,
            low,
        }
    }

    /// Count `len` more bytes as sent, returning the new total.
    fn record_sent(&mut self, len: usize) -> u64 {
        self.sent = self.sent.saturating_add(len as u64);
        self.update();
        self.sent
    }

    /// Record that `consumer` has taken the output up to `bytes`, making it
    /// a consumer if it wasn't one.
    fn ack(&mut self, consumer: C, bytes: u64) {
        let bytes = bytes.min(self.sent);
        let acked = self.consumers.entry(consumer).or_insert(0);
        *acked = (*acked).max(bytes);
        self.update();
    }

    fn has_consumer(&self, consumer: C) -> bool {
        self.consumers.contains_key(&consumer)
    }

    /// Drop the consumers `is_open` says are gone.
    fn retain_consumers(&mut self, mut is_open: impl FnMut(C) -> bool) {
        self.consumers.retain(|consumer, _| is_open(*consumer));
        self.update();
    }

    /// Sent bytes no consumer has acknowledged, or `None` with no consumers.
    fn unacked(&self) -> Option<u64> {
        let acked = self.consumers.values().copied().max()?;
        Some(self.sent - acked)
    }

    const fn is_paused(&self) -> bool {
        self.paused
    }

    fn update(&mut self) {
        self.paused = match self.unacked() {
            None => false,
            Some(unacked) if self.paused => unacked > self.low,
            Some(unacked) => unacked > self.high,
        };
    }
}

/// A terminal's [`OutputWindow`], shared by the manager (which records acks)
/// and the terminal's task (which counts what it sends and pauses on it).
#[derive(Debug)]
struct OutputFlow {
    window: parking_lot::Mutex<OutputWindow<ConnectionId>>,
    /// Wakes the terminal's task after an ack.
    acked: Notify,
}

impl OutputFlow {
    fn new() -> Self {
        Self {
            window: parking_lot::Mutex::new(OutputWindow::new(
                OUTPUT_WINDOW_HIGH_BYTES,
                OUTPUT_WINDOW_LOW_BYTES,
            )),
            acked: Notify::new(),
        }
    }

    /// Record an ack from `connection` and wake the terminal's task. A
    /// connection's first ack also drops the consumers whose connections
    /// have closed, so the set never outgrows the open connections by more
    /// than those closed since; one from a connection that's already closed
    /// is ignored.
    fn ack(&self, registry: &ConnectionRegistry, connection: ConnectionId, bytes: u64) {
        {
            let mut window = self.window.lock();
            if !window.has_consumer(connection) {
                if !registry.is_registered(connection) {
                    return;
                }
                window.retain_consumers(|consumer| registry.is_registered(consumer));
            }
            window.ack(connection, bytes);
        }
        self.acked.notify_one();
    }

    /// Whether the terminal should stop reading its PTY, after dropping the
    /// consumers whose connections have closed. Only a paused window looks
    /// the connections up, so sending a chunk doesn't touch the registry
    /// unless it's about to wait on one.
    fn refresh_paused(&self, registry: &ConnectionRegistry) -> bool {
        let mut window = self.window.lock();
        if window.is_paused() {
            window.retain_consumers(|consumer| registry.is_registered(consumer));
        }
        window.is_paused()
    }
}

// -- Per-terminal state -------------------------------------------------------

/// No terminal with the id is owned by the caller — it never existed, it
/// ended, the daemon restarted since it was created, or another account owns
/// it (indistinguishable by design).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("terminal not found")]
pub struct TerminalNotFound;

/// Why `PtyManager::write` refused input.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TerminalWriteError {
    #[error(transparent)]
    NotFound(#[from] TerminalNotFound),
    /// The terminal's input queue is full because the child isn't consuming
    /// what it's sent.
    #[error("terminal input queue is full")]
    InputFull,
}

/// A terminal's input byte budget ([`INPUT_QUEUE_MAX_BYTES`]), shared by the
/// manager (which reserves on send) and the terminal's task (whose chunks
/// release on drop — written, failed, or discarded with the task).
#[derive(Debug)]
struct InputBudget {
    held: AtomicUsize,
    max: usize,
}

impl InputBudget {
    const fn new(max: usize) -> Self {
        Self {
            held: AtomicUsize::new(0),
            max,
        }
    }

    /// Reserve `len` bytes, or `None` if they'd take the terminal past its
    /// budget. A chunk over the whole budget is admitted only when nothing is
    /// held, so it can't stall forever behind the cap.
    fn try_reserve(self: &Arc<Self>, len: usize) -> Option<InputReservation> {
        self.held
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |held| {
                let total = held.checked_add(len)?;
                (held == 0 || total <= self.max).then_some(total)
            })
            .ok()?;
        Some(InputReservation {
            budget: Arc::clone(self),
            len,
        })
    }
}

/// Bytes reserved from an [`InputBudget`], released when dropped.
#[derive(Debug)]
struct InputReservation {
    budget: Arc<InputBudget>,
    len: usize,
}

impl Drop for InputReservation {
    fn drop(&mut self) {
        self.budget.held.fetch_sub(self.len, Ordering::AcqRel);
    }
}

/// An input chunk on a terminal's queue, holding its bytes' reservation until
/// it's dropped.
#[derive(Debug)]
struct QueuedInput {
    data: Vec<u8>,
    _reservation: InputReservation,
}

/// A request for a terminal's task to shut the child down.
struct CloseRequest {
    signal: i32,
    /// Receives the exit code (`None` if the child hadn't exited within the
    /// close grace).
    reply: Option<oneshot::Sender<Option<i32>>>,
    /// How long a lingering child gets after the hangup before `SIGKILL`.
    kill_after: Duration,
}

/// Handles to a running terminal's task, held in the manager's map.
struct TerminalEntry {
    /// The account that created the terminal — the only one that sees its
    /// output or can drive it.
    owner: Uuid,
    input: mpsc::Sender<QueuedInput>,
    input_budget: Arc<InputBudget>,
    size: watch::Sender<(u16, u16)>,
    output: Arc<OutputFlow>,
    close: oneshot::Sender<CloseRequest>,
    task: JoinHandle<()>,
}

/// Owns a spawned `Pty`: the master fd (registered with the reactor through
/// `AsRawFd`) plus the child pid.
///
/// The master is closed exactly once — explicitly via `close_master`, or on
/// drop — while the pid stays usable for signalling and reaping afterwards.
#[derive(Debug)]
struct PtyHandle {
    pty: Pty,
    master_open: bool,
}

impl PtyHandle {
    const fn new(pty: Pty) -> Self {
        Self {
            pty,
            master_open: true,
        }
    }

    /// Close the master fd. The kernel hangs up the terminal session once no
    /// process holds the master (the fd is close-on-exec, so children never
    /// do).
    fn close_master(&mut self) {
        if self.master_open {
            self.master_open = false;
            let _ = self.pty.close();
        }
    }
}

impl AsRawFd for PtyHandle {
    fn as_raw_fd(&self) -> RawFd {
        self.pty.master_fd
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        self.close_master();
    }
}

// -- PtyManager ---------------------------------------------------------------

/// Manages spawned PTY processes keyed by `terminal_id` (UUID string).
///
/// Held in `App`, shared via `Arc`. Each terminal runs one task (see the
/// module doc) that sends `terminal_data`, and `terminal_exited` when the
/// process exits on its own, to the owning account's sockets.
pub struct PtyManager {
    terminals: RwLock<HashMap<String, TerminalEntry>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            terminals: RwLock::new(HashMap::new()),
        }
    }

    /// Spawn a new PTY process owned by the account `owner`, start its I/O
    /// task, and register it under `terminal_id` in `app.pty_manager`.
    ///
    /// The child's environment is zzzd's minus secrets (`terminal_env`).
    ///
    /// The spawn runs to completion in its own task, so a caller dropped
    /// mid-spawn (socket closed, HTTP disconnect) can't abandon a live PTY —
    /// its master fd and child would leak unreaped. Such a terminal still gets
    /// registered (the caller never learns its id); it runs until its process
    /// exits or `kill_all`.
    ///
    /// # Errors
    ///
    /// A message describing the failure when the PTY can't be spawned —
    /// including a bad `cwd` or an unexecutable `command`, which fail the
    /// spawn rather than running somewhere else or exiting later.
    pub async fn spawn(
        app: Arc<App>,
        owner: Uuid,
        terminal_id: &str,
        command: &str,
        args: &[String],
        cwd: Option<&str>,
    ) -> Result<(), String> {
        let terminal_id = terminal_id.to_owned();
        let command = command.to_owned();
        let args = args.to_vec();
        let cwd = cwd.map(str::to_owned);
        tokio::spawn(spawn_terminal(app, owner, terminal_id, command, args, cwd))
            .await
            .map_err(|e| format!("spawn task failed: {e}"))?
    }

    /// Queue `data` for a terminal's stdin. A terminal that's exiting accepts
    /// and drops it (its `terminal_exited` follows).
    ///
    /// Chunks are written in queue order, each in full, by the terminal's
    /// task — this returns once `data` is queued, not written.
    ///
    /// # Errors
    ///
    /// `NotFound` when `owner` has no terminal `terminal_id` (see
    /// [`TerminalNotFound`]) — checked for empty `data` too; `InputFull` when
    /// its input queue is full — [`INPUT_QUEUE_CAPACITY`] chunks, or
    /// [`INPUT_QUEUE_MAX_BYTES`] bytes (a larger chunk only once nothing is
    /// held).
    pub async fn write(
        &self,
        owner: Uuid,
        terminal_id: &str,
        data: &str,
    ) -> Result<(), TerminalWriteError> {
        let terminals = self.terminals.read().await;
        let entry = owned_entry(&terminals, owner, terminal_id)?;
        if data.is_empty() {
            return Ok(());
        }
        let reservation = entry
            .input_budget
            .try_reserve(data.len())
            .ok_or(TerminalWriteError::InputFull)?;
        // a refused chunk is dropped here, releasing its reservation
        let chunk = QueuedInput {
            data: data.as_bytes().to_vec(),
            _reservation: reservation,
        };
        match entry.input.try_send(chunk) {
            Ok(()) | Err(TrySendError::Closed(_)) => Ok(()),
            Err(TrySendError::Full(_)) => Err(TerminalWriteError::InputFull),
        }
    }

    /// Resize a terminal's PTY window.
    ///
    /// # Errors
    ///
    /// `TerminalNotFound` when `owner` has no terminal `terminal_id`.
    pub async fn resize(
        &self,
        owner: Uuid,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalNotFound> {
        let terminals = self.terminals.read().await;
        let entry = owned_entry(&terminals, owner, terminal_id)?;
        let _ = entry.size.send((cols, rows));
        Ok(())
    }

    /// Record that the connection `connection` has taken a terminal's output
    /// up to `bytes` — the `sent_bytes` of the last `terminal_data` it
    /// finished with. From then on the terminal is paced against that
    /// connection, until it closes (see `OutputWindow`).
    ///
    /// Without a `connection` (a request over HTTP, which receives no
    /// output), or with one `registry` no longer holds, the ack is checked
    /// and otherwise ignored.
    ///
    /// # Errors
    ///
    /// `TerminalNotFound` when `owner` has no terminal `terminal_id`.
    pub async fn ack(
        &self,
        registry: &ConnectionRegistry,
        owner: Uuid,
        terminal_id: &str,
        connection: Option<ConnectionId>,
        bytes: u64,
    ) -> Result<(), TerminalNotFound> {
        let terminals = self.terminals.read().await;
        let entry = owned_entry(&terminals, owner, terminal_id)?;
        if let Some(connection) = connection {
            entry.output.ack(registry, connection, bytes);
        }
        Ok(())
    }

    /// The ids of `owner`'s terminals, sorted — including ones whose process
    /// just exited (their `terminal_exited` is on its way).
    pub async fn terminal_ids_for_account(&self, owner: Uuid) -> Vec<String> {
        let mut ids: Vec<String> = self
            .terminals
            .read()
            .await
            .iter()
            .filter(|(_, entry)| entry.owner == owner)
            .map(|(terminal_id, _)| terminal_id.clone())
            .collect();
        ids.sort_unstable();
        ids
    }

    /// Close a terminal: send `signal`, hang up the session, and return the
    /// exit code if the process ended within the close grace.
    ///
    /// Returns `Ok(None)` if the process was still running at the end of
    /// the grace — it's then reaped in the background (`SIGKILL` after
    /// `REAP_KILL_AFTER`), and no `terminal_exited` is sent for it.
    ///
    /// # Errors
    ///
    /// `TerminalNotFound` when `owner` has no terminal `terminal_id` —
    /// including one whose process already exited.
    pub async fn close(
        &self,
        owner: Uuid,
        terminal_id: &str,
        signal: i32,
    ) -> Result<Option<i32>, TerminalNotFound> {
        let (reply_tx, reply_rx) = oneshot::channel();
        {
            let mut terminals = self.terminals.write().await;
            owned_entry(&terminals, owner, terminal_id)?;
            let entry = terminals.remove(terminal_id).ok_or(TerminalNotFound)?;
            // Sent under the lock: a task finishing on EOF removes its entry
            // under the same lock, so it either sees this request or already
            // removed the entry (and this returned `TerminalNotFound` above).
            let _ = entry.close.send(CloseRequest {
                signal,
                reply: Some(reply_tx),
                kill_after: REAP_KILL_AFTER,
            });
        }
        Ok(reply_rx.await.ok().flatten())
    }

    /// Close every terminal owned by `owner` — for an account that was
    /// deleted or purged. Each gets `SIGTERM` and a hangup, and is reaped in
    /// the background (`SIGKILL` after `REAP_KILL_AFTER`); no
    /// `terminal_exited` is sent. Returns how many terminals were closed.
    pub async fn close_all_for_account(&self, owner: Uuid) -> usize {
        let entries: Vec<(String, TerminalEntry)> = {
            let mut terminals = self.terminals.write().await;
            terminals
                .extract_if(|_, entry| entry.owner == owner)
                .collect()
        };
        let count = entries.len();
        for (terminal_id, entry) in entries {
            tracing::info!(terminal_id = %terminal_id, %owner, "closing a removed account's terminal");
            let _ = entry.close.send(CloseRequest {
                signal: libc::SIGTERM,
                reply: None,
                kill_after: REAP_KILL_AFTER,
            });
        }
        count
    }

    /// Kill every active terminal without destroying the manager.
    ///
    /// Each terminal gets `SIGTERM` and a hangup, then `SIGKILL` right after
    /// the close grace; this waits (bounded by `KILL_ALL_TIMEOUT`) until every
    /// child is reaped. The manager stays usable for new `terminal_create`
    /// calls. Used by the test binary's `_testing_reset` `reset_state`
    /// callback to clear cross-test terminal pollution, and at shutdown.
    pub async fn kill_all(&self) {
        let entries: Vec<(String, TerminalEntry)> = {
            let mut terminals = self.terminals.write().await;
            terminals.drain().collect()
        };
        if entries.is_empty() {
            return;
        }

        let mut tasks = Vec::with_capacity(entries.len());
        for (terminal_id, entry) in entries {
            tracing::info!(terminal_id = %terminal_id, "killing terminal");
            let _ = entry.close.send(CloseRequest {
                signal: libc::SIGTERM,
                reply: None,
                kill_after: Duration::ZERO,
            });
            tasks.push(entry.task);
        }
        if tokio::time::timeout(KILL_ALL_TIMEOUT, futures_util::future::join_all(tasks))
            .await
            .is_err()
        {
            tracing::warn!("timed out waiting for terminals to be reaped");
        }
    }
}

/// The entry for `terminal_id` if `owner` owns it — an unknown id and another
/// account's are the same `TerminalNotFound`.
fn owned_entry<'a>(
    terminals: &'a HashMap<String, TerminalEntry>,
    owner: Uuid,
    terminal_id: &str,
) -> Result<&'a TerminalEntry, TerminalNotFound> {
    terminals
        .get(terminal_id)
        .filter(|entry| entry.owner == owner)
        .ok_or(TerminalNotFound)
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for PtyManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtyManager").finish_non_exhaustive()
    }
}

/// The body of `PtyManager::spawn`, run as its own task.
async fn spawn_terminal(
    app: Arc<App>,
    owner: Uuid,
    terminal_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let env = terminal_env(std::env::vars_os());

    // fork + waiting on the child's exec report are blocking syscalls
    let pty = tokio::task::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        Pty::spawn(
            &command,
            &arg_refs,
            cwd.as_deref(),
            Some(&env),
            DEFAULT_COLS,
            DEFAULT_ROWS,
        )
    })
    .await
    .map_err(|e| format!("spawn task failed: {e}"))?
    .map_err(|e| e.to_string())?;

    let master = match AsyncFd::try_new(PtyHandle::new(pty)) {
        Ok(master) => master,
        Err(e) => {
            let (mut handle, error) = e.into_parts();
            handle.close_master();
            let _ = handle.pty.kill(libc::SIGKILL);
            tokio::spawn(async move {
                if matches!(
                    wait_for_exit(&handle.pty, REAP_GIVE_UP_AFTER).await,
                    WaitResult::StillRunning
                ) {
                    tracing::error!(
                        pid = handle.pty.pid,
                        "terminal process survived SIGKILL, leaving it unreaped"
                    );
                }
            });
            return Err(format!("failed to register PTY with the reactor: {error}"));
        }
    };

    let (input_tx, input_rx) = mpsc::channel(INPUT_QUEUE_CAPACITY);
    let input_budget = Arc::new(InputBudget::new(INPUT_QUEUE_MAX_BYTES));
    let (size_tx, size_rx) = watch::channel((DEFAULT_COLS, DEFAULT_ROWS));
    let (close_tx, close_rx) = oneshot::channel();
    let output = Arc::new(OutputFlow::new());

    // Hold the write lock across the task spawn so the task can't finish
    // (and try to remove its entry) before the entry exists.
    let mut terminals = app.pty_manager.terminals.write().await;
    let task = tokio::spawn(run_terminal(TerminalIo {
        owner,
        terminal_id: terminal_id.clone(),
        master,
        input_rx,
        size_rx,
        output: Arc::clone(&output),
        recheck_interval: PAUSED_RECHECK_INTERVAL,
        close_rx,
        app: Arc::clone(&app),
    }));
    terminals.insert(
        terminal_id,
        TerminalEntry {
            owner,
            input: input_tx,
            input_budget,
            size: size_tx,
            output,
            close: close_tx,
            task,
        },
    );

    Ok(())
}

// -- Terminal task ------------------------------------------------------------

/// Everything a terminal's task owns.
struct TerminalIo {
    /// The account whose sockets receive the terminal's notifications.
    owner: Uuid,
    terminal_id: String,
    master: AsyncFd<PtyHandle>,
    input_rx: mpsc::Receiver<QueuedInput>,
    size_rx: watch::Receiver<(u16, u16)>,
    output: Arc<OutputFlow>,
    /// How often the terminal, while paused, re-checks its consumers'
    /// connections — [`PAUSED_RECHECK_INTERVAL`].
    recheck_interval: Duration,
    close_rx: oneshot::Receiver<CloseRequest>,
    app: Arc<App>,
}

/// Why the I/O loop ended.
enum IoOutcome {
    /// The slave side closed — the process exited (or dropped its terminal).
    Eof,
    /// `terminal_close` / `kill_all` asked to shut the terminal down.
    Close(CloseRequest),
}

/// A queued input chunk being written, possibly across several writes. Its
/// bytes stay reserved until it's dropped — written in full, or abandoned.
struct PendingWrite {
    input: QueuedInput,
    written: usize,
}

async fn run_terminal(mut io: TerminalIo) {
    let mut decoder = Utf8StreamDecoder::default();
    let outcome = pump_io(&mut io, &mut decoder).await;

    let TerminalIo {
        owner,
        terminal_id,
        master,
        output,
        mut close_rx,
        app,
        ..
    } = io;
    let mut handle = master.into_inner();

    match outcome {
        IoOutcome::Eof => {
            // an incomplete UTF-8 tail can't be completed now — flush it
            send_data(
                &app,
                owner,
                &terminal_id,
                &output,
                &decoder.finish_to_string(),
            );
            handle.close_master();
            let exit_code = reap(&handle.pty, REAP_KILL_AFTER).await;
            tracing::info!(terminal_id, ?exit_code, "terminal exited");

            // Removed under the lock `close` sends under — a close request
            // that won the race is already in `close_rx`. That close gets the
            // exit code in its reply instead of a `terminal_exited` notification
            // (closed terminals never send one).
            app.pty_manager.terminals.write().await.remove(&terminal_id);
            if let Ok(request) = close_rx.try_recv() {
                if let Some(reply) = request.reply {
                    let _ = reply.send(exit_code);
                }
                return;
            }

            let notification = fuz_http::notification(
                "terminal_exited",
                &TerminalExitedParams {
                    terminal_id: &terminal_id,
                    exit_code,
                },
            );
            app.realtime.send_to_account(owner, &notification);
        }
        IoOutcome::Close(request) => {
            close_terminal(handle, request, &terminal_id).await;
        }
    }
}

/// Move bytes between the PTY and zzz until EOF or a close request.
///
/// While the output window is paused (`OutputWindow`) the master isn't
/// polled for reads — the child blocks once the kernel's PTY buffer is full —
/// and so EOF isn't seen either: a child that exits while paused is noticed,
/// and its `terminal_exited` sent, once the window reopens and the rest of
/// its output has been read. Close requests, input, and resizes are served
/// throughout.
async fn pump_io(io: &mut TerminalIo, decoder: &mut Utf8StreamDecoder) -> IoOutcome {
    let mut buf = vec![0u8; READ_BUFFER_SIZE];
    let mut pending: Option<PendingWrite> = None;
    let mut input_open = true;
    let mut size_open = true;
    let mut paused = false;
    // when a paused terminal next re-checks its consumers' connections —
    // a deadline, so serving input or resizes doesn't push it back
    let mut recheck_at = Instant::now();

    loop {
        tokio::select! {
            request = &mut io.close_rx => {
                // A dropped sender without a request means the entry was
                // discarded (manager dropped) — shut down as a plain close.
                return IoOutcome::Close(request.unwrap_or(CloseRequest {
                    signal: libc::SIGTERM,
                    reply: None,
                    kill_after: REAP_KILL_AFTER,
                }));
            }
            ready = io.master.readable(), if !paused => {
                let Ok(mut guard) = ready else {
                    return IoOutcome::Eof;
                };
                let read =
                    guard.try_io(|master| read_master(&master.get_ref().pty, &mut buf));
                drop(guard);
                match read {
                    Ok(Ok(0) | Err(_)) => return IoOutcome::Eof,
                    Ok(Ok(n)) => {
                        let text = decoder.feed_to_string(&buf[..n]);
                        paused =
                            send_data(&io.app, io.owner, &io.terminal_id, &io.output, &text);
                        recheck_at = Instant::now() + io.recheck_interval;
                        // Readiness futures don't consume coop budget, so a
                        // child that never stops writing would otherwise pin
                        // this worker thread — yield once the budget is spent.
                        tokio::task::coop::consume_budget().await;
                    }
                    // not actually readable — readiness cleared, wait again
                    Err(_would_block) => {}
                }
            }
            // An ack moved the window, or it's time to check that the
            // connections being paced against are still open.
            () = io.output.acked.notified(), if paused => {
                paused = io.output.refresh_paused(&io.app.realtime);
            }
            () = tokio::time::sleep_until(recheck_at), if paused => {
                paused = io.output.refresh_paused(&io.app.realtime);
                recheck_at = Instant::now() + io.recheck_interval;
            }
            ready = io.master.writable(), if pending.is_some() => {
                let Ok(mut guard) = ready else {
                    pending = None;
                    continue;
                };
                let Some(write) = pending.as_mut() else {
                    continue;
                };
                let unwritten = &write.input.data[write.written..];
                let result =
                    guard.try_io(|master| write_master(&master.get_ref().pty, unwritten));
                drop(guard);
                match result {
                    Ok(Ok(n)) if n > 0 => {
                        write.written += n;
                        if write.written >= write.input.data.len() {
                            pending = None;
                        }
                    }
                    Ok(Ok(_) | Err(_)) => {
                        // the slave is gone (EIO) — the read side will see EOF
                        tracing::debug!(
                            terminal_id = %io.terminal_id,
                            "dropping terminal input: PTY write failed"
                        );
                        pending = None;
                    }
                    // buffer full — readiness cleared, wait for writability
                    Err(_would_block) => {}
                }
            }
            chunk = io.input_rx.recv(), if input_open && pending.is_none() => {
                match chunk {
                    Some(input) => pending = Some(PendingWrite { input, written: 0 }),
                    None => input_open = false,
                }
            }
            changed = io.size_rx.changed(), if size_open => {
                if changed.is_ok() {
                    let (cols, rows) = *io.size_rx.borrow_and_update();
                    if let Err(e) = io.master.get_ref().pty.resize(cols, rows) {
                        tracing::debug!(
                            terminal_id = %io.terminal_id,
                            error = %e,
                            "PTY resize failed"
                        );
                    }
                } else {
                    size_open = false;
                }
            }
        }
    }
}

/// `Pty::read` in `io::Result` form for `AsyncFdReadyGuard::try_io`: `Ok(0)`
/// is EOF, `WouldBlock` clears readiness.
fn read_master(pty: &Pty, buf: &mut [u8]) -> io::Result<usize> {
    match pty.read(buf) {
        ReadResult::Data(n) => Ok(n),
        ReadResult::WouldBlock => Err(io::ErrorKind::WouldBlock.into()),
        ReadResult::Eof => Ok(0),
    }
}

/// `Pty::write` in `io::Result` form for `AsyncFdReadyGuard::try_io`.
fn write_master(pty: &Pty, data: &[u8]) -> io::Result<usize> {
    match pty.write(data) {
        Ok(n) => Ok(n),
        Err(PtyError::WouldBlock) => Err(io::ErrorKind::WouldBlock.into()),
        Err(e) => Err(io::Error::other(e)),
    }
}

/// Shut a terminal down per `request`: signal, wait briefly, hang up, wait
/// briefly, reply, then reap whatever's left in the background of this task.
async fn close_terminal(mut handle: PtyHandle, request: CloseRequest, terminal_id: &str) {
    // The child is unreaped until this task reaps it, so its pid can't have
    // been reused — signalling it is safe.
    let _ = handle.pty.kill(request.signal);
    let mut result = wait_for_exit(&handle.pty, CLOSE_SIGNAL_GRACE).await;

    // Closing the master hangs up the session: an interactive shell that
    // ignores SIGTERM exits on the SIGHUP.
    handle.close_master();
    if matches!(result, WaitResult::StillRunning) {
        result = wait_for_exit(&handle.pty, CLOSE_HANGUP_GRACE).await;
    }

    let exit_code = match result {
        WaitResult::Exited(code) => Some(code),
        WaitResult::StillRunning | WaitResult::Unavailable => None,
    };
    if let Some(reply) = request.reply {
        let _ = reply.send(exit_code);
    }

    if matches!(result, WaitResult::StillRunning) {
        let late_exit_code = reap(&handle.pty, request.kill_after).await;
        tracing::info!(terminal_id, exit_code = ?late_exit_code, "closed terminal reaped");
    } else {
        tracing::info!(terminal_id, ?exit_code, "terminal closed");
    }
}

// -- Reaping ------------------------------------------------------------------

/// Reap `pty`'s child: poll `waitpid` until it exits, sending `SIGKILL` once
/// `kill_after` elapses, and give up `REAP_GIVE_UP_AFTER` later.
///
/// Returns the exit code (`128 + signal` if killed), or `None` if it couldn't
/// be determined. Never signals a pid `waitpid` has already reported gone.
async fn reap(pty: &Pty, kill_after: Duration) -> Option<i32> {
    match wait_for_exit(pty, kill_after).await {
        WaitResult::Exited(code) => return Some(code),
        WaitResult::Unavailable => return None,
        WaitResult::StillRunning => {}
    }
    tracing::warn!(
        pid = pty.pid,
        "terminal process outlived its grace period, sending SIGKILL"
    );
    let _ = pty.kill(libc::SIGKILL);
    match wait_for_exit(pty, REAP_GIVE_UP_AFTER).await {
        WaitResult::Exited(code) => Some(code),
        WaitResult::Unavailable => None,
        WaitResult::StillRunning => {
            tracing::error!(
                pid = pty.pid,
                "terminal process survived SIGKILL, leaving it unreaped"
            );
            None
        }
    }
}

/// Poll `waitpid` with exponential backoff until the child exits or `timeout`
/// elapses. Returns `StillRunning` on timeout.
async fn wait_for_exit(pty: &Pty, timeout: Duration) -> WaitResult {
    let deadline = Instant::now() + timeout;
    let mut delay = REAP_POLL_MIN;
    loop {
        let result = pty.waitpid();
        if !matches!(result, WaitResult::StillRunning) {
            return result;
        }
        let now = Instant::now();
        if now >= deadline {
            return result;
        }
        tokio::time::sleep(delay.min(deadline - now)).await;
        delay = (delay * 2).min(REAP_POLL_MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn names(env: &[(OsString, OsString)]) -> Vec<&str> {
        env.iter()
            .map(|(k, _)| k.to_str().expect("utf-8 name"))
            .collect()
    }

    #[test]
    fn terminal_env_strips_secrets_and_zzz_config() {
        let env = terminal_env(vars(&[
            ("SECRET_ANTHROPIC_API_KEY", "sk"),
            ("SECRET_FUZ_COOKIE_KEYS", "k"),
            ("DATABASE_URL", "postgres://localhost/zzz"),
            ("FUZ_ALLOWED_ORIGINS", "http://localhost:*"),
            ("FUZ_BOOTSTRAP_TOKEN_PATH", "/tmp/t"),
            ("ZZZ_PORT", "4460"),
            ("ZZZ_ENABLE_TEST_ACTIONS", "1"),
            ("PUBLIC_ZZZ_DIR", ".zzz"),
            ("PORT", "4460"),
        ]));
        assert!(env.is_empty(), "leaked: {:?}", names(&env));
    }

    #[test]
    fn terminal_env_passes_user_environment_through() {
        let input = vars(&[
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/me"),
            ("USER", "me"),
            ("SHELL", "/bin/bash"),
            ("LANG", "en_US.UTF-8"),
            ("SSH_AUTH_SOCK", "/run/user/1000/ssh"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("TERM", "xterm"),
        ]);
        assert_eq!(terminal_env(input.clone()), input);
    }

    #[test]
    fn terminal_env_matches_names_exactly_and_by_prefix_only() {
        let env = terminal_env(vars(&[
            // exact-name rules don't catch lookalikes
            ("PORTAGE", "x"),
            ("MY_DATABASE_URL", "x"),
            ("DATABASE_URL_EXTRA", "x"),
            // prefix rules are anchored at the start and case-sensitive
            ("MY_SECRET_THING", "x"),
            ("PUBLIC_OTHER", "x"),
            ("secret_lowercase", "x"),
            ("FUZ", "x"),
            // stripped
            ("FUZ_", "x"),
            ("SECRET_X", "x"),
        ]));
        assert_eq!(
            names(&env),
            vec![
                "PORTAGE",
                "MY_DATABASE_URL",
                "DATABASE_URL_EXTRA",
                "MY_SECRET_THING",
                "PUBLIC_OTHER",
                "secret_lowercase",
                "FUZ",
            ]
        );
    }

    #[test]
    fn terminal_env_keeps_non_utf8_names() {
        use std::os::unix::ffi::OsStringExt;
        let odd = OsString::from_vec(vec![b'X', 0xFF]);
        let env = terminal_env(vec![(odd.clone(), OsString::from("v"))]);
        assert_eq!(env, vec![(odd, OsString::from("v"))]);
    }

    fn spawn_pty(script: &str) -> Pty {
        Pty::spawn("sh", &["-c", script], None, None, 80, 24).expect("spawn failed")
    }

    /// Spawn `script` after installing `trap '' <signals>`, and wait until the
    /// trap is live (the script prints a marker after it) before returning.
    async fn spawn_trapping(signals: &str, script: &str) -> Pty {
        let pty = spawn_pty(&format!("trap '' {signals}; echo TRAPPED; {script}"));
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        let mut buf = [0u8; 1024];
        while !String::from_utf8_lossy(&output).contains("TRAPPED") {
            assert!(Instant::now() < deadline, "trap never installed");
            match pty.read(&mut buf) {
                ReadResult::Data(n) => output.extend_from_slice(&buf[..n]),
                ReadResult::WouldBlock => tokio::time::sleep(Duration::from_millis(5)).await,
                ReadResult::Eof => panic!("child exited before installing its trap"),
            }
        }
        pty
    }

    #[tokio::test]
    async fn reap_collects_a_normal_exit() {
        let pty = spawn_pty("exit 3");
        assert_eq!(reap(&pty, REAP_KILL_AFTER).await, Some(3));
        assert!(matches!(pty.waitpid(), WaitResult::Unavailable));
        pty.close().expect("close failed");
    }

    #[tokio::test]
    async fn reap_escalates_to_sigkill() {
        // Ignores SIGTERM and SIGHUP (ignored dispositions survive `exec`),
        // so only the SIGKILL escalation can end it.
        let pty = spawn_trapping("TERM HUP", "exec sleep 30").await;
        let started = std::time::Instant::now();
        let _ = pty.kill(libc::SIGTERM);
        pty.close().expect("close failed");
        let exit_code = reap(&pty, Duration::from_millis(200)).await;
        assert_eq!(exit_code, Some(128 + libc::SIGKILL));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            matches!(pty.waitpid(), WaitResult::Unavailable),
            "child must be reaped, not left a zombie"
        );
    }

    #[tokio::test]
    async fn close_terminal_hangs_up_a_shell_that_ignores_sigterm() {
        // The interactive-shell case: SIGTERM is ignored, the hangup from
        // closing the master ends it, and the real exit code comes back.
        let pty = spawn_trapping("TERM", "sleep 30").await;
        let pid_check = Pty {
            master_fd: -1,
            pid: pty.pid,
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        close_terminal(
            PtyHandle::new(pty),
            CloseRequest {
                signal: libc::SIGTERM,
                reply: Some(reply_tx),
                kill_after: REAP_KILL_AFTER,
            },
            "test",
        )
        .await;
        let exit_code = reply_rx.await.expect("reply sent");
        assert_eq!(exit_code, Some(128 + libc::SIGHUP));
        assert!(matches!(pid_check.waitpid(), WaitResult::Unavailable));
    }

    #[tokio::test]
    async fn close_terminal_reaps_a_child_ignoring_term_and_hup() {
        let pty = spawn_trapping("TERM HUP", "exec sleep 30").await;
        let pid_check = Pty {
            master_fd: -1,
            pid: pty.pid,
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        let started = std::time::Instant::now();
        close_terminal(
            PtyHandle::new(pty),
            CloseRequest {
                signal: libc::SIGTERM,
                reply: Some(reply_tx),
                kill_after: Duration::from_millis(200),
            },
            "test",
        )
        .await;
        // the reply reports "still running"; the task then escalated and reaped
        assert_eq!(reply_rx.await.expect("reply sent"), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            matches!(pid_check.waitpid(), WaitResult::Unavailable),
            "child must be reaped, not left a zombie"
        );
    }

    /// A terminal's receiving ends, kept alive so its channels stay open.
    struct FakeTerminal {
        input: mpsc::Receiver<QueuedInput>,
        size: watch::Receiver<(u16, u16)>,
        _close: oneshot::Receiver<CloseRequest>,
    }

    /// Register a terminal entry with no process behind it.
    async fn insert_fake(manager: &PtyManager, terminal_id: &str, owner: Uuid) -> FakeTerminal {
        let (input_tx, input) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let (size_tx, size) = watch::channel((DEFAULT_COLS, DEFAULT_ROWS));
        let (close_tx, close) = oneshot::channel();
        manager.terminals.write().await.insert(
            terminal_id.to_owned(),
            TerminalEntry {
                owner,
                input: input_tx,
                input_budget: Arc::new(InputBudget::new(INPUT_QUEUE_MAX_BYTES)),
                size: size_tx,
                output: Arc::new(OutputFlow::new()),
                close: close_tx,
                task: tokio::spawn(async {}),
            },
        );
        FakeTerminal {
            input,
            size,
            _close: close,
        }
    }

    #[tokio::test]
    async fn unknown_and_foreign_terminals_are_the_same_not_found() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut fake = insert_fake(&manager, "t1", owner).await;
        let registry = ConnectionRegistry::new();
        let (connection, _frames) = connect(&registry, other);

        for (account, terminal_id) in [(other, "t1"), (owner, "missing"), (other, "missing")] {
            assert_eq!(
                manager.write(account, terminal_id, "x").await,
                Err(TerminalWriteError::NotFound(TerminalNotFound)),
                "{terminal_id}"
            );
            // an empty write is checked too
            assert_eq!(
                manager.write(account, terminal_id, "").await,
                Err(TerminalWriteError::NotFound(TerminalNotFound))
            );
            assert_eq!(
                manager.resize(account, terminal_id, 100, 30).await,
                Err(TerminalNotFound)
            );
            assert_eq!(
                manager
                    .ack(&registry, account, terminal_id, Some(connection.id), 1)
                    .await,
                Err(TerminalNotFound)
            );
            // checked without a connection too
            assert_eq!(
                manager.ack(&registry, account, terminal_id, None, 1).await,
                Err(TerminalNotFound)
            );
            assert_eq!(
                manager.close(account, terminal_id, libc::SIGTERM).await,
                Err(TerminalNotFound)
            );
        }
        assert!(
            !consumes(&manager, "t1", connection.id).await,
            "no foreign ack reached it"
        );
        assert!(
            fake.input.try_recv().is_err(),
            "no foreign input reached it"
        );
        assert!(
            !fake.size.has_changed().unwrap(),
            "no foreign resize reached it"
        );

        // the owner drives it
        assert_eq!(manager.write(owner, "t1", "mine").await, Ok(()));
        assert_eq!(fake.input.try_recv().unwrap().data, b"mine");
        assert_eq!(manager.write(owner, "t1", "").await, Ok(()));
        assert!(fake.input.try_recv().is_err(), "empty writes aren't queued");
        assert_eq!(manager.resize(owner, "t1", 100, 30).await, Ok(()));
        assert_eq!(*fake.size.borrow_and_update(), (100, 30));
    }

    /// Open a connection for `account` on `registry`, returning it with the
    /// receiving end of its outbound queue.
    fn connect(
        registry: &ConnectionRegistry,
        account: Uuid,
    ) -> (fuz_realtime::Connection, fuz_realtime::ConnectionReceiver) {
        let (sender, frames) = fuz_realtime::connection_channel(TEST_OUTBOUND_QUEUE_BYTES);
        let connection = registry.add_connection(
            sender,
            None,
            Some(account),
            None,
            tokio_util::sync::CancellationToken::new(),
        );
        (connection, frames)
    }

    /// Roomy enough that no test's output overflows a connection nobody
    /// reads from.
    const TEST_OUTBOUND_QUEUE_BYTES: usize = 64 * 1024 * 1024;

    /// Whether `connection` is one of the terminal's consumers.
    async fn consumes(manager: &PtyManager, terminal_id: &str, connection: ConnectionId) -> bool {
        manager.terminals.read().await[terminal_id]
            .output
            .window
            .lock()
            .has_consumer(connection)
    }

    #[tokio::test]
    async fn an_ack_makes_its_connection_a_consumer() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let _fake = insert_fake(&manager, "t1", owner).await;
        let registry = ConnectionRegistry::new();
        let (connection, _frames) = connect(&registry, owner);
        let (closed, closed_frames) = connect(&registry, owner);
        registry.remove_connection(closed.id);
        drop(closed_frames);

        // over HTTP there's no connection to pace against
        assert_eq!(manager.ack(&registry, owner, "t1", None, 5).await, Ok(()));
        // nor is a closed one worth waiting for
        assert_eq!(
            manager
                .ack(&registry, owner, "t1", Some(closed.id), 5)
                .await,
            Ok(())
        );
        assert!(!consumes(&manager, "t1", closed.id).await);
        assert!(!consumes(&manager, "t1", connection.id).await);

        assert_eq!(
            manager
                .ack(&registry, owner, "t1", Some(connection.id), 5)
                .await,
            Ok(())
        );
        assert!(consumes(&manager, "t1", connection.id).await);
    }

    #[tokio::test]
    async fn a_new_consumer_drops_the_closed_ones() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let _fake = insert_fake(&manager, "t1", owner).await;
        let registry = ConnectionRegistry::new();
        let (first, _first_frames) = connect(&registry, owner);
        manager
            .ack(&registry, owner, "t1", Some(first.id), 1)
            .await
            .unwrap();
        registry.remove_connection(first.id);

        let (second, _second_frames) = connect(&registry, owner);
        manager
            .ack(&registry, owner, "t1", Some(second.id), 1)
            .await
            .unwrap();
        assert!(consumes(&manager, "t1", second.id).await);
        assert!(!consumes(&manager, "t1", first.id).await);
    }

    // -- OutputWindow --

    /// A window pausing above 100 unacknowledged bytes, resuming at 40.
    fn window() -> OutputWindow<u32> {
        OutputWindow::new(100, 40)
    }

    #[test]
    fn a_window_counts_what_it_sends() {
        let mut window = window();
        assert_eq!(window.record_sent(7), 7);
        assert_eq!(window.record_sent(0), 7);
        assert_eq!(window.record_sent(5), 12);
    }

    #[test]
    fn a_window_without_consumers_never_pauses() {
        let mut window = window();
        window.record_sent(1_000_000);
        assert_eq!(window.unacked(), None);
        assert!(!window.is_paused());
    }

    #[test]
    fn a_window_pauses_above_the_high_mark() {
        let mut window = window();
        window.ack(1, 0);
        window.record_sent(100);
        assert_eq!(window.unacked(), Some(100));
        assert!(!window.is_paused(), "at the mark isn't past it");
        window.record_sent(1);
        assert!(window.is_paused());
    }

    #[test]
    fn a_paused_window_resumes_at_the_low_mark() {
        let mut window = window();
        window.ack(1, 0);
        window.record_sent(101);
        assert!(window.is_paused());
        window.ack(1, 60);
        assert_eq!(window.unacked(), Some(41));
        assert!(window.is_paused(), "below the high mark isn't enough");
        window.ack(1, 61);
        assert!(!window.is_paused());
        // and stays open until it passes the high mark again
        window.record_sent(60);
        assert_eq!(window.unacked(), Some(100));
        assert!(!window.is_paused());
        window.record_sent(1);
        assert!(window.is_paused());
    }

    #[test]
    fn a_window_keeps_pace_with_its_fastest_consumer() {
        let mut window = window();
        window.ack(1, 0);
        window.ack(2, 0);
        window.record_sent(500);
        assert!(window.is_paused());
        // one consumer catching up is enough, however far behind the other
        window.ack(2, 480);
        assert_eq!(window.unacked(), Some(20));
        assert!(!window.is_paused());
    }

    #[test]
    fn a_closed_consumer_stops_counting() {
        let mut window = window();
        window.ack(1, 0);
        window.ack(2, 0);
        window.record_sent(500);
        window.ack(2, 500);
        assert!(!window.is_paused());
        // the fast one closes: the window is the slow one's
        window.retain_consumers(|consumer| consumer != 2);
        assert_eq!(window.unacked(), Some(500));
        assert!(window.is_paused());
        // the last one closes: nothing left to wait for
        window.retain_consumers(|_| false);
        assert_eq!(window.unacked(), None);
        assert!(!window.is_paused());
    }

    #[test]
    fn acks_are_cumulative() {
        let mut window = window();
        window.record_sent(300);
        window.ack(1, 250);
        // a late or repeated ack never takes the count back
        window.ack(1, 100);
        assert_eq!(window.unacked(), Some(50));
        window.ack(1, 250);
        assert_eq!(window.unacked(), Some(50));
    }

    #[test]
    fn an_ack_past_what_was_sent_counts_as_all_of_it() {
        let mut window = window();
        window.record_sent(300);
        window.ack(1, u64::MAX);
        assert_eq!(window.unacked(), Some(0));
        // it didn't acknowledge output that hadn't been sent yet
        window.record_sent(101);
        assert_eq!(window.unacked(), Some(101));
        assert!(window.is_paused());
    }

    // -- pump_io pacing --

    /// An `App` with nothing behind it but a connection registry.
    fn test_app() -> Arc<App> {
        let pool = fuz_db::create_pool("postgres://localhost:1/pty_unused")
            .expect("a lazy pool builds without connecting");
        Arc::new(App::new(
            pool,
            crate::scoped_fs::ScopedFs::new(vec![]),
            String::new(),
            vec![],
            crate::provider::ProviderManager::new(),
            false,
            Arc::new(ConnectionRegistry::new()),
        ))
    }

    /// A real PTY whose I/O loop runs in a task, with the handles the manager
    /// would hold.
    struct Pumped {
        app: Arc<App>,
        output: Arc<OutputFlow>,
        input: mpsc::Sender<QueuedInput>,
        input_budget: Arc<InputBudget>,
        close: oneshot::Sender<CloseRequest>,
        _size: watch::Sender<(u16, u16)>,
        /// The owner's one connection, and its queue (never read).
        connection: fuz_realtime::Connection,
        _frames: fuz_realtime::ConnectionReceiver,
        task: JoinHandle<(TerminalIo, IoOutcome)>,
    }

    impl Pumped {
        fn spawn(script: &str) -> Self {
            Self::spawn_rechecking(script, PAUSED_RECHECK_INTERVAL)
        }

        /// [`Self::spawn`] with its own interval between a paused terminal's
        /// re-checks of its consumers.
        fn spawn_rechecking(script: &str, recheck_interval: Duration) -> Self {
            let app = test_app();
            let owner = Uuid::new_v4();
            let (connection, frames) = connect(&app.realtime, owner);
            let master = AsyncFd::try_new(PtyHandle::new(spawn_pty(script))).expect("async fd");
            let (input, input_rx) = mpsc::channel(INPUT_QUEUE_CAPACITY);
            let (size, size_rx) = watch::channel((DEFAULT_COLS, DEFAULT_ROWS));
            let (close, close_rx) = oneshot::channel();
            let output = Arc::new(OutputFlow::new());
            let mut io = TerminalIo {
                owner,
                terminal_id: "t1".to_owned(),
                master,
                input_rx,
                size_rx,
                output: Arc::clone(&output),
                recheck_interval,
                close_rx,
                app: Arc::clone(&app),
            };
            let task = tokio::spawn(async move {
                let mut decoder = Utf8StreamDecoder::default();
                let outcome = pump_io(&mut io, &mut decoder).await;
                (io, outcome)
            });
            Self {
                app,
                output,
                input,
                input_budget: Arc::new(InputBudget::new(INPUT_QUEUE_MAX_BYTES)),
                close,
                _size: size,
                connection,
                _frames: frames,
                task,
            }
        }

        fn ack(&self, bytes: u64) {
            self.output
                .ack(&self.app.realtime, self.connection.id, bytes);
        }

        fn sent(&self) -> u64 {
            self.output.window.lock().sent
        }

        /// Wait until the window is paused, returning what had been sent.
        async fn paused(&self) -> u64 {
            wait_until("the terminal to pause", || {
                self.output.window.lock().is_paused()
            })
            .await;
            self.sent()
        }

        /// Wait for the I/O loop to end, then reap the child.
        async fn finish(self) -> IoOutcome {
            let (io, outcome) = tokio::time::timeout(PUMP_TIMEOUT, self.task)
                .await
                .expect("the I/O loop to end")
                .expect("the I/O loop not to panic");
            let mut handle = io.master.into_inner();
            handle.close_master();
            let _ = handle.pty.kill(libc::SIGKILL);
            reap(&handle.pty, REAP_KILL_AFTER).await;
            outcome
        }
    }

    const PUMP_TIMEOUT: Duration = Duration::from_secs(30);

    async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + PUMP_TIMEOUT;
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Longer than `PAUSED_RECHECK_INTERVAL`, so a paused terminal has
    /// re-checked its consumers at least once.
    const PAST_A_RECHECK: Duration = Duration::from_millis(600);

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unacknowledged_output_stops_the_reads_and_not_the_input() {
        let pumped = Pumped::spawn("exec yes");
        // the first ack is what makes the connection one to pace against
        pumped.ack(0);
        let sent = pumped.paused().await;
        assert!(sent > OUTPUT_WINDOW_HIGH_BYTES, "{sent}");
        assert!(
            sent <= OUTPUT_WINDOW_HIGH_BYTES + READ_BUFFER_SIZE as u64,
            "at most one read past the mark: {sent}"
        );

        // nothing more is read while the consumer, still connected, is behind
        tokio::time::sleep(PAST_A_RECHECK).await;
        assert_eq!(pumped.sent(), sent);

        // input is written while paused: an interrupt for the child
        let reservation = pumped.input_budget.try_reserve(1).unwrap();
        pumped
            .input
            .send(QueuedInput {
                data: vec![0x03],
                _reservation: reservation,
            })
            .await
            .unwrap();
        wait_until("the input to be written", || {
            pumped.input_budget.held.load(Ordering::Acquire) == 0
        })
        .await;
        assert_eq!(pumped.sent(), sent, "still paused");

        // catching up reopens the window: the rest is read, up to the EOF of
        // the child the interrupt ended
        pumped.ack(sent);
        assert!(matches!(pumped.finish().await, IoOutcome::Eof));
    }

    #[tokio::test]
    async fn an_ack_wakes_the_terminal_task() {
        let registry = ConnectionRegistry::new();
        let (connection, _frames) = connect(&registry, Uuid::new_v4());
        let flow = OutputFlow::new();
        let woken = flow.acked.notified();
        tokio::pin!(woken);
        assert!(
            futures_util::poll!(woken.as_mut()).is_pending(),
            "nothing has acked yet"
        );
        flow.ack(&registry, connection.id, 0);
        assert!(futures_util::poll!(woken).is_ready());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_ack_resumes_the_reads_without_a_recheck() {
        // no re-check comes while the test runs, so only the ack itself can
        // resume the reads
        let pumped = Pumped::spawn_rechecking("exec yes", 10 * PUMP_TIMEOUT);
        pumped.ack(0);
        let sent = pumped.paused().await;
        pumped.ack(sent);
        wait_until("the ack to resume the reads", || pumped.sent() > sent).await;
        let (close, _) = oneshot::channel();
        let mut pumped = pumped;
        let close = std::mem::replace(&mut pumped.close, close);
        assert!(
            close
                .send(CloseRequest {
                    signal: libc::SIGTERM,
                    reply: None,
                    kill_after: REAP_KILL_AFTER,
                })
                .is_ok()
        );
        assert!(matches!(pumped.finish().await, IoOutcome::Close(_)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_paused_terminal_still_closes() {
        let mut pumped = Pumped::spawn("exec yes");
        pumped.ack(0);
        pumped.paused().await;
        let (close, _) = oneshot::channel();
        let close = std::mem::replace(&mut pumped.close, close);
        let sent = close.send(CloseRequest {
            signal: libc::SIGTERM,
            reply: None,
            kill_after: REAP_KILL_AFTER,
        });
        assert!(sent.is_ok());
        assert!(matches!(pumped.finish().await, IoOutcome::Close(_)));
    }

    /// Prints a few times the high mark, then exits.
    const SEVERAL_WINDOWS: &str = "yes | head -c 4000000";

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn output_nobody_acknowledges_is_never_paused() {
        // a connection that receives the output but never acks it
        let pumped = Pumped::spawn(SEVERAL_WINDOWS);
        let output = Arc::clone(&pumped.output);
        assert!(matches!(pumped.finish().await, IoOutcome::Eof));
        let window = output.window.lock();
        assert!(
            window.sent > 3 * OUTPUT_WINDOW_HIGH_BYTES,
            "{}",
            window.sent
        );
        assert!(!window.is_paused());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_consumer_that_closes_stops_pacing_the_terminal() {
        let pumped = Pumped::spawn(SEVERAL_WINDOWS);
        pumped.ack(0);
        pumped.paused().await;
        // its connection goes away without another ack
        pumped.app.realtime.remove_connection(pumped.connection.id);
        let output = Arc::clone(&pumped.output);
        assert!(matches!(pumped.finish().await, IoOutcome::Eof));
        assert!(output.window.lock().sent > 3 * OUTPUT_WINDOW_HIGH_BYTES);
    }

    #[tokio::test]
    async fn a_full_input_queue_is_refused() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let _fake = insert_fake(&manager, "t1", owner).await;
        for _ in 0..INPUT_QUEUE_CAPACITY {
            manager.write(owner, "t1", "x").await.unwrap();
        }
        assert_eq!(
            manager.write(owner, "t1", "x").await,
            Err(TerminalWriteError::InputFull)
        );
    }

    #[tokio::test]
    async fn input_is_capped_by_bytes_held() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let mut fake = insert_fake(&manager, "t1", owner).await;
        let quarter = "x".repeat(INPUT_QUEUE_MAX_BYTES / 4);
        for _ in 0..4 {
            manager.write(owner, "t1", &quarter).await.unwrap();
        }
        // the budget is spent, though far fewer chunks than the count cap
        assert_eq!(
            manager.write(owner, "t1", "x").await,
            Err(TerminalWriteError::InputFull)
        );
        // a chunk written (dropped by the task) frees its bytes
        drop(fake.input.try_recv().unwrap());
        manager.write(owner, "t1", &quarter).await.unwrap();
        assert_eq!(
            manager.write(owner, "t1", "x").await,
            Err(TerminalWriteError::InputFull)
        );
    }

    #[tokio::test]
    async fn a_chunk_over_the_byte_cap_waits_for_an_empty_queue() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let mut fake = insert_fake(&manager, "t1", owner).await;
        let big = "x".repeat(INPUT_QUEUE_MAX_BYTES + 1);
        manager.write(owner, "t1", "a").await.unwrap();
        // refused while anything is held
        assert_eq!(
            manager.write(owner, "t1", &big).await,
            Err(TerminalWriteError::InputFull)
        );
        drop(fake.input.try_recv().unwrap());
        // accepted once nothing is — and written in full
        manager.write(owner, "t1", &big).await.unwrap();
        // it holds the whole budget until it's written
        assert_eq!(
            manager.write(owner, "t1", "b").await,
            Err(TerminalWriteError::InputFull)
        );
        assert_eq!(fake.input.try_recv().unwrap().data.len(), big.len());
        manager.write(owner, "t1", "b").await.unwrap();
    }

    #[test]
    fn a_reservation_releases_on_drop() {
        let budget = Arc::new(InputBudget::new(10));
        let a = budget.try_reserve(6).unwrap();
        assert!(budget.try_reserve(5).is_none(), "6 + 5 is over 10");
        let b = budget.try_reserve(4).unwrap();
        drop(a);
        assert_eq!(budget.held.load(Ordering::Acquire), 4);
        drop(b);
        assert_eq!(budget.held.load(Ordering::Acquire), 0);
        // over the whole budget: only when nothing is held
        let big = budget.try_reserve(11).unwrap();
        assert!(budget.try_reserve(1).is_none());
        drop(big);
        assert!(budget.try_reserve(1).is_some());
    }

    #[tokio::test]
    async fn a_refused_chunk_releases_its_bytes() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let _fake = insert_fake(&manager, "t1", owner).await;
        for _ in 0..INPUT_QUEUE_CAPACITY {
            manager.write(owner, "t1", "x").await.unwrap();
        }
        // refused by the chunk count, after its bytes were reserved
        assert_eq!(
            manager.write(owner, "t1", "y").await,
            Err(TerminalWriteError::InputFull)
        );
        let terminals = manager.terminals.read().await;
        assert_eq!(
            terminals["t1"].input_budget.held.load(Ordering::Acquire),
            INPUT_QUEUE_CAPACITY
        );
    }

    #[tokio::test]
    async fn an_exiting_terminal_accepts_and_drops_input() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let fake = insert_fake(&manager, "t1", owner).await;
        drop(fake);
        assert_eq!(manager.write(owner, "t1", "x").await, Ok(()));
    }

    #[tokio::test]
    async fn terminal_ids_are_listed_per_account() {
        let manager = PtyManager::new();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let _b = insert_fake(&manager, "b", owner).await;
        let _a = insert_fake(&manager, "a", owner).await;
        let _c = insert_fake(&manager, "c", other).await;
        assert_eq!(manager.terminal_ids_for_account(owner).await, ["a", "b"]);
        assert_eq!(manager.terminal_ids_for_account(other).await, ["c"]);
        assert!(
            manager
                .terminal_ids_for_account(Uuid::new_v4())
                .await
                .is_empty()
        );
    }
}
