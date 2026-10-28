//! `zzz_server` — Rust backend for zzz.
//!
//! The library entry point [`run_app`] owns the full server lifecycle over
//! the spine's server toolkit (`fuz_actions::server`): config from the command
//! line and env, the spine core booted by `create_app_backend` (pool, the
//! READ COMMITTED guard, migrations, keyring, audit emitter, limiters,
//! realtime registries, revocation listeners), the `ActionRegistry` compile,
//! file watchers, route composition, signal handling, the auth cleanup task,
//! graceful shutdown, then zzz's own teardown (jobs, PTYs).
//!
//! The spine's swap points (`fuz_actions::server::SpineRunOptions`) are what
//! the binaries differ on:
//!
//! - Production wires [`fuz_auth::Argon2idHasher`] from `src/main.rs`.
//! - `testing_zzz_server`'s `main.rs` wires
//!   `fuz_testing::TestingArgon2idHasher` for ~1-5 ms argon2 in
//!   cross-process integration tests, plus its daemon token and seams.
//!
//! Keeping the lifecycle in the library shrinks each binary's
//! `main.rs` to the command line, the swap points, and `run_app(...)`.

pub mod file_bytes;
pub mod filer;
pub mod handlers;
pub mod job_manager;
pub mod media;
mod origin_allowlist;
pub mod provider;
pub mod pty_manager;
mod router;
pub mod scoped_fs;
pub mod static_files;
pub mod tool;
pub mod transcription;
pub mod utf8_stream;
pub mod zzz_action_specs;

use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fuz_actions::ActionRateLimits;
use fuz_actions::server::{
    AppBackendSpec, BootedAppBackend, ServeOptions, SpineRunOptions, StartupError, UpkeepOptions,
    compile_action_registry, create_app_backend, serve_until_shutdown,
};

/// Default loopback bind address (port 4460).
///
/// `--port` or `ZZZ_PORT` override the port; the host stays loopback. The
/// port matches the `zzz` CLI's daemon default so a directly-run `zzzd` and a
/// CLI-spawned daemon bind the same port.
pub const DEFAULT_ADDR: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 4460);

/// Prefix of zzz's session cookie name; the daemon's port completes it (see
/// [`session_cookie_name_for_port`]).
pub const SESSION_COOKIE_NAME_PREFIX: &str = "zzz_session_";

/// The session cookie name for a daemon listening on `port`:
/// `zzz_session_<port>`.
///
/// Browsers scope cookies by host, not port, so with one fixed name every zzz
/// daemon on `localhost` — the installed one, `cargo xtask dev`, a test
/// binary — would read and overwrite the same cookie, and logging into one
/// would log you out of the others. A per-port name keeps each daemon's
/// session its own.
#[must_use]
pub fn session_cookie_name_for_port(port: u16) -> String {
    format!("{SESSION_COOKIE_NAME_PREFIX}{port}")
}

/// Cap on one JSON-RPC message, in bytes, on both transports.
///
/// It's the `/api/rpc` request body limit and the `/api/ws` inbound message
/// (and frame) limit — one value so the two transports can't drift. The
/// frontend's twin of the same name
/// (`src/lib/rpc_message_limit.ts`) refuses a larger request before sending,
/// since an oversized WebSocket message closes the socket rather than getting
/// an error reply; the cross-backend filesystem suite pins the two together.
///
/// 16 MiB, above the spine's 1 MiB default, so saving a file the filer loads
/// (at most 4 MiB) fits in all but pathological cases — JSON escapes a
/// control character to 6 bytes, so a file dense with them can exceed the
/// cap, and the client guard then refuses the save cleanly — and so a long
/// `completion_create` history fits.
///
/// **Memory.** The larger cap is not confined to authenticated callers on
/// HTTP: `/api/rpc` buffers and parses the body before auth, and `ping` is
/// public, so any local process can make zzzd buffer up to 16 MiB per
/// concurrent request. On the WebSocket (authenticated at upgrade) each
/// socket can have up to 128 dispatches in flight, a ceiling of about 2 GiB
/// of buffered messages per authenticated socket. Acceptable only because
/// the bind is loopback-only and zzz is single-operator (see the root
/// CLAUDE.md § Security posture); the account, bootstrap, and signup routes
/// keep the 1 MiB default.
pub const RPC_MESSAGE_MAX_BYTES: usize = 16 * 1024 * 1024;

/// Byte budget of one WebSocket connection's outbound queue — the frames
/// queued for a socket that its writer has not yet taken.
///
/// A frame that does not fit closes the socket with
/// `fuz_realtime::WS_CLOSE_OUTBOUND_OVERFLOW` (4005) and the client
/// reconnects and reloads; a frame is always queued into an empty queue
/// (`fuz_realtime::connection_channel`).
///
/// 32 MiB, above the spine's 4 MiB default
/// (`fuz_actions::DEFAULT_WS_OUTBOUND_QUEUE_BYTES`), sized by the largest
/// frame zzz pushes: a `filer_change` carries a file's whole text, up to
/// `filer::MAX_INDEXED_FILE_SIZE` (4 MiB), and JSON escapes a control
/// character to 6 bytes, so one frame can reach 24 MiB. The budget holds
/// that frame behind others still waiting — under the default any file near
/// the cap is delivered only into an empty queue, so two of them in a row,
/// or one behind a line of terminal output, would close the socket. Every
/// other notification is
/// small next to it (`terminal_data` is at most one 8 KiB read, escaped), and
/// responses are written by the connection's own loop, not queued.
///
/// It bounds a burst, it does not absorb one of any size: a batch of changes
/// larger than this still closes a socket whose client takes nothing while
/// the batch is queued. The filer yields after each broadcast so a
/// connection's writer can take each frame before the next is queued; a
/// client that falls more than the budget behind is still closed.
///
/// **Memory.** This is what a client that stops reading can make zzzd hold
/// for its socket: up to 32 MiB waiting, plus the one frame its writer has
/// taken (at most 24 MiB), until the write stalls out
/// (`fuz_realtime::WS_WRITE_STALL_TIMEOUT`) or the next frame overflows the
/// queue. A broadcast's text is one buffer shared by every recipient, so
/// sockets holding the same `filer_change` frames hold them once.
pub const WS_OUTBOUND_QUEUE_BYTES: usize = 2 * RPC_MESSAGE_MAX_BYTES;

// The budget holds the largest `filer_change` frame — every byte of a file
// at the cap escaped to 6 — with 1 MiB to spare for its envelope and for the
// frames it queues behind.
const _: () =
    assert!(WS_OUTBOUND_QUEUE_BYTES as u64 >= 6 * filer::MAX_INDEXED_FILE_SIZE + 1024 * 1024);

