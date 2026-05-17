use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Stream, StreamExt, stream};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{RwLock, mpsc};
use tokio::time::Instant;

use crate::handlers::App;
use crate::rpc;

// -- Indexing limits ----------------------------------------------------------

/// Max bytes of file content held in the in-memory index. Anything above
/// this skips `read_to_string` and stores `contents: None`. Protects RSS
/// against lockfiles, generated artifacts, or large binaries that the
/// watcher otherwise would happily pull into memory.
///
/// TODO @parity: align with `fuz_app`'s equivalent cap when it lands.
const MAX_INDEXED_FILE_SIZE: u64 = 4 * 1024 * 1024;

/// Cap on concurrent `read_to_string` calls during a directory scan.
/// File reads block on disk + utf-8 validation; without a cap a large
/// tree would unbound the in-flight set and exhaust fd budgets on small
/// workstations.
const MAX_CONCURRENT_FILE_READS: usize = 32;

// -- Notification params ------------------------------------------------------

/// Params for `filer_change` `remote_notification`.
///
/// Matches the TypeScript `filer_change_action_spec` input schema:
/// `{ change: DiskfileChange, disknode: SerializableDisknode }`.
#[derive(Serialize)]
struct FilerChangeParams {
    change: DiskfileChange,
    disknode: SerializableDisknode,
}

/// Matches `DiskfileChange` from `diskfile_types.ts`.
#[derive(Serialize, Clone)]
struct DiskfileChange {
    #[serde(rename = "type")]
    change_type: String,
    path: String,
}

/// Matches `SerializableDisknode` from `diskfile_types.ts`.
///
/// Simplified — `dependents` and `dependencies` are always empty (no
/// dependency tracking in the Rust backend).
#[derive(Serialize, Clone)]
pub struct SerializableDisknode {
    pub id: String,
    pub source_dir: String,
    pub contents: Option<String>,
    pub ctime: Option<f64>,
    pub mtime: Option<f64>,
    pub dependents: Vec<Value>,
    pub dependencies: Vec<Value>,
}

// -- Default ignored directories ----------------------------------------------

/// Directories always ignored by all watchers. Individual filers
/// can add extra ignores on top of these via `FilerConfig`.
const DEFAULT_IGNORED_DIRS: &[&str] = &[".git", "node_modules", ".svelte-kit", "target", "dist"];

/// Check if a single directory name is in the ignore lists.
fn is_ignored_name(name: &str, extra_ignores: &[String]) -> bool {
    DEFAULT_IGNORED_DIRS.contains(&name) || extra_ignores.iter().any(|ig| ig == name)
}

/// Check if a path contains any ignored directory component below `source_dir`.
///
/// Only checks components after the `source_dir` prefix — root path segments
/// like `/`, `home`, `user` can never match ignored names and are skipped.
fn is_ignored(path: &Path, source_dir: &Path, extra_ignores: &[String]) -> bool {
    let suffix = path.strip_prefix(source_dir).unwrap_or(path);
    suffix.components().any(|c| {
        let s = c.as_os_str().to_str().unwrap_or("");
        is_ignored_name(s, extra_ignores)
    })
}

// -- File metadata helpers ----------------------------------------------------

/// Convert a `SystemTime` to milliseconds since epoch (matching JS `Date` format).
fn system_time_to_ms(t: std::time::SystemTime) -> Option<f64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64() * 1000.0)
}

/// Construct a `SerializableDisknode` from pre-read components.
fn make_disknode(
    id: String,
    source_dir: &str,
    contents: Option<String>,
    ctime: Option<f64>,
    mtime: Option<f64>,
) -> SerializableDisknode {
    SerializableDisknode {
        id,
        source_dir: source_dir.to_owned(),
        contents,
        ctime,
        mtime,
        dependents: vec![],
        dependencies: vec![],
    }
}

