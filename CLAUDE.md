# zzz

> nice web things for the tired

`@fuzdev/zzz` — local-first AI forge: chat + files + prompts + terminals in one app.
SvelteKit frontend (static SPA), Rust (Axum) backend, Svelte 5 runes, Zod schemas.
v0.0.1. fuz_app auth stack (sessions, bearer tokens, bootstrap), PostgreSQL DB. Cell + Action patterns (generated roster in [docs/reference.md](./docs/reference.md)), 3 AI providers.

zzz has a single **Rust** backend: `crates/zzz_server` (Axum). The frontend
is a prerendered static SPA served by `zzz_server` — no JS runtime in
production.

For coding conventions, see Skill(fuz-stack).

## Committing

`git add` and `git commit` are denied by `.claude/settings.local.json` in
this repo — make the edits and stop, the user commits.

## What zzz Does

1. **Chat** with AI models — multi-thread, multi-model comparison, streaming responses
2. **Edit files** on disk — scoped filesystem, syntax highlighting, multi-tab editor
3. **Build prompts** — reusable content templates composed from text parts and file references
4. **Manage models** — Claude/ChatGPT/Gemini via BYOK API keys
5. **Run terminals** — interactive PTY terminals via xterm.js with preset commands, contextmenu copy, and restart
6. **Symmetric actions** — JSON-RPC 2.0 between frontend and backend, same ActionPeer on both sides

## Key Principles

- **Local-first**: your data stays on your machine, no third-party lock-in; providers are opt-in BYOK
- **Schema-driven**: Every Cell and Action defined by Zod schemas, validated at boundaries
- **Symmetric actions**: Frontend and backend are peers — same ActionPeer code, same spec format
- **Cell pattern**: All state is Cell subclasses with `$state`/`$derived` runes, JSON-serializable

## Development Stage

Early development, v0.0.1. Breaking changes are expected and welcome. fuz_app auth stack on both RPC and WebSocket endpoints (cookie sessions, bearer tokens, daemon tokens, bootstrap flow); WebSocket upgrade requires authentication with event-driven session revocation. PostgreSQL DB for auth; domain state (files, terminals) is in-memory.

The Rust backend (`crates/zzz_server`, Axum) provides the full auth stack, filesystem, terminals, PostgreSQL, bootstrap, AI providers with SSE streaming, audit emission with listener fan-out, trusted-proxy `client_ip` resolution, login rate limiting (always on; disabled in the test binary), Origin allowlist on every REST + RPC + WS handler. Auth, HTTP, realtime (WS + SSE), dispatch, and DB all come from the spine crates (`fuz_db`, `fuz_auth`, `fuz_http`, `fuz_realtime`, `fuz_actions`); a single `/api/rpc` + `/api/ws` serves the boot-compiled `fuz_actions::ActionRegistry`, with the zzz-specific handlers (workspace, filesystem, terminal, provider, `completion_create`) in `handlers/` and the admin audit-log SSE stream at `GET /api/admin/audit/stream`. AI providers are Anthropic, OpenAI, and Gemini, all with non-streaming and SSE streaming completions.

