use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, RwLock};
use tokio::time::Instant;

use crate::handlers::App;
use crate::rpc;

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
const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".svelte-kit",
    "target",
    "dist",
];

/// Check if a path contains any of the given ignored directory components.
fn is_ignored(path: &Path, extra_ignores: &[String]) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_str().unwrap_or("");
        DEFAULT_IGNORED_DIRS.contains(&s) || extra_ignores.iter().any(|ig| ig == s)
    })
}

// -- File metadata helpers (async, non-blocking) ------------------------------

/// Read metadata for a file/directory on a blocking thread.
/// Returns `(None, None)` if the path doesn't exist (e.g. on delete events).
async fn read_metadata(path: PathBuf) -> (Option<f64>, Option<f64>) {
    tokio::task::spawn_blocking(move || {
        let Ok(meta) = std::fs::metadata(&path) else {
            return (None, None);
        };

        let ctime = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0);

        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0);

        (ctime, mtime)
    })
    .await
    .unwrap_or((None, None))
}

/// Try to read file contents as UTF-8 on a blocking thread.
/// Returns `None` for directories, binary files, or read errors.
async fn read_contents(path: PathBuf) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        if path.is_dir() {
            return None;
        }
        std::fs::read_to_string(&path).ok()
    })
    .await
    .unwrap_or(None)
}

/// Build a `SerializableDisknode` for a file, reading metadata and contents
/// on blocking threads.
async fn build_disknode(file_path: &Path, source_dir: &str, is_delete: bool) -> SerializableDisknode {
    let path_str = file_path.to_string_lossy().to_string();

    let (ctime, mtime, contents) = if is_delete {
        (None, None, None)
    } else {
        let meta_path = file_path.to_path_buf();
        let content_path = file_path.to_path_buf();
        let (meta, contents) = tokio::join!(
            read_metadata(meta_path),
            read_contents(content_path),
        );
        (meta.0, meta.1, contents)
    };

    SerializableDisknode {
        id: path_str,
        source_dir: source_dir.to_owned(),
        contents,
        ctime,
        mtime,
        dependents: vec![],
        dependencies: vec![],
    }
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

/// A pending debounced event.
struct PendingEvent {
    change_type: &'static str,
    deadline: Instant,
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
    scan_directory(&source_dir, &source_dir, &config.extra_ignores, &mut initial_files).await;
    {
        let mut index = files.write().await;
        *index = initial_files;
    }

    let files_clone = Arc::clone(&files);
    let task = tokio::spawn(filer_event_loop(
        rx,
        source_dir.clone(),
        config.extra_ignores,
        files_clone,
        app,
    ));

    Ok(Filer {
        _watcher: watcher,
        task,
        files,
    })
}

/// Recursively scan a directory and populate the file map.
async fn scan_directory(
    dir: &str,
    source_dir: &str,
    extra_ignores: &[String],
    files: &mut HashMap<String, SerializableDisknode>,
) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();

        // Skip ignored directories
        if let Some(name) = path.file_name().and_then(|n| n.to_str())
            && (DEFAULT_IGNORED_DIRS.contains(&name) || extra_ignores.iter().any(|ig| ig == name))
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
            Box::pin(scan_directory(&dir_path, source_dir, extra_ignores, files)).await;
        } else {
            let path_str = path.to_string_lossy().into_owned();

            let ctime = meta
                .created()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0);
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0);

            let contents = tokio::fs::read_to_string(&path).await.ok();

            files.insert(
                path_str.clone(),
                SerializableDisknode {
                    id: path_str,
                    source_dir: source_dir.to_owned(),
                    contents,
                    ctime,
                    mtime,
                    dependents: vec![],
                    dependencies: vec![],
                },
            );
        }
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
    let mut pending: HashMap<PathBuf, PendingEvent> = HashMap::new();

    loop {
        // If we have pending events, wait until the nearest deadline or a new event
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
                    if is_ignored(&file_path, &extra_ignores) {
                        continue;
                    }
                    let deadline = Instant::now() + DEBOUNCE_DURATION;
                    pending
                        .entry(file_path)
                        .and_modify(|p| {
                            // Extend the deadline but preserve "add" — a Create
                            // followed by Modify should still be seen as "add"
                            // by clients (the file is new).
                            p.deadline = deadline;
                            if p.change_type != "add" {
                                p.change_type = change_type;
                            }
                        })
                        .or_insert(PendingEvent {
                            change_type,
                            deadline,
                        });
                }
            }
            None => {
                // Channel closed or timeout fired — flush ready events
                if pending.is_empty() {
                    // Channel truly closed (no pending, no new events)
                    break;
                }
            }
        }

        // Flush events whose deadline has passed
        let now = Instant::now();
        let ready: Vec<(PathBuf, PendingEvent)> = pending
            .extract_if(|_, p| p.deadline <= now)
            .collect();

        for (file_path, event) in ready {
            let is_delete = event.change_type == "delete";

            // Skip directory events — we only index files. On delete we can't
            // stat so we check if the path was in the index (only files are indexed).
            if !is_delete
                && let Ok(meta) = tokio::fs::metadata(&file_path).await
                && meta.is_dir()
            {
                continue;
            }

            let disknode = build_disknode(&file_path, &source_dir, is_delete).await;

            // Update the file index
            {
                let mut index = files.write().await;
                if is_delete {
                    index.remove(&disknode.id);
                } else {
                    index.insert(disknode.id.clone(), disknode.clone());
                }
            }

            // Build and broadcast the notification
            let params = FilerChangeParams {
                change: DiskfileChange {
                    change_type: event.change_type.to_owned(),
                    path: disknode.id.clone(),
                },
                disknode,
            };

            let notification = rpc::notification(
                "filer_change",
                serde_json::to_value(&params).unwrap_or_default(),
            );
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

    /// Collect all files from all filers into a single Vec.
    /// Used by `session_load` to return the complete file listing.
    pub async fn collect_all_files(&self) -> Vec<SerializableDisknode> {
        // Collect Arc handles under the outer lock, then release it before
        // awaiting the inner per-filer locks — avoids holding the manager
        // lock across await points (which would block start_filer/stop_filer).
        let file_maps: Vec<Arc<RwLock<HashMap<String, SerializableDisknode>>>> = {
            let filers = self.filers.read().await;
            filers.values().map(|e| Arc::clone(&e.filer.files)).collect()
        };

        let mut all_files = Vec::new();
        for files in &file_maps {
            let index = files.read().await;
            all_files.extend(index.values().cloned());
        }
        all_files
    }
}