/// Build a `SerializableDisknode` for a watcher event, reading metadata and
/// contents on blocking threads (never blocks the tokio runtime).
///
/// Honours [`MAX_INDEXED_FILE_SIZE`]: oversized files keep their metadata
/// but store `contents: None`, matching the size-cap behavior of the
/// initial scan path.
async fn build_disknode(
    file_path: &Path,
    source_dir: &str,
    is_delete: bool,
) -> SerializableDisknode {
    let path_str = file_path.to_string_lossy().to_string();

    if is_delete {
        return make_disknode(path_str, source_dir, None, None, None);
    }

    let path_owned = file_path.to_path_buf();
    // Read metadata first so we can short-circuit oversized files instead
    // of pulling them through `read_to_string`.
    let meta = tokio::task::spawn_blocking({
        let p = path_owned.clone();
        move || std::fs::metadata(&p).ok()
    })
    .await
    .ok()
    .flatten();

    let ctime = meta
        .as_ref()
        .and_then(|m| m.created().ok())
        .and_then(system_time_to_ms);
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(system_time_to_ms);
    let is_dir = meta.as_ref().is_some_and(std::fs::Metadata::is_dir);
    let size = meta.as_ref().map_or(0, std::fs::Metadata::len);

    let contents = if is_dir || size > MAX_INDEXED_FILE_SIZE {
        None
    } else {
        tokio::task::spawn_blocking(move || std::fs::read_to_string(&path_owned).ok())
            .await
            .ok()
            .flatten()
    };

    make_disknode(path_str, source_dir, contents, ctime, mtime)
}

// -- Event → notification mapping ---------------------------------------------

/// Map a notify `EventKind` to a `DiskfileChangeType` string.
///
/// Returns `None` for events we don't care about (access, other).
const fn event_kind_to_change_type(kind: EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("add"),
        EventKind::Modify(_) => Some("change"),
        EventKind::Remove(_) => Some("delete"),
        _ => None,
    }
}

// -- Debouncing ---------------------------------------------------------------

/// Window for coalescing rapid events on the same path.
const DEBOUNCE_DURATION: Duration = Duration::from_millis(80);

/// A pending debounced notification (broadcast only — index updates are immediate).
struct PendingNotification {
    change_type: &'static str,
    deadline: Instant,
    disknode: SerializableDisknode,
}

// -- Filer configuration ------------------------------------------------------

/// Per-filer configuration controlling which directories to ignore.
pub struct FilerConfig {
    /// Extra directory names to ignore beyond the defaults.
    /// For workspace watchers this includes `.zzz`; for the `zzz_dir`
    /// watcher this is empty so it can see its own files.
    pub extra_ignores: Vec<String>,
}

impl FilerConfig {
    /// Config for the `zzz_dir` watcher — no extra ignores, since it needs
    /// to see files inside the zzz directory.
    pub const fn zzz_dir() -> Self {
        Self {
            extra_ignores: vec![],
        }
    }

    /// Config for workspace and `scoped_dir` watchers — ignores the zzz
    /// directory name to avoid duplicate events when `zzz_dir` is nested
    /// under a watched directory.
    ///
    /// Derives the ignore name from the actual `zzz_dir` path (e.g. `.zzz`
    /// from `/home/user/.zzz/`) so it works with custom `PUBLIC_ZZZ_DIR`.
    pub fn workspace(zzz_dir: &str) -> Self {
        let zzz_dir_name = Path::new(zzz_dir.trim_end_matches('/'))
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(".zzz")
            .to_owned();
        Self {
            extra_ignores: vec![zzz_dir_name],
        }
    }
}

// -- Filer (replaces WorkspaceWatcher) ----------------------------------------

/// Watches a directory for file changes, maintains an in-memory file index,
/// and broadcasts `filer_change` notifications to WebSocket clients.
///
/// Dropped when the filer is stopped (notify cleans up on Drop,
/// the tokio task is aborted).
pub struct Filer {
    /// Held to keep the notify watcher alive — dropped when the filer stops.
    _watcher: RecommendedWatcher,
    /// Background task processing watcher events.
    task: tokio::task::JoinHandle<()>,
    /// In-memory file index — path → disknode. Updated by watcher events
    /// and initial scan. Read by `session_load`.
    pub files: Arc<RwLock<HashMap<String, SerializableDisknode>>>,
    /// Watched directory path — retained so `rescan` can re-walk the tree.
    source_dir: String,
    /// Ignored directory names — retained for `rescan`.
    extra_ignores: Vec<String>,
}