The `cross_backend_*` vitest projects (gated behind `FUZ_TEST_CROSS_BACKEND=1`) are the Rust backend's integration tests — they run fuz_app's standard suites against `zzz_server` over real HTTP, verifying wire-shape conformance to the shared fuz_app contract. (A schema-parity snapshot gate exists as a fuz_app capability — `query_schema_snapshot` + `assert_schema_snapshots_equal` — but is not currently wired into zzz's cross-backend projects.) Long-term the CLI and daemon migrate to Rust fuz/fuzd.

See [GitHub issues](https://github.com/fuzdev/zzz/issues) for planned work.

## CLI

zzz has a Rust CLI (`crates/zzz`, argh) for daemon management and browser
launching. See ./crates/CLAUDE.md for the crate layout.

```bash
zzz                          # start daemon if needed, open browser
zzz ~/dev/                   # open workspace at ~/dev/
zzz daemon start             # start daemon (foreground)
zzz daemon status            # show daemon info
zzz init                     # initialize ~/.zzz/
```

The global daemon runs on port 4460 with state at `~/.zzz/`. The CLI spawns
and discovers the `zzzd` daemon binary (the `[[bin]]` target of the
`zzz_server` crate) — found beside the CLI executable (e.g. `~/.zzz/bin/zzzd`),
with a dev fallback to `./target/debug/zzzd`. Build both with `cargo`:
`cargo build -p zzz` (CLI) and `cargo build -p zzz_server` (daemon → `zzzd`).

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
│   ├── xtask/                        # Dev automation: `cargo xtask dev` (build + run zzzd + Vite), `dev-setup`/`prod-setup` (env files), `check-release` (dep-graph audit — sanity check #2 of the test-binary pattern). Replaces the former Deno `scripts/*.ts`
│   ├── testing_zzz_server/           # Test-mode binary — wires `fuz_testing::TestingArgon2idHasher` for fast cross-process integration tests. **Never ships in a release.**
│   └── zzz_server/                   # Axum JSON-RPC server — full spine consumer (single `/api/rpc` + `/api/ws` on `fuz_actions::ActionRegistry`)
│       └── src/                      # `run_app` lifecycle (`lib.rs`) + thin `main.rs`; `handlers/` (App state + `broadcast`/`close_sockets_for_*` shims + per-domain RPC handlers) + `zzz_action_specs/` (spec builders), `provider/` (AI providers), `filer.rs`, `pty_manager.rs`, `scoped_fs.rs`, `error.rs`. Auth / HTTP / realtime (WS + SSE) / dispatch / DB (and the JSON-RPC `notification` builder + error constructors) all come from the spine crates. See ./crates/CLAUDE.md for the full tree.
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
│   ├── models/
│   ├── projects/
│   ├── prompts/
│   ├── providers/
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

Registered in `src/lib/cell_classes.ts` — [docs/reference.md](./docs/reference.md)
has the authoritative generated roster and count. Purposes below (`Socket` is
not a Cell — it's a plain `.svelte.ts` wrapper around fuz_app's
`FrontendWebsocketClient`, so it's not listed):

- `Parts` (`parts.svelte.ts`) — Collection of all parts
- `TextPart` (`part.svelte.ts`) — Direct text content
- `DiskfilePart` (`part.svelte.ts`) — File reference content
- `Capabilities` (`capabilities.svelte.ts`) — Feature capability tracking
- `Chat` (`chat.svelte.ts`) — Chat container with threads
- `Chats` (`chats.svelte.ts`) — Collection of chats
- `Diskfile` (`diskfile.svelte.ts`) — Single file on disk
- `DiskfileTab` (`diskfile_tab.svelte.ts`) — Editor tab for a file
- `DiskfileTabs` (`diskfile_tabs.svelte.ts`) — Tab manager
- `DiskfileHistory` (`diskfile_history.svelte.ts`) — File edit history
- `Diskfiles` (`diskfiles.svelte.ts`) — Collection of disk files
- `DiskfilesEditor` (`diskfiles_editor.svelte.ts`) — Multi-file editor state
- `Model` (`model.svelte.ts`) — AI model definition
- `Models` (`models.svelte.ts`) — Model catalog with indexes
- `Action` (`action.svelte.ts`) — Single action event state
- `Actions` (`actions.svelte.ts`) — Action history
- `Prompt` (`prompt.svelte.ts`) — Reusable prompt template
- `Prompts` (`prompts.svelte.ts`) — Collection of prompts
- `Provider` (`provider.svelte.ts`) — AI provider config
- `Providers` (`providers.svelte.ts`) — Collection of providers
- `Turn` (`turn.svelte.ts`) — Single conversation message
- `Thread` (`thread.svelte.ts`) — Linear conversation with one model
- `Threads` (`threads.svelte.ts`) — Collection of threads
- `Space` (`space.svelte.ts`) — Named grouping of workspace dirs
- `Spaces` (`spaces.svelte.ts`) — Collection of spaces
- `Terminal` (`terminal.svelte.ts`) — PTY terminal process state
- `TerminalPreset` (`terminal_preset.svelte.ts`) — Saved terminal command config
- `Time` (`time.svelte.ts`) — Reactive time state
- `Ui` (`ui.svelte.ts`) — UI state (menus, layout)
- `Workspace` (`workspace.svelte.ts`) — Open workspace directory
- `Workspaces` (`workspaces.svelte.ts`) — Collection of workspaces

## Action Specs

Defined in `src/lib/action_specs.ts`. The full list — method, kind, initiator,
auth, and description — is generated into [docs/reference.md](./docs/reference.md)
from the specs themselves (`src/lib/reference.gen.ts`, refreshed by `gro gen`),
so it can't drift. The test-only `_testing_emit_notifications` +
`_testing_notification` specs live in `src/lib/testing_action_specs.ts` and only
register on the live dispatchers when `ZZZ_ENABLE_TEST_ACTIONS=1`.

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
- `gro format` — Format with Prettier
- `gro build` — Production build

`cargo xtask dev` is the dev command — it builds and runs `zzz_server` plus
the Vite frontend. (The user manages the dev server; don't start it yourself.)

### Rust Backend

The Rust `zzz_server` (Axum) is zzz's backend.
RPC methods: `ping`, `session_load`, `workspace_*`,
`diskfile_update`, `diskfile_delete`, `directory_create`, `terminal_create`,
`terminal_data_send`, `terminal_resize`, `terminal_close`,
`provider_load_status`, `provider_update_api_key` (keeper-only),
`completion_create`, `account_verify`, `account_session_list`,
`account_session_revoke`, `account_session_revoke_all`,
`account_token_create`, `account_token_list`, `account_token_revoke`,
`admin_session_revoke_all`, `admin_token_revoke_all`.
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
unit tests live in the provider modules (`provider/common.rs`,
`provider/sse.rs`, etc.); auth, origin, and trusted-proxy pure functions are
unit-tested in the spine crates (`fuz_auth`, `fuz_http`).

```bash
cargo build -p zzz_server                                                 # Build
cargo clippy -p zzz_server                                                # Lint
./target/debug/zzzd --port 4460                                           # Run (requires DATABASE_URL, SECRET_FUZ_COOKIE_KEYS)
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
	selected_thread_id: Uuid.nullable().default(null),
}).meta({cell_class_name: 'Chat'});

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
	description: 'Write content to a file on disk',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
	side_effects: true,
	input: z.strictObject({
		path: DiskfilePath,
		content: z.string(),
	}),
	output: z.null(),
	async: true,
} satisfies ActionSpecUnion;
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
	auth: null, // public; or {account: 'required', actor: 'none'} to require a session
	side_effects: true, // or null for read-only
	input: z.strictObject({foo: z.string()}),
	output: z.strictObject({bar: z.number()}),
	async: true,
	description: 'What this action does.',
} satisfies ActionSpecUnion;
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
const result = await app.api.my_action({foo: 'hello'});
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
- Every schema field must have a `.default()` for Cell instantiation without full JSON

### State Class Rules

- Schema fields use `$state.raw()!` by default (non-null assertion, set by `init()`)
- Use `$state()!` only for arrays/objects mutated in place (push, splice, index assignment)
- Computed values use `readonly $derived` or `readonly $derived.by(() => ...)` — always `readonly` unless reassignment is explicitly needed
- No `$effect` inside Cell classes — effects belong in components
- Constructor must call `this.init()` as the last statement
- Always register new Cell classes in `cell_classes.ts`

## Code Practices

- `// @slop [Model]` marks LLM-generated code needing review
- `// TODO` for work items, `// TODO @api` for API design questions
- Import from `*.js` extensions (ESM convention): `import {Chat} from './chat.svelte.js'`
- Prefer pure functions; mark mutations with `@mutates` JSDoc tag
- Tests in `src/test/`, split by aspect: `cell.svelte.base.test.ts`, `cell.svelte.decoders.test.ts`
- UI uses `@fuzdev/fuz_css` style variables and semantic classes, not inline styles

## Zzz App Directory

The `.zzz/` directory stores app data. Configured via `PUBLIC_ZZZ_DIR`.

- `state/` — Persistent data (completions, workspaces.json)
- `cache/` — Regenerable data, safe to delete
- `run/` — Runtime ephemeral (daemon.json: PID, port)

All filesystem access goes through `ScopedFs` — path validation, no symlinks, absolute paths only.

## Environment Variables

### Server (BaseServerEnv from fuz_app — ecosystem standard)

- `NODE_ENV` — `development` or `production`
- `PORT` — HTTP server port (default 4460; `cargo xtask dev` uses 4461)
- `HOST` — Bind address (default `localhost`)
- `DATABASE_URL` — PostgreSQL connection (`postgres://`)
- `SECRET_FUZ_COOKIE_KEYS` — HMAC signing keys (min 32 chars)

### zzz-specific server vars

- `FUZ_ALLOWED_ORIGINS` — Origin patterns for API verification
- `FUZ_BOOTSTRAP_TOKEN_PATH` — One-shot admin bootstrap token path
- `PUBLIC_ZZZ_DIR` — Zzz app directory (default `.zzz`)
- `PUBLIC_ZZZ_SCOPED_DIRS` — Comma-separated filesystem paths
- `PUBLIC_ZZZ_BACKEND_ARTIFICIAL_DELAY` — Testing delay (ms)
- `ZZZ_ENABLE_TEST_ACTIONS` — Register `_testing_*` actions on live dispatchers (integration tests only — must stay unset in prod)
- `SECRET_ANTHROPIC_API_KEY` — Claude API key
- `SECRET_OPENAI_API_KEY` — OpenAI API key
- `SECRET_GOOGLE_API_KEY` — Google Gemini API key

### SvelteKit frontend vars (PUBLIC_ZZZ_\*)

- `PUBLIC_ZZZ_SERVER_PROTOCOL` — `http` or `https`
- `PUBLIC_ZZZ_SERVER_HOST` — Server hostname (frontend)
- `PUBLIC_ZZZ_SERVER_PORT` — SvelteKit dev server port
- `PUBLIC_ZZZ_SERVER_API_PATH` — API endpoint path
- `PUBLIC_ZZZ_WEBSOCKET_URL` — WebSocket URL
- `PUBLIC_ZZZ_SERVER_PROXIED_PORT` — Backend port (frontend)

## Avoid

- **Don't start the dev server yourself** — the user manages `cargo xtask dev`
- **Never edit generated outputs** (`action_collections.ts`, `action_metatypes.ts`, `frontend_action_types.ts`, `docs/reference.md`) — edit the `*.gen.ts` generators and run `gro gen`
- **Use `z.strictObject()`** in action specs, not `z.object()` — unknown keys must be rejected
- **No `$effect` in Cell classes** — effects belong in Svelte components only
- **Run `gro gen` after changing action specs** — handler types are generated from specs
- **Register new Cell classes in `cell_classes.ts`** — the registry must be complete
- **Don't import without `.js` extension** — ESM requires explicit extensions

## Known Limitations

- **WebSocket auth** — Auth is enforced at upgrade time via `require_auth` middleware (cookie sessions, bearer tokens — bearer silently discarded in browser context via Origin/Referer defense). Per-action auth checks enforce spec-level auth: `keeper` requires `daemon_token` + keeper role; `{role}` requires the named role via `has_role` (matches the HTTP path). Batch JSON-RPC is rejected (not yet supported). Sockets are closed on session/token revocation, logout, and password change via audit events — `token_revoke` closes only the revoked token's sockets (granular), `session_revoke_all` / `token_revoke_all` / `password_change` close all sockets on the account. No per-message session revalidation — event-driven revocation is sufficient. ActionPeer itself has no auth awareness.
- **Bearer auth soft-fails** — fuz_app's bearer middleware soft-fails for invalid/expired/empty tokens (calls `next()`, no error response). Auth enforcement happens downstream via `check_action_auth` (JSON-RPC) or `require_auth` (routes), producing `{code: -32001, message: "unauthenticated"}` JSON-RPC errors. Public actions are not blocked by bad bearer credentials.
- **Domain state is in-memory** — auth/accounts are in the PostgreSQL DB, but zzz domain state (files, terminals, workspaces) is in-memory, lost on restart. Workspaces persist to JSON file as a stopgap.
- **No undo/history** — file edits are permanent
- **PTY terminals** — terminal spawning uses the `fuz_pty` Rust crate as a native dependency of `zzz_server` (no FFI indirection). `PtyManager` manages spawned processes with async read loops; `terminal_close` cancels the read loop before killing the process. Requires the sibling Rust workspace checked out alongside this repo (path dep).
- **No git integration** — no commit/push/pull from the UI
- **No MCP/A2A** — protocol support planned but not implemented
- **Backend** — `zzz_server` serves the full RPC surface with the full auth stack. `cargo xtask dev` runs it with the Vite frontend. Anthropic, OpenAI, and Gemini providers fully implemented (non-streaming + SSE streaming). No batch JSON-RPC. A single `/api/rpc` + `/api/ws` serves the boot-compiled `ActionRegistry` (handlers in `handlers/`), plus the admin audit-log SSE stream at `GET /api/admin/audit/stream`.

## fuz_app

zzz is the reference implementation for Cell and Action patterns. The SAES
runtime lives in `@fuzdev/fuz_app` — zzz imports ActionSpec, ActionEvent,
ActionDispatcher, transports, and `create_rpc_client` from
`@fuzdev/fuz_app/actions/*.js`. Cell patterns (Cell base class, cell classes,
IndexedCollection) remain in zzz. The generated `TypedActionEvent` alias
intersects fuz_app's generic `ActionEvent` with zzz's `ActionEventDatas` map
for typed input/output in handlers. `Uuid` and `create_uuid` are re-exported
from `@fuzdev/fuz_app/uuid.js` via `zod_helpers.ts`.

The CLI and daemon lifecycle use `@fuzdev/fuz_app/cli/*` helpers: `DaemonInfo`
schema, `write_daemon_info`, `read_daemon_info`, `is_daemon_running`,
`stop_daemon`. The server writes `~/.zzz/run/daemon.json` (not `server.json`).
