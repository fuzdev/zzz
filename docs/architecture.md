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
	input: CompletionCreateInput, // {completion_request, _meta?: {progressToken?}}
	output: CompletionCreateOutput, // {completion_response, _meta?: {progressToken?}}
	async: true,
	streams: 'completion_progress',
	description: 'Start an AI completion request, optionally with a progress token for streaming.'
} satisfies RequestResponseActionSpec;
```

### Action Kinds

- `request_response` — Standard RPC. Phases: `send_request` → `receive_request` → `send_response` → `receive_response`. Transport: HTTP or WebSocket
- `remote_notification` — Backend → frontend push (progress, broadcast). Phases: `send` → `receive`. Transport: WebSocket only
- `local_call` — Frontend-only UI actions. Phases: `execute`. Transport: None

`remote_notification` actions have two routing paths on the backend:

- **Request-scoped** — delivered only to the originating socket, via the
  connection registry's `send_to(connection_id, …)` (or a handler's
  `ctx.notify`). Used for progress streams tied to an in-flight request
  (`completion_progress`). Specs that use this pattern set
  `streams: '<notification_method>'` to name the companion notification.
- **Broadcast** (`App::broadcast` in the Rust backend) — fanned out to all
  connected sockets. Used for server-wide events that every client needs
  (`filer_change`, `workspace_changed`, `terminal_data`, `terminal_exited`).

### Action Spec Fields

- `method` (`string`) — Action name (e.g. `'completion_create'`)
- `kind` (`ActionKind`) — `'request_response'` | `'remote_notification'` | `'local_call'`
- `initiator` (`ActionInitiator`) — `'frontend'` | `'backend'` | `'both'`
- `auth` (`RouteAuth | null`) — `{account, actor, roles?, credential_types?, required_scope?}`; required on `request_response` specs, `null` on `remote_notification` / `local_call`
- `side_effects` (`boolean`) — Whether action mutates state (also keeps it off the cacheable `GET /api/rpc` path)
- `input` (`z.ZodType`) — Zod schema for request params
- `output` (`z.ZodType`) — Zod schema for response
- `async` (`boolean`) — Whether handler is async
- `description` (`string`) — What the action does (rendered into ./reference.md)
- `streams` (`string` (optional)) — Name of the companion request-scoped `remote_notification` method this action emits (e.g. `'completion_progress'`)
- `error_reasons`, `rate_limit` (optional) — see fuz_app's `ActionSpec`

### Core Components

- `ActionSpec` (`action_spec.ts`) — Action metadata schema
- `ActionEvent` (`action_event.ts`) — Lifecycle state machine (initial → parsed → handling → handled/failed)
- `ActionDispatcher` (`action_dispatcher.ts`) — Send/receive on both sides
- `ActionRegistry` (`action_registry.ts`) — Type-safe action lookup

These live in `@fuzdev/fuz_app/actions/` — the SAES runtime lives in fuz_app, and zzz imports it. Cell patterns (the `Cell` base class, `IndexedCollection`) remain in zzz.

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
		receive_error: ({ data: { input, error } }) => {
			// marks the unsettled turn `cancelled` on `request_cancelled`,
			// else sets its `error_message` (streamed content is kept)
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
	send(message: JsonrpcRequest, options?: TransportSendOptions): Promise<JsonrpcResponseOrError>;
	send(
		message: JsonrpcNotification,
		options?: TransportSendOptions
	): Promise<JsonrpcErrorResponse | null>;
	// ...plus a general `JsonrpcMessageFromClientToServer` overload
	is_ready: () => boolean;
	dispose?: () => void;
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
        this.#clear_turns(); // also cancels a pending completion
        for (const item_json of items) {
          this.add_turn(new Turn({app: this.app, json: item_json}));
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
	Turn /* ... 33 total */
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
- Diskfile (`DiskfilePart`) — `path: DiskfilePath | null` → reads from disk or editor state

### Turns

Conversation messages with role:

```typescript
class Turn extends Cell<typeof TurnJson> {
	part_ids: Array<Uuid> = $state()!; // $state because push/splice used
	role: CompletionRole = $state.raw()!; // a string — 'user' | 'assistant' | 'system' by convention
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
  readonly turns: IndexedCollection<Turn> = new IndexedCollection({
    dispose_item: (turn) => turn.dispose(),
  });
  enabled: boolean = $state.raw()!;