/// Receive silence past which `/api/ws` closes a socket (4003, "server
/// heartbeat timeout") — 1200 s, twice the longest heartbeat interval zzz's
/// frontend lets a user set (`HEARTBEAT_INTERVAL_BOUNDS.max`, 600 s, in
/// `src/lib/socket_helpers.ts`). The spine's 60 s default would drop a live
/// client whose interval was raised past 30 s; at twice the longest interval
/// a client idle for one interval and slow on the next stays inside it.
const WS_RECEIVE_TIMEOUT: std::time::Duration = std::time::Duration::from_mins(20);

/// The limits `/api/ws` is mounted with: the inbound message cap shared
/// with the `/api/rpc` body ([`RPC_MESSAGE_MAX_BYTES`] — an oversized
/// message closes the socket), the outbound queue budget
/// ([`WS_OUTBOUND_QUEUE_BYTES`]), and the receive timeout
/// ([`WS_RECEIVE_TIMEOUT`]).
///
/// Private, and read by exactly one non-test site — the
/// `register_action_ws_with_options` call in `run_app` — so that mounting
/// the socket without it (the spine's `register_action_ws`, or its
/// message-limit helper, either of which leaves the outbound budget at the
/// spine's 4 MiB default) leaves this unused and fails the `dead_code` lint
/// under `-D warnings`. The assertion above names `WS_OUTBOUND_QUEUE_BYTES`
/// rather than this for the same reason: a use inside a `const _` would keep
/// it alive. `filer`'s budget test reads it too, which doesn't count in the
/// library target. The tripwire only sees the const going unread: a call
/// site that reads one field and drops the other (say `max_message_bytes`
/// alone, through the message-limit helper) still compiles clean — and so does
/// one that drops `receive_timeout` for the spine default, which the
/// `ws_receive_timeout_covers_the_longest_client_interval` test pins.
const WS_OPTIONS: fuz_actions::ActionWsOptions = fuz_actions::ActionWsOptions {
    max_message_bytes: RPC_MESSAGE_MAX_BYTES,
    outbound_queue_bytes: WS_OUTBOUND_QUEUE_BYTES,
    receive_timeout: Some(WS_RECEIVE_TIMEOUT),
};

/// zzz's concrete instantiation of [`fuz_actions::ExtraActionSpecsFactory`]
/// over [`handlers::App`] — extra specs folded in after the standard zzz set.
///
/// Production passes `None`; the `testing_zzz_server` binary passes `Some(_)`
/// to inject `_testing_reset` and `_testing_drain_effects`, closing over `fuz_testing` types in its own
/// process so the production graph stays clean.
pub type ExtraActionSpecsFactory = fuz_actions::ExtraActionSpecsFactory<handlers::App>;

/// The name zzz's sentinels carry (`zzz_server listening on …`).
pub const SERVER_NAME: &str = "zzz_server";

/// The migration chain zzz applies: the spine's auth namespace alone (zzz's
/// own state is in-memory and on disk).
pub const ZZZ_MIGRATION_NAMESPACES: &[fuz_db::MigrationNamespace] = &[fuz_auth::AUTH_MIGRATIONS];

/// Options for [`run_app`].
pub struct RunAppOptions {
    /// The spine's swap points. Production: [`fuz_auth::Argon2idHasher`],
    /// [`DEFAULT_ADDR`] (`127.0.0.1:4460`; only the port is overridable),
    /// [`fuz_http::DEFAULT_DRAIN_TIMEOUT`], every limiter enforced — always
    /// on, matching the other spine servers — no daemon token, no hook, no
    /// in-flight audit tracking.
    ///
    /// zzz mounts **no** daemon-token credential in production. Nothing sends
    /// the header — the browser UI authenticates with session cookies, and a
    /// browser request carries `Origin`/`Referer`, which
    /// `fuz_auth::is_browser_context` refuses for this credential anyway — so
    /// the only effect of mounting it was writing a keeper-grade secret into
    /// `<zzz_dir>/run/daemon_token` on a 30-second timer. Its producer
    /// (`fuz_testing::init_daemon_token`) is confined to `fuz_testing` by dep
    /// graph, so this crate cannot construct one even by mistake.
    ///
    /// The test binary: `fuz_testing::TestingArgon2idHasher`,
    /// `127.0.0.1:4462` so the two can run side-by-side, the limiters
    /// `DisabledForTesting` so the cross-backend auth suite's repeated logins
    /// don't trip the bucket, the daemon token `_testing_reset` resolves the
    /// keeper through, the env-gated schema wipe, and in-flight tracking so
    /// `_testing_drain_effects` is a real barrier.
    pub spine: SpineRunOptions,
    /// The parsed command line ([`parse_args`]): `--port` and `--static-dir`,
    /// each over its env var.
    pub args: CliArgs,
    /// Override the `ZZZ_ENABLE_TEST_ACTIONS` env-parsed flag.
    /// Production: `false`. Test binary: `true` so the `_testing_*`
    /// registry branch fires regardless of operator env.
    pub force_test_actions: bool,
    /// Factory injecting extra action specs after the standard zzz set.
    /// Production: `None`. Test binary: `Some(_)` so
    /// `fuz_testing::create_testing_reset_action_spec` can register
    /// without dragging `fuz_testing` into the production dep graph
    /// (the `cargo xtask check-release` audit blocks that).
    pub extra_action_specs_factory: Option<ExtraActionSpecsFactory>,
}

impl std::fmt::Debug for RunAppOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunAppOptions")
            .field("default_addr", &self.spine.default_addr)
            .field("drain_timeout", &self.spine.drain_timeout)
            .field("args", &self.args)
            .field("force_test_actions", &self.force_test_actions)
            .finish_non_exhaustive()
    }
}

