# zzz

> nice web things for the tired

`@fuzdev/zzz` — local-first AI forge: chat + files + prompts + terminals in one app.
SvelteKit frontend (static SPA), Rust (Axum) backend, Svelte 5 runes, fuz_schema schemas.
v0.0.1. fuz_app auth stack (sessions, bearer tokens, bootstrap), PostgreSQL DB. Cell + Action patterns (generated roster in ./docs/reference.md), 3 AI providers.

zzz has a single **Rust** backend: `crates/zzz_server` (Axum), whose
`zzzd` binary also serves the frontend — a prerendered static SPA, no JS
runtime in production. The about and docs routes are public; every other
route sits behind the auth gate (./docs/architecture.md § Auth gate).

For coding conventions, see Skill(fuz-stack).

IMPORTANT for AI agents: never deploy or publish zzz. Its releases and deploys
are the user's.

## What zzz Does

1. **Chat** with AI models — multi-thread, multi-model comparison, streaming responses
2. **Edit files** on disk — scoped filesystem, syntax highlighting, multi-tab editor
3. **Build prompts** — reusable content templates composed from text parts and file references
4. **Manage models** — Claude/ChatGPT/Gemini via BYOK API keys
5. **Run terminals** — interactive PTY terminals drawn by zzz's own terminal view over Ghostty's emulator (`fuz_terminal`)
6. **Record and transcribe audio** — the microphone to a file on disk, transcribed on this machine (whisper.cpp)
7. **Symmetric actions** — JSON-RPC 2.0 between frontend and backend, same ActionPeer on both sides

## Key Principles

- **Local-first**: your data stays on your machine, no third-party lock-in; providers are opt-in BYOK
- **Schema-driven**: Every Cell and Action defined by `@fuzdev/fuz_schema` schemas, validated at boundaries
- **Symmetric actions**: Frontend and backend are peers — same ActionPeer code, same spec format
- **Cell pattern**: All state is Cell subclasses with `$state`/`$derived` runes, JSON-serializable

## Development Stage

