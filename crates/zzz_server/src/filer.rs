use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

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
#[derive(Serialize)]
struct DiskfileChange {
    #[serde(rename = "type")]
    change_type: String,
    path: String,
}

/// Matches `SerializableDisknode` from `diskfile_types.ts`.
///
/// Simplified — `dependents` and `dependencies` are always empty (no
/// dependency tracking in the Rust backend).
#[derive(Serialize)]
struct SerializableDisknode {
    id: String,
    source_dir: String,
    contents: Option<String>,
    ctime: Option<f64>,
    mtime: Option<f64>,
    dependents: Vec<Value>,
    dependencies: Vec<Value>,
}

// -- Ignored paths ------------------------------------------------------------

/// Directories to skip when watching — avoids inotify watch exhaustion
/// and noisy events from generated/vendored content.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".svelte-kit",
    "target",
    "dist",
    ".zzz",
];

/// Check if a path contains any ignored directory component.
fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_str().unwrap_or("");
        IGNORED_DIRS.contains(&s)
    })
}

// -- File metadata helpers ----------------------------------------------------

/// Read metadata for a file/directory. Returns `None` if the path doesn't
/// exist (e.g. on delete events).
fn read_metadata(path: &Path) -> (Option<f64>, Option<f64>) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (None, None);
    };

    let ctime = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0); // ms since epoch (matching JS Date)

    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0);

    (ctime, mtime)
}

/// Try to read file contents as UTF-8. Returns `None` for directories,
/// binary files, or read errors.
fn read_contents(path: &Path) -> Option<String> {
    if path.is_dir() {
        return None;
    }
    std::fs::read_to_string(path).ok()
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

/// Build a `filer_change` notification JSON string from a notify event.
fn build_filer_change_notification(
    change_type: &str,
    file_path: &Path,
    source_dir: &str,
) -> String {
    let path_str = file_path.to_string_lossy().to_string();

    let (ctime, mtime) = if change_type == "delete" {
        (None, None)
    } else {
        read_metadata(file_path)
    };

    let contents = if change_type == "delete" {
        None
    } else {
        read_contents(file_path)
    };

    let params = FilerChangeParams {
        change: DiskfileChange {
            change_type: change_type.to_owned(),
            path: path_str.clone(),
        },
        disknode: SerializableDisknode {
            id: path_str,
            source_dir: source_dir.to_owned(),
            contents,
            ctime,
            mtime,
            dependents: vec![],
            dependencies: vec![],
        },
    };

    rpc::notification(
        "filer_change",
        serde_json::to_value(&params).unwrap_or_default(),
    )
}

// -- Workspace watcher --------------------------------------------------------

/// Watches a workspace directory for file changes and broadcasts
/// `filer_change` notifications to all connected WebSocket clients.
///
/// The watcher is stopped when dropped (notify cleans up on Drop,
/// the tokio task is aborted).
pub struct WorkspaceWatcher {
    /// Held to keep the watcher alive — dropped when the workspace closes.
    _watcher: RecommendedWatcher,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Start watching a workspace directory for file changes.
///
/// Spawns a background tokio task that receives events from the notify
/// watcher and broadcasts `filer_change` notifications via `app.broadcast()`.
///
/// Skips events in ignored directories (`.git`, `node_modules`, etc.).
pub fn start_watching(
    path: &str,
    app: Arc<App>,
) -> Result<WorkspaceWatcher, notify::Error> {
    let (tx, mut rx) = mpsc::channel::<notify::Event>(256);

    let config = Config::default()
        .with_poll_interval(Duration::from_secs(2));

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Non-blocking send — drop events if the channel is full
                let _ = tx.try_send(event);
            }
        },
        config,
    )?;

    watcher.watch(Path::new(path), RecursiveMode::Recursive)?;

    let source_dir = path.to_owned();
    let task = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let Some(change_type) = event_kind_to_change_type(event.kind) else {
                continue;
            };

            for file_path in &event.paths {
                if is_ignored(file_path) {
                    continue;
                }

                let notification =
                    build_filer_change_notification(change_type, file_path, &source_dir);
                app.broadcast(&notification);
            }
        }
    });

    Ok(WorkspaceWatcher {
        _watcher: watcher,
        task,
    })
}
