# zzz

> nice web things for the tired

`@fuzdev/zzz` — local-first AI forge: chat + files + prompts + terminals in one app.
SvelteKit frontend, Hono/Deno backend, Svelte 5 runes, Zod schemas.
v0.0.1, no auth, no database yet. 32 cell classes, 29 action specs, 4 AI providers.

For coding conventions, see [`fuz-stack`](../fuz-stack/CLAUDE.md).

## What zzz Does

1. **Chat** with AI models — multi-thread, multi-model comparison, streaming responses
2. **Edit files** on disk — scoped filesystem, syntax highlighting, multi-tab editor
3. **Build prompts** — reusable content templates composed from text parts and file references
4. **Manage models** — Ollama local models + Claude/ChatGPT/Gemini via BYOK API keys
5. **Run terminals** — interactive PTY terminals via xterm.js with preset commands, contextmenu copy, and restart
6. **Symmetric actions** — JSON-RPC 2.0 between frontend and backend, same ActionPeer on both sides

## Key Principles

- **Local-first**: Ollama for local AI, sensitive data stays on your machine, no third-party lock-in
- **Schema-driven**: Every Cell and Action defined by Zod schemas, validated at boundaries
- **Symmetric actions**: Frontend and backend are peers — same ActionPeer code, same spec format
- **Cell pattern**: All state is Cell subclasses with `$state`/`$derived` runes, JSON-serializable

## Development Stage

Early development, v0.0.1. Breaking changes are expected and welcome. No authentication — development use only. All state is in-memory (no database yet). The Hono/Deno backend is the reference implementation. A Rust backend (`crates/zzz_server`) is in development — Phase 1 (ping, static files, integration test harness) is complete. Long-term the CLI and daemon migrate to Rust fuz/fuzd.