/// Run the `zzz_server` lifecycle to completion.
///
/// Reads the config (command line + env), boots the spine core
/// (`fuz_actions::server::create_app_backend`: the keyring, the READ
/// COMMITTED guard, the pre-migration hook, the auth migrations, the keeper,
/// bootstrap availability, the revocation listeners and the audit-row fan-out
/// to the admin audit streams), builds zzz's app over it, compiles the action
/// registry, starts the permanent file watchers, mounts the routes, and
/// serves until Ctrl-C / SIGTERM
/// ([`fuz_actions::server::serve_until_shutdown`]): every live WebSocket is
/// closed with 1001 (going away) and every audit stream ended, then in-flight
/// requests drain. Jobs and PTYs are torn down after the drain.
///
/// The spine's auth cleanup ([`fuz_auth::spawn_auth_cleanup`]) runs beside
/// the server — expired sessions deleted and the connections they opened
/// closed, expired role-grant offers audited once — from the bind until
/// shutdown begins, and is joined before the teardown. Its close repeats one
/// already made: a socket or audit stream closes at its own credential's
/// deadline ([`fuz_auth::ResolvedAuth::credential_deadline`]).
///
/// # Errors
///
/// [`StartupError`] for config validation failures (exit `2`), DB
/// connectivity / migration failures, a database not at READ COMMITTED,
/// listener bind failures, and serve errors.
pub async fn run_app(options: RunAppOptions) -> Result<(), StartupError> {
    let RunAppOptions {
        spine:
            SpineRunOptions {
                backend: backend_options,
                default_addr,
                drain_timeout,
            },
        args,
        force_test_actions,
        extra_action_specs_factory,
    } = options;
    let mut config = parse_config(default_addr, args)?;
    if force_test_actions {
        config.enable_test_actions = true;
    }
    let shutdown = fuz_http::shutdown_token();

    // Parse `ZZZ_TRUSTED_PROXIES`. Empty/unset → no XFF trust (`client_ip` is
    // the TCP peer): zzz binds loopback only and has no proxy in front of it
    // by default. Misconfiguration fails fast so the operator sees the error
    // instead of silently leaving a hole.
    let trusted_proxies = match config.trusted_proxies.as_deref() {
        None => Vec::new(),
        Some(raw) => fuz_http::parse_proxy_list(raw)
            .map_err(|e| StartupError::Config(format!("ZZZ_TRUSTED_PROXIES: {e}")))?,
    };
    if !trusted_proxies.is_empty() {
        tracing::info!(
            count = trusted_proxies.len(),
            "trusted proxies configured — XFF resolution enabled"
        );
    }

    // What zzz's server is: its per-port cookie (the spine's route states take
    // the name as `&'static str`; it is fixed for the life of the process, so
    // leak its one allocation), the auth chain, and the admin audit stream. No
    // `/ready` fixture: zzz is a local daemon with no deploy gate.
    let spec = AppBackendSpec {
        session_cookie_name: session_cookie_name_for_port(config.bind_addr.port()).leak(),
        migration_namespaces: ZZZ_MIGRATION_NAMESPACES,
        expected_schema_json: None,
        audit_sse: true,
    };
    // zzz reads its own env (`ZZZ_PORT`, `--port`, a required
    // `DATABASE_URL`, `ZZZ_TRUSTED_PROXIES`); the spine core takes it in the
    // base reader's shape. The bind is `config.bind_addr`, not this.
    let env = fuz_http::BaseServerEnv {
        database_url: Some(config.database_url.clone()),
        cookie_keys: Some(config.secret_cookie_keys.clone()),
        host: None,
        port: None,
        allowed_origins: config.allowed_origins.clone(),
        trusted_proxies,
        bootstrap_token_path: config.bootstrap_token_path.as_deref().map(PathBuf::from),
    };
    let BootedAppBackend { backend, .. } = create_app_backend(&env, &spec, backend_options).await?;

    let scoped_dir_strings = std::mem::take(&mut config.scoped_dirs);

    // Permanent roots: zzz_dir first, then scoped_dirs — canonicalized paths,
    // not raw config paths
    let mut scoped_fs_paths: Vec<PathBuf> = Vec::with_capacity(1 + scoped_dir_strings.len());
    scoped_fs_paths.push(PathBuf::from(&config.zzz_dir));
    scoped_fs_paths.extend(scoped_dir_strings.iter().map(PathBuf::from));
    let scoped_fs = scoped_fs::ScopedFs::new(scoped_fs_paths);

    // AI providers — read API keys from env (empty counts as unset),
    // construct ProviderManager
    let anthropic_key = provider::read_api_key_env("SECRET_ANTHROPIC_API_KEY");
    let openai_key = provider::read_api_key_env("SECRET_OPENAI_API_KEY");
    let google_key = provider::read_api_key_env("SECRET_GOOGLE_API_KEY");
    let mut provider_manager = provider::ProviderManager::new();
    provider_manager.add(provider::Provider::Anthropic(
        provider::anthropic::AnthropicProvider::new(anthropic_key.as_deref()),
    ));
    provider_manager.add(provider::Provider::OpenAi(
        provider::openai::OpenAiProvider::new(openai_key.as_deref()),
    ));
    provider_manager.add(provider::Provider::Gemini(
        provider::gemini::GeminiProvider::new(google_key.as_deref()),
    ));

    if config.enable_test_actions {
        tracing::info!(
            "test actions enabled — `_testing_*` methods registered on live dispatchers"
        );
    }

    // The app over the core's pool, connection registry, and audit emitter —
    // the instances the spine routes and the revocation listeners use.
    let mut app = handlers::App::new(
        backend.pool.clone(),
        scoped_fs,
        config.zzz_dir,
        scoped_dir_strings,
        provider_manager,
        config.enable_test_actions,
        Arc::clone(&backend.realtime),
        Arc::clone(&backend.audit_emitter),
    );
    app.tools = config.tools;
    let app_state = Arc::new(app);

    // A deleted or purged account's terminals end with its sockets.
    handlers::terminal::register_account_removal_listener(&backend.audit_emitter, &app_state);

    // The per-action limiters, built once and shared by both dispatcher
    // states: the dispatcher charges every spec declaring a class — the
    // spine's auth spec set, protocol, and zzz-owned specs — across both the
    // HTTP RPC and WS transports, one budget per caller, as fuz_app threads
    // one pair through `create_app_server`.
    //
    // The IP axis is live: `peer/ping` comes in with `PROTOCOL_ACTION_SPECS`
    // declaring `RateLimitClass::Ip`. zzz is local-first on a loopback-fixed
    // bind, so that budget is per-machine and the axis carries little signal
    // until a zzz grows a reverse proxy or a second account. No zzz-owned spec
    // declares a class, so beyond the auth surface's account charges these sit
    // ready rather than active — the point is that a future
    // `.with_rate_limit(...)` gets a real limiter instead of silently
    // no-op'ing against a `None` axis.
    let limits = ActionRateLimits::defaults(backend.rate_limiters);

    // Compile the spine action registry — must run after `Arc<App>` is
    // constructed because the zzz-specific spec builders capture
    // `Arc::clone(&app_state)` into per-spec handler closures.
    //
    // Composition order: protocol (heartbeat + peer/ping), then the spine's
    // auth families (account + admin self-service), then zzz-specific specs
    // (`core`, `workspace`, `filesystem`, `terminal`, `provider`).
    let mut all_specs: Vec<fuz_actions::ActionSpec> = fuz_actions::PROTOCOL_ACTION_SPECS();
    all_specs.extend(backend.auth_spec_set(
        Arc::new(fuz_auth::AdminOfferAuthorize),
        Arc::new(fuz_auth::RoleRegistry::default()),
    ));
    all_specs.extend(zzz_action_specs::build_zzz_owned_specs(&app_state));
    if app_state.enable_test_actions {
        all_specs.extend(zzz_action_specs::build_testing_specs(Arc::clone(
            &app_state,
        )));
    }
    if let Some(factory) = extra_action_specs_factory {
        all_specs.extend(factory(
            Arc::clone(&app_state),
            backend.extra_action_specs_runtime(),
        ));
    }
    let action_registry = compile_action_registry(all_specs)?;
    tracing::info!(
        spec_count = action_registry.len(),
        "spine action registry compiled"
    );
    // Set the action_registry on App via OnceLock. The set call returns
    // Err only if the cell is already populated, which is impossible
    // here because we just constructed the Arc<App>.
    if app_state
        .action_registry
        .set(Arc::clone(&action_registry))
        .is_err()
    {
        return Err(StartupError::Internal(
            "action_registry was already set — unexpected double init".to_owned(),
        ));
    }

    // Start the permanent file watchers at startup: zzz_dir, then each of
    // scoped_dirs. zzz_dir uses FilerConfig::zzz_dir() (no ignored dirs);
    // scoped_dirs use workspace config (ignoring zzz_dir when nested inside).
    match app_state
        .filer_manager
        .start_filer(
            &app_state.zzz_dir,
            Arc::clone(&app_state),
            filer::FilerConfig::zzz_dir(),
            filer::FilerLifetime::Permanent,
        )
        .await
    {
        Ok(_) => tracing::info!(path = %app_state.zzz_dir, "started zzz_dir filer"),
        Err(e) => {
            tracing::warn!(path = %app_state.zzz_dir, error = %e, "failed to start zzz_dir filer");
        }
    }

    for dir in &app_state.scoped_dirs {
        if *dir == app_state.zzz_dir {
            continue;
        }
        match app_state
            .filer_manager
            .start_filer(
                dir,
                Arc::clone(&app_state),
                filer::FilerConfig::workspace(dir, &app_state.zzz_dir),
                filer::FilerLifetime::Permanent,
            )
            .await
        {
            Ok(_) => tracing::info!(path = %dir, "started scoped_dir filer"),
            Err(e) => tracing::warn!(path = %dir, error = %e, "failed to start scoped_dir filer"),
        }
    }

    // -- Routes -----------------------------------------------------------
    //
    // One front door for the whole server: the origin allowlist beside the
    // credential walk (daemon token → cookie → bearer) over zzz's per-port
    // cookie. Every route state that reads a credential takes a clone, and the
    // stack's options read its allowlist (`router::zzz_stack_options`), so
    // the stack's origin check and each handler's in-handler one read one list.
    // The allowlist is never empty and every entry is well-formed:
    // `parse_config` refused to boot otherwise (see `origin_allowlist`).
    //
    // The spine `ActionRegistry` dispatcher is mounted at `/api/rpc` and the
    // spine WS handler at `/api/ws`; `app.broadcast` is shimmed onto
    // `App.realtime` (see `handlers/mod.rs`). The routers carry no layers of
    // their own: `router::compose_router` puts each in a
    // `fuz_http::compose_stack` group — see `router`.
    let gate = backend.auth_gate();
    let audit_sse = backend
        .audit_sse
        .clone()
        .ok_or_else(|| StartupError::Internal("the audit stream registry is unbuilt".into()))?;
    let dispatch = backend.action_dispatch(gate.clone(), action_registry, &limits);
    let surfaces = router::SurfaceRouters {
        rpc: fuz_actions::create_rpc_router(dispatch.clone()),
        // `WS_OPTIONS`: the `/api/rpc` body's inbound cap, and an outbound
        // queue budget sized for `filer_change` frames.
        ws: fuz_actions::register_action_ws_with_options(
            backend.ws_route_state(
                dispatch,
                // No role gate: zzz is single-operator by configuration
                // (`open_signup` defaults false, so every account is operator-minted)
                // and so every authenticated account is that operator. That default is
                // the weaker half of the argument, though — flip it and the gate still
                // wouldn't help, because the socket adds no privilege the account
                // doesn't already hold. The RPC surface is itself wide open by
                // recorded decision: the `any_credential_surface` census in
                // `crate::zzz_action_specs` documents that every zzz-owned spec is
                // `CredentialGate::Any`, mutations included, so any credential that
                // could open a socket can already `terminal_create` and read the same
                // stream over RPC. A role gate here would narrow nothing while that
                // posture stands; it becomes the right move in the same breath as
                // narrowing that census (a second account, a reverse proxy). Zzz has
                // no TS server to twin against (Rust-only), so this preserves the
                // shipped behavior exactly.
                Vec::new(),
            ),
            WS_OPTIONS,
        ),
        account: fuz_auth::account_router(backend.account_route_state(gate.clone())),
        bootstrap: fuz_auth::bootstrap_routes::bootstrap_router(
            backend.bootstrap_route_state(gate.clone()),
        ),
        // Signup: mounted on the production server so the cross-process
        // integration harness (testing_zzz_server reuses run_app) can mint
        // per-test accounts through production RPC. `open_signup` defaults to
        // false in app_settings, so the route is invite-gated at runtime
        // unless an admin flips the flag.
        signup: fuz_auth::signup_routes::signup_router(backend.signup_route_state(gate.clone())),
        // `GET /api/admin/audit/stream`, with the spine defaults (admin role,
        // session-only credential gate, close-on-revoke keyed by each audit
        // event's declared `RevocationScope`), over the registry the core's
        // audit listener fans rows into.
        audit_stream: fuz_realtime::audit_stream_router(fuz_realtime::AuditStreamRouteState::new(
            gate.clone(),
            audit_sse,
        )),
        // File byte routes (`file_bytes::FILE_BYTES_PATH`): hand-written,
        // outside the action system, so the handlers run the gate themselves
        // (origin, then the query, then the credential) before they read a body.
        file_bytes: file_bytes::file_bytes_router(file_bytes::FileBytesRouteState {
            app: Arc::clone(&app_state),
            gate,
        }),
    };
    if let Some(ref dir) = config.static_dir {
        tracing::info!(dir = %dir.display(), "serving static files");
    }
    let router = router::compose_router(
        surfaces,
        config.static_dir.as_deref(),
        &router::zzz_stack_options(backend.stack_options()),
    );

    // Signal handling, the shutdown close of every live WebSocket (a 1001
    // close) and audit stream, the auth cleanup beside the server, and the
    // graceful drain come from the spine; zzz's own teardown (jobs, PTYs) runs
    // after the drain returns, ahead of the result.
    let served = serve_until_shutdown(
        router,
        ServeOptions {
            server_name: SERVER_NAME,
            addr: config.bind_addr,
            drain_timeout,
            shutdown,
            socket_revoker: Some(backend.socket_revoker()),
            upkeep: Some(UpkeepOptions {
                auth_cleanup: backend.auth_cleanup_options(),
                extra: Vec::new(),
            }),
        },
    )
    .await;

    // Stop jobs (killing their tool processes) and clean up spawned terminal
    // processes before exiting
    app_state.job_manager.cancel_all().await;
    app_state.pty_manager.kill_all().await;
    served
}

