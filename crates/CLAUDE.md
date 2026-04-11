# zzz Rust Backend

Shadow implementation of the Deno/Hono server using axum. Same JSON-RPC 2.0
protocol, same wire format — the Deno server is ground truth and the
integration tests enforce identical behaviour between both backends.

Phase 2b complete: cookie-based auth on both HTTP and WebSocket, filesystem
actions (`diskfile_update`, `diskfile_delete`, `directory_create`) with
`ScopedFs` path safety, per-action auth checks on all transports, and a
bootstrap endpoint for first-time account creation. Database (PostgreSQL via
`tokio-postgres`/`deadpool-postgres`), HMAC-SHA256 cookie signing
(`fuz_session`), blake3 session hashing. All other methods return
`method_not_found`.

## Prerequisites

`private_fuz` must be checked out as a sibling directory:

```
~/dev/zzz/               (this repo)
~/dev/private_fuz/        (path dep: fuz_common)
```

If the path dep is missing, `cargo build` will fail with
`failed to read .../private_fuz/crates/fuz_common/Cargo.toml`.

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
| GET    | `/ws`        | JSON-RPC 2.0 (WebSocket, cookie auth)    |
| GET    | `/health`    | Health check (`{"status":"ok"}`)         |
| GET    | `/*`         | Static files (if `--static-dir`)         |

Note: the Deno server uses `/api/rpc`; the Rust server uses `/rpc`. The
integration test configs handle this difference.

## Auth

Cookie-based session auth mirroring fuz_app's auth stack:

1. **Keyring** — HMAC-SHA256 cookie signing with key rotation support.
   Keys from `SECRET_COOKIE_KEYS` env, separated by `__`. First key signs,
   all keys verify.

2. **Cookie format** — `fuz_session` cookie containing signed
   `{session_token}:{expires_at}.{base64_signature}`. 30-day expiry,
   `Secure; HttpOnly; SameSite=Strict`.

3. **Session validation** — Cookie → HMAC verify → blake3 hash token →
   `auth_session` table lookup → build `RequestContext` (account, actor,
   permits). Sessions touched (last_seen_at updated) fire-and-forget.

4. **Per-action auth** — Each RPC method has an auth level:
   - `public` — no auth required (`ping`)
   - `authenticated` — valid session required (workspace_*, session_load, etc.)
   - `keeper` — keeper role permit required (`provider_update_api_key`)

5. **Bootstrap** — `POST /bootstrap` creates first admin account with keeper
   + admin permits. Reads token from `BOOTSTRAP_TOKEN_PATH`, timing-safe
   compare, Argon2 password hashing, all in a transaction with bootstrap_lock.

6. **Origin verification** — `ALLOWED_ORIGINS` patterns checked on requests
   with an `Origin` header. Supports exact match, wildcard port
   (`http://localhost:*`), subdomain wildcard (`https://*.example.com`).

**Not yet implemented:** Bearer token auth, daemon token rotation, account
management routes (login/logout/signup), event-driven socket revocation.

## Integration Tests

30 tests verify identical Deno/Rust behaviour. Both backends bootstrap
auth (admin account + session cookie) before tests. The test database
(`zzz_test` by default, configurable via `TEST_DATABASE_URL`) is cleaned
(TRUNCATE CASCADE) before each backend run. A scoped directory
(`/tmp/zzz_integration_scoped`) is created for filesystem tests.

**WS tests (both backends):** `ping_ws`, `parse_error_ws`,
`method_not_found_ws`, `invalid_request_ws`, `notification_ws`,
`multi_message_ws` — 6 tests verify identical WS behaviour.

**HTTP tests (both backends):** `null_id_is_invalid`, `parse_error_http`,
`parse_error_empty_body`, `method_not_found_http`, `invalid_request_*`
(4 variants), `notification_http` — 9 tests verify identical HTTP behaviour.

**HTTP tests (both backends):** `ping_http`, `ping_numeric_id` — ping handler
echoes the JSON-RPC request id back as `ping_id`.

**Cross-backend:** `health_check` — 1 test on both backends.

**Workspace tests (both backends):** `workspace_open_and_list`,
`workspace_open_idempotent`, `workspace_open_nonexistent`,
`workspace_close` — 4 tests.

**Auth tests (both backends):** `auth_required_without_cookie`,
`auth_required_invalid_cookie`, `auth_public_no_cookie` — 3 tests verify
auth enforcement (unauthenticated → -32001/401, public → success).

**WebSocket auth test (both backends):** `ws_auth_required` — 1 test verifies
unauthenticated WS upgrade is rejected.

**Filesystem tests (both backends):** `diskfile_update_and_read`,
`diskfile_delete`, `directory_create`, `diskfile_update_outside_scope` —
4 tests verify scoped filesystem operations and path rejection.

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
├── main.rs        # Entry, config parsing, DB/keyring init, graceful shutdown
├── handlers.rs    # App (server state), Ctx (per-request + auth), dispatch
├── rpc.rs         # JSON-RPC classify, HTTP handler with auth pipeline
├── ws.rs          # WebSocket upgrade with cookie auth + message loop
├── auth.rs        # Keyring, cookie parsing, session validation, per-action auth
├── bootstrap.rs   # POST /bootstrap handler (account + session creation)
├── db.rs          # Connection pool, migrations, auth queries
├── scoped_fs.rs   # Scoped filesystem — path validation, symlink rejection
└── error.rs       # ServerError (Bind, Serve, Database, Config)
```

**App/Ctx/dispatch pattern**: `App` holds long-lived server state (workspaces
in `RwLock<HashMap>`, `deadpool_postgres::Pool`, `Keyring`, origin config,
`ScopedFs`), constructed once in `main`, wrapped in `Arc`. `Ctx` is per-request
context (borrows `App`, `request_id`, `auth: Option<&RequestContext>`),
constructed by each transport before calling `handlers::dispatch`.

**Auth pipeline** (HTTP RPC path):
1. Origin verification (if `Origin` header present)
2. Parse `fuz_session` cookie from `Cookie` header
3. Verify HMAC signature via keyring
4. Hash session token (blake3) → look up in `auth_session` table
5. Build `RequestContext` (account → actor → permits)
6. Check per-action auth level before dispatch

**Message classification** (`rpc::classify`) is transport-agnostic:
- HTTP: origin check → auth → classify → auth check → dispatch
- WS: upgrade auth (reject 401) → classify → per-action auth check → dispatch

## Known Issues

- **No keeper auth-rejection test** — missing: keeper method without keeper
  role (requires a non-keeper authenticated user).
- **No per-message WS session revalidation** — upgrade-time auth only. Event-
  driven revocation (matching Deno) not yet implemented.

## Known Limitations

- 7 RPC methods (`ping`, `workspace_*`, `diskfile_update`, `diskfile_delete`, `directory_create`)
- No batch request support (JSON arrays)
- No WebSocket connection tracking for broadcast notifications
- No bearer token auth, daemon token rotation, or account management routes
- No file watching / `filer_change` notifications
- No completion/streaming, Ollama, or terminal actions

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

## What's Next

**Phase 3** (next):
1. Bearer token auth (API tokens, daemon tokens)
2. WebSocket connection tracking for broadcast notifications
3. Event-driven socket revocation (session/token revoke, logout, password change)
4. Keeper auth-rejection integration test (non-keeper user)
5. Codegen from Zod specs (action input/output types)

Phase 4 (full action port: completions, Ollama, terminals). See the
[Rust Backends quest](../../grimoire/quests/rust-backends.md).
