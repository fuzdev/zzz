//! Long-lived `App` server state, the per-domain RPC handlers, and the
//! `App.broadcast` connection shim.
//!
//! The per-domain handler modules (`core`, `filesystem`, `job`, `media`,
//! `provider`, `terminal`, `project`) hold the zzz-specific RPC handlers in the spine
//! signature `(params: Value, ctx: ActionContext<'_>, app: Arc<App>) ->
//! Result<Value, JsonrpcError>`. They are registered into
//! `App.action_registry` via `crate::zzz_action_specs::build_*_specs`, which
//! own the `Arc<App>` and clone it into each per-spec handler closure — the
//! source of the zzz-specific deps (`PtyManager`, `FilerManager`,
//! `ProviderManager`, `ProjectManager`) that don't live on `ActionContext`.
//!
//! Auth, dispatch, and the JSON-RPC / WS routes come from the spine
//! (`fuz_actions::perform_action` plus the route states built in `main.rs`).
//! `App.realtime` is the sole connection-tracking surface; it drives the
//! `broadcast` shim called from `filer.rs` and `project_manager.rs`, and
//! `pty_manager.rs`, `job_manager.rs`, and `transcription/` send a terminal's
//! and a job's notifications through it to the owning account only
//! (`send_to_account`).

pub mod core;
pub mod filesystem;
pub mod job;
pub mod media;
pub mod project;
pub mod provider;
pub mod terminal;

use std::sync::Arc;

use deadpool_postgres::Pool;

use crate::file_trust::TrustedOwner;
use crate::filer::FilerManager;
use crate::job_manager::JobManager;
use crate::project_manager::ProjectManager;
use crate::provider::{CompletionOptions, ProviderManager};
use crate::pty_manager::PtyManager;
use crate::root_policy::RootPolicy;
use crate::scoped_fs::ScopedFs;
use crate::tool::Tools;

use fuz_actions::{ActionContext, ActionRegistry};
use fuz_auth::AuditEmitter;
use fuz_http::{JsonrpcError, unauthenticated};
use fuz_realtime::ConnectionRegistry;
use uuid::Uuid;

// -- App state (long-lived, shared via Arc) -----------------------------------

/// Server state shared across all requests.
///
/// Constructed once in `run_app`, wrapped in `Arc`, passed into the spec
/// builders + the spine RPC / WS route states.
pub struct App {
    /// Minted when the app starts — `session_load` returns it as
    /// `server_instance_id`, so a client that sees it change knows the daemon
    /// restarted (its terminals and open projects are gone).
    pub instance_id: Uuid,
    /// The open projects, and the one path that changes them — and with
    /// them the project filers and the runtime `ScopedFs` roots
    /// ([`ProjectManager`]).
    pub projects: ProjectManager,
    /// Whose registry files and directories `project_open` trusts — the
    /// daemon's own user, read once at boot ([`TrustedOwner::current`]).
    pub trusted_owner: TrustedOwner,
    /// The git runner project resolution calls, over the environment a
    /// terminal gets ([`crate::pty_manager::terminal_env`] — `HOME` kept, so
    /// the user's git config applies; zzzd's secrets and config dropped).
    pub git: fuz_git::Git,
    pub db_pool: Pool,
    pub scoped_fs: ScopedFs,
    pub zzz_dir: String,
    pub scoped_dirs: Vec<String>,
    /// Active file watchers — one per unique directory path, with lifetime
    /// tracking.
    pub filer_manager: FilerManager,
    /// PTY terminal manager.
    pub pty_manager: PtyManager,
    /// Long-running tool work (transcriptions), in memory like terminals.
    pub job_manager: JobManager,
    /// AI provider manager (Anthropic, `OpenAI`, Gemini).
    pub provider_manager: ProviderManager,
    /// Completion options for every request — always
    /// `CompletionOptions::default()`, since `completion_create` accepts no
    /// options.
    pub completion_options: CompletionOptions,
    /// Register `_testing_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave false.
    /// Read in `run_app` at registry-compile time to conditionally
    /// extend the spec set via `zzz_action_specs::build_testing_specs`.
    pub enable_test_actions: bool,
    /// `Arc<ConnectionRegistry>` — the spine's connection-tracking
    /// registry. Sole connection store on `App`; drives the `broadcast`
    /// shim below.
    pub realtime: Arc<ConnectionRegistry>,
    /// Compiled spine action registry. Holds the protocol specs +
    /// `auth_adapter::build_auth_spec_set` plus the zzz-specific specs from
    /// `zzz_action_specs::build_*_specs`.
    ///
    /// **Wrapped in `OnceLock`** so it can be set after `Arc<App>` is
    /// constructed — the spec builders close over `Arc<App>`, so the
    /// registry can't be built until the App `Arc` exists.
    pub action_registry: std::sync::OnceLock<Arc<ActionRegistry>>,
    /// The local tools found at boot (`ffmpeg`, whisper.cpp and its model).
    /// [`Self::new`] starts with
    /// none; `run_app` sets them from the config.
    pub tools: Tools,
    /// Which directories `project_open` admits as roots
    /// ([`crate::root_policy`]). [`Self::new`] starts with the default, which
    /// admits nothing; `run_app` sets it from the config.
    pub root_policy: RootPolicy,
    /// The spine audit emitter every audit row goes through — the one
    /// `run_app` hands the route states and the action registry. Held here so
    /// the test binary's specs factory can build `_testing_drain_effects`
    /// over it.
    pub audit_emitter: Arc<AuditEmitter>,
}

