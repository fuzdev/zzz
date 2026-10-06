//! Byte routes for files: read a file's bytes (with `Range`), create a file
//! from bytes, and append bytes at an expected offset.
//!
//! The JSON-RPC actions carry file contents as UTF-8 strings inside one capped
//! message, which fits neither media nor a file that grows as it's recorded.
//! These are plain HTTP routes beside `/api/rpc` at [`FILE_BYTES_PATH`], all
//! taking the file as an absolute `?path=`:
//!
//! - `GET` / `HEAD` — the file's bytes. One `Range: bytes=` range is honored
//!   (`206`, or `416` when it starts past the end), which is what lets a media
//!   element seek.
//! - `POST` — create the file exclusively from the request body (which may be
//!   empty), like `diskfile_create`: `201 {"size"}`, or `409 already_exists`.
//! - `PATCH` with `?offset=` — append the body if the file is exactly `offset`
//!   bytes long: `200 {"size"}`, or `409 {"error": "offset_mismatch", "size"}`
//!   having written nothing. So a retried chunk is harmless (the reply's size
//!   says whether it already landed) and chunks can't interleave.
//!
//! ## Gates
//!
//! In order: the query's shape, authentication
//! ([`fuz_auth::resolve_auth_from_headers`] — any credential, like every
//! zzz-owned action), and the token scope (a method-scoped API token holds no
//! non-RPC surface). The router is mounted behind the Origin allowlist. Paths
//! go through [`ScopedFs`](crate::scoped_fs::ScopedFs): absolute, in scope, no
//! symlinks, regular files only. A write's body is read only after the gates
//! pass.
//!
//! These routes are outside the action system, so nothing derived from action
//! specs covers them: no audit row, no actions-log entry, no generated client,
//! and no entry in the `any_credential_surface` census.
//!
//! ## Serving bytes never executes them
//!
//! A file in a workspace is untrusted content, and a document rendered on
//! zzz's own origin could script the whole app. So a response is typed from a
//! fixed extension allowlist ([`media_content_type`]) — raster images, audio,
//! and video, never anything a browser renders as a document (no HTML, SVG, or
//! XML) and never by sniffing — and anything else is
//! `application/octet-stream` with `Content-Disposition: attachment`. Every
//! response carries `X-Content-Type-Options: nosniff`, a sandboxing
//! `Content-Security-Policy`, and `Cross-Origin-Resource-Policy: same-origin`.
//! Responses are `Cache-Control: no-store`: a path's bytes change under it (a
//! recording grows, a save replaces it), and no validators are sent.

use std::fmt::Write as _;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Extension, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use fuz_auth::route_helpers::extract_client_ip_or_unresolved;
use fuz_auth::{Keyring, SharedDaemonTokenState, resolve_auth_from_headers};
use fuz_http::{ClientIp, assert_known_query_keys, query_first};
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};

use crate::handlers::App;
use crate::handlers::filesystem::{ERROR_OFFSET_MISMATCH, scoped_fs_error};
use crate::scoped_fs::ScopedFsError;

/// The byte routes' path.
pub const FILE_BYTES_PATH: &str = "/api/files/bytes";

/// Largest body one `POST` or `PATCH` accepts.
///
/// The same bound as one JSON-RPC message ([`crate::RPC_MESSAGE_MAX_BYTES`]),
/// so a single request buffers no more here than anywhere else on the API. A
/// larger file is written as several appends.
pub const FILE_BYTES_MAX_BODY_BYTES: usize = crate::RPC_MESSAGE_MAX_BYTES;

/// Capability named in the `403` a method-scoped API token gets here.
pub const FILE_BYTES_SURFACE: &str = "surface:file_bytes";

/// How much of a file one read pulls into memory while streaming a response.
const READ_CHUNK_BYTES: usize = 64 * 1024;

const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; sandbox";