// -- Config -------------------------------------------------------------------

/// Validated config built from CLI args + env vars.
pub struct Config {
    pub bind_addr: SocketAddr,
    pub static_dir: Option<PathBuf>,
    pub database_url: String,
    pub secret_cookie_keys: String,
    pub bootstrap_token_path: Option<String>,
    /// `FUZ_ALLOWED_ORIGINS`, parsed and validated entry by entry — never
    /// empty (see [`origin_allowlist`]). Read by both the origin check and
    /// the `Host` check.
    pub allowed_origins: fuz_http::AllowedOrigins,
    /// `PUBLIC_ZZZ_SCOPED_DIRS`, resolved (canonical, trailing `/`) and
    /// checked by [`check_scoped_dirs`].
    pub scoped_dirs: Vec<String>,
    pub zzz_dir: String,
    /// Register `_testing_*` actions on live dispatchers. Set by integration
    /// tests via `ZZZ_ENABLE_TEST_ACTIONS=1`; production must leave unset.
    pub enable_test_actions: bool,
    /// Comma-separated trusted-proxy entries (IPs and CIDR ranges).
    /// Unset/empty → no XFF trust → `client_ip` falls back to the TCP
    /// peer IP on every request. Set when running behind a reverse
    /// proxy so login rate-limit keys and `audit_log.ip` reflect the
    /// originating client. Parsed eagerly in `run()`; invalid entries
    /// fail startup.
    pub trusted_proxies: Option<String>,
    /// The local tools found at boot (`ffmpeg`, whisper.cpp and its model).
    pub tools: tool::Tools,
}

