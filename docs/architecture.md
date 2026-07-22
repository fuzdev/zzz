# Architecture

Core systems: actions, cells, content model, data flow, terminals, indexed collections, filesystem, file editing, spaces and workspaces, capabilities.

## Action System

Symmetric peer-to-peer JSON-RPC 2.0 — by design either end can initiate. The frontend runs the TypeScript `ActionDispatcher` (from `@fuzdev/fuz_app`); the Rust `zzz_server` backend implements the same spec + wire contract via `fuz_actions`.

### Action Spec

Every action is a plain object with Zod schemas. Defined in `src/lib/action_specs.ts`:

```typescript
export const completion_create_action_spec = {
	method: 'completion_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: z.strictObject({
		completion_request: CompletionRequest,
		_meta: z.looseObject({ progressToken: Uuid.optional() }).optional()
	}),
	output: z.strictObject({
		completion_response: CompletionResponse,
		_meta: z.looseObject({ progressToken: Uuid.optional() }).optional()
	}),
	async: true
} satisfies ActionSpecUnion;
```

### Action Kinds

- `request_response` — Standard RPC. Phases: `send_request` → `receive_request` → `send_response` → `receive_response`. Transport: HTTP or WebSocket
- `remote_notification` — Backend → frontend push (progress, broadcast). Phases: `send` → `receive`. Transport: WebSocket only
- `local_call` — Frontend-only UI actions. Phases: `execute`. Transport: None

`remote_notification` actions have two routing paths on the backend:

- **Request-scoped** (`ctx.notify(method, params)` from a handler) — delivered
  only to the originating socket. Used for progress streams tied to an
  in-flight request (`completion_progress`). Specs that use
  this pattern set `streams: '<notification_method>'` to name the companion
  notification.
- **Broadcast** (`backend.api.<method>(input)`) — fanned out to all connected
  sockets. Used for server-wide events that every client needs
  (`filer_change`, `workspace_changed`, `terminal_data`, `terminal_exited`).

### Action Spec Fields

- `method` (`string`) — Action name (e.g. `'completion_create'`)
- `kind` (`ActionKind`) — `'request_response'` | `'remote_notification'` | `'local_call'`
- `initiator` (`ActionInitiator`) — `'frontend'` | `'backend'` | `'both'`
- `auth` (`RouteAuth | null`) — `{account, actor, roles?, credential_types?}` | `null` (four-axis flat record)
- `side_effects` (`boolean | null`) — Whether action mutates state
- `input` (`z.ZodType`) — Zod schema for request params
- `output` (`z.ZodType`) — Zod schema for response
- `async` (`boolean`) — Whether handler is async
- `streams` (`string` (optional)) — Name of companion `remote_notification` method this action emits via `ctx.notify` (e.g. `'completion_progress'`)

### Core Components

- `ActionSpec` (`action_spec.ts`) — Action metadata schema
- `ActionEvent` (`action_event.ts`) — Lifecycle state machine (initial → parsed → handling → handled/failed)
- `ActionDispatcher` (`action_dispatcher.ts`) — Send/receive on both sides
- `ActionRegistry` (`action_registry.ts`) — Type-safe action lookup

These live in `@fuzdev/fuz_app/actions/` — the SAES runtime is extracted to fuz_app; zzz imports them. Cell patterns (the `Cell` base class, `IndexedCollection`) remain in zzz.

### Action Event Lifecycle

```
Steps:   initial → parsed → handling → handled (or failed)
```

```typescript
const event = create_action_event(environment, spec, input, 'send_request');
await event.parse().handle_async();
```

### Handler Registration

Frontend and backend register handlers per action per phase:

```typescript
// Frontend (frontend_action_handlers.ts)
// Handlers are built by a factory that closes over the `Frontend` instance:
export const create_frontend_action_handlers = (frontend: Frontend): FrontendActionHandlers => ({
	completion_create: {
		send_request: ({ data: { input } }) => {
			console.log('sending prompt:', input.completion_request.prompt);
		},
		receive_response: ({ data: { input, output } }) => {
			const progress_token = input._meta?.progressToken;
			if (progress_token) {
				const turn = frontend.cell_registry.all.get(progress_token);
				if (turn instanceof Turn) {
					turn.content = to_completion_response_text(output.completion_response) || '';
					turn.response = output.completion_response;
				}
			}
		},
		receive_error: ({ data: { error } }) => {
			console.error('completion failed:', error);
		}
	}
});

// The matching backend handler lives in
// the Rust `zzz_server` (`crates/zzz_server/src/handlers/`), registered into
// the spine `ActionRegistry`. It receives `(params, ActionContext, Arc<App>)`,
// looks up the provider, and streams `completion_progress` chunks to the
// originating socket via `ConnectionRegistry::send_to(ctx.connection_id, …)`.
// See ../crates/CLAUDE.md for the backend handler patterns.
```

### Transport Layer

Actions are transport-agnostic via the `Transport` interface (from `@fuzdev/fuz_app/actions/`):

```typescript
interface Transport {
	transport_name: TransportName;
	send(message: JsonrpcRequest): Promise<JsonrpcResponseOrError>;
	send(message: JsonrpcNotification): Promise<JsonrpcErrorMessage | null>;
	is_ready: () => boolean;
}
```

Frontend implementations: `FrontendHttpTransport`, `FrontendWebsocketTransport`. The Rust backend serves the matching `/api/rpc` + `/api/ws` endpoints directly.

### JSON-RPC 2.0

MCP-compatible subset, no batching:

```typescript
// Request:     { jsonrpc: "2.0", id: "uuid", method: "completion_create", params: {...} }
// Response:    { jsonrpc: "2.0", id: "uuid", result: {...} }
// Error:       { jsonrpc: "2.0", id: "uuid", error: { code: -32000, message: "..." } }
// Notification (no id): { jsonrpc: "2.0", method: "completion_progress", params: {...} }
```

### Actions

Defined in `src/lib/action_specs.ts`. A representative subset below — the `terminal_*` and `workspace_*` families are omitted here; see [reference.md](./reference.md) (generated from the specs) for the full list:

- `ping` — Health check. Kind: `request_response`. Initiator: `both`
- `session_load` — Load initial session data. Kind: `request_response`. Initiator: `frontend`
- `filer_change` — File system change notification. Kind: `remote_notification`. Initiator: `backend`
- `diskfile_update` — Write file content. Kind: `request_response`. Initiator: `frontend`
- `diskfile_delete` — Delete a file. Kind: `request_response`. Initiator: `frontend`
- `directory_create` — Create a directory. Kind: `request_response`. Initiator: `frontend`
- `completion_create` — Start AI completion. Kind: `request_response`. Initiator: `frontend`
- `completion_progress` — Stream completion chunks. Kind: `remote_notification`. Initiator: `backend`
- `toggle_main_menu` — Toggle main menu UI. Kind: `local_call`. Initiator: `frontend`
- `provider_load_status` — Check provider availability. Kind: `request_response`. Initiator: `frontend`
- `provider_update_api_key` — Update provider API key. Kind: `request_response`. Initiator: `frontend`

## Cell System

Schema-driven reactive data models using Svelte 5 runes.

### Base Cell Class

From `cell.svelte.ts`:

```typescript
export abstract class Cell<TSchema extends z.ZodType = z.ZodType> implements CellJson {
  readonly cid = ++global_cell_count; // monotonic client-side ordering

  // Base properties from CellJson — $state.raw() by default
  id: Uuid = $state.raw()!;
  created: Datetime = $state.raw()!;
  updated: Datetime = $state.raw()!;

  readonly schema!: TSchema;
  readonly schema_keys: Array<SchemaKeys<TSchema>> = $derived(...);
  readonly json: z.output<TSchema> = $derived(this.to_json());
  readonly json_serialized: string = $derived(JSON.stringify(this.json));

  readonly app: Frontend;
  protected decoders: CellValueDecoder<TSchema> = {};

  constructor(schema: TSchema, options: CellOptions<TSchema>) { ... }
  protected init(): void { ... }  // Must call at end of subclass constructor
  dispose(): void { ... }
  set_json(json: z.input<TSchema>): void { ... }
  set_json_partial(partial: Partial<...>): void { ... }
  protected register(): void { ... }  // Called by init()
  protected unregister(): void { ... }
}
```