/// State for [`file_bytes_router`].
#[derive(Clone)]
pub struct FileBytesRouteState {
    pub app: Arc<App>,
    /// Cookie-signing keyring.
    pub keyring: Arc<Keyring>,
    /// `Some(_)` only in the test binary.
    pub daemon_token_state: Option<SharedDaemonTokenState>,
    pub session_cookie_name: &'static str,
}

impl std::fmt::Debug for FileBytesRouteState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileBytesRouteState")
            .field("session_cookie_name", &self.session_cookie_name)
            .finish_non_exhaustive()
    }
}

/// Router exposing the byte routes at their absolute path.
///
/// Merge it, don't nest it. The caller layers the Origin allowlist, the
/// client-IP middleware, and a [`FILE_BYTES_MAX_BODY_BYTES`] body limit over
/// it.
pub fn file_bytes_router(state: FileBytesRouteState) -> Router {
    Router::new()
        .route(
            FILE_BYTES_PATH,
            get(read_file_bytes)
                .post(create_file_bytes)
                .patch(append_file_bytes),
        )
        .with_state(state)
}

// -- Handlers -----------------------------------------------------------------

/// `GET` / `HEAD` — a file's bytes, whole or one range of them.
async fn read_file_bytes(
    State(state): State<FileBytesRouteState>,
    Query(query_pairs): Query<Vec<(String, String)>>,
    client_ip: Option<Extension<ClientIp>>,
    headers: HeaderMap,
) -> Response {
    let path = match parse_query(&query_pairs, &["path"]) {
        Ok(query) => query.path,
        Err(response) => return response,
    };
    if let Err(response) = authorize(&state, &headers, client_ip).await {
        return response;
    }
    let (file, meta) = match state.app.scoped_fs.open_file(path).await {
        Ok(opened) => opened,
        Err(e) => return scoped_fs_error_response("failed to read file", &e),
    };
    let size = meta.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let (status, start, len) = match resolve_range(range, size) {
        ByteRange::Full => (StatusCode::OK, 0, size),
        ByteRange::Partial { start, end } => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
        ByteRange::Unsatisfiable => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            set_header(
                &mut response,
                header::CONTENT_RANGE,
                &format!("bytes */{size}"),
            );
            apply_content_headers(&mut response, path);
            return response;
        }
    };

    let mut response = Response::new(file_body(tokio::fs::File::from_std(file), start, len));
    *response.status_mut() = status;
    set_header(&mut response, header::CONTENT_LENGTH, &len.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        set_header(
            &mut response,
            header::CONTENT_RANGE,
            &format!("bytes {start}-{}/{size}", start + len - 1),
        );
    }
    apply_content_headers(&mut response, path);
    response
}

/// `POST` — create a file exclusively from the request body.
async fn create_file_bytes(
    State(state): State<FileBytesRouteState>,
    Query(query_pairs): Query<Vec<(String, String)>>,
    client_ip: Option<Extension<ClientIp>>,
    request: Request,
) -> Response {
    let path = match parse_query(&query_pairs, &["path"]) {
        Ok(query) => query.path,
        Err(response) => return response,
    };
    if let Err(response) = authorize(&state, request.headers(), client_ip).await {
        return response;
    }
    let content = match read_body(request).await {
        Ok(content) => content,
        Err(response) => return response,
    };
    let size = content.len();
    match state.app.scoped_fs.create_file(path, content).await {
        Ok(()) => size_response(StatusCode::CREATED, size as u64),
        Err(e) => scoped_fs_error_response("failed to create file", &e),
    }
}

/// `PATCH` — append the request body at `?offset=`.
async fn append_file_bytes(
    State(state): State<FileBytesRouteState>,
    Query(query_pairs): Query<Vec<(String, String)>>,
    client_ip: Option<Extension<ClientIp>>,
    request: Request,
) -> Response {
    let query = match parse_query(&query_pairs, &["path", "offset"]) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let Some(offset) = query.offset else {
        return fuz_http::invalid_query_params_response();
    };
    if let Err(response) = authorize(&state, request.headers(), client_ip).await {
        return response;
    }
    let content = match read_body(request).await {
        Ok(content) => content,
        Err(response) => return response,
    };
    match state
        .app
        .scoped_fs
        .append_file(query.path, offset, content)
        .await
    {
        Ok(size) => size_response(StatusCode::OK, size),
        Err(e) => scoped_fs_error_response("failed to append to file", &e),
    }
}

