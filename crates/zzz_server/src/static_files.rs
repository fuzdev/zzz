//! Serving the built frontend from `--static-dir` / `ZZZ_STATIC_DIR`.
//!
//! The frontend is a `SvelteKit` adapter-static build: prerendered pages
//! (`index.html`, `chats.html`, `docs/api.html`, …), hashed assets under
//! `_app/`, and an SPA fallback shell ([`SPA_FALLBACK_FILE`]) that routes
//! everything else client-side — dynamic routes like `/chats/<id>` are never
//! prerendered. A GET or HEAD resolves in order:
//!
//! 1. the exact file (`/favicon.png`, `/_app/immutable/…`) — a directory
//!    never matches, so `/docs` isn't redirected to a `/docs/` with no index
//! 2. the prerendered page — `{path}.html`, or `{path}index.html` when the
//!    path ends in `/` (so `/` serves `index.html`)
//! 3. the fallback shell
//!
//! Backend paths ([`BACKEND_PATH_PREFIXES`] and below) never get the shell —
//! the router mounts every real backend route ahead of this fallback, so a
//! request reaching here under `/api` is an unknown route and 404s. A missing
//! `_app/` asset 404s too instead of answering a script import with HTML, so a
//! tab left open across a rebuild fails the chunk load (which `SvelteKit` turns
//! into a full reload) rather than executing the shell as JavaScript. Other
//! methods get `405`.
//!
//! Path safety: both path probes go through `ServeDir`, which percent-decodes
//! the path and rejects `..`, root, and drive-prefix components before
//! touching the filesystem. The `.html` / `index.html` suffix is appended to
//! the still-encoded URI path, so it only ever extends the final segment of a
//! path `ServeDir` then validates — a rejected path falls through to the
//! shell (or 404s under `_app/`), never to a file outside the directory. The
//! shell itself is a fixed file: `ServeFile` ignores the request path.
//! `ServeDir` follows symlinks
//! inside the static dir — the dir is trusted operator content (the build
//! output), not user-writable input.
//!
//! Caching: `_app/immutable/` responses are content-hashed and cached for a
//! year as `immutable`; everything else is `no-cache` (revalidated through
//! `Last-Modified`), so a rebuild is picked up on the next load.

use std::convert::Infallible;
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use tower::{Service, ServiceExt};
use tower_http::services::fs::ServeFileSystemResponseBody;
use tower_http::services::{ServeDir, ServeFile};

/// The SPA fallback shell's filename — must match `fallback` in
/// `svelte.config.js`.
pub const SPA_FALLBACK_FILE: &str = "200.html";

/// Backend path prefixes that never get the fallback shell. Each matches the
/// exact path and everything below it (`/api`, `/api/…`), not siblings
/// (`/apiary`).
pub const BACKEND_PATH_PREFIXES: [&str; 2] = ["/api", "/health"];

/// Build-output assets — a miss under here 404s rather than serving the shell.
const ASSET_PATH_PREFIX: &str = "/_app/";

/// Content-hashed build output — safe to cache forever.
const IMMUTABLE_PATH_PREFIX: &str = "/_app/immutable/";

const CACHE_CONTROL_IMMUTABLE: &str = "public, max-age=31536000, immutable";
const CACHE_CONTROL_NO_CACHE: &str = "no-cache";

#[derive(Debug, Clone)]
struct StaticFiles {
    dir: ServeDir,
    fallback: ServeFile,
}

/// Router serving the built frontend in `dir`, meant to be mounted as the
/// app's `fallback_service` so every backend route takes precedence. See the
/// module docs for the resolution order.
///
/// Warns (without failing) when `dir` has no [`SPA_FALLBACK_FILE`] — every
/// non-prerendered route then 404s.
pub fn static_router(dir: &Path) -> Router {
    let fallback_path = dir.join(SPA_FALLBACK_FILE);
    if !fallback_path.is_file() {
        tracing::warn!(
            path = %fallback_path.display(),
            "static dir has no SPA fallback page — routes that aren't prerendered will 404"
        );
    }
    let files = StaticFiles {
        dir: ServeDir::new(dir).append_index_html_on_directories(false),
        fallback: ServeFile::new(fallback_path),
    };
    Router::new().fallback(serve_static).with_state(files)
}