  async send_message(content: string): Promise<Turn | null> {
    const completion_messages = render_completion_messages(this.turns.by_id.values());
    const user_turn = this.add_user_turn(content);
    const assistant_turn = this.add_assistant_turn('', {request: ...});
    await this.app.api.completion_create(
      {completion_request, _meta: {progressToken: assistant_turn.id}},
      {signal: controller.signal}, // `cancel_pending()` aborts it
    );
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
    → Build CompletionMessage[] from thread history (before the new message,
      which is sent as `prompt`)
    → Create user Turn with TextPart
    → Create empty assistant Turn (progressToken = turn.id)
    → app.api.completion_create(request)
      → ActionEvent send_request phase
        → Transport.send(JSON-RPC request)
          → POST /api/rpc or /api/ws → Rust spine dispatch (spec lookup, auth check; the handler deserializes params)
            → handlers::provider::completion_create(params, ctx, app)
              → ProviderManager looks up the provider by name
              → provider streams the completion (stream = true when a progress token is
                present and the request came over WebSocket)
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
never broadcast. Over HTTP there's no socket, so the provider runs without
streaming and the caller gets only the final response. `App::broadcast` is
reserved for genuine broadcasts (`filer_change`, `terminal_data`,
`terminal_exited`, `workspace_changed`).

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

### Keeping Indexes Current

An index is maintained one of two ways:

- **Reactive** (`reactive: true`) — the index is a `$derived` of its `compute`,
  rebuilt in O(n) on the next read after the collection changes or any reactive
  field `compute` reads changes. `create_single_index` and `create_multi_index`
  are reactive by default, so a lookup like `by_name` follows an item that's
  renamed after it was added. Two costs follow:
  - every rebuild makes a new map, so everything reading the index re-runs on
    any change to the collection or an indexed field, not only the keys it read
  - a read outside a reactive context (an event handler, a plain method) can't
    rely on change notifications, so it checks all O(n) dependencies even when
    nothing changed — fine for occasional lookups, but code that adds an item
    and then reads the index in a loop is O(n²)
- **Incremental** — `onadd`/`onremove` hooks update the index on membership
  changes only (O(1) per change, per-key reactive via `SvelteMap`), which is
  correct only while an item's indexed values never change. Single and multi
  indexes opt in with `immutable_key: true`; use it for identity-like keys on
  large or busy collections (`Diskfiles.by_path` — seeded with every file,
  upserting by path in a loop — plus `Workspaces.by_path` and
  `Actions.by_method`). Derived-array indexes (`create_derived_index`) are
  incremental and can be replaced by assignment (e.g.
  `items.indexes.manual_order = reordered`).

`onremove` hooks run after the removed items have left `by_id`, so a single
index falling back to another holder of a key never picks an item removed in the
same `remove_many`.

### Ownership and Disposal

A collection that owns its items passes `dispose_item`, which runs for every
item leaving through `remove`, `remove_many`, or `clear` (including a decoder
re-populating the collection). Every app collection owns its cells, so removed
cells leave the cell registry and release their resources — trimmed `Actions`
stop observing their action events, a disposed `Thread` cancels its in-flight
completion and disposes its turns, and a disposed `Prompt` disposes its parts
(a prompt's parts are its own instances, not in `app.parts`).

Removal cascades through the content model; disposal alone doesn't, since a
decoder replacing a collection disposes cells whose replacements still point at
the same dependents:

- `Chats.remove` removes the chat's threads unless another chat still lists
  them, and the `Chat.remove_thread*` methods do the same for the threads they
  drop (`detach_thread`/`detach_threads` only drop the ids).
- `Threads.remove` drops the thread from every chat, disposes it (cancelling
  its completion), and removes its turns' parts from `app.parts`;
  `Thread.remove_all_turns` removes its turns' parts the same way.
- A part is only removed when no turn in `app.threads` still references it —
  turns are the only owners of `app.parts` (`Diskfile.part` is a lookup).

### Index Definition

```typescript
interface IndexDefinition<T extends IndexedItem, TResult = any, TQuery = any> {
	key: string;
	type?: 'single' | 'multi' | 'derived' | 'dynamic';
	extractor?: (item: T) => any;
	compute: (collection: IndexedCollection<T>) => TResult;
	reactive?: boolean; // `$derived` of `compute`, the hooks below are unused
	onadd?: (result: TResult, item: T, collection: IndexedCollection<T>) => TResult;
	onremove?: (result: TResult, item: T, collection: IndexedCollection<T>) => TResult;
}
```

### Usage

```typescript
// Create with indexes
const items = new IndexedCollection<Model>({
	dispose_item: (model) => model.dispose(),
	indexes: [
		create_single_index({ key: 'name', extractor: (m) => m.name }),
		create_multi_index({ key: 'provider_name', extractor: (m) => m.provider_name }),
		create_derived_index({
			key: 'ordered_by_name',
			compute: (collection) => collection.values,
			sort: (a, b) => a.name.localeCompare(b.name)
		})
	]
});

// Query
items.by('name', 'gpt-5'); // single → Model, throws if missing
items.by_optional('name', 'gpt-5'); // single → Model | undefined
items.where('provider_name', 'claude'); // multi → Array<Model>
items.derived_index('ordered_by_name'); // derived → Array<Model>
```

## Filesystem

Two separate concerns:

- App directory (`PUBLIC_ZZZ_DIR`) — Zzz's own files (`state/`, `cache/`, and `run/` are reserved subdirectories)
- Scoped dirs (`PUBLIC_ZZZ_SCOPED_DIRS`) — User file access (comma-separated paths)

### ScopedFs

All filesystem operations go through `ScopedFs` (Rust: `crates/zzz_server/src/scoped_fs.rs`). Security: paths validated against allowed roots, symlinks rejected, absolute paths required, parent directories checked recursively.

The allowed roots are the permanent boot-time set (the app directory + scoped dirs) plus one runtime root per open workspace. A path is allowed when any root covers it, and removing a workspace's root never touches a permanent root — so closing a workspace opened on, nested in, or containing the app directory or a scoped dir leaves the access those roots grant intact.

### Filer

`FilerManager` starts one `Filer` watcher per unique directory — the app dir, each scoped dir, and each open workspace dir. Each filer keeps an in-memory file index and broadcasts changes to clients via debounced `filer_change` notifications over WebSocket. Notify events are treated as hints: for every event, removes and renames included, the filer `lstat`s the path and decides `add` / `change` / `delete` from the disk and its index, so renames resolve to a delete of the old path plus an add of the new one, and late or reordered events can't delete a file that exists. Broadcasts are debounced per path (80ms quiet, at most 500ms): a delete then re-create becomes one `change`, and a file created and deleted inside the window is sent only as a `delete` (a no-op for clients that never saw it). Ignored directories (`.git`, `node_modules`, `target`, …) are filtered before the event channel; if events are still dropped (or the OS queue overflows), the filer rebuilds its watches on a fresh watcher, rescans its root, and broadcasts the diff. Symlinks are skipped entirely — never followed, never indexed, never watched — matching `ScopedFs`.

Watches are per directory: the filer's own walk (on a blocking thread) adds one non-recursive watch to each directory it indexes — never inside ignored, symlinked, or non-UTF-8 directories — watching each before listing it, so nothing created in between is missed. A directory that appears gets watches for its subtree when it's synced; one that's removed or renamed away has them dropped (two paths sharing one inode, like a renamed directory's old and new path or a bind mount, share one kernel watch, removed only with its last path). An unreadable subdirectory is skipped and logged once, and picked up once it's readable again; one made unreadable later drops out of the index. A listing that fails transiently (`EMFILE`, `EIO`) keeps what's indexed under it and retries. Rescans (`session_load`, overflow recovery) re-read only files whose `lstat` identity or change stamps moved, and trust a stamp only once the file has been still for two seconds (git's "racily clean" rule), since same-size writes within one timestamp tick look identical.

When the OS runs out of watches (inotify's `max_user_watches`), or no watcher can be created at all (`max_user_instances`), the filer runs **degraded**: the index still comes from the scan, and the directories without a watch are rescanned every 5 seconds or more (retrying their watches each time), so changes there show up late. `workspace_open` returns this as `watch_status` (`'full'` or `'degraded'`), which the tab that opened it keeps on its `Workspace` cell and shows on the workspaces page and in the desk menu. It's reported at open time only (another tab or a reload shows `'full'`) — a filer that degrades or recovers later is just logged. A workspace root that can't be listed fails `workspace_open` (`forbidden` / `permission_denied`, or `not_found`); a running filer whose root disappears polls it until it's back.

### Daemon Info

`~/.zzz/run/daemon.json` tracks the running daemon (boot id, pid, kernel start time, port, version). The Rust CLI (`crates/zzz/src/daemon_lifecycle.rs`) writes it atomically once the spawned `zzzd` holds the listening socket and answers `/health`, reads it back for discovery and `status`, and identifies the daemon by boot id, pid, and start time — a dead or reused pid reads as stale and is never signalled; a record from an older zzz is reported, never acted on. The file is removed on `daemon stop`, when the foreground `daemon start` exits, and when found stale, each time only if it still records that same process.

## File Editing

The frontend file pipeline is six Cells plus a per-file editor-session class:

- `Diskfiles` — `IndexedCollection<Diskfile>` (`by_path` single index,
  `immutable_key` since a path is a diskfile's disk identity); its
  `handle_change` is the `filer_change` dispatch point
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
external edit look identical to the frontend. The response still gates the
editor: `save_changes()` runs one save per file at a time, and records the
saved entry and clears the modified flag only when the write succeeds — a
failure keeps the edit unsaved and sets `save_error`. If anything moves while
the write is in flight — more typing, another history entry picked, or an
external edit landing after the save's own broadcast — the saved content is
recorded in history but the editor keeps its content and selection, and an
external edit stays the last-seen disk state. An editor that switched to
another file mid-save only settles the saved file's history. Ctrl+S saves the
focused editor; the main `/files` editor also takes it from anywhere on the
page.

The initial file listing comes from `session_load` (the backend rescans and
flattens every active filer's index), and `workspace_open` returns the opened
workspace's index so the new tree appears immediately. `Frontend.load_session`
runs `session_load` and retries a failure with backoff (1s doubling to 30s)
until it succeeds, tracking progress in `session_status` / `session_error`;
`Workspaces.open` does the same snapshot handling for `workspace_open`. Both
record the paths `filer_change` touches while their request is in flight
(`Diskfiles.track_changes`) and skip those snapshot entries, since the
notification is at least as new — a file deleted mid-request isn't
resurrected, and newer content isn't reverted. `Diskfiles` upserts by
path — for seeds and for both `add` and `change` — so a path never has two
`Diskfile`s. A `delete` closes the file's tabs, moves selection, and drops its
history — unless the file is open in a tab and its history holds unsaved
edits: then the `Diskfile` is kept, flagged `deleted_on_disk` (marked in the
tab and the editor), so saving writes the path back (always allowed while
flagged) and the `add` broadcast reattaches it (same id, flag cleared), while
closing its last tab discards it. A flagged `Diskfile` is hidden from the
explorer and pickers, and a `DiskfilePart` treats it as missing. Tabs,
history, and editor state are UI-session-only — a reload restores only what
`session_load` provides.

## Spaces and Workspaces

Two layers of directory scoping on top of the Filesystem section's "two
separate concerns":

- **Workspace** (backend-tracked) — an open directory the server watches and
  serves. `workspace_open` validates and canonicalizes the path, starts (or
  finds) its workspace-lifetime `Filer` — the initial scan runs before the
  workspace lifecycle lock is taken, and concurrent opens of one path share
  it; a root that can't be listed fails the open here, with nothing
  registered — then, under the lock, records the workspace, re-ensures the
  filer, adds the path to `ScopedFs`, broadcasts `workspace_changed`, and
  returns the files with the `watch_status`;
  `workspace_close` reverses that — except that the boot-time app directory
  and `PUBLIC_ZZZ_SCOPED_DIRS` keep their permanent filers and `ScopedFs`
  roots, so closing a workspace that overlaps one never revokes its access.
  Backend state is an in-memory map — a restart forgets all workspaces.
  Scoped dirs aren't listed as workspaces automatically: they're the
  operator-configured always-on layer; workspaces are the user-opened runtime
  layer. A scoped dir (or the app directory) can still be opened as a
  workspace, and closing it leaves its permanent access in place.
- **Space** (frontend-only) — a named grouping of directory paths
  (`Space.directory_paths`) with no backend counterpart (no `space_*`
  actions). `active_directory_paths` derives to only the paths that resolve
  to a currently open workspace. `Spaces` auto-creates and protects a
  `scratchpad` space, identified by `Spaces.scratchpad_id` so renaming it
  keeps it the protected default. Space state is in-memory (DB persistence
  is planned).

The two meet in `DeskMenu.svelte`, which lists the open workspaces to toggle
into the active Space. Opening brand-new directories happens on
`/workspaces` (path input → `workspace_open`; the `?workspace=<path>` query
param auto-opens — this is how the CLI's `zzz <dir>` lands the browser on a
workspace). Both paths require an absolute path (a leading `~` isn't
expanded), activate the workspace by the canonical path `workspace_open`
returns, and the query param is handled once and then stripped from the URL,
so a reload doesn't reopen a workspace the user has since closed.
`workspace_changed` broadcasts keep every connected client's `Workspaces`
collection in sync.

## Capabilities

`Capabilities` (`capabilities.svelte.ts`) is a single Cell aggregating
hardcoded (deliberately non-extensible) `Capability<T>` statuses. The
`/capabilities` route is zzz's diagnostics + settings page: verify the
backend is reachable, see filesystem scope, check each provider's API-key
status, and control the WebSocket transport. In the static-only build (no
backend) every capability reads as unavailable — the "diminished
capabilities" deploy.

Population, per capability:

- `backend` — driven by `ping` (the ping action's frontend handlers forward
  to `capabilities.handle_ping_*`); keeps a rolling round-trip-time history.
  Once connected, a new ping keeps the connected status until it answers or
  fails, so periodic pings don't flicker it
- `websocket` — `$derived` off the `Socket` wrapper's connection state; its
  panel is also a live control surface (connect/disconnect, heartbeat and
  reconnect tuning — the setters coerce and clamp input, and the heartbeat's
  receive timeout scales with its interval so an idle socket isn't closed)
- `filesystem` — `$derived` off `zzz_dir`/`scoped_dirs` from `session_load`,
  gated on backend status; after a `session_load` fails (to load or to
  apply) it reads as failed with the error, and until a load succeeds its
  panel offers "retry now" (`load_session`) ahead of the next scheduled retry
- `providers` — one `ProviderCapability` per provider, `$derived` off
  `Frontend.provider_status`, populated by `session_load` and refreshed via
  `provider_load_status`. Provider keys are env-only
  (`SECRET_ANTHROPIC_API_KEY` / `SECRET_OPENAI_API_KEY` /
  `SECRET_GOOGLE_API_KEY`), so a key change lands on daemon restart rather
  than through an action