### CellOptions

```typescript
interface CellOptions<TSchema extends z.ZodType> {
	app: Frontend; // Root app state reference
	json?: z.input<TSchema>; // Initial JSON data (parsed by schema)
}
```

### Creating a Cell

Real example from `chat.svelte.ts`:

```typescript
// 1. Schema with CellJson base — every field has .default()
export const ChatJson = CellJson.extend({
	name: z.string().default(''),
	thread_ids: z.array(Uuid).default(() => []),
	main_input: z.string().default(''),
	view_mode: z.enum(['simple', 'multi']).default('simple'),
	selected_thread_id: Uuid.nullable().default(null)
}).meta({ cell_class_name: 'Chat' });

// 2. Class: $state.raw by default, $state only for in-place-mutated arrays
export class Chat extends Cell<typeof ChatJson> {
	name: string = $state.raw()!;
	thread_ids: Array<Uuid> = $state()!; // $state because push/splice used
	main_input: string = $state.raw()!;
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

	readonly enabled_threads = $derived(this.threads.filter((t) => t.enabled));

	constructor(options: ChatOptions) {
		super(ChatJson, options);
		this.init(); // Must call at end
	}
}
```

### Custom Decoders

For complex field deserialization, override `this.decoders` before `init()`:

```typescript
constructor(options: ThreadOptions) {
  super(ThreadJson, options);

  this.decoders = {
    turns: (items) => {
      if (Array.isArray(items)) {
        this.turns.clear();
        for (const json of items) {
          this.add_turn(json);
        }
      }
      return HANDLED;  // Signal decoder fully handled the property
    },
  };

  this.init();
}
```

### Cell Registry

All cell classes are registered in `cell_classes.ts`. Frontend iterates and registers them:

```typescript
// cell_classes.ts — add new classes here
export const cell_classes = {
	Parts,
	Chat,
	Chats,
	Thread,
	Threads,
	Turn /* ... 31 total */
} satisfies Record<string, typeof Cell<any>>;

// frontend.svelte.ts — auto-registers all classes
for (const constructor of Object.values(cell_classes)) {
	this.cell_registry.register(constructor);
}

// Lookup by ID at runtime
const cell = app.cell_registry.all.get(id);
```

## Content Model

```
Chat → thread_ids → Thread[]
                     └── turns: IndexedCollection<Turn>
                                └── part_ids → Part[]
                                               ├── TextPart (content stored directly)
                                               └── DiskfilePart (content from file reference)

Prompt → parts: Array<Part>  (reusable content templates)
```

### Parts

- Text (`TextPart`) — `content: string` stored directly
- Diskfile (`DiskfilePart`) — `path: DiskfilePath` → reads from disk or editor state

### Turns

Conversation messages with role:

```typescript
class Turn extends Cell<typeof TurnJson> {
	part_ids: Array<Uuid> = $state()!; // $state because push/splice used
	role: CompletionRole = $state.raw()!; // 'user' | 'assistant' | 'system'
	request: CompletionRequest | undefined = $state.raw();
	response: CompletionResponse | undefined = $state.raw();

	// mutable by design — streaming handlers assign to it;
	// the getter joins part contents, the setter writes the first part
	get content(): string {
		return this.parts
			.map((part) => part.content)
			.filter((c) => c != null)
			.join('\n\n');
	}
	set content(value: string | null | undefined) {
		if (value != null && this.parts[0]) {
			this.parts[0].content = value;
		}
	}

	readonly pending: boolean = $derived(
		this.role === 'assistant' &&
			this.is_content_loaded &&
			this.is_content_empty &&
			!this.response &&
			!this.error_message
	);
}
```

### Threads

Linear conversation with one model. Sends messages via the action system:

```typescript
class Thread extends Cell<typeof ThreadJson> {
  model_name: string = $state.raw()!;
  readonly turns: IndexedCollection<Turn> = new IndexedCollection();
  enabled: boolean = $state.raw()!;

  async send_message(content: string): Promise<Turn | null> {
    const user_turn = this.add_user_turn(content);
    const assistant_turn = this.add_assistant_turn('', {request: ...});
    await this.app.api.completion_create({
      completion_request,
      _meta: {progressToken: assistant_turn.id},
    });
    return assistant_turn;
  }
}
```

### Chats

Container for multi-model comparison. Holds `thread_ids`, resolves to Thread instances. `view_mode: 'simple' | 'multi'` controls single-thread vs side-by-side display.

## Data Flow

### Completion Request

```
User types message in Chat UI
  → Thread.send_message(content)
    → Create user Turn with TextPart
    → Build CompletionMessage[] from thread history
    → Create empty assistant Turn (progressToken = turn.id)
    → app.api.completion_create(request)
      → ActionEvent send_request phase
        → Transport.send(JSON-RPC request)
          → POST /api/rpc or /api/ws → Rust spine dispatch (spec lookup, auth check, schema validation)
            → handlers::provider::completion_create(params, ctx, app)
              → ProviderManager looks up the provider by name
              → provider streams the completion (stream = true when a progress token is present)
                → For each text chunk:
                  → completion_progress notification to the originating WS connection (ctx.connection_id)
              → Return {completion_response}
            → JSON-RPC response via WebSocket
              → Frontend receive_response phase
                → turn.content = response_text
                → turn.response = completion_response
                  → Svelte reactivity updates UI
```

### Streaming Progress

```
Rust provider parses the SSE stream from the API — the shared `provider/sse.rs`
hands raw SSE events to the provider, which parses its own event vocabulary
(Anthropic's `content_block_delta` in `provider/anthropic.rs`; OpenAI and
Gemini use their own event shapes)
  → for each text chunk
    → ConnectionRegistry::send_to(ctx.connection_id, completion_progress notification)
      → WebSocket notification to the originating socket (no id, no response)
        → frontend_action_handlers.completion_progress.receive()
          → Find turn by progressToken in cell_registry
          → Append chunk to turn content
            → UI re-renders incrementally
```

Streaming progress (`completion_progress`) is
**socket-scoped** — it routes only to the client that initiated the request,
never broadcast. On HTTP transport `ctx.notify` is a no-op (with a DEV warn).
`backend.api.*` is reserved for genuine broadcasts (`filer_change`,
`terminal_data`, `terminal_exited`, `workspace_changed`).

## Terminals

PTY terminals rendered by xterm.js, spawned and managed by the Rust backend's
`PtyManager` (`crates/zzz_server/src/pty_manager.rs`, using the native
`fuz_pty` crate — [development.md](./development.md) covers the build story).

Actions: `terminal_create` (→ `{terminal_id}`), `terminal_data_send` (stdin),
`terminal_resize`, and `terminal_close` (→ `{exit_code}`) are
`request_response`; `terminal_data` (output chunks) and `terminal_exited` are
**broadcast** `remote_notification`s — like `filer_change`, fanned out to all
connected sockets, not socket-scoped like `completion_progress`.

```
User types in xterm.js (TerminalView.svelte)
  → term.onData → app.api.terminal_data_send({terminal_id, data})
    → handlers::terminal → PtyManager::write (raw write to the PTY master)
  → child process output → PtyManager read_loop (10ms poll)
    → terminal_data broadcast to all sockets
      → frontend_action_handlers.terminal_data.receive
        → frontend.terminal_writers.get(terminal_id)?.(data)
          → the mounted TerminalView writes the chunk into its xterm buffer
```