// -- Gates --------------------------------------------------------------------

struct FileBytesQuery<'a> {
    path: &'a str,
    /// Present and valid only when `offset` is among the allowed keys.
    offset: Option<u64>,
}

/// Check the query's shape: only `allowed` keys, a `path`, and — when given —
/// an `offset` that's a plain decimal `u64`. Runs before auth, so a malformed
/// query answers the same whatever the caller's credentials.
#[allow(
    clippy::result_large_err,
    reason = "Err is the ready-to-return axum Response — the spine REST handler idiom"
)]
fn parse_query<'a>(
    query_pairs: &'a [(String, String)],
    allowed: &[&str],
) -> Result<FileBytesQuery<'a>, Response> {
    assert_known_query_keys(query_pairs, allowed)?;
    let Some(path) = query_first(query_pairs, "path") else {
        return Err(fuz_http::invalid_query_params_response());
    };
    let offset = match query_first(query_pairs, "offset") {
        None => None,
        // digits only: `u64::from_str` alone would take a leading `+`
        Some(raw) if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) => Some(
            raw.parse::<u64>()
                .map_err(|_| fuz_http::invalid_query_params_response())?,
        ),
        Some(_) => return Err(fuz_http::invalid_query_params_response()),
    };
    Ok(FileBytesQuery { path, offset })
}

/// Authenticate the request and check its token scope: `401` with no valid
/// credential, `403` for a method-scoped API token.
async fn authorize(
    state: &FileBytesRouteState,
    headers: &HeaderMap,
    client_ip: Option<Extension<ClientIp>>,
) -> Result<(), Response> {
    let client_ip = extract_client_ip_or_unresolved(client_ip);
    let Some(auth) = resolve_auth_from_headers(
        headers,
        &state.keyring,
        &state.app.db_pool,
        state.daemon_token_state.as_ref(),
        state.session_cookie_name,
        &client_ip,
    )
    .await
    else {
        return Err(fuz_http::authentication_required_response());
    };
    if !auth.scope.admits_non_rpc_surface() {
        return Err(fuz_auth::token_scope_surface_denied_response(
            FILE_BYTES_SURFACE,
        ));
    }
    Ok(())
}

/// Buffer a write's body, after the gates. The router's body-limit layer
/// already refused a declared `Content-Length` over the cap; this catches a
/// body that runs past it without declaring one.
async fn read_body(request: Request) -> Result<Bytes, Response> {
    axum::body::to_bytes(request.into_body(), FILE_BYTES_MAX_BODY_BYTES)
        .await
        .map_err(|_| fuz_http::payload_too_large_response())
}

// -- Responses ----------------------------------------------------------------

fn size_response(status: StatusCode, size: u64) -> Response {
    let mut response = (status, Json(serde_json::json!({ "size": size }))).into_response();
    apply_security_headers(&mut response);
    response
}

/// Map a [`ScopedFsError`] to a flat `{"error": <reason>}` response, with the
/// classification the JSON-RPC file actions use ([`scoped_fs_error`]): the
/// same reason, and the HTTP status of the same error code. An offset
/// mismatch also carries the file's current `size`. The message (which names
/// the path) is logged, not sent.
fn scoped_fs_error_response(action: &str, error: &ScopedFsError) -> Response {
    let jsonrpc_error = scoped_fs_error(action, error);
    let status = fuz_http::error_code_to_http_status(jsonrpc_error.code);
    let reason = jsonrpc_error
        .data
        .as_ref()
        .and_then(|data| data.get("reason"))
        .and_then(serde_json::Value::as_str);
    let mut response = match (reason, error) {
        (Some(_), ScopedFsError::OffsetMismatch { size, .. }) => (
            status,
            Json(serde_json::json!({ "error": ERROR_OFFSET_MISMATCH, "size": size })),
        )
            .into_response(),
        (Some(reason), _) => (status, Json(serde_json::json!({ "error": reason }))).into_response(),
        (None, _) => fuz_http::internal_error_response(),
    };
    tracing::debug!(status = %response.status(), "{}", jsonrpc_error.message);
    apply_security_headers(&mut response);
    response
}