impl Drop for Filer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Start watching a directory, perform an initial file scan, and return a `Filer`.
///
/// The initial scan populates the file index before returning, so callers
/// can immediately read from `filer.files`. The background task then
/// keeps the index updated and broadcasts changes.
pub async fn start_filer(
    path: &str,
    app: Arc<App>,
    config: FilerConfig,
) -> Result<Filer, notify::Error> {
    let (tx, rx) = mpsc::channel::<notify::Event>(256);

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.try_send(event);
            }
        },
        notify::Config::default(),
    )?;

    watcher.watch(Path::new(path), RecursiveMode::Recursive)?;

    let source_dir = path.to_owned();
    let files: Arc<RwLock<HashMap<String, SerializableDisknode>>> =
        Arc::new(RwLock::new(HashMap::new()));

    // Initial scan — populate the file index
    let mut initial_files = HashMap::new();
    scan_directory(
        &source_dir,
        &source_dir,
        &config.extra_ignores,
        &mut initial_files,
    )
    .await;
    {
        let mut index = files.write().await;
        *index = initial_files;
    }

    let files_clone = Arc::clone(&files);
    let extra_ignores = config.extra_ignores;
    let task = tokio::spawn(filer_event_loop(
        rx,
        source_dir.clone(),
        extra_ignores.clone(),
        files_clone,
        app,
    ));

    Ok(Filer {
        _watcher: watcher,
        task,
        files,
        source_dir,
        extra_ignores,
    })
}

/// One file discovered by the walk phase — input to the read phase.
struct FileJob {
    path: PathBuf,
    path_str: String,
    ctime: Option<f64>,
    mtime: Option<f64>,
    size: u64,
}

/// In-progress directory walk state for [`walk_files`].
///
/// `current` holds the open readdir handle for the directory currently
/// being drained; `dir_stack` holds the not-yet-visited directories.
/// Subdirectories discovered while draining `current` are pushed onto
/// the stack so traversal stays depth-first (matches the previous
/// `Box::pin` recursion order — important for deterministic file
/// ordering on the cold-start path).
struct WalkState {
    dir_stack: Vec<String>,
    current: Option<tokio::fs::ReadDir>,
    extra_ignores: Vec<String>,
}

