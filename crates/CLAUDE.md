# zzz Rust Backend

Shadow implementation of the Deno/Hono server using axum. Same JSON-RPC 2.0
protocol, same wire format — the Deno server is ground truth and the
integration tests enforce identical behaviour between both backends.

Phase 4 in progress: AI provider system with enum-dispatched providers
(Anthropic fully implemented, OpenAI/Gemini/Ollama stubs). 16 RPC methods:
`ping`, `session_load`, `workspace_*`, `diskfile_*`, `directory_create`,
`terminal_*`, `provider_load_status`, `provider_update_api_key`,
`completion_create`. Full auth stack (cookie sessions, bearer tokens, daemon
tokens), account management routes, filesystem actions with `ScopedFs`,
terminal actions via `fuz_pty`, `session_load` returns real provider status
from all registered providers, `workspace_changed`/`filer_change`/
`terminal_data`/`terminal_exited` notifications, file watching via `notify`
crate with debounced broadcasts and immediate index updates, WebSocket
connection tracking with targeted `completion_progress` streaming
notifications, event-driven socket revocation. Database (PostgreSQL via
`tokio-postgres`/`deadpool-postgres`), HMAC-SHA256 cookie signing, blake3
session hashing. Anthropic provider uses `reqwest` HTTP client with manual
SSE parsing for streaming completions.

## Prerequisites

`private_fuz` must be checked out as a sibling directory:

```
~/dev/zzz/               (this repo)
~/dev/private_fuz/        (path deps: fuz_common, fuz_pty)
```

If a path dep is missing, `cargo build` will fail with
`failed to read .../private_fuz/crates/{crate}/Cargo.toml`.

**PostgreSQL** is required. Create the development and test databases:

```bash
createdb zzz       # development
createdb zzz_test  # integration tests
```

## Build and Run

```bash
cargo build -p zzz_server
cargo clippy -p zzz_server        # workspace lints: pedantic + nursery

# Run (requires DATABASE_URL and SECRET_COOKIE_KEYS)
DATABASE_URL=postgres://localhost/zzz \
SECRET_COOKIE_KEYS=dev-only-not-for-production-use-000 \
./target/debug/zzz_server --port 1174

# Quick smoke test
curl http://localhost:1174/health
curl -X POST http://localhost:1174/api/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"ping"}'
# → {"jsonrpc":"2.0","id":"1","result":{"ping_id":"1"}}
```

CLI args (`--port`, `--static-dir`) take precedence over env vars
(`ZZZ_PORT`, `ZZZ_STATIC_DIR`).

### Required Environment Variables

| Variable             | Purpose                                            |
|----------------------|----------------------------------------------------|
| `DATABASE_URL`       | PostgreSQL connection (e.g. `postgres://localhost/zzz`) |
| `SECRET_COOKIE_KEYS` | HMAC signing keys (min 32 chars, `__` separator for rotation) |

### Optional Environment Variables

| Variable                 | Purpose                                    |
|--------------------------|--------------------------------------------|
| `BOOTSTRAP_TOKEN_PATH`   | Path to bootstrap token file               |
| `ALLOWED_ORIGINS`        | Comma-separated origin patterns            |
| `PUBLIC_ZZZ_SCOPED_DIRS` | Comma-separated filesystem paths           |
| `ZZZ_PORT`               | Server port (default 1174, CLI overrides)  |
| `ZZZ_STATIC_DIR`         | Static file directory                      |

## Endpoints

| Method | Path                              | Description                              |
|--------|-----------------------------------|------------------------------------------|
| GET    | `/api/rpc`                        | JSON-RPC 2.0 (cacheable reads, query params) |
| POST   | `/api/rpc`                        | JSON-RPC 2.0 (HTTP transport, auth-gated) |
| POST   | `/api/account/bootstrap`          | One-shot admin account creation          |
| GET    | `/api/account/status`             | Current account info or 401 + bootstrap status |
| POST   | `/api/account/login`              | Username/password login → session cookie |
| POST   | `/api/account/logout`             | Invalidate session, close WS connections |
| POST   | `/api/account/password`           | Change password, revoke all sessions/tokens |
| GET    | `/api/account/sessions`           | List sessions for authenticated account  |
| POST   | `/api/account/sessions/:id/revoke`| Revoke a specific session                |
| GET    | `/api/ws`                         | JSON-RPC 2.0 (WebSocket, cookie/bearer/daemon) |
| GET    | `/health`                         | Health check (`{"status":"ok"}`)         |
| GET    | `/*`                              | Static files (if `--static-dir`)         |

