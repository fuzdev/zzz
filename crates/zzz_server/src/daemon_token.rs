use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngExt;
use tokio::sync::RwLock;

// -- Daemon token state -------------------------------------------------------

/// In-memory daemon token state for `X-Daemon-Token` authentication.
///
/// Mirrors `fuz_app`'s `DaemonTokenState`:
/// - `current_token`: 43-char base64url string (32 random bytes)
/// - `previous_token`: prior token, valid during rotation race window
/// - `keeper_account_id`: resolved after bootstrap
///
/// Protected by `tokio::sync::RwLock` — async reads during validation,
/// write lock only during rotation.
#[derive(Debug)]
pub struct DaemonTokenState {
    pub current_token: String,
    pub previous_token: Option<String>,
    pub keeper_account_id: Option<uuid::Uuid>,
    pub token_path: PathBuf,
}

/// Shared handle to daemon token state.
pub type SharedDaemonTokenState = Arc<RwLock<DaemonTokenState>>;

// -- Token generation ---------------------------------------------------------

/// Generate a daemon token: 32 random bytes → base64url (43 chars).
///
/// Matches `fuz_app`'s `generate_daemon_token` / `generate_random_base64url`.
pub fn generate_daemon_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

// -- Token validation ---------------------------------------------------------

/// Validate a provided token against the current and previous tokens.
///
/// Uses constant-time comparison to prevent timing attacks.
/// Accepts both current and previous token (rotation race window).
///
/// Mirrors `fuz_app`'s `validate_daemon_token`.
pub fn validate_daemon_token(provided: &str, state: &DaemonTokenState) -> bool {
    if timing_safe_eq(provided.as_bytes(), state.current_token.as_bytes()) {
        return true;
    }
    if let Some(ref previous) = state.previous_token
        && timing_safe_eq(provided.as_bytes(), previous.as_bytes())
    {
        return true;
    }
    false
}

/// Timing-safe byte comparison.
///
/// Returns `false` immediately if lengths differ (length is not secret
/// for daemon tokens — they're always 43 chars). Content comparison
/// is constant-time via XOR accumulation.
fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// -- Token file I/O -----------------------------------------------------------

/// Write the daemon token to disk atomically (tempfile + rename).
///
/// Mirrors `fuz_app`'s `write_daemon_token` with atomic write pattern.
/// File contains the token followed by a newline.
pub async fn write_token_file(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "token path has no parent dir")
    })?;

    // Ensure parent directory exists
    tokio::fs::create_dir_all(parent).await?;

    // Atomic write: write to temp file, then rename
    let tmp_path = path.with_extension("tmp");
    tokio::fs::write(&tmp_path, format!("{token}\n")).await?;
    tokio::fs::rename(&tmp_path, path).await?;

    // Best-effort chmod 0o600 (owner read-write only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
    }

    Ok(())
}

// -- Token rotation -----------------------------------------------------------

/// Rotation interval in milliseconds (30 seconds, matching `fuz_app`).
const ROTATION_INTERVAL_MS: u64 = 30_000;

/// Spawn a background task that rotates the daemon token every 30 seconds.
///
/// Rotation: `previous_token = current_token`, `current_token = new_token`,
/// then write to disk atomically.
///
/// Returns a `tokio::task::JoinHandle` — caller should abort on shutdown.
pub fn spawn_rotation_task(
    state: SharedDaemonTokenState,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(ROTATION_INTERVAL_MS));
        // First tick fires immediately — skip it (token was just written at startup)
        interval.tick().await;

        loop {
            interval.tick().await;

            let new_token = generate_daemon_token();
            let path = {
                let mut state = state.write().await;
                state.previous_token = Some(state.current_token.clone());
                state.current_token.clone_from(&new_token);
                state.token_path.clone()
            };

            if let Err(e) = write_token_file(&path, &new_token).await {
                tracing::error!(error = %e, "failed to write rotated daemon token");
            } else {
                tracing::debug!("daemon token rotated");
            }
        }
    })
}

// -- Init ---------------------------------------------------------------------

/// Initialize daemon token state: generate token, write to disk, return state.
///
/// Called from `main.rs` during server startup.
pub async fn init_daemon_token(
    zzz_dir: &str,
) -> Result<SharedDaemonTokenState, std::io::Error> {
    let token_path = PathBuf::from(zzz_dir).join("run").join("daemon_token");
    let token = generate_daemon_token();

    write_token_file(&token_path, &token).await?;
    tracing::info!(path = %token_path.display(), "daemon token initialized");

    let state = DaemonTokenState {
        current_token: token,
        previous_token: None,
        keeper_account_id: None,
        token_path,
    };

    Ok(Arc::new(RwLock::new(state)))
}