/// Hand-written so the secrets never reach a log line: `database_url` (which
/// can carry a password) and `secret_cookie_keys` print as `[redacted]`.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind_addr", &self.bind_addr)
            .field("static_dir", &self.static_dir)
            .field("database_url", &"[redacted]")
            .field("secret_cookie_keys", &"[redacted]")
            .field("bootstrap_token_path", &self.bootstrap_token_path)
            .field("allowed_origins", &self.allowed_origins)
            .field("scoped_dirs", &self.scoped_dirs)
            .field("zzz_dir", &self.zzz_dir)
            .field("enable_test_actions", &self.enable_test_actions)
            .field("trusted_proxies", &self.trusted_proxies)
            .field("tools", &self.tools)
            .finish()
    }
}

/// The app directory when `PUBLIC_ZZZ_DIR` is unset or empty, relative to
/// the working directory.
pub const DEFAULT_ZZZ_DIR: &str = ".zzz/";

/// An env var's value, `None` when unset.
///
/// # Errors
///
/// [`StartupError::Config`] naming the variable when its value isn't valid
/// UTF-8 — never read as unset, which would silently drop a configured path
/// (e.g. every `PUBLIC_ZZZ_SCOPED_DIRS` entry).
fn env_var_utf8(name: &str) -> Result<Option<String>, StartupError> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(StartupError::Config(format!("{name} is not valid UTF-8")))
        }
    }
}

/// An env var's value, with unset, empty, and whitespace-only all reading as
/// unset — so an exported-but-empty path var falls back to its default
/// rather than resolving to the working directory or `/`.
///
/// # Errors
///
/// As [`env_var_utf8`].
fn env_non_empty(name: &str) -> Result<Option<String>, StartupError> {
    Ok(non_empty(env_var_utf8(name)?))
}

/// Parse a port from `--port` or `ZZZ_PORT` (named by `source`).
///
/// # Errors
///
/// The reason, naming `source`, for anything but an integer in `1..=65535` —
/// an invalid port refuses to boot rather than falling back to the default.
fn parse_port(source: &str, value: &str) -> Result<u16, String> {
    value
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|&port| port != 0)
        .ok_or_else(|| format!("invalid {source} {value:?}: expected a port in 1..=65535"))
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Resolve a path to an absolute, canonical, normalized directory string
/// with trailing `/`. Tries `canonicalize` (resolves symlinks, requires path
/// to exist), falls back to `absolute` (no I/O). Used for the scoped dirs and,
/// through [`ensure_app_dir`], the app directory.
///
/// # Errors
///
/// Returns [`StartupError::Config`] for an empty path or one that can't be
/// made absolute — never a silent fallback, which would collapse to `/` (a
/// permanent scoped root, and a filer, over the whole filesystem).
fn resolve_dir(path: &Path) -> Result<String, StartupError> {
    if path.as_os_str().is_empty() {
        return Err(StartupError::Config("empty directory path".to_owned()));
    }
    let resolved = std::fs::canonicalize(path)
        .or_else(|_| std::path::absolute(path))
        .map_err(|e| StartupError::Config(format!("can't resolve {}: {e}", path.display())))?;
    let mut s = resolved
        .to_str()
        .ok_or_else(|| {
            StartupError::Config(format!(
                "{} resolves to a path that isn't valid UTF-8: {}",
                path.display(),
                resolved.display()
            ))
        })?
        .to_owned();
    if !s.ends_with('/') {
        s.push('/');
    }
    Ok(s)
}

/// The app directory: `PUBLIC_ZZZ_DIR` (unset or empty → [`DEFAULT_ZZZ_DIR`])
/// through [`ensure_app_dir`].
///
/// Public so `testing_zzz_server` places its
/// daemon-token file exactly where [`run_app`] resolves the app dir — the
/// cross-process harness reads `<zzz_dir>/run/daemon_token`, so the two must
/// not drift.
///
/// # Errors
///
/// Returns [`StartupError::Config`] when the directory can't be created or
/// resolved, or is the working directory (see [`check_app_dir_is_not_cwd`]).
pub fn ensure_zzz_dir_from_env() -> Result<String, StartupError> {
    let raw = env_non_empty("PUBLIC_ZZZ_DIR")?.unwrap_or_else(|| DEFAULT_ZZZ_DIR.to_owned());
    let zzz_dir = ensure_app_dir(Path::new(&raw))?;
    // an unreadable working directory can't equal the app dir, which resolved
    if let Ok(cwd) = std::env::current_dir() {
        check_app_dir_is_not_cwd(&zzz_dir, &cwd)?;
    }
    Ok(zzz_dir)
}

/// Refuse an app dir that is the daemon's working directory — under the CLI
/// that's the daemon home `~/.zzz/`, whose `.env` and `bootstrap_token` the
/// app dir's filer (which skips `.zzz` only below its root) would index and
/// broadcast. Any other directory is fine, like the default `.zzz`.
///
/// This catches the daemon home only when it's the working directory: an
/// explicit `PUBLIC_ZZZ_DIR` naming `~/.zzz` for a daemon run elsewhere makes
/// the home the app dir all the same, indexing its `.env` — don't.
///
/// # Errors
///
/// [`StartupError::Config`] naming both when `zzz_dir` (resolved) is `cwd`.
fn check_app_dir_is_not_cwd(zzz_dir: &str, cwd: &Path) -> Result<(), StartupError> {
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    if Path::new(zzz_dir) == cwd {
        return Err(StartupError::Config(format!(
            "PUBLIC_ZZZ_DIR resolves to the daemon's working directory {zzz_dir}: the app dir must not be the working directory itself (the default `{DEFAULT_ZZZ_DIR}` is a subdirectory of it), since the working directory holds the daemon's own files (the CLI's `.env` and `bootstrap_token`)"
        )));
    }
    Ok(())
}