Route paths match the Deno server — both backends use the same `/api/*` prefix.
Integration tests use identical config for both backends.

## Auth

Cookie-based session auth and bearer token auth mirroring fuz_app's auth stack:

1. **Keyring** — HMAC-SHA256 cookie signing with key rotation support.
   Keys from `SECRET_COOKIE_KEYS` env, separated by `__`. First key signs,
   all keys verify.

2. **Cookie format** — `fuz_session` cookie containing signed
   `{session_token}:{expires_at}.{base64_signature}`. 30-day expiry,
   `Secure; HttpOnly; SameSite=Strict`.

3. **Session validation** — Cookie → HMAC verify → blake3 hash token →
   `auth_session` table lookup → build `RequestContext` (account, actor,
   permits). Sessions touched (last_seen_at updated) fire-and-forget.

4. **Bearer token auth** — `Authorization: Bearer <token>` header. Token
   hashed with blake3, looked up in `api_token` table. Browser context
   silently discarded (Origin/Referer headers present → bearer ignored). Token
   `last_used_at` touched fire-and-forget. Sets `CredentialType::ApiToken`.

5. **Daemon token auth** — `X-Daemon-Token` header. Token is a 43-char
   base64url string (32 random bytes), generated at startup and written to
   `{zzz_dir}/run/daemon_token`. Rotated every 30 seconds (previous token
   accepted during rotation race window). Validated with constant-time
   comparison. Resolves the keeper account for the `RequestContext`. Sets
   `CredentialType::DaemonToken`. State protected by `tokio::sync::RwLock`.

6. **Auth pipeline** — Both transports try: daemon token → cookie → bearer.
   Daemon token has highest priority (matches fuz_app middleware order).
   `ResolvedAuth` carries `credential_type` (`Session`, `ApiToken`,
   `DaemonToken`) and optional `token_hash` (session connections only —
   bearer and daemon token connections have `None`).

7. **Per-action auth** — Each RPC method has an auth level:
   - `public` — no auth required (`ping`)
   - `authenticated` — valid session or bearer token required (workspace_*, session_load, etc.)
   - `keeper` — requires `DaemonToken` credential type AND keeper role permit (`provider_update_api_key`). API tokens and session cookies cannot access keeper actions even if the account has the keeper permit.

8. **Bootstrap** — `POST /bootstrap` creates first admin account with keeper
   + admin permits. Reads token from `BOOTSTRAP_TOKEN_PATH`, timing-safe
   compare, Argon2 password hashing, all in a transaction with bootstrap_lock.

9. **Origin verification** — `ALLOWED_ORIGINS` patterns checked on requests
   with an `Origin` header. Supports exact match, wildcard port
   (`http://localhost:*`), subdomain wildcard (`https://*.example.com`).

10. **Socket revocation** — `close_sockets_for_session(token_hash)` and
    `close_sockets_for_account(account_id)` methods on `App` close matching
    WebSocket connections by dropping the channel sender. Session connections
    are revocable per-session or per-account; bearer connections are revocable
    only per-account. Called by logout (per-session) and password change
    (per-account).

11. **Account status** — `GET /api/account/status` returns account info +
    permits (200) when authenticated, or 401 with optional
    `bootstrap_available` flag when not. Consumed by fuz_app's `AuthState`
    for the frontend auth gate (bootstrap → login → verified flow).

12. **Account management** — `POST /api/account/login` (username/password →
    session cookie with enumeration prevention via dummy hash),
    `POST /api/account/logout` (invalidate session + close WS connections),
    `POST /api/account/password` (change password, revoke all sessions + API
    tokens, close all WS connections), `GET /api/account/sessions` (list
    sessions for account), `POST /api/account/sessions/:id/revoke` (revoke
    specific session, scoped to own account).

