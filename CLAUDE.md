# zzz

> nice web things for the tired

`@fuzdev/zzz` — local-first AI forge: chat + files + prompts + terminals in one app.
SvelteKit frontend (static SPA), Rust (Axum) backend, Svelte 5 runes, Zod schemas.
v0.0.1. fuz_app auth stack (sessions, bearer tokens, bootstrap), PostgreSQL DB. Cell + Action patterns (generated roster in ./docs/reference.md), 3 AI providers.

zzz has a single **Rust** backend: `crates/zzz_server` (Axum). The frontend
is a prerendered static SPA served by `zzz_server` — no JS runtime in
production. adapter-static prerenders the fixed routes (`chats.html`, …) and
writes a `200.html` SPA shell; `zzzd --static-dir` serves the exact file, then
the prerendered `{path}.html`, then the shell, so deep links and dynamic routes
(`/chats/<id>`) load. See `static_files.rs` in ./crates/CLAUDE.md.

The about and docs routes are public: they render (and prerender) without a
session or a backend, so a static-only build still shows them. Every other
route sits behind the root layout's auth gate (`src/lib/auth_gate.ts`) — a
bootstrap or login form, or, when no zzz backend answers `/health`, a page
saying the route needs the zzz daemon. A login or bootstrap returns to the page
it replaced (path, query, and hash).

For coding conventions, see Skill(fuz-stack).

## What zzz Does

1. **Chat** with AI models — multi-thread, multi-model comparison, streaming responses
2. **Edit files** on disk — scoped filesystem, syntax highlighting, multi-tab editor
3. **Build prompts** — reusable content templates composed from text parts and file references
4. **Manage models** — Claude/ChatGPT/Gemini via BYOK API keys
5. **Run terminals** — interactive PTY terminals via xterm.js with preset commands, contextmenu copy, and restart
6. **Record and transcribe audio** — the microphone to a file on disk, uploaded as it's recorded, with pause and resume; transcribed by a speech model on this machine (whisper.cpp), with the transcript read against the audio
7. **Symmetric actions** — JSON-RPC 2.0 between frontend and backend, same ActionPeer on both sides

## Key Principles

- **Local-first**: your data stays on your machine, no third-party lock-in; providers are opt-in BYOK
- **Schema-driven**: Every Cell and Action defined by Zod schemas, validated at boundaries
- **Symmetric actions**: Frontend and backend are peers — same ActionPeer code, same spec format
- **Cell pattern**: All state is Cell subclasses with `$state`/`$derived` runes, JSON-serializable

## Development Stage

Early development, v0.0.1. Breaking changes are expected and welcome. fuz_app auth stack on both RPC and WebSocket endpoints (cookie sessions, bearer tokens, bootstrap flow; daemon tokens in the test binary only); WebSocket upgrade requires authentication with event-driven session revocation. PostgreSQL DB for auth; domain state (files, terminals, workspaces, jobs) is in-memory.

The Rust backend (`crates/zzz_server`, Axum) provides the full auth stack, filesystem, terminals, PostgreSQL, bootstrap, AI providers with SSE streaming, audit emission with listener fan-out, trusted-proxy `client_ip` resolution, login rate limiting (always on; disabled in the test binary), Origin allowlist on every REST + RPC + WS handler. Auth, HTTP, realtime (WS + SSE), dispatch, and DB all come from the spine crates (`fuz_db`, `fuz_auth`, `fuz_http`, `fuz_realtime`, `fuz_actions`); a single `/api/rpc` + `/api/ws` serves the boot-compiled `fuz_actions::ActionRegistry`, with the zzz-specific handlers (workspace, filesystem, media, job, terminal, provider, `completion_create`) in `handlers/`, the admin audit-log SSE stream at `GET /api/admin/audit/stream`, and the file byte routes at `/api/files/bytes` (hand-written, outside the registry — see File bytes). It runs `ffmpeg` and whisper.cpp as subprocesses for media work and holds jobs in memory. AI providers are Anthropic, OpenAI, and Gemini, all with non-streaming and SSE streaming completions. Refused, blocked, or filtered replies fail with the provider's reason, and truncated replies are marked on the turn (./docs/providers.md § Stop Reasons).