/// Refuse a scoped dir that is, or is inside, a `.zzz` directory other than
/// the app dir ([`filer::is_in_zzz_home`]) — its filer would refuse to start
/// (so nothing would be indexed) while it stayed a writable `ScopedFs` root,
/// and `.zzz` directories hold zzz's own files (the CLI's `.env` and
/// `bootstrap_token`). Paths are the resolved forms.
///
/// # Errors
///
/// [`StartupError::Config`] naming `PUBLIC_ZZZ_SCOPED_DIRS` and the first
/// such dir.
fn check_scoped_dirs(scoped_dirs: &[String], zzz_dir: &str) -> Result<(), StartupError> {
    let app_dir = Path::new(zzz_dir);
    scoped_dirs
        .iter()
        .find(|dir| filer::is_in_zzz_home(Path::new(dir), app_dir))
        .map_or(Ok(()), |dir| {
            Err(StartupError::Config(format!(
                "PUBLIC_ZZZ_SCOPED_DIRS entry {dir} is in a .zzz directory other than the app dir {zzz_dir}: .zzz directories hold zzz's own files (secrets, tokens) and can't be scoped"
            )))
        })
}

/// Create the app directory `path` if it doesn't exist, then
/// [`resolve_dir`] it.
///
/// Missing parents are created too, all mode `0700` — the app dir holds
/// runtime state and tokens. Creating first means the result is always
/// canonical, never the `absolute` fallback a missing directory gets.
///
/// # Errors
///
/// Returns [`StartupError::Config`] naming the path when it can't be created
/// (or exists but isn't a directory) or can't be resolved.
fn ensure_app_dir(path: &Path) -> Result<String, StartupError> {
    if path.as_os_str().is_empty() {
        return Err(StartupError::Config("empty directory path".to_owned()));
    }
    fuz_sys::fs::create_dir_all_mode(path, 0o700).map_err(|e| {
        StartupError::Config(format!(
            "can't create app directory {}: {e}",
            path.display()
        ))
    })?;
    resolve_dir(path)
}

/// The daemon's options, printed after the binary's name for `-h` /
/// `--help` ([`usage`]) and quoted by every argument error —
/// shared by `zzzd` and `testing_zzzd`, so it names neither.
pub const OPTIONS: &str = "[--port <port>] [--static-dir <dir>]";

/// The usage text for the binary named `program` (`zzzd`, `testing_zzzd`).
#[must_use]
pub fn usage(program: &str) -> String {
    format!("Usage: {program} {OPTIONS}\n")
}

/// Why [`parse_args`] stopped short of a command line to run.
#[derive(Debug, PartialEq, Eq)]
pub enum ArgsError {
    /// `-h` / `--help`: not a failure — the binary prints its usage and exits
    /// `0`.
    HelpRequested,
    /// The line to print above the usage; the binary exits `2`.
    Invalid(String),
}

/// Parse the process's command line for the binary named `program`, or the
/// exit it ends on.
///
/// `--help` prints the usage to stdout and exits `0`; a bad
/// argument prints the error and the usage to stderr and exits `2`
/// (`fuz_sys::cli::EXIT_USAGE`) — before the binary does anything else.
///
/// # Errors
///
/// The [`std::process::ExitCode`] to return from `main`.
pub fn parse_process_args(program: &str) -> Result<CliArgs, std::process::ExitCode> {
    match parse_args(std::env::args_os().skip(1)) {
        Ok(args) => Ok(args),
        Err(ArgsError::HelpRequested) => {
            print!("{}", usage(program));
            Err(std::process::ExitCode::SUCCESS)
        }
        Err(ArgsError::Invalid(message)) => {
            eprint!("error: {message}\n\n{}", usage(program));
            Err(std::process::ExitCode::from(fuz_sys::cli::EXIT_USAGE))
        }
    }
}

/// Flags parsed from the command line; unset ones fall back to env vars.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CliArgs {
    /// `--port`, over `ZZZ_PORT`.
    pub port: Option<u16>,
    /// `--static-dir`, over `ZZZ_STATIC_DIR`.
    pub static_dir: Option<PathBuf>,
}

/// Parse `zzzd`'s arguments (without the program name). Each flag takes its
/// value as the next argument or after `=` (`--port 4460`, `--port=4460`);
/// a repeated flag's last value wins.
///
/// Read as `OsString`s, so a non-UTF-8 argument never panics: a
/// `--static-dir` path may be any bytes, and anything else that isn't UTF-8
/// is an error.
///
/// # Errors
///
/// [`ArgsError::HelpRequested`] for `-h` / `--help`; [`ArgsError::Invalid`]
/// for an unknown flag or stray positional argument, a flag missing its
/// value, an empty `--static-dir`, or an invalid port — never ignored, so a
/// typo can't silently boot with defaults.
pub fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<CliArgs, ArgsError> {
    use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};

    let mut parsed = CliArgs::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        // split `--flag=value` on the bytes, so the value may be any path
        let bytes = arg.as_bytes();
        let (flag_bytes, inline) = match bytes.iter().position(|&b| b == b'=') {
            Some(eq) if bytes.starts_with(b"--") => (
                &bytes[..eq],
                Some(OsString::from_vec(bytes[eq + 1..].to_vec())),
            ),
            _ => (bytes, None),
        };
        let flag = match std::str::from_utf8(flag_bytes) {
            Ok("-h" | "--help") if inline.is_none() => return Err(ArgsError::HelpRequested),
            Ok(flag @ ("--port" | "--static-dir")) => flag,
            Ok(_) => {
                return Err(ArgsError::Invalid(format!(
                    "unknown argument {:?} (options: {OPTIONS})",
                    arg.to_string_lossy()
                )));
            }
            Err(_) => {
                return Err(ArgsError::Invalid(format!(
                    "argument {:?} is not valid UTF-8 (options: {OPTIONS})",
                    arg.to_string_lossy()
                )));
            }
        };
        let value = inline.or_else(|| args.next()).ok_or_else(|| {
            ArgsError::Invalid(format!("{flag} requires a value (options: {OPTIONS})"))
        })?;
        if flag == "--port" {
            let value = value
                .to_str()
                .ok_or_else(|| ArgsError::Invalid("--port is not valid UTF-8".to_owned()))?;
            parsed.port = Some(parse_port("--port", value).map_err(ArgsError::Invalid)?);
        } else {
            if value.is_empty() {
                return Err(ArgsError::Invalid(
                    "--static-dir requires a non-empty value".to_owned(),
                ));
            }
            parsed.static_dir = Some(PathBuf::from(value));
        }
    }
    Ok(parsed)
}

/// A required env var's value.
///
/// # Errors
///
/// [`StartupError::Config`] naming the variable when it's unset or blank
/// (empty or whitespace — the same "unset" every other var uses), or not
/// valid UTF-8.
fn env_required(name: &str) -> Result<String, StartupError> {
    env_non_empty(name)?
        .ok_or_else(|| StartupError::Config(format!("{name} is unset or blank (it is required)")))
}