## Integration Tests

79 tests on both backends, all cross-backend (0 skips, 0 backend-specific
branches). Both backends bootstrap
auth (admin account + session cookie), create a non-keeper user (account +
actor + session, no
keeper permit, cookie signed via HMAC-SHA256), and insert API tokens into
the `api_token` table before tests. The test database (`zzz_test` by default,
configurable via `TEST_DATABASE_URL`) is cleaned (TRUNCATE CASCADE) before
each backend run. A scoped directory (`/tmp/zzz_integration_scoped`) is
created for filesystem tests. Tests are split across modules: `tests.ts`
(core RPC, auth, filesystem, terminal tests), `bearer_tests.ts` (bearer
token auth, keeper credential enforcement, session revocation),
`account_tests.ts` (login, logout, password change, session management),
`test_helpers.ts` (shared assertion and HTTP/WS helpers).

**WS tests (both backends):** `ping_ws`, `parse_error_ws`,
`method_not_found_ws`, `invalid_request_ws`, `notification_ws`,
`multi_message_ws`, `ws_workspace_list` — 7 tests verify identical WS
behaviour including authenticated actions over WebSocket.

**HTTP tests (both backends):** `null_id_is_invalid`, `parse_error_http`,
`parse_error_empty_body`, `method_not_found_http`, `invalid_request_*`
(4 variants), `notification_http` — 9 tests verify identical HTTP behaviour.

**HTTP tests (both backends):** `ping_http`, `ping_numeric_id` — ping handler
echoes the JSON-RPC request id back as `ping_id`.

**Cross-backend:** `health_check` — 1 test on both backends.

**Workspace tests (both backends):** `workspace_open_and_list`,
`workspace_open_idempotent`, `workspace_open_nonexistent`,
`workspace_close` — 4 tests.

**Workspace notification tests (both backends):**
`workspace_changed_on_open`, `workspace_changed_on_close`,
`workspace_changed_idempotent_no_notification` — 3 tests verify
`workspace_changed` notifications are broadcast to WebSocket clients on
workspace open/close, and that idempotent opens do not broadcast.

**Auth tests (both backends):** `auth_required_without_cookie`,
`auth_required_invalid_cookie`, `auth_public_no_cookie`,
`auth_keeper_forbidden` — 4 tests verify auth enforcement (unauthenticated
→ -32001/401, public → success, non-keeper calling keeper action → -32002/403).

**WebSocket auth test (both backends):** `ws_auth_required` — 1 test verifies
unauthenticated WS upgrade is rejected.

**Session/provider tests (both backends):** `session_load_basic`,
`session_load_returns_zzz_dir_files`, `session_load_returns_nested_files`,
`provider_load_status_empty` — 4 tests verify session data loading
(including zzz_dir file listing with contents and recursive subdirectory
walk) and provider status stub.

**Filesystem tests (both backends):** `diskfile_update_and_read`,
`diskfile_update_in_zzz_dir`, `diskfile_update_in_zzz_dir_subdirectory`,
`diskfile_delete`, `directory_create`, `directory_create_already_exists`,
`diskfile_update_outside_scope`, `diskfile_update_path_traversal`,
`diskfile_update_relative_path`, `diskfile_delete_nonexistent` — 10 tests
verify scoped filesystem operations (including writes to zzz_dir and nested
subdirectories), idempotent directory creation, path traversal rejection,
relative path rejection, and nonexistent file deletion.

**Workspace edge cases (both backends):** `workspace_open_not_directory` —
1 test verifies opening a file (not a directory) returns an error.

**File watcher tests (both backends):** `filer_change_on_file_create` —
1 test verifies `filer_change` notifications are broadcast when files are
created in an open workspace.

