# Architecture

Core systems: actions, cells, content model, data flow, indexed collections, filesystem.

## Action System

Symmetric peer-to-peer JSON-RPC 2.0 — by design either end can initiate. The frontend runs the TypeScript `ActionPeer` (from `@fuzdev/fuz_app`); the Rust `zzz_server` backend implements the same spec + wire contract via `fuz_actions`.

### Action Spec

Every action is a plain object with Zod schemas. Defined in `src/lib/action_specs.ts`:

```typescript
export const completion_create_action_spec = {
	method: 'completion_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: null,
	side_effects: true,
	input: z.strictObject({
		completion_request: CompletionRequest,
		_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
	}),
	output: z.strictObject({
		completion_response: CompletionResponse,
		_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
	}),
	async: true,
} satisfies ActionSpecUnion;
```

### Action Kinds

| Kind                  | Phases                                                                    | Transport         | Use                                     |
| --------------------- | ------------------------------------------------------------------------- | ----------------- | --------------------------------------- |
| `request_response`    | `send_request` → `receive_request` → `send_response` → `receive_response` | HTTP or WebSocket | Standard RPC                            |
| `remote_notification` | `send` → `receive`                                                        | WebSocket only    | Backend → frontend push (progress, broadcast) |
| `local_call`          | `execute`                                                                 | None              | Frontend-only UI actions                |

`remote_notification` actions have two routing paths on the backend:

- **Request-scoped** (`ctx.notify(method, params)` from a handler) — delivered
  only to the originating socket. Used for progress streams tied to an
  in-flight request (`completion_progress`). Specs that use
  this pattern set `streams: '<notification_method>'` to name the companion
  notification.
- **Broadcast** (`backend.api.<method>(input)`) — fanned out to all connected
  sockets. Used for server-wide events that every client needs
  (`filer_change`, `workspace_changed`, `terminal_data`).

### Action Spec Fields

| Field          | Type                 | Values                                                            |
| -------------- | -------------------- | ----------------------------------------------------------------- |
| `method`       | `string`             | Action name (e.g. `'completion_create'`)                          |
| `kind`         | `ActionKind`         | `'request_response'` \| `'remote_notification'` \| `'local_call'` |
| `initiator`    | `ActionInitiator`    | `'frontend'` \| `'backend'` \| `'both'`                           |
| `auth`         | `RouteAuth \| null` | `{account, actor, roles?, credential_types?}` \| `null` (four-axis flat record) |
| `side_effects` | `boolean \| null`    | Whether action mutates state                                      |
| `input`        | `z.ZodType`          | Zod schema for request params                                     |
| `output`       | `z.ZodType`          | Zod schema for response                                           |
| `async`        | `boolean`            | Whether handler is async                                          |
| `streams`      | `string` (optional)  | Name of companion `remote_notification` method this action emits via `ctx.notify` (e.g. `'completion_progress'`) |

### Core Components

| Component        | File                 | Purpose                                                                |
| ---------------- | -------------------- | ---------------------------------------------------------------------- |
| `ActionSpec`     | `action_spec.ts`     | Action metadata schema                                                 |
| `ActionEvent`    | `action_event.ts`    | Lifecycle state machine (initial → parsed → handling → handled/failed) |
| `ActionPeer`     | `action_peer.ts`     | Send/receive on both sides                                             |
| `ActionRegistry` | `action_registry.ts` | Type-safe action lookup                                                |

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
export const frontend_action_handlers: FrontendActionHandlers = {
	completion_create: {
		send_request: ({data: {input}}) => {
			console.log('sending prompt:', input.completion_request.prompt);
		},
		receive_response: ({app, data: {input, output}}) => {
			const progress_token = input._meta?.progressToken;
			if (progress_token) {
				const turn = app.cell_registry.all.get(progress_token);
				if (turn instanceof Turn) {
					turn.content = to_completion_response_text(output.completion_response) || '';
					turn.response = output.completion_response;
				}
			}
		},
		receive_error: ({data: {error}}) => {
			console.error('completion failed:', error);
		},
	},
};

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

Defined in `src/lib/action_specs.ts`. A representative subset below — the `terminal_*` and `workspace_*` families are omitted here; see [reference.md](./reference.md) (generated from the specs) for the full table:

| Method                    | Kind                  | Initiator  | Purpose                         |
| ------------------------- | --------------------- | ---------- | ------------------------------- |
| `ping`                    | `request_response`    | `both`     | Health check                    |
| `session_load`            | `request_response`    | `frontend` | Load initial session data       |
| `filer_change`            | `remote_notification` | `backend`  | File system change notification |
| `diskfile_update`         | `request_response`    | `frontend` | Write file content              |
| `diskfile_delete`         | `request_response`    | `frontend` | Delete a file                   |
| `directory_create`        | `request_response`    | `frontend` | Create a directory              |
| `completion_create`       | `request_response`    | `frontend` | Start AI completion             |
| `completion_progress`     | `remote_notification` | `backend`  | Stream completion chunks        |
| `toggle_main_menu`        | `local_call`          | `frontend` | Toggle main menu UI             |
| `provider_load_status`    | `request_response`    | `frontend` | Check provider availability     |
| `provider_update_api_key` | `request_response`    | `frontend` | Update provider API key         |

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
	selected_thread_id: Uuid.nullable().default(null),
}).meta({cell_class_name: 'Chat'});

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
	Turn /* ... 31 total */,
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

| Type     | Class          | Content source                                         |
| -------- | -------------- | ------------------------------------------------------ |
| Text     | `TextPart`     | `content: string` stored directly                      |
| Diskfile | `DiskfilePart` | `path: DiskfilePath` → reads from disk or editor state |

### Turns

Conversation messages with role:

```typescript
class Turn extends Cell<typeof TurnJson> {
	part_ids: Array<Uuid> = $state()!; // $state because push/splice used
	role: CompletionRole = $state.raw()!; // 'user' | 'assistant' | 'system'
	request: CompletionRequest | undefined = $state.raw();
	response: CompletionResponse | undefined = $state.raw();

	readonly content: string = $derived(
		this.parts
			.map((p) => p.content)
			.filter(Boolean)
			.join('\n\n'),
	);
	readonly pending: boolean = $derived(
		this.role === 'assistant' && this.is_content_empty && !this.response,
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
Rust provider parses the SSE stream from the API (`provider/sse.rs`)
  → for each `content_block_delta` text chunk
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

| Type      | Cardinality           | Example                            |
| --------- | --------------------- | ---------------------------------- |
| `single`  | One key → one item    | `by('name', 'gpt-5')`              |
| `multi`   | One key → many items  | `where('provider_name', 'claude')` |
| `derived` | Computed sorted array | `derived_index('ordered_by_name')` |
| `dynamic` | Runtime-computed      | Custom queries                     |

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
		create_single_index({key: 'name', extractor: (m) => m.name}),
		create_multi_index({key: 'provider_name', extractor: (m) => m.provider_name}),
		create_derived_index({key: 'ordered_by_name', sort: (a, b) => a.name.localeCompare(b.name)}),
	],
});

// Query
items.by('name', 'gpt-5'); // single → Model | undefined
items.where('provider_name', 'claude'); // multi → Array<Model>
items.derived_index('ordered_by_name'); // derived → Array<Model>
```

## Filesystem

Two separate concerns:

| Concern       | Env Var                  | Purpose                                                    |
| ------------- | ------------------------ | ---------------------------------------------------------- |
| App directory | `PUBLIC_ZZZ_DIR`         | Zzz's own data (`.zzz/state/`, `.zzz/cache/`, `.zzz/run/`) |
| Scoped dirs   | `PUBLIC_ZZZ_SCOPED_DIRS` | User file access (comma-separated paths)                   |

### ScopedFs

All filesystem operations go through `ScopedFs` (Rust: `crates/zzz_server/src/scoped_fs.rs`). Security: paths validated against allowed roots, symlinks rejected, absolute paths required, parent directories checked recursively.

### Filer

Each scoped directory gets a `Filer` watcher. File changes are broadcast to clients via `filer_change` notifications over WebSocket.

### Daemon Info

`run/daemon.json` tracks the running server (PID, port, version). Written atomically on startup via `@fuzdev/fuz_app/cli/daemon.ts`, removed on clean shutdown (SIGINT/SIGTERM). Stale detection via `kill -0`.