/// Parse the `ZZZ_ENABLE_TEST_ACTIONS` flag from its env value: unset or
/// blank → `false`, else [`fuz_sys::env::parse_stringbool`].
///
/// # Errors
///
/// [`StartupError::Config`] naming the variable for an unrecognized value.
fn parse_test_actions_flag(value: Option<&str>) -> Result<bool, StartupError> {
    let Some(value) = value.filter(|v| !v.trim().is_empty()) else {
        return Ok(false);
    };
    fuz_sys::env::parse_stringbool(value)
        .map_err(|e| StartupError::Config(format!("ZZZ_ENABLE_TEST_ACTIONS: {e}")))
}

fn parse_config(default_addr: SocketAddr, args: CliArgs) -> Result<Config, StartupError> {
    let CliArgs {
        mut port,
        mut static_dir,
    } = args;

    // Fall back to env vars for port/static_dir
    if port.is_none()
        && let Some(val) = env_non_empty("ZZZ_PORT")?
    {
        port = Some(parse_port("ZZZ_PORT", &val).map_err(StartupError::Config)?);
    }
    if static_dir.is_none() {
        static_dir = env_non_empty("ZZZ_STATIC_DIR")?.map(PathBuf::from);
    }
    // An empty or missing static dir would serve the working directory (or
    // nothing) as the UI — refuse to boot instead.
    if let Some(dir) = &static_dir
        && !dir.is_dir()
    {
        return Err(StartupError::Config(format!(
            "static dir is not a directory: {}",
            dir.display()
        )));
    }

    // Required env vars
    let database_url = env_required("DATABASE_URL")?;
    let secret_cookie_keys = env_required("SECRET_FUZ_COOKIE_KEYS")?;

    let bootstrap_token_path = env_non_empty("FUZ_BOOTSTRAP_TOKEN_PATH")?;
    // checked here, before anything touches the DB: an unset or empty list,
    // or a malformed entry, refuses to boot, and a wildcard entry is logged
    // with what it admits
    let allowed_origins = origin_allowlist::allowed_origins_from_env(
        env_var_utf8(origin_allowlist::ALLOWED_ORIGINS_VAR)?.as_deref(),
    )?;

    let zzz_dir = ensure_zzz_dir_from_env()?;

    // resolved and checked here, before anything touches the DB, so a bad
    // entry is reported without one
    let scoped_dirs: Vec<String> = env_var_utf8("PUBLIC_ZZZ_SCOPED_DIRS")?
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|dir| resolve_dir(Path::new(dir)))
        .collect::<Result<_, _>>()?;
    check_scoped_dirs(&scoped_dirs, &zzz_dir)?;

    let enable_test_actions =
        parse_test_actions_flag(env_var_utf8("ZZZ_ENABLE_TEST_ACTIONS")?.as_deref())?;
    let trusted_proxies = env_var_utf8("ZZZ_TRUSTED_PROXIES")?;
    // a bad override refuses to boot; a tool that's simply absent doesn't
    let tools = tool::Tools::from_env().map_err(StartupError::Config)?;

    Ok(Config {
        bind_addr: SocketAddr::new(
            default_addr.ip(),
            port.unwrap_or_else(|| default_addr.port()),
        ),
        static_dir,
        database_url,
        secret_cookie_keys,
        bootstrap_token_path,
        allowed_origins,
        scoped_dirs,
        zzz_dir,
        enable_test_actions,
        trusted_proxies,
        tools,
    })
}

#[cfg(test)]
mod ws_receive_timeout {
    /// The longest heartbeat interval zzz's frontend lets a user set —
    /// `HEARTBEAT_INTERVAL_BOUNDS.max` in `src/lib/socket_helpers.ts`, kept in
    /// step by hand: a change there moves this.
    const MAX_CLIENT_HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(600);

