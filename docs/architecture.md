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
	error_message: string | undefined = $state.raw(); // set on failure, kept separate from content
	cancelled: boolean = $state.raw()!; // set when the user stops the completion

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

	// the completion ended — late streaming chunks are ignored after this
	readonly settled: boolean = $derived(
		!!this.response || !!this.error_message || this.cancelled
	);

	readonly pending: boolean = $derived(
		this.role === 'assistant' && this.is_content_loaded && this.is_content_empty && !this.settled
	);
}
```

A failed completion keeps whatever content streamed in and records the error in
`error_message`, which the turn UI renders separately. When rendering a thread's
history for the next request, `render_completion_messages` skips errored turns and
turns with empty content (e.g. a completion cancelled before its first token);
cancelled turns with partial content are kept.

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
  → term.onData → terminal.send_input(data)  (Terminal cell's ordered queue)
    → app.api.terminal_data_send({terminal_id, data})  (one in flight per terminal)
      → handlers::terminal → PtyManager::write (enqueue on the terminal's input queue)
        → the terminal's task writes each chunk in full as the PTY accepts it
  → child process output → the terminal's task (readiness-driven read,
    incremental UTF-8 decode)
    → terminal_data broadcast to all sockets
      → frontend_action_handlers.terminal_data.receive
        → frontend.terminals.receive_output(terminal_id, data)
          → the Terminal cell buffers the chunk and forwards it to any
            attached TerminalView, which writes it into its xterm buffer
```

Terminal state lives in app-level Cells, not components: `app.terminals`
(`Terminals`, a collection of `Terminal` cells) and `app.terminal_presets`
(`TerminalPresets`, seeded once with the default presets). Views come and
go — navigating away from the terminals page leaves the processes running
and their output buffering, and coming back reattaches to them.

- **Output** — each `Terminal` keeps a bounded buffer of its output (about
  the most recent 1M characters, oldest dropped first, trimmed at a line or
  chunk boundary) whether or not a view is mounted. `attach_output` streams
  new output and hands back the buffered history, which a (re)mounted view
  replays into a fresh xterm — after a dim "earlier output truncated" line if
  output was dropped — ignoring xterm's input until the replay is parsed, so
  xterm's answers to terminal queries in the history (cursor position, device
  attributes) aren't typed into the live process. Output for an unknown
  `terminal_id` is held (capped at 64K characters) only while a
  `terminal_create` is in flight, since a new shell's first output can arrive
  before the create response.
- **Input** — `Terminal.send_input` keeps at most one `terminal_data_send` in
  flight per terminal and coalesces data typed meanwhile into the next send,
  so keystrokes stay ordered even though the backend dispatches one socket's
  requests concurrently. A `queue_overflow` (the child isn't reading its
  input) requeues the refused data ahead of newer input and retries with
  backoff — nothing was enqueued, so a resend can't duplicate — and shows the
  error until a send succeeds; other failures are shown without a retry,
  since the data may have been delivered. Pending input is capped.
  `Terminal.resize` coalesces to the latest size the same way.
- **Status** — `starting` → `running` → `exited` (natural exit via the
  `terminal_exited` broadcast, with its code) or `closed` (the user's
  `terminal_close`, with the code from its response, or `null` if the process
  outlived the close grace), or `failed` (spawn error). Exits are recorded
  on the cell whether or not a view is mounted.

`Terminals.create` always spawns a shell (`terminal_create({command: 'sh'})`)
and types the actual command line into it via the input queue — queued while
starting, so it goes ahead of anything else sent before the process starts.
If the process exits before the create response arrives, the queued input is
discarded. Restart
closes a running terminal (and gives up if the close fails, rather than
orphan a live process), then spawns a fresh process into the same cell with
a new `terminal_id` and cleared output. Removing a terminal closes it if
running, then disposes the cell. The terminal list is in-memory: a page
reload loses it while the backend PTYs keep running (reattaching needs a
backend `terminal_list`).

Each terminal is one backend task that owns the PTY master and the child
process. Input chunks are written in the order `terminal_data_send` calls
reach the handler; sends on one socket are dispatched concurrently, so
keeping keystrokes ordered across sends is the client's job.

On natural process exit the task reaps the child, broadcasts
`terminal_exited` with the real exit code, and removes its entry. An explicit
`terminal_close` signals the process (SIGTERM by default), then closes the
PTY master — the hangup ends a shell that ignores SIGTERM — and returns the
exit code in the RPC response, or `null` if the process is still running
after a short grace; the backend keeps reaping it (SIGKILL after 3s), and no
`terminal_exited` is broadcast for a closed terminal. Children get the
server's environment minus its secrets and config (`SECRET_*`, `FUZ_*`,
`ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, `PORT`). Terminals are pure
in-memory process state — no persistence, no reconnect-to-running across
server restarts.

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

`FilerManager` starts one `Filer` watcher per unique directory — the app dir, each scoped dir, and each open workspace dir. Each filer keeps an in-memory file index and broadcasts changes to clients via debounced `filer_change` notifications over WebSocket. Notify events are treated as hints: for every event, removes and renames included, the filer `lstat`s the path and decides `add` / `change` / `delete` from the disk and its index, so renames resolve to a delete of the old path plus an add of the new one, and late or reordered events can't delete a file that exists. Broadcasts are debounced per path (80ms quiet, at most 500ms): a delete then re-create becomes one `change`, and a file created and deleted inside the window is sent only as a `delete` (a no-op for clients that never saw it). Ignored directories (`.git`, `node_modules`, `target`, …) are filtered before the event channel; if events are still dropped (or the OS queue overflows), the filer rescans its root and broadcasts the diff. Symlinks are skipped entirely — never followed, never indexed — matching `ScopedFs`.

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
index), and `workspace_open` returns the opened workspace's index so the new
tree appears immediately. `Diskfiles` upserts by path — for seeds and for
both `add` and `change` — so a path never has two `Diskfile`s. A `delete`
closes the file's tabs, moves selection, and drops its history — unless the
file is open in a tab and its history holds unsaved edits: then the
`Diskfile` is kept, flagged `deleted_on_disk` (marked in the tab and the
editor), so saving writes the path back (always allowed while flagged) and
the `add` broadcast reattaches it (same id, flag cleared), while closing its
last tab discards it. A flagged `Diskfile` is hidden from the explorer and
pickers, and a `DiskfilePart` treats it as missing.
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
  `provider_load_status`. Provider keys are env-only
  (`SECRET_ANTHROPIC_API_KEY` / `SECRET_OPENAI_API_KEY` /
  `SECRET_GOOGLE_API_KEY`), so a key change lands on daemon restart rather
  than through an action