**Terminal tests (both backends):** `terminal_create_echo`,
`terminal_close`, `terminal_write_and_read`, `terminal_resize_live`,
`terminal_create_with_cwd`, `terminal_create_nonexistent_command`,
`terminal_data_send_missing`, `terminal_close_missing`,
`terminal_resize_missing` — 9 tests verify PTY spawn/read/write/close
lifecycle, `terminal_data`/`terminal_exited` notifications over WebSocket,
stdin write with echo verification, live resize, explicit cwd, nonexistent
command handling, explicit process kill, and silent return behavior for
missing terminal IDs.

**Non-keeper tests (both backends):** `non_keeper_authenticated_action`,
`auth_keeper_forbidden` — 2 tests verify non-keeper users can access
authenticated actions but are rejected from keeper actions.

**Bearer token tests (both backends unless noted):**
`bearer_token_auth`, `bearer_token_invalid`, `bearer_token_expired`,
`bearer_token_public_action`, `bearer_token_ws`,
`bearer_token_ws_rejected_invalid`, `keeper_requires_daemon_token`,
`ws_revocation_on_session_delete`,
`bearer_rejects_browser_context_origin`,
`bearer_rejects_browser_context_referer`, `bearer_empty_value`,
`bearer_cookie_priority` — 12 tests verify API token auth via
`Authorization: Bearer` header on HTTP and WebSocket, expired/invalid token
rejection, keeper credential enforcement (API tokens can't access keeper
actions), session revocation via DB delete, browser context discard
(Origin/Referer headers → bearer silently ignored), empty bearer value
handling, and cookie-over-bearer priority.

**Account management tests (both backends):**
`login_success`, `login_invalid_password`, `login_nonexistent_user`,
`logout_clears_session`, `logout_unauthenticated`,
`password_change_revokes_all`, `password_wrong_current`,
`session_list`, `session_revoke` — 9 tests verify login with
valid/invalid/nonexistent credentials, logout with session invalidation and
cookie clearing, password change with full session + token revocation and
re-login verification, session listing (with `account_id` field), and single
session revocation (idempotent with `revoked` field).

```bash
deno task test:integration --backend=rust   # Rust only
deno task test:integration --backend=deno   # Deno only
deno task test:integration --backend=both   # Both (default)
deno task test:integration --filter=ping    # Substring match on test name
```

The test runner cleans the `zzz_test` database, writes a bootstrap token,
starts the backend, bootstraps an admin account, runs tests with the session
cookie, then stops the backend and cleans up.

## Architecture

```
crates/zzz_server/src/
├── main.rs          # Entry, config, DB/keyring/daemon-token init, route setup, graceful shutdown
├── handlers.rs      # App (server state + connection tracking + watchers), Ctx, dispatch
├── rpc.rs           # JSON-RPC classify + notification builder, HTTP handler with auth pipeline
├── ws.rs            # WebSocket upgrade with auth, connection tracking, select! message loop
├── auth.rs          # Keyring, cookie/bearer/daemon-token resolution, per-action auth
├── daemon_token.rs  # Daemon token state, generation, timing-safe validation, rotation task
├── account.rs       # Account routes: login, logout, password change, session management
├── bootstrap.rs     # POST /bootstrap handler (account + session creation)
├── db.rs            # Connection pool, migrations, auth + account management queries
├── filer.rs         # Filer + FilerManager (notify crate) — immediate file index updates, debounced filer_change broadcasts
├── provider/        # AI provider system
│   ├── mod.rs       # ProviderName, ProviderStatus, Provider enum, ProviderManager, CompletionOptions
│   ├── anthropic.rs # AnthropicProvider — Messages API with SSE streaming
│   ├── openai.rs    # OpenAiProvider stub (status only)
│   ├── gemini.rs    # GeminiProvider stub (status only)
│   └── ollama.rs    # OllamaProvider stub (status only)
├── pty_manager.rs   # PTY terminal manager (fuz_pty crate) → terminal_data/exited notifications
├── scoped_fs.rs     # Scoped filesystem — path validation, symlink rejection
└── error.rs         # ServerError (Bind, Serve, Database, Config)
```

