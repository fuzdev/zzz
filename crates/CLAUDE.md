# zzz Rust Backend

Shadow implementation of the Deno/Hono server using axum. Same JSON-RPC 2.0
protocol, same wire format — the Deno server is ground truth and the
integration tests enforce identical behaviour between both backends.

**Workspace layout**:
- `zzz_server/` — library + production binary. `pub async fn run_app(options: RunAppOptions)` in `src/lib.rs` owns the full lifecycle (env, signal handler, router build, listener bind, drain). `RunAppOptions` carries: `password_hasher` (production-vs-test swap), `default_port`, `force_test_actions` (overrides the `ZZZ_ENABLE_TEST_ACTIONS` env flag), and `extra_action_specs_factory` (lets the test binary inject `_testing_reset` without putting `fuz_testing` in the production dep graph). `src/main.rs` is the thin production entry — constructs `Argon2idHasher`, calls `run_app` with `force_test_actions: false, extra_action_specs_factory: None`.
- `testing_zzz_server/` — separate test-binary package wiring `fuz_testing::TestingArgon2idHasher` (~1-5 ms argon2 vs production's ~30-50 ms) AND `fuz_testing::create_testing_reset_action_spec` (auth-table reset preserving keeper + consumer-supplied `reset_state` callback; `credential_types: [DaemonToken]` auth gate). The reset closure here clears zzz workspaces, calls `pty_manager.kill_all()` (non-destructive — manager stays usable across tests), and wipes the optional `ZZZ_TESTING_SCRATCH_DIR`. Default port 1175 (production is 1174). **Never ships in a release** — enforced by `fuz_release`'s `testing_` manifest filter and the `cargo xtask check-release` dep-graph audit. **TS-side peers**: `../src/lib/server/testing_server_{deno,node}.ts` over a shared `testing_server_core.ts` cover the same `_testing_reset` wire contract on the TS canonical backend — together the three test entries (Rust + Deno + Node) span both the cross-language axis (TS vs Rust) and the cross-runtime axis (Deno V8 vs Node V8) on the same wire shape.
- `xtask/` — dev automation. `cargo xtask check-release` thin-wraps `fuz_audit::run_check_release_cli()`; marked `[package.metadata.fuz_audit] dev_only = true` so xtask itself is excluded from the production scan.
- `zzz/` — Rust CLI scaffold (argh, stubs only).

AI provider system feature-complete for Anthropic; OpenAI /
Gemini / Ollama stubs ship status only. Spine consumption
underway — spine path deps (`fuz_db`, `fuz_auth`, `fuz_http`,
`fuz_realtime`, `fuz_actions`) and the `JsonrpcError` rename are in;
additive `App` spine fields, `ActionRegistry` compiled at boot
with 23 specs, and four handler modules migrated to `handlers_v2/`;
`/api/rpc/v2` mounted as a parallel route; admin + account migration
resolved by letting fuz_auth's `auth_adapter::build_{account,admin}_specs`
cover the zzz surface verbatim (no new handlers_v2 modules). Legacy
`/api/rpc` + `/api/ws` still serve live dispatch unchanged. 25 RPC methods:
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
├── main.rs          # Entry, config, DB/keyring/daemon-token init, route setup, graceful shutdown
├── handlers/        # Per-domain RPC handlers + App state + dispatch (legacy `&Ctx` signature, live `/api/rpc` + `/api/ws` dispatch path)
│   ├── mod.rs       # App (state + `realtime` + `action_registry`), Ctx, dispatch, ping, session_load, _testing_emit_notifications
│   ├── account.rs   # account_verify, account_session_*, account_token_*
│   ├── filesystem.rs # diskfile_update, diskfile_delete, directory_create
│   ├── provider.rs  # provider_load_status, provider_update_api_key, completion_create
│   ├── terminal.rs  # terminal_create, terminal_data_send, terminal_resize, terminal_close
│   └── workspace.rs # workspace_list, workspace_open, workspace_close (+ workspace_changed broadcast)
├── handlers_v2/     # Spine-signature handlers (`(Value, ActionContext<'_>, Arc<App>)`). Registered into `App.action_registry` via `zzz_action_specs::build_*_specs`; served on `/api/rpc/v2`. Migrated: workspace, filesystem, terminal, provider/load_status + provider/update_api_key. Deferred: completion_create (notify reshape pending). Admin + account: NOT migrated to handlers_v2 — `fuz_auth`'s `auth_adapter::build_{account,admin}_specs` cover the surface verbatim (the legacy `handlers/{admin,account}.rs` files are line-for-line ports of fuz_auth's canonical handlers, so a parallel handlers_v2 module would re-implement the same logic for later deletion).
│   ├── mod.rs
│   ├── filesystem.rs
│   ├── provider.rs
│   ├── terminal.rs
│   └── workspace.rs
├── zzz_action_specs/ # Per-domain `ActionSpec` builders consumed by main.rs's `ActionRegistry::compile(...)`. Each builder takes `Arc<App>` and emits closures that call the corresponding `handlers_v2::*` function.
│   ├── mod.rs
│   ├── filesystem.rs
│   ├── provider.rs
│   ├── terminal.rs
│   └── workspace.rs
├── rpc.rs           # JSON-RPC classify + notification builder, HTTP handler with auth pipeline
├── ws.rs            # WebSocket upgrade with auth, connection tracking, select! message loop
├── perform_action.rs # Transport-agnostic dispatch core shared by HTTP RPC + WS (mirrors fuz_app/src/lib/actions/perform_action.ts)
├── audit/           # Audit emission + listeners
│   ├── mod.rs       # AuditEmitter (pool-write + listener chain), AuditLogEvent / AuditLogInput
│   └── listeners.rs # register() — translates audit events into WS socket revocation
├── auth/            # Auth surface
│   ├── mod.rs       # AuthError, RequestContext, build_request_context (+ pub use submodules)
│   ├── keyring.rs   # Keyring (HMAC sign/verify), session-cookie parsing, hash_session_token
│   ├── resolve.rs   # ResolvedAuth, cookie/bearer/daemon-token resolution pipeline
│   └── spec.rs      # ActionAuth / CredentialType / MethodSpec, check_action_auth, method_spec, origin allowlist, REST credential gate (`enforce_session_only`)
├── rate_limiter.rs  # Sliding-window RateLimiter (per-IP + per-account on /login + /password); opt-in via ZZZ_LOGIN_RATE_LIMIT_ENABLED
├── proxy.rs         # Trusted-proxy parsing (IPv4/IPv6/CIDR), strict-IP validation, right-to-left XFF resolution, `client_ip_middleware` (sets `ClientIp` on request extensions). Gated by ZZZ_TRUSTED_PROXIES (empty → TCP peer fallback).
├── api_token.rs     # generate_api_token (raw token + tok_<12> public id + blake3 hash)
├── daemon_token.rs  # Daemon token state, generation, timing-safe validation, rotation task
├── account/         # Account REST routes
│   ├── mod.rs       # Shared helpers (cookies, hashing, rate-limit responses), LoginInput / PasswordInput (+ pub use handlers)
│   ├── status.rs    # GET /api/account/status
│   ├── login.rs     # POST /api/account/login
│   ├── logout.rs    # POST /api/account/logout
│   └── password.rs  # POST /api/account/password
├── bootstrap.rs     # POST /bootstrap handler (account + session creation)
├── db/              # Per-domain query modules
│   ├── mod.rs       # Pool creation + re-exports
│   ├── migrations.rs # AUTH_DDL constant + run_migrations
│   ├── account.rs   # AccountRow, AccountSummaryRow, password_hash queries
│   ├── actor.rs     # ActorRow, RoleGrantRow, role_grant queries, keeper_account_id
│   ├── api_token.rs # api_token CRUD (create, list, validate, revoke, enforce_limit)
│   └── auth.rs      # auth_session queries (validate, touch, create, delete)
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
by path), plus spine-backed fields:
`realtime: Arc<fuz_realtime::ConnectionRegistry>`, `audit_emitter:
Arc<fuz_auth::AuditEmitter>` (transactional in-tx shape — distinct
from the legacy spawn-and-await `audit`), `action_registry:
OnceLock<Arc<fuz_actions::ActionRegistry>>` (OnceLock because spec
builders capture `Arc<App>`), `account_route_state`,
`bootstrap_route_state`, `spine_keyring`, `spine_daemon_token`,
`spine_allowed_origins`, `spine_trusted_proxies`. The spine fields
are additive — `#[allow(dead_code)]` until later Batch 5 sub-batches
mount the spine routes and retire the legacy duplicates), constructed
once in `main`, wrapped in `Arc`. `Ctx` is
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
5. Build `RequestContext` (account → actor → role grants) with `CredentialType`
6. Check per-action auth level (keeper actions require `DaemonToken` credential type)

