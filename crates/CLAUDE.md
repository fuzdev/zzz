# zzz Rust Backend

Shadow implementation of the Deno/Hono server using axum. Same JSON-RPC 2.0
protocol, same wire format — the Deno server is ground truth and the
integration tests enforce identical behaviour between both backends.

Phase 2b+ complete: cookie-based auth on both HTTP and WebSocket, filesystem
actions (`diskfile_update`, `diskfile_delete`, `directory_create`) with
`ScopedFs` path safety, terminal actions (`terminal_create`, `terminal_data_send`,
`terminal_resize`, `terminal_close`) via `fuz_pty` native crate dependency
(real PTY via `forkpty`), per-action auth checks on all transports, a
bootstrap endpoint for first-time account creation, `session_load` handler
(returns zzz_dir, scoped_dirs, workspaces), `provider_load_status` stub
(returns empty array), `workspace_changed` notifications (broadcast to all
connected WebSocket clients on open/close), `terminal_data` and `terminal_exited`
notifications (broadcast on PTY output and process exit), file watching via
`notify` crate (`filer_change` notifications on file add/change/delete within
open workspaces), and WebSocket connection tracking with `broadcast`/`send_to`
infrastructure. Database (PostgreSQL via `tokio-postgres`/`deadpool-postgres`),
HMAC-SHA256 cookie signing (`fuz_session`), blake3 session hashing.
All other methods return `method_not_found`.

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
curl -X POST http://localhost:1174/rpc \
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

| Method | Path         | Description                              |
|--------|--------------|------------------------------------------|
| POST   | `/rpc`       | JSON-RPC 2.0 (HTTP transport, auth-gated) |
| POST   | `/bootstrap` | One-shot admin account creation          |
| GET    | `/ws`        | JSON-RPC 2.0 (WebSocket, cookie/bearer)  |
| GET    | `/health`    | Health check (`{"status":"ok"}`)         |
| GET    | `/*`         | Static files (if `--static-dir`)         |

Note: the Deno server uses `/api/rpc`; the Rust server uses `/rpc`. The
integration test configs handle this difference.

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
   rejected (Origin/Referer headers present → bearer ignored). Token
   `last_used_at` touched fire-and-forget. Sets `CredentialType::ApiToken`.

5. **Auth pipeline** — Both transports try cookie first, then bearer.
   `ResolvedAuth` carries `credential_type` (`Session`, `ApiToken`,
   `DaemonToken`) and optional `token_hash` (session connections only —
   bearer connections have `None`, revocable only via account-level).

6. **Per-action auth** — Each RPC method has an auth level:
   - `public` — no auth required (`ping`)
   - `authenticated` — valid session or bearer token required (workspace_*, session_load, etc.)
   - `keeper` — requires `DaemonToken` credential type AND keeper role permit (`provider_update_api_key`). API tokens and session cookies cannot access keeper actions even if the account has the keeper permit.

7. **Bootstrap** — `POST /bootstrap` creates first admin account with keeper
   + admin permits. Reads token from `BOOTSTRAP_TOKEN_PATH`, timing-safe
   compare, Argon2 password hashing, all in a transaction with bootstrap_lock.

8. **Origin verification** — `ALLOWED_ORIGINS` patterns checked on requests
   with an `Origin` header. Supports exact match, wildcard port
   (`http://localhost:*`), subdomain wildcard (`https://*.example.com`).

9. **Socket revocation** — `close_sockets_for_session(token_hash)` and
   `close_sockets_for_account(account_id)` methods on `App` close matching
   WebSocket connections by dropping the channel sender. Session connections
   are revocable per-session or per-account; bearer connections are revocable
   only per-account. No callers yet (need account management routes or audit
   event hooks).

**Not yet implemented:** Daemon token auth (`X-Daemon-Token` header with
in-memory token rotation), daemon token rotation, account management routes
(login/logout/signup), audit event system for triggering socket revocation.

## Integration Tests

65 tests on Rust, 63 on Deno (some bearer tests are Rust-only). Both backends bootstrap auth (admin account + session cookie),
create a non-keeper user (account + actor + session, no keeper permit,
cookie signed via HMAC-SHA256), and insert API tokens into the `api_token`
table before tests. The test database (`zzz_test` by default, configurable
via `TEST_DATABASE_URL`) is cleaned (TRUNCATE CASCADE) before each backend
run. A scoped directory (`/tmp/zzz_integration_scoped`) is created for
filesystem tests. Tests are split across modules: `tests.ts` (core RPC,
auth, filesystem, terminal tests), `bearer_tests.ts` (bearer token auth,
keeper credential enforcement, session revocation), `test_helpers.ts`
(shared assertion and HTTP/WS helpers).

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
`provider_load_status_empty` — 2 tests verify session data loading and
provider status stub.