**App/Ctx/dispatch pattern**: `App` holds long-lived server state (workspaces
in `RwLock<HashMap>`, `deadpool_postgres::Pool`, `Keyring`, origin config,
`ScopedFs`, `zzz_dir`, `scoped_dirs`, `PtyManager`, `DaemonTokenState`,
connection tracking via `AtomicU64` + `RwLock<HashMap<ConnectionId,
ConnectionInfo>>`, `FilerManager` with per-watcher ignore config, event
debouncing, in-memory file index, and lifetime tracking (permanent for
`zzz_dir`/`scoped_dirs`, workspace-scoped for `workspace_open`; deduplicates
by path)), constructed once in `main`, wrapped in `Arc`. `Ctx` is
per-request context (borrows `App` + holds `Arc<App>` for spawning tasks,
`request_id`, `auth: Option<&RequestContext>`, `notify: NotifyFn` for
request-scoped JSON-RPC notifications — socket-scoped on WS via `app.send_to`,
debug no-op on HTTP, mirrors TS `ctx.notify`; `signal: CancellationToken`
for cancellation — per-socket on WS cancelled on disconnect, fresh per-request
on HTTP, mirrors TS `ctx.signal`), constructed by each transport before
calling `handlers::dispatch`.

**Auth pipeline** (HTTP RPC path):
1. Origin verification (if `Origin` header present)
2. Try daemon token auth: `X-Daemon-Token` → timing-safe validate → resolve keeper account
3. If no daemon token: try cookie auth: `fuz_session` cookie → HMAC verify → blake3 hash → `auth_session` lookup
4. If no cookie: try bearer auth: `Authorization: Bearer` → reject browser context → blake3 hash → `api_token` lookup
5. Build `RequestContext` (account → actor → permits) with `CredentialType`
6. Check per-action auth level (keeper actions require `DaemonToken` credential type)

**Message classification** (`rpc::classify`) is transport-agnostic:
- HTTP: origin check → auth → classify → auth check → dispatch
- WS: upgrade auth (reject 401) → classify → per-action auth check → dispatch

## Known Issues

- **No per-message WS session revalidation** — upgrade-time auth only. Event-
  driven revocation covers logout and password change (closes matching WS
  connections via `close_sockets_for_session`/`close_sockets_for_account`).
  Per-message session recheck is not done — the event-driven approach is
  sufficient for current needs.
- **error.data intentional divergence** — Deno includes Zod validation details
  in `error.data` for -32602 errors; Rust omits for security (no schema leak to
  unauthenticated callers). The integration test `normalize_error_data` function
  handles this. Future: environment-conditional in both (include in dev, strip
  in prod).

### Cross-Backend Response Divergences

