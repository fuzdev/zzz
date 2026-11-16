# zzz Rust Backend

zzz's backend, using axum. Serves the frontend (a prerendered static SPA) and
a single JSON-RPC 2.0 API over HTTP + WebSocket. AI providers are Anthropic,
OpenAI, and Gemini (all full).

**Workspace layout** (each crate in full: ../docs/backend.md § Crates):

- `zzz_server/` — library + the production daemon binary `zzzd`.
  `run_app(RunAppOptions)` in `src/lib.rs` owns the lifecycle over the
  spine's server toolkit (`fuz_actions::server`); `src/main.rs` is the thin
  production entry.
- `testing_zzz_server/` — the test binary `testing_zzzd`: fast argon2,
  `_testing_reset` and `_testing_drain_effects`, default port 4462. **Never
  ships in a release** (`fuz_release`'s `testing_` filter and `cargo xtask
  check-release`).
- `xtask/` — `cargo xtask dev`, `dev-setup` / `prod-setup`, `check-release`,
  `ghostty-vt`; pure `std` + `fuz_audit`, marked `dev_only`.
- `zzz/` — the CLI: `daemon_launch.rs`, `opener.rs`, `daemon_lifecycle.rs`,
  `procfs.rs`, `env_file.rs`; its rules are ../docs/development.md § The
  `zzz` CLI.

AI provider system feature-complete for all three providers (Anthropic,
OpenAI, Gemini). Spine consumption is
complete — the spine crates (`fuz_db`, `fuz_auth`, `fuz_http`,
`fuz_realtime`, `fuz_actions`) own auth, HTTP, realtime, and the
boot-compiled `ActionRegistry` dispatch path. A single canonical
`/api/rpc` + `/api/ws` (mounted via `fuz_actions::create_rpc_router` /
`register_action_ws`) serves all dispatch; admin + account specs come
from fuz_actions' `auth_adapter::build_auth_spec_set`, the zzz-specific
workspace / filesystem / media / job / terminal / provider specs from
`zzz_action_specs/` (handlers in `handlers/`), the admin audit-log
SSE stream from `fuz_realtime::audit_stream_router`, and zzz's own
hand-written file byte routes (`file_bytes.rs`, outside the registry). Besides the handlers,
`handlers/` holds `App` state and a `broadcast` shim over `App.realtime` (connection revocation
lives on the spine's `ConnectionRegistry` — see Auth below). RPC methods:
`ping`, `session_load`, `workspace_*`, `diskfile_*`, `directory_create`,
`media_finalize`, `transcription_create`, `job_cancel`, `terminal_*`,
`provider_load_status`, `completion_create`,
`account_verify`, `account_session_list`,
`account_session_revoke`, `account_session_revoke_all`,
`account_token_create`, `account_token_list`, `account_token_revoke`,
`admin_session_revoke_all`, `admin_token_revoke_all`.
Those are the zzz-domain methods plus fuz_app's account self-service and
admin-revocation slice; `auth_adapter::build_auth_spec_set` registers the
rest of `fuz_auth`'s standard bundle too — admin account/audit/invite
management, `app_settings_*`, and the consent-based `role_grant_*` /
`role_grant_offer_*` flow with its own notifications — plus
`fuz_actions::PROTOCOL_ACTION_SPECS` (`heartbeat`, `peer/ping`; `cancel` is a
client notification the WS read loop handles, not a spec).
That spine surface is live on `/api/rpc` + `/api/ws` even though zzz ships
no UI for most of it; the spine crates are its source of truth.
`_testing_emit_notifications` is gated behind
`ZZZ_ENABLE_TEST_ACTIONS=1` (set by the integration runner; production
leaves it unset, dispatch returns `method_not_found`). Full auth stack (cookie
sessions, bearer tokens, daemon
tokens), account management routes, filesystem actions with `ScopedFs`,
terminal actions via `fuz_pty`, `session_load` returns real provider status
from all registered providers, `workspace_changed`/`filer_change`/
`terminal_data`/`terminal_exited`/`job_changed`/`transcription_progress`
notifications, local tools (`ffmpeg`, whisper.cpp) run as subprocesses with an
in-memory job queue, file watching via `notify`
crate with debounced broadcasts and immediate index updates, WebSocket
connection tracking with targeted `completion_progress` streaming
notifications, event-driven connection revocation. Database (PostgreSQL via
`tokio-postgres`/`deadpool-postgres`), HMAC-SHA256 cookie signing, blake3
session hashing. Anthropic provider uses `reqwest` HTTP client with manual
SSE parsing for streaming completions.

## Prerequisites

The sibling [fuz](https://github.com/fuzdev/fuz) workspace must be checked out alongside this repo:

```
~/dev/zzz/                  (this repo)
~/dev/fuz/                  (path deps: fuz_sys, fuz_pty, the spine crates — fuz_db, fuz_auth, fuz_http, fuz_realtime, fuz_actions — plus fuz_testing for the test binary and fuz_audit for xtask)
```

If a path dep is missing, `cargo build` will fail with
`failed to read .../crates/{crate}/Cargo.toml`.

**PostgreSQL** is required. Create the development and manual-test databases
(the cross-backend projects' `zzz_test_rust` / `zzz_test_rust_proxy` are
created by their global setup when missing):

```bash
createdb zzz                 # development
createdb zzz_test            # manual testing_zzzd runs
```

## Build and Run

```bash
cargo build --workspace
cargo clippy -p zzz_server        # workspace lints: pedantic + nursery
cargo clippy --workspace --all-targets -- -D warnings   # the lint gate: whole workspace, tests included
cargo doc --workspace --no-deps --document-private-items   # the doc-link gate (pass = exit code)
cargo xtask check-release         # audit: no production binary depends on fuz_testing / fuz_audit

# Run (requires DATABASE_URL, SECRET_FUZ_COOKIE_KEYS, and FUZ_ALLOWED_ORIGINS)
DATABASE_URL=postgres://localhost/zzz \
SECRET_FUZ_COOKIE_KEYS=dev-only-not-for-production-use-000 \
FUZ_ALLOWED_ORIGINS='http://localhost:4460' \
./target/debug/zzzd --port 4460

# Test binary (cross-process integration tests — fast argon2)
DATABASE_URL=postgres://localhost/zzz_test \
SECRET_FUZ_COOKIE_KEYS=dev-only-not-for-production-use-000 \
FUZ_ALLOWED_ORIGINS='http://localhost:*' \
FUZ_ALLOW_ORIGIN_WILDCARDS=true \
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
listing the options (`OPTIONS`) — never ignored. Both binaries parse it first
(`parse_process_args(<binary name>)`, before any setup): `-h` / `--help`
prints `Usage: <binary> <OPTIONS>` and exits 0, a bad argument prints the
error and the usage to stderr and exits 2. A failed `run_app` prints its error
chain and a hint (`fuz_sys::cli::report_failure`) and exits 2 for a
configuration error, 1 otherwise — returned from `main` rather than
`std::process::exit`, so the non-blocking log writer's guard drops and
flushes.

### Required Environment Variables

- `DATABASE_URL` — PostgreSQL connection (e.g. `postgres://localhost/zzz`)
- `SECRET_FUZ_COOKIE_KEYS` — HMAC signing keys (min 32 chars, `__` separator for rotation)
- `FUZ_ALLOWED_ORIGINS` — Comma-separated origin allowlist patterns —
  required. `fuz_http::AllowedOrigins::parse` reads it at boot
  (`origin_allowlist.rs`, before the DB is touched): an unset or blank list,
  or any malformed entry — one no browser would send, which would leave every
  browser request a 403 — refuses to boot, naming each refused entry and the
  expected `scheme://host[:port]` shape, and a wildcard one refuses to boot
  unless `FUZ_ALLOW_ORIGIN_WILDCARDS=true`, and with it boots with a `warn!`
  saying what it admits (../docs/backend.md § Auth, item 9). The `.env`
  templates list exact origins (dev: the Vite dev server's,
  `http://localhost:5460` — the port `vite.config.ts` pins with `strictPort`,
  zzz's own rather than Vite's default, and `localhost` only, since Vite binds
  what that name resolves to; prod: `zzzd`'s own
  `http://localhost:4460,http://127.0.0.1:4460`) — `zzzd` trusts whatever page
  is served at a listed origin, and the session cookie reaches every
  `localhost` port, so a wildcard would admit any local page to the WebSocket.
  xtask's `dev_origin_copies` tests hold the dev copies together (the Vite
  port, the template, the setup docs), and a `daemon_launch` test holds the
  prod template to the CLI's default. The cross-backend harness runs the prod
  shape — the backend's own two origins, the page it serves — plus fuz_app's
  `TEST_ORIGIN` (`http://localhost:5173`, the origin its `rpc_call` test
  helper sends), with wildcards refused as the CLI and xtask boot them
  (`zzz_backend_config.ts`); `dev_origins.cross.test.ts` runs a second backend
  on the dev template's list.