/// The headers every response here carries, whatever its body.
fn apply_security_headers(response: &mut Response) {
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

/// The headers of a response that serves (or could serve) `path`'s bytes: the
/// security set, `Accept-Ranges`, and the content type — an allowlisted media
/// type, or `application/octet-stream` as an attachment.
fn apply_content_headers(response: &mut Response, path: &str) {
    apply_security_headers(response);
    let headers = response.headers_mut();
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(content_type) = media_content_type(path) {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    } else {
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        set_header(
            response,
            header::CONTENT_DISPOSITION,
            &attachment_disposition(path),
        );
    }
}

/// Set a header whose value is built at runtime from ASCII we produced.
fn set_header(response: &mut Response, name: header::HeaderName, value: &str) {
    match HeaderValue::from_str(value) {
        Ok(value) => {
            response.headers_mut().insert(name, value);
        }
        Err(e) => tracing::warn!(%name, error = %e, "file_bytes: unrepresentable header value"),
    }
}

/// The content type a file is served as inline, from its extension alone —
/// `None` for everything that isn't an allowlisted raster image, audio, or
/// video type.
///
/// Never anything a browser renders as a document or runs: no HTML, SVG (it
/// scripts), XML, PDF, or text. The extension is the only input — the bytes
/// are never sniffed, here or (with `nosniff`) by the browser.
#[must_use]
pub fn media_content_type(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next()?;
    let (_, extension) = name.rsplit_once('.')?;
    let content_type = match extension.to_ascii_lowercase().as_str() {
        // raster images
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // audio
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "weba" => "audio/webm",
        // video
        "webm" => "video/webm",
        "mp4" | "m4v" => "video/mp4",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        _ => return None,
    };
    Some(content_type)
}

/// `Content-Disposition` for a download of `path`: `attachment` with the file
/// name percent-encoded (RFC 5987), so no byte of the name is ever a header
/// delimiter.
fn attachment_disposition(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or_default();
    let mut value = String::from("attachment; filename*=UTF-8''");
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_') {
            value.push(char::from(byte));
        } else {
            // writing to a `String` can't fail
            let _ = write!(value, "%{byte:02X}");
        }
    }
    value
}

// -- Ranges -------------------------------------------------------------------

/// What a `Range` header asks of a file of a known size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ByteRange {
    /// No usable range: serve the whole file (`200`).
    Full,
    /// Serve `start..=end` (`206`); both are inside the file.
    Partial { start: u64, end: u64 },
    /// The range starts at or past the end (`416`).
    Unsatisfiable,
}

/// Resolve a `Range` header against a file of `size` bytes.
///
/// One `bytes=` range is honored: `a-b`, `a-`, or the suffix `-n`. Anything
/// else — another unit, several ranges, a malformed spec — is ignored and the
/// whole file served, which RFC 9110 allows a server to do with any range.
fn resolve_range(header: Option<&str>, size: u64) -> ByteRange {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return ByteRange::Full;
    };
    let Some((first, last)) = spec.trim().split_once('-') else {
        return ByteRange::Full;
    };
    let parse = |digits: &str| -> Option<u64> {
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        digits.parse().ok()
    };
    if first.is_empty() {
        // suffix: the last `n` bytes
        return match parse(last) {
            None => ByteRange::Full,
            Some(0) => ByteRange::Unsatisfiable,
            Some(_) if size == 0 => ByteRange::Unsatisfiable,
            Some(n) => ByteRange::Partial {
                start: size.saturating_sub(n),
                end: size - 1,
            },
        };
    }
    let Some(start) = parse(first) else {
        return ByteRange::Full;
    };
    let end = if last.is_empty() {
        None
    } else {
        match parse(last) {
            Some(end) if end >= start => Some(end),
            _ => return ByteRange::Full,
        }
    };
    if start >= size {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Partial {
        start,
        end: end.map_or(size - 1, |end| end.min(size - 1)),
    }
}

