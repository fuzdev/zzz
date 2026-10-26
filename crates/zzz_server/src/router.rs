//! The router `run_app` serves: zzz's surfaces composed by
//! `fuz_http::compose_stack` into route groups, each behind the stack's
//! fixed order, outermost first:
//!
//! ```text
//! body cap → host_layer → origin_layer → simple_request_layer
//!     → client_ip_middleware → handler
//! ```
//!
//! ## Groups
//!
//! - `rpc` — `/api/rpc` and `/api/ws`, capped at [`crate::RPC_MESSAGE_MAX_BYTES`]
//! - `file_bytes` — [`crate::file_bytes::FILE_BYTES_PATH`], capped at
//!   [`FILE_BYTES_MAX_BODY_BYTES`]
//! - `account` — `/api/account/*` (account, bootstrap, signup)
//! - `health_and_audit` — `/health` and `/api/admin/audit/stream`
//! - the fallback — every unrouted path: the built frontend, if any
//!
//! The last three are capped at `DEFAULT_BODY_LIMIT_BYTES`.
//!
//! Every path sits in exactly one group (a path split across groups would
//! answer a method neither routes with a `405` outside both groups' gates).
//! The WebSocket upgrade is a body-less `GET`, so it shares the RPC group; its
//! message cap is the socket's own (`WS_OPTIONS` in the crate root). The
//! static fallback takes no body, and the cap there only bounds what an
//! unrouted request may declare.
//!
//! ## Every group carries every gate
//!
//! - **Body cap** — outside the other gates in each group, so a declared
//!   `Content-Length` over the group's cap answers `413` whatever the
//!   request's `Host`, `Origin`, content type, or credentials. No group owns
//!   its cap in its handlers.
//! - **Host** (`StackOptions::host_gate`) — a `Host` that isn't loopback or
//!   named by an allowed origin is `403 forbidden_host`: a DNS-rebinding page
//!   talks to `zzzd` same-origin, sending no `Origin`, but its `Host` is its
//!   own domain.
//! - **Origin** — a disallowed `Origin` is `403 forbidden_origin` on every
//!   path, the static frontend and the unrouted `404` included. No group is
//!   carved out. A request with no `Origin` passes (a non-browser client, or
//!   a same-origin `GET` such as a media element's `src`). The spine handlers,
//!   and the byte routes, check it again in-handler through the
//!   [`fuz_auth::AuthGate`].
//! - **CORS simple requests** — every group refuses a `POST` a browser could
//!   send cross-origin without a preflight (no `Content-Type`, or a form or
//!   text one: `415 unsupported_content_type`). The session cookie is
//!   `SameSite=Strict`, but same-site ignores the port, so a page on another
//!   `localhost` port would send it. zzz takes no form or multipart bodies —
//!   JSON calls send `application/json` and byte uploads
//!   `application/octet-stream` — so nothing legitimate is lost.
//! - **Client IP** — innermost, unconditionally: with an empty trusted-proxy
//!   set every connection fails the trust check, so the spoofable
//!   `X-Forwarded-For` is ignored and `ClientIp` is the TCP peer. Without the
//!   layer the IP-keyed limiters would bucket every caller under
//!   `fuz_http::UNRESOLVED_CLIENT_IP`, and each bearer touch of `api_token`
//!   would record that sentinel as `last_used_ip`.
//!
//! Request tracing is off: zzz logged no per-request line before the stack,
//! and a media element seeking through a recording, or an upload appending a
//! chunk every few seconds, would fill the daemon log with them.
//!
//! A new top-level backend route (beside `/api` and `/health`) must also be
//! added to [`crate::static_files::BACKEND_PATH_PREFIXES`], or its unknown
//! subpaths get the SPA shell.

use std::path::Path;
use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use fuz_auth::AuthGate;
use fuz_http::{
    BodyCap, DEFAULT_BODY_LIMIT_BYTES, GatedRouter, ParsedProxy, RouteGroup, StackOptions,
    compose_stack,
};
use serde::Serialize;

use crate::file_bytes::FILE_BYTES_MAX_BODY_BYTES;
use crate::static_files;

/// The surfaces `run_app` builds, each a router carrying its own state and no
/// layers — [`compose_router`] puts them in their groups.
pub struct SurfaceRouters {
    /// `fuz_actions::create_rpc_router` — `/rpc`, nested at `/api`.
    pub rpc: Router,
    /// `fuz_actions::register_action_ws_with_options` — `/ws`, nested at `/api`.
    pub ws: Router,
    /// `fuz_auth::account_router` — nested at `/api/account`.
    pub account: Router,
    /// `fuz_auth::bootstrap_routes::bootstrap_router` — nested at `/api/account`.
    pub bootstrap: Router,
    /// `fuz_auth::signup_routes::signup_router` — nested at `/api/account`.
    pub signup: Router,
    /// `fuz_realtime::audit_stream_router` — at its absolute path.
    pub audit_stream: Router,
    /// [`crate::file_bytes::file_bytes_router`] — at its absolute path.
    pub file_bytes: Router,
}

