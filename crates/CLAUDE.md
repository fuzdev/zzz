# zzz Rust Backend

zzz's backend, using axum. Serves the frontend (a prerendered static SPA) and
a single JSON-RPC 2.0 API over HTTP + WebSocket. AI providers are Anthropic,
OpenAI, and Gemini (all full).

**Workspace layout**:

- `zzz_server/` — library (`zzz_server`) + production daemon binary (the `[[bin]]` target is named `zzzd`). `pub async fn run_app(options: RunAppOptions)` in `src/lib.rs` owns the full lifecycle (env, signal handler, router build, listener bind, drain). `RunAppOptions` carries: `password_hasher` (production-vs-test swap), `default_addr: SocketAddr` (bind address when `--port`/`ZZZ_PORT` don't supply one; host stays loopback, only the port is overridable), `drain_timeout` (graceful-shutdown drain bound), `force_test_actions` (overrides the `ZZZ_ENABLE_TEST_ACTIONS` env flag), `rate_limiters` (the `fuz_auth::RateLimiterMode` every spine limiter is built through — `Enforced` in production, `DisabledForTesting` in the test binary only), `extra_action_specs_factory` (lets the test binary inject `_testing_reset` without putting `fuz_testing` in the production dep graph), and `pre_migration_hook` (fires after pool creation, before migrations — the test binary wires `fuz_testing::reset_db_on_startup_if_env_set`). `src/main.rs` is the thin production entry — constructs `Argon2idHasher`, calls `run_app` with `force_test_actions: false, extra_action_specs_factory: None`.
- `testing_zzz_server/` — separate test-binary package (its `[[bin]]` target is named `testing_zzzd`) wiring `fuz_testing::TestingArgon2idHasher` (~1-5 ms argon2 vs production's ~30-50 ms) AND `fuz_testing::create_testing_reset_action_spec` (auth-table wipe + fresh-keeper re-seed + consumer-supplied `reset_state(ActionDb)` callback; `credential_types: [DaemonToken]` auth gate). zzz's reset closure ignores the in-tx `ActionDb` handle (its domain state is in-memory, not in PG) — it closes every zzz workspace through the production close path (`handlers::workspace::workspace_close_all` — filers stopped, `ScopedFs` roots removed, `workspace_changed` broadcast, restoring the boot-time scope), calls `pty_manager.kill_all()` (non-destructive — manager stays usable across tests), and wipes the optional `ZZZ_TESTING_SCRATCH_DIR`. Default port 4462 (production is 4460). **Never ships in a release** — enforced by `fuz_release`'s `testing_` manifest filter and the `cargo xtask check-release` dep-graph audit. It is zzz's test binary, spawned by the cross-process integration tests.
- `xtask/` — dev automation (`cargo xtask <cmd>`, pure `std` + `fuz_audit`, no extra deps). `dev` loads `.env.development`, builds `zzz_server`, checks port 4461 is free, then runs `zzzd` (port 4461) + the Vite frontend (`node_modules/.bin/vite dev` run directly — `npx` doesn't forward signals; 5173, proxying `/api`), with the inherited env overlaid by `.env.development` — the file's non-blank values win (the opposite of the CLI's rule; a blank `KEY=` line is unset, never clearing an exported value), printing each inherited key it overrides (never the value), holding both children in guards that `SIGTERM` (then `SIGKILL`) and reap the survivor on every exit path; `dev-setup` / `prod-setup` create `.env.development` / `.env.production` from the `.example` templates (mode `0600`, `create_new`) with a freshly generated `SECRET_FUZ_COOKIE_KEYS` — the templates ship the key empty; `check-release` (the dep-graph audit — sanity check #2 of the test-binary pattern) delegates its work to `fuz_audit::run_check_release_cli()`. Dispatch and usage live in xtask itself: bare `cargo xtask` / `help` / `-h` / `--help` print the full subcommand list (exit 0); an unknown subcommand (a non-UTF-8 one included — args are read with `args_os`), or any argument after a subcommand (none takes one), prints an error + usage (exit 1). Every subcommand runs from the workspace root (the grandparent of `CARGO_MANIFEST_DIR` — the one `cargo run` sets at run time, else the one baked in at build time, which goes stale in a copied checkout), so it works from any directory in the checkout — the env files, `node_modules/.bin/vite`, `target/debug/zzzd`, and `.env.development`'s relative paths (resolved by the children against their working directory) are always the workspace's. Marked `[package.metadata.fuz_audit] dev_only = true` so xtask itself is excluded from the production scan.
- `zzz/` — Rust CLI (argh). `daemon start/stop/status`, `status`, `init`, `open` (the default command — opener resolution, path resolution, daemon discovery, detached auto-start, then the configured opener or the browser), and `version` (+ the `--version`/`-v` switch). Modules: `daemon_launch.rs` (the `zzzd` command: `--port`, `--static-dir`, cwd `~/.zzz`, and the env overlay from `~/.zzz/.env` + defaults, with required-var / static-dir / port / `config.json` validation, the note naming `.env` keys the environment overrides, and `ZZZ_ENABLE_TEST_ACTIONS` stripped; `CliConfig`, the one reader of `config.json`), `opener.rs` (the open command run instead of the browser: `opener` in `config.json` — a string, or an array of the program and its arguments — then `ZZZ_OPENER`; blank reads as unset; the program whitespace-trimmed, `~`-expanded, resolved against `~/.zzz` or the CLI's directory by source, and required to be an executable file — a bare name (no `/`, `~name` included) is refused from both sources, never searched for on `$PATH` or run from the current directory; the URL appended as its own final argument, no shell, so a `--flag=<url>` form needs a wrapper script; output in `run/opener.log`, emptied at each launch; `ZZZ_ENABLE_TEST_ACTIONS` removed), `daemon_lifecycle.rs` (`resolve_server_bin` — `ZZZ_SERVER_BIN` (must be an executable file) > beside the resolved CLI executable > `~/.zzz/bin` > absolute `$PATH` entries, skipping non-executable candidates, never the current directory; `parse_port`, the one `1..=65535` rule for `--port` (argh `from_str_fn`), `ZZZ_PORT`, and `zzz_config_port`; `daemon.json` v2 I/O with ownership-checked removal and foreign-record reporting — an older/newer/corrupt record is never signalled, removed, or overwritten, so a start refuses to run; the proxy-free `/health` probe on `127.0.0.1`, the serving wait, `create_private_log` + `spawn_detached` (the detached spawn the auto-started daemon and the opener share: own process group, output appended to a `0600` log under `~/.zzz/run` that each launch empties), shutdown-signal handling, `stop_child` SIGTERM → SIGKILL → reap, terminate), `procfs.rs` (Linux `/proc` identity: boot id, pid start time, listening-socket ownership), `env_file.rs` (the dotenv parser — std-only, also compiled into xtask via `#[path]`; its module doc lists where it diverges from `dotenv`). `zzz status` / `zzz daemon status` exit 0 when running, 1 when alive but not responding, 3 when not running, 4 when unknown (a `daemon.json` this zzz can't read). With `--json` they print one object whose keys are always all present: `state` (`running`, `not_responding`, `not_running`, `stale` — the record named a process that's gone and was removed — or `unknown`), `running` (the recorded process is alive), `healthy` (it answers `/health`), `daemon` (the `daemon.json` record — `version`, `pid`, `boot_id`, `pid_start_ticks`, `port`, `started`, `app_version` — for `running` / `not_responding` / `stale`, else `null`), and `foreign_record` (`{pid, kind, description}` for `unknown`, `kind` one of `older` / `newer` / `unreadable`, `pid` `null` when it names none; else `null`). The CLI reads its args with `args_os`, so a non-UTF-8 argument is an error, never a panic (the program name is decoded lossily — argh only shows it in help). Usage and config errors — argh parse errors included — exit 2; `--help` exits 0. See the root CLAUDE.md § CLI for the launch rules. Tests: unit tests per module, `tests/cli_daemon.rs` (infra-free: status + stale/reused-pid/older-zzz records (a start refuses to overwrite one), launch validation (ports at every source, `config.json`, env-override notes, `ZZZ_ENABLE_TEST_ACTIONS` stripped, never a `zzzd` from the current directory), early child exit, `init` file modes, the opener (a stand-in script recording its arguments: the URL as the single final argument for a workspace path a shell would mangle, array arguments passed through, config over env, blank values unset, the browser stub as the fallback, no `ZZZ_ENABLE_TEST_ACTIONS`; a missing or non-executable program, a bare name from either source, and a malformed `opener` exit 2 with nothing launched), full foreground + detached lifecycles and signals during startup against a `sh` + `python3` stand-in daemon — a visible SKIPPED line without `python3` — with a drop guard that kills stand-ins on failure), and `tests/cli_e2e.rs` (full `daemon start` ↔ live `testing_zzzd` lifecycle, gated behind `ZZZ_TEST_E2E=1` + Postgres, self-skips otherwise). Build it with `cargo build -p zzz`.

AI provider system feature-complete for all three providers (Anthropic,
OpenAI, Gemini). Spine consumption is
complete — the spine crates (`fuz_db`, `fuz_auth`, `fuz_http`,
`fuz_realtime`, `fuz_actions`) own auth, HTTP, realtime, and the
boot-compiled `ActionRegistry` dispatch path. A single canonical
`/api/rpc` + `/api/ws` (mounted via `fuz_actions::create_rpc_router` /
`register_action_ws`) serves all dispatch; admin + account specs come
from fuz_auth's `auth_adapter::build_auth_spec_set`, the zzz-specific
workspace / filesystem / terminal / provider specs from
`zzz_action_specs/` (handlers in `handlers/`), and the admin audit-log
SSE stream from `fuz_realtime::audit_stream_router`. Besides the handlers,
`handlers/` holds `App` state and a `broadcast` shim over `App.realtime` (socket revocation
lives on the spine's `ConnectionRegistry` — see Auth below). RPC methods:
`ping`, `session_load`, `workspace_*`, `diskfile_*`, `directory_create`,
`terminal_*`, `provider_load_status`, `completion_create`,
`account_verify`, `account_session_list`,
`account_session_revoke`, `account_session_revoke_all`,
`account_token_create`, `account_token_list`, `account_token_revoke`,
`admin_session_revoke_all`, `admin_token_revoke_all`.
Those are the zzz-domain methods plus fuz_app's account self-service and
admin-revocation slice; `auth_adapter::build_auth_spec_set` registers the
rest of `fuz_auth`'s standard bundle too — admin account/audit/invite
management, `app_settings_*`, and the consent-based `role_grant_*` /
`role_grant_offer_*` flow with its own notifications — plus
`fuz_actions::PROTOCOL_ACTION_SPECS` (`heartbeat`, `peer/ping`; `cancel` is a client notification the WS read loop handles, not a spec).
That spine surface is live on `/api/rpc` + `/api/ws` even though zzz ships
no UI for most of it; the spine crates are its source of truth.
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

The sibling Rust workspace must be checked out alongside this repo:

```
~/dev/zzz/                  (this repo)
<sibling Rust workspace>/   (path deps: fuz_sys, fuz_pty, the 5 spine crates — fuz_db, fuz_auth, fuz_http, fuz_realtime, fuz_actions — plus fuz_testing for the test binary and fuz_audit for xtask)
```

If a path dep is missing, `cargo build` will fail with
`failed to read .../crates/{crate}/Cargo.toml`.

**PostgreSQL** is required. Create the development and test databases:

```bash
createdb zzz                 # development
createdb zzz_test            # manual testing_zzzd runs
createdb zzz_test_rust        # cross-backend vitest project: cross_backend_rust
createdb zzz_test_rust_proxy  # cross-backend vitest project: cross_backend_rust_proxy
```

## Build and Run

```bash
cargo build --workspace
cargo clippy -p zzz_server        # workspace lints: pedantic + nursery
cargo xtask check-release         # audit: no production binary depends on fuz_testing / fuz_audit

# Run (requires DATABASE_URL, SECRET_FUZ_COOKIE_KEYS, and FUZ_ALLOWED_ORIGINS)
DATABASE_URL=postgres://localhost/zzz \
SECRET_FUZ_COOKIE_KEYS=dev-only-not-for-production-use-000 \
FUZ_ALLOWED_ORIGINS='http://localhost:*' \
./target/debug/zzzd --port 4460

# Test binary (cross-process integration tests — fast argon2)
DATABASE_URL=postgres://localhost/zzz_test \
SECRET_FUZ_COOKIE_KEYS=dev-only-not-for-production-use-000 \
FUZ_ALLOWED_ORIGINS='http://localhost:*' \
./target/debug/testing_zzzd

# Quick smoke test
curl http://localhost:4460/health
curl -X POST http://localhost:4460/api/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"ping"}'
# → {"jsonrpc":"2.0","id":"1","result":{"ping_id":"1"}}
```

CLI args (`--port`, `--static-dir`) take precedence over env vars
(`ZZZ_PORT`, `ZZZ_STATIC_DIR`). Each takes its value as the next argument or
after `=` (`--port=4460`); a repeated flag's last value wins. The args are
read as `OsString`s (`parse_args` in `lib.rs`): a `--static-dir` may be any
path, and anything else that isn't UTF-8, an unknown flag, a stray
positional, a missing or empty value, or an invalid port refuses to boot,
listing the options (`OPTIONS`) — never ignored. `-h` / `--help` prints
`usage: <binary> <OPTIONS>` and exits 0. Both binaries' `main` return
`run_app`'s result through `report_run_result(result, <binary name>)` — help
to stdout, `<binary>: <error>` to stderr, exit 1 — rather
than `std::process::exit`, so the non-blocking log writer's guard drops and
flushes; `testing_zzzd` checks the args (`check_cli_args`) before its own
setup (app dir, daemon token).

### Required Environment Variables

- `DATABASE_URL` — PostgreSQL connection (e.g. `postgres://localhost/zzz`)
- `SECRET_FUZ_COOKIE_KEYS` — HMAC signing keys (min 32 chars, `__` separator for rotation)
- `FUZ_ALLOWED_ORIGINS` — Comma-separated origin allowlist patterns — required, non-empty. The server hard-fails at boot on an empty list, because `fuz_http::check_origin` treats an empty allowlist as allow-all (every origin passes). Dev/prod `.env` set `http://localhost:*`.

An unset or blank (empty or whitespace) `DATABASE_URL` or
`SECRET_FUZ_COOKIE_KEYS` refuses to boot with `<NAME> is unset or blank`.

### Optional Environment Variables

- `FUZ_BOOTSTRAP_TOKEN_PATH` — Path to bootstrap token file
- `PUBLIC_ZZZ_DIR` — App directory (default `.zzz`, relative to the working directory); created at boot (with missing parents, mode `0700`) if absent — boot fails, naming the path, if it can't be, or if it resolves to the working directory itself (`check_app_dir_is_not_cwd`: the app dir's filer skips `.zzz` only below its root, so `PUBLIC_ZZZ_DIR=.` under the CLI would index the daemon home's `.env` and `bootstrap_token`; any other directory is accepted, the default being the subdirectory `.zzz`). It catches the daemon home only as the working directory — an explicit `PUBLIC_ZZZ_DIR` naming `~/.zzz` for a daemon run elsewhere makes the home the app dir and indexes its `.env`, so don't
- `PUBLIC_ZZZ_SCOPED_DIRS` — Comma-separated filesystem paths (no `~` expansion); an entry that resolves to, or inside, a `.zzz` directory other than the app dir fails boot naming the variable and the path (`check_scoped_dirs`, run with the config parse, before the DB is touched)
- `ZZZ_PORT` — Server port (default 4460, `--port` overrides); an invalid port (either source — anything but `1..=65535`) refuses to boot rather than falling back to the default
- `ZZZ_STATIC_DIR` — Static file directory (must be a directory, or boot fails)
- `SECRET_ANTHROPIC_API_KEY` / `SECRET_OPENAI_API_KEY` / `SECRET_GOOGLE_API_KEY` — provider keys, read once at boot
- `ZZZ_ENABLE_TEST_ACTIONS` — Register `_testing_*` actions on live dispatchers (mirrors Zod `z.stringbool()`: `true`/`1`/`yes`/`on`/`y`/`enabled` opt in; `false`/`0`/`no`/`off`/`n`/`disabled` or unset opt out; case-insensitive; blank reads as unset; anything else errors at startup. Integration tests only — production must leave unset, and the `zzz` CLI strips it from a daemon it starts)
- `ZZZ_TRUSTED_PROXIES` — Comma-separated trusted-proxy entries (IPs and CIDR ranges, e.g. `127.0.0.1,10.0.0.0/8,fe80::/10`). Unset/empty → no XFF trust → `client_ip` falls back to the TCP peer IP on every request (direct-bind behavior). Set when deploying behind nginx / a cloud LB so the trusted-proxy middleware walks `X-Forwarded-For` right-to-left and resolves the real client IP for rate limiting + `audit_log.ip`. Parsed eagerly at startup — invalid entries (malformed IPs, non-aligned CIDRs, out-of-range prefixes) fail server boot. Mirrors fuz_app's `http/proxy.ts`.

A blank (empty or whitespace) path var reads as unset — `PUBLIC_ZZZ_DIR` falls back to `.zzz`, never `/` (`resolve_dir` errors on an empty or unresolvable path rather than collapsing to `/`). A non-UTF-8 value of any of the server's string vars fails boot naming the variable (it would otherwise read as unset — e.g. silently dropping every `PUBLIC_ZZZ_SCOPED_DIRS` entry), as does a dir that resolves to a non-UTF-8 path.

## Endpoints

- `/api/rpc` (GET) — JSON-RPC 2.0 (cacheable reads, query params)
- `/api/rpc` (POST) — JSON-RPC 2.0 (HTTP transport, auth-gated)
- `/api/account/bootstrap` (POST) — One-shot admin account creation
- `/api/account/signup` (POST) — Public account creation (invite-gated by default; `open_signup=true` opens)
- `/api/account/status` (GET) — Current account info or 401 + bootstrap status
- `/api/account/login` (POST) — Username/password login → session cookie
- `/api/account/logout` (POST) — Invalidate session, close WS connections
- `/api/account/password` (POST) — Change password, revoke all sessions/tokens
- `/api/ws` (GET) — JSON-RPC 2.0 (WebSocket, cookie/bearer/daemon)
- `/api/admin/audit/stream` (GET) — Admin-gated audit-log SSE stream (`text/event-stream`)
- `/health` (GET) — Health check (`{"status":"ok"}`)
- `/*` (GET, HEAD) — the built frontend (if `--static-dir` / `ZZZ_STATIC_DIR`), the router's fallback behind every route above. `static_files.rs` resolves the exact file (directories never match), then the prerendered page (`{path}.html`, or `{path}index.html` for a trailing `/`), then the `200.html` SPA shell (`static_files::SPA_FALLBACK_FILE`, matching `fallback` in `svelte.config.js`) — so `/workspaces?workspace=…`, reloads, deep links, and dynamic routes (`/chats/<id>`) all load. `/api`, `/health`, and paths below them never get the shell (an unknown `/api/foo` is an empty 404), nor does a missing `/_app/` asset (404, so a stale tab's chunk load fails instead of executing HTML); other methods get 405. `_app/immutable/` is served `Cache-Control: public, max-age=31536000, immutable`, everything else `no-cache`. Both path probes go through `ServeDir`, which percent-decodes the path and rejects `..` / root / prefix components; the shell is a fixed file (`ServeFile` ignores the request path). `ServeDir` follows symlinks inside the static dir, which is trusted operator content. A static dir without `200.html` logs a boot warning, and non-prerendered routes 404. Without a static dir (dev, where Vite serves the frontend) unmatched paths get axum's empty 404

## Auth

zzz is single-operator: every session and every full-scope API token
effectively has the daemon OS user's powers — see the root CLAUDE.md
§ Security posture.

Cookie-based session auth and bearer token auth. These mechanics are
spine behaviors (`fuz_auth` / `fuz_http` / `fuz_realtime`) that `run_app`
composes — `zzz_server` owns none of this code. Summarized here for
orientation; the spine crates are authoritative:

1. **Keyring** — HMAC-SHA256 cookie signing with key rotation support.
   Keys from `SECRET_FUZ_COOKIE_KEYS` env, separated by `__`. First key signs,
   all keys verify.

2. **Cookie format** — `zzz_session_<port>` cookie (per port —
   `session_cookie_name_for_port` — since browsers scope cookies by host, not
   port, so zzz daemons on one host would otherwise share, and clobber, one
   session) containing signed
   `{session_token}:{expires_at}.{base64_signature}`. 30-day expiry,
   `Secure; HttpOnly; SameSite=Strict`.

3. **Session validation** — Cookie → HMAC verify → blake3 hash token →
   `auth_session` table lookup → build `RequestContext` (account, actor,
   role grants). Pure read — sessions are never touched or renewed; the
   30-day lifetime is an absolute cap set at mint, and the row carries no
   activity signal.

4. **Bearer token auth** — `Authorization: Bearer <token>` header. Token
   hashed with blake3, looked up in `api_token` table. Browser context
   silently discarded (Origin/Referer headers present → bearer ignored). Token
   `last_used_at` touched fire-and-forget. Sets `CredentialType::ApiToken`.

5. **Daemon token auth** — `X-Daemon-Token` header. **Not mounted in
   production.** `zzz_server` cannot construct the credential: its producer
   (`fuz_testing::init_daemon_token`) lives in `fuz_testing`, which
   `cargo xtask check-release` forbids in a production binary, and
   `RunAppOptions::daemon_token_state` is `None` for `zzz_server`'s own
   `main.rs`. Only `testing_zzz_server` supplies one, so `_testing_reset` can
   authenticate as keeper; it writes `{zzz_dir}/run/daemon_token` for the
   cross-process harness to read. No production caller exists — a browser
   request carries `Origin`/`Referer`, which `is_browser_context` refuses for
   this credential. The spine keeps the consuming half (constant-time compare,
   keeper resolution, `CredentialType::DaemonToken`) in `fuz_auth`; state is
   protected by `parking_lot::RwLock`.

6. **Auth pipeline** — Both transports try: daemon token → cookie → bearer.
   Daemon token has highest priority (matches fuz_app middleware order), but
   its leg is unreachable in production, where the state is `None`.
   `ResolvedAuth` carries `credential_type` (`Session`, `ApiToken`,
   `DaemonToken`) and optional `token_hash` (session connections only —
   bearer and daemon token connections have `None`).

7. **Per-action auth** — these levels are the enforcement shorthand for the
   `auth` record on each TS spec (fuz_app's `RouteAuth`: `{account, actor,
   roles?, credential_types?, required_scope?}`; see `src/lib/action_specs.ts`
   and the generated `docs/reference.md`):
   - `public` — `{account: 'none', actor: 'none'}`; no auth required (`ping`)
   - `authenticated` — `{account: 'required', actor: 'none'}`; valid session or bearer token required (workspace_*, session_load, etc.)
   - `keeper` — `{account: 'required', actor: 'required', roles: ['keeper'], credential_types: ['daemon_token']}`; requires `DaemonToken` credential type AND keeper role grant. No zzz action uses this shape today — the daemon-token credential is test-binary-only (see Auth §5), so the only keeper-gated specs are `fuz_testing`'s `_testing_*` backdoors. API tokens and session cookies cannot access keeper actions even if the account has the keeper role grant.

8. **Bootstrap** — `POST /api/account/bootstrap` creates the first admin
   account with keeper + admin role grants. Reads the token from
   `FUZ_BOOTSTRAP_TOKEN_PATH`, timing-safe compare, Argon2 password hashing,
   all in a transaction with bootstrap_lock.

9. **Origin verification** — `FUZ_ALLOWED_ORIGINS` patterns checked on requests
   with an `Origin` header. Supports exact match, wildcard port
   (`http://localhost:*`), subdomain wildcard (`https://*.example.com`).

10. **Socket revocation** — `close_sockets_for_session(token_hash)`,
    `close_sockets_for_token(api_token_id)`, and
    `close_sockets_for_account(account_id)` are the spine's `SocketRevoker`
    methods; `run_app` binds `fuz_realtime::RealtimeRevoker`, which fans each
    close to the WS `ConnectionRegistry` and the audit-stream `SseRegistry`
    (`App` itself carries only a `broadcast` shim). They close matching
    WebSocket connections by dropping the channel sender — the ws loop breaks
    on `recv()` returning `None` and sends a 4001 (`WS_CLOSE_SESSION_REVOKED`)
    Close frame so clients can distinguish revocation from normal close — and
    end matching audit streams the same way.
    Invoked by the spine's revocation-emitting handlers and audit-event
    listeners: `session_revoke` (per-session), `token_revoke` /
    `account_token_revoke` (per-token), and `logout` / `session_revoke_all`
    / `token_revoke_all` / `password_change` (account-wide). The RPC
    handlers close only after their transaction commits
    (`fuz_auth::queue_socket_close`), so a client's recheck on a 4001 never
    finds the revoked session still in the table; the REST ones close inline
    on their autocommit client. See "Audit emission" under Architecture for
    the listener chain.

11. **Account status** — `GET /api/account/status` returns account info +
    role grants (200) when authenticated, or 401 with optional
    `bootstrap_available` flag when not. Consumed by fuz_app's `AuthState`
    for the frontend auth gate (bootstrap → login → verified flow).

12. **Account management** — `POST /api/account/login` (username/password →
    session cookie with enumeration prevention via dummy hash),
    `POST /api/account/logout` (invalidate session + close WS connections),
    `POST /api/account/password` (change password, revoke all sessions + API
    tokens, close all WS connections). Session listing and revocation are
    JSON-RPC: `account_verify`, `account_session_list`,
    `account_session_revoke`, `account_session_revoke_all`,
    `account_token_create`, `account_token_list`, `account_token_revoke`
    (all scoped to the authenticated account), plus the admin role-gated
    `admin_session_revoke_all` / `admin_token_revoke_all` which target a
    caller-supplied `account_id`.

## Integration Tests

The `cross_backend_*` vitest projects run fuz_app's shared cross-process
suites plus zzz-specific suites against the spawned `testing_zzz_server`
binary over real HTTP + WebSocket, verifying its JSON-RPC / SSE responses
conform to the shared fuz_app contract. The tests live in
`src/test/cross_backend/` (TypeScript, not in the Rust crate):

- **`auth.cross.test.ts`** — invokes fuz_app's
  `describe_standard_cross_process_tests` (the cross-process subset of the
  standard bundle: ping; JSON-RPC parse / method / request errors over HTTP +
  WS; auth enforcement; bearer-token auth on HTTP + WS incl. browser-context
  discard and per-token revocation; session + account management; audit
  emission; admin role-gated paths). The surface is built in TS from
  `action_specs.ts` + fuz_app's standard route bundle via
  `create_zzz_app_surface_spec` (`zzz_surface_spec.ts`) — no backend
  dependency. The keeper is granted `ROLE_ADMIN` (`extra_keeper_roles`) so
  admin-gated cases can drive admin RPC. The bundle omits `rate_limiting`,
  `audit_completeness`, and `bootstrap_success` (in-process / FK-structural /
  already consumed by globalSetup — see the bundle's module doc).
- **`session.cross.test.ts`** — the per-port session cookie
  (`zzz_session_<port>`: set on login, the shared `fuz_session` name not
  read, plus fuz_app's hardened-attribute suite under it); another session's
  logout closing this session's socket while the session stays valid and a
  fresh socket works (what the frontend's recheck-and-reconnect relies on);
  an RPC `account_session_revoke_all` already committed when the socket
  closes.
- **`sse.cross.test.ts`** — `describe_cross_process_sse_tests` against
  `GET /api/admin/audit/stream` (the shared `fuz_realtime::audit_stream_router`):
  the `: connected` comment, an audit `data:` frame on
  `admin_session_revoke_all`, and close-on-revoke. Gated on `capabilities.sse`.
- **`workspace.cross.test.ts`** — workspace open / list / close, idempotency,
  scope on close (closing a workspace on `zzz_dir`, on a scoped dir via a
  non-canonical spelling, or nested in a scoped dir keeps write access; closing
  a plain workspace revokes it), `_testing_reset` closing every workspace and
  restoring the boot-time scope,
  `workspace_open` returning the workspace's files and `watch_status` (first
  and idempotent open; symlinks and link loops skipped; an unreadable
  subdirectory skipped while its siblings are indexed; an unreadable root
  refused with `forbidden` and nothing registered),
  not-a-directory (`invalid_params`) + nonexistent (`not_found`) errors, a
  NUL byte / symlink loop / over-long name (`invalid_params` /
  `invalid_path`), `.zzz` directories refused (`zzz_home_not_allowed` — the
  directory, a subdirectory, and a symlink to it, while its parent opens with
  it skipped), and `workspace_changed` broadcast on
  open/close (no broadcast on an idempotent open).
- **`filesystem.cross.test.ts`** — scoped `diskfile_update` / `diskfile_delete`,
  `directory_create` (missing parents created, a taken name `conflict` /
  `already_exists`), writes into `zzz_dir` + nested subdirs,
  path-traversal / out-of-scope / relative-path rejection and the error codes
  (see Filesystem errors), wrong file kinds (a directory, a FIFO — refused
  without blocking), atomic replace keeping the mode with no temp file left,
  permissions (a read-only file refused, a writable file in a read-only
  directory written in place, a new file there `directory_not_writable`),
  `diskfile_create` never overwriting (`conflict` / `already_exists`),
  strict inputs, the 16 MiB RPC message cap on both transports (built from
  the frontend's `RPC_MESSAGE_MAX_BYTES`, pinning it to the backend's
  `RPC_MESSAGE_MAX_BYTES`: under it is written, over it is a 413 on HTTP and
  closes the socket on WS), and `filer_change`
  broadcasts in an open workspace (file create; rename → `delete` of the old
  path + `add` of the new).
- **`terminal.cross.test.ts`** — PTY create / read / write / close lifecycle,
  `terminal_data` / `terminal_exited` notifications over WS, live resize and
  out-of-range resize rejection, explicit cwd and bad-cwd spawn failure,
  nonexistent-command handling, a relative `cwd` and unsupported close
  signals refused (`invalid_params`), a ~22KB paste round-trip through `cat`
  (partial writes continued), multibyte output split across reads, env
  scrubbing (no `SECRET_*` / `DATABASE_URL` / … in the child), reaping of a
  child that ignores `SIGTERM` + `SIGHUP` (no zombie after close),
  `not_found` for a missing terminal ID (close included), ownership scoping (a second
  account gets no output, can't drive or close the terminal, and gets
  replies identical to an unknown id's; the owner's second socket does get
  output), `session_load`'s `terminal_ids` (running listed; exited, closed,
  and other accounts' not), and a self-deleted account's terminal processes
  being reaped.
- **`provider.cross.test.ts`** — `provider_load_status` (no-key status) plus `session_load`
  (zzz_dir file listing with contents + recursive subdirectory walk; `file_roots`
  covering `zzz_dir`, the scoped dirs, and every file; a stable
  `server_instance_id`).
- **`completion.cross.test.ts`** — `completion_create` invalid-provider and blank-prompt rejection.
- **`peer_ping_ws.cross.test.ts`** — server-initiated `peer/ping` round-trip
  (client invokes, server pings back over the same socket, client responder
  echoes, server validates) plus security negatives. Invokes fuz_app's shared
  `describe_peer_ping_ws_tests`; gated on `capabilities.peer_request` (runs in
  the `cross_backend_rust` project).
- **`static.cross.test.ts`** — built-frontend serving through the full
  router: the `cross_backend_rust` backend serves a miniature adapter-static
  build (`STATIC_FIXTURE_FILES` in `zzz_backend_config.ts`, via
  `ZZZ_STATIC_DIR`); covers root / prerendered pages (incl. `docs.html` beside
  a `docs/` dir), the `200.html` fallback for dynamic routes and
  `?workspace=` queries, HEAD, cache headers, and the 404s for missing
  `_app/` assets and backend paths. `static_files.rs` unit tests cover the
  same resolution plus path traversal.
- **`proxy.cross.test.ts`** — runs only in the `cross_backend_rust_proxy`
  project (backend booted with `ZZZ_TRUSTED_PROXIES=127.0.0.1`, which can't be
  flipped mid-run). Each test triggers a failed login under a unique username
  and asserts the resulting `audit_log.ip` matches the expected resolved client
  IP for a given `X-Forwarded-For` + connection-IP combination (no-XFF,
  trusted/untrusted hops, malformed entries, IPv6, IPv4-mapped normalization,
  leftmost fallback). The resolution itself is `fuz_http::client_ip_middleware`
  (spine crate), where the pure functions carry their own `#[cfg(test)]` unit
  tests.

Supporting files: `global_setup.ts` (vitest globalSetup),
`zzz_backend_config.ts` (per-project `BackendConfig` factories),
`zzz_surface_spec.ts` (the TS `AppSurfaceSpec` + RPC endpoints), and
`cross_test_types.ts` (`inject('backend_handle')` typing).

```bash
npm run test:cross                                                        # Both rust projects (rust + rust_proxy) — flag baked in
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust       # Single project (Rust binary; postgres://localhost/zzz_test_rust)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust_proxy # Single project (proxy variant; ZZZ_TRUSTED_PROXIES=127.0.0.1, proxy.cross.test.ts only)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run -t ping                            # Substring match on test name (vitest -t flag)
```

The `cross_backend_*` projects are gated behind `FUZ_TEST_CROSS_BACKEND=1`
in `vite.config.ts` so a bare `gro test` never spawns backends. The
`test:cross` package.json script (`npm run test:cross`) bakes the flag in;
set it manually only for the single-project `--project` runs.

The harness writes a bootstrap token to a tmpdir, spawns the test binary
via the project's `BackendConfig.start_command`, waits for health,
bootstraps an admin account via `POST /api/account/bootstrap`, then
provides the bootstrapped handle to test files via vitest's
`inject('backend_handle')`. SIGTERM on globalSetup teardown leaves no
stranded ports. Each project targets its own real PostgreSQL DB
(`zzz_test_rust` / `zzz_test_rust_proxy`), with its auth-namespace schema
wiped on backend startup (`FUZ_TESTING_RESET_DB_ON_STARTUP`) and
`_testing_reset` clearing it between tests (preserving the keeper row).

## Architecture

```
crates/zzz_server/src/
├── lib.rs            # `run_app(RunAppOptions)` — full lifecycle: env/config, DB pool + migrations, spine state construction (keyring, audit emitter, connection + SSE registries, rate limiters), `ActionRegistry::compile`, file watchers, route composition, graceful shutdown
├── main.rs           # Thin production entry — constructs `Argon2idHasher`, calls `run_app`
├── handlers/         # `App` state + the per-domain RPC handlers (spine signature `(Value, ActionContext<'_>, Arc<App>)`, registered into the `ActionRegistry` via `zzz_action_specs::build_*_specs`; `session_load` and `workspace_open` return a `fuz_actions::ActionOutput` — see Large responses below)
│   ├── mod.rs        # `App` long-lived state (workspaces, `workspace_lifecycle`, `db_pool`, `ScopedFs`, `FilerManager`, `PtyManager`, `ProviderManager`, `realtime`, `action_registry` OnceLock) + the `broadcast` shim over `App.realtime`
│   ├── core.rs       # ping, session_load, _testing_emit_notifications
│   ├── filesystem.rs # diskfile_update, diskfile_create, diskfile_delete, directory_create
│   ├── provider.rs   # provider_load_status, completion_create
│   ├── terminal.rs   # terminal_create, terminal_data_send, terminal_resize, terminal_close
│   └── workspace.rs  # workspace_list, workspace_open, workspace_close (+ workspace_changed broadcast)
├── zzz_action_specs/ # Per-domain `ActionSpec` builders consumed by `run_app`'s `ActionRegistry::compile`; each captures `Arc<App>` and calls the matching `handlers::*` fn
│   ├── mod.rs
│   ├── core.rs
│   ├── filesystem.rs
│   ├── provider.rs
│   ├── terminal.rs
│   └── workspace.rs
├── provider/         # AI provider system
│   ├── mod.rs        # ProviderName, ProviderStatus, Provider enum, ProviderManager, CompletionOptions
│   ├── anthropic.rs  # AnthropicProvider — Messages API with SSE streaming
│   ├── common.rs     # shared provider helpers
│   ├── sse.rs        # provider SSE parsing
│   ├── openai.rs     # OpenAiProvider — Chat Completions API with SSE streaming
│   └── gemini.rs     # GeminiProvider — Generative Language API with SSE streaming
├── filer.rs          # Filer + FilerManager (notify crate) — level-triggered file index (events are hints, `lstat` decides), per-directory watches from the filer's own walk (degraded polling past the watch limit), stat-reusing rescans, debounced + coalesced filer_change broadcasts, overflow rescans, symlinks skipped
├── pty_manager.rs    # PTY terminal manager (fuz_pty crate) — one task per terminal (readiness-driven I/O, ordered input queue, reaping) → terminal_data/exited notifications; `terminal_env` scrubs the child env
├── scoped_fs.rs      # Scoped filesystem — permanent (`zzz_dir` + `scoped_dirs`) + per-workspace roots, path validation, symlink rejection, atomic writes (temp file + fsync + rename)
├── static_files.rs   # Built-frontend fallback router: exact file → prerendered `{path}.html` → `200.html` SPA shell; backend paths + missing `_app/` assets 404; cache headers
├── utf8_stream.rs    # Incremental UTF-8 decoder (split sequences held back, invalid bytes → U+FFFD) shared by provider SSE and PTY output
└── error.rs          # ServerError (Bind, Serve, Database, Config)
```

Auth, HTTP / origin / proxy, realtime (WS + SSE), dispatch (`ActionRegistry`
and `perform_action`), and DB pool / migrations all live in the spine crates
(`fuz_auth` / `fuz_http` / `fuz_realtime` / `fuz_actions` / `fuz_db`) —
`zzz_server` composes them in `run_app`. `handlers/` holds `App` state, a
`broadcast` shim over `App.realtime`, and the per-domain handlers; socket
revocation is the spine `RealtimeRevoker` over the WS and SSE registries
(see Auth item 10).

**Large responses**: `session_load` and `workspace_open` carry every
indexed file's contents, so they skip the `serde_json::Value` round trip: the
filer index holds contents as `Arc<String>` (a snapshot clones pointers, not
text), the handler returns its typed result as a `fuz_actions::ActionOutput`
(registered with `ActionSpec::new_output`, sized up front from the contents),
and the spine serializes it once, straight into the response body — so an
HTTP response costs about its own size in memory, and a WebSocket one about
twice that (tungstenite copies each outgoing frame into its write buffer).
Keys come out in struct declaration order rather than the sorted order of a
`Value` rendering — the same JSON, which no client may depend on the key
order of. Responses aren't capped: a workspace of many large files is a large
response.

**App + dispatch**: `App` (in `handlers/mod.rs`) holds zzz's long-lived,
non-spine state — `instance_id` (a UUID minted at boot, returned by
`session_load` as `server_instance_id` so clients can tell a restart),
`workspaces` (`RwLock<HashMap>`), `workspace_lifecycle`
(the `tokio::sync::Mutex` serializing `workspace_open` / `workspace_close`),
`db_pool`, `ScopedFs`,
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
`fuz_actions::RpcRouteState` / `WsRouteState` (both carrying `notification_sender: Arc<dyn NotificationSender>` for realtime dispatch fan-out), and
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

- `fuz_auth::register_socket_revocation_listeners` — closes
  matching connections through the bound `RealtimeRevoker` (WS sockets and audit
  streams) on `session_revoke` / `token_revoke` (granular) and
  `session_revoke_all` / `token_revoke_all` / `password_change` / `logout`
  (account-wide). Revocation-emitting handlers also close directly — the RPC
  ones on the post-commit queue, the REST `/logout` / `/password` inline before
  their audit write — so revocation lands on sockets and audit streams alike
  even if a pool-routed audit INSERT later fails.
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
- **error.data omits Zod validation details** — for -32602 (invalid params)
  errors, `error.data` omits the Zod issues for security (no schema leak to
  unauthenticated callers). The integration test `normalize_error_data`
  function tolerates either shape. Future: env-conditional — include the
  issues in dev, strip in prod.
- **filer skips symlinks** — the walker and event handling never follow or
  index a symlink (file or directory), and no watch is added through one
  (watches go only on real directories the walker lists), consistent with
  `ScopedFs`'s no-symlink rule.
  This keeps link loops (`up -> ..`, a Wine prefix's `dosdevices/z: -> /`)
  from hanging the scan and keeps files outside the watched root out of the
  index. A symlinked file or directory inside a workspace is invisible in
  the file tree.
- **filer file-size cap** — `filer::MAX_INDEXED_FILE_SIZE`
  (4 MiB, in `crates/zzz_server/src/filer.rs`) caps the in-memory index: files
  over 4 MiB carry their metadata but store `contents: None`. This bounds
  memory under workspaces containing large lockfiles or build outputs.
  The cross-backend integration tests don't exercise files >4 MiB. The
  frontend treats such a file (and any other `contents: None` — non-UTF-8 or
  unreadable) as not loaded: read-only, never saved over (see the root
  CLAUDE.md § Known Limitations). A loaded file's save fits the 16 MiB RPC
  message cap except in the worst case (JSON escapes each control character
  to 6 bytes), where the client guard refuses it cleanly.
- **filer skips non-UTF-8 paths** — a file or directory whose name isn't
  valid UTF-8 is skipped with its whole subtree, by the walker and in event
  handling (`is_ignored`), rather than indexed under a lossy U+FFFD key no
  client could address.
- **Filer watches** — each filer adds one non-recursive notify watch per
  directory it indexes, from its own walk (`filer::DirWatches`), so ignored,
  symlinked, and non-UTF-8 directories and the app dir get none — the watch
  budget scales with what's indexed, not with `node_modules/` or `target/`.
  Each directory is watched before it's listed, so an entry created in
  between is either listed or reported; a directory that appears (created,
  renamed in, recreated) gets watches for its subtree during its sync, and
  one that's removed or renamed away has its watches dropped. The walk and
  the watch calls (a round trip to notify's watcher thread each) run on
  blocking threads. Watches are reference-counted by inode: two paths naming
  one directory (a renamed directory's old and new path before the old is
  dropped, a bind mount) share one kernel watch, removed only with its last
  path. Failures are per directory: an unreadable directory is skipped and
  logged once (its parent's watch reports a chmod that makes it readable,
  which syncs it; a watched directory chmod'ed unreadable is re-checked on
  that report and drops out of the index), a vanished one ignored, and one
  whose listing fails transiently (`EMFILE`, `ENOMEM`, `EIO` — anything but
  `EACCES` / `ENOENT` / `ENOTDIR`) keeps what's indexed under it and is
  polled until it lists; only a root that can't be listed fails
  `start_filer` (`workspace_open` → `forbidden` / `not_found`). A running
  filer whose root goes missing polls it until it's back. An overflow
  (dropped events, or inotify's queue overflow) replaces the watcher with a
  fresh one and re-adds every watch during the rescan, since neither the
  bookkeeping nor notify's own path map survives lost events. The watcher
  comes from a factory (`WatcherFactory`) that holds the event channel's
  sender, so the event loop runs — polling, answering rescans — even with
  no watcher. **Degraded mode**: past the watch limit (inotify's `ENOSPC`
  from `max_user_watches`, `FilerConfig::watch_limit`, or no watcher at all
  — e.g. `max_user_instances`), the remaining directories are listed
  unwatched and the index still comes from the scan; the topmost unwatched
  directories are rescanned every `DEGRADED_RESCAN_INTERVAL` (5s, or 10x the
  last rescan's duration if longer), retrying their watches, and
  `Filer::watch_status` reports `Degraded` (returned by `workspace_open` as
  `watch_status`, kept on the opening tab's `Workspace` cell and shown on
  the workspaces page and in the desk menu). A limit hit stops watch attempts
  until the next rescan. A filer that degrades or recovers after
  `workspace_open` returns is only logged — no notification carries the
  change. Rescans (`session_load`, overflow, degraded polling) reuse a
  file's indexed node when its `lstat` identity and change stamps
  (`filer::FileStat`: dev, inode, size, mtime, ctime) are unchanged, so they
  re-read only changed files; following git's "racily clean" rule, a stamp
  is only recorded once the file has been still for `RACY_STAT_MARGIN` (2s)
  and the read saw the stat's size, since same-size writes inside one
  timestamp tick (coarse on tmpfs) leave every stamp unchanged.
  `FilerManager::start_filer` gates starts per path, so concurrent opens of
  one directory share a single initial scan. On macOS `FSEvents` each watch
  call restarts notify's stream, so per-directory watching is slow there on
  large trees.

## Known Limitations

- RPC methods: `ping`, `session_load`, `workspace_*`, `diskfile_update`, `diskfile_create`, `diskfile_delete`, `directory_create`, `terminal_*`, `provider_load_status`, `completion_create`, `account_verify`, `account_session_list`, `account_session_revoke`, `account_session_revoke_all`, `account_token_create`, `account_token_list`, `account_token_revoke`, `admin_session_revoke_all` (admin-only), `admin_token_revoke_all` (admin-only) — plus the rest of the spine-registered `fuz_auth` standard bundle and protocol specs (see the workspace-layout section above)
- 5 zzz-domain `remote_notification` actions: `workspace_changed` (broadcast on open/close), `filer_change` (`FilerManager` with `notify` crate — per-directory watches (see Filer watches below), per-path debounced broadcasts (80ms quiet, capped at 500ms) with immediate index updates (delete+create inside the window becomes `change`, create+delete becomes a bare `delete`), every event resolved by `lstat` so late or reordered removes can't drop an existing file, rename-aware (old path `delete`, new path `add`), ignored paths filtered before the bounded event channel with a coalesced root rescan on overflow, per-watcher ignore config, in-memory file index returned by `session_load` and `workspace_open`, symlinks skipped; ignores `.git`/`node_modules`/`.svelte-kit`/`target`/`dist`/`.zzz` by name globally (`.zzz` keeps the CLI daemon home's `.env` / `bootstrap_token` out of a `~` workspace), `ScopedFs`'s `.zzz-tmp-*` staging files (the walk also deletes orphaned ones — exact `.zzz-tmp-<uuid>` names, regular files over an hour old), and every non-UTF-8 path, plus `zzz_dir` by its full path for a workspace/scoped_dir watcher whose root contains it; startup filers on `zzz_dir` and `scoped_dirs`, per-workspace filers with dedup and lifetime tracking), `terminal_data` (PTY output) and `terminal_exited` (process exit), both sent only to the owning account's sockets, `completion_progress` (streaming completion chunks to requesting WS connection); the spine's role-grant-offer bundle carries its own notification set (`role_grant_offer_received` / `_retracted` / `_accepted` / `_declined` / `_supersede`)
- AI providers: Anthropic, OpenAI, and Gemini all fully implemented (non-streaming + SSE streaming)
- No batch request support (JSON arrays)
- `/api/account/signup` is mounted via `fuz_auth::signup_routes`. Invite-gated by default (`app_settings.open_signup=false`); admins flip the setting via `app_settings_update` to enable open signup. The cross-process test binary opts into `open_signup: true` at startup via `app_settings_patch` so per-test `mint_account` can sign up without invites. `app_settings` is loaded from the DB per signup request (no cache).
- Token management is JSON-RPC only (`account_token_create` / `account_token_list` / `account_token_revoke`) — no REST token routes
- Admin audit-log SSE broadcast is live at `GET /api/admin/audit/stream` — the shared `fuz_realtime::audit_stream_router`, wired to the spine `AuditEmitter` via `fuz_realtime::register_audit_sse_listener` alongside the socket-revocation listeners (which close through the `RealtimeRevoker` fan-out, so they reach these streams too). Wire shape matches fuz_app's `audit_log_sse`; the `sse.cross.test.ts` suite verifies it. Close-on-revoke dispatches on the `RevocationScope` each event declares in `fuz_auth`'s `AUDIT_EVENT_SPECS` — the same column the socket-revocation listener reads, so the two can't drift: `session_revoke` (session-hash-scoped) / `token_revoke` (token-scoped) / `session_revoke_all` / `token_revoke_all` / `password_change` / `logout` / `account_delete` / `account_purge` (account-wide) / `role_grant_revoke` (role-matched). `role_grant_revoke` is the one deliberate difference from the socket-revocation listener, which omits it because `perform_action` re-authorizes every message. The route itself is session-only (`AuditStreamRouteState::credential_gate`), so a bearer never opens a stream here in the first place
- Login/password rate limiting is **always on** (matching `fuz_forge_server` + `mageguild_server` and the fuz defaults): per-IP (5 attempts / 15 min) + per-account (10 / 30 min) sliding windows fire on `/login` and `/password`; 429 carries `{error: 'rate_limit_exceeded', retry_after}` plus a `Retry-After` header. Per-IP key is the resolved client IP from `fuz_http::client_ip_middleware` — set `ZZZ_TRUSTED_PROXIES` when running behind a reverse proxy so the bucket keys on the originating client rather than the proxy. The `testing_zzz_server` binary disables it via `RunAppOptions::rate_limiters: RateLimiterMode::DisabledForTesting` so the cross-backend auth suite's repeated logins don't trip the bucket; a process that nulls any limiter prints a startup banner saying so
- One JSON-RPC message is capped at `zzz_server::RPC_MESSAGE_MAX_BYTES` (16 MiB) on both transports: the `/api/rpc` request body (`fuz_http::body_limit_layer`, plus axum's `DefaultBodyLimit` raised to match — the handler's `Bytes` extractor would otherwise stop at axum's 2 MiB default) and each `/api/ws` inbound message and frame (`fuz_actions::register_action_ws_with_message_limit`; the spine default is 1 MiB, tungstenite's own 64 MiB / 16 MiB). It's above the spine's 1 MiB so saving a file the filer loads (≤ 4 MiB) fits — except in the worst case, where JSON's 6-byte escape of each control character pushes a file dense with them past the cap and the client guard refuses the save cleanly — and so long completion histories fit. **The larger buffer isn't confined to authenticated callers on HTTP**: `fuz_actions::rpc_post_handler` buffers and parses the body before auth, and `ping` is public, so any local process can make zzzd hold up to 16 MiB per concurrent request. On the WebSocket (authenticated at upgrade) up to 128 dispatches can be in flight per socket, a ceiling of about 2 GiB of buffered messages per authenticated socket. Both are acceptable only because the bind is loopback-only and zzz is single-operator (root CLAUDE.md § Security posture). The account/bootstrap/signup routers keep `fuz_http::DEFAULT_BODY_LIMIT_BYTES` (1 MiB). An oversized WebSocket message gets no error reply — the read fails and the socket closes (code 1006), taking its in-flight requests with it — so the frontend `Socket` refuses any request over the cap before sending (`RPC_MESSAGE_MAX_BYTES` in `src/lib/rpc_message_limit.ts`, pinned to the Rust constant by the cross-backend filesystem suite). A streaming content-addressed route is the deferred path for larger / binary blobs. The static fallback takes no body

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
- **Strict inputs**: every zzz handler decodes `params` through
  `fuz_http::parse_strict_params` into a `#[serde(deny_unknown_fields)]`
  struct mirroring its `z.strictObject` TS input (unknown keys and explicit
  `null`s are `invalid_params`; nested `.optional()` fields refuse `null`
  through a `present` deserializer; UUID fields use
  `fuz_auth::deserialize_wire_uuid`), and the `z.void()` methods (`ping`,
  `session_load`, `workspace_list`) refuse any declared key via
  `fuz_auth::require_void_params` — an absent `params` and a `{}` are both
  the no-arg call, since fuz_app's WebSocket client sends `{}` for a
  parameterless request.
- **Filesystem errors**: `handlers::filesystem::scoped_fs_error` maps each
  `ScopedFsError` by cause, with `data.reason` set to an `ERROR_*` constant:
  a relative / NUL path, a directory or special file where a file was
  expected, or a non-directory where one was expected → `invalid_params`
  (-32602; `invalid_path`, `is_a_directory`, `not_a_regular_file`,
  `not_a_directory`); out of scope, a symlink, an OS permission refusal
  (including a read-only target file or filesystem), or a new file or
  directory in a non-writable directory → `forbidden` (-32002; `path_not_allowed`,
  `symlink_not_allowed`, `permission_denied`, `directory_not_writable`); a
  missing path → `not_found` (-32003; `path_not_found`); `diskfile_create`
  or `directory_create` over an existing path, or a save whose file was replaced mid-save →
  `conflict` (-32004; `already_exists`, `replaced_during_save`); any other
  I/O failure → `internal_error` (-32603, no
  reason). Messages keep the `failed to … : …` prefix. `workspace_open` maps
  the same way (missing → `not_found`; not a directory → `invalid_params` /
  `not_a_directory`; a NUL byte, a symlink loop, or an over-long name →
  `invalid_params` / `invalid_path`; a directory whose listing is refused →
  `forbidden` / `permission_denied`), and refuses a path that is, or is
  inside, a directory named `.zzz` other than the app dir — checked on the
  canonical path, so no symlink gets around it — with `forbidden` /
  `zzz_home_not_allowed` (`handlers::workspace::ERROR_ZZZ_HOME_NOT_ALLOWED`,
  `filer::is_in_zzz_home`): the CLI's daemon home holds `.env` and
  `bootstrap_token`. A filer started on such a root refuses too
  (`FilerConfig::root_in_zzz_home`); a scoped dir there fails boot before
  any filer starts (`PUBLIC_ZZZ_SCOPED_DIRS` below).
  `workspace_close` of a path that isn't open → `invalid_params` /
  `workspace_not_open` (`handlers::workspace::ERROR_WORKSPACE_NOT_OPEN`).
- **Atomic writes**: `ScopedFs::write_file` stages content in a hidden
  `.zzz-tmp-<uuid>` file beside the target (`O_EXCL | O_NOFOLLOW`), gives it
  the replaced file's mode minus setuid/setgid (zzz always drops them — the
  content changed) and (best-effort `fchown`) owner +
  group, writes, fsyncs, renames it over the target, and fsyncs the directory
  (best-effort), all on a blocking thread; the temp file is removed on any
  failure. So `ENOSPC` / `EFBIG` / a crash leave the old file intact, and
  concurrent saves to one path never interleave (the last rename wins — no
  per-path lock needed). The filer ignores `.zzz-tmp-*` names
  (`scoped_fs::is_temp_file_name`), so only the publishing rename is indexed
  and broadcast. An existing target must be a regular file — a directory,
  FIFO, socket, or device node is refused before anything is opened (a FIFO
  would otherwise block the write, holding a pooled DB connection and a
  blocking thread). Trade-offs: the result is a new inode, so **hardlinks are
  broken** (other names keep the old content) and xattrs / ACLs aren't
  carried over; a file owned by another user becomes the daemon user's when
  `fchown` isn't permitted. An existing target must be writable by the
  daemon — checked by opening it for writing (no create, no truncate), since
  a rename needs only the directory's permission and would otherwise replace
  a read-only file — else `permission_denied`. **In-place fallback (not
  atomic):** when the rename can't happen but the file is writable — the
  directory isn't writable (no temp file), or the rename fails `EBUSY` (a
  bind-mounted file), `EXDEV`, or `EPERM` (a sticky directory) — the content
  is written through that handle: truncate, write, fsync (inode, mode, owner,
  and hardlinks kept; a failure midway leaves the file truncated or
  partial). It first checks the path still names the opened file (`fstat`
  `(dev, ino)` against a fresh `lstat`); a file replaced or removed
  externally since the open fails with `conflict` / `replaced_during_save`
  rather than writing into an unreachable inode. A new file in a non-writable directory is `directory_not_writable`.
  Errors always name the target, never the temp file. A crash can orphan a
  staging file: the filer's walk deletes exact `.zzz-tmp-<32 hex>` names
  that are regular files last modified over an hour ago
  (`scoped_fs::ORPHANED_TEMP_FILE_MIN_AGE`), and nothing else — staging files
  inside ignored directories aren't reached. `diskfile_create`
  (`ScopedFs::create_file`, used by the editor's "new file") creates the
  final name `O_CREAT | O_EXCL | O_NOFOLLOW` and fails with `already_exists`
  rather than overwriting; a failed write removes the file it created.
  `directory_create` (`ScopedFs::create_dir`, the "new folder") likewise
  creates missing parents but fails with `already_exists` when anything
  holds the final name (`mkdir(2)` is exclusive) — for both, a symlink there
  is `symlink_not_allowed` (path validation refuses it first), and a missing
  parent under a read-only ancestor is `permission_denied`. `rm` and `create_dir` stay
  plain `tokio::fs` calls (unlinking a FIFO doesn't open it).
- **Dispatch is async**: filesystem handlers (`diskfile_update`, etc.) use
  `tokio::fs` async I/O (the atomic write's blocking I/O runs on
  `spawn_blocking`). `workspace_open` / `workspace_close` canonicalize
  asynchronously and serialize on `App::workspace_lifecycle` (a
  `tokio::sync::Mutex`), since each spans the workspaces map, `ScopedFs`, and
  the workspace filer across await points. `workspace_open` runs in its own
  task (a dropped caller can't abandon it halfway) and starts the filer —
  the initial walk, watches, and reads — before taking the lock, then
  re-ensures it under the lock (a dedup hit, unless a racing close stopped
  it), so a large tree's scan doesn't hold up other opens and closes.
- **`parking_lot::RwLock`** for short synchronous sections (the workspaces
  map, `ScopedFs` roots); no poisoning. The async managers (filer index,
  PTY terminals, providers) use `tokio::sync::RwLock` — scope sync guards
  before await points.
- **PTY terminals**: `fuz_pty` as a native crate dependency (no FFI
  indirection). `PtyManager` in `App` runs one task per terminal that
  exclusively owns the PTY master (`tokio::io::unix::AsyncFd` over a
  `PtyHandle` newtype — `AsRawFd` is a safe impl, so no `unsafe` here) and the
  child pid:
  - **Output** is readiness-driven (no polling) and decoded with
    `utf8_stream::Utf8StreamDecoder` so a multibyte character split across
    reads isn't mangled. `AsyncFd` readiness doesn't spend tokio's coop
    budget, so the loop calls `tokio::task::coop::consume_budget()` per chunk
    — a child that never stops writing (`yes`) can't pin a worker thread.
  - **Input**: `terminal_data_send` enqueues onto a bounded per-terminal queue
    (at most 256 chunks and 4 MiB held — queued or being written; past
    either → `queue_overflow`, nothing enqueued) and returns. A single chunk
    over 4 MiB is accepted only while nothing is held, so any send the
    16 MiB message cap admits still goes through, and a terminal holds at
    most one such chunk. The task writes each
    chunk in full — looping on partial writes, waiting for writability on
    `EAGAIN` — before the next, so a large paste is never truncated and two
    chunks never interleave. Chunks are written in the order sends reach the
    handler: sends on one socket are dispatched concurrently (each through
    the pool and a `side_effects` transaction), so ordering across sends is
    the client's job.
  - **Resize** is latest-wins through a `watch` channel; `cols` / `rows`
    must be `1..=65535` (`invalid_params` otherwise, never truncated).
  - **Exit**: on EOF the task closes the master, reaps the child, and
    sends `terminal_exited` with the real exit code. `terminal_close`
    sends the signal (`SIGTERM` by default, or `SIGKILL`; any other is
    `invalid_params`, never silently a `SIGTERM`), waits 50ms, closes the master (the hangup ends an
    interactive shell that ignores `SIGTERM`), waits 100ms more, and replies
    with the exit code or `null`; a child still alive is reaped in the
    background (`SIGKILL` after 3s) — no zombie outlives its terminal, and no
    `terminal_exited` is sent for a closed terminal. `kill_all`
    (shutdown, `_testing_reset`) escalates to `SIGKILL` right after the close
    grace and waits for every reap, bounded at 5s.
  - **Ownership**: `terminal_create` records the calling account as the
    terminal's owner. `terminal_data` / `terminal_exited` go to that
    account's sockets only (`ConnectionRegistry::send_to_account`), and
    `terminal_data_send` / `terminal_resize` / `terminal_close` from any other
    account behave exactly as for an unknown id (no effect, same reply — see
    below), so a terminal's existence isn't observable across accounts.
    `session_load` lists only the caller's terminal ids. A successful
    `account_delete` / `account_purge` audit event closes the target account's
    terminals (`handlers::terminal::register_terminal_account_listener`,
    beside the spine's socket-revocation listeners). Creation itself is open
    to any authenticated account (`CredentialGate::Any`) — and a terminal is a
    shell as the daemon's OS user; see the root CLAUDE.md § Security posture.
    Notifications go to every socket of the account, regardless of which API
    token or session opened it.
  - **Spawn** runs in its own task (so a caller dropped mid-spawn can't
    abandon a live PTY) around `spawn_blocking`. A `cwd` must be absolute
    (`invalid_params` / `invalid_path` otherwise — a relative one would
    resolve against zzzd's own working directory). A bad `cwd` or unexecutable command
    fails `terminal_create` (fuz_pty reports the child's `chdir` / `execvpe`
    errno over a close-on-exec pipe). The PTY pair is created close-on-exec
    atomically, so no other child inherits a terminal's master or slave, and
    the child starts with default signal dispositions and an empty mask
    (the Rust runtime's ignored `SIGPIPE` doesn't leak into shells).
  - **Environment**: children get zzzd's environment minus `SECRET_*`,
    `FUZ_*`, `ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, and `PORT`
    (`pty_manager::terminal_env`, a pure filter). Everything else — `PATH`,
    `HOME`, `SSH_AUTH_SOCK`, `WAYLAND_DISPLAY`, `XDG_*` — passes through,
    since a terminal is the user's shell; fuz_pty forces
    `TERM=xterm-256color`. This keeps secrets out of the child's
    environment; it is not isolation — the shell runs as the same user and
    can still read `/proc/<zzzd pid>/environ` or the `.env` files. The
    prefix match also drops the user's own `FUZ_*` variables (e.g. for the
    `fuz` CLI) from terminals.
  - **Missing terminal IDs** (unknown, ended, lost to a restart, or another
    account's — one `pty_manager::TerminalNotFound`): `terminal_data_send`,
    `terminal_resize`, and `terminal_close` fail with `not_found`
    (`"terminal not found"`, no `data`), so a client notices a terminal it
    thinks is running is gone; the frontend takes a `not_found` close as
    closed, since the process is already gone.
- **Provider system**: Enum-dispatched (`Provider` enum, not trait objects) —
  3 providers known at compile time, exhaustive matching. API keys come from
  the `SECRET_*_API_KEY` env vars at construction and are never mutated at
  runtime; provider state sits behind `tokio::sync::RwLock` for the
  `load_status` cache write. The shared client has a 30s connect timeout and
  a 15-minute read timeout (`provider::common::READ_TIMEOUT`): until the
  response headers arrive it's one non-resetting deadline over connect +
  upload + the wait for headers, then it bounds each body read, resetting
  after every one. So a provider that stalls mid-stream or never answers
  can't hold a completion and its pooled DB connection forever; it's
  generous because a non-streaming completion sends no headers until it's
  done (Anthropic caps those at 10 minutes) and reasoning models can go
  quiet mid-stream. `complete()` clones the `reqwest::Client`
  (internally `Arc`'d) and releases the lock before HTTP calls, so a
  long-running streaming response doesn't hold it against a status refresh.
  SSE parsing is manual (`provider/sse.rs`: line endings normalized, split
  UTF-8 reassembled, the final event flushed at end of stream).
- **Dispatcher transaction wrap**: `fuz_actions::perform_action` wraps
  `side_effects: true` actions in a `tokio_postgres` transaction (commit on
  `Ok`, rollback on `Err`) and drains post-commit pending effects, so paired
  writes commit atomically; read-only actions get a pooled client with no
  transaction. Either way the handler holds a pooled connection for its whole
  run — a long streaming `completion_create` included.
  zzz's `handlers` functions receive the `ActionContext` DB handle and
  stay transaction-agnostic — the wrap is the spine's concern.

## What's Next

**Spine consumption — complete.** The spine crates (`fuz_db`,
`fuz_auth`, `fuz_http`, `fuz_realtime`, `fuz_actions`) own auth, HTTP,
realtime, and dispatch. A single `/api/rpc` + `/api/ws` (via
`fuz_actions::create_rpc_router` / `register_action_ws`) serves the
boot-compiled `ActionRegistry`; account / bootstrap / signup REST come
from fuz_auth's routers; the admin audit-log SSE stream
(`GET /api/admin/audit/stream`) comes from
`fuz_realtime::audit_stream_router` + `register_audit_sse_listener`.
Besides the handlers, `handlers/` holds `App` state + a `broadcast` shim
over `App.realtime`.

**AI providers** (Anthropic, OpenAI, and Gemini all complete):

- [x] Provider system: enum-dispatched `Provider` with `ProviderManager`, `ProviderStatus`, `CompletionOptions`
- [x] Anthropic provider: full implementation with `reqwest` HTTP client, SSE streaming, message format conversion
- [x] `provider_load_status` handler (all 3 providers report status)
- [x] `completion_create` handler with `completion_progress` streaming notifications (targeted to requesting WS connection)
- [x] `session_load` returns real provider status from all providers
- [x] OpenAI provider: full completion implementation (Chat Completions API, non-streaming + SSE streaming)
- [x] Gemini provider: full completion implementation (Generative Language API, non-streaming + SSE streaming)

**Other remaining work**:

1. Codegen from Zod specs (action input/output types)

- [x] Trusted-proxy client-IP resolution (XFF + CIDR + strict-IP
      validation), Origin allowlist (Origin-only, no Referer fallback), and
      login-username canonicalization — all now provided by the spine
      (`fuz_http` proxy/origin + `fuz_auth`); zzz wires them via config
      (`ZZZ_TRUSTED_PROXIES`, `FUZ_ALLOWED_ORIGINS`).