async fn serve_static(State(files): State<StaticFiles>, request: Request) -> Response {
    let (parts, _body) = request.into_parts();
    let path = parts.uri.path();
    if is_backend_path(path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if parts.method != Method::GET && parts.method != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, HeaderValue::from_static("GET, HEAD"))],
        )
            .into_response();
    }

    let response = serve(files.dir.clone(), &parts, parts.uri.clone()).await;
    if response.status() != StatusCode::NOT_FOUND || path.starts_with(ASSET_PATH_PREFIX) {
        return with_cache_control(path, response);
    }

    if let Some(page_uri) = prerendered_page_uri(path) {
        let response = serve(files.dir.clone(), &parts, page_uri).await;
        if response.status() != StatusCode::NOT_FOUND {
            return with_cache_control(path, response);
        }
    }

    with_cache_control(path, serve(files.fallback, &parts, parts.uri.clone()).await)
}

/// Whether `path` is a backend path — one of [`BACKEND_PATH_PREFIXES`] or
/// below it.
fn is_backend_path(path: &str) -> bool {
    BACKEND_PATH_PREFIXES.iter().any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// The prerendered page a path maps to: `{path}.html`, or `{path}index.html`
/// for a path ending in `/`. `None` if the result isn't a valid URI path.
fn prerendered_page_uri(path: &str) -> Option<Uri> {
    let page = if path.ends_with('/') {
        format!("{path}index.html")
    } else {
        format!("{path}.html")
    };
    Uri::builder().path_and_query(page).build().ok()
}

/// Run a `ServeDir`/`ServeFile` against a body-less copy of the request with
/// `uri` swapped in — method and headers (conditional, range, and
/// `Accept-Encoding`) carry over.
async fn serve<S>(service: S, parts: &Parts, uri: Uri) -> Response
where
    S: Service<Request<Body>, Response = Response<ServeFileSystemResponseBody>, Error = Infallible>,
{
    let mut request = Request::new(Body::empty());
    request.method_mut().clone_from(&parts.method);
    *request.uri_mut() = uri;
    request.headers_mut().clone_from(&parts.headers);
    let Ok(response) = service.oneshot(request).await;
    response.map(Body::new)
}

/// Set `Cache-Control` on a successful (or `304`) response: `immutable` under
/// `_app/immutable/`, `no-cache` otherwise. Errors pass through untouched so a
/// 404 is never cached as immutable.
fn with_cache_control(path: &str, mut response: Response) -> Response {
    let status = response.status();
    if !status.is_success() && status != StatusCode::NOT_MODIFIED {
        return response;
    }
    let value = if path.starts_with(IMMUTABLE_PATH_PREFIX) {
        CACHE_CONTROL_IMMUTABLE
    } else {
        CACHE_CONTROL_NO_CACHE
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use std::fs;
    use std::path::PathBuf;

    const INDEX: &str = "<!doctype html>index";
    const FALLBACK: &str = "<!doctype html>fallback";
    const CHATS: &str = "<!doctype html>chats";
    const DOCS: &str = "<!doctype html>docs";
    const DOCS_API: &str = "<!doctype html>docs api";
    const APP_JS: &str = "export const x = 1;";
    const IMMUTABLE_JS: &str = "export const y = 2;";
    const SECRET: &str = "outside the static dir";

    /// A temp root holding `static/` (a miniature adapter-static build) plus
    /// sibling files outside it for the traversal cases. Removed on drop.
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("zzz_static_files_test_{}", uuid::Uuid::new_v4()));
            let dir = root.join("static");
            fs::create_dir_all(dir.join("_app/immutable")).unwrap();
            fs::create_dir_all(dir.join("docs")).unwrap();
            fs::write(dir.join("index.html"), INDEX).unwrap();
            fs::write(dir.join(SPA_FALLBACK_FILE), FALLBACK).unwrap();
            fs::write(dir.join("chats.html"), CHATS).unwrap();
            // `docs.html` beside a `docs/` directory with no `index.html` —
            // the collision adapter-static produces for nested prerendered pages
            fs::write(dir.join("docs.html"), DOCS).unwrap();
            fs::write(dir.join("docs/api.html"), DOCS_API).unwrap();
            fs::write(dir.join("_app/x.js"), APP_JS).unwrap();
            fs::write(dir.join("_app/immutable/y.js"), IMMUTABLE_JS).unwrap();
            fs::write(root.join("secret.txt"), SECRET).unwrap();
            fs::write(root.join("secret.html"), SECRET).unwrap();
            Self { root }
        }

        fn dir(&self) -> PathBuf {
            self.root.join("static")
        }

        /// The static router composed the way `run_app` mounts it — behind a
        /// `/health` route and an `/api` nest.
        fn app(&self) -> Router {
            Router::new()
                .route("/health", get(|| async { "ok" }))
                .nest(
                    "/api",
                    Router::new().route("/rpc", post(|| async { "rpc" })),
                )
                .fallback_service(static_router(&self.dir()))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct Probe {
        status: StatusCode,
        content_type: Option<String>,
        cache_control: Option<String>,
        body: String,
    }

    async fn request(app: Router, method: Method, uri: &str) -> Probe {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let content_type = header_string(&response, header::CONTENT_TYPE);
        let cache_control = header_string(&response, header::CACHE_CONTROL);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        Probe {
            status,
            content_type,
            cache_control,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    fn header_string(response: &Response, name: header::HeaderName) -> Option<String> {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_owned())
    }

    async fn get_path(fixture: &Fixture, uri: &str) -> Probe {
        request(fixture.app(), Method::GET, uri).await
    }

    fn assert_html(probe: &Probe, body: &str) {
        assert_eq!(probe.status, StatusCode::OK);
        assert_eq!(probe.body, body);
        assert!(
            probe
                .content_type
                .as_deref()
                .is_some_and(|value| value.starts_with("text/html")),
            "content-type: {:?}",
            probe.content_type
        );
        assert_eq!(probe.cache_control.as_deref(), Some("no-cache"));
    }

    #[tokio::test]
    async fn root_serves_index() {
        let fixture = Fixture::new();
        assert_html(&get_path(&fixture, "/").await, INDEX);
        assert_html(&get_path(&fixture, "/index.html").await, INDEX);
    }

    #[tokio::test]
    async fn prerendered_page_serves_its_html() {
        let fixture = Fixture::new();
        assert_html(&get_path(&fixture, "/chats").await, CHATS);
        assert_html(&get_path(&fixture, "/chats?x=1").await, CHATS);
        assert_html(&get_path(&fixture, "/chats.html").await, CHATS);
        assert_html(&get_path(&fixture, "/docs/api").await, DOCS_API);
    }

    #[tokio::test]
    async fn page_beside_same_named_directory_is_not_redirected() {
        let fixture = Fixture::new();
        assert_html(&get_path(&fixture, "/docs").await, DOCS);
        // no `docs/index.html`, so the trailing-slash form gets the shell
        assert_html(&get_path(&fixture, "/docs/").await, FALLBACK);
    }

    #[tokio::test]
    async fn unknown_routes_serve_the_fallback() {
        let fixture = Fixture::new();
        assert_html(
            &get_path(&fixture, "/chats/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d").await,
            FALLBACK,
        );
        assert_html(
            &get_path(&fixture, "/workspaces?workspace=/tmp/").await,
            FALLBACK,
        );
        assert_html(
            &get_path(&fixture, "/workspaces?workspace=%2Ftmp%2F").await,
            FALLBACK,
        );
        // dotted dynamic segments (model slugs) are routes, not assets
        assert_html(&get_path(&fixture, "/models/gpt-4.1").await, FALLBACK);
        assert_html(&get_path(&fixture, "/apiary").await, FALLBACK);
        assert_html(&get_path(&fixture, "/healthy").await, FALLBACK);
    }

    #[tokio::test]
    async fn assets_serve_with_cache_headers() {
        let fixture = Fixture::new();
        let probe = get_path(&fixture, "/_app/x.js").await;
        assert_eq!(probe.status, StatusCode::OK);
        assert_eq!(probe.body, APP_JS);
        assert!(probe.content_type.unwrap().contains("javascript"));
        assert_eq!(probe.cache_control.as_deref(), Some("no-cache"));

        let probe = get_path(&fixture, "/_app/immutable/y.js").await;
        assert_eq!(probe.status, StatusCode::OK);
        assert_eq!(probe.body, IMMUTABLE_JS);
        assert_eq!(
            probe.cache_control.as_deref(),
            Some("public, max-age=31536000, immutable")
        );
    }

    #[tokio::test]
    async fn missing_asset_404s_without_the_fallback() {
        let fixture = Fixture::new();
        for uri in ["/_app/missing.js", "/_app/immutable/missing.js"] {
            let probe = get_path(&fixture, uri).await;
            assert_eq!(probe.status, StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(probe.body, "", "{uri}");
            assert_eq!(probe.cache_control, None, "{uri}");
        }
    }

    #[tokio::test]
    async fn backend_paths_never_get_the_fallback() {
        let fixture = Fixture::new();
        for uri in ["/api", "/api/", "/api/nope", "/api/rpc/extra", "/health/x"] {
            for method in [Method::GET, Method::POST] {
                let probe = request(fixture.app(), method.clone(), uri).await;
                assert_eq!(probe.status, StatusCode::NOT_FOUND, "{method} {uri}");
                assert_eq!(probe.body, "", "{method} {uri}");
            }
        }
        // real backend routes still win over the static fallback
        let probe = get_path(&fixture, "/health").await;
        assert_eq!((probe.status, probe.body.as_str()), (StatusCode::OK, "ok"));
        let probe = request(fixture.app(), Method::POST, "/api/rpc").await;
        assert_eq!((probe.status, probe.body.as_str()), (StatusCode::OK, "rpc"));
    }

    #[tokio::test]
    async fn head_resolves_like_get_without_a_body() {
        let fixture = Fixture::new();
        for (uri, len) in [
            ("/", INDEX.len()),
            ("/chats", CHATS.len()),
            (
                "/chats/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                FALLBACK.len(),
            ),
        ] {
            let request = Request::builder()
                .method(Method::HEAD)
                .uri(uri)
                .body(Body::empty())
                .unwrap();
            let response = fixture.app().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                len.to_string().as_str(),
                "{uri}"
            );
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert!(bytes.is_empty(), "{uri}");
        }
        let probe = request(fixture.app(), Method::HEAD, "/_app/missing.js").await;
        assert_eq!(probe.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn other_methods_are_not_allowed() {
        let fixture = Fixture::new();
        for method in [Method::POST, Method::PUT, Method::DELETE] {
            let request = Request::builder()
                .method(method.clone())
                .uri("/chats")
                .body(Body::empty())
                .unwrap();
            let response = fixture.app().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method}"
            );
            assert_eq!(response.headers()[header::ALLOW], "GET, HEAD");
        }
    }

    #[tokio::test]
    async fn traversal_never_escapes_the_static_dir() {
        let fixture = Fixture::new();
        for uri in [
            "/../secret.txt",
            "/../secret",
            "/..%2Fsecret.txt",
            "/..%2fsecret",
            "/%2e%2e/secret.txt",
            "/%2E%2E%2Fsecret",
            "/_app/../../secret.txt",
            "/docs/%2e%2e/%2e%2e/secret",
            "/..",
            "/%2e%2e",
        ] {
            let probe = get_path(&fixture, uri).await;
            assert_ne!(probe.body, SECRET, "{uri} escaped the static dir");
            assert!(
                probe.status == StatusCode::NOT_FOUND || probe.body == FALLBACK,
                "{uri}: {} {:?}",
                probe.status,
                probe.body
            );
        }
    }

    #[tokio::test]
    async fn missing_fallback_file_404s() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.dir().join(SPA_FALLBACK_FILE)).unwrap();
        let probe = get_path(&fixture, "/chats/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d").await;
        assert_eq!(probe.status, StatusCode::NOT_FOUND);
        // prerendered pages still serve
        assert_html(&get_path(&fixture, "/chats").await, CHATS);
    }
}