An unset or blank (empty or whitespace) `DATABASE_URL` or
`SECRET_FUZ_COOKIE_KEYS` refuses to boot with `<NAME> is unset or blank`.

### Optional Environment Variables

- `FUZ_BOOTSTRAP_TOKEN_PATH` — Path to bootstrap token file
- `FUZ_DB_CHECKOUT_TIMEOUT_MS` — bound on the pool checkouts a request makes,
  in ms (default 5000, `1..=600000`; anything else refuses to boot); a failed
  checkout answers 503 `service_unavailable`, a failed query keeps its 500.
  `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS` (default 30000, same range) bounds the
  checkout behind each audit pool write instead — the failed-login row a
  request waits on included
- `PUBLIC_ZZZ_DIR` — App directory (default `.zzz`, relative to the working
  directory); created at boot (with missing parents, mode `0700`) if absent —
  boot fails, naming the path, if it can't be, or if it resolves to the
  working directory itself (`check_app_dir_is_not_cwd`: the app dir's filer
  skips `.zzz` only below its root, so `PUBLIC_ZZZ_DIR=.` under the CLI would
  index the daemon home's `.env` and `bootstrap_token`; any other directory is
  accepted, the default being the subdirectory `.zzz`). It catches the daemon
  home only as the working directory — an explicit `PUBLIC_ZZZ_DIR` naming
  `~/.zzz` for a daemon run elsewhere makes the home the app dir and indexes
  its `.env`, so don't
- `PUBLIC_ZZZ_SCOPED_DIRS` — Comma-separated filesystem paths (no `~`
  expansion); an entry the root rules refuse (`root_policy.rs`: strictly
  inside `$HOME` or in `ZZZ_ROOTS_OUTSIDE_HOME`, never `/`, `$HOME` or an
  ancestor, or under `/proc`, `/sys`, `/dev`), or that resolves to, or
  inside, a credential directory or a `.zzz` directory other than the app
  dir, fails boot naming the variable, the path, and why
  (`check_scoped_dirs`, run with the config parse, before the DB is touched).
  An entry that doesn't exist yet is checked as spelled (`resolve_dir`: one
  with a `..` fails boot) and again on its canonical path when its filer
  starts (`recheck_scoped_dir`: skipped with a warning if refused, or if it
  resolves anywhere but the path the boot checked)