See [GitHub issues](https://github.com/fuzdev/zzz/issues) for planned work.

## CLI

zzz has a Deno-compiled CLI binary for daemon management and browser launching.
See [src/lib/zzz/CLAUDE.md](src/lib/zzz/CLAUDE.md) for full CLI architecture.

```bash
zzz                          # start daemon if needed, open browser
zzz ~/dev/                   # open workspace at ~/dev/
zzz daemon start             # start daemon (foreground)
zzz daemon status            # show daemon info
zzz init                     # initialize ~/.zzz/
```

The global daemon runs on port 4460 with state at `~/.zzz/`. Built via
`gro_plugin_deno_compile` (see `gro.config.ts` and `deno.json`).

## Docs

- [docs/architecture.md](docs/architecture.md) — Action system, Cell system, content model, data flow
- [docs/development.md](docs/development.md) — Development workflow, extension points, patterns
- [docs/providers.md](docs/providers.md) — AI provider integration, adding new providers
- [src/lib/server/CLAUDE.md](src/lib/server/CLAUDE.md) — Backend server architecture, providers, security
- [src/lib/zzz/CLAUDE.md](src/lib/zzz/CLAUDE.md) — CLI architecture, commands, runtime abstraction
- [crates/CLAUDE.md](crates/CLAUDE.md) — Rust backend (zzz_server)

## Repository Structure

```
crates/                               # Rust workspace
│   ├── CLAUDE.md                     # Rust backend docs
│   └── zzz_server/                   # Axum JSON-RPC server (Phase 1: ping only)
│       └── src/
│           ├── main.rs               # Entry point, arg parsing, graceful shutdown
│           ├── rpc.rs                # JSON-RPC types, dispatch, HTTP handler
│           ├── ws.rs                 # WebSocket handler
│           └── error.rs              # Error types
test/
│   └── integration/                  # Cross-backend integration tests (Deno)
│       ├── run.ts                    # Test runner (--backend=deno|rust|both)
│       ├── config.ts                 # Backend configurations
│       └── tests.ts                  # Test cases
src/
├── lib/                          # Published as @fuzdev/zzz
│   ├── server/                   # Backend (Hono/Deno reference impl)
│   │   ├── backend.ts
│   │   ├── server.ts            # Deno server entry (dev + production)
│   │   ├── backend_action_handlers.ts
│   │   ├── backend_provider_*.ts # Ollama, Claude, ChatGPT, Gemini
│   │   ├── pty_ffi.ts              # Deno FFI bindings for libfuz_pty.so
│   │   ├── backend_pty_manager.ts  # PTY process management (FFI or fallback)
│   │   ├── scoped_fs.ts
│   │   ├── security.ts
│   │   └── backend_action_types.gen.ts
│   │
│   ├── zzz/                      # CLI (Deno compiled binary)
│   │   ├── main.ts              # Entry point (deno compile target)
│   │   ├── cli.ts               # Arg parsing wrapper
│   │   ├── cli_config.ts        # ~/.zzz/config.json
│   │   ├── runtime/             # ZzzRuntime abstraction
│   │   ├── cli/                 # CLI infrastructure
│   │   └── commands/            # init, daemon, open, status
│   │
│   ├── *.svelte.ts               # Cell state classes (28 classes)
│   ├── action_specs.ts           # All 29 action spec definitions
│   ├── action_event.ts           # Action lifecycle state machine
│   ├── action_peer.ts            # Symmetric send/receive
│   ├── cell.svelte.ts            # Base Cell class
│   ├── cell_classes.ts           # Cell class registry
│   ├── indexed_collection.svelte.ts
│   │
│   ├── *.svelte                  # UI components
│   ├── action_collections.gen.ts # Generated
│   ├── frontend_action_types.gen.ts
│   └── action_metatypes.gen.ts
│
├── routes/                       # SvelteKit routes (17 dirs)
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
├── test/                         # Tests (not co-located)
│   ├── cell.svelte.*.test.ts
│   ├── action_event.test.ts
│   ├── indexed_collection.svelte.*.test.ts
│   └── ...
│
└── routes/library.gen.ts         # Generated route metadata
```

## Architecture

The two core abstractions are **Cells** (reactive state) and **Actions** (RPC). Cells hold all application state as Svelte 5 rune classes with Zod schemas. Actions provide symmetric JSON-RPC 2.0 communication where frontend and backend are equal peers.

Content model: `Chat → Thread[] → Turn[] → Part[]` (TextPart or DiskfilePart). Prompts also hold Parts.

See [docs/architecture.md](docs/architecture.md) for detailed data flow, content model, and IndexedCollection docs.

## Cell Classes

32 registered classes in `src/lib/cell_classes.ts`:

| Class            | Source file                    | Purpose                              |
| ---------------- | ------------------------------ | ------------------------------------ |
| `Parts`          | `parts.svelte.ts`             | Collection of all parts              |
| `TextPart`       | `part.svelte.ts`              | Direct text content                  |
| `DiskfilePart`   | `part.svelte.ts`              | File reference content               |
| `Capabilities`   | `capabilities.svelte.ts`      | Feature capability tracking          |
| `Chat`           | `chat.svelte.ts`              | Chat container with threads          |
| `Chats`          | `chats.svelte.ts`             | Collection of chats                  |
| `Diskfile`       | `diskfile.svelte.ts`          | Single file on disk                  |
| `DiskfileTab`    | `diskfile_tab.svelte.ts`      | Editor tab for a file                |
| `DiskfileTabs`   | `diskfile_tabs.svelte.ts`     | Tab manager                          |
| `DiskfileHistory`| `diskfile_history.svelte.ts`  | File edit history                    |
| `Diskfiles`      | `diskfiles.svelte.ts`         | Collection of disk files             |
| `DiskfilesEditor`| `diskfiles_editor.svelte.ts`  | Multi-file editor state              |
| `Model`          | `model.svelte.ts`             | AI model definition                  |
| `Models`         | `models.svelte.ts`            | Model catalog with indexes           |
| `Action`         | `action.svelte.ts`            | Single action event state            |
| `Actions`        | `actions.svelte.ts`           | Action history                       |
| `Prompt`         | `prompt.svelte.ts`            | Reusable prompt template             |
| `Prompts`        | `prompts.svelte.ts`           | Collection of prompts                |
| `Provider`       | `provider.svelte.ts`          | AI provider config                   |
| `Providers`      | `providers.svelte.ts`         | Collection of providers              |
| `Socket`         | `socket.svelte.ts`            | WebSocket connection state           |
| `Turn`           | `turn.svelte.ts`              | Single conversation message          |
| `Thread`         | `thread.svelte.ts`            | Linear conversation with one model   |
| `Threads`        | `threads.svelte.ts`           | Collection of threads                |
| `Terminal`       | `terminal.svelte.ts`          | PTY terminal process state           |
| `TerminalPreset` | `terminal_preset.svelte.ts`   | Saved terminal command config        |
| `Time`           | `time.svelte.ts`              | Reactive time state                  |
| `Ui`             | `ui.svelte.ts`                | UI state (menus, layout)             |
| `Workspace`      | `workspace.svelte.ts`         | Open workspace directory             |
| `Workspaces`     | `workspaces.svelte.ts`        | Collection of workspaces             |

## Action Specs

29 specs in `src/lib/action_specs.ts`:

| Method                   | Kind                  | Initiator  | Purpose                          |
| ------------------------ | --------------------- | ---------- | -------------------------------- |
| `ping`                   | `request_response`    | `both`     | Health check                     |
| `session_load`           | `request_response`    | `frontend` | Load initial session data        |
| `filer_change`           | `remote_notification` | `backend`  | File system change notification  |
| `diskfile_update`        | `request_response`    | `frontend` | Write file content               |
| `diskfile_delete`        | `request_response`    | `frontend` | Delete a file                    |
| `directory_create`       | `request_response`    | `frontend` | Create a directory               |
| `completion_create`      | `request_response`    | `frontend` | Start AI completion              |
| `completion_progress`    | `remote_notification` | `backend`  | Stream completion chunks         |
| `ollama_progress`        | `remote_notification` | `backend`  | Ollama model operation progress  |
| `toggle_main_menu`       | `local_call`          | `frontend` | Toggle main menu UI              |
| `ollama_list`            | `request_response`    | `frontend` | List local Ollama models         |
| `ollama_ps`              | `request_response`    | `frontend` | List running Ollama models       |
| `ollama_show`            | `request_response`    | `frontend` | Show Ollama model details        |
| `ollama_pull`            | `request_response`    | `frontend` | Pull Ollama model                |
| `ollama_delete`          | `request_response`    | `frontend` | Delete Ollama model              |
| `ollama_copy`            | `request_response`    | `frontend` | Copy Ollama model                |
| `ollama_create`          | `request_response`    | `frontend` | Create Ollama model              |
| `ollama_unload`          | `request_response`    | `frontend` | Unload Ollama model from memory  |
| `provider_load_status`   | `request_response`    | `frontend` | Check provider availability      |
| `provider_update_api_key`| `request_response`    | `frontend` | Update provider API key          |
| `terminal_create`        | `request_response`    | `frontend` | Spawn PTY terminal process       |
| `terminal_data_send`     | `request_response`    | `frontend` | Send stdin to terminal           |
| `terminal_data`          | `remote_notification` | `backend`  | Stream stdout/stderr to frontend |
| `terminal_resize`        | `request_response`    | `frontend` | Update PTY dimensions            |
| `terminal_close`         | `request_response`    | `frontend` | Kill terminal process            |
| `workspace_open`         | `request_response`    | `frontend` | Open workspace directory         |
| `workspace_close`        | `request_response`    | `frontend` | Close workspace directory        |
| `workspace_list`         | `request_response`    | `frontend` | List open workspaces             |
| `workspace_changed`      | `remote_notification` | `backend`  | Workspace open/close notification|

## Development Workflow

### Setup

```bash
deno task dev:setup
npm install

# Optional: build fuz_pty for real PTY support (echo, prompts, colors, resize)
# Without this, terminals fall back to Deno.Command pipes (no interactivity)
cd ~/dev/private_fuz && cargo build -p fuz_pty --release
```

### Daily Commands

| Command         | Purpose                                    |
| --------------- | ------------------------------------------ |
| `gro check`     | All checks (typecheck, test, gen, format, lint) |
| `gro typecheck` | Type checking only (faster iteration)      |
| `gro test`      | Run Vitest unit tests                      |
| `deno task test` | All tests (Vitest + integration)            |
| `deno task test:integration` | Cross-backend parity tests (Rust + Deno) |
| `gro gen`       | Regenerate `*.gen.ts` files                |
| `gro format`    | Format with Prettier                       |
| `gro build`     | Production build                           |

### Rust Backend

Shadow implementation of the Deno server using axum. Phase 1: only `ping`,
no auth, no DB. The Deno server is ground truth — 18 integration tests verify
both backends produce identical JSON-RPC responses.

```bash
cargo build -p zzz_server                          # Build
cargo clippy -p zzz_server                         # Lint
./target/debug/zzz_server --port 1174              # Run (add --static-dir ./build after gro build)
deno task test:integration --backend=rust           # Integration tests (Rust)
deno task test:integration --backend=deno           # Integration tests (Deno)
deno task test:integration --backend=both           # Both (default, shows comparison)
deno task test:integration --filter=ping            # Substring match on test name
```

Requires `~/dev/private_fuz` as a sibling directory (path deps).
See [crates/CLAUDE.md](crates/CLAUDE.md) for architecture, endpoints,
prerequisites, and what the integration tests check.

### Naming Conventions

| Thing            | Convention             | Example                |
| ---------------- | ---------------------- | ---------------------- |
| TypeScript files | `snake_case.ts`        | `action_peer.ts`       |
| Svelte 5 state   | `snake_case.svelte.ts` | `chat.svelte.ts`       |
| Components       | `PascalCase.svelte`    | `ChatView.svelte`      |
| Tests            | `*.test.ts` in `src/test/` | `cell.svelte.base.test.ts` |

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
  auth: 'public',
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

| Kind                  | Transport        | Pattern                         |
| --------------------- | ---------------- | ------------------------------- |
| `request_response`    | HTTP or WebSocket | Frontend sends, backend replies |
| `remote_notification` | WebSocket only    | Backend pushes to frontend      |
| `local_call`          | None (in-process) | Frontend-only                   |

### Adding an Action (End-to-End)

Adding a new action touches up to 6 files. Here's the full workflow:

**1. Define the spec** in `src/lib/action_specs.ts`:

```typescript
export const my_action_spec = {
  method: 'my_action',
  kind: 'request_response',       // or 'remote_notification', 'local_call'
  initiator: 'frontend',          // or 'backend', 'both'
  auth: 'public',
  side_effects: true,             // or null for read-only
  input: z.strictObject({ foo: z.string() }),
  output: z.strictObject({ bar: z.number() }),
  async: true,
  description: 'What this action does.',
} satisfies ActionSpecUnion;
```

Add it to the `all_action_specs` array at the bottom of the file.

**2. Run `gro gen`** — regenerates 4 files:
- `action_collections.ts` — `ActionInputs`/`ActionOutputs` type maps
- `action_metatypes.ts` — `ActionMethod` union, `ActionsApi` interface
- `frontend_action_types.ts` — `FrontendActionHandlers` type
- `server/backend_action_types.ts` — `BackendActionHandlers` type

**3. Add backend handler** in `src/lib/server/backend_action_handlers.ts`:

```typescript
my_action: {
  receive_request: async ({backend, data: {input}}) => {
    // input is typed from the spec's input schema
    return {bar: 42}; // must match spec's output schema
  },
},
```

**4. Add frontend handler** in `src/lib/frontend_action_handlers.ts`:

```typescript
my_action: {
  // For request_response:
  receive_response: ({app, data: {output}}) => { /* handle success */ },
  receive_error: ({data: {error}}) => { /* handle error */ },
  // For remote_notification:
  receive: ({app, data: {input}}) => { /* handle notification */ },
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

**6. For `remote_notification` actions**, also add to `BackendActionsApi`
in `src/lib/server/backend_actions_api.ts` — follow the `terminal_data`
or `completion_progress` pattern.

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

| Subdirectory | Purpose                                |
| ------------ | -------------------------------------- |
| `state/`     | Persistent data (completions, workspaces.json) |
| `cache/`     | Regenerable data, safe to delete       |
| `run/`       | Runtime ephemeral (daemon.json: PID, port) |

All filesystem access goes through `ScopedFs` — path validation, no symlinks, absolute paths only.

## Environment Variables

From `.env.development.example`:

| Variable                              | Purpose                                    |
| ------------------------------------- | ------------------------------------------ |
| `PUBLIC_ZZZ_DIR`                      | Zzz app directory (default `.zzz`)         |
| `PUBLIC_ZZZ_SCOPED_DIRS`              | Comma-separated user file paths            |
| `PUBLIC_SERVER_PROTOCOL`              | `http` or `https`                          |
| `PUBLIC_SERVER_HOST`                  | Server hostname                            |
| `PUBLIC_SERVER_PORT`                  | SvelteKit dev server port                  |
| `PUBLIC_SERVER_API_PATH`              | API endpoint path                          |
| `PUBLIC_WEBSOCKET_URL`               | WebSocket URL                              |
| `PUBLIC_SERVER_PROXIED_PORT`          | Hono backend port                          |
| `PUBLIC_BACKEND_ARTIFICIAL_RESPONSE_DELAY` | Testing delay in ms                  |
| `ALLOWED_ORIGINS`                     | Origin allowlist patterns                  |
| `SECRET_OPENAI_API_KEY`              | OpenAI API key                             |
| `SECRET_ANTHROPIC_API_KEY`           | Anthropic API key                          |
| `SECRET_GOOGLE_API_KEY`              | Google Gemini API key                      |
| `SECRET_GITHUB_API_TOKEN`            | GitHub API token                           |

## Avoid

- **Never run `gro dev`** — the user manages the dev server
- **Never edit `*.gen.ts` files** — they are regenerated by `gro gen`
- **Use `z.strictObject()`** in action specs, not `z.object()` — unknown keys must be rejected
- **No `$effect` in Cell classes** — effects belong in Svelte components only
- **Run `gro gen` after changing action specs** — handler types are generated from specs
- **Register new Cell classes in `cell_classes.ts`** — the registry must be complete
- **Don't import without `.js` extension** — ESM requires explicit extensions

## Known Limitations

- **No authentication** — development use only, localhost-only binding enforced. Host header validation and origin checking provide defense-in-depth. Bearer token auth planned.
- **No database** — all state is in-memory, lost on restart (pglite planned). Workspaces persist to JSON file as a stopgap
- **No undo/history** — file edits are permanent
- **PTY via FFI** — real PTY support via `fuz_pty` Rust crate loaded through Deno FFI (`forkpty()`). Requires `cargo build -p fuz_pty --release` in `~/dev/private_fuz/`. For bundled binaries, place `libfuz_pty.so` next to the `zzz` executable. Falls back to `Deno.Command` pipes (no echo, no prompt) if `.so` not found
- **No git integration** — no commit/push/pull from the UI
- **No MCP/A2A** — protocol support planned but not implemented
- **Rust backend is Phase 1** — only `ping` action implemented; no auth, no DB, no action system. Batch JSON-RPC requests not yet supported. See [Rust Backends quest](../grimoire/quests/rust-backends.md) for roadmap

## fuz_app

zzz is the reference implementation for Cell and Action patterns. ActionSpec
types have been extracted to `@fuzdev/fuz_app` — zzz imports them from
`@fuzdev/fuz_app/actions/action_spec.js` and `@fuzdev/fuz_app/actions/action_registry.js`.
Cell patterns and the full SAES runtime (ActionEvent, ActionPeer, transports)
remain in zzz until a second consumer needs them (DA-5).

The CLI and daemon lifecycle use `@fuzdev/fuz_app/cli/*` helpers: `DaemonInfo`
schema, `write_daemon_info`, `read_daemon_info`, `is_daemon_running`,
`stop_daemon`. The server writes `~/.zzz/run/daemon.json` (not `server.json`).

Last updated: 2026-03-16