The live frontend path is callback maps, not Cells: `TerminalView` registers
write/exit callbacks in `Frontend.terminal_writers` /
`terminal_exit_handlers`, and the notification handlers dispatch by
`terminal_id`. (The `Terminal` Cell class is registered but not part of this
flow today — `TerminalRunner.svelte` tracks runs as plain objects.)
`TerminalRunner` always spawns a shell (`terminal_create({command: 'sh'})`)
and sends the actual command line via `terminal_data_send`; presets
(`TerminalPreset`) are component-local state seeded from defaults, not
persisted. Restart closes the old terminal (tolerating failure if it already
exited) and spawns a fresh one with a new `terminal_id`.

On natural process exit the backend's read loop broadcasts `terminal_exited`
and cleans up its entry; an explicit `terminal_close` cancels the read loop,
signals the process (SIGTERM by default), and returns the exit code in the
RPC response. Terminals are pure in-memory process state — no persistence,
no reconnect-to-running across server restarts.

## IndexedCollection

Queryable reactive collections with multiple index types. From `indexed_collection.svelte.ts`.

### Core Structure

```typescript
class IndexedCollection<T extends IndexedItem> {
	readonly by_id: SvelteMap<Uuid, T> = new SvelteMap();
	readonly values: Array<T> = $derived(Array.from(this.by_id.values()));
	readonly size: number = $derived(this.by_id.size);
}
```

### Index Types

- `single` — One key → one item. Example: `by('name', 'gpt-5')`
- `multi` — One key → many items. Example: `where('provider_name', 'claude')`
- `derived` — Computed sorted array. Example: `derived_index('ordered_by_name')`
- `dynamic` — Runtime-computed. Example: Custom queries

### Index Definition

```typescript
interface IndexDefinition<T extends IndexedItem, TResult = any, TQuery = any> {
	key: string;
	type?: 'single' | 'multi' | 'derived' | 'dynamic';
	extractor?: (item: T) => any;
	compute: (collection: IndexedCollection<T>) => TResult;
	onadd?: (result: TResult, item: T, collection: IndexedCollection<T>) => TResult;
	onremove?: (result: TResult, item: T, collection: IndexedCollection<T>) => TResult;
}
```

### Usage

```typescript
// Create with indexes
const items = new IndexedCollection<Model>({
	indexes: [
		create_single_index({ key: 'name', extractor: (m) => m.name }),
		create_multi_index({ key: 'provider_name', extractor: (m) => m.provider_name }),
		create_derived_index({ key: 'ordered_by_name', sort: (a, b) => a.name.localeCompare(b.name) })
	]
});

// Query
items.by('name', 'gpt-5'); // single → Model | undefined
items.where('provider_name', 'claude'); // multi → Array<Model>
items.derived_index('ordered_by_name'); // derived → Array<Model>
```

## Filesystem

Two separate concerns:

- App directory (`PUBLIC_ZZZ_DIR`) — Zzz's own data (`.zzz/state/`, `.zzz/cache/`, `.zzz/run/`)
- Scoped dirs (`PUBLIC_ZZZ_SCOPED_DIRS`) — User file access (comma-separated paths)

### ScopedFs

All filesystem operations go through `ScopedFs` (Rust: `crates/zzz_server/src/scoped_fs.rs`). Security: paths validated against allowed roots, symlinks rejected, absolute paths required, parent directories checked recursively.

### Filer

`FilerManager` starts one `Filer` watcher per unique directory — the app dir, each scoped dir, and each open workspace dir. File changes are broadcast to clients via `filer_change` notifications over WebSocket.

### Daemon Info

`~/.zzz/run/daemon.json` tracks the running daemon (PID, port, version). The Rust CLI (`crates/zzz/src/daemon_lifecycle.rs`) writes it atomically when spawning `zzzd`, reads it back for discovery and `status`, removes it on `daemon stop`, and cleans it up when the recorded PID turns out dead (stale detection via PID liveness).

## File Editing

The frontend file pipeline is five Cells plus a per-file editor-session class:

- `Diskfiles` — `IndexedCollection<Diskfile>` (`by_path` single index,
  `by_extension` multi index); its `handle_change` is the `filer_change`
  dispatch point
- `Diskfile` — one file: `{path, source_dir, content}`; the Cell `id` is
  client-side identity, `path` is the disk identity used for backend
  correlation