/// The stack options every group shares: the gate's allowlist and the trusted
/// proxies, the host gate on, request tracing off (module doc).
pub fn zzz_stack_options(gate: &AuthGate, trusted_proxies: Arc<Vec<ParsedProxy>>) -> StackOptions {
    let mut options = gate.stack_options(trusted_proxies);
    options.host_gate = true;
    options.request_tracing = false;
    options
}

/// Compose zzz's router: the groups in the module doc's table, and the built
/// frontend in `static_dir` as the fallback (without one, unrouted paths get
/// axum's empty `404` — dev, where Vite serves the frontend).
pub fn compose_router(
    surfaces: SurfaceRouters,
    static_dir: Option<&Path>,
    options: &StackOptions,
) -> GatedRouter {
    let SurfaceRouters {
        rpc,
        ws,
        account,
        bootstrap,
        signup,
        audit_stream,
        file_bytes,
    } = surfaces;

    // `RPC_MESSAGE_MAX_BYTES` request-body cap, shared with the `/api/ws`
    // message cap; larger and binary content goes over the byte routes.
    let rpc_group = RouteGroup::new(
        "rpc",
        Router::new().nest("/api", rpc.merge(ws)),
        BodyCap::Bytes(crate::RPC_MESSAGE_MAX_BYTES),
    )
    .refuse_simple_requests();
    let file_bytes_group = RouteGroup::new(
        "file_bytes",
        file_bytes,
        BodyCap::Bytes(FILE_BYTES_MAX_BODY_BYTES),
    )
    .refuse_simple_requests();
    // The three account routers expose disjoint paths under one prefix.
    let account_group = RouteGroup::new(
        "account",
        Router::new().nest("/api/account", account.merge(bootstrap).merge(signup)),
        BodyCap::Bytes(DEFAULT_BODY_LIMIT_BYTES),
    )
    .refuse_simple_requests();
    let health_and_audit_group = RouteGroup::new(
        "health_and_audit",
        Router::new()
            .route("/health", get(health_handler))
            .merge(audit_stream),
        BodyCap::Bytes(DEFAULT_BODY_LIMIT_BYTES),
    )
    .refuse_simple_requests();
    // The built frontend — exact files, then prerendered pages, then the SPA
    // shell (see `static_files`).
    let fallback = RouteGroup::new(
        "fallback",
        static_dir.map_or_else(Router::new, static_files::static_router),
        BodyCap::Bytes(DEFAULT_BODY_LIMIT_BYTES),
    )
    .refuse_simple_requests();

    compose_stack(
        [
            rpc_group,
            file_bytes_group,
            account_group,
            health_and_audit_group,
        ],
        fallback,
        options,
    )
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[cfg(test)]
mod tests {
    //! The composed router's gates, driven in-process over the real surface
    //! routers on a pool that never connects: every case here is refused (or
    //! answered) before anything reads the database.

    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;

    use axum::body::Body;
    use axum::extract::ConnectInfo;
    use axum::http::{Request, StatusCode};
    use fuz_http::AllowedOrigins;
    use tower::ServiceExt as _;

    use super::*;
    use crate::file_bytes::{FILE_BYTES_PATH, FileBytesRouteState};
    use crate::handlers::App;

    const ALLOWED_ORIGIN: &str = "http://localhost:4460";
    const FOREIGN_ORIGIN: &str = "http://localhost:5555";
    const COOKIE_KEY: &str = "a-cookie-signing-key-that-is-long-enough-to-pass";
    const SPA_SHELL: &str = "<!doctype html>shell";

    fn test_gate() -> AuthGate {
        AuthGate {
            pool: fuz_db::create_pool("postgres://localhost:1/zzz_router_unused")
                .expect("a lazy pool builds without connecting"),
            keyring: Arc::new(fuz_auth::Keyring::new(COOKIE_KEY).expect("keyring builds")),
            daemon_token_state: None,
            session_cookie_name: "zzz_session_4460",
            allowed_origins: AllowedOrigins::parse(ALLOWED_ORIGIN).expect("origins parse"),
        }
    }

    /// The real surface routers over inert state, the way `run_app` builds
    /// them (no limiters, no bootstrap token).
    fn surfaces(gate: &AuthGate) -> SurfaceRouters {
        let pool = gate.pool.clone();
        let realtime = Arc::new(fuz_realtime::ConnectionRegistry::new());
        let audit_sse = Arc::new(fuz_realtime::SseRegistry::new());
        let audit = Arc::new(fuz_auth::AuditEmitter::new(pool.clone()));
        let socket_revoker = fuz_realtime::RealtimeRevoker::socket_revoker(&realtime, &audit_sse);
        let password_hasher: Arc<dyn fuz_auth::PasswordHasher> =
            Arc::new(fuz_auth::Argon2idHasher::new());
        let bootstrap_available = Arc::new(AtomicBool::new(false));
        let registry = Arc::new(
            fuz_actions::ActionRegistry::compile(fuz_actions::PROTOCOL_ACTION_SPECS())
                .expect("the protocol specs compile"),
        );
        let app = Arc::new(App::new(
            pool.clone(),
            crate::scoped_fs::ScopedFs::new(vec![]),
            String::new(),
            vec![],
            crate::provider::ProviderManager::new(),
            false,
            Arc::clone(&realtime),
            Arc::clone(&audit),
        ));
        SurfaceRouters {
            rpc: fuz_actions::create_rpc_router(fuz_actions::RpcRouteState {
                gate: gate.clone(),
                registry: Arc::clone(&registry),
                audit: Arc::clone(&audit),
                socket_revoker: Arc::clone(&socket_revoker),
                notification_sender: Arc::clone(&realtime).into_notification_sender(),
                account_rate_limiter: None,
                ip_rate_limiter: None,
            }),
            ws: fuz_actions::register_action_ws_with_options(
                fuz_actions::WsRouteState {
                    gate: gate.clone(),
                    registry,
                    audit: Arc::clone(&audit),
                    socket_revoker: Arc::clone(&socket_revoker),
                    notification_sender: Arc::clone(&realtime).into_notification_sender(),
                    connection_registry: Arc::clone(&realtime),
                    account_rate_limiter: None,
                    ip_rate_limiter: None,
                    required_roles: Vec::new(),
                },
                crate::WS_OPTIONS,
            ),
            account: fuz_auth::account_router(fuz_auth::AccountRouteState {
                gate: gate.clone(),
                password_hasher: Arc::clone(&password_hasher),
                audit: Arc::clone(&audit),
                socket_revoker,
                bootstrap_available: Arc::clone(&bootstrap_available),
                login_ip_rate_limiter: None,
                login_account_rate_limiter: None,
                login_fail_floor_ms: fuz_auth::DEFAULT_LOGIN_FAIL_FLOOR_MS,
                login_fail_jitter_ms: fuz_auth::DEFAULT_LOGIN_FAIL_JITTER_MS,
            }),
            bootstrap: fuz_auth::bootstrap_routes::bootstrap_router(
                fuz_auth::BootstrapRouteState {
                    options: Arc::new(fuz_auth::BootstrapOptions {
                        pool: pool.clone(),
                        password_hasher: Arc::clone(&password_hasher),
                        audit: Arc::clone(&audit),
                        bootstrap_available,
                        token_store: None,
                        on_keeper_resolved: None,
                    }),
                    gate: gate.clone(),
                },
            ),
            signup: fuz_auth::signup_routes::signup_router(fuz_auth::SignupRouteState {
                options: Arc::new(fuz_auth::SignupOptions {
                    pool,
                    password_hasher,
                    audit,
                    signup_ip_rate_limiter: None,
                    signup_account_rate_limiter: None,
                    signup_fail_floor_ms: fuz_auth::DEFAULT_SIGNUP_FAIL_FLOOR_MS,
                    signup_fail_jitter_ms: fuz_auth::DEFAULT_SIGNUP_FAIL_JITTER_MS,
                }),
                gate: gate.clone(),
            }),
            audit_stream: fuz_realtime::audit_stream_router(
                fuz_realtime::AuditStreamRouteState::new(gate.clone(), audit_sse),
            ),
            file_bytes: crate::file_bytes::file_bytes_router(FileBytesRouteState {
                app,
                gate: gate.clone(),
            }),
        }
    }

    /// A built frontend in a temporary directory: a prerendered root and the
    /// SPA shell.
    struct StaticDir {
        root: PathBuf,
    }

    impl StaticDir {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("zzz_router_test_{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("index.html"), "<!doctype html>index").unwrap();
            fs::write(root.join(static_files::SPA_FALLBACK_FILE), SPA_SHELL).unwrap();
            Self { root }
        }
    }

    impl Drop for StaticDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn router(static_dir: Option<&Path>) -> GatedRouter {
        let gate = test_gate();
        let options = zzz_stack_options(&gate, Arc::new(Vec::new()));
        compose_router(surfaces(&gate), static_dir, &options)
    }

    /// Both fallbacks — no static dir (dev) and a built frontend —
    /// labelled for the assertion messages. The `StaticDir` lives as long as
    /// the routers.
    fn both_routers() -> (StaticDir, [(&'static str, GatedRouter); 2]) {
        let dir = StaticDir::new();
        let routers = [
            ("no static dir", router(None)),
            ("static", router(Some(&dir.root))),
        ];
        (dir, routers)
    }

    struct Probe<'a> {
        method: &'a str,
        uri: &'a str,
        origin: Option<&'a str>,
        host: Option<&'a str>,
        content_type: Option<&'a str>,
        content_length: Option<usize>,
    }

    impl<'a> Probe<'a> {
        const fn new(method: &'a str, uri: &'a str) -> Self {
            Self {
                method,
                uri,
                origin: None,
                host: None,
                content_type: None,
                content_length: None,
            }
        }

        const fn origin(mut self, origin: &'a str) -> Self {
            self.origin = Some(origin);
            self
        }

        const fn host(mut self, host: &'a str) -> Self {
            self.host = Some(host);
            self
        }

        const fn content_type(mut self, content_type: &'a str) -> Self {
            self.content_type = Some(content_type);
            self
        }

        /// Declare a `Content-Length` with no body behind it — the cap reads
        /// only the header.
        const fn content_length(mut self, length: usize) -> Self {
            self.content_length = Some(length);
            self
        }
    }

    /// Send one request, with the TCP peer `serve_with_shutdown` supplies,
    /// and return the status and body.
    async fn send(router: GatedRouter, probe: Probe<'_>) -> (StatusCode, String) {
        let mut builder = Request::builder().method(probe.method).uri(probe.uri);
        if let Some(origin) = probe.origin {
            builder = builder.header("origin", origin);
        }
        if let Some(host) = probe.host {
            builder = builder.header("host", host);
        }
        if let Some(content_type) = probe.content_type {
            builder = builder.header("content-type", content_type);
        }
        if let Some(length) = probe.content_length {
            builder = builder.header("content-length", length.to_string());
        }
        let mut req = builder.body(Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:50000".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let res = router.into_router_for_testing().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    /// A path under the byte routes, with a well-formed query.
    fn bytes_uri() -> String {
        format!("{FILE_BYTES_PATH}?path=/nowhere/file.bin")
    }

    #[tokio::test]
    async fn a_foreign_origin_is_refused_on_every_group_and_unrouted_paths() {
        let bytes = bytes_uri();
        let (_dir, routers) = both_routers();
        for (label, router) in routers {
            for (method, uri) in [
                ("GET", "/health"),
                ("GET", "/"),
                ("GET", "/chats/some-id"),
                ("GET", "/nope"),
                ("GET", "/api/nope"),
                ("GET", "/api/rpc"),
                ("POST", "/api/rpc"),
                ("GET", "/api/ws"),
                ("GET", "/api/account/status"),
                ("POST", "/api/account/login"),
                ("GET", "/api/admin/audit/stream"),
                ("GET", bytes.as_str()),
                ("POST", bytes.as_str()),
            ] {
                // a forged `text/plain` body: the origin check answers ahead
                // of the simple-request gate, so a group out of the origin
                // check would answer 415 here instead
                let probe = Probe::new(method, uri)
                    .origin(FOREIGN_ORIGIN)
                    .content_type("text/plain");
                let (status, body) = send(router.clone(), probe).await;
                assert_eq!(
                    status,
                    StatusCode::FORBIDDEN,
                    "{label} {method} {uri}: {body}"
                );
                assert_eq!(
                    body, r#"{"error":"forbidden_origin"}"#,
                    "{label} {method} {uri}"
                );
            }
        }
    }

    #[tokio::test]
    async fn an_absent_or_allowed_origin_passes_the_check() {
        let (_dir, routers) = both_routers();
        for (label, router) in routers {
            for origin in [None, Some(ALLOWED_ORIGIN)] {
                let mut health = Probe::new("GET", "/health");
                let mut unrouted = Probe::new("GET", "/api/nope");
                if let Some(origin) = origin {
                    health = health.origin(origin);
                    unrouted = unrouted.origin(origin);
                }
                let (status, body) = send(router.clone(), health).await;
                assert_eq!(status, StatusCode::OK, "{label} {origin:?}");
                assert_eq!(body, r#"{"status":"ok"}"#, "{label} {origin:?}");
                let (status, _) = send(router.clone(), unrouted).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{label} {origin:?}");
            }
        }
    }

    #[tokio::test]
    async fn the_built_frontend_is_the_fallback_behind_the_gates() {
        let dir = StaticDir::new();
        let (status, body) = send(router(Some(&dir.root)), Probe::new("GET", "/chats/x")).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, SPA_SHELL));
        let probe = Probe::new("GET", "/chats/x").origin(ALLOWED_ORIGIN);
        let (status, body) = send(router(Some(&dir.root)), probe).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, SPA_SHELL));
        // without a static dir, an unrouted path is axum's empty 404
        let (status, body) = send(router(None), Probe::new("GET", "/chats/x")).await;
        assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, ""));
    }

    #[tokio::test]
    async fn a_declared_over_cap_body_is_413_ahead_of_the_origin_check() {
        let bytes = bytes_uri();
        let (_dir, routers) = both_routers();
        for (label, router) in routers {
            for (uri, cap) in [
                ("/health", DEFAULT_BODY_LIMIT_BYTES),
                ("/nope", DEFAULT_BODY_LIMIT_BYTES),
                ("/api/nope", DEFAULT_BODY_LIMIT_BYTES),
                ("/api/account/login", DEFAULT_BODY_LIMIT_BYTES),
                ("/api/admin/audit/stream", DEFAULT_BODY_LIMIT_BYTES),
                ("/api/rpc", crate::RPC_MESSAGE_MAX_BYTES),
                (bytes.as_str(), FILE_BYTES_MAX_BODY_BYTES),
            ] {
                // a foreign `Origin`, a foreign `Host`, and a form body: every
                // other gate would refuse it, and the cap answers first
                let probe = Probe::new("POST", uri)
                    .origin(FOREIGN_ORIGIN)
                    .host("evil.example")
                    .content_type("application/x-www-form-urlencoded")
                    .content_length(cap + 1);
                let (status, body) = send(router.clone(), probe).await;
                assert_eq!(
                    status,
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "{label} {uri}: {body}"
                );
                assert_eq!(body, r#"{"error":"payload_too_large"}"#, "{label} {uri}");
            }
        }
    }

    #[tokio::test]
    async fn each_group_is_held_to_its_own_cap() {
        // over the 1 MiB default and under the RPC and byte-route caps: the
        // account route refuses the size, the RPC and byte routes go on to the
        // origin check
        let len = DEFAULT_BODY_LIMIT_BYTES + 1;
        let probe = Probe::new("POST", "/api/account/login")
            .origin(FOREIGN_ORIGIN)
            .content_length(len);
        let (status, _) = send(router(None), probe).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        let bytes = bytes_uri();
        for uri in ["/api/rpc", bytes.as_str()] {
            let probe = Probe::new("POST", uri)
                .origin(FOREIGN_ORIGIN)
                .content_type("application/json")
                .content_length(len);
            let (status, body) = send(router(None), probe).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        }
    }

    #[tokio::test]
    async fn a_foreign_host_is_refused_on_every_group_and_unrouted_paths() {
        let bytes = bytes_uri();
        let (_dir, routers) = both_routers();
        for (label, router) in routers {
            for uri in [
                "/health",
                "/nope",
                "/api/rpc",
                "/api/account/status",
                bytes.as_str(),
            ] {
                let probe = Probe::new("GET", uri).host("rebound.example:4460");
                let (status, body) = send(router.clone(), probe).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{label} {uri}: {body}");
                assert_eq!(body, r#"{"error":"forbidden_host"}"#, "{label} {uri}");
            }
        }
    }

    #[tokio::test]
    async fn every_group_refuses_a_cors_simple_post() {
        let bytes = bytes_uri();
        let (_dir, routers) = both_routers();
        for (label, router) in routers {
            for uri in [
                "/health",
                "/nope",
                "/api/rpc",
                "/api/account/login",
                "/api/admin/audit/stream",
                bytes.as_str(),
            ] {
                for content_type in [
                    None,
                    Some("text/plain"),
                    Some("multipart/form-data; boundary=x"),
                ] {
                    let mut probe = Probe::new("POST", uri).origin(ALLOWED_ORIGIN);
                    if let Some(content_type) = content_type {
                        probe = probe.content_type(content_type);
                    }
                    let (status, body) = send(router.clone(), probe).await;
                    assert_eq!(
                        status,
                        StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        "{label} {uri} {content_type:?}: {body}"
                    );
                }
            }
        }
    }
}
