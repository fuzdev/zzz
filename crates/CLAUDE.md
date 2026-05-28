# zzz Rust Backend

zzz's backend going forward, using axum. Same JSON-RPC 2.0 protocol and wire
format as the legacy TS/Deno backend (`src/lib/server/`), which is retained
only as the cross-backend parity reference. This Rust backend has reached
full behavioral parity — the SSE audit broadcast landed and Ollama (the last
divergence) has been retired from zzz entirely — so the TS backend is now
slated for removal. The integration tests enforce identical behaviour between
the two backends, gating that removal.

**Workspace layout**:
- `zzz_server/` — library + production binary. `pub async fn run_app(options: RunAppOptions)` in `src/lib.rs` owns the full lifecycle (env, signal handler, router build, listener bind, drain). `RunAppOptions` carries: `password_hasher` (production-vs-test swap), `default_port`, `force_test_actions` (overrides the `ZZZ_ENABLE_TEST_ACTIONS` env flag), and `extra_action_specs_factory` (lets the test binary inject `_testing_reset` without putting `fuz_testing` in the production dep graph). `src/main.rs` is the thin production entry — constructs `Argon2idHasher`, calls `run_app` with `force_test_actions: false, extra_action_specs_factory: None`.
- `testing_zzz_server/` — separate test-binary package wiring `fuz_testing::TestingArgon2idHasher` (~1-5 ms argon2 vs production's ~30-50 ms) AND `fuz_testing::create_testing_reset_action_spec` (auth-table wipe + fresh-keeper re-seed + consumer-supplied `reset_state(ActionDb)` callback; `credential_types: [DaemonToken]` auth gate). zzz's reset closure ignores the in-tx `ActionDb` handle (its domain state is in-memory, not in PG) — it clears zzz workspaces, calls `pty_manager.kill_all()` (non-destructive — manager stays usable across tests), and wipes the optional `ZZZ_TESTING_SCRATCH_DIR`. Default port 1175 (production is 1174). **Never ships in a release** — enforced by `fuz_release`'s `testing_` manifest filter and the `cargo xtask check-release` dep-graph audit. **TS-side peers**: `../src/lib/server/testing_server_{deno,node}.ts` over a shared `testing_server_core.ts` cover the same `_testing_reset` wire contract on the TS canonical backend — together the three test entries (Rust + Deno + Node) span both the cross-language axis (TS vs Rust) and the cross-runtime axis (Deno V8 vs Node V8) on the same wire shape.
- `xtask/` — dev automation. `cargo xtask check-release` thin-wraps `fuz_audit::run_check_release_cli()`; marked `[package.metadata.fuz_audit] dev_only = true` so xtask itself is excluded from the production scan.
- `zzz/` — Rust CLI scaffold (argh, stubs only).

AI provider system feature-complete for Anthropic; OpenAI /
Gemini stubs ship status only. Spine consumption is
complete — the spine crates (`fuz_db`, `fuz_auth`, `fuz_http`,
`fuz_realtime`, `fuz_actions`) own auth, HTTP, realtime, and the
boot-compiled `ActionRegistry` dispatch path. A single canonical
`/api/rpc` + `/api/ws` (mounted via `fuz_actions::create_rpc_router` /
`register_action_ws`) serves all dispatch; admin + account specs come
from fuz_auth's `auth_adapter::build_auth_spec_set`, the zzz-specific
workspace / filesystem / terminal / provider specs from
`zzz_action_specs/` (handlers in `handlers_v2/`), and the admin audit-log
SSE stream from `fuz_realtime::audit_stream_router`. The legacy in-house
dispatch surface (`Ctx` / `dispatch` / per-domain `handlers/*` / `auth/` /
`account/` / `db/` / `bootstrap.rs` / `audit/` / `rate_limiter.rs` /
`proxy.rs` / `api_token.rs` / `daemon_token.rs` / `perform_action.rs` /
`ws.rs`) was retired; `handlers/` now holds only `App` state plus a few
`broadcast` / `close_sockets_for_*` shims over `App.realtime`. 25 RPC methods:
`ping`, `session_load`, `workspace_*`, `diskfile_*`, `directory_create`,
`terminal_*`, `provider_load_status`, `provider_update_api_key`,
`completion_create`, `account_verify`, `account_session_list`,
`account_session_revoke`, `account_session_revoke_all`,
`account_token_create`, `account_token_list`, `account_token_revoke`,
`admin_session_revoke_all`, `admin_token_revoke_all`.
`_testing_emit_notifications` is gated behind
`ZZZ_ENABLE_TEST_ACTIONS=1` (set by the integration runner; production
leaves it unset, dispatch returns `method_not_found`). Full auth stack (cookie sessions, bearer tokens, daemon
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
~/dev/private_fuz/        (path deps: fuz_common, fuz_pty, plus the 5 spine crates — fuz_db, fuz_auth, fuz_http, fuz_realtime, fuz_actions)
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
cargo build --workspace
cargo clippy -p zzz_server        # workspace lints: pedantic + nursery
cargo xtask check-release         # audit: no production binary depends on fuz_testing / fuz_audit

# Run (requires DATABASE_URL and SECRET_FUZ_COOKIE_KEYS)
DATABASE_URL=postgres://localhost/zzz \
SECRET_FUZ_COOKIE_KEYS=dev-only-not-for-production-use-000 \
./target/debug/zzz_server --port 1174

# Test binary (cross-process integration tests — fast argon2)
DATABASE_URL=postgres://localhost/zzz_test \
SECRET_FUZ_COOKIE_KEYS=dev-only-not-for-production-use-000 \
./target/debug/testing_zzz_server

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
| `SECRET_FUZ_COOKIE_KEYS` | HMAC signing keys (min 32 chars, `__` separator for rotation) |

### Optional Environment Variables

| Variable                 | Purpose                                    |
|--------------------------|--------------------------------------------|
| `FUZ_BOOTSTRAP_TOKEN_PATH`   | Path to bootstrap token file           |
| `FUZ_ALLOWED_ORIGINS`        | Comma-separated origin patterns        |
| `PUBLIC_ZZZ_SCOPED_DIRS` | Comma-separated filesystem paths           |
| `ZZZ_PORT`               | Server port (default 1174, CLI overrides)  |
| `ZZZ_STATIC_DIR`         | Static file directory                      |
| `ZZZ_ENABLE_TEST_ACTIONS`| Register `_testing_*` actions on live dispatchers (mirrors Zod `z.stringbool()`: `true`/`1`/`yes`/`on`/`y`/`enabled` opt in; `false`/`0`/`no`/`off`/`n`/`disabled` or unset opt out; case-insensitive; anything else errors at startup. Integration tests only — production must leave unset) |
| `ZZZ_LOGIN_RATE_LIMIT_ENABLED`| Turn on per-IP + per-account rate limiting on `/login` and `/password` (same `z.stringbool()` shape as `ZZZ_ENABLE_TEST_ACTIONS`). Default off so existing integration tests don't trip the bucket. Defaults match fuz_app (5 attempts / 15 min IP, 10 / 30 min account). Per-IP key is the resolved client IP from `proxy::client_ip_middleware` — set `ZZZ_TRUSTED_PROXIES` when deploying behind a reverse proxy so the bucket keys on the originator, not the proxy. |
| `ZZZ_TRUSTED_PROXIES`        | Comma-separated trusted-proxy entries (IPs and CIDR ranges, e.g. `127.0.0.1,10.0.0.0/8,fe80::/10`). Unset/empty → no XFF trust → `client_ip` falls back to the TCP peer IP on every request (direct-bind behavior). Set when deploying behind nginx / a cloud LB so the trusted-proxy middleware walks `X-Forwarded-For` right-to-left and resolves the real client IP for rate limiting + `audit_log.ip`. Parsed eagerly at startup — invalid entries (malformed IPs, non-aligned CIDRs, out-of-range prefixes) fail server boot. Mirrors fuz_app's `http/proxy.ts`. |

## Endpoints

| Method | Path                              | Description                              |
|--------|-----------------------------------|------------------------------------------|
| GET    | `/api/rpc`                        | JSON-RPC 2.0 (cacheable reads, query params) |
| POST   | `/api/rpc`                        | JSON-RPC 2.0 (HTTP transport, auth-gated) |
| POST   | `/api/account/bootstrap`          | One-shot admin account creation          |
| POST   | `/api/account/signup`             | Public account creation (invite-gated by default; `open_signup=true` opens) |
| GET    | `/api/account/status`             | Current account info or 401 + bootstrap status |
| POST   | `/api/account/login`              | Username/password login → session cookie |
| POST   | `/api/account/logout`             | Invalidate session, close WS connections |
| POST   | `/api/account/password`           | Change password, revoke all sessions/tokens |
| GET    | `/api/ws`                         | JSON-RPC 2.0 (WebSocket, cookie/bearer/daemon) |
| GET    | `/api/admin/audit/stream`         | Admin-gated audit-log SSE stream (`text/event-stream`) |
| GET    | `/health`                         | Health check (`{"status":"ok"}`)         |
| GET    | `/*`                              | Static files (if `--static-dir`)         |

Route paths match the Deno server — both backends use the same `/api/*` prefix.
Integration tests use identical config for both backends.

## Auth

Cookie-based session auth and bearer token auth mirroring fuz_app's auth stack:

1. **Keyring** — HMAC-SHA256 cookie signing with key rotation support.
   Keys from `SECRET_FUZ_COOKIE_KEYS` env, separated by `__`. First key signs,
   all keys verify.

2. **Cookie format** — `fuz_session` cookie containing signed
   `{session_token}:{expires_at}.{base64_signature}`. 30-day expiry,
   `Secure; HttpOnly; SameSite=Strict`.

3. **Session validation** — Cookie → HMAC verify → blake3 hash token →
   `auth_session` table lookup → build `RequestContext` (account, actor,
   role grants). Sessions touched (last_seen_at updated) fire-and-forget.

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
   - `keeper` — requires `DaemonToken` credential type AND keeper role grant (`provider_update_api_key`). API tokens and session cookies cannot access keeper actions even if the account has the keeper role grant.

8. **Bootstrap** — `POST /bootstrap` creates first admin account with keeper
   + admin role grants. Reads token from `FUZ_BOOTSTRAP_TOKEN_PATH`, timing-safe
   compare, Argon2 password hashing, all in a transaction with bootstrap_lock.

9. **Origin verification** — `FUZ_ALLOWED_ORIGINS` patterns checked on requests
   with an `Origin` header. Supports exact match, wildcard port
   (`http://localhost:*`), subdomain wildcard (`https://*.example.com`).

10. **Socket revocation** — `close_sockets_for_session(token_hash)`,
    `close_sockets_for_token(api_token_id)`, and
    `close_sockets_for_account(account_id)` methods on `App` close matching
    WebSocket connections by dropping the channel sender; the ws loop breaks
    on `recv()` returning `None` and sends a 4001 (`WS_CLOSE_SESSION_REVOKED`)
    Close frame so clients can distinguish revocation from normal close.
    Session connections are revocable per-session, per-token (for the bearer
    on this connection — n/a for cookie sessions), or per-account. Called by
    logout (per-session), password change (per-account), and
    `account_token_revoke` (per-token).

11. **Account status** — `GET /api/account/status` returns account info +
    role grants (200) when authenticated, or 401 with optional
    `bootstrap_available` flag when not. Consumed by fuz_app's `AuthState`
    for the frontend auth gate (bootstrap → login → verified flow).

12. **Account management** — `POST /api/account/login` (username/password →
    session cookie with enumeration prevention via dummy hash),
    `POST /api/account/logout` (invalidate session + close WS connections),
    `POST /api/account/password` (change password, revoke all sessions + API
    tokens, close all WS connections). Session listing and revocation moved
    to JSON-RPC: `account_verify`, `account_session_list`,
    `account_session_revoke`, `account_session_revoke_all`,
    `account_token_create`, `account_token_list`, `account_token_revoke`
    (all scoped to the authenticated account), plus the admin role-gated
    `admin_session_revoke_all` / `admin_token_revoke_all` which target a
    caller-supplied `account_id`.

## Integration Tests

94 cross-backend tests (95 with the new `login_forbidden_origin` shared
test) + 17 Rust-only (`bearer_rejects_account_token_create_ws` skipped on
Deno per the deferred fuz_app upstream; `rate_limit_login_blocks_after_threshold`
skipped on Deno because the rate-limit env-var gate is Rust-only — Deno's
limiter is fuz_app's concern; ten `proxy_*` tests skipped on Deno because
fuz_app already covers the TS port of the proxy module at the unit-test
layer in `http/proxy.test.ts` (87 cases) and `crates/zzz_server/src/proxy.rs`
carries 86 `#[cfg(test)]` unit tests Rust-side, plus 7 `origin_tests` in
`auth/spec.rs` covering the shared `is_request_origin_allowed` helper; five
`admin_*` tests skipped on Deno because the Deno reference backend does
not expose admin RPC methods today). All
cross-backend tests pass on both
backends (0 skips on the shared set). Both backends bootstrap
auth (admin account + session cookie), create a non-keeper user (account +
actor + session, no
keeper role grant, cookie signed via HMAC-SHA256), and insert API tokens into
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
`ws_revocation_on_session_delete`, `ws_revocation_only_for_revoked_token`,
`bearer_rejects_browser_context_origin`,
`bearer_rejects_browser_context_referer`, `bearer_empty_value`,
`bearer_cookie_priority` — 13 tests verify API token auth via
`Authorization: Bearer` header on HTTP and WebSocket, expired/invalid token
rejection, keeper credential enforcement (API tokens can't access keeper
actions), session revocation via DB delete, per-token revocation granularity
(revoking one bearer token closes its socket only, not other sockets on the
same account), browser context discard (Origin/Referer headers → bearer
silently ignored), empty bearer value handling, and cookie-over-bearer priority.

**Audit emission tests (both backends):** `audit_bootstrap_success`,
`audit_token_create_records_credential_type`,
`audit_session_revoke_all_records_credential_type`,
`audit_password_change_records_credential_type`,
`audit_password_change_failure_records_credential_type` — 5 tests
verify the bootstrap success row (carries `account_id` + `actor_id`,
`metadata: null`) plus the four credential-gated paths (RPC
`account_token_create` / `account_session_revoke_all` + REST
`POST /password` on success and wrong-password failure) writing
`audit_log` rows with `metadata.credential_type === 'session'` (the
v0.63.0 wire-shape contract). The `password_change_concurrent_change`
test under §Account management additionally verifies
`metadata.reason === 'concurrent_change'` on the verify-write race
loser. Direct `psql` query against the `audit_log` table — no
admin RPC route required.

**Account management tests (both backends):**
`login_success`, `login_invalid_password`, `login_nonexistent_user`,
`logout_clears_session`, `logout_unauthenticated`,
`password_change_revokes_all`, `password_wrong_current`,
`password_change_concurrent_change`,
`session_list`, `session_revoke`, `account_verify`, `session_revoke_all`,
`token_create`, `token_list` — 14 tests verify login with
valid/invalid/nonexistent credentials, logout with session invalidation and
cookie clearing, password change with full session + token revocation and
re-login verification, the verify-write race detection (two concurrent
password changes against the same starting hash: one wins, one returns
401 with `metadata.reason === 'concurrent_change'`), session listing
(with `account_id` field), single session revocation (idempotent with
`revoked` field), self-account verify echoing `SessionAccountJson`
(no `password_hash` leak), bulk session revocation closing every socket
on the account (cookie, bearer, and daemon-token — matches fuz_app
`transports_ws_auth_guard`), token creation with bearer round-trip
(raw `secret_fuz_token_…` validates against the same backend's
`Authorization: Bearer` path), and token listing in `ClientApiTokenJson`
shape (no `token_hash` field anywhere).

**Rate limit tests (Rust-only):** `rate_limit_login_blocks_after_threshold`
— runs in a dedicated post-suite phase that restarts the Rust backend
with `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1`. Fires 5 failed logins, asserts
the 6th returns 429 with `{error: 'rate_limit_exceeded', retry_after}`
plus a `Retry-After` header, and asserts correct credentials are also
blocked while the bucket is full (the limiter check runs before
argon2 verify). Skipped on Deno via `skip: ['deno']` — Deno's rate
limiter is fuz_app's concern.

**Trusted-proxy tests (Rust-only):** `proxy_no_xff_uses_connection_ip`,
`proxy_trusted_xff_resolves_to_originator`,
`proxy_multi_hop_stops_at_first_untrusted`,
`proxy_malformed_xff_entry_skipped`,
`proxy_all_trusted_xff_falls_back_to_leftmost`,
`proxy_empty_xff_uses_connection_ip`,
`proxy_ipv6_originator_in_xff`,
`proxy_ipv4_mapped_xff_normalizes`,
`proxy_multi_hop_with_malformed_then_untrusted`,
`proxy_all_malformed_xff_falls_back_to_connection_ip` — runs in a
dedicated post-suite phase that restarts the Rust backend with
`ZZZ_TRUSTED_PROXIES=127.0.0.1`. Each test triggers a failed login
under a unique `proxy-test-<label>-<uuid>` username and asserts the
resulting `audit_log.ip` row matches the expected resolved client IP
for that XFF + connection-IP combination. Skipped on Deno via
`skip: ['deno']` — fuz_app covers the TS port at the unit-test layer
in `http/proxy.test.ts` (87 cases); `crates/zzz_server/src/proxy.rs`
ships 86 Rust unit tests covering the pure functions
(`normalize_ip` including the IPv6 canonicalization and the
ipv4-mapped collapse ordering, `validate_ip_strict`,
`parse_proxy_entry` + all `ProxyParseError` variants including the
non-aligned `/0` regressions, `parse_proxy_list`, `is_trusted_ip`
including the cross-family CIDR guard, `resolve_client_ip` including
malformed-skip and leftmost-fallback, `cidr_contains` shift-edge
cases).

```bash
npm run test:cross:rust                                                   # Both rust projects (rust + rust_proxy) — flag baked in
npm run test:cross                                                        # Both TS projects (ts_node + ts_deno; no external infra)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust       # Single project (Rust binary; postgres://localhost/zzz_test)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust_proxy # Single project (proxy variant; ZZZ_TRUSTED_PROXIES=127.0.0.1, proxy.cross.test.ts only)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_node    # Single project (Node TS adapter; PGlite in-memory)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_ts_deno    # Single project (Deno TS adapter; PGlite in-memory)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run -t ping                            # Substring match on test name (vitest -t flag)
```

The `cross_backend_*` projects are gated behind `FUZ_TEST_CROSS_BACKEND=1`
in `vite.config.ts` so a bare `gro test` never spawns backends. The
`test:cross` / `test:cross:rust` package.json scripts bake the flag in
(and run via `deno task` under Deno 2); set the flag manually only for the
single-project `--project` runs.

The harness writes a bootstrap token to a per-backend tmpdir, spawns the
test binary via the project's `BackendConfig.start_command`, waits for
health, bootstraps an admin account via `POST /api/account/bootstrap`,
then provides the bootstrapped handle to test files via vitest's
`inject('backend_handle')`. SIGTERM on globalSetup teardown leaves no
stranded ports. Rust projects target a real PostgreSQL at
`postgres://localhost/zzz_test` (cleaned by `_testing_reset` between
tests, preserving the keeper row); TS projects target in-memory
PGlite. The old `zzz/test/integration/` runner this section once
described was deleted in cross-process lift §3d.9.

## Architecture

```
crates/zzz_server/src/
├── lib.rs            # `run_app(RunAppOptions)` — full lifecycle: env/config, DB pool + migrations, spine state construction (keyring, daemon token, audit emitter, connection + SSE registries, rate limiters), `ActionRegistry::compile`, file watchers, route composition, graceful shutdown
├── main.rs           # Thin production entry — constructs `Argon2idHasher`, calls `run_app`
├── handlers/
│   └── mod.rs        # `App` long-lived state (workspaces, `db_pool`, `ScopedFs`, `FilerManager`, `PtyManager`, `ProviderManager`, `realtime`, `action_registry` OnceLock) + the `broadcast` / `close_sockets_for_*` shims over `App.realtime`
├── handlers_v2/      # zzz-specific spine-signature handlers (`(Value, ActionContext<'_>, Arc<App>)`), registered into the `ActionRegistry` via `zzz_action_specs::build_*_specs`
│   ├── mod.rs
│   ├── core.rs       # ping, session_load, _testing_emit_notifications
│   ├── filesystem.rs # diskfile_update, diskfile_delete, directory_create
│   ├── provider.rs   # provider_load_status, provider_update_api_key, completion_create
│   ├── terminal.rs   # terminal_create, terminal_data_send, terminal_resize, terminal_close
│   └── workspace.rs  # workspace_list, workspace_open, workspace_close (+ workspace_changed broadcast)
├── zzz_action_specs/ # Per-domain `ActionSpec` builders consumed by `run_app`'s `ActionRegistry::compile`; each captures `Arc<App>` and calls the matching `handlers_v2::*` fn
│   ├── mod.rs
│   ├── core.rs
│   ├── filesystem.rs
│   ├── provider.rs
│   ├── terminal.rs
│   └── workspace.rs
├── rpc.rs            # JSON-RPC helpers — error constructors + the `notification` builder used by broadcast / send_to sites
├── provider/         # AI provider system
│   ├── mod.rs        # ProviderName, ProviderStatus, Provider enum, ProviderManager, CompletionOptions
│   ├── anthropic.rs  # AnthropicProvider — Messages API with SSE streaming
│   ├── common.rs     # shared provider helpers
│   ├── sse.rs        # provider SSE parsing
│   ├── openai.rs     # OpenAiProvider stub (status only)
│   └── gemini.rs     # GeminiProvider stub (status only)
├── filer.rs          # Filer + FilerManager (notify crate) — immediate file index updates, debounced filer_change broadcasts
├── pty_manager.rs    # PTY terminal manager (fuz_pty crate) → terminal_data/exited notifications
├── scoped_fs.rs      # Scoped filesystem — path validation, symlink rejection
└── error.rs          # ServerError (Bind, Serve, Database, Config)
```

Auth, HTTP / origin / proxy, realtime (WS + SSE), dispatch (`ActionRegistry`
+ `perform_action`), and DB pool / migrations all live in the spine crates
(`fuz_auth` / `fuz_http` / `fuz_realtime` / `fuz_actions` / `fuz_db`) —
`zzz_server` composes them in `run_app`. The legacy in-house `auth/`,
`account/`, `db/`, `audit/`, `bootstrap.rs`, `rate_limiter.rs`, `proxy.rs`,
`api_token.rs`, `daemon_token.rs`, `perform_action.rs`, `ws.rs`, and
per-domain `handlers/*` modules were retired.

**App + dispatch**: `App` (in `handlers/mod.rs`) holds zzz's long-lived,
non-spine state — `workspaces` (`RwLock<HashMap>`), `db_pool`, `ScopedFs`,
`zzz_dir`, `scoped_dirs`, `FilerManager` (per-watcher ignore config, event
debouncing, in-memory file index, lifetime tracking — permanent for
`zzz_dir`/`scoped_dirs`, workspace-scoped for `workspace_open`),
`PtyManager`, `ProviderManager`, `completion_options`, `enable_test_actions`,
the spine `realtime: Arc<fuz_realtime::ConnectionRegistry>`, and the
boot-compiled `action_registry: OnceLock<Arc<fuz_actions::ActionRegistry>>`
(OnceLock because the spec builders capture `Arc<App>`). Constructed once
in `run_app`, wrapped in `Arc`. Auth keyring, daemon-token state, audit
emitter, rate limiters, allowed-origins, and trusted-proxy config are spine
types built in `run_app` and threaded into the spine route states
(`fuz_auth::AccountRouteState` / `BootstrapRouteState` / `SignupRouteState`,
`fuz_actions::RpcRouteState` / `WsRouteState`, and
`fuz_realtime::AuditStreamRouteState`) — not fields on `App`.

**Dispatch + auth run in the spine.** A single `/api/rpc` (via
`fuz_actions::create_rpc_router`) and `/api/ws` (via `register_action_ws`
→ `fuz_realtime::run_ws_connection`) drive the `ActionRegistry`;
`fuz_actions::perform_action` owns the spec lookup, per-action auth
(credential + role gates — keeper actions require the `DaemonToken`
credential type), the transactional `side_effects` wrap, and the
post-commit pending-effects drain. Auth resolution (daemon-token → cookie →
bearer), Origin verification, trusted-proxy client-IP resolution, and rate
limiting are `fuz_auth` / `fuz_http` concerns. Account / bootstrap / signup
REST routes come from fuz_auth's routers; the admin audit-log SSE stream
from `fuz_realtime::audit_stream_router`.

**Audit emission**: all audit rows go through the spine
`fuz_auth::AuditEmitter` (`spine_audit_emitter`, built in `run_app`),
shared by the account / bootstrap / signup routers and the RPC dispatch
path. Two listener sets hang off its event chain, both registered in
`run_app` after `Arc<App>` exists:

- `fuz_auth::register_socket_revocation_listeners` — the WS half: closes
  matching WebSocket connections on `session_revoke` / `token_revoke`
  (granular) and `session_revoke_all` / `token_revoke_all` /
  `password_change` / `logout` (account-wide). Revocation-emitting handlers
  also call `close_sockets_for_*` synchronously before emitting, so
  revocation lands even if the audit INSERT later fails.
- `fuz_realtime::register_audit_sse_listener` — the SSE half: fans every
  audit row to the open `GET /api/admin/audit/stream` subscriptions as one
  `data:` frame and closes an account's streams on the account-wide
  revocation events.

Failure-outcome rows never trigger socket / stream close — they carry
caller-submitted metadata (e.g. a failed `session_revoke` records the
submitted `session_id`), so reacting to them would let an authenticated
user disconnect another by guessing an id. The credential-channel
metadata contract, the bootstrap success/failure audit rows, and the
`password_change` `concurrent_change` race row are all spine
(`fuz_auth`) behaviors now — see fuz_app's `auth/` docs for their shapes.

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
- **filer file-size cap intentional divergence** — `filer::MAX_INDEXED_FILE_SIZE`
  (4 MiB, `crates/zzz_server/src/filer.rs:22`) caps the in-memory index: files
  over 4 MiB carry their metadata but store `contents: None`. The Deno
  reference (`gro/src/lib/filer.ts`) and `fuz_app` have no cap today —
  `readTextFile` runs unconditionally, so multi-MB lockfiles / generated
  artifacts get pulled into RSS. The Rust port is deliberately stricter to
  bound memory under workspaces containing large lockfiles or build outputs.
  Tracked for upstream convergence so fuz_app converges DOWN to the
  bounded posture rather than Rust loosening.
  Cross-backend integration tests don't exercise files >4 MiB so parity is
  maintained on the existing fixture set.

### Cross-Backend Response Divergences

Tracked asymmetries between the Rust backend and the legacy TS/Deno parity
reference. Bearer auth response format (issue #1) was resolved — both backends
now produce identical JSON-RPC envelopes for all auth failures.

| Issue | Status | Detail |
|-------|--------|--------|
| Bearer invalid/expired token | **Resolved** | Both backends soft-fail → JSON-RPC `-32001` unauthenticated |
| `provider_load_status` shape | **Resolved** | Both backends return `{status: ProviderStatus}` per the action spec. Test is cross-backend (no backend branching). |
| `session_list` response | **Resolved** | Both backends now return `{sessions: [{id, account_id, created_at, last_seen_at, expires_at}]}` matching fuz_app `AuthSessionJson`. Tests are cross-backend. |
| `session_revoke` format | **Resolved** | Both backends now return `{ok: true, revoked: boolean}` with idempotent 200 responses via the `account_session_revoke` JSON-RPC method. Tests are cross-backend. |
| `error.data` (validation) | Intentional | Deno includes Zod issues in `error.data` for -32602; Rust omits. Intentional divergence — Rust's omission is the safer production default, Deno's inclusion aids DX. Handled by `normalize_error_data` in tests. Future: environment-conditional in both backends (include in dev, strip in prod). |

## Known Limitations

- 25 RPC methods (`ping`, `session_load`, `workspace_*`, `diskfile_update`, `diskfile_delete`, `directory_create`, `terminal_*`, `provider_load_status`, `provider_update_api_key` keeper-only, `completion_create`, `account_verify`, `account_session_list`, `account_session_revoke`, `account_session_revoke_all`, `account_token_create`, `account_token_list`, `account_token_revoke`, `admin_session_revoke_all` admin-only, `admin_token_revoke_all` admin-only)
- 5 `remote_notification` actions: `workspace_changed` (broadcast on open/close), `filer_change` (`FilerManager` with `notify` crate — recursive watching, 80ms debounced broadcasts with immediate index updates, per-watcher ignore config, in-memory file index; ignores `.git`/`node_modules`/`.svelte-kit`/`target`/`dist` globally plus zzz dir name for workspace/scoped_dir watchers; startup filers on `zzz_dir` and `scoped_dirs`, per-workspace filers with dedup and lifetime tracking), `terminal_data` (PTY stdout broadcast), `terminal_exited` (process exit broadcast), `completion_progress` (streaming completion chunks to requesting WS connection)
- AI providers: Anthropic fully implemented (non-streaming + SSE streaming), OpenAI/Gemini stubs (status only)
- No batch request support (JSON arrays)
- `/api/account/signup` is mounted on both backends (Rust via `fuz_auth::signup_routes`, added 2026-05-19 in cross-backend-integration quest Phase 3b.2; Deno via `create_signup_route_specs`, added in cross-process 3d.4 Issue 5). Invite-gated by default (`app_settings.open_signup=false`); admins flip the setting via `app_settings_update` to enable open signup. The cross-process test binary opts into `open_signup: true` at startup via `app_settings_patch` so per-test `mint_account` can sign up without invites. Rust `app_settings` is loaded per-request today; a cached `Arc<RwLock<AppSettings>>` shared with the future admin `app_settings_update` handler lands when that admin RPC moves to Rust.
- No token management routes (GET /tokens, POST /tokens/create, etc.)
- Admin audit-log SSE broadcast is live at `GET /api/admin/audit/stream` — the shared `fuz_realtime::audit_stream_router`, wired to the spine `AuditEmitter` via `fuz_realtime::register_audit_sse_listener` alongside the WS socket-revocation listeners. Byte-identical wire shape to fuz_app's `audit_log_sse`; the `sse.cross.test.ts` cross-backend suite verifies it on both backends. Close-on-revoke keys on the union of access-invalidation events, matching fuz_app's TS guard: `session_revoke` (session-hash-scoped) / `session_revoke_all` / `token_revoke_all` / `password_change` / `logout` (account-wide) / `role_grant_revoke` (role-matched). The single `token_revoke` is excluded (no SSE stream is keyed by an API token)
- Login/password rate limiting is **opt-in via `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1`** (default off so existing integration tests don't trip the bucket). When enabled, per-IP (5 attempts / 15 min) + per-account (10 / 30 min) sliding windows fire on `/login` and `/password`; 429 carries `{error: 'rate_limit_exceeded', retry_after}` plus a `Retry-After` header. Per-IP key is the resolved client IP from `proxy::client_ip_middleware` — set `ZZZ_TRUSTED_PROXIES` when running behind a reverse proxy so the bucket keys on the originating client rather than the proxy

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
- **`parking_lot::RwLock`** for sync handlers (workspaces, scoped-fs); no
  poisoning. Async handlers (filer, pty, providers) use `tokio::sync::RwLock`
  where a guard is held across an await — scope sync guards before await points.
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
- **Dispatcher transaction wrap**: `fuz_actions::perform_action` wraps
  `side_effects: true` actions in a `tokio_postgres` transaction (commit on
  `Ok`, rollback on `Err`) and drains post-commit pending effects, so paired
  writes commit atomically and read-only actions skip the pool entirely.
  zzz's `handlers_v2` functions receive the `ActionContext` DB handle and
  stay transaction-agnostic — the wrap is the spine's concern.

## What's Next

**Rust Spine consumption — complete.** The spine crates (`fuz_db`,
`fuz_auth`, `fuz_http`, `fuz_realtime`, `fuz_actions`) own auth, HTTP,
realtime, and dispatch. A single `/api/rpc` + `/api/ws` (via
`fuz_actions::create_rpc_router` / `register_action_ws`) serves the
boot-compiled `ActionRegistry`; account / bootstrap / signup REST come
from fuz_auth's routers; the admin audit-log SSE stream
(`GET /api/admin/audit/stream`) comes from
`fuz_realtime::audit_stream_router` + `register_audit_sse_listener`. The
legacy in-house dispatch path (`Ctx` / `dispatch` / per-domain
`handlers/*` / `auth/` / `account/` / `db/` / `bootstrap.rs` / `audit/` /
`rate_limiter.rs` / `proxy.rs` / `api_token.rs` / `daemon_token.rs` /
`perform_action.rs` / `ws.rs`) was deleted — `handlers/` retains only
`App` state + the `broadcast` / `close_sockets_for_*` shims over
`App.realtime`.

Behavioral parity is reached — Ollama (the last divergence) has been retired
from zzz entirely, so the TS backend is ready to delete once the canonical
parity role moves to the dual-impl forge consumer.

**AI providers** (Anthropic complete, others pending):
- [x] Provider system: enum-dispatched `Provider` with `ProviderManager`, `ProviderStatus`, `CompletionOptions`
- [x] Anthropic provider: full implementation with `reqwest` HTTP client, SSE streaming, message format conversion
- [x] `provider_load_status` handler (cross-backend, all 3 providers report status)
- [x] `provider_update_api_key` handler (keeper-only, runtime API key updates)
- [x] `completion_create` handler with `completion_progress` streaming notifications (targeted to requesting WS connection)
- [x] `session_load` returns real provider status from all providers
- [ ] OpenAI provider: full completion implementation
- [ ] Gemini provider: full completion implementation

**Other remaining work**:
1. Codegen from Zod specs (action input/output types)
2. Token management routes (create, list, revoke API tokens)
- [x] Trusted-proxy client-IP resolution (XFF + CIDR + strict-IP
  validation), Origin allowlist (Origin-only, no Referer fallback), and
  login-username canonicalization — all now provided by the spine
  (`fuz_http` proxy/origin + `fuz_auth`); zzz wires them via config
  (`ZZZ_TRUSTED_PROXIES`, `FUZ_ALLOWED_ORIGINS`).