/// Stream of file jobs discovered by walking `root` recursively.
///
/// Streaming (vs. pre-collecting into `Vec<FileJob>`) keeps peak memory
/// flat in tree size: only the active readdir handle + dir-stack +
/// in-flight `buffer_unordered` futures are resident at any moment.
/// For a 100k-file tree the pre-collected list was ~10 MB of `FileJob`s
/// resident before any read fired; this version caps at
/// `MAX_CONCURRENT_FILE_READS` (32) in-flight jobs.
///
/// Implementation uses `stream::unfold` rather than spawning a producer
/// task — no `mpsc` channel, no extra `tokio::spawn`, and the walker
/// runs on the same task as the consumer so cancellation propagates
/// naturally when the consumer drops the stream.
fn walk_files(root: String, extra_ignores: Vec<String>) -> impl Stream<Item = FileJob> {
    let state = WalkState {
        dir_stack: vec![root],
        current: None,
        extra_ignores,
    };
    stream::unfold(state, |mut state| async move {
        loop {
            // Ensure a current readdir handle. Pop dirs off the stack
            // until one opens successfully or the stack is empty.
            while state.current.is_none() {
                let Some(dir) = state.dir_stack.pop() else {
                    return None;
                };
                state.current = tokio::fs::read_dir(&dir).await.ok();
            }

            // Pull the next entry. Scope the &mut borrow so we can
            // mutate `state.dir_stack` on the dir-discovery branch.
            let entry_result = match state.current.as_mut() {
                Some(entries) => entries.next_entry().await,
                None => continue,
            };

            match entry_result {
                Ok(Some(entry)) => {
                    let path = entry.path();
                    if let Some(name) = path.file_name().and_then(|n| n.to_str())
                        && is_ignored_name(name, &state.extra_ignores)
                    {
                        continue;
                    }
                    let Ok(meta) = tokio::fs::metadata(&path).await else {
                        continue;
                    };
                    if meta.is_dir() {
                        let mut dir_path = path.to_string_lossy().into_owned();
                        if !dir_path.ends_with('/') {
                            dir_path.push('/');
                        }
                        state.dir_stack.push(dir_path);
                        continue;
                    }
                    let path_str = path.to_string_lossy().into_owned();
                    let ctime = meta.created().ok().and_then(system_time_to_ms);
                    let mtime = meta.modified().ok().and_then(system_time_to_ms);
                    let job = FileJob {
                        path,
                        path_str,
                        ctime,
                        mtime,
                        size: meta.len(),
                    };
                    return Some((job, state));
                }
                Ok(None) => {
                    // Directory exhausted — drop handle, pop next on
                    // the outer loop iteration.
                    state.current = None;
                }
                Err(_) => {
                    // Per-entry read failure (e.g. permission denied on
                    // a single dirent); skip and keep draining.
                }
            }
        }
    })
}

/// Recursively scan a directory and populate the file map.
///
/// Walks the tree and reads files concurrently in a single pipeline:
/// [`walk_files`] streams `FileJob`s as directories are discovered, and
/// `buffer_unordered` fans out up to [`MAX_CONCURRENT_FILE_READS`]
/// `read_to_string` calls at a time. Files over
/// [`MAX_INDEXED_FILE_SIZE`] skip the read and store `contents: None`.
///
/// Streaming the walker (vs. pre-collecting into a `Vec<FileJob>`)
/// keeps peak memory flat in tree size — the reader starts firing
/// while the walker is still discovering files, instead of waiting
/// for the entire tree to be enumerated. Matters on the hot path:
/// `FilerManager::rescan_all` runs on every `session_load`.
///
/// Called by `start_filer` (cold path) and `FilerManager::rescan_all`
/// (hot path).
async fn scan_directory(
    dir: &str,
    source_dir: &str,
    extra_ignores: &[String],
    files: &mut HashMap<String, SerializableDisknode>,
) {
    let source_dir_owned = source_dir.to_owned();
    let walker = walk_files(dir.to_owned(), extra_ignores.to_owned());
    let stream = walker
        .map(|job| {
            let source_dir = source_dir_owned.clone();
            async move {
                let contents = if job.size > MAX_INDEXED_FILE_SIZE {
                    None
                } else {
                    tokio::fs::read_to_string(&job.path).await.ok()
                };
                let disknode = make_disknode(
                    job.path_str.clone(),
                    &source_dir,
                    contents,
                    job.ctime,
                    job.mtime,
                );
                (job.path_str, disknode)
            }
        })
        .buffer_unordered(MAX_CONCURRENT_FILE_READS);
    // `stream::unfold`'s state future is `!Unpin`, so the composed
    // stream needs pinning before `.next()`. `std::pin::pin!` puts it
    // on the local stack — no heap allocation.
    let mut stream = std::pin::pin!(stream);

    while let Some((path_str, disknode)) = stream.next().await {
        files.insert(path_str, disknode);
    }
}