The `cross_backend_*` vitest projects (gated behind `FUZ_TEST_CROSS_BACKEND=1`) are the Rust backend's integration tests — they run fuz_app's standard suites against `zzz_server` over real HTTP, verifying wire-shape conformance to the shared fuz_app contract. (A schema-parity snapshot gate exists as a fuz_app capability — `query_schema_snapshot` + `assert_schema_snapshots_equal` — but is not currently wired into zzz's cross-backend projects.) Long-term the CLI and daemon migrate to Rust fuz/fuzd.

See [GitHub issues](https://github.com/fuzdev/zzz/issues) for planned work.

## CLI

zzz has a Rust CLI (`crates/zzz`, argh) for daemon management and opening
the UI. See ./crates/CLAUDE.md for the crate layout.

```bash
zzz                          # start daemon if needed, open zzz (the browser, or a configured opener)
zzz ~/dev/                   # open workspace at ~/dev/ (a file opens its directory)
zzz daemon start             # start daemon (foreground)
zzz daemon stop              # stop the recorded daemon
zzz daemon status            # show daemon info (exit 0 running, 1 not responding, 3 not running, 4 unknown)
zzz init                     # initialize ~/.zzz/
```

The global daemon runs on port 4460 with `~/.zzz/` as its home and working
directory. `zzz init` creates it (mode `0700`) with `config.json` (the port),
`.env` (the daemon's environment, mode `0600`, with a generated cookie key),
`bootstrap_token` (the one-shot admin token), and the app directory `.zzz/`
(so `~/.zzz/.zzz/`) — never overwriting an existing file. The daemon deletes
the token once the first admin exists; a later `zzz init` recreates it when
missing (say the database was dropped), and a running daemon picks it up on
restart, since it checks bootstrap availability once at boot. The CLI spawns
and discovers the `zzzd` daemon binary (the `[[bin]]` target of the
`zzz_server` crate) — `ZZZ_SERVER_BIN` (a relative value resolves against
the directory `zzz` runs in; one that isn't an executable file is an error,
not a fallback), else beside the resolved CLI executable (symlinks followed,
so a symlinked `zzz` finds the `zzzd` beside its target; this covers a dev
build: `target/debug/zzz` runs `target/debug/zzzd`), else `~/.zzz/bin/zzzd`,
then `zzzd` on `$PATH` — a candidate that isn't an executable file is skipped.
Never from the current directory (relative `$PATH` entries are skipped), so
running `zzz` inside an untrusted checkout can't execute its
`target/debug/zzzd` with your database URL and cookie key; finding none is an
error (`ZZZ_SERVER_BIN` must `exec` the server, not fork it — the listening socket
is checked on the spawned pid). Build both
with `cargo`: `cargo build -p zzz` (CLI) and `cargo build -p zzz_server`
(daemon → `zzzd`).

When the CLI starts `zzzd` it:

- **env** — passes its own environment, with `~/.zzz/.env` filling any
  variable that environment doesn't set (or sets blank — a blank value is
  never passed on: the CLI removes it from the child's env; so to disable a
  key `~/.zzz/.env` sets, comment it out there — an empty exported value
  doesn't override it), and
  `FUZ_ALLOWED_ORIGINS` defaulting to
  `http://localhost:<port>,http://127.0.0.1:<port>`. `DATABASE_URL` and
  `SECRET_FUZ_COOKIE_KEYS` must be set in one or the other. `.env` lines
  that aren't assignments are skipped with a warning naming their line
  numbers. When the environment overrides a `.env` key with a different
  value, a note names the key (never the value).
  `ZZZ_ENABLE_TEST_ACTIONS` is never passed on, from either source (a
  warning says so when it's set).
- **cwd** — runs it in `~/.zzz`. For the path-valued vars (`PUBLIC_ZZZ_DIR`,
  `PUBLIC_ZZZ_SCOPED_DIRS`, `FUZ_BOOTSTRAP_TOKEN_PATH`, `ZZZ_STATIC_DIR`,
  `ZZZ_FFMPEG_BIN`, `ZZZ_WHISPER_CPP_BIN`, `ZZZ_WHISPER_CPP_MODEL`) the
  CLI expands `~`; a relative value from `~/.zzz/.env` resolves against
  `~/.zzz`, and one from the CLI's own environment against the directory
  `zzz` runs in. The three tool vars are the exception to the first half:
  `zzzd` requires them absolute, so a relative one in `~/.zzz/.env` (which
  the CLI passes through as written) refuses to boot — write `~/…` or a full
  path there.
- **port** — `--port` (only `zzz daemon start` takes it: `zzz` reuses
  whatever daemon is recorded) > `ZZZ_PORT` > `zzz_config_port` in
  `~/.zzz/config.json` > 4460, passed as `--port`; the port must be free.
  Every source must be a port in `1..=65535`, and a `config.json` that
  exists must parse as a JSON object — otherwise it's an error naming the
  source (the file, for `config.json`), never a fallback.
- **UI** — `ZZZ_STATIC_DIR` if set (must be a directory), else
  `~/.zzz/static`, passed as `--static-dir`; neither is an error.

A daemon counts as started once the spawned process itself holds the
listening socket and answers `/health` (probed on `127.0.0.1`, bypassing any
`HTTP(S)_PROXY`); one that exits first fails the start at once (the detached
`zzz` start shows the tail of `~/.zzz/run/daemon.log`, mode `0600`). Until it
serves, a timeout or SIGINT/SIGTERM/SIGHUP stops the child (`SIGTERM`, then
`SIGKILL` after 10s) — no unrecorded daemon is left behind — and
`daemon.json` is written only once it serves. `~/.zzz/run/daemon.json`
identifies the daemon by boot id, pid, **and** kernel start time, so a pid
reused by another process (or a record from before a reboot) is treated as
gone — never signalled — and the file is removed only while it still
records the same process: by `zzz daemon start` when its foreground daemon
exits, by `stop` (after stopping it, or once it's stale), by `zzz` (once it's
stale, or after stopping an unresponsive one), or by `status` once it's
stale. A `daemon.json` this zzz can't read — an older or newer zzz's, or a
corrupt one — is reported (with its pid, "stop it manually", when it names
one; a corrupt one usually doesn't, so "remove it once no daemon is running")
and never signalled, removed, or overwritten: `zzz` and `zzz daemon start`
refuse to start a daemon while it's there, `zzz daemon stop` refuses to
signal, and `status` reports the state unknown (exit 4). Once serving, foreground
`zzz daemon start` exits with zzzd's own status (0 on a clean stop, 128 + the
signal if one killed it); a signal during startup exits 128 + that signal, and
a startup failure exits 1. A usage or config error — a bad argument, a
non-UTF-8 one, an invalid port, a bad `config.json`, missing env, no `zzzd` —
exits 2 before anything runs; `--help` exits 0.

`zzz <path>` expands `~`, resolves the path against the current directory,
and canonicalizes it (the form the daemon stores for workspaces) before
building the `?workspace=` URL; a missing path is an error, and a file opens
its parent directory.

`zzz` opens that URL in the browser (`xdg-open` / `open` / `start`) unless an
**opener** — an open command to run instead — is configured:

- **sources** — `opener` in `~/.zzz/config.json`, then `ZZZ_OPENER` in the
  CLI's own environment (`~/.zzz/.env` is the daemon's and isn't read for
  it). A blank value (or a config `null`) reads as unset and falls through to
  the next source, then to the browser.
- **shape** — in `config.json`, a string is the program alone (never split)
  and an array of strings is the program followed by its arguments, so flags
  need no shell parsing: `"opener": ["~/bin/my-opener", "--new-window"]`.
  Any other JSON type, an empty array, a non-string element, or a blank
  program (the array's first element) is an error naming the file.
  `ZZZ_OPENER` is the program alone.
- **program** — surrounding whitespace is trimmed and `~` expands; a relative
  path resolves against `~/.zzz` from `config.json` and against the directory
  `zzz` runs in from `ZZZ_OPENER`. A bare name (no `/` — `~name` included, as
  only `~` and `~/…` expand) is refused from both sources: `$PATH` isn't
  searched, and `zzz` never runs a same-named executable from whatever
  directory it's in — write `./name` for a file in that directory, or an
  absolute path. A bare name, or a program that isn't an executable file, is
  an error (exit 2), checked before any daemon is started — never a fallback
  to the browser, and a bad `config.json` opener doesn't fall back to
  `ZZZ_OPENER`.
- **launch** — the URL is the final argument, after the configured ones, and
  the program is executed directly: no shell sees the URL or the arguments.
  The URL is always its own argument, so a `--flag=<url>` form needs a
  wrapper script. It runs detached (its own process group, output in
  `~/.zzz/run/opener.log`, mode `0600`, emptied at each launch) in the
  directory `zzz` runs in, with the CLI's environment
  minus `ZZZ_ENABLE_TEST_ACTIONS`; the daemon's `~/.zzz/.env` values aren't
  added. `zzz` doesn't wait for it, so the opener's own exit status isn't
  checked; only a failure to start it is an error (exit 1).

`zzz` reads `config.json` for the opener on every run, so a file that isn't a
JSON object is an error (exit 2) even when a daemon is already running.

## Docs

- ./docs/architecture.md — Action system, Cell system, content model, data flow
- ./docs/development.md — Development workflow, extension points, patterns
- ./docs/providers.md — AI provider integration, adding new providers
- ./docs/reference.md — generated action-spec + cell-class tables (`gro gen`)
- ./crates/CLAUDE.md — Rust backend (`zzzd`) + Rust CLI (`crates/zzz`)

## Repository Structure

```
crates/                               # Rust workspace
│   ├── CLAUDE.md                     # Rust backend docs
│   ├── zzz/                          # Rust CLI (argh) — daemon lifecycle, init, open, version
│   ├── xtask/                        # Dev automation: `cargo xtask dev` (build + run zzzd + Vite), `dev-setup`/`prod-setup` (env files), `check-release` (dep-graph audit — sanity check #2 of the test-binary pattern)
│   ├── testing_zzz_server/           # Test-mode binary — wires `fuz_testing::TestingArgon2idHasher` for fast cross-process integration tests. **Never ships in a release.**
│   └── zzz_server/                   # Axum JSON-RPC server — full spine consumer (single `/api/rpc` + `/api/ws` on `fuz_actions::ActionRegistry`)
│       └── src/                      # `run_app` lifecycle (`lib.rs`) + thin `main.rs`; `handlers/` (App state + `broadcast` shim + per-domain RPC handlers) + `zzz_action_specs/` (spec builders), `provider/` (AI providers), `file_bytes.rs` (byte routes), `filer.rs`, `job_manager.rs`, `media.rs` + `tool.rs` (`ffmpeg` runs, local tools), `transcription/`, `pty_manager.rs`, `scoped_fs.rs`, `utf8_stream.rs`, `error.rs`. Auth / HTTP / realtime (WS + SSE) / dispatch / DB (and the JSON-RPC `notification` builder + error constructors + socket revocation) all come from the spine crates. See ./crates/CLAUDE.md for the full tree.
src/
├── lib/                          # Published as @fuzdev/zzz
│   ├── *.svelte.ts               # Cell state classes
│   ├── action_specs.ts           # Action spec definitions
│   ├── cell.svelte.ts            # Base Cell class
│   ├── cell_classes.ts           # Cell class registry
│   ├── indexed_collection.svelte.ts
│   │
│   ├── *.svelte                  # UI components
│   ├── *.gen.ts                  # Generators (hand-written) — run `gro gen`
│   ├── action_collections.ts     #   ↳ generated output (DO NOT EDIT)
│   ├── action_metatypes.ts       #   ↳ generated output (DO NOT EDIT)
│   └── frontend_action_types.ts  #   ↳ generated output (DO NOT EDIT)
│
├── routes/                       # SvelteKit routes (one dir per page)
│   ├── about/
│   ├── actions/
│   ├── bots/
│   ├── capabilities/
│   ├── chats/
│   ├── docs/
│   ├── feeds/
│   ├── files/
│   ├── jobs/
│   ├── models/
│   ├── projects/
│   ├── prompts/
│   ├── providers/
│   ├── recordings/
│   ├── repos/
│   ├── settings/
│   ├── tabs/
│   ├── terminals/
│   ├── views/
│   └── workspaces/
│
└── test/                         # Tests (not co-located)
    ├── cell.svelte.*.test.ts
    ├── action_event.test.ts
    ├── indexed_collection.svelte.*.test.ts
    └── ...
```

## Architecture

The two core abstractions are **Cells** (reactive state) and **Actions** (RPC). Cells hold all application state as Svelte 5 rune classes with Zod schemas. Actions provide symmetric JSON-RPC 2.0 communication where frontend and backend are equal peers.

Content model: `Chat → Thread[] → Turn[] → Part[]` (TextPart or DiskfilePart). Prompts also hold Parts.

See ./docs/architecture.md for detailed data flow, content model, and IndexedCollection docs.

## Cell Classes

Registered in `src/lib/cell_classes.ts` — ./docs/reference.md
has the authoritative generated roster and count. Purposes below (`Socket` is
not a Cell — it's a plain `.svelte.ts` wrapper around fuz_app's
`FrontendWebsocketClient`, so it's not listed):

- `Parts` (`parts.svelte.ts`) — Collection of all parts
- `TextPart` (`part.svelte.ts`) — Direct text content
- `DiskfilePart` (`part.svelte.ts`) — File reference content
- `Capabilities` (`capabilities.svelte.ts`) — Feature capability tracking
- `Chat` (`chat.svelte.ts`) — Chat container with threads
- `Chats` (`chats.svelte.ts`) — Collection of chats
- `Diskfile` (`diskfile.svelte.ts`) — Single file on disk (its content when loaded, and its `mtime`)
- `DiskfileTab` (`diskfile_tab.svelte.ts`) — Editor tab for a file
- `DiskfileTabs` (`diskfile_tabs.svelte.ts`) — Tab manager
- `DiskfileHistory` (`diskfile_history.svelte.ts`) — File edit history (owned by the file's app-level `DiskfileEditorState`)
- `Diskfiles` (`diskfiles.svelte.ts`) — Collection of disk files
- `DiskfilesEditor` (`diskfiles_editor.svelte.ts`) — Multi-file editor state
- `Job` (`job.svelte.ts`) — A backend job: long-running work on a file (a transcription), its status and progress
- `Jobs` (`jobs.svelte.ts`) — The account's jobs, mirroring the backend's
- `Model` (`model.svelte.ts`) — AI model definition
- `Models` (`models.svelte.ts`) — Model catalog with indexes
- `Action` (`action.svelte.ts`) — Single action event state
- `Actions` (`actions.svelte.ts`) — Action history: the newest 512 calls, payloads over 8192 characters of JSON replaced by markers (./docs/architecture.md § Actions Log)
- `Prompt` (`prompt.svelte.ts`) — Reusable prompt template
- `Prompts` (`prompts.svelte.ts`) — Collection of prompts
- `Provider` (`provider.svelte.ts`) — AI provider config
- `Providers` (`providers.svelte.ts`) — Collection of providers
- `Recorder` (`recorder.svelte.ts`) — App-level microphone recording: status, the file it grows, its level, pause / resume / stop, transcribe-on-stop
- `Turn` (`turn.svelte.ts`) — Single conversation message
- `Thread` (`thread.svelte.ts`) — Linear conversation with one model
- `Threads` (`threads.svelte.ts`) — Collection of threads
- `Space` (`space.svelte.ts`) — Named grouping of workspace dirs
- `Spaces` (`spaces.svelte.ts`) — Collection of spaces
- `Terminal` (`terminal.svelte.ts`) — PTY terminal run: status, buffered output, ordered input
- `Terminals` (`terminals.svelte.ts`) — App-level terminal runs; routes output/exit notifications
- `TerminalPreset` (`terminal_preset.svelte.ts`) — Saved terminal command config
- `TerminalPresets` (`terminal_presets.svelte.ts`) — Collection of terminal presets
- `Time` (`time.svelte.ts`) — Reactive time state
- `Ui` (`ui.svelte.ts`) — UI state (menus, layout)
- `Workspace` (`workspace.svelte.ts`) — Open workspace directory
- `Workspaces` (`workspaces.svelte.ts`) — Collection of workspaces

## Action Specs

Defined in `src/lib/action_specs.ts`. The full list — method, kind, initiator,
auth, and description — is generated into ./docs/reference.md
from the specs themselves (`src/lib/reference.gen.ts`, refreshed by `gro gen`),
so it can't drift. The test-only `_testing_emit_notifications` +
`_testing_notification` specs live in `src/lib/testing_action_specs.ts` and only
register on the live dispatchers when `ZZZ_ENABLE_TEST_ACTIONS=1`.

The generated tables cover zzz's own TS specs only — the fuz_app methods the
backend registers from the spine (`account_*`, `admin_*`, invites, role
grants, …) never pass through `action_specs.ts`, so they don't appear in
./docs/reference.md; see the Rust Backend section for that surface.

## Development Workflow

### Setup

```bash
createdb zzz
cargo xtask dev-setup
npm install
cargo xtask dev
```

The Rust backend (and its native `fuz_pty` PTY dependency) builds via `cargo`
— `cargo xtask dev` runs `cargo build -p zzz_server` on every start. Requires the
sibling Rust workspace checked out alongside this repo (path deps).

Node dependencies are installed with `npm install`. zzz has no Deno: the dev and
env-setup orchestration is `cargo xtask` (see `crates/xtask/`), so there's no
`deno.json` import map to keep version-synced — npm manages `node_modules`.

### Daily Commands

- `cargo xtask dev` — Dev server: Rust backend + Vite frontend
- `gro check` — All checks (typecheck, test, gen, format, lint)
- `gro typecheck` — Type checking only (faster iteration)
- `gro test` — Run Vitest unit + db tests (cross-backend gated out — see below)
- `npm test` — `gro test` (unit + db; cross-backend projects excluded unless `FUZ_TEST_CROSS_BACKEND=1`)
- `npm run test:cross` — Rust cross-process suites (rust + rust_proxy; needs rust binary + `zzz_test_rust`/`zzz_test_rust_proxy` Postgres DBs) — flag baked in
- `gro gen` — Run `*.gen.ts` generators (regenerate their outputs)
- `gro format` — Format with tsv
- `gro build` — Production build

`cargo xtask dev` is the dev command — it builds and runs `zzz_server` plus
the Vite frontend.

### Rust Backend

The Rust `zzz_server` (Axum) is zzz's backend.
RPC methods: `ping`, `session_load`, `workspace_*`,
`diskfile_update`, `diskfile_create`, `diskfile_delete`, `directory_create`, `media_finalize`,
`transcription_create`, `job_cancel`, `terminal_create`,
`terminal_data_send`, `terminal_resize`, `terminal_close`,
`provider_load_status`,
`completion_create`, `account_verify`, `account_session_list`,
`account_session_revoke`, `account_session_revoke_all`,
`account_token_create`, `account_token_list`, `account_token_revoke`,
`admin_session_revoke_all`, `admin_token_revoke_all`.
Those are the zzz-domain methods plus fuz_app's account self-service and
admin-revocation slice; `run_app` also registers the rest of `fuz_auth`'s
standard bundle — admin account/audit/invite management, `app_settings_*`,
and the consent-based `role_grant_*` / `role_grant_offer_*` flow with its own
notifications — plus the protocol specs (`heartbeat`, WS-only; `peer/ping`,
both transports). That spine surface is live on `/api/rpc` + `/api/ws` even
though zzz ships no UI for most of it.
Cookie session auth and bearer token auth (API tokens)
on HTTP and WebSocket, `ScopedFs` path safety, PTY terminals via `fuz_pty`
native crate, and WebSocket connection tracking (`broadcast`/`send_to`).
PostgreSQL via `tokio-postgres`/`deadpool-postgres`, HMAC-SHA256 cookie
signing, blake3 session/token hashing, per-action auth checks with credential
type enforcement, bootstrap endpoint. AI provider system with enum-dispatched
providers — Anthropic, OpenAI, and Gemini all fully implemented (non-streaming +
SSE streaming with connection-targeted `completion_progress` notifications).
Cross-process integration tests in `src/test/cross_backend/*.cross.test.ts`
run fuz_app's standard suites against `zzz_server` over real HTTP, verifying
its JSON-RPC responses conform to the shared fuz_app contract. They cover
the full surface — including the admin role-gated `admin_session_revoke_all` /
`admin_token_revoke_all` handlers and trusted-proxy `client_ip` resolution
(the `cross_backend_rust_proxy` project). `zzz_server`'s own `#[cfg(test)]`
unit tests sit beside the code they cover (e.g. the provider modules,
`filer.rs`, `pty_manager.rs`, `scoped_fs.rs`); auth,
origin, and trusted-proxy pure functions are unit-tested in the spine crates
(`fuz_auth`, `fuz_http`).

```bash
cargo build -p zzz_server                                                 # Build
cargo clippy -p zzz_server                                                # Lint
./target/debug/zzzd --port 4460                                           # Run (requires DATABASE_URL, SECRET_FUZ_COOKIE_KEYS, FUZ_ALLOWED_ORIGINS)
cargo xtask dev                                                             # Dev server: Rust backend + Vite frontend
npm run test:cross                                                        # Rust cross-process suites (rust + rust_proxy; needs rust binary + zzz_test_rust/zzz_test_rust_proxy DBs) — flag baked in
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust       # Single project (Rust binary; needs `postgres://localhost/zzz_test_rust`)
FUZ_TEST_CROSS_BACKEND=1 npx vitest run --project cross_backend_rust_proxy # Single project (proxy variant; ZZZ_TRUSTED_PROXIES=127.0.0.1 at boot)
```

The `cross_backend_*` vitest projects are gated behind
`FUZ_TEST_CROSS_BACKEND=1` (set in `vite.config.ts`) — they spawn the real
backend binary via `globalSetup`, so a bare `gro test` stays a fast,
infra-free unit+db run and never spawns. The `test:cross` package.json
script (`npm run test:cross`) bakes in the flag; set it manually only for
single-project `--project` runs.

Requires the sibling Rust workspace checked out alongside this repo (path
deps). Each cross-backend project expects its own PostgreSQL DB —
`zzz_test_rust` and `zzz_test_rust_proxy` (`createdb zzz_test_rust`;
`createdb zzz_test_rust_proxy`).
See ./crates/CLAUDE.md for architecture, endpoints,
prerequisites, and what the integration tests check.

### Naming Conventions

- TypeScript files — `snake_case.ts`. Example: `action_dispatcher.ts`
- Svelte 5 state — `snake_case.svelte.ts`. Example: `chat.svelte.ts`
- Components — `PascalCase.svelte`. Example: `ChatView.svelte`
- Tests — `*.test.ts` in `src/test/`. Example: `cell.svelte.base.test.ts`

## Code Patterns

### Cell Pattern

Every piece of state is a Cell subclass: Zod schema defines shape, `$state` runes hold values, `$derived` computes reactively.

```typescript
// 1. Schema with CellJson base
export const ChatJson = CellJson.extend({
	name: z.string().default(''),
	thread_ids: z.array(Uuid).default(() => []),
	view_mode: z.enum(['simple', 'multi']).default('simple'),
	selected_thread_id: Uuid.nullable().default(null)
}).meta({ cell_class_name: 'Chat' });

// 2. Class with $state.raw for most fields, $state for in-place-mutated arrays
export class Chat extends Cell<typeof ChatJson> {
	name: string = $state.raw()!;
	thread_ids: Array<Uuid> = $state()!; // $state because push/splice used
	view_mode: ChatViewMode = $state.raw()!;
	selected_thread_id: Uuid | null = $state.raw()!;

	readonly threads: Array<Thread> = $derived.by(() => {
		const result: Array<Thread> = [];
		for (const id of this.thread_ids) {
			const thread = this.app.threads.items.by_id.get(id);
			if (thread) result.push(thread);
		}
		return result;
	});

	constructor(options: ChatOptions) {
		super(ChatJson, options);
		this.init(); // Must call at end of constructor
	}
}
```

### Action Spec Pattern

Each action is a plain object with Zod schemas for input/output:

```typescript
export const diskfile_update_action_spec = {
	method: 'diskfile_update',
	description: 'Write new content to a file on disk.',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: z.strictObject({
		path: DiskfilePath,
		content: z.string()
	}),
	output: z.null(),
	async: true
} satisfies RequestResponseActionSpec;
```

Action kinds:

- `request_response` — HTTP or WebSocket. Pattern: Frontend sends, backend replies
- `remote_notification` — WebSocket only. Pattern: Backend pushes to frontend
- `local_call` — None (in-process). Pattern: Frontend-only

### Adding an Action (End-to-End)

Adding a new action touches up to 5 files. Here's the full workflow:

**1. Define the spec** in `src/lib/action_specs.ts`:

```typescript
export const my_action_spec = {
	method: 'my_action',
	kind: 'request_response', // or 'remote_notification', 'local_call'
	initiator: 'frontend', // or 'backend', 'both'
	auth: { account: 'required', actor: 'none' }, // or {account: 'none', actor: 'none'} for public
	side_effects: true, // or false for read-only
	input: z.strictObject({ foo: z.string() }),
	output: z.strictObject({ bar: z.number() }),
	async: true,
	description: 'What this action does.'
} satisfies RequestResponseActionSpec; // RemoteNotificationActionSpec / LocalCallActionSpec for the other kinds
```

Add it to the `all_action_specs` array at the bottom of the file.

**2. Run `gro gen`** — regenerates 4 files:

- `action_collections.ts` — `ActionInputs`/`ActionOutputs` type maps + `ActionEventDatas`
- `action_metatypes.ts` — `ActionMethod` open union, narrow handler enums (`BackendRequestResponseMethod`, `BroadcastActionMethod`, …), `FrontendActionsApi` interface
- `frontend_action_types.ts` — `TypedActionEvent` + `FrontendActionHandlers`
- `docs/reference.md` — the human-readable action-spec + cell-class tables

**3. Add the backend handler** in the Rust backend (`crates/zzz_server`):
add a spec builder in `zzz_action_specs/` and the handler fn in
`handlers/` (see ./crates/CLAUDE.md). Both HTTP RPC and WebSocket paths
dispatch through the same `ActionRegistry`, so the new handler is picked up
on both transports.

**4. Add frontend handler** in `src/lib/frontend_action_handlers.ts` — handlers
live inside `create_frontend_action_handlers(frontend)` and reach app state via
the closed-over `frontend` (the action event carries no `app`):

```typescript
my_action: {
  // For request_response:
  receive_response: ({data: {output}}) => { /* handle success */ },
  receive_error: ({data: {error}}) => { /* handle error */ },
  // For remote_notification:
  receive: ({data: {input}}) => { /* handle notification */ },
},
```

**5. Call from frontend** via `app.api`:

```typescript
// Returns Result<{value: OutputType}, {error: JsonrpcError}>
const result = await app.api.my_action({ foo: 'hello' });
if (result.ok) {
	console.log(result.value.bar); // 42
}
```

For `remote_notification` actions, the backend broadcasts via its realtime
connection registry — see the `broadcast` / notification builders in
./crates/CLAUDE.md.

### Zod Schema Conventions

- Always use `z.strictObject()` (not `z.object()`) for action specs — unknown keys are rejected
- Cell schemas use `CellJson.extend({...})` with `.meta({cell_class_name: 'ClassName'})`
- Every schema field must have a `.default()` for Cell instantiation without full JSON — except identity fields a cell can't exist without (e.g. `Diskfile.path`/`source_dir`, `DiskfileTab.diskfile_id`, `Workspace.path`, `Model.name`, `Action.method`, `Turn.role`), which stay required rather than defaulting to a value the class type doesn't allow
- Schema and class types agree: a field typed non-null in the class never defaults to `null` in the schema
- A registered class's schema names it: `.meta({cell_class_name})` equals its key in `cell_classes.ts` (the registry's key — never `constructor.name`, which minification mangles)

### State Class Rules

- Schema fields use `$state.raw()!` by default (non-null assertion, set by `init()`)
- Use `$state()!` only for arrays/objects mutated in place (push, splice, index assignment)
- Computed values use `readonly $derived` or `readonly $derived.by(() => ...)` — always `readonly` unless reassignment is explicitly needed
- No `$effect` inside Cell classes — effects belong in components
- Constructor must call `this.init()` as the last statement
- Always register new Cell classes in `cell_classes.ts`
- Cells that outlive a component are never constructed in its init, `onMount`, or an `$effect` directly — wrap the construction in `create_detached` (`reactive_helpers.svelte.ts`), or a `$derived` of theirs freezes when the component unmounts

## Code Practices

- `// @slop [Model]` marks LLM-generated code needing review
- `// TODO` for work items, `// TODO @api` for API design questions
- Import the real source extension (`.ts` / `.svelte.ts` / `.svelte`): `import {Chat} from './chat.svelte.ts'`
- Prefer pure functions; mark mutations with `@mutates` JSDoc tag
- Tests in `src/test/`, split by aspect: `cell.svelte.base.test.ts`, `cell.svelte.decoders.test.ts`
- UI uses `@fuzdev/fuz_css` style variables and semantic classes, not inline styles
- Icons beside text use `Icon` (`Icon.svelte`: a `1em`, inline, unshrinkable `Svg`); a bare `Svg` is `var(--font_size, auto)`-sized (`auto` outside headings and `font_size_*` classes) and fuz_css makes `svg` a block capped at `max-width: 100%`, so use it only with an explicit `size`
- A `Contextmenu` wrapper's element is `display: contents` — put layout classes on an inner element, not on the wrapper (it has no `attrs` prop)

## Zzz App Directory

The app directory stores zzz's own files. Configured via `PUBLIC_ZZZ_DIR`
(default `.zzz`, relative to the daemon's working directory): `./.zzz` under
`cargo xtask dev`, `~/.zzz/.zzz` for the CLI's daemon, whose working directory
is the daemon home `~/.zzz/` (see CLI).

- `state/` — Persistent data (reserved — the Rust backend currently keeps domain state in memory)
- `cache/` — Regenerable data, safe to delete: scratch for tool runs — unnamed temp files (unlinked as soon as they're created) and, during a transcription, a `.zzz-tmp-<uuid>/` directory removed when it ends
- `recordings/` — where the recordings page records: audio files and their transcript sidecars
- `run/` — Runtime ephemeral (the test binary's `daemon_token`)

It's a permanent `ScopedFs` root with its own filer, so the frontend can
read and write files there. A workspace or scoped-dir filer whose root contains the
app directory skips it by its full path (its own filer covers it), so a
custom-named app dir (say `data`) doesn't hide other `data/` folders. Every
filer also skips any directory named `.zzz` — the conventional app dir and the
CLI's daemon home, which holds `.env` and `bootstrap_token` — and
`workspace_open` refuses a `.zzz` directory, or a path inside one, other than
the app dir itself (`forbidden` / `zzz_home_not_allowed`), so `zzz ~/.zzz/.env`
(which opens `~/.zzz/`) can't index and broadcast those secrets. The app dir
and the paths inside it stay openable.

The daemon home holds the CLI's files beside it: `config.json`, `.env`,
`bootstrap_token`, `static/` (the UI build), `bin/`, and `run/`
(`daemon.json` — boot id, pid, start time, port — `daemon.log`, and an
opener's `opener.log`).

All filesystem access goes through `ScopedFs` — path validation, no symlinks, absolute paths only.
Saves are atomic: `diskfile_update` stages the content in a hidden
`.zzz-tmp-<uuid>` file beside the target (never indexed or broadcast by the
filer), fsyncs it, and renames it over the target, so a failed or concurrent
save never leaves an empty or mixed file. The file's mode is kept — except
setuid and setgid, which zzz always drops on a save —
and its owner best-effort (a file owned by another user becomes the daemon user's when
zzz can't restore it); being a new inode, a saved file **loses its hardlinks**
(other names keep the old content) and any xattrs/ACLs. An existing file must
be writable by the daemon — a read-only file is refused (`permission_denied`)
even though its directory would allow the rename. When the rename can't
happen but the file itself is writable — its directory isn't writable, or the
file is a bind mount (`EBUSY`) or in a sticky directory (`EPERM`) — the save
falls back to writing in place (truncate + write + fsync), which is **not
atomic**: a failure midway leaves the file truncated or partial. A new file
in a non-writable directory fails with `directory_not_writable`. Only regular
files are written — a directory, FIFO, socket, or device node target is
refused. A crash mid-save can orphan a staging file; the filer's walk deletes
exact `.zzz-tmp-<uuid>` regular files older than an hour (ones inside ignored
directories stay). The files page's new file and new folder go in the active
workspace (`Diskfiles.new_files_dir`) and are disabled while no workspace is
open; a failure (say a non-writable directory) is reported, never silent, as
is a failed delete (each alert leads with the name or path). The entered
name is trimmed, leading slashes dropped; refused (`parse_new_diskfile_name`):
a blank name, one naming the workspace itself, a whitespace-only path
segment, a `..` climbing out of the workspace, and a file name whose last
segment is empty, `.`, or `..`. "New
file" uses `diskfile_create`, which creates the final name exclusively
(`O_EXCL`) and fails with `conflict` / `already_exists` instead of
overwriting; "new folder" (`directory_create`) fails the same way when the
name is taken, directory or not. For both, a symlink at the name is refused
as `forbidden` / `symlink_not_allowed` (zzz never follows symlinks), and a
missing parent folder that can't be created under a read-only ancestor
reports `permission_denied` rather than `directory_not_writable`. The UI shows a path inside the app directory relative to it and
any other path absolute — including a file part's `path` attribute in the
prompt XML sent to models.

### File bytes

The file actions carry contents as UTF-8 strings in one JSON-RPC message. For
everything else — media, and files written as they grow — `zzzd` has byte
routes at `/api/files/bytes?path=<absolute path>` (`file_bytes.rs`;
`src/lib/file_bytes.ts` builds the URLs):

- `GET` / `HEAD` — the file's bytes, with single-range `Range` support, so a
  media element can use the URL as its `src` and seek.
- `POST` — create the file exclusively from the request body (201 `{size}`,
  409 `already_exists`).
- `PATCH` with `&offset=` — append the body only if the file is exactly
  `offset` bytes long (200 `{size}`); otherwise 409 `offset_mismatch` with the
  current `size` and nothing written, so a retried chunk is harmless and
  chunks can't interleave. One body is at most 16 MiB
  (`FILE_BYTES_MAX_BODY_BYTES`).

They go through `ScopedFs` like every file action, and require a session or a
full-scope API token (a method-scoped token is refused). **Serving bytes never
executes them**: only allowlisted raster image, audio, and video extensions
get their media type; anything else — HTML, SVG, XML, scripts, text — is sent
as `application/octet-stream` with `Content-Disposition: attachment`, and
every response that serves or describes a file (a read, a write's reply, a
file error) carries `nosniff`, a sandboxing `Content-Security-Policy`, and
`Cross-Origin-Resource-Policy: same-origin`. A refusal at a gate — a bad
query, no credential, a scoped token, an oversized body, a foreign origin —
is the spine's plain JSON error, without them. The routes are hand-written,
outside the action system: no audit row, no actions-log entry, no generated
client.

`ScopedFs` is the only path check here, and it knows roots, not secrets: with
a workspace open on a directory that contains a `.zzz` directory — `~`, or
`/` — these routes can read the files inside it (the CLI daemon home's `.env`
and `bootstrap_token`), which the file index never loads. That's within what
a session can already do (see Security posture), and it is the one place a
`.zzz` directory's contents are served. See ./crates/CLAUDE.md § Design
Decisions.

### Local tools

`zzzd` shells out to `ffmpeg` for media work and to whisper.cpp
(`whisper-cli`) for transcription. They're assumed runtime dependencies, not
bundled ones: `zzzd` looks for each once at boot — `ZZZ_FFMPEG_BIN` /
`ZZZ_WHISPER_CPP_BIN` if set, else the binary on `PATH` (absolute entries
only, never the working directory) — and what needs one fails with
`service_unavailable` / `tool_unavailable` when it's missing. The speech model
is never searched for: it's the file `ZZZ_WHISPER_CPP_MODEL` names, or
transcription is unavailable.

A media file is untrusted input to a large parser, so `ffmpeg` is never given
a path: it reads and writes only file handles `zzzd` opened, is allowed no
other protocol (it can't open another file or a URL, whatever the file says),
is told the input's format from the extension, and runs with the scrubbed
environment terminals get, a timeout, and no shell.

`media_finalize` rewrites a media file's header: a browser recording is
streamed to disk, so its header has no duration and players seek it poorly;
finalizing rewrites the file in place (a stream copy, nothing re-encoded) with
both, replacing it atomically like a save. The container comes from the
extension — WebM, Matroska, Ogg, MP4, MP3, WAV, FLAC, or AAC — and the same
set is what `ffmpeg` will decode for a transcription.

There is no switch that turns media off. Transcription is off while
`ZZZ_WHISPER_CPP_MODEL` is unset; recording, the byte routes, and finalize are
always there. Tools are found once at boot, so installing one, or setting a
model, takes a daemon restart. The `ffmpeg` must have the `fd` protocol
(`ffmpeg -protocols` lists it; current builds have it) — one without it fails
every run as `media_invalid`. ./docs/development.md § Local tools has the
install steps.

### Transcription and jobs

`transcription_create` transcribes an audio file with the local model. **The
audio never leaves the machine**: whisper.cpp runs as a subprocess, with no
server and no network, over PCM `ffmpeg` decoded — it reads that from a handle
too, so neither tool is ever given the file's path. The result is a
**sidecar** beside the audio, `<name>.<model>.transcript.json`: timed
segments (with words and their probabilities), plus what it was made from
(the audio's blake3 hash and size) and what made it (whisper.cpp's version,
the model and its hash, the parameters). It is tool output — written once,
exclusively, and never edited: transcribing again with the same model is
refused (`conflict` / `already_exists`) until the sidecar is deleted, and the
model's name is in the file name so another model's transcript sits beside
it. Editing happens on a copy ("edit a copy" writes `<name>.md`: a link to the
audio, then the speech as paragraphs split at pauses).

A transcription takes minutes, so it's a **job**: daemon-side work that
outlives the request, tab, and socket that started it (`job_manager.rs`).
Jobs run one at a time in the order submitted, belong to the account that
created them (only its sockets get `job_changed`; to another account the job
doesn't exist), can be cancelled queued or running (`job_cancel` — the running
one's tool process is killed), and live in the daemon's memory like terminals:
a restart forgets them, finished ones are kept up to a bound, and
`session_load` lists the caller's so a reload resyncs. While one runs,
`transcription_progress` carries each segment as it's decoded — a preview; the
sidecar is written at the end. **Nothing runs on its own**: a file appearing
in a workspace is never probed, decoded, or transcribed — only an explicit
`transcription_create`, which the recorder sends for a recording just made
when its "transcribe" toggle is on. See ./crates/CLAUDE.md § Design
Decisions.

## Environment Variables

### Server (read by `zzz_server` at boot)

- `ZZZ_PORT` — HTTP server port (default 4460; `cargo xtask dev` uses 4461); the `--port` flag wins. Anything but a port in `1..=65535` refuses to boot. The bind address is always loopback — there is no `HOST` override.
- `ZZZ_STATIC_DIR` — directory of the built SPA to serve (`--static-dir` wins); must be a directory, or `zzzd` refuses to boot. Unset, `zzzd` serves no frontend (dev: Vite serves it)
- `ZZZ_TRUSTED_PROXIES` — comma-separated trusted proxy IPs / CIDR ranges for `client_ip` resolution
- `ZZZ_FFMPEG_BIN` — the `ffmpeg` binary to run (see Local tools); an absolute path to an executable file, or `zzzd` refuses to boot. Unset, `zzzd` uses the `ffmpeg` on its `PATH`
- `ZZZ_WHISPER_CPP_BIN` — whisper.cpp's `whisper-cli` binary to run, under the same rule. Unset, `zzzd` uses the `whisper-cli` on its `PATH`
- `ZZZ_WHISPER_CPP_MODEL` — the Whisper model file (`ggml-*.bin`) transcription loads; an absolute path to a file, or `zzzd` refuses to boot. There is no default and no search — unset, nothing is transcribed. zzz downloads no models
- `DATABASE_URL` — PostgreSQL connection (`postgres://`; required — unset or blank refuses to boot, naming it)
- `SECRET_FUZ_COOKIE_KEYS` — HMAC signing keys (min 32 chars; required, like `DATABASE_URL`)
- `FUZ_ALLOWED_ORIGINS` — Origin patterns for API verification (required — `zzzd` refuses to boot on an absent or empty list, since an empty allowlist would allow every origin; the CLI defaults it to `http://localhost:<port>,http://127.0.0.1:<port>`)
- `FUZ_BOOTSTRAP_TOKEN_PATH` — One-shot admin bootstrap token path
- `PUBLIC_ZZZ_DIR` — Zzz app directory (default `.zzz`, a subdirectory of the daemon's working directory); must not be the working directory itself (under the CLI that's the daemon home, with `.env` and `bootstrap_token`) — `zzzd` refuses to boot on that. The check catches the daemon home only as the working directory: an explicit `PUBLIC_ZZZ_DIR` naming the absolute path of `~/.zzz` for a daemon run elsewhere (say `cargo xtask dev`) makes the home the app dir, whose filer indexes and broadcasts its `.env` — don't
- `PUBLIC_ZZZ_SCOPED_DIRS` — Comma-separated filesystem paths (`zzzd` doesn't expand `~`; the CLI does); an entry that is, or is inside, a `.zzz` directory other than the app dir refuses to boot
- `ZZZ_ENABLE_TEST_ACTIONS` — Register `_testing_*` actions on live dispatchers (integration tests only — must stay unset in prod; blank reads as unset, and the `zzz` CLI never passes it to a daemon it starts)
- `SECRET_ANTHROPIC_API_KEY` — Claude API key
- `SECRET_OPENAI_API_KEY` — OpenAI API key
- `SECRET_GOOGLE_API_KEY` — Google Gemini API key

`zzzd` reads a blank (empty or whitespace) value of any of its path vars as
unset — `PUBLIC_ZZZ_DIR` falls back to `.zzz`, never `/` — and fails to boot
on an empty or unresolvable path (a missing scoped dir is fine). It creates
the app directory (and missing parents, mode `0700`) at boot, and fails to
boot with the path in the error if it can't. A value that isn't valid UTF-8
fails boot too, rather than reading as unset.

Its command line is `zzzd [--port <port>] [--static-dir <dir>]` (each value
also as `--flag=value`); `-h` / `--help` prints that usage (exit 0), and an
unknown or malformed argument refuses to boot rather than being ignored. A
`--static-dir` may be any path, UTF-8 or not. A boot failure prints
`zzzd: <error>` to stderr and exits 1.

PTY terminals spawned by the server don't get the `SECRET_*`, `FUZ_*`,
`ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, or `PORT` variables — they're
scrubbed from the child environment, which keeps them out of a shell's env
but isn't isolation (see Known Limitations → PTY terminals).

`zzzd` reads only its process environment — it loads no env file. The `zzz`
CLI supplies it from `~/.zzz/.env`, where the **process env wins** (the file
fills gaps; see CLI); `cargo xtask dev` from `.env.development`, where the
**file wins** — it's dev's source of truth, so a stale exported
`DATABASE_URL` can't redirect dev migrations, and xtask prints each
inherited key it overrides. In both, a blank value is unset: a template's
empty `SECRET_*_API_KEY=` line never clears an exported key. `.env.production` is what `gro build` reads for
the `PUBLIC_ZZZ_*` vars, and the template for running `zzzd` under a process
manager (see ./docs/development.md). The CLI itself also
reads `ZZZ_SERVER_BIN` (the `zzzd` binary to spawn) and `ZZZ_OPENER` (an
open command to run instead of the browser — see CLI).

### SvelteKit frontend vars (PUBLIC_ZZZ_\*)

Baked in at build time (`$env/static/public`), so each must be present in
the env file the build reads, even if empty.

- `PUBLIC_ZZZ_SERVER_PROTOCOL` — `http` or `https`
- `PUBLIC_ZZZ_SERVER_HOST` — Server hostname (frontend)
- `PUBLIC_ZZZ_SERVER_PORT` — the server the UI calls (dev: the Vite port, which proxies `/api`); empty → the page's own origin, which is how the production build (served by `zzzd` on any port) is configured
- `PUBLIC_ZZZ_SERVER_API_PATH` — API endpoint path
- `PUBLIC_ZZZ_WEBSOCKET_URL` — WebSocket URL (dev: `zzzd` directly); empty → `<API path>/ws` on the page's origin

`PUBLIC_ZZZ_SERVER_PROXIED_PORT` is dev-only and not baked in: `vite.config.ts`
reads it from the process env as the backend port its dev proxy targets
(`cargo xtask dev` forces 4461).

## Avoid

- **Never edit generated outputs** (`action_collections.ts`, `action_metatypes.ts`, `frontend_action_types.ts`, `docs/reference.md`) — edit the `*.gen.ts` generators and run `gro gen`
- **Use `z.strictObject()`** in action specs, not `z.object()` — unknown keys must be rejected
- **No `$effect` in Cell classes** — effects belong in Svelte components only
- **Run `gro gen` after changing action specs** — handler types are generated from specs
- **Register new Cell classes in `cell_classes.ts`** — the registry must be complete
- **Don't omit import extensions** — use the real source extension (`.ts` / `.svelte.ts` / `.svelte`)

## Security posture

zzz is a single-operator local app: one person, their own machine, the daemon
running as their OS user on loopback. Accounts and the auth stack keep other
OS users' processes and other browser origins out — not same-user processes,
which can read `~/.zzz/.env` and the bootstrap token — and they don't separate
accounts from each other.

- Every session and every full-scope API token effectively has the daemon OS
  user's powers (a method-scoped token is limited to its listed methods):
  terminals (a shell as that user), `workspace_open` of any directory
  including `/` (which makes it writable and scans it) — except `.zzz`
  directories other than the app dir (see Zzz App Directory) — and file
  reads and writes anywhere in scope (the file actions, and the byte routes
  at `/api/files/bytes`, which a method-scoped token can't use at all).
- Terminal output and control — and jobs — are scoped to the account that
  created them, and a deleted or purged account's terminals are closed and
  its jobs cancelled — but that
  isn't a security boundary: any account can open its own shell.
- Revisit — role-gating the `terminal_*`, `workspace_*`, and file actions —
  if multi-account use ever matters.

## Known Limitations

- **WebSocket auth** — Auth is enforced at upgrade time — the spine resolves credentials from the request headers (cookie sessions, bearer tokens — bearer silently discarded in browser context via Origin/Referer defense) before upgrading and re-reads them once the connection is registered, before admitting it. Per-action auth checks enforce spec-level auth: `keeper` requires `daemon_token` + keeper role; `{role}` requires the named role via `has_role` (matches the HTTP path). Batch JSON-RPC is rejected (not yet supported). Sockets are closed on session/token revocation, logout, and password change via audit events — `token_revoke` closes only the revoked token's sockets (granular), `logout` / `session_revoke_all` / `token_revoke_all` / `password_change` close all sockets on the account (logout included, per the fuz_app contract — so another tab's logout closes this tab's socket while its session stays valid). RPC revocations close sockets only after their transaction commits. An expired session's sockets are closed by the auth cleanup, within one cleanup interval of the expiry. An account holds at most 50 sockets (`fuz_realtime::DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`); one more closes its oldest with 4004. A socket closed with 4004 stays closed until the user reconnects — reconnecting would close a newer socket in turn — so the frontend never reopens it on its own (`Socket.superseded`) and shows a notice saying why, with a reconnect button. No per-message session revalidation. ActionPeer itself has no auth awareness. On the frontend, a revoked socket, an `unauthenticated` RPC error, or repeated failed reconnects (a browser can't see an upgrade's 401) trigger a session recheck (`src/lib/session_recheck.ts`); only a definitive 401 from the account status route drops the App and shows the login gate, so a daemon restart doesn't log anyone out. A recheck that finds the session still valid after a revoked close reconnects the socket (`Socket.reconnect_revoked`).
- **Bearer auth soft-fails** — bearer resolution soft-fails for invalid/expired/empty tokens (no early error response). Auth enforcement happens downstream via the per-action auth checks, producing `{code: -32001, message: "unauthenticated"}` JSON-RPC errors. Public actions are not blocked by bad bearer credentials.
- **Domain state is in-memory** — auth/accounts are in the PostgreSQL DB, but zzz domain state (files, terminals, workspaces, jobs) is in-memory, lost on restart — a running transcription included, though the transcripts already written are files and stay. The frontend resyncs after every reconnect (a restart included): it reloads `session_load` and reconciles — workspaces the daemon no longer has are dropped (after a restart they're reopened instead, and dropped only if the directory is gone or forbidden), files it no longer indexes are pruned (a file with unsaved edits stays, flagged deleted on disk), and running terminals it doesn't list become `lost`. Notifications sent while the socket was down aren't replayed, so terminal output from that window is missing (the terminal view says so). See ./docs/architecture.md § File Editing.
- **16 MiB messages** — a JSON-RPC message is capped at 16 MiB on both transports (`RPC_MESSAGE_MAX_BYTES`: the `/api/rpc` body limit and the `/api/ws` message limit). The server closes the socket on an oversized WebSocket message, so the frontend's `Socket` refuses any request over the cap before sending (`invalid_request`, `data.reason` `payload_too_large`; `src/lib/rpc_message_limit.ts`) — a huge save or a very long completion history fails cleanly instead of dropping the socket. Saving any file the filer loads (at most 4 MiB) fits, except in the worst case: JSON escapes a control character to 6 bytes, so a file dense with them can exceed the cap, and that save is refused the same clean way. The cap isn't confined to authenticated callers on HTTP (see ./crates/CLAUDE.md), which is acceptable only because the bind is loopback
- **Unloaded files are read-only** — the file index holds contents only for UTF-8 files up to 4 MiB it could read; any other file arrives with `contents: null` (`Diskfile.content_loaded` is `false`). The editor shows it read-only and empty with a "content not loaded" notice (no stale earlier text, no copy button) and never saves it (`DiskfileEditorState` ignores edits and refuses `save_changes`; `Diskfiles.update` refuses to write over it too, with `conflict` / `content_not_loaded`), since a save would overwrite a file nobody has seen. A file part for it contributes a `[content not loaded — …]` placeholder to a formatted prompt instead of silently dropping out
- **No persistent undo** — saves overwrite the file on disk; the editor keeps an in-memory per-file history (`DiskfileHistory`) you can restore from, lost on reload, as are unsaved drafts — leaving the page while any file has unsaved changes asks first (`beforeunload`), and a session that ends (logout, or a recheck finding it revoked) drops the App and its drafts with it. A file's editing state is app-level (`Diskfiles.get_editor_state`): disk changes are recorded with no editor open, a draft survives tab switches and keeps a file deleted on disk, closing a draft's last tab asks save / don't save / cancel, and a disk change under a draft pauses saving until you overwrite or reload (see ./docs/architecture.md § File Editing). The conflict check is frontend-only: an external write landing between the backend receiving a save and its broadcast arriving is overwritten silently. Histories of files you've opened stay in memory for the session (each capped by entries and size)
- **Symlinks are invisible** — the filer never follows or indexes a symlink (file or directory), and `ScopedFs` rejects symlinked paths, so linked files don't appear in the file tree
- **File watching** — the filer adds one inotify watch per directory it indexes (never inside ignored directories like `node_modules/` or `target/`), and those watches come out of the user's `max_user_watches` budget, shared with every other process. An unreadable subdirectory is skipped (logged once) and picked up if it becomes readable; an unreadable root fails `workspace_open` with `forbidden` (`permission_denied`). When the watch limit is reached (or no watcher can be created), the workspace still opens with every file the scan found, but in **degraded mode**: `workspace_open` returns `watch_status: 'degraded'` (kept on the opening tab's `Workspace` cell; the workspaces page and the desk menu show it — another tab or a reload shows `'full'`), and the directories without a watch are rescanned every 5 seconds or more (retrying their watches each time), so changes there show up late. A workspace that degrades or recovers after it opened isn't re-announced — only the daemon log says so. Rescans re-read only files whose `lstat` changed, trusting a stamp only after the file has been still for 2 seconds
- **Workspace scope** — opening a workspace makes its directory a writable `ScopedFs` root with its own filer until it's closed; closing never revokes the permanent roots (`PUBLIC_ZZZ_DIR` and `PUBLIC_ZZZ_SCOPED_DIRS`). Any absolute directory can be opened — `/` makes the whole filesystem writable and scans it — except a `.zzz` directory (or a path inside one) other than the app dir. A workspace opened in another tab (or by `zzz <dir>`) appears here unactivated, and its files arrive with a session resync
- **Terminals** — any authenticated account can create a terminal, which runs a command as the daemon's OS user (see Security posture). Each terminal belongs to the account that created it: its output (`terminal_data`, `terminal_exited`) reaches only that account's sockets, and other accounts' `terminal_data_send` / `terminal_resize` / `terminal_close` act as if it didn't exist (`not_found`, as for an unknown or ended id). `terminal_create` takes only an absolute `cwd`, and `terminal_close` only `SIGTERM` (the default) or `SIGKILL`. The frontend's terminal list is in-memory, so a page reload loses it while the backend processes keep running
- **PTY terminals** — terminal spawning uses the `fuz_pty` Rust crate as a native dependency of `zzz_server` (no FFI indirection). `PtyManager` runs one I/O task per terminal (readiness-driven reads, an ordered input queue — at most 256 chunks and 4 MiB per terminal, beyond which input is refused with `queue_overflow` — that writes large pastes in full, reaping with `SIGKILL` escalation so closed terminals leave no zombies). Terminal children inherit zzzd's environment **minus** `SECRET_*`, `FUZ_*`, `ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, and `PORT` — this keeps the daemon's API keys, cookie keys, and DB URL out of the child's environment, but it is not isolation (the shell runs as the same user and can read `/proc/<zzzd pid>/environ` or the `.env` files). The prefix match also drops the user's own `FUZ_*` variables from terminals; everything else (`PATH`, `HOME`, `SSH_AUTH_SOCK`, …) passes through. See ./crates/CLAUDE.md for details. Requires the sibling Rust workspace checked out alongside this repo (path dep).
- **Recording** — two places record, over the same `Recorder`: the files page's record button (beside new file and new folder; disabled without an open workspace) records to the active workspace, and the recordings page (`/recordings`: a record button, a level meter, and the recordings with their transcripts) records to `recordings/` in the app directory, which needs no workspace and keeps voice notes out of a repository. Deleting on the recordings page removes a recording with its transcripts; on the files page, exactly the file selected. A recording is a new file named for the local time (`2026-01-31_09-05-07.webm`) — Opus in WebM where the browser records it, else Ogg, else MP4. The file is created under its final name and grows as chunks upload every few seconds (the byte routes), so a crashed or closed tab loses at most the last chunk and leaves a file that still plays but has no duration; `media_finalize` on it later fixes that. Stopping uploads the rest and finalizes, then queues a transcription when the recorder's "transcribe" toggle is on (the default; with no speech model set up it quietly doesn't). The microphone opens only from a click or key press in the UI — `Recorder.start` refuses without a user gesture, and no action the backend can send starts capture. While it may be open an indicator with pause and stop shows on every page (`RecorderIndicator` in the root layout), leaving the page asks first, and a session that ends (logout, or a recheck finding it revoked) closes it with the App. One recording at a time, per tab. The filer sees the file grow: it re-reads and broadcasts it on each chunk while it's under the index's size limit. An upload that fails for good — the session ended, the file changed on disk — ends the recording and says why; the file keeps what landed. See ./docs/architecture.md § Recording
- **Transcription** — batch, not live: the transcript is made from the finished file, and text fills in while the job runs (whisper.cpp decodes in windows of about thirty seconds), not while you speak. It needs `ffmpeg`, whisper.cpp, and a model the operator placed and pointed `ZZZ_WHISPER_CPP_MODEL` at; without whisper.cpp or a model, recording still works and transcribing says what's missing. Without `ffmpeg`, recording still saves the audio, but every stop reports that it couldn't finalize, and the file has no duration. The UI offers transcription on audio extensions (`.webm`, `.ogg`, `.mp3`, `.wav`, `.flac`, `.m4a`, …); the action itself takes any container `ffmpeg` is told how to read here, a `.mkv` or `.mp4` included, and transcribes its first audio stream. The format is taken from the extension, so a mislabeled file fails to decode. The language is detected unless given. The model loads on every job. Word timings are whisper.cpp's own estimates. A transcript isn't checked against its audio afterward — if the audio's bytes change, the sidecar still shows (its recorded hash no longer matches). A sidecar over the file index's 4 MiB limit wouldn't load in the UI. One job runs at a time; jobs and their history are lost on a daemon restart, and a crash mid-transcription can leave a `.zzz-tmp-*` scratch directory in the app directory's `cache/` (hidden from the file index). A transcript's text is whatever was said near the microphone — it's shown as text, and nothing sends it to a chat, a prompt, or a terminal on its own
- **Audio files** — the files page shows a file with an audio extension (`diskfile_content_kind.ts`: `.webm`, `.ogg`, `.mp3`, `.wav`, `.flac`, `.m4a`, …) in a player instead of the text editor (`DiskfileView` picks; `DiskfileAudioView` plays it from the byte route, with finalize, download, and delete), with its transcript beside it — click a segment to play from there — or a transcribe button when it has none. A transcript sidecar (`*.transcript.json`) opens read-only in `DiskfileTranscriptView`, with the audio's player when the audio is beside it. The kind comes from the extension alone — the file index carries no type — so a `.webm` holding video plays as its audio, and a text file named `.ogg` gets a player that can't play it. The player reloads when the file's `mtime` moves (`Diskfile.mtime`, from the index's disk node), and the file being recorded shows as recording, with no player, until it's saved. Images and video have no viewer yet
- **No git integration** — no commit/push/pull from the UI
- **No MCP/A2A** — protocol support planned but not implemented
- **Backend** — `zzz_server` serves the full RPC surface with the full auth stack. `cargo xtask dev` runs it with the Vite frontend. Anthropic, OpenAI, and Gemini providers fully implemented (non-streaming + SSE streaming). No batch JSON-RPC. A single `/api/rpc` + `/api/ws` serves the boot-compiled `ActionRegistry` (handlers in `handlers/`), plus the admin audit-log SSE stream at `GET /api/admin/audit/stream` and the file byte routes at `/api/files/bytes`.

## fuz_app

zzz is the reference implementation for Cell and Action patterns. The SAES
runtime lives in `@fuzdev/fuz_app` — zzz imports ActionSpec, ActionEvent,
ActionDispatcher, transports, and `create_rpc_client` from
`@fuzdev/fuz_app/actions/*.ts`. Cell patterns (Cell base class, cell classes,
IndexedCollection) remain in zzz. The generated `TypedActionEvent` alias
intersects fuz_app's generic `ActionEvent` with zzz's `ActionEventDatas` map
for typed input/output in handlers. `Uuid` and `create_uuid` come from
`@fuzdev/fuz_util/id.ts`, imported directly.

Daemon lifecycle is owned by the Rust CLI (`crates/zzz/src/daemon_lifecycle.rs`)
— it atomically writes `~/.zzz/run/daemon.json` (`{version, pid, boot_id,
pid_start_ticks, port, started, app_version}`) once the spawned `zzzd`
serves, reads it back for discovery/`status`, and checks the process
identity (boot id + pid + start time). The shape follows fuz_app's
`DaemonInfo` by convention, plus `boot_id` and `pid_start_ticks` (hence
`version: 2`) — patterns only, no code reuse.