- `ZZZ_ROOTS_OUTSIDE_HOME` — Comma-separated directories outside `$HOME`
  that roots may be at or inside (no `~` expansion; parsed like
  `PUBLIC_ZZZ_SCOPED_DIRS`). An entry that is `/`, `$HOME` or an ancestor of
  it, or under a pseudo-filesystem fails boot (`build_root_policy`). `$HOME`
  is `fuz_sys::home_dir()`, canonicalized at boot (`root_policy::resolve_home`);
  one that can't be resolved, isn't a directory, or is `/` leaves only this
  list admitting roots, with a boot warning. The app dir (`PUBLIC_ZZZ_DIR`)
  is exempt from the `$HOME` rule but not the floor, and may not sit in a
  credential directory (`check_app_dir_root`)
- `ZZZ_PORT` — Server port (default 4460, `--port` overrides); an invalid port
  (either source — anything but `1..=65535`) refuses to boot rather than
  falling back to the default
- `ZZZ_STATIC_DIR` — Static file directory (must be a directory, or boot fails)
- `ZZZ_FFMPEG_BIN` — the `ffmpeg` binary to run instead of the one on `PATH`;
  must be an absolute path to an executable file, or boot fails naming the
  variable (blank reads as unset). See Local tools under Design Decisions
- `ZZZ_WHISPER_CPP_BIN` — whisper.cpp's `whisper-cli` to run instead of the
  one on `PATH`, under the same rule
- `ZZZ_WHISPER_CPP_MODEL` — the Whisper model file whisper.cpp loads; must be
  an absolute path to a file, or boot fails. No default, no search: unset,
  `transcription_create` is `tool_unavailable`
- `SECRET_ANTHROPIC_API_KEY` / `SECRET_OPENAI_API_KEY` /
  `SECRET_GOOGLE_API_KEY` — provider keys, read once at boot
- `ZZZ_ENABLE_TEST_ACTIONS` — Register `_testing_*` actions on live
  dispatchers (`true`/`1`/`yes`/`on`/`y`/`enabled` opt in;
  `false`/`0`/`no`/`off`/`n`/`disabled` or unset opt out; case-insensitive;
  blank reads as unset; anything else errors at startup. Integration tests
  only — production must leave unset, and the `zzz` CLI strips it from a
  daemon it starts)
- `ZZZ_TRUSTED_PROXIES` — Comma-separated trusted-proxy entries (IPs and CIDR
  ranges, e.g. `127.0.0.1,10.0.0.0/8,fe80::/10`). Unset/empty → no XFF trust →
  `client_ip` falls back to the TCP peer IP on every request (direct-bind
  behavior). Set when deploying behind nginx / a cloud LB so the trusted-proxy
  middleware walks `X-Forwarded-For` right-to-left and resolves the real
  client IP for rate limiting + `audit_log.ip`. Parsed eagerly at startup —
  invalid entries (malformed IPs, non-aligned CIDRs, out-of-range prefixes)
  fail server boot. Mirrors fuz_app's `http/proxy.ts`.

A blank (empty or whitespace) path var reads as unset — `PUBLIC_ZZZ_DIR` falls
back to `.zzz`, never `/` (`resolve_dir` errors on an empty or unresolvable
path rather than collapsing to `/`). A non-UTF-8 value of any of the server's
string vars fails boot naming the variable (it would otherwise read as unset —
e.g. silently dropping every `PUBLIC_ZZZ_SCOPED_DIRS` entry), as does a dir
that resolves to a non-UTF-8 path.

**The doc-link gate** is the only command that checks doc links: rustdoc
lints fire under `cargo doc` alone, never `build`, `test`, or `clippy`. The
workspace `[workspace.lints.rustdoc]` table denies `broken_intra_doc_links`
(plus `invalid_html_tags`, `bare_urls`, `redundant_explicit_links`), so a
broken link is an `error` and the pass condition is the exit code. The
`private_intra_doc_links` warnings it also prints are by design — module and
item docs deliberately point at private members — so `RUSTDOCFLAGS="-D
warnings"` would fail; rustdoc warns on those links even with
`--document-private-items`, since they'd break in the public-only docs.
`--document-private-items` is still part of the gate: without it rustdoc
never reads the doc comments on private and `pub(crate)` items, so their
links go unchecked. The GitHub check workflow is Node-only (no sibling Rust
spine checkout), so the Rust gates run locally.

`zzz_server`'s own `#[cfg(test)]` unit tests sit beside the code they cover
(the provider modules, `filer.rs`, `pty_manager.rs`, `scoped_fs.rs`, …);
auth, origin, and trusted-proxy pure functions are unit-tested in the spine
crates (`fuz_auth`, `fuz_http`).

## Endpoints

- `/api/rpc` (GET) — JSON-RPC 2.0 (side-effect-free reads, query params)
- `/api/rpc` (POST) — JSON-RPC 2.0 (HTTP transport, auth-gated)
- `/api/account/bootstrap` (POST) — One-shot admin account creation
- `/api/account/signup` (POST) — Public account creation (invite-gated by
  default; `open_signup=true` opens)