**Message classification** (`rpc::classify`) is transport-agnostic:
- HTTP: origin check → auth → classify → `perform_action`
- WS: upgrade auth (reject 401) → classify → `perform_action`

**Shared dispatch core** (`perform_action::perform_action`): each
transport assembles a `PerformActionInput` (method, params, request_id,
optional auth context, credential type, notify closure, signal) and
calls `perform_action(input, &app)`. The function runs the spec lookup
(`auth::method_spec`), per-action auth (`auth::check_action_auth` —
credential + role gates), and `handlers::dispatch` (which routes
`side_effects: true` through its internal `dispatch_with_tx`). Returns
a discriminated `PerformActionResult` (`Ok(Value) | Err {error,
status}`); HTTP binds the status directly, WS ignores it. Mirrors
fuz_app's `actions/perform_action.ts` shape — the TS port additionally
owns input validation, the authorization phase, rate limiting, and
DEV-only output validation inside `perform_action`; those land on Rust
as later phases. The REST sibling `auth::enforce_session_only` enforces
the session-only credential channel for `POST /api/account/password`
out of the same module that holds `check_action_auth` so the two
gates can't drift silently.

**Audit emission**: `audit/mod.rs` houses `AuditEmitter`, the bound capability
threaded onto `App.audit`. Every `audit.emit(input)` site spawns a
fire-and-forget pool-write (via `tokio::spawn`) that returns a
`JoinHandle<()>`. RPC handlers (account session/token mutations) push the
handle onto `Ctx.pending_effects`; `perform_action` drains that queue
before returning to the transport so audit rows are persistent by
response time. REST handlers (`login`, `logout`, `password`, `bootstrap`)
await the handle directly via `let _ = app.audit.emit(input).await` —
the spawn-then-await shape (rather than inlining the write into the
REST future) is **load-bearing for cancel-safety**: if the REST future
is dropped mid-`.await` (client disconnect), the spawned task continues
independently on the runtime and the audit row still lands. The
discriminant is "where does the write run?" — detached task = survives
cancellation; inline = dies with the dropped future. Don't refactor the
sites back to a single inline `write_and_notify` future without a
plan to preserve cancel-safety. The emit task INSERTs into `audit_log`
via the captured pool (rollback-resilient — survives a tx rollback)
and then fans the materialized `AuditLogEvent` out to every listener
on `AuditEmitter.on_event_chain` (registered in
`audit::listeners::register` after `App` is constructed). Pool failures
and INSERT failures are logged at `warn` and swallowed — same fail-open
posture as fuz_app.

