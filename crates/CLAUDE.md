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
  `_testing_reset`, `_testing_drain_effects`, `_testing_db_invariants`, and
  `_testing_action_manifest`, default port 4462. **Never ships in a
  release** (`fuz_release`'s `testing_` filter and `cargo xtask
  check-release`).
- `xtask/` — `cargo xtask dev`, `dev-setup` / `prod-setup`, `install`, `check-release`,
  `ghostty-vt`; pure `std` + `fuz_audit`, marked `dev_only`.
- `zzz/` — the CLI: `cli/` (argument parsing, and a module per command in
  `cli/commands/` — `open`, `daemon`, `init`, `status`, `version`),
  `daemon_launch.rs`, `opener.rs`, `daemon_lifecycle.rs`, `procfs.rs`,
  `env_file.rs`, `error.rs`; its rules are ../docs/development.md § The
  `zzz` CLI.

The spine crates (`fuz_db`, `fuz_auth`, `fuz_http`, `fuz_realtime`,
`fuz_actions`) own auth, HTTP, realtime, the DB pool and migrations, and
the boot-compiled `ActionRegistry`. One `/api/rpc` + `/api/ws`
(`fuz_actions::create_rpc_router` / `register_action_ws`) serves all
dispatch:

- **zzz's specs** come from `zzz_action_specs/` (project, filesystem,
  media, job, terminal, provider), their handlers in `handlers/`, which
  also holds `App` state and a `broadcast` shim over `App.realtime`.
- **fuz_auth's standard bundle** comes from fuz_actions'
  `auth_adapter::build_auth_spec_set`: account self-service, admin
  revocation and management, `app_settings_*`, and the `role_grant_*` /
  `role_grant_offer_*` flow with its notifications — live though zzz ships
  no UI for most of it; the spine crates are its source of truth.
- **Protocol specs**: `fuz_actions::PROTOCOL_ACTION_SPECS` (`heartbeat`,
  `peer/ping`; `cancel` is a client notification the WS read loop handles,
  not a spec).
- `_testing_emit_notifications` registers only under
  `ZZZ_ENABLE_TEST_ACTIONS=1` (the integration runner sets it; elsewhere
  dispatch answers `method_not_found`).

Outside the registry: the admin audit-log SSE stream
(`fuz_realtime::audit_stream_router`) and zzz's file byte routes
(`file_bytes.rs`).

RPC methods zzz exposes and uses: `ping`, `session_load`, `project_*`,
`repo_focus`, `repo_unfocus`, `repo_files`, `diskfile_*`,
`directory_create`, `media_finalize`, `transcription_create`,
`job_cancel`, `terminal_*`, `provider_load_status`, `completion_create`,
`account_verify`, `account_session_list`, `account_session_revoke`,
`account_session_revoke_all`, `account_token_create`,
`account_token_list`, `account_token_revoke`, `admin_session_revoke_all`,
`admin_token_revoke_all`.

Underneath: PostgreSQL via `tokio-postgres` / `deadpool-postgres`; local
tools (`ffmpeg`, whisper.cpp) as subprocesses behind an in-memory job
queue; file watching with `notify`; the providers over `reqwest` with
manual SSE parsing.

## Prerequisites

The sibling [fuz](https://github.com/fuzdev/fuz) and
[fuz_repos](https://github.com/fuzdev/fuz_repos) workspaces must be checked
out alongside this repo:

```
~/dev/zzz/                  (this repo)
~/dev/fuz/                  (path deps: fuz_sys, fuz_pty, the spine crates — fuz_db, fuz_auth, fuz_http, fuz_realtime, fuz_actions — plus fuz_testing for the test binary and fuz_audit for xtask)
~/dev/fuz_repos/            (path deps: fuz_repos for registry discovery, parsing, and repo status, fuz_git, its git runner)
```

If a path dep is missing, `cargo build` will fail with
`failed to read .../crates/{crate}/Cargo.toml`.

**PostgreSQL** is required. Create the development and manual-test databases
(the cross-backend projects' `zzz_test_rust` / `zzz_test_rust_proxy` /
`zzz_test_rust_projects` are
created by their global setup when missing):

```bash
createdb zzz_dev             # development (`cargo xtask dev`)
createdb zzz                 # the `zzz` CLI's daemon
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
DATABASE_URL=postgres://localhost/zzz_dev \
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
- `PUBLIC_ZZZ_SCOPED_DIRS` — Comma-separated filesystem paths (`zzzd`
  doesn't expand `~`; the `zzz` CLI does); an entry the root rules refuse (`root_policy.rs`: strictly
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
  that roots may be at or inside (`zzzd` doesn't expand `~`; the `zzz` CLI does; parsed like
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

**The request-reads census**: the workspace `clippy.toml` disallows axum's
lenient request readers (`Path`, `RawPathParams`, `Query`, `Form`) and
`form_urlencoded::parse` / `Url::query_pairs`, as the spine's own does — a
handler reads its query through `fuz_http::read_query_pairs` over `RawQuery`
and its path params through `fuz_http::RouteParams`.
`zzz_server/tests/request_reads_census.rs` runs the spine's shared census
(`fuz_testing::request_reads_census`) over this workspace — every
`clippy.toml` carries those entries (a crate-level one replaces the root
file), every in-source suppression of the disallow lints is listed — and
holds the axum types' positive controls.

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
(the provider modules, `filer/`, `pty_manager.rs`, `scoped_fs.rs`, …);
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
- `/api/account/logout` (POST) — Invalidate session, close its WS connections
- `/api/account/password` (POST) — Change password, revoke all sessions/tokens
- `/api/ws` (GET) — JSON-RPC 2.0 (WebSocket, cookie/bearer/daemon)
- `/api/admin/audit/stream` (GET) — Admin-gated audit-log SSE stream (`text/event-stream`)
- `/api/files/bytes?path=` (GET, HEAD) — a file's bytes, with single-range
  `Range` support; served as an allowlisted media type or as a download (see
  ../docs/backend.md § Design Decisions → File byte routes)
- `/api/files/bytes?path=` (POST) — create a file exclusively from the request body
- `/api/files/bytes?path=&offset=` (PATCH) — append the request body if the
  file is exactly `offset` bytes long. On every method the query is read
  strictly (`fuz_http::read_query_pairs`): an escape that doesn't decode is
  `400 invalid_query_params`, never a path with U+FFFD in it
- `/health` (GET) — Health check (`{"status":"ok"}`)
- `/*` (GET, HEAD) — the built frontend (if `--static-dir` /
  `ZZZ_STATIC_DIR`), the router's fallback behind every route above.
  `static_files.rs` resolves the exact file (directories never match), then
  the prerendered page (`{path}.html`, or `{path}index.html` for a trailing
  `/`), then the `200.html` SPA shell (`static_files::SPA_FALLBACK_FILE`,
  matching the adapter's `fallback` in `vite.config.ts`) — so
  `/projects?open=…`, reloads, deep links, and dynamic routes
  (`/chats/<id>`) all load. `/api`, `/health`, and paths below them never get
  the shell (an unknown `/api/foo` is the spine's JSON `route_not_found`
  404, an unknown `/health/x` its plain-text one —
  `fuz_actions::server::unmatched_route_response`), nor does a missing asset
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
  frontend) unmatched paths get the spine's unmatched-route 404

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
npm run test:cross                                                        # Every rust project (rust, rust_proxy, rust_projects) — flag baked in
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust       # Single project (Rust binary; postgres://localhost/zzz_test_rust)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust_proxy # Single project (proxy variant; ZZZ_TRUSTED_PROXIES=127.0.0.1, proxy.cross.test.ts only)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust_projects # Single project (a fixture HOME for registries; project_registry.cross.test.ts only)
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
(`zzz_test_rust` / `zzz_test_rust_proxy` / `zzz_test_rust_projects`), with its auth-namespace schema
wiped on backend startup (`FUZ_TESTING_RESET_DB_ON_STARTUP`) and
`_testing_reset` clearing it between tests (preserving the keeper row).

A schema-parity snapshot gate exists as a fuz_app capability
(`query_schema_snapshot` + `assert_schema_snapshots_equal`) but isn't wired
into zzz's cross-backend projects.

## Architecture

```
crates/zzz_server/src/
├── lib.rs            # `run_app(RunAppOptions)` — full lifecycle over `fuz_actions::server`: config (command line + env), the spine core (`create_app_backend`: keyring, READ COMMITTED guard, migrations, audit emitter, connection + SSE registries, rate limiters), `ActionRegistry` compile, file watchers, route composition, `serve_until_shutdown` (the auth cleanup beside the server; at shutdown, within one drain timeout, the 1001 close of every live WebSocket and the end of every audit stream, the request drain, the cleanup join, the audit-write drain), then jobs and PTYs torn down
├── main.rs           # Thin production entry — parses the command line, constructs `Argon2idHasher`, calls `run_app`
├── git.rs            # The daemon's git: the runner's allowlisted environment (`git_env`: `PATH`, `HOME`, `XDG_CONFIG_HOME`), `daemon_git`, and the boot check (`check_git` → `GitUsability`, held as `App.git_usability`)
├── handlers/         # `App` state + the per-domain RPC handlers (spine signature `(Value, ActionContext<'_>, Arc<App>)`, registered into the `ActionRegistry` via `zzz_action_specs::build_*_specs`; `session_load`, `project_open`, `repo_focus`, `repo_files`, and `diskfile_read` return a `fuz_actions::ActionOutput` — see Large responses below)
│   ├── mod.rs        # `App` long-lived state (`ProjectManager`, `repo_status`, `trusted_owner`, `git`, `git_usability`, `db_pool`, `ScopedFs`, `FilerManager`, `PtyManager`, `JobManager`, `ProviderManager`, `tools`, `realtime`, `action_registry` OnceLock) + the `broadcast` shim over `App.realtime`
│   ├── core.rs       # ping, session_load, _testing_emit_notifications
│   ├── filesystem.rs # diskfile_read (+ its bounded text read, `read_text_contents`, and the bytes' `hash`), diskfile_update (+ its `expected_hash` compare-and-swap), diskfile_create, diskfile_delete, diskfile_rename (+ its sidecars, under the job table's lock), directory_create
│   ├── job.rs        # job_cancel
│   ├── media.rs      # media_finalize, transcription_create (+ `tool_error`, the `ToolError` → JSON-RPC mapping)
│   ├── project.rs    # project_list, project_open, project_close, repo_focus, repo_unfocus, repo_files, project_status: the resolve and what an open focuses, each change handed to `ProjectManager`, its refusals mapped to the wire (`lifecycle_error`, and per requested focus of an open `focus_refusal_reason`)
│   ├── provider.rs   # provider_load_status, completion_create
│   └── terminal.rs   # terminal_create, terminal_data_send, terminal_resize, terminal_ack, terminal_close
├── zzz_action_specs/ # Per-domain `ActionSpec` builders consumed by `run_app`'s `ActionRegistry::compile`; each captures `Arc<App>` and calls the matching `handlers::*` fn
│   ├── mod.rs
│   ├── core.rs
│   ├── filesystem.rs
│   ├── job.rs
│   ├── media.rs
│   ├── project.rs
│   ├── provider.rs
│   └── terminal.rs
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
├── file_trust.rs     # Whether discovered config is the daemon user's alone to write — Debian sshd's rule: owned by the user or root, never `o+w`, `g+w` only by the user's private group (`TrustedOwner`, NSS read once by `current`)
├── filer/            # File index + watcher (notify crate) — stat-only and level-triggered (events are hints, `lstat` decides), debounced `filer_change` broadcasts, a whole tree or a registry root's top level (`FilerDepth`), git's ignore rule under a checkout root (../docs/projects.md § Filer)
│   ├── mod.rs        # Module docs (the filer's design), re-exports of the public API, the indexing limits (`REPRUNE_BROADCAST_MAX`, the flood guard; `IGNORED_REFRESH_INTERVAL`), the `filer_change` notification params, `SerializableDisknode`, `IgnoredPaths` (a focused dir's `ignored` entry: git's paths and the nested repos), `WatchStatus`, and the dir-prefix helpers
│   ├── core.rs       # `Filer` (the running handle, its ignored set as the wire carries it: `ignored_on_wire`), `FilerConfig`, `FilerDepth`, `start_filer`, the notify callback's `watcher_factory`, `RescanSignal`, the `FilerIgnoredChange` hook and its coalescing publisher (`publish_ignored_changes`)
│   ├── index.rs      # The index's file metadata: `FileStat` and its racily-clean rule (`reusable_stat`, `is_unchanged`), disknodes, and `apply_subtree`, the diff of a scanned subtree
│   ├── watches.rs    # `DirWatches` (the per-directory watch bookkeeping, degraded mode) and `classify_event`
│   ├── ignore.rs     # What a filer ignores (`IgnoreRule`: fixed names, or git's `IgnoredSet` under a checkout root; `ALWAYS_IGNORED_DIRS`, `PLAIN_DIR_IGNORED_DIRS`, `is_ignored`), the shared rule (`SharedRule`, with the nested repos the walks found), the git calls (`GitRoot`: prune, check, re-confine), nested repos, the `.git/info/` dir the filer's watcher watches
│   ├── walk.rs       # The blocking `walk_blocking` + `scan_directory`/`scan_file` (pruned by the rule, nested repos skipped under git and reported, `DirScan`), the orphaned-staging-file sweep
│   ├── event_loop.rs # `FilerState` + `filer_event_loop`: events resolved against the disk, a git root's burst vetting and re-prunes (a big one on the wire resynced rather than broadcast, `queue_or_resync`), the ignored-set signal, the debounce / coalesce, `flush_ready`, `filer_change_notification`
│   ├── git_rule_tests.rs # `#[cfg(test)]` tests of a git root's rule live: a listing racing its walk (a `HookedGit` acting between git's answer and the walk), re-prunes and their failures, the `info/exclude` watch, vetting
│   ├── snapshot.rs   # `SnapshotFiles`: a snapshot reply's files on the wire, grouped by filer dir as `[rel, size, mtime, ctime?]` tuples, and its size hint
│   ├── manager.rs    # `FilerManager`: lifetimes (permanent / project), depths, dedup of concurrent starts, snapshots, `hold_index`, a `#[cfg(test)]` seam that holds an index for writing (`project_manager`'s tests use it); each `filer_change` broadcast hints the repo status (`RepoStatusManager::hint`)
│   └── test_support.rs # `#[cfg(test)]` helpers shared across the filer's test modules (`TempDir`, scan and state builders, checkouts, `HookedGit`)
├── project_manager.rs # The open projects and the one path that changes them (`ProjectManager`): open, close, focus, and unfocus each compute the next state and `commit` it under the state's lock — the filers it needs, the `ScopedFs` roots, the published snapshot, `project_changed`, and the lifecycle rev (../docs/projects.md § Projects)
├── project.rs        # Resolving an opened path to its project: a trusted `repos.toml` registry, else the nearest `.git`, else the directory, with the fallbacks and refusals (`resolve_project`, `Fallback`, `ProjectError` / `EntryRefusal`; ../docs/projects.md § Projects)
├── pty_manager.rs    # PTY terminal manager (fuz_pty crate) — one task per terminal (readiness-driven I/O, output paced by client acks, ordered input queue, reaping) → terminal_data/exited notifications; `terminal_env` scrubs the child env
├── repo_status.rs    # Tier-1 git status of open registries' entries (`RepoStatusManager`, `App.repo_status`): `project_status` polls never wait on git — each present entry's `.git` stat stamp (`stat_stamp`), filer edit hints (`hint`, from each filer's broadcast), and a slow sweep pick the stale ones, probed by `fuz_repos::status::status` (no fetch, no busy detection) on a small pool; the narrow wire projection (`RepoStatusInfo`)
├── root_policy.rs    # Which directories can be roots: strictly inside `$HOME` or in `ZZZ_ROOTS_OUTSIDE_HOME`, never `/`, `$HOME` or an ancestor, or under `/proc` / `/sys` / `/dev` (`RootPolicy`, held by `App` and the boot checks)
├── scoped_fs.rs      # Scoped filesystem — permanent (`zzz_dir` + `scoped_dirs`) + per-project roots, path validation, protected directories (credential directories, `.zzz` directories other than the app dir) refused under every root (`protected_dir`), symlink rejection, atomic writes (temp file + fsync + rename) with an optional compare-and-swap on the file's BLAKE3 (`ExpectedContent`, `disk_changed`), exclusive create, offset-checked append, open-for-read
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

**Large responses**: `session_load`, `project_open`, `repo_focus`, and
`repo_files` carry indexed files' metadata — every indexed file's, or a
focused repo's for the last two — never their contents (those come by
`diskfile_read`), so a large tree is a large response, and they skip the `serde_json::Value`
round trip: a snapshot clones the index's nodes (metadata only — the index
holds no file text), the handler returns its typed result as a
`fuz_actions::ActionOutput` (registered with `ActionSpec::new_output`, sized
up front from the nodes' paths), and the spine serializes it once, straight
into the response body. The files go out as `filer::SnapshotFiles`: one
`{dir, files}` group per filer dir, each file `[rel, size, mtime, ctime?]`
relative to `dir`, `ctime` left off when it equals `mtime` — about half the
bytes of the disknode objects `filer_change` still sends; timestamps are
whole milliseconds since the epoch (../docs/backend.md § Design Decisions →
Large responses). An HTTP response costs about its own size in memory, and a
WebSocket one about twice that (tungstenite copies each outgoing frame into its write buffer).
Keys come out in struct declaration order rather than the sorted order of a
`Value` rendering — the same JSON, which no client may depend on the key
order of. Responses aren't capped: a project of many indexed files is a large
response. `diskfile_read` returns its one file's contents (≤ 4 MiB) the same
way, moved into its typed output rather than copied into a `Value`.

**App + dispatch**: `App` (in `handlers/mod.rs`) holds zzz's long-lived,
non-spine state — `instance_id` (a UUID minted at boot, returned by
`session_load` as `server_instance_id` so clients can tell a restart),
`projects` (the `ProjectManager`: the open projects behind the
`tokio::sync::Mutex` every `project_open` / `project_close` / `repo_focus`
/ `repo_unfocus` commits under, and the snapshot readers take without it),
`repo_status` (the open registries' entry statuses, `RepoStatusManager`),
`trusted_owner` (whose registries are trusted — `TrustedOwner::current`,
read once at boot), `git` (the daemon's git runner over an allowlisted
environment, `git::git_env`), `git_usability` (whether git is usable,
checked once at boot before any filer starts — `git::check_git`),
`db_pool`, `ScopedFs`,
`zzz_dir`, `scoped_dirs`, `FilerManager` (per-watcher ignore config, event
debouncing, in-memory file index, lifetime tracking — permanent for
`zzz_dir`/`scoped_dirs`, project-scoped for `project_open`, stopped once no
open project keeps them, and a depth — a whole tree, or a registry root's
top level alone),
`PtyManager`, `JobManager`, `ProviderManager`, `tools` (the local tools
found at boot), `completion_options`, `enable_test_actions`,
`root_policy` (which directories can be roots, `RootPolicy`),
`audit_emitter` (the spine emitter, held so the test binary's specs factory
can reach it), the spine `realtime: Arc<fuz_realtime::ConnectionRegistry>`,
and the boot-compiled `action_registry: OnceLock<Arc<fuz_actions::ActionRegistry>>`
(OnceLock because the spec builders capture `Arc<App>`). Constructed once
in `run_app`, wrapped in `Arc`. Auth keyring, daemon-token state, rate
limiters, allowed-origins, and trusted-proxy config live on the
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

- RPC methods: the list in the intro above (../docs/backend.md § Crates for
  the spine's full bundle).
- zzz-domain `remote_notification` actions: `job_changed` and
  `transcription_progress`, `terminal_data` and `terminal_exited` (each to
  the owning account's sockets), `completion_progress` (to the requesting
  connection), `project_changed` (broadcast on open, update — a focus added
  or dropped, or its ignored set changed — and close), and `filer_change`
  (broadcast; metadata only — the filer's watches, debounce, stamp rule,
  and ignore rules are ../docs/projects.md § Filer and
  ../docs/backend.md § Known Issues → Filer watches / Filer ignore rule).
  The spine's role-grant-offer bundle carries its own notification set.
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
  broadcasts. Wire shape matches fuz_app's `audit_log_sse`; fuz_app's
  SSE suite (run by `spine_suites.cross.test.ts`) verifies it. Close-on-revoke is the one revocation
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
  the spine's 1 MiB so saving a file `diskfile_read` loads (≤ 4 MiB) fits — except
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
  closes that client's socket. The filer's flush (`filer::event_loop::flush_ready`) yields
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
- `/api/ws` closes a socket that sends nothing for `WS_RECEIVE_TIMEOUT`
  (20 min, close 4003) — twice the longest heartbeat interval the frontend
  allows (`HEARTBEAT_INTERVAL_BOUNDS.max` in `src/lib/socket_helpers.ts`);
  the spine's 60 s default would drop a client whose interval was raised
  past 30 s

## Design Decisions

../docs/backend.md § Design Decisions — DB, Credentials, Large responses,
Strict inputs, Filesystem errors, Atomic writes, Text reads, File byte
routes, Local tools, `ffmpeg` never gets a path, `media_finalize`, Jobs,
Transcription, Dispatch is async, The lifecycle rev, Ignored paths in the
commit, `parking_lot::RwLock`, PTY terminals, Provider system, Dispatcher
transaction wrap.

## What's Next

- Codegen from the TS specs (the action input/output types), so the Rust
  handlers' wire types can't drift from `action_specs.ts` — today the
  cross-backend `spec_schemas` and `action_manifest` suites catch drift
  after the fact.