**Filesystem tests (both backends):** `diskfile_update_and_read`,
`diskfile_delete`, `directory_create`, `directory_create_already_exists`,
`diskfile_update_outside_scope`, `diskfile_update_path_traversal`,
`diskfile_update_relative_path`, `diskfile_delete_nonexistent` — 8 tests
verify scoped filesystem operations, idempotent directory creation, path
traversal rejection, relative path rejection, and nonexistent file deletion.

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
`bearer_token_ws_rejected_invalid`, `keeper_requires_daemon_token`
(Rust only), `ws_revocation_on_session_delete`,
`bearer_rejects_browser_context_origin`,
`bearer_rejects_browser_context_referer`, `bearer_empty_value`,
`bearer_cookie_priority` (Rust only) — 12 tests verify API token auth via
`Authorization: Bearer` header on HTTP and WebSocket, expired/invalid token
rejection, keeper credential enforcement (API tokens can't access keeper
actions), session revocation via DB delete, browser context rejection
(Origin/Referer headers → bearer ignored), empty bearer value handling,
and cookie-over-bearer priority.

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
├── main.rs        # Entry, config parsing (incl. PUBLIC_ZZZ_DIR), DB/keyring init, graceful shutdown
├── handlers.rs    # App (server state + connection tracking + watchers), Ctx, dispatch
├── rpc.rs         # JSON-RPC classify + notification builder, HTTP handler with auth pipeline
├── ws.rs          # WebSocket upgrade with cookie auth, connection tracking, select! message loop
├── auth.rs        # Keyring, cookie parsing, session validation, per-action auth
├── bootstrap.rs   # POST /bootstrap handler (account + session creation)
├── db.rs          # Connection pool, migrations, auth queries
├── filer.rs       # File watcher (notify crate) → filer_change notifications via broadcast
├── pty_manager.rs # PTY terminal manager (fuz_pty crate) → terminal_data/exited notifications
├── scoped_fs.rs   # Scoped filesystem — path validation, symlink rejection
└── error.rs       # ServerError (Bind, Serve, Database, Config)
```

**App/Ctx/dispatch pattern**: `App` holds long-lived server state (workspaces
in `RwLock<HashMap>`, `deadpool_postgres::Pool`, `Keyring`, origin config,
`ScopedFs`, `zzz_dir`, `scoped_dirs`, `PtyManager`, connection tracking via
`AtomicU64` + `RwLock<HashMap<ConnectionId, UnboundedSender>>`, file watchers
via `RwLock<HashMap<String, WorkspaceWatcher>>`), constructed once in `main`,
wrapped in `Arc`. `Ctx` is per-request context (borrows `App` + holds
`Arc<App>` for spawning tasks, `request_id`,
`auth: Option<&RequestContext>`), constructed by each transport before calling
`handlers::dispatch`.

**Auth pipeline** (HTTP RPC path):
1. Origin verification (if `Origin` header present)
2. Try cookie auth: parse `fuz_session` cookie → HMAC verify → blake3 hash → `auth_session` lookup
3. If no cookie: try bearer auth: `Authorization: Bearer` → reject browser context → blake3 hash → `api_token` lookup
4. Build `RequestContext` (account → actor → permits) with `CredentialType`
5. Check per-action auth level (keeper actions require `DaemonToken` credential type)

**Message classification** (`rpc::classify`) is transport-agnostic:
- HTTP: origin check → auth → classify → auth check → dispatch
- WS: upgrade auth (reject 401) → classify → per-action auth check → dispatch

## Known Issues

- **No per-message WS session revalidation** — upgrade-time auth only. Event-
  driven revocation (matching Deno) not yet implemented.
- **error.data gap** — Deno includes Zod validation details in `error.data`
  for -32602 errors; Rust omits `error.data`. The integration test
  `normalize_error_data` function handles this. No other error format
  asymmetries exist.

## Known Limitations

- 13 RPC methods (`ping`, `session_load`, `workspace_*`, `diskfile_update`, `diskfile_delete`, `directory_create`, `terminal_create`, `terminal_data_send`, `terminal_resize`, `terminal_close`, `provider_load_status` stub)
- 4 `remote_notification` actions: `workspace_changed` (broadcast on open/close), `filer_change` (file watcher via `notify` crate, recursive, ignores `.git`/`node_modules`/`.svelte-kit`/`target`/`dist`/`.zzz`), `terminal_data` (PTY stdout broadcast), `terminal_exited` (process exit broadcast)
- No batch request support (JSON arrays)
- Bearer token auth (API tokens) supported; no daemon token auth (`X-Daemon-Token`), no daemon token rotation, no account management routes
- Socket revocation infrastructure exists but no callers (needs account management routes or audit events)
- No completion/streaming or Ollama actions
- `provider_load_status` returns `[]` — no provider integration yet

## Design Decisions

- **DB**: `tokio-postgres` + `deadpool-postgres` pool in `App`. Required at
  startup — server fails fast if `DATABASE_URL` is missing or unreachable.
  Migrations run on every startup (CREATE TABLE IF NOT EXISTS).
- **Cookie signing**: Pure Rust HMAC-SHA256 via `hmac`/`sha2` crates.
  Compatible with fuz_app's keyring format (same `value.base64(signature)`).
- **Session hashing**: `blake3` crate for token → storage key hashing.
  Compatible with fuz_app's `hash_blake3` (same hex output).
- **Password hashing**: Argon2id via `argon2` crate (bootstrap only).
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

## What's Next

**Phase 3** (next):
1. Daemon token auth (`X-Daemon-Token` header with in-memory token rotation)
2. Account management routes (login/logout/signup) with audit events
3. Event-driven socket revocation (wire audit events to `close_sockets_for_*`)
4. Use connection tracking for `completion_progress` notifications
5. Codegen from Zod specs (action input/output types)
6. Real `provider_load_status` implementation (check Ollama availability)
7. Ollama integration (`ollama_list`, `ollama_ps`, completion pipeline)

Phase 4 (full action port: completions, Ollama). Terminal actions are
complete. See the [Rust Backends quest](../../grimoire/quests/rust-backends.md).