The listener chain currently translates audit events into WebSocket
socket revocation. Mirrors fuz_app's `create_ws_auth_guard` +
`create_ws_logout_closer`:

- `session_revoke` (success) → `close_sockets_for_session(metadata.session_id)`
- `token_revoke` (success) → `close_sockets_for_token(metadata.token_id)`
- `session_revoke_all` / `token_revoke_all` / `password_change` / `logout`
  (success) → `close_sockets_for_account(target_account_id ?? account_id)`

Failure-outcome rows never trigger socket close — they carry
attacker-controlled metadata (e.g. a `session_revoke` row records the
caller-submitted `session_id` even if the DB rejected it), so reacting
to them would let an authenticated user disconnect another user by
guessing a session hash.

**Credential-channel metadata contract**: every audit row emitted by
the four credential-gated RPC methods (`account_session_revoke`,
`account_session_revoke_all`, `account_token_create`,
`account_token_revoke`) plus the REST `POST /api/account/password`
handler records `metadata.credential_type` (`'session' | 'api_token' |
'daemon_token'`). Mirrors fuz_app v0.63.0's defense-in-depth contract —
the spec gate already restricts these to `Session` credentials, but
forensics survive a future loosening or bypass because the row records
what actually authenticated the request. See
`fuz_app/docs/security.md` §Credential-channel gating.