Early development, v0.0.1; breaking changes are expected and welcome.
PostgreSQL holds auth only; domain state (files, terminals, workspaces, jobs)
is in memory, lost on a daemon restart. Auth, HTTP, realtime (WS + SSE),
dispatch, and DB come from the spine crates (`fuz_db`, `fuz_auth`,
`fuz_http`, `fuz_realtime`, `fuz_actions`); a single `/api/rpc` + `/api/ws`
serves the boot-compiled `ActionRegistry`, with zzz's handlers in
`handlers/`. The `cross_backend_*` vitest projects run fuz_app's shared
suites against `zzz_server` over real HTTP. See ./crates/CLAUDE.md, and
[GitHub issues](https://github.com/fuzdev/zzz/issues) for planned work.

## Docs

- ./docs/architecture.md — actions, cells, content model, data flow, terminals, recording, filesystem and file editing, the app directory, security posture, known limitations
- ./docs/development.md — setup, commands, production build, the `zzz` CLI, environment variables, extension points, patterns, testing
- ./docs/fuz_terminal.md — the terminal emulator binding, renderer, and adapter
- ./docs/backend.md — the Rust backend's internals: each crate, the auth pipeline, the cross-process suites, known issues, design decisions
- ./docs/providers.md — AI provider integration, adding new providers
- ./docs/reference.md — generated action-spec + cell-class tables (`gro gen`)
- ./crates/CLAUDE.md — the Rust backend (`zzzd`), the CLI crate, xtask, the test binary, integration tests

## Repository Structure

```
crates/                         # Rust workspace (./crates/CLAUDE.md)
├── zzz/                        # the CLI (argh): daemon lifecycle, init, open
├── zzz_server/                 # Axum JSON-RPC server → the `zzzd` binary
├── testing_zzz_server/         # test-mode binary (`testing_zzzd`) — never ships in a release
└── xtask/                      # `cargo xtask dev`, env setup, check-release, ghostty-vt
src/
├── lib/                        # library exports of @fuzdev/zzz (not yet on npm)
│   ├── *.svelte.ts             # Cell state classes (registered in cell_classes.ts)
│   ├── action_specs.ts         # action spec definitions
│   ├── *.gen.ts                # generators — `gro gen` writes their outputs
│   ├── fuz_terminal/           # libghostty-vt binding + FuzTerminal.svelte
│   └── *.svelte                # UI components
├── routes/                     # SvelteKit routes, one dir per page
├── env.ts                      # PUBLIC_ZZZ_* declarations (`$app/env/public`)
└── test/                       # tests (not co-located)
```

## Architecture

The two core abstractions are **Cells** (reactive state) and **Actions**
(RPC). Cells hold all application state as Svelte 5 rune classes with
fuz_schema schemas. Actions are symmetric JSON-RPC 2.0, frontend and backend
equal peers. Content model: `Chat → Thread[] → Turn[] → Part[]` (TextPart or
DiskfilePart); prompts also hold Parts. Cell classes are registered in
`src/lib/cell_classes.ts` (purposes in ./docs/architecture.md § Cell
Registry); action specs in `src/lib/action_specs.ts` (the generated table in
./docs/reference.md — zzz's own specs only; the spine methods the backend
registers are listed in ./crates/CLAUDE.md).

### fuz_terminal

`src/lib/fuz_terminal/` binds libghostty-vt (Ghostty's emulator, wasm) in
three layers: the DOM-free binding (`ghostty_*.ts`), the renderer
(`FuzTerminal.svelte`, app-free), and zzz's adapter (`TerminalView.svelte` +
`terminal_view_link.ts`). What a change must not break — each detailed in
./docs/fuz_terminal.md:

- **The manifest, never constants** — enum values, offsets, and option types
  come from `ghostty_manifest.ts`; every `GhosttyResult` is checked.
- **Memory** — retake linear-memory views after any export call that can
  allocate; free scratch on every path.
- **Effects** run synchronously mid-parse; `write`, `resize`, `dispose`, and
  `set_effect` inside one throw `GhosttyReentrancyError`. No clipboard effects.
- **Poisoning** — an escaped exception poisons the instance; recover with a
  fresh one. Each view instantiates its own.
- **One render state per terminal**; grapheme clustering (mode 2027) is on
  for every view (`FUZ_TERMINAL_MODES`).
- **Replays answer nothing** (`{replay: true}`, reply effects unregistered).
- **Acks follow parsing** — a chunk is acked only once the emulator parsed it.
- **Keys** — `should_fuz_terminal_pass_key` decides what the browser keeps;
  Ctrl+C is always the program's.
- **Paste** — only from zzz's context menu, whole or not at all, with
  confirmation for text that could run commands.
- **Global shortcuts** must leave a key whose target is a terminal view to
  the terminal (`is_fuz_terminal_key_target`), as they do a text field's.
- **Classes and layout** — no fuz_css utility class in `FuzTerminal`'s
  output (`FuzTerminal.classes.test.ts`); each run placed at its own column;
  the host gives the view a sized box.
- **Theming** is the `--fuz_terminal_*` custom properties a host sets.

The module isn't committed: `cargo xtask ghostty-vt` builds it (Zig 0.17)
into the gitignored `static/fuz_terminal/ghostty-vt.wasm`, and `cargo xtask
dev` builds it when missing or stale. **`gro build` doesn't notice it
appearing** — run `gro build --force_build` after building the module.

## Development Workflow

```bash
createdb zzz
cargo xtask dev-setup
npm install
cargo xtask dev            # the terminal module if needed, then zzzd + Vite — the user runs it
```

The Rust crates need the sibling Rust workspace checked out alongside this
repo (path deps); terminals need Zig 0.17 (without it the app runs and each
terminal says the module is missing). Node deps via npm; there is no Deno.

- `gro check` — all checks (typecheck, test, gen, format, lint)
- `gro typecheck`, `gro test`, `gro gen`, `gro format`, `gro build`
- `npm run test:cross` — the Rust cross-process suites (needs local Postgres;
  builds `testing_zzzd`, creates its DBs). A bare `gro test` excludes them
  (`FUZ_TEST_CROSS_BACKEND=1` gates them).
- Rust gates: `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, and the doc-link gate `cargo doc --workspace
  --no-deps --document-private-items` (pass = exit code; its
  `private_intra_doc_links` warnings are expected — ./crates/CLAUDE.md
  § Build and Run). CI is Node-only, so the Rust gates run locally.

### Naming Conventions

- TypeScript files — `snake_case.ts` (`action_helpers.ts`)
- Svelte 5 state — `snake_case.svelte.ts` (`chat.svelte.ts`)
- Components — `PascalCase.svelte` (`ChatView.svelte`)
- Tests — `*.test.ts` in `src/test/`, split by aspect (`cell.svelte.base.test.ts`)

## Code Patterns

### Cell Pattern

```typescript
export const ChatJson = cell_json_schema(
	{
		name: with_default(string, ''),
		thread_ids: with_default_fn(array(Uuid), () => []),
		selected_thread_id: with_default(nullable(Uuid), null)
	},
	'Chat'
);

export class Chat extends Cell<typeof ChatJson> {
	name: string = $state.raw()!;
	thread_ids: Array<Uuid> = $state()!; // $state because push/splice used
	selected_thread_id: Uuid | null = $state.raw()!;

	readonly threads: Array<Thread> = $derived.by(() => /* ... */);

	constructor(options: ChatOptions) {
		super(ChatJson, options);
		this.init(); // Must call at end of constructor
	}
}
```

### Adding an Action

1. **Spec** in `src/lib/action_specs.ts` — `method`, `kind`
   (`request_response` / `remote_notification` / `local_call`), `initiator`,
   `auth`, `side_effects`, `input` / `output` schemas, `description`,
   `satisfies` the kind's spec type — and add it to `all_action_specs`.
2. **`gro gen`** — regenerates `action_collections.ts`,
   `action_metatypes.ts`, `frontend_action_types.ts`, and `docs/reference.md`.
3. **Backend** — a spec builder in `zzz_action_specs/` and a handler in
   `handlers/` (./crates/CLAUDE.md); one `ActionRegistry` serves HTTP and WS.
4. **Frontend handler** in `create_frontend_action_handlers(frontend)`
   (`src/lib/frontend_action_handlers.ts`): `receive_response` /
   `receive_error` for requests, `receive` for notifications.
5. **Call** via `app.api.my_action(input)` → `Result<{value}, {error}>`.

Details: ./docs/development.md § Adding a New Action.

### Schema Conventions

- Schemas are `@fuzdev/fuz_schema` (named imports from `@fuzdev/fuz_schema/schema.ts`).
- Action specs use strict `object()` — never `strip_object()` / `loose_object()`.
- Cell schemas use `cell_json_schema({...}, 'ClassName')` (`cell_types.ts`:
  `CellJson`'s entries then the cell's, with `cell_class_name` metadata
  declared on fuz_schema's `SchemaMeta`); the `cell_class_name` equals the
  class's key in `cell_classes.ts` (never `constructor.name`, which
  minification mangles).
- Every field has a default, except identity fields a cell can't exist
  without (`Diskfile.path` / `source_dir`, `DiskfileTab.diskfile_id`,
  `Workspace.path`, `Model.name`, `Action.method`, `Turn.role`).
- An array or object default is `with_default_fn(schema, () => [])` —
  `with_default` shares one value across every parse.
- Schema and class types agree: a non-null class field never defaults to `null`.

### State Class Rules

- Schema fields use `$state.raw()!`; `$state()!` only for arrays/objects
  mutated in place (push, splice, index assignment).
- Computed values are `readonly $derived` / `readonly $derived.by(...)` —
  always `readonly` unless reassignment is explicitly needed.
- No `$effect` in Cell classes — effects belong in components.
- The constructor calls `this.init()` last; register every class in `cell_classes.ts`.
- Cells that outlive a component are never constructed in its init,
  `onMount`, or an `$effect` directly — wrap the construction in
  `create_detached` (`reactive_helpers.svelte.ts`), or their `$derived`s
  freeze when the component unmounts.

## Code Practices

- `// @slop [Model]` marks LLM-generated code needing review; `// TODO` for
  work items, `// TODO @api` for API design questions
- Import the real source extension (`.ts` / `.svelte.ts` / `.svelte`)
- Prefer pure functions; mark mutations with the `@mutates` JSDoc tag
- UI uses fuz_css style variables and semantic classes, not inline styles
- Icons beside text use `Icon` (`Icon.svelte`: a `1em`, inline,
  unshrinkable `Svg`); a bare `Svg` is `var(--font_size, auto)`-sized
  (`auto` outside headings and `font_size_*` classes) and fuz_css makes
  `svg` a block capped at `max-width: 100%`, so use it only with an
  explicit `size`
- A `Contextmenu` wrapper is `display: contents` — put layout classes on an
  inner element, not on the wrapper (it has no `attrs` prop)

## Files, scope, and the app directory

- **All filesystem access goes through `ScopedFs`** — path validation, no
  symlinks, absolute paths only. Roots: the app directory, `PUBLIC_ZZZ_SCOPED_DIRS`,
  and each open workspace.
- **The app directory** (`PUBLIC_ZZZ_DIR`, default `.zzz` under the
  daemon's working directory) holds `cache/`, `recordings/`, `run/`, and a
  reserved `state/`. The CLI's daemon home `~/.zzz/` holds `.env` and
  `bootstrap_token`, so a `.zzz` directory other than the app dir is off
  limits under every root: `ScopedFs` refuses every operation on a path in
  one (`zzz_home_not_allowed` — the file actions and the byte routes alike),
  every filer skips such directories, and `workspace_open` refuses one.
- **Saves are atomic** (staged beside the target, fsynced, renamed),
  falling back to a non-atomic in-place write only when the rename can't
  happen; new files and folders are created exclusively.
- **Byte routes** (`/api/files/bytes`) read, create, and append file bytes
  for media; serving never executes bytes.
- **Local tools** (`ffmpeg`, whisper.cpp) are found once at boot and are
  never given the audio file's path (`ffmpeg` reads and writes only handles
  `zzzd` opened); transcription is a daemon-side **job**.

Detail: ./docs/architecture.md § Zzz App Directory, § Filesystem, § File
Editing, § Recording; ./docs/backend.md § Design Decisions.

## Environment Variables

`zzzd` reads only its process environment. The `zzz` CLI supplies it from
`~/.zzz/.env` (the process env wins); `cargo xtask dev` from
`.env.development` (the file wins). A blank value is unset everywhere.

- Required: `DATABASE_URL`, `SECRET_FUZ_COOKIE_KEYS`, `FUZ_ALLOWED_ORIGINS`
  (exact origins; wildcards refuse to boot unless `FUZ_ALLOW_ORIGIN_WILDCARDS=true`)
- Server: `ZZZ_PORT` (default 4460; dev 4461; loopback bind, no `HOST`),
  `ZZZ_STATIC_DIR`, `ZZZ_TRUSTED_PROXIES`, `PUBLIC_ZZZ_DIR`,
  `PUBLIC_ZZZ_SCOPED_DIRS`, `FUZ_BOOTSTRAP_TOKEN_PATH`,
  `FUZ_DB_CHECKOUT_TIMEOUT_MS`, `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS`
- Tools: `ZZZ_FFMPEG_BIN`, `ZZZ_WHISPER_CPP_BIN`, `ZZZ_WHISPER_CPP_MODEL`
- Providers: `SECRET_ANTHROPIC_API_KEY`, `SECRET_OPENAI_API_KEY`, `SECRET_GOOGLE_API_KEY`
- Tests only: `ZZZ_ENABLE_TEST_ACTIONS` (never in prod; the CLI never passes it)
- Frontend (baked in by `gro build`, `src/env.ts`): `PUBLIC_ZZZ_SERVER_*`
  and `PUBLIC_ZZZ_WEBSOCKET_URL` — protocol, host, port, and the WebSocket
  URL stay empty in production, so the UI uses the page's origin
- CLI only: `ZZZ_SERVER_BIN`, `ZZZ_OPENER`

PTY terminals don't get `SECRET_*`, `FUZ_*`, `ZZZ_*`, `PUBLIC_ZZZ_*`,
`DATABASE_URL`, or `PORT`. Every variable's rules: ./docs/development.md
§ Environment Variables.

## The CLI

`zzz` (crate `crates/zzz`) starts or finds the daemon (`~/.zzz/` home,
port 4460) and opens the UI — the browser, or a configured opener; `zzz
<path>` opens a workspace; `zzz daemon start|stop|status`; `zzz init`. It
never searches the current directory for `zzzd` or an opener, so an
untrusted checkout can't get its own binary run with your secrets. Full
rules (discovery, env, port, exit codes, `daemon.json`, the opener):
./docs/development.md § The `zzz` CLI.

## Avoid

- **Never edit generated outputs** (`action_collections.ts`, `action_metatypes.ts`, `frontend_action_types.ts`, `docs/reference.md`) — edit the `*.gen.ts` generators and run `gro gen`
- **Use `object()`** in action specs, not `strip_object()` / `loose_object()`
- **No `$effect` in Cell classes** — effects belong in Svelte components only
- **Run `gro gen` after changing action specs** — handler types are generated from specs
- **Register new Cell classes in `cell_classes.ts`**
- **Don't omit import extensions**

## Security posture

zzz is a single-operator local app: one person, their own machine, the
daemon running as their OS user on loopback. **Every session and every
full-scope API token has the daemon user's powers** — terminals, opening
any directory as a workspace (except a `.zzz` directory other than the app
dir), file reads and writes in scope. Accounts keep
other OS users' processes and other browser origins out, not same-user
processes, and don't separate accounts from each other.

Only zzz's own UI can drive the daemon from a browser: every request passes
an **Origin** allowlist (`FUZ_ALLOWED_ORIGINS`), a **Host** check (against
DNS rebinding), and a refusal of **CORS-simple POSTs** (pinned by
`browser_gates.cross.test.ts`). The allowlist names only origins that are
zzz's own. Full posture, the gates, and the dev and prod origins:
./docs/architecture.md § Security posture.

## Known Limitations

The main ones; detail in ./docs/architecture.md § Known Limitations:

- **Domain state is in memory** — lost on a daemon restart; the frontend
  resyncs after every reconnect.
- **Chats, prompts, and terminal presets** live in page memory, lost on reload.
- **WebSocket auth** at upgrade only, with event-driven revocation; at most
  50 sockets per account; no batch JSON-RPC.
- **Message caps** — 16 MiB per JSON-RPC message, 32 MiB outbound queue per
  socket; terminal output is paced by acks.
- **Every indexed file's contents** ship on open and resync; files over
  4 MiB or not UTF-8 arrive unloaded and read-only.
- **No persistent undo**; symlinks are invisible; file watching can degrade
  to polling past `max_user_watches`.
- **The terminal emulator** lacks scrollback scrolling, IME, and mouse
  reporting; paste is from the context menu only.
- **Recording** is one at a time per tab; **transcription** is batch, needs
  `ffmpeg`, whisper.cpp, and a model.
- **No git integration, no MCP/A2A** yet.

## fuz_app

zzz is the reference implementation for Cell and Action patterns. The SAES
runtime lives in `@fuzdev/fuz_app` — zzz imports ActionSpec, ActionEvent,
ActionDispatcher, transports, and `create_rpc_client` from
`@fuzdev/fuz_app/actions/*.ts`; Cells and IndexedCollection stay in zzz.
The generated `TypedActionEvent` intersects fuz_app's `ActionEvent` with
zzz's `ActionEventDatas`. `Uuid` / `create_uuid` come from
`@fuzdev/fuz_app/primitive_schemas.ts`; `Datetime`, `DatetimeNow`, and
`get_datetime_now` are zzz's own (`datetime.ts`). The Cell framework reads schemas through
`@fuzdev/fuz_schema/introspect.ts`. `~/.zzz/run/daemon.json` (written by
`crates/zzz/src/daemon_lifecycle.rs`) follows fuz_app's `DaemonInfo` by
convention — patterns only, no code reuse — plus `boot_id` and `pid_start_ticks`
(hence `version: 2`).