- `DiskfilesEditor` → `DiskfileTabs` → `DiskfileTab` — VS-Code-style tabs:
  single-click opens a reusable _preview_ tab, editing or an explicit open
  promotes it to permanent; tab order, recent-tab history, and
  reopen-closed-tab state live on `DiskfileTabs`
- `DiskfileHistory` — per-path edit history (disk changes, unsaved edits,
  original state; max 100 entries), held in `Frontend.diskfile_histories` —
  in-memory only, lost on reload
- `DiskfileEditorState` (plain class, not a Cell) — one open file's editing
  session; routes `current_content` writes through the history and owns
  `save_changes()`

Save round trip:

```
User edits → DiskfileEditorState.current_content setter
  → unsaved-edit entry in DiskfileHistory
Save → save_changes() → app.api.diskfile_update({path, content})
  → ScopedFs::write_file (response is null — no content echo)
→ notify watcher fires → Filer updates its index immediately
  → debounced (80ms) filer_change broadcast to all sockets
    → Diskfiles.handle_change → existing Diskfile.set_json(...)
      → editor sees diskfile.content change → disk-change history entry
```

The confirmation is the broadcast, not the RPC response — a save and an
external edit look identical to the frontend. The initial file listing comes
from `session_load` (the backend rescans and flattens every active filer's
index); `workspace_open` currently returns `files: []`, so a newly opened
workspace populates only via subsequent `filer_change` events or a reload.
Tabs, history, and editor state are UI-session-only — a reload restores only
what `session_load` provides.

## Spaces and Workspaces

Two layers of directory scoping on top of the Filesystem section's "two
separate concerns":

- **Workspace** (backend-tracked) — an open directory the server watches and
  serves. `workspace_open` validates the path, adds it to `ScopedFs`, starts
  a workspace-lifetime `Filer`, and broadcasts `workspace_changed`;
  `workspace_close` reverses that (unless the path is one of the boot-time
  `PUBLIC_ZZZ_SCOPED_DIRS`, whose permanent filers are never torn down).
  Backend state is an in-memory map — a restart forgets all workspaces.
  Scoped dirs never appear as workspaces: they're the operator-configured
  always-on layer; workspaces are the user-opened runtime layer.
- **Space** (frontend-only) — a named grouping of directory paths
  (`Space.directory_paths`) with no backend counterpart (no `space_*`
  actions). `active_directory_paths` derives to only the paths that resolve
  to a currently open workspace. `Spaces` auto-creates and protects a
  `scratchpad` space. Space state is in-memory only today (DB persistence is
  planned).

The two meet in `DeskMenu.svelte`: toggling a directory into the active Space
first ensures its workspace is open. Opening brand-new directories happens on
`/workspaces` (path input → `workspace_open`; the `?workspace=<path>` query
param auto-opens — this is how the CLI's `zzz <dir>` lands the browser on a
workspace). `workspace_changed` broadcasts keep every connected client's
`Workspaces` collection in sync.

## Capabilities

`Capabilities` (`capabilities.svelte.ts`) is a single Cell aggregating
hardcoded (deliberately non-extensible) `Capability<T>` statuses. The
`/capabilities` route is zzz's diagnostics + settings page: verify the
backend is reachable, see filesystem scope, configure and test provider API
keys, and control the WebSocket transport. In the static-only build (no
backend) every capability reads as unavailable — the "diminished
capabilities" deploy.

Population, per capability:

- `backend` — driven by `ping` (the ping action's frontend handlers forward
  to `capabilities.handle_ping_*`); keeps a rolling round-trip-time history
- `websocket` — `$derived` off the `Socket` wrapper's connection state; its
  panel is also a live control surface (connect/disconnect, heartbeat and
  reconnect tuning)
- `filesystem` — `$derived` off `zzz_dir`/`scoped_dirs` from `session_load`,
  gated on backend status
- `providers` — one `ProviderCapability` per provider, `$derived` off
  `Frontend.provider_status`, populated by `session_load` and refreshed via
  `provider_load_status` (and after `provider_update_api_key`)