**Bootstrap audit emission**. `POST /api/account/bootstrap` writes an
audit row on both legs (matches fuz_app's `bootstrap_routes.ts`).
Success rows carry both `account_id` (new keeper account) and
`actor_id` (new keeper actor), `metadata: null`. Failure rows carry
`metadata: {error: <reason>}` matching
`audit_metadata_schemas.bootstrap` (a `looseObject` with
`error: string`); four failure shapes are emitted —
`bootstrap_not_configured`, `already_bootstrapped` (fired at both the
pre-check and post-lock double-check sites), `token_file_missing`,
`invalid_token`. Bootstrap is pre-auth so no `credential_type` in
metadata.

**`password_change` `concurrent_change` row**. `db/account.rs`'s
`query_update_password` is a conditional UPDATE keyed on
`WHERE id = $2 AND password_hash = $3` returning `bool`. When the
loser's UPDATE matches zero rows (a concurrent password change
committed first against the same starting hash), the REST handler
emits `password_change` failure with
`metadata: {reason: 'concurrent_change', credential_type}` and
returns 401 — same shape as fuz_app's
`query_update_account_password` + loser-path emit. Wrong-password
failures carry `metadata: {credential_type}` only (no `reason`).

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

Tracked asymmetries between Deno (ground truth) and Rust backends. Bearer
auth response format (issue #1) was resolved — both backends now produce
identical JSON-RPC envelopes for all auth failures.

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
- AI providers: Anthropic fully implemented (non-streaming + SSE streaming), OpenAI/Gemini stubs (status only), Ollama stub (always unavailable)
- No batch request support (JSON arrays)
- No Ollama actions (`ollama_list`, `ollama_ps`, etc.)
- `/api/account/signup` is mounted on both backends (Rust via `fuz_auth::signup_routes`, added 2026-05-19 in cross-backend-integration quest Phase 3b.2; Deno via `create_signup_route_specs`, added in cross-process 3d.4 Issue 5). Invite-gated by default (`app_settings.open_signup=false`); admins flip the setting via `app_settings_update` to enable open signup. The cross-process test binary opts into `open_signup: true` at startup via `app_settings_patch` so per-test `mint_account` can sign up without invites. Rust `app_settings` is loaded per-request today; a cached `Arc<RwLock<AppSettings>>` shared with the future admin `app_settings_update` handler lands when that admin RPC moves to Rust.
- No token management routes (GET /tokens, POST /tokens/create, etc.)
- No SSE broadcast of audit events to admins — the in-process listener chain (`audit/`) only drives WebSocket socket revocation today; an SSE adapter mirroring fuz_app's `audit_log_sse` is future work
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
- **Dispatcher transaction wrap**: `auth::method_side_effects` mirrors the
  `side_effects` field on each action spec. `dispatch` routes
  `side_effects: true` actions through `dispatch_with_tx`, which begins a
  `tokio_postgres` transaction, hands `&tx` to handlers that touch the DB
  (the four `account_session_revoke*` / `account_token_*` mutators today),
  and commits on `Ok` or rolls back on `Err`. Mirrors `fuz_app`'s
  `perform_action` `db.transaction` wrap so paired writes (e.g.
  `account_token_create`'s `INSERT api_token` + `query_api_token_enforce_limit`)
  commit atomically — two concurrent token creates can no longer both bypass
  the per-account cap. Query helpers in `db/*.rs` take
  `&(impl deadpool_postgres::GenericClient + ?Sized)` so the same function
  works against a pooled `Object` (read-only path) or a `Transaction`
  (side-effects path) without per-handler match wiring. Read-only actions
  acquire a pooled client only when the matched handler needs one (`ping`,
  `session_load`, `workspace_list`, `provider_load_status` don't touch the
  pool at all).

## What's Next

**Rust Spine consumption**:
- [x] Spine path deps wired (`fuz_db`, `fuz_auth`, `fuz_http`,
  `fuz_realtime`, `fuz_actions`).
- [x] `fuz_common::JsonRpcError` → `fuz_http::JsonrpcError` swap (17 files).
- [x] Additive `App` spine fields + `SpineState`.
- [x] `ActionRegistry::compile(...)` at boot — 23 specs
  (`PROTOCOL_ACTION_SPECS` + `auth_adapter::build_account_specs` +
  `auth_adapter::build_admin_specs` + zzz-specific workspace /
  filesystem / terminal / provider).
- [x] `handlers_v2/` + `zzz_action_specs/` module trees — 4 domains
  on the new `(Value, ActionContext<'_>, Arc<App>)` signature.
- [x] Mount `fuz_actions::create_rpc_router(...)` as a parallel
  `/api/rpc/v2` route; legacy `/api/rpc` + `/api/ws` untouched.
- [x] Admin + account: keep `fuz_auth`'s
  `auth_adapter::build_{account,admin}_specs` as-is, do NOT create
  `handlers_v2/{admin,account}.rs` (the 6 zzz handlers are verbatim
  ports of fuz_auth's canonical handlers, so a duplicate module
  would re-implement the same logic for later deletion). No new
  handlers_v2 sites means zero zzz emit sites flip; the 14 sites in
  `handlers/{admin,account}.rs` + `account/*` + `bootstrap.rs` stay
  legacy until later cleanup retires them along with the rest of
  the legacy dispatch path.
- [ ] `completion_create` notify reshape + `ws.rs` collapse to
  `fuz_realtime::run_ws_connection`.
- [ ] Delete the legacy duplicates (`rate_limiter.rs`,
  `account/`, `proxy.rs`, `auth/`, `api_token.rs`, `daemon_token.rs`,
  `bootstrap.rs`, `db/`, `audit/`, `perform_action.rs`,
  `handlers/admin.rs`, `handlers/account.rs`) once all consumers
  route through the spine.

**AI providers** (Anthropic complete, others pending):
- [x] Provider system: enum-dispatched `Provider` with `ProviderManager`, `ProviderStatus`, `CompletionOptions`
- [x] Anthropic provider: full implementation with `reqwest` HTTP client, SSE streaming, message format conversion
- [x] `provider_load_status` handler (cross-backend, all 4 providers report status)
- [x] `provider_update_api_key` handler (keeper-only, runtime API key updates)
- [x] `completion_create` handler with `completion_progress` streaming notifications (targeted to requesting WS connection)
- [x] `session_load` returns real provider status from all providers
- [ ] OpenAI provider: full completion implementation
- [ ] Gemini provider: full completion implementation
- [ ] Ollama provider: HTTP client to local Ollama API, `ollama_list`, `ollama_ps`, etc.

**Other remaining work**:
1. Codegen from Zod specs (action input/output types)
2. Token management routes (create, list, revoke API tokens)
- [x] Trusted-proxy `get_client_ip` port (XFF + CIDR + strict-IP
  validation). `proxy.rs` ports fuz_app's
  `http/proxy.ts`; `client_ip_middleware` sets `ClientIp` on every
  request via `from_fn_with_state`; consumer sites in `account/`,
  `bootstrap.rs`, `handlers/account.rs` plumb `audit.ip` on all 11
  emit sites and the rate-limit keys read the resolved value. Ten
  integration tests in `proxy_tests.ts` (Rust-only) + 86 Rust unit
  tests in `proxy.rs`. Review pass fixed three correctness issues
  (IPv6 /0 host_mask overflow in `parse_proxy_entry`
  (`1u128 << 128` UB — release would silently accept `fe80::/0`);
  empty-XFF parity drift; missed audit emit on the bootstrap
  post-lock verify-write race loser) and landed three security
  hardenings: belt-and-suspenders WS revocation in
  logout / password / session_revoke / token_revoke handlers (sync
  `close_sockets_for_*` before audit emit so revocation lands on the
  live WS even if the audit INSERT fails); IPv6 string
  canonicalization in `normalize_ip` (round-trip through
  `IpAddr::from_str` → `to_string()` so `::01` / `::1` / fully-
  expanded forms collapse to one rate-limit / `audit_log.ip` key);
  and login-username canonicalization at the boundary
  (`trim().to_lowercase()` on `LoginInput.username` before DB lookup
  + rate-limit key + audit metadata, mirroring fuz_app's
  `login_routes.ts:369`; same canonicalization applied to
  `bootstrap_inner` so stored `account.username` is the canonical
  form a later login can find). Plus `is_request_origin_allowed`
  centralized in `auth/spec.rs` and called from every REST + RPC + WS
  handler (parity inversion: Rust drops the Referer fallback,
  fuz_app tracks the convergence).