/// Background event loop: receives notify events, debounces them, updates
/// the file index, and broadcasts `filer_change` notifications.
async fn filer_event_loop(
    mut rx: mpsc::Receiver<notify::Event>,
    source_dir: String,
    extra_ignores: Vec<String>,
    files: Arc<RwLock<HashMap<String, SerializableDisknode>>>,
    app: Arc<App>,
) {
    let source_dir_path = Path::new(&source_dir);
    // Pending notifications — index updates happen immediately, but
    // filer_change broadcasts are debounced to avoid flooding clients.
    let mut pending: HashMap<PathBuf, PendingNotification> = HashMap::new();

    loop {
        // If we have pending notifications, wait until the nearest deadline or a new event
        let timeout = pending
            .values()
            .map(|p| p.deadline)
            .min()
            .map(|deadline| deadline.saturating_duration_since(Instant::now()));

        let event = if let Some(timeout) = timeout {
            tokio::select! {
                biased;
                e = rx.recv() => e,
                () = tokio::time::sleep(timeout) => None,
            }
        } else {
            rx.recv().await
        };

        match event {
            Some(event) => {
                let Some(change_type) = event_kind_to_change_type(event.kind) else {
                    continue;
                };

                for file_path in event.paths {
                    if is_ignored(&file_path, source_dir_path, &extra_ignores) {
                        continue;
                    }

                    let is_delete = change_type == "delete";

                    // Skip directory events — we only index files.
                    if !is_delete
                        && let Ok(meta) = tokio::fs::metadata(&file_path).await
                        && meta.is_dir()
                    {
                        continue;
                    }

                    let disknode = build_disknode(&file_path, &source_dir, is_delete).await;

                    // Update the file index immediately so reads always
                    // see the latest state (no debounce on the index).
                    {
                        let mut index = files.write().await;
                        if is_delete {
                            index.remove(&disknode.id);
                        } else {
                            index.insert(disknode.id.clone(), disknode.clone());
                        }
                    }

                    // Debounce the notification broadcast
                    let deadline = Instant::now() + DEBOUNCE_DURATION;
                    pending
                        .entry(file_path)
                        .and_modify(|p| {
                            // Extend the deadline but preserve "add" — a Create
                            // followed by Modify should still be seen as "add"
                            // by clients (the file is new).
                            p.deadline = deadline;
                            p.disknode = disknode.clone();
                            if p.change_type != "add" {
                                p.change_type = change_type;
                            }
                        })
                        .or_insert(PendingNotification {
                            change_type,
                            deadline,
                            disknode,
                        });
                }
            }
            None => {
                // Channel closed or timeout fired — flush ready notifications
                if pending.is_empty() {
                    // Channel truly closed (no pending, no new events)
                    break;
                }
            }
        }

        // Flush notifications whose deadline has passed
        let now = Instant::now();
        let ready: Vec<(PathBuf, PendingNotification)> =
            pending.extract_if(|_, p| p.deadline <= now).collect();

        for (_, event) in ready {
            let params = FilerChangeParams {
                change: DiskfileChange {
                    change_type: event.change_type.to_owned(),
                    path: event.disknode.id.clone(),
                },
                disknode: event.disknode,
            };
            let notification = rpc::notification("filer_change", &params);
            app.broadcast(&notification);
        }
    }
}

// -- FilerManager -------------------------------------------------------------

/// Whether a filer was started at server startup (permanent) or via
/// `workspace_open` (can be stopped on `workspace_close`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FilerLifetime {
    /// Started at server startup for `zzz_dir` or `scoped_dirs` — never stopped.
    Permanent,
    /// Started via `workspace_open` — stopped on `workspace_close`.
    Workspace,
}

/// Entry in the filer manager.
pub struct FilerEntry {
    pub filer: Filer,
    pub lifetime: FilerLifetime,
}

/// Manages all active filers with deduplication and lifetime tracking.
///
/// One filer per unique directory path. Permanent filers (`zzz_dir`, `scoped_dirs`)
/// survive `workspace_close`. Workspace filers are stopped on close.
pub struct FilerManager {
    filers: RwLock<HashMap<String, FilerEntry>>,
}

impl FilerManager {
    pub fn new() -> Self {
        Self {
            filers: RwLock::new(HashMap::new()),
        }
    }