- `/api/account/status` (GET) — Current account info or 401 + bootstrap status
- `/api/account/login` (POST) — Username/password login → session cookie
- `/api/account/logout` (POST) — Invalidate session, close WS connections
- `/api/account/password` (POST) — Change password, revoke all sessions/tokens
- `/api/ws` (GET) — JSON-RPC 2.0 (WebSocket, cookie/bearer/daemon)
- `/api/admin/audit/stream` (GET) — Admin-gated audit-log SSE stream (`text/event-stream`)
- `/api/files/bytes?path=` (GET, HEAD) — a file's bytes, with single-range
  `Range` support; served as an allowlisted media type or as a download (see
  ../docs/backend.md § Design Decisions → File byte routes)
- `/api/files/bytes?path=` (POST) — create a file exclusively from the request body
- `/api/files/bytes?path=&offset=` (PATCH) — append the request body if the
  file is exactly `offset` bytes long
- `/health` (GET) — Health check (`{"status":"ok"}`)
- `/*` (GET, HEAD) — the built frontend (if `--static-dir` /
  `ZZZ_STATIC_DIR`), the router's fallback behind every route above.
  `static_files.rs` resolves the exact file (directories never match), then
  the prerendered page (`{path}.html`, or `{path}index.html` for a trailing
  `/`), then the `200.html` SPA shell (`static_files::SPA_FALLBACK_FILE`,
  matching the adapter's `fallback` in `vite.config.ts`) — so
  `/workspaces?workspace=…`, reloads, deep links, and dynamic routes
  (`/chats/<id>`) all load. `/api`, `/health`, and paths below them never get
  the shell (an unknown `/api/foo` is an empty 404), nor does a missing asset
  under `/_app/` or `/fuz_terminal/` (404 — a stale tab's chunk load fails
  instead of executing HTML, and a checkout that never built the terminal
  emulator module answers its fetch honestly); other methods get 405. Media
  types are `ServeDir`'s by extension, so `.wasm` is `application/wasm` (the
  browser compiles the module as it downloads; pinned by a `static_files.rs`
  test). `_app/immutable/` is served `Cache-Control: public, max-age=31536000,
  immutable`, everything else `no-cache`. Both path probes go through
  `ServeDir`, which percent-decodes the path and rejects `..` / root / prefix
  components; the shell is a fixed file (`ServeFile` ignores the request
  path). `ServeDir` follows symlinks inside the static dir, which is trusted
  operator content. A static dir without `200.html` logs a boot warning, and
  non-prerendered routes 404. Without a static dir (dev, where Vite serves the
  frontend) unmatched paths get axum's empty 404

## Auth

zzz is single-operator: every session and every full-scope API token
effectively has the daemon OS user's powers — see
../docs/architecture.md § Security posture.

Cookie sessions (`zzz_session_<port>`, HMAC-signed with
`SECRET_FUZ_COOKIE_KEYS`), bearer API tokens, and bootstrap are spine
behaviors (`fuz_auth` / `fuz_http` / `fuz_realtime`) that `run_app`
composes — `zzz_server` owns none of that code. Per-action auth is checked
from the spec; the Origin, Host, and simple-request gates wrap the whole
router; revocation closes sockets after the transaction commits. The full
pipeline: ../docs/backend.md § Auth.

## Integration Tests

The `cross_backend_*` vitest projects run fuz_app's shared cross-process
suites plus zzz-specific suites against the spawned `testing_zzz_server`
binary over real HTTP + WebSocket, verifying its JSON-RPC / SSE responses
conform to the shared fuz_app contract. The tests live in
`src/test/cross_backend/` (TypeScript, not in the Rust crate).

Each suite file and what it pins: ../docs/backend.md § Integration test
suites.