/// A body streaming `len` bytes of `file` from `start`, read
/// [`READ_CHUNK_BYTES`] at a time. A file that shrinks underneath ends the
/// body early (the client sees a short response); one that grows is still cut
/// at `len`.
fn file_body(file: tokio::fs::File, start: u64, len: u64) -> Body {
    let stream = futures_util::stream::try_unfold(
        (file, len, start > 0),
        move |(mut file, remaining, seek)| async move {
            if seek {
                file.seek(std::io::SeekFrom::Start(start)).await?;
            }
            if remaining == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            let want =
                usize::try_from(remaining).map_or(READ_CHUNK_BYTES, |r| r.min(READ_CHUNK_BYTES));
            let mut chunk = vec![0; want];
            let read = file.read(&mut chunk).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "file shrank while it was being served",
                ));
            }
            chunk.truncate(read);
            Ok(Some((
                Bytes::from(chunk),
                (file, remaining - read as u64, false),
            )))
        },
    );
    Body::from_stream(stream)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use super::*;

    #[test]
    fn no_or_unusable_range_serves_the_whole_file() {
        for header in [
            None,
            Some("items=0-1"),
            Some("bytes=0-1,4-5"),
            Some("bytes=abc"),
            Some("bytes=5-2"),
            Some("bytes=+1-2"),
            Some("bytes=-"),
            Some("bytes=1-x"),
        ] {
            assert_eq!(resolve_range(header, 10), ByteRange::Full, "{header:?}");
        }
    }

    #[test]
    fn ranges_resolve_inside_the_file() {
        let partial = |start, end| ByteRange::Partial { start, end };
        assert_eq!(resolve_range(Some("bytes=0-"), 10), partial(0, 9));
        assert_eq!(resolve_range(Some("bytes=2-5"), 10), partial(2, 5));
        assert_eq!(resolve_range(Some("bytes=9-9"), 10), partial(9, 9));
        // an end past the file is clamped
        assert_eq!(resolve_range(Some("bytes=4-999"), 10), partial(4, 9));
        // suffix ranges count back from the end
        assert_eq!(resolve_range(Some("bytes=-3"), 10), partial(7, 9));
        assert_eq!(resolve_range(Some("bytes=-999"), 10), partial(0, 9));
        assert_eq!(resolve_range(Some(" bytes=2-5 "), 10), partial(2, 5));
    }

    #[test]
    fn a_range_past_the_end_is_unsatisfiable() {
        assert_eq!(
            resolve_range(Some("bytes=10-"), 10),
            ByteRange::Unsatisfiable
        );
        assert_eq!(
            resolve_range(Some("bytes=11-20"), 10),
            ByteRange::Unsatisfiable
        );
        assert_eq!(
            resolve_range(Some("bytes=-0"), 10),
            ByteRange::Unsatisfiable
        );
        // nothing of an empty file can be ranged over
        assert_eq!(resolve_range(Some("bytes=0-"), 0), ByteRange::Unsatisfiable);
        assert_eq!(resolve_range(Some("bytes=-5"), 0), ByteRange::Unsatisfiable);
        assert_eq!(resolve_range(None, 0), ByteRange::Full);
    }

    #[test]
    fn only_media_extensions_get_a_content_type() {
        assert_eq!(media_content_type("/a/b/voice.webm"), Some("video/webm"));
        assert_eq!(media_content_type("/a/PHOTO.JPG"), Some("image/jpeg"));
        assert_eq!(media_content_type("/a/song.final.mp3"), Some("audio/mpeg"));
        // anything a browser would render or run as a document is a download
        for path in [
            "/a/page.html",
            "/a/page.htm",
            "/a/drawing.svg",
            "/a/feed.xml",
            "/a/doc.pdf",
            "/a/notes.txt",
            "/a/script.js",
            "/a/style.css",
            "/a/no_extension",
            "/a/.webm/inner",
            "/a/trailing.",
        ] {
            assert_eq!(media_content_type(path), None, "{path}");
        }
        // a dotfile named like an extension is still typed by that extension
        assert_eq!(media_content_type("/a/.png"), Some("image/png"));
    }

    #[test]
    fn attachment_names_are_percent_encoded() {
        assert_eq!(
            attachment_disposition("/a/b/notes.txt"),
            "attachment; filename*=UTF-8''notes.txt"
        );
        assert_eq!(
            attachment_disposition("/a/we\"ird; name\r\n.html"),
            "attachment; filename*=UTF-8''we%22ird%3B%20name%0D%0A.html"
        );
        assert_eq!(
            attachment_disposition("/a/é.bin"),
            "attachment; filename*=UTF-8''%C3%A9.bin"
        );
    }

    #[test]
    fn content_headers_lock_down_every_served_file() {
        let headers_for = |path: &str| {
            let mut response = Response::new(Body::empty());
            apply_content_headers(&mut response, path);
            response.headers().clone()
        };
        let get = |headers: &HeaderMap, name: &str| {
            headers
                .get(name)
                .map(|value| value.to_str().unwrap().to_owned())
        };

        let html = headers_for("/a/page.html");
        assert_eq!(
            get(&html, "content-type").as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(
            get(&html, "content-disposition").as_deref(),
            Some("attachment; filename*=UTF-8''page.html")
        );

        let audio = headers_for("/a/voice.ogg");
        assert_eq!(get(&audio, "content-type").as_deref(), Some("audio/ogg"));
        assert_eq!(get(&audio, "content-disposition"), None);
        assert_eq!(get(&audio, "accept-ranges").as_deref(), Some("bytes"));

        for headers in [&html, &audio] {
            assert_eq!(
                get(headers, "x-content-type-options").as_deref(),
                Some("nosniff")
            );
            assert_eq!(
                get(headers, "content-security-policy").as_deref(),
                Some("default-src 'none'; sandbox")
            );
            assert_eq!(
                get(headers, "cross-origin-resource-policy").as_deref(),
                Some("same-origin")
            );
            assert_eq!(get(headers, "cache-control").as_deref(), Some("no-store"));
        }
    }

    async fn collect(body: Body) -> Result<Vec<u8>, axum::Error> {
        axum::body::to_bytes(body, usize::MAX)
            .await
            .map(|bytes| bytes.to_vec())
    }

    #[tokio::test]
    async fn a_body_streams_exactly_the_requested_bytes() {
        let dir = std::env::temp_dir().join(format!("zzz-file-bytes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.bin");
        // longer than one read, so the stream takes several
        let content: Vec<u8> = (0..READ_CHUNK_BYTES * 2 + 100)
            .map(|i| u8::try_from(i % 251).unwrap())
            .collect();
        std::fs::write(&path, &content).unwrap();
        let open = || async { tokio::fs::File::open(&path).await.unwrap() };

        let whole = collect(file_body(open().await, 0, content.len() as u64)).await;
        assert_eq!(whole.unwrap(), content);

        let start = READ_CHUNK_BYTES - 7;
        let len = READ_CHUNK_BYTES + 50;
        let part = collect(file_body(open().await, start as u64, len as u64)).await;
        assert_eq!(part.unwrap(), content[start..start + len]);

        let empty = collect(file_body(open().await, 0, 0)).await;
        assert!(empty.unwrap().is_empty());

        // a file shorter than promised fails the body rather than padding it
        let short = collect(file_body(open().await, 0, content.len() as u64 + 1)).await;
        assert!(short.is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