impl std::fmt::Debug for App {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("App")
            .field("instance_id", &self.instance_id)
            .field("zzz_dir", &self.zzz_dir)
            .field("scoped_dirs", &self.scoped_dirs)
            .field("enable_test_actions", &self.enable_test_actions)
            .finish_non_exhaustive()
    }
}

impl App {
    #[expect(
        clippy::too_many_arguments,
        reason = "the handles and config `run_app` composes; tests pass inert ones"
    )]
    pub fn new(
        db_pool: Pool,
        scoped_fs: ScopedFs,
        zzz_dir: String,
        scoped_dirs: Vec<String>,
        provider_manager: ProviderManager,
        enable_test_actions: bool,
        realtime: Arc<ConnectionRegistry>,
        audit_emitter: Arc<AuditEmitter>,
    ) -> Self {
        Self {
            instance_id: Uuid::new_v4(),
            projects: ProjectManager::new(),
            trusted_owner: TrustedOwner::current(),
            git: fuz_git::Git::with_clean_env(
                crate::pty_manager::terminal_env(std::env::vars_os()),
            ),
            db_pool,
            scoped_fs,
            zzz_dir,
            scoped_dirs,
            filer_manager: FilerManager::new(),
            pty_manager: PtyManager::new(),
            job_manager: JobManager::new(),
            provider_manager,
            completion_options: CompletionOptions::default(),
            enable_test_actions,
            realtime,
            action_registry: std::sync::OnceLock::new(),
            tools: Tools::default(),
            root_policy: RootPolicy::default(),
            audit_emitter,
        }
    }

    /// Broadcast a message to all connected clients.
    ///
    /// Shim over `App.realtime`. The spine WS handler registers
    /// connections in `App.realtime` (`Arc<fuz_realtime::ConnectionRegistry>`);
    /// call sites (`filer::app_broadcast`,
    /// `project_manager::broadcast_project_changed`)
    /// broadcast through this shim. Terminal output and job state are
    /// per-account, so `pty_manager` and `job_manager` use
    /// `realtime.send_to_account` instead.
    pub fn broadcast(&self, message: &str) {
        let _ = self.realtime.broadcast(message);
    }
}

// -- Errors -------------------------------------------------------------------

/// The calling account. For specs that require an account, so a missing one
/// is refused rather than trusted.
///
/// # Errors
///
/// `unauthenticated` when the request carries no account.
pub fn caller_account_id(ctx: &ActionContext<'_>) -> Result<Uuid, JsonrpcError> {
    ctx.auth
        .account()
        .map(|account| account.id)
        .ok_or_else(unauthenticated)
}

/// Deserialize an optional field that, when present, must not be `null` —
/// a TS `optional` entry. Pair with `#[serde(default)]` for the absent case.
/// (`parse_strict_params` refuses a top-level `null`; this covers the
/// nested fields its walk doesn't reach.)
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// A `not_found` (-32003) error with a caller-supplied `message` and
/// `data.reason`.
///
/// `fuz_http::not_found` fixes the message to `"{resource} not found"`; the
/// filesystem and project handlers keep their `failed to …: …` messages
/// (which name the path) across every code, so they build the error here.
#[cold]
pub fn not_found_error(message: &str, reason: &str) -> JsonrpcError {
    JsonrpcError {
        code: fuz_http::JsonrpcErrorCode::NotFound,
        message: message.to_owned(),
        data: Some(serde_json::json!({ "reason": reason })),
    }
}