Supporting files: `global_setup.ts` (vitest globalSetup:
`create_cross_backend_global_setup`, which builds `testing_zzzd` first and
creates each project's database when missing), `zzz_backend_config.ts`
(per-project `BackendConfig` factories and the stated capabilities), and
`raw_request.ts` (a request sent with exactly the headers given — a chosen
`Host`, an upgrade). The over-cap cases send the request head alone through
fuz_app's `raw_http_send_head`, so the cap must refuse on the declared length.

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

The harness builds the test binary (`prepare_cargo_binary`;
`FUZ_TESTING_NO_REBUILD=1` skips it), writes a bootstrap token to a tmpdir,
spawns the built binary (`BackendConfig.start_command`), waits for health,
bootstraps an admin account via `POST /api/account/bootstrap`, then
provides the bootstrapped handle to test files, which read it with
`inject_backend_handle`. SIGTERM on globalSetup teardown leaves no
stranded ports. Each project targets its own real PostgreSQL DB
(`zzz_test_rust` / `zzz_test_rust_proxy`), with its auth-namespace schema
wiped on backend startup (`FUZ_TESTING_RESET_DB_ON_STARTUP`) and
`_testing_reset` clearing it between tests (preserving the keeper row).

A schema-parity snapshot gate exists as a fuz_app capability
(`query_schema_snapshot` + `assert_schema_snapshots_equal`) but isn't wired
into zzz's cross-backend projects.

## Architecture

```
crates/zzz_server/src/
├── lib.rs            # `run_app(RunAppOptions)` — full lifecycle over `fuz_actions::server`: config (command line + env), the spine core (`create_app_backend`: keyring, READ COMMITTED guard, migrations, audit emitter, connection + SSE registries, rate limiters), `ActionRegistry` compile, file watchers, route composition, `serve_until_shutdown` (the auth cleanup beside the server, the 1001 close of every live WebSocket and the end of every audit stream before the drain), then jobs and PTYs torn down
├── main.rs           # Thin production entry — parses the command line, constructs `Argon2idHasher`, calls `run_app`
├── handlers/         # `App` state + the per-domain RPC handlers (spine signature `(Value, ActionContext<'_>, Arc<App>)`, registered into the `ActionRegistry` via `zzz_action_specs::build_*_specs`; `session_load`, `workspace_open`, and `diskfile_read` return a `fuz_actions::ActionOutput` — see Large responses below)
│   ├── mod.rs        # `App` long-lived state (workspaces, `workspace_lifecycle`, `db_pool`, `ScopedFs`, `FilerManager`, `PtyManager`, `JobManager`, `ProviderManager`, `tools`, `realtime`, `action_registry` OnceLock) + the `broadcast` shim over `App.realtime`
│   ├── core.rs       # ping, session_load, _testing_emit_notifications
│   ├── filesystem.rs # diskfile_read, diskfile_update, diskfile_create, diskfile_delete, directory_create
│   ├── job.rs        # job_cancel
│   ├── media.rs      # media_finalize, transcription_create (+ `tool_error`, the `ToolError` → JSON-RPC mapping)
│   ├── provider.rs   # provider_load_status, completion_create
│   ├── terminal.rs   # terminal_create, terminal_data_send, terminal_resize, terminal_ack, terminal_close
│   └── workspace.rs  # workspace_list, workspace_open, workspace_close (+ workspace_changed broadcast)
├── zzz_action_specs/ # Per-domain `ActionSpec` builders consumed by `run_app`'s `ActionRegistry::compile`; each captures `Arc<App>` and calls the matching `handlers::*` fn
│   ├── mod.rs
│   ├── core.rs
│   ├── filesystem.rs
│   ├── job.rs
│   ├── media.rs
│   ├── provider.rs
│   ├── terminal.rs
│   └── workspace.rs
├── job_manager.rs    # Jobs: long-running tool work that outlives its request — in memory, one at a time with a queue, owned by an account, cancellable (dropping the work kills its tool), bounded history; `job_changed` notifications
├── origin_allowlist.rs # `FUZ_ALLOWED_ORIGINS` at boot: parsed by `fuz_http` (a malformed entry refuses the boot), the warning for each wildcard entry
├── media.rs          # Media containers (by extension) and the `ffmpeg` runs over them — confined to file handles zzz opened (`fd:` protocol only, named input format); `remux`, `decode_speech` (16 kHz mono PCM), unnamed scratch files
├── provider/         # AI provider system
│   ├── mod.rs        # ProviderName, ProviderStatus, Provider enum, ProviderManager, CompletionOptions
│   ├── anthropic.rs  # AnthropicProvider — Messages API with SSE streaming
│   ├── common.rs     # shared provider helpers
│   ├── sse.rs        # provider SSE parsing
│   ├── openai.rs     # OpenAiProvider — Chat Completions API with SSE streaming
│   └── gemini.rs     # GeminiProvider — Generative Language API with SSE streaming
├── file_bytes.rs     # Byte routes for files (`/api/files/bytes`): ranged read with a response-header lockdown, exclusive create, offset-checked append — hand-written axum handlers with their own auth + scope gates
├── filer.rs          # Filer + FilerManager (notify crate) — level-triggered file index (events are hints, `lstat` decides), per-directory watches from the filer's own walk (degraded polling past the watch limit), stat-reusing rescans, debounced + coalesced filer_change broadcasts, overflow rescans, symlinks skipped
├── pty_manager.rs    # PTY terminal manager (fuz_pty crate) — one task per terminal (readiness-driven I/O, output paced by client acks, ordered input queue, reaping) → terminal_data/exited notifications; `terminal_env` scrubs the child env
├── root_policy.rs    # Which directories can be roots: strictly inside `$HOME` or in `ZZZ_ROOTS_OUTSIDE_HOME`, never `/`, `$HOME` or an ancestor, or under `/proc` / `/sys` / `/dev` (`RootPolicy`, held by `App` and the boot checks)
├── scoped_fs.rs      # Scoped filesystem — permanent (`zzz_dir` + `scoped_dirs`) + per-workspace roots, path validation, protected directories (credential directories, `.zzz` directories other than the app dir) refused under every root (`protected_dir`), symlink rejection, atomic writes (temp file + fsync + rename), exclusive create, offset-checked append, open-for-read
├── router.rs         # The served router: the surface routers composed by `fuz_http::compose_stack` into capped route groups (rpc, file_bytes, account, health_and_audit, the static fallback), every group behind the host, origin, and simple-request gates; its tests pin each gate on every group
├── static_files.rs   # Built-frontend fallback router: exact file → prerendered `{path}.html` → `200.html` SPA shell; backend paths + missing `_app/` assets 404; cache headers
├── tool.rs           # Local tools run as subprocesses: `resolve_tool` (override env var, else absolute `$PATH` entries — never the working directory), `resolve_model_file`, `Tools` (found at boot), `run_tool` (argument array, handles for stdin/stdout, scrubbed env, cwd `/`, timeout, bounded stderr tail), `run_tool_lines` (the same, handing over output lines as they're written)
├── transcription/    # Speech to timed text by a local model
│   ├── mod.rs        # `TranscriptionBackend` (enum-dispatched seam), the `Transcript` sidecar, `run_transcription` (the job's work: hash → decode → recognize → sidecar)
│   └── whisper_cpp.rs # The whisper.cpp backend: `whisper-cli` arguments, segment / progress / version line parsing, the JSON result → segments and words
└── utf8_stream.rs    # Incremental UTF-8 decoder (split sequences held back, invalid bytes → U+FFFD) shared by provider SSE and PTY output
```

Auth, HTTP / origin / proxy, realtime (WS + SSE), dispatch (`ActionRegistry`
and `perform_action`), and DB pool / migrations all live in the spine crates
(`fuz_auth` / `fuz_http` / `fuz_realtime` / `fuz_actions` / `fuz_db`) —
`zzz_server` composes them in `run_app`. `handlers/` holds `App` state, a
`broadcast` shim over `App.realtime`, and the per-domain handlers; socket
revocation is the spine `RealtimeCloser` over the WS and SSE registries
(../docs/backend.md § Auth, item 10).

**Large responses**: `session_load` and `workspace_open` carry every
indexed file's metadata (never its contents — those come by `diskfile_read`),
so a large tree is a large response, and they skip the `serde_json::Value`
round trip: a snapshot clones the index's nodes, whose contents are shared
`Arc<String>`s (pointers, not text), the handler returns its typed result as a
`fuz_actions::ActionOutput` (registered with `ActionSpec::new_output`, sized
up front from the nodes' paths), and the spine serializes it once, straight
into the response body — so an
HTTP response costs about its own size in memory, and a WebSocket one about
twice that (tungstenite copies each outgoing frame into its write buffer).
Keys come out in struct declaration order rather than the sorted order of a
`Value` rendering — the same JSON, which no client may depend on the key
order of. Responses aren't capped: a workspace of many files is a large
response. `diskfile_read` returns its one file's contents (≤ 4 MiB) the same
way, moved into its typed output rather than copied into a `Value`.

**App + dispatch**: `App` (in `handlers/mod.rs`) holds zzz's long-lived,
non-spine state — `instance_id` (a UUID minted at boot, returned by
`session_load` as `server_instance_id` so clients can tell a restart),
`workspaces` (`RwLock<HashMap>`), `workspace_lifecycle`
(the `tokio::sync::Mutex` serializing `workspace_open` / `workspace_close`),
`db_pool`, `ScopedFs`,
`zzz_dir`, `scoped_dirs`, `FilerManager` (per-watcher ignore config, event
debouncing, in-memory file index, lifetime tracking — permanent for
`zzz_dir`/`scoped_dirs`, workspace-scoped for `workspace_open`),
`PtyManager`, `JobManager`, `ProviderManager`, `tools` (the local tools
found at boot), `completion_options`, `enable_test_actions`,
the spine `realtime: Arc<fuz_realtime::ConnectionRegistry>`, and the
boot-compiled `action_registry: OnceLock<Arc<fuz_actions::ActionRegistry>>`
(OnceLock because the spec builders capture `Arc<App>`). Constructed once
in `run_app`, wrapped in `Arc`. Auth keyring, daemon-token state, audit
emitter, rate limiters, allowed-origins, and trusted-proxy config live on the
spine core (`fuz_actions::server::AppBackend`), whose builders produce the
spine route states
(`fuz_auth::AccountRouteState` / `BootstrapRouteState` / `SignupRouteState`,
`fuz_actions::ActionDispatch` (the RPC router's state, carrying
`notification_sender: Arc<dyn NotificationSender>` for realtime dispatch
fan-out) / `WsRouteState` (which wraps it), and
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
`fuz_auth::AuditEmitter` (the spine core's `audit_emitter`),
shared by the account / bootstrap / signup routers and the RPC dispatch
path. Two listener sets hang off its event chain, the spine's registered by
`create_app_backend` and zzz's by `run_app` once `Arc<App>` exists:

- `fuz_auth::register_revocation_guard` — closes
  matching connections through the bound `RealtimeCloser` (WS sockets and audit
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

**Auth cleanup**: `run_app` schedules the spine's `fuz_auth::spawn_auth_cleanup`
on the same emitter — a pass once the listener is bound, then one per
`DEFAULT_AUTH_CLEANUP_INTERVAL`. Expired sessions are deleted and the
connections they opened closed through the bound `RealtimeCloser` (WS sockets
get the revocation close, audit streams end) — no audit row, so this direct
close is the sweep's only one. It repeats a close already made: every socket
and audit stream closes at its own credential's deadline
(`fuz_auth::ResolvedAuth::credential_deadline`), sweep or no sweep. Each expired
role-grant offer is audited once (`role_grant_offer_expire`, fanned out to the
audit streams like any other row). The task stops on the shutdown token and is
joined after the drain, before PTY teardown.

## Known Issues

../docs/backend.md § Known Issues.

## Known Limitations

- RPC methods: `ping`, `session_load`, `workspace_*`, `diskfile_read`,
  `diskfile_update`, `diskfile_create`, `diskfile_delete`, `directory_create`,
  `media_finalize`,
  `transcription_create`, `job_cancel`, `terminal_*`, `provider_load_status`,
  `completion_create`, `account_verify`, `account_session_list`,
  `account_session_revoke`, `account_session_revoke_all`,
  `account_token_create`, `account_token_list`, `account_token_revoke`,
  `admin_session_revoke_all` (admin-only), `admin_token_revoke_all`
  (admin-only) — plus the rest of the spine-registered `fuz_auth` standard
  bundle and protocol specs (see ../docs/backend.md § Crates)
- zzz-domain `remote_notification` actions: `job_changed` (a job's full state
  on every change) and `transcription_progress` (segments a running
  transcription just decoded), both sent only to the owning account's sockets,
  `workspace_changed` (broadcast on open/close), `filer_change`
  (`FilerManager` with `notify` crate — per-directory watches (see
  ../docs/backend.md § Known Issues → Filer watches), per-path debounced
  broadcasts (80ms quiet, capped at 500ms) with immediate index updates
  (delete+create inside the window becomes `change`, create+delete becomes a
  bare `delete`), every event resolved by `lstat` so late or reordered removes
  can't drop an existing file, rename-aware (old path `delete`, new path
  `add`), metadata only — each `disknode` is `{id, source_dir, size, ctime,
  mtime}`, never contents, which clients read with `diskfile_read`; the
  index still reads and holds each loaded file's text, and any move of the
  text, `size`, or timestamps it holds for a file (a `touch` included) is a
  `change`), ignored paths filtered before the bounded
  event channel with a coalesced root rescan on overflow, per-watcher ignore
  config, in-memory file index returned (as metadata) by `session_load` and
  `workspace_open`, symlinks skipped; ignores
  `.git`/`node_modules`/`.svelte-kit`/`target`/`dist`/`.zzz` and the
  credential directories (`.ssh`/`.gnupg`/`.aws`/`.kube`/`.docker`/
  `.password-store`) by name globally (`.zzz` keeps the CLI daemon home's
  `.env` / `bootstrap_token` out of a root that covers it), `ScopedFs`'s `.zzz-tmp-*` staging files (the walk also deletes
  orphaned ones — exact `.zzz-tmp-<uuid>` names, regular files over an hour
  old), and every non-UTF-8 path, plus `zzz_dir` by its full path for a
  workspace/scoped_dir watcher whose root contains it; startup filers on
  `zzz_dir` and `scoped_dirs`, per-workspace filers with dedup and lifetime
  tracking), `terminal_data` (PTY output) and `terminal_exited` (process
  exit), both sent only to the owning account's sockets, `completion_progress`
  (streaming completion chunks to requesting WS connection); the spine's
  role-grant-offer bundle carries its own notification set
  (`role_grant_offer_received` / `_retracted` / `_accepted` / `_declined` /
  `_supersede`)
- AI providers: Anthropic, OpenAI, and Gemini all fully implemented (non-streaming + SSE streaming)
- No batch request support (JSON arrays)
- `/api/account/signup` is mounted via `fuz_auth::signup_routes`. Invite-gated
  by default (`app_settings.open_signup=false`); admins flip the setting via
  `app_settings_update` to enable open signup. `app_settings` is loaded from
  the DB per signup request (no cache).
- Token management is JSON-RPC only (`account_token_create` /
  `account_token_list` / `account_token_revoke`) — no REST token routes
- Admin audit-log SSE broadcast is live at `GET /api/admin/audit/stream` — the
  shared `fuz_realtime::audit_stream_router`, wired to the spine
  `AuditEmitter` via `fuz_realtime::register_audit_sse_listener`, which only
  broadcasts. Wire shape matches fuz_app's `audit_log_sse`; the
  `sse.cross.test.ts` suite verifies it. Close-on-revoke is the one revocation
  guard's, closing through the `RealtimeCloser` fan-out, so it reaches these
  streams too: it dispatches on the `RevocationScope` each event declares in
  `fuz_auth`'s `AUDIT_EVENT_SPECS` — `session_revoke` (session-hash-scoped) /
  `token_revoke` (token-scoped) / `session_revoke_all` / `token_revoke_all` /
  `password_change` / `logout` / `account_delete` / `account_purge`
  (account-wide) / `role_grant_revoke` (role-matched, global grants only). The
  route itself is session-only (`AuditStreamRouteState::credential_gate`), so
  a bearer never opens a stream here in the first place. A session holds at
  most `AUDIT_LOG_SSE_MAX_PER_SCOPE` (10) streams — one more ends its oldest —
  and a stream registers pending once its gates pass, with the credential,
  acting actor, and role re-read before it is admitted
  (`fuz_auth::recheck_admission` — a credential or actor revoked meanwhile
  gets a 401, a role a 403, or a stream that ends right after its connect
  comment, never a live one)
- Login/password rate limiting is **always on** (matching `fuz_forge_server`
  and the other spine servers, and the fuz defaults): per-IP (5 attempts / 15
  min) + per-account (10 / 30 min) sliding windows fire on `/login` and
  `/password`; 429 carries `{error: 'rate_limit_exceeded', retry_after}` plus
  a `Retry-After` header. Per-IP key is the resolved client IP from
  `fuz_http::client_ip_middleware` — set `ZZZ_TRUSTED_PROXIES` when running
  behind a reverse proxy so the bucket keys on the originating client rather
  than the proxy. The `testing_zzz_server` binary disables it via
  `SpineBackendOptions::rate_limiters: RateLimiterMode::DisabledForTesting` so
  the cross-backend auth suite's repeated logins don't trip the bucket; a
  process that nulls any limiter prints a startup banner saying so
- One JSON-RPC message is capped at `zzz_server::RPC_MESSAGE_MAX_BYTES` (16
  MiB) on both transports: the `/api/rpc` request body (the `rpc` stack
  group's `BodyCap::Bytes`, which mounts `fuz_http`'s JSON-413 body-limit
  layer plus axum's `DefaultBodyLimit` at the same size — the handler's
  `Bytes` extractor would otherwise stop at axum's 2 MiB default) and each
  `/api/ws` inbound message and frame (`max_message_bytes` of the
  `fuz_actions::ActionWsOptions` passed to `register_action_ws_with_options`;
  the spine default is 1 MiB, tungstenite's own 64 MiB / 16 MiB). It's above
  the spine's 1 MiB so saving a file the filer loads (≤ 4 MiB) fits — except
  in the worst case, where JSON's 6-byte escape of each control character
  pushes a file dense with them past the cap and the client guard refuses the
  save cleanly — and so long completion histories fit. **The larger buffer
  isn't confined to authenticated callers on HTTP**:
  `fuz_actions::rpc_post_handler` buffers and parses the body before auth, and
  `ping` is public, so any local process can make zzzd hold up to 16 MiB per
  concurrent request. On the WebSocket (authenticated at upgrade) up to 128
  dispatches can be in flight per socket, a ceiling of about 2 GiB of buffered
  messages per authenticated socket. Both are acceptable only because the bind
  is loopback-only and zzz is single-operator (../docs/architecture.md §
  Security posture). The account/bootstrap/signup routers, `/health`, the
  audit stream, and the fallback keep `fuz_http::DEFAULT_BODY_LIMIT_BYTES` (1
  MiB). An oversized WebSocket message gets no error reply — the read fails
  and the socket closes (code 1006), taking its in-flight requests with it —
  so the frontend `Socket` refuses any request over the cap before sending
  (`RPC_MESSAGE_MAX_BYTES` in `src/lib/rpc_message_limit.ts`, pinned to the
  Rust constant by the cross-backend filesystem suite). Larger and binary
  content goes over the file byte routes instead (../docs/backend.md § Design
  Decisions → File byte routes), a chunk of at most the same size per request.
  The static fallback takes no body
- Each WebSocket connection's outbound queue — the frames queued for a socket
  that its writer hasn't taken yet — has a byte budget of
  `zzz_server::WS_OUTBOUND_QUEUE_BYTES` (32 MiB, `outbound_queue_bytes` of the
  same `ActionWsOptions`; the spine default is 4 MiB, and it doesn't follow
  the message cap). Each waiting frame is charged its UTF-8 length plus
  `fuz_realtime::OUTBOUND_FRAME_OVERHEAD_BYTES`, a frame is always queued into
  an empty queue, and one that doesn't fit closes that socket with
  `fuz_realtime::WS_CLOSE_OUTBOUND_OVERFLOW` (4005), its backlog discarded —
  the frontend reconnects and reloads `session_load`. Every frame zzz pushes
  is small — a `filer_change` carries a file's metadata, not its text — so
  the budget is how far a burst can get ahead of a client: a change across a
  tree queues one `filer_change` per file. Requests' responses are written by
  the connection's loop and never queue. **The budget bounds a burst, it doesn't
  absorb one of any size**: a sender never waits for a socket, so anything
  that produces faster than a client takes for longer than the budget holds
  closes that client's socket. The filer's flush (`filer::flush_ready`) yields
  to the runtime after each broadcast, so each connection's writer gets a turn
  to take a frame before the next is queued and a batch isn't queued whole —
  it is a turn, not backpressure: a client that takes the batch slower than
  the filer serializes it still falls behind, and is closed once more than the
  budget is waiting; terminal output is paced by
  acks instead (see ../docs/backend.md § Design Decisions → PTY terminals →
  Output pacing): a terminal stops reading its PTY once 1 MiB of its output is
  unacknowledged by its fastest acking connection, so it holds about that much
  in such a socket's queue; a connection that never acks isn't paced, and more
  than the budget of output it hasn't taken closes it (the terminal keeps
  running; the reconnect flags the output gap). **Memory**: a client that
  stops reading holds at most the budget plus the one frame its writer has
  taken per socket, until that write passes
  `fuz_realtime::WS_WRITE_STALL_TIMEOUT` or the next frame overflows; a
  broadcast's text is one buffer shared by every recipient. Acceptable for the
  same reason as the message cap: authenticated sockets only, on a loopback
  bind

## Design Decisions

../docs/backend.md § Design Decisions — DB, Credentials, Strict inputs,
Filesystem errors, Atomic writes, File byte routes, Local tools, `ffmpeg`
never gets a path, `media_finalize`, Jobs, Transcription, Dispatch is async,
`parking_lot::RwLock`, PTY terminals, Provider system, Dispatcher transaction
wrap.

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

- [x] Provider system: enum-dispatched `Provider` with `ProviderManager`,
  `ProviderStatus`, `CompletionOptions`
- [x] Anthropic provider: full implementation with `reqwest` HTTP client, SSE
  streaming, message format conversion
- [x] `provider_load_status` handler (all 3 providers report status)
- [x] `completion_create` handler with `completion_progress` streaming
  notifications (targeted to requesting WS connection)
- [x] `session_load` returns real provider status from all providers
- [x] OpenAI provider: full completion implementation (Chat Completions API,
  non-streaming + SSE streaming)
- [x] Gemini provider: full completion implementation (Generative Language
  API, non-streaming + SSE streaming)

**Other remaining work**:

1. Codegen from the TS specs (action input/output types)

- [x] Trusted-proxy client-IP resolution (XFF + CIDR + strict-IP
      validation), Origin allowlist (Origin-only, no Referer fallback), and
      login-username canonicalization — all now provided by the spine
      (`fuz_http` proxy/origin + `fuz_auth`); zzz wires them via config
      (`ZZZ_TRUSTED_PROXIES`, `FUZ_ALLOWED_ORIGINS`).