Tracked asymmetries between Deno (ground truth) and Rust backends. Bearer
auth response format (issue #1) was resolved — both backends now produce
identical JSON-RPC envelopes for all auth failures.

| Issue | Status | Detail |
|-------|--------|--------|
| Bearer invalid/expired token | **Resolved** | Both backends soft-fail → JSON-RPC `-32001` unauthenticated |
| `provider_load_status` shape | **Resolved** | Both backends return `{status: ProviderStatus}` per the action spec. Test is cross-backend (no backend branching). |
| `session_list` response | **Resolved** | Both backends now return `{sessions: [{id, account_id, created_at, last_seen_at, expires_at}]}` matching fuz_app `AuthSessionJson`. Tests are cross-backend. |
| `session_revoke` format | **Resolved** | Both backends now return `{ok: true, revoked: boolean}` with idempotent 200 responses. Route paths unified (`/api/account/*`). Tests are cross-backend. |
| `error.data` (validation) | Intentional | Deno includes Zod issues in `error.data` for -32602; Rust omits. Intentional divergence — Rust's omission is the safer production default, Deno's inclusion aids DX. Handled by `normalize_error_data` in tests. Future: environment-conditional in both backends (include in dev, strip in prod). |

## Known Limitations

- 16 RPC methods (`ping`, `session_load`, `workspace_*`, `diskfile_update`, `diskfile_delete`, `directory_create`, `terminal_*`, `provider_load_status`, `provider_update_api_key` keeper-only, `completion_create`)
- 5 `remote_notification` actions: `workspace_changed` (broadcast on open/close), `filer_change` (`FilerManager` with `notify` crate — recursive watching, 80ms debounced broadcasts with immediate index updates, per-watcher ignore config, in-memory file index; ignores `.git`/`node_modules`/`.svelte-kit`/`target`/`dist` globally plus zzz dir name for workspace/scoped_dir watchers; startup filers on `zzz_dir` and `scoped_dirs`, per-workspace filers with dedup and lifetime tracking), `terminal_data` (PTY stdout broadcast), `terminal_exited` (process exit broadcast), `completion_progress` (streaming completion chunks to requesting WS connection)
- AI providers: Anthropic fully implemented (non-streaming + SSE streaming), OpenAI/Gemini stubs (status only), Ollama stub (always unavailable)
- No batch request support (JSON arrays)
- No Ollama actions (`ollama_list`, `ollama_ps`, etc.)
- No signup route (requires invite system)
- No token management routes (GET /tokens, POST /tokens/create, etc.)
- No SSE/realtime audit event broadcasting
- No rate limiting on login/password endpoints

## Design Decisions

- **DB**: `tokio-postgres` + `deadpool-postgres` pool in `App`. Required at
  startup — server fails fast if `DATABASE_URL` is missing or unreachable.
  Migrations run on every startup (CREATE TABLE IF NOT EXISTS).
- **Cookie signing**: Pure Rust HMAC-SHA256 via `hmac`/`sha2` crates.
  Compatible with fuz_app's keyring format (same `value.base64(signature)`).
- **Session hashing**: `blake3` crate for token → storage key hashing.
  Compatible with fuz_app's `hash_blake3` (same hex output).
- **Password hashing**: Argon2id via `argon2` crate (bootstrap, login, password change),
  offloaded to `tokio::task::spawn_blocking` to avoid blocking the async runtime.
- **Dispatch is async**: filesystem handlers (`diskfile_update`, etc.) use
  `tokio::fs` async I/O. Workspace handlers remain sync (no await points).
- **`std::sync::RwLock`** (not tokio): current handlers are sync. When async
  handlers arrive, scope lock guards before await points.
- **Session touch**: fire-and-forget via `tokio::spawn` — doesn't block
  the request pipeline.
- **PTY terminals**: `fuz_pty` as a native crate dependency (no FFI
  indirection). `PtyManager` in `App` manages spawned processes with async
  read loops via `tokio::spawn`. Each terminal gets a `CancellationToken` so
  `terminal_close` can stop the read loop before killing the process. Matching
  Deno behavior: 10ms poll interval, 50ms wait after kill before waitpid,
  silent returns for missing terminal IDs.
- **Provider system**: Enum-dispatched (`Provider` enum, not trait objects) —
  4 providers known at compile time, exhaustive matching. Provider state behind
  `tokio::sync::RwLock` for async `set_api_key`. `complete()` clones the
  `reqwest::Client` (internally `Arc`'d) and releases the lock before HTTP
  calls, so `set_api_key` is never blocked by long-running streaming responses.
  SSE parsing is manual with `\r\n` normalization per RFC 8895.

## What's Next

**Phase 4** (in progress — AI providers):
- [x] Provider system: enum-dispatched `Provider` with `ProviderManager`, `ProviderStatus`, `CompletionOptions`
- [x] Anthropic provider: full implementation with `reqwest` HTTP client, SSE streaming, message format conversion
- [x] `provider_load_status` handler (cross-backend, all 4 providers report status)
- [x] `provider_update_api_key` handler (keeper-only, runtime API key updates)
- [x] `completion_create` handler with `completion_progress` streaming notifications (targeted to requesting WS connection)
- [x] `session_load` returns real provider status from all providers
- [ ] OpenAI provider: full completion implementation
- [ ] Gemini provider: full completion implementation
- [ ] Ollama provider: HTTP client to local Ollama API, `ollama_list`, `ollama_ps`, etc.

**Phase 5** (remaining):
1. Codegen from Zod specs (action input/output types)
2. Token management routes (create, list, revoke API tokens)
3. Rate limiting on login/password endpoints

See the [Rust Backends quest](../../grimoire/quests/rust-backends.md).