    /// Start a filer for the given directory path. Returns `Ok(true)` if a new
    /// filer was created, `Ok(false)` if one already existed for this path.
    ///
    /// If a filer already exists, its lifetime is upgraded to `Permanent` if
    /// the new request is `Permanent` (but never downgraded).
    pub async fn start_filer(
        &self,
        path: &str,
        app: Arc<App>,
        config: FilerConfig,
        lifetime: FilerLifetime,
    ) -> Result<bool, notify::Error> {
        debug_assert!(
            path.ends_with('/'),
            "FilerManager paths must have trailing slash: {path}"
        );

        // Fast path — already watching
        {
            let filers = self.filers.read().await;
            if let Some(entry) = filers.get(path) {
                // Upgrade lifetime if needed (workspace → permanent)
                if lifetime == FilerLifetime::Permanent
                    && entry.lifetime == FilerLifetime::Workspace
                {
                    drop(filers);
                    let mut filers = self.filers.write().await;
                    if let Some(entry) = filers.get_mut(path) {
                        entry.lifetime = FilerLifetime::Permanent;
                    }
                }
                return Ok(false);
            }
        }

        // Create new filer
        let filer = start_filer(path, app, config).await?;

        let mut filers = self.filers.write().await;
        // Double-check in case another task raced us
        if filers.contains_key(path) {
            // Filer was created by another task between our read and write
            return Ok(false);
        }
        filers.insert(path.to_owned(), FilerEntry { filer, lifetime });
        Ok(true)
    }

    /// Stop and remove a filer for the given path. Only stops workspace-scoped
    /// filers — permanent filers are preserved.
    ///
    /// Returns `true` if the filer was actually stopped.
    pub async fn stop_filer(&self, path: &str) -> bool {
        debug_assert!(
            path.ends_with('/'),
            "FilerManager paths must have trailing slash: {path}"
        );
        let mut filers = self.filers.write().await;
        if let Some(entry) = filers.get(path) {
            if entry.lifetime == FilerLifetime::Permanent {
                return false;
            }
            filers.remove(path);
            true
        } else {
            false
        }
    }

    /// Rescan every active filer's watched directory and replace its index.
    ///
    /// Called by `session_load` before `collect_all_files` to guarantee a
    /// consistent snapshot — notify events are eventually consistent, so a
    /// just-written file may not yet be in the index when the event loop is
    /// still draining. A direct filesystem walk sidesteps that race.
    pub async fn rescan_all(&self) {
        // Snapshot what we need under the outer lock, then rescan without
        // holding it — the outer lock blocks start_filer/stop_filer.
        type FilerRescanEntry = (
            String,
            Vec<String>,
            Arc<RwLock<HashMap<String, SerializableDisknode>>>,
        );
        let entries: Vec<FilerRescanEntry> = {
            let filers = self.filers.read().await;
            filers
                .values()
                .map(|e| {
                    (
                        e.filer.source_dir.clone(),
                        e.filer.extra_ignores.clone(),
                        Arc::clone(&e.filer.files),
                    )
                })
                .collect()
        };
        for (source_dir, extra_ignores, files) in entries {
            let mut fresh = HashMap::new();
            scan_directory(&source_dir, &source_dir, &extra_ignores, &mut fresh).await;
            let mut index = files.write().await;
            *index = fresh;
        }
    }

    /// Collect all files from all filers into a single Vec.
    /// Used by `session_load` to return the complete file listing.
    pub async fn collect_all_files(&self) -> Vec<SerializableDisknode> {
        // Collect Arc handles under the outer lock, then release it before
        // awaiting the inner per-filer locks — avoids holding the manager
        // lock across await points (which would block start_filer/stop_filer).
        let file_maps: Vec<Arc<RwLock<HashMap<String, SerializableDisknode>>>> = {
            let filers = self.filers.read().await;
            filers
                .values()
                .map(|e| Arc::clone(&e.filer.files))
                .collect()
        };

        let mut all_files = Vec::new();
        for files in &file_maps {
            let index = files.read().await;
            all_files.extend(index.values().cloned());
        }
        all_files
    }
}