    /// `/api/ws` keeps a client at its longest heartbeat interval: the socket's
    /// receive timeout is set, and at least twice that interval.
    #[test]
    fn ws_receive_timeout_covers_the_longest_client_interval() {
        assert_eq!(
            super::WS_OPTIONS.receive_timeout,
            Some(super::WS_RECEIVE_TIMEOUT)
        );
        assert!(super::WS_RECEIVE_TIMEOUT >= 2 * MAX_CLIENT_HEARTBEAT_INTERVAL);
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod config_paths {
    //! Path config never collapses to `/`: empty values read as unset, and
    //! `resolve_dir` errors rather than falling back to an empty string.

    use super::*;

    #[test]
    fn empty_and_whitespace_values_read_as_unset() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some(String::new())), None);
        assert_eq!(non_empty(Some(" \t".to_owned())), None);
        assert_eq!(non_empty(Some("x".to_owned())).as_deref(), Some("x"));
    }

    #[test]
    fn session_cookie_name_is_per_port() {
        assert_eq!(session_cookie_name_for_port(4460), "zzz_session_4460");
        assert_ne!(
            session_cookie_name_for_port(4460),
            session_cookie_name_for_port(4461)
        );
    }

    #[test]
    fn invalid_ports_refuse_to_boot() {
        assert_eq!(parse_port("--port", "4460").unwrap(), 4460);
        assert_eq!(parse_port("ZZZ_PORT", " 65535 ").unwrap(), 65535);
        for bad in ["", "0", "65536", "-1", "44x60", "4460.0"] {
            match parse_port("ZZZ_PORT", bad) {
                Err(message) => {
                    assert!(message.contains("ZZZ_PORT"), "{message}");
                }
                other => panic!("{bad:?} should be refused, got {:?}", other.ok()),
            }
        }
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn config_error(result: Result<CliArgs, ArgsError>) -> String {
        match result {
            Err(ArgsError::Invalid(message)) => message,
            other => panic!("expected a config error, got {other:?}"),
        }
    }

    #[test]
    fn args_take_separate_and_inline_values() {
        assert_eq!(parse_args(args(&[])).unwrap(), CliArgs::default());
        let expected = CliArgs {
            port: Some(5000),
            static_dir: Some(PathBuf::from("/ui")),
        };
        assert_eq!(
            parse_args(args(&["--port", "5000", "--static-dir", "/ui"])).unwrap(),
            expected
        );
        assert_eq!(
            parse_args(args(&["--port=5000", "--static-dir=/ui"])).unwrap(),
            expected
        );
        // the last of a repeated flag wins; `=` inside a value is kept
        assert_eq!(
            parse_args(args(&["--port", "1", "--port=2", "--static-dir=a=b"])).unwrap(),
            CliArgs {
                port: Some(2),
                static_dir: Some(PathBuf::from("a=b")),
            }
        );
    }

    #[test]
    fn unknown_and_malformed_args_are_refused() {
        for (list, needle) in [
            (&["--prot", "5000"][..], "unknown argument \"--prot\""),
            (&["--prot=5000"][..], "unknown argument \"--prot=5000\""),
            (&["serve"][..], "unknown argument \"serve\""),
            (&["-p", "5000"][..], "unknown argument \"-p\""),
            (&["--help=x"][..], "unknown argument \"--help=x\""),
            (
                &["--bogus"][..],
                "(options: [--port <port>] [--static-dir <dir>])",
            ),
            (&["--port"][..], "--port requires a value"),
            (&["--static-dir"][..], "--static-dir requires a value"),
            (
                &["--static-dir", ""][..],
                "--static-dir requires a non-empty value",
            ),
            (
                &["--static-dir="][..],
                "--static-dir requires a non-empty value",
            ),
            (&["--port=0"][..], "expected a port in 1..=65535"),
            (&["--port", "65536"][..], "expected a port in 1..=65535"),
            (&["--port="][..], "expected a port in 1..=65535"),
        ] {
            let message = config_error(parse_args(args(list)));
            assert!(message.contains(needle), "{list:?}: {message}");
        }
    }

    #[test]
    fn help_is_requested_not_an_error() {
        for list in [&["--help"][..], &["-h"], &["--port", "5000", "-h"]] {
            assert!(
                matches!(parse_args(args(list)), Err(ArgsError::HelpRequested)),
                "{list:?}"
            );
        }
        // a flag's value is never taken for help
        assert_eq!(
            parse_args(args(&["--static-dir", "--help"]))
                .unwrap()
                .static_dir,
            Some(PathBuf::from("--help"))
        );
    }

    #[test]
    fn non_utf8_args_never_panic() {
        use std::os::unix::ffi::OsStringExt as _;
        let bad = || OsString::from_vec(vec![b'x', 0xff]);

        // a static dir may be any bytes, in either form
        let mut inline = b"--static-dir=".to_vec();
        inline.extend([b'x', 0xff]);
        for list in [
            vec![OsString::from("--static-dir"), bad()],
            vec![OsString::from_vec(inline)],
        ] {
            assert_eq!(
                parse_args(list).unwrap().static_dir,
                Some(PathBuf::from(bad()))
            );
        }
        // anything else is a clear error
        let message = config_error(parse_args([bad()]));
        assert!(message.contains("not valid UTF-8"), "{message}");
        let message = config_error(parse_args([OsString::from("--port"), bad()]));
        assert!(message.contains("--port is not valid UTF-8"), "{message}");
    }

    #[test]
    fn blank_test_actions_flag_reads_as_unset() {
        for unset in [None, Some(""), Some("  ")] {
            assert!(!parse_test_actions_flag(unset).unwrap(), "{unset:?}");
        }
        assert!(parse_test_actions_flag(Some("1")).unwrap());
        assert!(parse_test_actions_flag(Some("TRUE")).unwrap());
        assert!(!parse_test_actions_flag(Some("off")).unwrap());
        let Err(StartupError::Config(message)) = parse_test_actions_flag(Some("maybe")) else {
            panic!("an unknown value errors");
        };
        assert!(message.contains("ZZZ_ENABLE_TEST_ACTIONS"), "{message}");
    }

    #[test]
    fn resolve_dir_rejects_an_empty_path() {
        assert!(matches!(
            resolve_dir(Path::new("")),
            Err(StartupError::Config(_))
        ));
    }

    #[test]
    fn resolve_dir_makes_paths_absolute_with_a_trailing_slash() {
        let cwd = std::env::current_dir().unwrap();
        let resolved = resolve_dir(Path::new("no_such_dir_for_resolve_dir")).unwrap();
        assert_eq!(
            resolved,
            format!("{}/no_such_dir_for_resolve_dir/", cwd.display())
        );
        assert_ne!(resolved, "/");
        assert_eq!(resolve_dir(Path::new("/")).unwrap(), "/");
    }

    /// A unique temp dir removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("zzz_config_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.canonicalize().unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ensure_app_dir_creates_a_missing_app_dir_with_parents() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new();
        let dir = tmp.0.join("a/b/app");
        let resolved = ensure_app_dir(&dir).unwrap();
        assert_eq!(resolved, format!("{}/", dir.display()));
        let meta = std::fs::metadata(&dir).unwrap();
        assert!(meta.is_dir());
        assert_eq!(meta.permissions().mode() & 0o077, 0);
        // idempotent on an existing dir
        assert_eq!(ensure_app_dir(&dir).unwrap(), resolved);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_app_dir_resolves_through_symlinked_parents() {
        let tmp = TempDir::new();
        std::fs::create_dir(tmp.0.join("real")).unwrap();
        std::os::unix::fs::symlink(tmp.0.join("real"), tmp.0.join("link")).unwrap();
        let resolved = ensure_app_dir(&tmp.0.join("link/app")).unwrap();
        assert_eq!(resolved, format!("{}/", tmp.0.join("real/app").display()));
    }

    #[test]
    fn the_app_dir_must_not_be_the_working_directory() {
        let tmp = TempDir::new();
        let home = tmp.0.join(".zzz");
        let app = ensure_app_dir(&home.join(".zzz")).unwrap();
        let home_dir = ensure_app_dir(&home).unwrap();

        let Err(StartupError::Config(message)) = check_app_dir_is_not_cwd(&home_dir, &home) else {
            panic!("expected the daemon home to be refused as the app dir");
        };
        assert!(message.contains("PUBLIC_ZZZ_DIR"), "{message}");
        assert!(message.contains(&home_dir), "{message}");
        // a subdirectory, the default, is fine
        assert!(check_app_dir_is_not_cwd(&app, &home).is_ok());
        // so is an unrelated directory
        assert!(check_app_dir_is_not_cwd(&app, &tmp.0).is_ok());
    }

    #[test]
    fn scoped_dirs_in_a_zzz_home_refuse_to_boot() {
        let app = "/home/u/.zzz/.zzz/";
        for dir in ["/home/u/.zzz/", "/home/u/.zzz/run/", "/w/.zzz/"] {
            let Err(StartupError::Config(message)) =
                check_scoped_dirs(&["/w/ok/".to_owned(), dir.to_owned()], app)
            else {
                panic!("expected {dir} to be refused");
            };
            assert!(message.contains("PUBLIC_ZZZ_SCOPED_DIRS"), "{message}");
            assert!(message.contains(dir), "{message}");
        }
        let fine = [
            "/home/u/".to_owned(),
            "/home/u/.zzz/.zzz/".to_owned(),
            "/home/u/.zzz/.zzz/state/".to_owned(),
        ];
        assert!(check_scoped_dirs(&fine, app).is_ok());
    }

    #[test]
    fn ensure_app_dir_errors_clearly_when_the_path_is_a_file() {
        let tmp = TempDir::new();
        let file = tmp.0.join("file");
        std::fs::write(&file, "x").unwrap();
        let Err(StartupError::Config(message)) = ensure_app_dir(&file) else {
            panic!("expected a config error");
        };
        assert!(message.contains("can't create app directory"), "{message}");
        assert!(message.contains(&file.display().to_string()), "{message}");
        assert!(matches!(
            ensure_app_dir(Path::new("")),
            Err(StartupError::Config(_))
        ));
    }
}
