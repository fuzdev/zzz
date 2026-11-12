# Architecture

Core systems: actions, cells, content model, data flow, terminals, indexed collections, filesystem, file editing, spaces and workspaces, capabilities.

## Action System

Symmetric peer-to-peer JSON-RPC 2.0 — by design either end can initiate. The frontend runs the TypeScript `ActionDispatcher` (from `@fuzdev/fuz_app`); the Rust `zzz_server` backend implements the same spec + wire contract via `fuz_actions`.

### Action Spec

Every action is a plain object with fuz_schema schemas. Defined in `src/lib/action_specs.ts`:

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

`remote_notification` actions have three routing paths on the backend:

- **Request-scoped** — delivered only to the originating socket, via the
  connection registry's `send_to(connection_id, …)` (or a handler's
  `ctx.notify`). Used for progress streams tied to an in-flight request
  (`completion_progress`). Specs that use this pattern set
  `streams: '<notification_method>'` to name the companion notification.
- **Account-scoped** — delivered to every socket of one account, via the
  connection registry's `send_to_account(account_id, …)`. Used for what
  belongs to the account that created it: a terminal's output and exit
  (`terminal_data`, `terminal_exited`) and a job's state and preview
  (`job_changed`, `transcription_progress`).
- **Broadcast** (`App::broadcast` in the Rust backend) — fanned out to all
  connected sockets. Used for server-wide events that every client needs
  (`filer_change`, `workspace_changed`).

### Action Spec Fields

- `method` (`string`) — Action name (e.g. `'completion_create'`)
- `kind` (`ActionKind`) — `'request_response'` | `'remote_notification'` | `'local_call'`
- `initiator` (`ActionInitiator`) — `'frontend'` | `'backend'` | `'both'`
- `auth` (`RouteAuth | null`) — `{account, actor, roles?, credential_types?, required_scope?}`; required on `request_response` specs, `null` on `remote_notification` / `local_call`
- `side_effects` (`boolean`) — Whether action mutates state (also keeps it off the side-effect-free `GET /api/rpc` path)
- `input` (`ValidationSchema`) — schema for request params (zzz's are fuz_schema)
- `output` (`ValidationSchema`) — schema for response
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
- `session_load` — Load the session snapshot, at boot and after each reconnect. Kind: `request_response`. Initiator: `frontend`
- `filer_change` — File system change notification. Kind: `remote_notification`. Initiator: `backend`
- `diskfile_update` — Write file content. Kind: `request_response`. Initiator: `frontend`
- `diskfile_delete` — Delete a file. Kind: `request_response`. Initiator: `frontend`
- `directory_create` — Create a new directory (and missing parents); a taken name is `conflict`. Kind: `request_response`. Initiator: `frontend`
- `completion_create` — Start AI completion. Kind: `request_response`. Initiator: `frontend`
- `completion_progress` — Stream completion chunks. Kind: `remote_notification`. Initiator: `backend`
- `toggle_main_menu` — Toggle main menu UI. Kind: `local_call`. Initiator: `frontend`
- `provider_load_status` — Check provider availability. Kind: `request_response`. Initiator: `frontend`

### Actions Log

Every `app.api` call is recorded as an `Action` cell in `app.actions` (shown on
the actions page), which keeps the newest 512 (`HISTORY_LIMIT_DEFAULT`) —
except calls of the flow-control methods in `QUIET_ACTION_METHODS`
(`terminal_ack`), which arrive many a second under a flood of terminal output
and would turn the whole history over. The
log keeps each call's method, lifecycle (kind, phase, step), timing, and error,
but only a bounded copy of its payloads: an `input`, `output`, `progress`,
request `params`, response `result`, notification `params`, or error `data`
whose JSON is over `ACTION_PAYLOAD_BUDGET` (8192 characters) is replaced by a
`{zzz_payload_omitted: '…'}` marker, and a longer error `message` is truncated
and flagged with `zzz_message_truncated_from` (`bound_action_event_data` in
`action_helpers.ts`). So a `session_load` snapshot or a file save doesn't keep
every file's contents per call, and `completion_create` requests, each carrying
the chat history so far, don't add up quadratically. An `Action` stops observing
its `ActionEvent` and drops it once the call completes, so the event's full
payloads can be collected.

## Cell System

Schema-driven reactive data models using Svelte 5 runes.

### Base Cell Class

From `cell.svelte.ts`:

```typescript
export abstract class Cell<TSchema extends AnySchema = AnySchema> implements CellJson {
  readonly cid = ++global_cell_count; // monotonic client-side ordering

  // Base properties from CellJson — $state.raw() by default
  id: Uuid = $state.raw()!;
  created: Datetime = $state.raw()!;
  updated: Datetime = $state.raw()!;

  readonly schema!: TSchema;
  readonly schema_keys: Array<SchemaKeys<TSchema>> = $derived(...); // via `get_schema_entries`
  readonly json: Infer<TSchema> = $derived(this.to_json());
  readonly json_serialized: string = $derived(JSON.stringify(this.json));

  readonly app: Frontend;
  protected decoders: CellValueDecoder<TSchema> = {};

  constructor(schema: TSchema, options: CellOptions<TSchema>) { ... }
  protected init(): void { ... }  // Must call at end of subclass constructor
  dispose(): void { ... }
  set_json(json: InferInput<TSchema>): void { ... } // `parse_or_throw`, filling defaults
  set_json_partial(partial: Partial<...>): void { ... }
  protected register(): void { ... }  // Called by init()
  protected unregister(): void { ... }
}
```

### CellOptions

```typescript
interface CellOptions<TSchema extends AnySchema> {
	app: Frontend; // Root app state reference
	json?: InferInput<TSchema>; // Initial JSON data (parsed by schema)
}
```

### Creating a Cell

Real example from `chat.svelte.ts`:

```typescript
// 1. Schema with CellJson's entries — every field has a default
export const ChatJson = cell_json_schema(
	{
		name: with_default(string, ''),
		thread_ids: with_default_fn(array(Uuid), () => []),
		main_input: with_default(string, ''),
		view_mode: with_default(one_of(['simple', 'multi']), 'simple'),
		selected_thread_id: with_default(nullable(Uuid), null)
	},
	'Chat'
);

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

For complex field deserialization, override `this.decoders` before `init()`.
A decoder returns a value to assign, `undefined` for the default decoding, or
`HANDLED` when it has fully handled the property. A property holding a
collection of cells uses `create_collection_decoder` (`cell_helpers.ts`): an
array value clears the collection, then adds each element, and it always
returns `HANDLED`:

```typescript
constructor(options: ThreadOptions) {
  super(ThreadJson, options);

  this.decoders = {
    turns: create_collection_decoder(
      () => this.#clear_turns(), // also cancels a pending completion
      (json) => this.add_turn(new Turn({app: this.app, json})),
    ),
  };

  this.init();
}
```

### Cell Registry

All cell classes are registered in `cell_classes.ts`, keyed by the name
schemas refer to them by — each class's schema carries it as
`cell_class_name` metadata, and decoding a cell-typed field instantiates the
class registered under that name. The key is explicit, never
`constructor.name`, which a minified production build mangles. Frontend
iterates and registers them:

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

// frontend.svelte.ts — auto-registers all classes under their keys
for (const [class_name, constructor] of Object.entries(cell_classes)) {
	this.cell_registry.register(class_name, constructor);
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
reserved for genuine broadcasts (`filer_change`, `workspace_changed`).

A chunk updates only its own turn: `Turn.length` / `token_count` and
`Thread.length` / `token_count` are summed from the parts' and turns' lengths
(`joined_content_length`, `render_messages_length`), so a thread's token count
doesn't re-concatenate the conversation per chunk. `Thread.content` builds the
full text only when something reads it, like "copy conversation".

## Terminals

PTY terminals drawn by zzz's own terminal view (`TerminalView.svelte`, a
`FuzTerminal` over Ghostty's emulator — see [fuz_terminal](#fuz_terminal)
below), spawned and managed by the Rust backend's `PtyManager`
(`crates/zzz_server/src/pty_manager.rs`, using the native `fuz_pty` crate —
[development.md](./development.md) covers the build story).

Actions: `terminal_create` (→ `{terminal_id}`), `terminal_data_send` (stdin),
`terminal_resize`, `terminal_ack` (output consumed), and `terminal_close`
(→ `{exit_code}`) are
`request_response`; `terminal_data` (output chunks) and `terminal_exited` are
**account-scoped** `remote_notification`s — sent to every socket of the
account that created the terminal, not to all sockets like `filer_change`
nor to one socket like `completion_progress`.

```
User types in a focused FuzTerminal (TerminalView.svelte), or pastes from its context menu
  → the key encoder's bytes, a paste's encoded text, or the emulator's reply to a live query
    → ondata → TerminalViewLink.send (streaming UTF-8 decode)
      → terminal.send_input(data)  (Terminal cell's ordered queue)
    → app.api.terminal_data_send({terminal_id, data})  (one in flight per terminal)
      → handlers::terminal → PtyManager::write (enqueue on the terminal's input queue)
        → the terminal's task writes each chunk in full as the PTY accepts it
  → child process output → the terminal's task (readiness-driven read,
    incremental UTF-8 decode)
    → terminal_data sent to the owning account's sockets
      → frontend_action_handlers.terminal_data.receive
        → frontend.terminals.receive_output(terminal_id, data, sent_bytes)
          → the Terminal cell buffers the chunk and forwards it to any
            attached TerminalView's link, which writes it into the emulator
            (parsed synchronously; drawn at the next animation frame)
            → as soon as the write returns: app.api.terminal_ack({terminal_id, bytes})
              (batched) → PtyManager::ack, which paces the terminal's reads
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
  replays into a fresh emulator — after a dim "earlier output truncated" line
  if output was dropped — as a replay write (`{replay: true}`), which has no
  reply effects registered: the queries in the history (cursor position,
  device attributes) were answered when the output first arrived, and get no
  second answer typed into the live process. What the history does to the
  emulator's state carries forward, as when live output continues it — a
  history that ends partway through a query is answered once live output
  completes it, and one that turned on in-band size reports (mode 2048) gets
  a report at the view's next resize. Live chunks after it are plain writes,
  whose queries the view answers. Output for an unknown
  `terminal_id` is held (capped at 64K characters) only while a
  `terminal_create` is in flight, since a new shell's first output can arrive
  before the create response.
- **Output pacing** — each `terminal_data` carries `sent_bytes`, the
  backend's running total of the terminal's output, and the `Terminal` acks
  the `sent_bytes` it has consumed through with `terminal_ack`. Consumed
  means every attached view's emulator has parsed the chunk, or, with no
  view attached, that the chunk is in the buffer — which drops its oldest
  output, so it never backs up. A ready view parses a chunk before `write`
  returns, and `TerminalViewLink` calls the listener's `consumed` right
  after. A view still loading its module queues the chunk unparsed, so its
  `consumed` waits until the view leaves `loading` (the view's `onstatus`):
  at `ready` the queued writes have been parsed, and every chunk that waited
  is consumed in order; at `failed` or `poisoned` nothing will parse them,
  and they're consumed too, so a view that can't draw never holds the
  process blocked. So the backend's window bounds what can queue while a
  view loads. The backend paces a terminal only against a connection that
  has acked it, so the `Terminal` announces its position
  (`TerminalOutputAcker.announce`: an ack sent at once, 0 when nothing has
  been consumed) when the process starts, before any view has consumed
  anything. On each socket connect (`Terminal.receive_socket_connect`) it
  holds the acks (`TerminalOutputAcker.hold`) until the first chunk on the
  new connection and announces that chunk's start: a position consumed
  before the connect is behind the output sent while the socket was down,
  which never arrives, so acking it could leave the terminal paused for
  good on output this tab can't consume. Between a reconnect and that
  announce reaching the backend — about a round trip after the first chunk —
  the output is unpaced. A view that detaches stops being waited on — the
  cell drops its listener, and what that listener hadn't consumed counts no
  more. `TerminalOutputAcker` batches the acks: one at once when 256 KiB are
  waiting, otherwise after a short delay so the last of a
  burst is acked too, and never more than one in flight — what's consumed
  meanwhile waits for it and goes in the next, by the same rule. The backend
  stops reading a terminal that gets 1 MiB ahead of its acks, which blocks
  the process until the view catches up, and reads again once 256 KiB or
  less is unacked — the ack threshold is no higher than that, so a view that
  has caught up acks at once rather than after the delay. Output for a
  terminal this tab doesn't hold is never acked, so the backend never slows
  one down for this tab. Acks are flow control, not user actions: they stay
  out of the actions log, and one answered `not_found` — its terminal closed
  or exited first — just ends the acks (`QUIET_ACTION_METHODS`).
- **Input** — `Terminal.send_input` keeps at most one `terminal_data_send` in
  flight per terminal and coalesces data typed meanwhile into the next send,
  so keystrokes stay ordered even though the backend dispatches one socket's
  requests concurrently. A `queue_overflow` (the child isn't reading its
  input) requeues the refused data ahead of newer input and retries with
  backoff — nothing was enqueued, so a resend can't duplicate — and shows the
  error until a send succeeds; other failures are shown without a retry,
  since the data may have been delivered. Pending input is capped.
  The view's bytes arrive as `Uint8Array`s (keys typed, replies to live
  queries) and are decoded as UTF-8 by a streaming decoder per view, since
  input goes over the wire as text. `Terminal.resize` coalesces to the latest
  size the same way; the view calls it with its size in cells when its
  emulator is created and whenever its box or font changes.
- **The view** — `TerminalView` fills the height its host gives it (the
  terminals page gives each run a fixed height) and lays the emulator's box
  over a stretched flex item absolutely, so the box has a definite size. It
  hosts one `FuzTerminal`, whose module comes from `load_fuz_terminal_module`
  (`fuz_terminal_module.ts`): `static/fuz_terminal/ghostty-vt.wasm`, fetched
  and compiled once per page and shared by every view, a failed load dropped
  so the next view retries. A missing module — a 404, or an HTML page in its
  place — leaves the view `failed` with a message naming `cargo xtask
  ghostty-vt`, and so does a load that hasn't settled within
  `FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS` (about 30 seconds; the fetch is
  aborted), which is what ends a load that would never finish: the view
  fails, the output it held is released, and its retry is offered; the process runs regardless and its output buffers, though
  nothing answers its queries, so a shell that waits for a reply at startup
  stalls until its own timeout. A view whose emulator is `poisoned` shows
  "reopen", and a `failed` one "retry": either remounts it — a fresh
  instance, replayed from the cell's buffer — and a retry loads the module
  again, so building it and retrying recovers without a page reload. The
  view takes keys (`accepts_input`) exactly while `send_input` takes bytes,
  so a terminal whose process ended leaves keys — Tab included — to the
  browser. A view taking keys marks its root (`data-fuz-terminal-keys`), and
  the dashboard's global shortcuts (`dashboard_shortcuts.ts`: `` ` ``, `~`,
  Escape) leave keys whose target is inside one
  (`is_fuz_terminal_key_target`) to the terminal, as they leave a text
  field's. The copy button and the context
  menu's "copy output" read the emulator's text (`get_text`: the scrollback
  and screen, soft wraps joined). The view passes
  `TERMINAL_SCROLLBACK_MAX_BYTES` (2 MiB) as the emulator's
  `scrollback_max_bytes`: the limit counts the emulator's memory, pruned in
  whole pages, so a wider or more styled terminal keeps fewer lines,
  dropping the oldest; the library's default keeps a single page. A remount
  replays the whole output buffer, which usually holds more than that, so
  the fresh emulator keeps the newest history up to the limit.
  The context menu's "paste" (enabled
  exactly while the terminal takes input) reads the clipboard
  (`read_clipboard_text`, `navigator.clipboard.readText`, started in the
  entry's activation, since a browser allows the read only with a user
  gesture — Chrome asks for permission once, Firefox shows its own paste
  button) and hands the read to the view, which runs `paste_terminal_text`
  (`terminal_paste.ts`) over `FuzTerminal.paste` (§ fuz_terminal, *Paste*).
  A paste longer than the terminal's input takes now (`Terminal.input_room`:
  what's left of `TERMINAL_INPUT_PENDING_MAX_LENGTH` after the input waiting
  to be sent, which `send_input` would otherwise drop the whole paste past)
  is refused whole, naming the limit — measured as `send_input` measures, the
  bracketed frame included, and before the text's safety, so a paste that
  can't fit is never asked about. Unsafe text (`get_ghostty_paste_hazard`)
  is pasted only once the person confirms it (`confirm`), and the
  confirmation covers only the hazard asked about: the second paste allows
  that hazard in that mode, so if the program toggled bracketed paste while
  the person was asked and the text is unsafe in the new mode (its hazard,
  or only the mode, differs from what was asked), nothing is sent and
  the notice says to paste again, which asks about the text as it is then
  (text the toggle made safe is pasted). Asking again at once instead could
  repeat for as long as a program kept toggling; the refusal is bounded. A
  failed or empty read, a refusal, or a view that takes no input is shown
  in the view as a notice until the next paste that doesn't fail, or it's
  dismissed — never thrown. A paste that goes through focuses the terminal.
  `TerminalViewLink` (`terminal_view_link.ts`)
  is the wiring between the cell and one view — attach and replay, acks,
  input decoding, resize — kept out of the component so tests drive it with
  a real `Terminal` cell.
- **Status** — `starting` → `running` → `exited` (natural exit via the
  `terminal_exited` broadcast, with its code) or `closed` (the user's
  `terminal_close`, with the code from its response, or `null` if the process
  outlived the close grace), or `failed` (spawn error). Exits are recorded
  on the cell whether or not a view is mounted.

`Terminals.create` always spawns a shell (`terminal_create({command: 'sh'})`)
and types the actual command line into it via the input queue — queued while
starting, so it goes ahead of anything else sent before the process starts.
A typed line reaches the shell verbatim (trimmed): `parse_terminal_command`
only splits off its first word as `command` (for display and a preset's
default name) and keeps the rest of the line, separator included, as the one
arg, which `format_terminal_command` rejoins byte for byte — quoting,
comments, and continuation lines are the shell's to interpret.
If the process exits before the create response arrives, the queued input is
discarded. Restart
closes a running terminal (and gives up if the close fails, rather than
orphan a live process), then spawns a fresh process into the same cell with
a new `terminal_id` and cleared output. Removing a terminal closes it if
running, then disposes the cell. The terminal list is in-memory: a page
reload loses it while the backend PTYs keep running (`session_load` lists
their ids, but reattaching would also need their commands and output).

A terminal the backend no longer has becomes `lost`, with an
`error_message` saying why, and its queued input is dropped: when
`terminal_data_send` or `terminal_resize` answers `not_found`, or when the
session snapshot loaded after a reconnect doesn't list a terminal that was
running (the message tells a zzzd restart — a new `server_instance_id` —
from a process that ended or was closed from another tab while the
connection was down, whose `terminal_exited` was missed). A lost terminal
can be restarted. The backend drops a terminal just before sending its
`terminal_exited`, so one can be marked lost moments before its real exit
arrives; the exit then wins (`exited` with its code). Output sent while the socket was down is lost too, so a
reconnect flags each running terminal's `output_gap`, and its view shows a
dismissible "connection lost — some output may be missing" notice.

Each terminal is one backend task that owns the PTY master and the child
process. Input chunks are written in the order `terminal_data_send` calls
reach the handler; sends on one socket are dispatched concurrently, so
keeping keystrokes ordered across sends is the client's job.

On natural process exit the task reaps the child, broadcasts
`terminal_exited` with the real exit code, and removes its entry. An explicit
`terminal_close` signals the process (`SIGTERM` by default, or `SIGKILL` —
any other signal is `invalid_params`), then closes the
PTY master — the hangup ends a shell that ignores SIGTERM — and returns the
exit code in the RPC response, or `null` if the process is still running
after a short grace; the backend keeps reaping it (SIGKILL after 3s), and no
`terminal_exited` is broadcast for a closed terminal. `terminal_data_send`
and `terminal_resize` for an id the caller has no live terminal under —
unknown, ended, lost to a restart, or another account's — fail with the same
`not_found`, and so does `terminal_close` (the frontend treats that as
closed: the process is already gone). A `terminal_create` `cwd` must be
absolute (`invalid_params` otherwise), so it never resolves against the
daemon's own working directory.
Children get the
server's environment minus its secrets and config (`SECRET_*`, `FUZ_*`,
`ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, `PORT`). Terminals are pure
in-memory process state — no persistence; a server restart ends them, and
clients find them `lost` when they resync.

### fuz_terminal

`src/lib/fuz_terminal/` binds libghostty-vt's wasm build — Ghostty's
emulator: parsing, the screens, scrollback with reflow — and draws it with
`FuzTerminal.svelte`, a DOM renderer of zzz's own, which zzz's terminal views
host (see [Terminals](#terminals) above). The binding has no DOM or Svelte
dependency, so its behavior is tested in Node:

- `ghostty_vt.ts` — `load_ghostty_vt` and `GhosttyVt`: the instance (its
  function exports guarded against an escaping exception, below), its
  validated type manifest, its build info (version, compiled-in features),
  and `check` for result codes. The core resolves its constants at load
  (`GhosttyVt.constants`); each other module resolves its own once, on first
  use (`GhosttyVt.resolve`), so enum values and offsets are never hardcoded.
- `ghostty_terminal.ts` — `GhosttyTerminal`: write, resize, plain-text
  format, effects, dispose. A query in the output gets a reply only through
  a registered `write_pty` handler. Width and height are capped at
  `GHOSTTY_TERMINAL_MAX_SIZE` cells: the screen is allocated up front and
  wasm memory never shrinks, so an absurd size (a bad cell measurement) is
  refused before it can grow memory by gigabytes. Writes go through a
  per-terminal buffer kept between writes. A terminal can be created with
  modes set, each as its reset default too (`modes`).
- `fuz_terminal_module.ts` (beside the library, in `src/lib/`, since it knows
  the app's asset path) — `load_fuz_terminal_module`: the page's one fetch
  and compile of the module, for every view (see [Terminals](#terminals)).
- `ghostty_memory.ts` — linear memory: views cached until memory grows,
  never held across an export call; scratch and opaque-slot allocations
  freed on every path. Buffers the library allocates
  (the formatter's output) are freed with `ghostty_free`.
- `ghostty_render_state.ts` — `GhosttyRenderState`: the render-state
  reader, turning the library's per-frame copy of the screen into plain
  frame data a renderer draws (below). Its terminal disposes it first.
- `ghostty_key_encoder.ts` — `GhosttyKeyEncoder`: key events to the bytes
  a program expects, following the terminal's input modes (below). Its
  terminal disposes it first.
- `ghostty_effects.ts` — the effects the binding registers (`write_pty`,
  `bell`, `title_changed`, `pwd_changed`, `render_hold`), their handler
  types, their constants and callback signatures from the manifest, and
  `GhosttyEffectRouter`, which dispatches each callback by terminal handle.
- `ghostty_callback_table.ts`, `wasm_trampoline.ts` — function-table slots
  holding JS callbacks, each added once and kept for the instance's life;
  a trampoline is a tiny wasm module, encoded and compiled at runtime,
  that wraps a JS function as a wasm one (a table slot takes only those).
- `ghostty_manifest.ts`, `ghostty_errors.ts` — the manifest reader (enum
  values, struct layouts, and the bit positions of packed types such as
  `GhosttyCell`, which aren't ABI) and the binding's errors.

The renderer, beside it (tested under jsdom with the built module):

- `FuzTerminal.svelte` — the view: the root element, the keyed rows, the
  cursor, a cell probe, and a plain-text message for a failure.
- `fuz_terminal_state.svelte.ts` — `FuzTerminalState`: the view's instance,
  terminal, and reader, the frame loop, render holds, sizing, and errors;
  `FuzTerminalOptions` is the host's side (the component's props).
- `fuz_terminal_keyboard.ts` — a `KeyboardEvent` to a `GhosttyKeyInput`
  (the key from `code`, the modifiers, the text, the unshifted code point),
  and which keys the browser and the OS keep.
- `fuz_terminal_key_target.ts` — whether a key event's target is a view
  that takes keys, for a page's global shortcuts; apart from the keyboard
  module, so every page's shortcuts load none of the key encoding.
- `fuz_terminal_style.ts` — styles and colors to CSS: a style's declarations
  (cached by key), and the root's color custom properties for a frame.
- `fuz_terminal_layout.ts` — the size in cells from a measurement, a row's
  runs split for boxing, and the cursor's box.
- `fuz_terminal_frame.ts` — `FuzTerminalFrameLoop`, at most one frame
  pending.
- `fuz_terminal_deps.ts` — `FuzTerminalDeps` (loading, frames, a timer,
  resize observation, measuring, the keyboard platform), the browser's
  defaults, and the context a test sets its own through.

**Effects.** A program's output asks the terminal for things it can't do
itself — answer a query, ring the bell, retitle the window. libghostty-vt
hands each to a callback the host registers (`GhosttyTerminal.set_effect`),
and ignores it when none is: a cursor-position or device-attributes query
gets no reply, and none arrives later. That's what lets a history be fed
into a fresh terminal without answering its stale queries — feed it with no
`write_pty` registered, then register one for the live output. What the
history does to the terminal's state still carries forward, as it should
when the live stream continues it: a history that turned on the in-band
size report (mode 2048) makes the first resize after registering send a
report, and a history that ends partway through a query is answered when
the live output completes it.

```
write(bytes) ─ busy ─ ghostty_terminal_vt_write ── parser hits ESC[6n
                                                       │ call_indirect(slot)
                       trampoline (table slot, one per effect per instance)
                                                       │ (terminal, userdata, ptr, len)
                       GhosttyEffectRouter ── by terminal handle ──▶ the terminal's receiver
                                                       │ copy the bytes, call the handler
                                                       │ (a throw is kept, never rethrown here)
           ◀── vt_write returns ── rest of the output parsed ──┘
       idle; a kept handler exception is thrown now, as GhosttyEffectError
```

The rules follow from callbacks running in the middle of the library's
parse: a handler can read the terminal but not write, resize, dispose, or
re-register it (`GhosttyReentrancyError`); the data it's passed is borrowed,
so the binding copies or decodes it before the handler sees it; it may write
other terminals; its return value is ignored, so an async handler catches
its own errors. The callback slots are bounded: one per effect per module
instance, added on first registration and never released, since a wasm
table can't shrink. The library's other effects aren't bound and are never
registered; the clipboard ones stay that way until there's a way to ask the
person first. The trampolines are compiled at runtime, so a page
Content-Security-Policy would have to allow wasm compilation
(`'wasm-unsafe-eval'`) — which loading the module needs anyway.

**Poisoning.** A handler's exception is caught inside the callback and
surfaced after the call. One can still escape a call into the module: a
trap, or the JS stack running out inside the module's frames or at the
callback boundary, before the catch is reached. Unwinding through wasm
skips the frames' epilogues, so the stack pointer the module keeps in
linear memory stays moved (enough escapes and an ordinary call traps), the
write it abandoned left that terminal mid-parse, and it may have landed
mid-allocation in the heap every terminal on the instance shares. Rather
than guess at what survived, `GhosttyVt` wraps each function export once at
load, and the first escape poisons the instance — later modules' calls
included, with nothing to opt into:

- The exception reaches the caller of the call it escaped from, unchanged:
  the cleanup on its way out (scratch frees, the formatter's output)
  skips its own calls into the module rather than have them refused.
- Every later call throws `GhosttyPoisonedError`, with the escape as its
  `cause`, before entering wasm. `GhosttyVt.poisoned` records the export
  it escaped from and the exception.
- A `write` or `resize` during which a nested call poisoned the instance —
  a handler's own call, or its write to another terminal — throws
  `GhosttyPoisonedError` once it returns, and that wins over any handler
  exception. Once poisoned, no handler runs for the rest of the parse.
- Poison belongs to the module instance, not the `GhosttyVt` object: every
  wrapper of one instance sees it, and other instances don't.
- A stack overflow at a call's very entry poisons too, though it disturbed
  nothing: the guard can't tell it from one that did.

A poisoned instance's terminals dispose without calling in, and its memory
goes when it's collected; a host builds a fresh instance from the compiled
module. The guard costs a few nanoseconds a call.

**Rendering data.** libghostty-vt's render state is a copy of what one
frame needs, updated in place from the terminal — it redoes only what
changed — with two layers of change tracking: the frame's (clean, partial,
full) and a flag per row. An update only adds to them; the renderer clears
both once it has drawn (`ghostty_render_state_clean`). `GhosttyRenderState`
reads it into JS once per update and keeps nothing of wasm memory:

```
update() ─ ghostty_render_state_update ─ get_multi(dirty, size, cursor, colors)
   │ clean: done — two calls, nothing allocated
   └ else, per row: next + get_multi(dirty flag, id, raw cells, cells handle)
        clean row with a known id → its previous object
        dirty row → decode its raw cells (one u64 each, bits from the manifest)
             a style id new to the row → select + STYLE, interned by value
             a multi-code-point cluster → select + GRAPHEMES_BUF
           → runs; equal to the previous object under that id → keep that
```

- **Rows** are `{id, runs}`, every viewport row in order. The id is the
  library's row identity as a string: it stays with a row as the screen
  scrolls, so it keys a keyed list. A row's object is replaced only when
  its contents change — the library rebuilds every row after an ordinary
  scroll, and
  the reader compares what it decoded with the previous object under the
  same id — so a keyed list re-renders just the rows whose object is new.
  The row's position is its index; the object holds none, so it survives
  moving. An edit that moves rows within the library's page — a scroll
  inside a scroll region (DECSTBM), inserted or deleted lines, some erases
  — gives every row of that page a new id, rows outside the edit included,
  so those rows come back as new objects, on what may be only a `partial`
  update. The library also numbers each screen's rows on its own: after a
  switch between the primary and alternate screens an id can come back for
  a different row, whose object then holds that row's contents.
- **Runs** cover a row from column 0 without gaps, up to its last cell that
  draws anything: trailing blanks in the default style are dropped (and
  the unstyled spacer head a wrapped wide character leaves in the last
  column), a
  styled blank is kept, and a cell of background only (an erase with a
  color, held in the cell rather than a style) is a space in that
  background. A run is consecutive cells with one style and one hyperlink
  flag, with its column `x` and its `width` in columns, so nothing needs
  measuring: a plain run has one code point per narrow cell; a wide
  character or a grapheme of several code points (combining marks, a ZWJ
  sequence under mode 2027) is a run of its own, a `cluster` to box to its
  width, since a fallback font's glyph needn't match the cell. The second
  cell of a wide character has no text and makes no run.
- **Styles** are interned per reader by value and carry a stable `key` to
  cache derived CSS by. The cache holds two generations — the styles the
  current update read and the previous update's — so it stays about two
  screens' worth however many styles a program makes, and a style read in
  consecutive updates that read rows keeps its object (a row kept unchanged
  doesn't count as a read); one unread for such an update is let go, and
  comes back as a new object with the same key, so styles are compared by
  key. A color is `null` for the default, a palette index,
  or RGB; palette colors stay indices, so a palette change recolors without
  touching rows. Flags are the SGR ones; `inverse` is left for the renderer
  to apply after resolving defaults. Style ids in cells are only meaningful
  within their row's page, so the reader caches the ids it has read per row
  only; id 0 is the default style, read without a call.
- **Cursor and colors** are read on every update, since a cursor shape, its
  visibility, or a default color (OSC 10/11/12) changes without dirtying a
  row; a palette change (OSC 4) is a full update. Each is a new object
  only when it changed. The default foreground and background are the
  library's white-on-black placeholders until the terminal has both set:
  the render state takes them only as a pair, so an OSC 11 alone still
  reports the placeholders.

A terminal has at most one live `GhosttyRenderState` — a second is refused
— since an update consumes the terminal's change tracking and a second
reader would miss what the first took. The output is plain immutable data,
so any number of views can share one reader. After it's disposed a new one
can be made, and its first update is a full frame.

The library misses one change: with grapheme clustering (mode 2027) off, a
combining mark or other zero-width character that arrives in a write of its
own joins the cell before it without marking that row changed. The update is
`clean` and the row keeps showing the cell without the mark until anything
else changes the row, which brings it back right. With mode 2027 on, or the
mark in the same write as its base, it's tracked. The reader can't detect
it, so `FuzTerminal` creates every terminal with the mode on (below); a
program that turns it off brings the gap back for that terminal.

The reader's calls only write buffers it owns, after the update itself, so
it reads its views of memory across them, taking them again if one ever
came back detached and always after growing its own grapheme buffer. The
cell data is borrowed from the render state until the next update; the
reader copies what it keeps before then.

**Render holds.** A program redrawing the whole screen sets synchronized
output (mode 2026) so it isn't seen half-drawn. The library reports the
hold through the `render_hold` effect, `true` at the start — when the
terminal holds exactly the frame to keep showing, later bytes of the same
write not yet parsed — and `false` at the end (the mode reset, a full
reset, or a resize). A renderer updates its `GhosttyRenderState` from the
handler when a hold begins, then doesn't update until it ends — or until a
timeout of its own, after which it stops honoring the hold, since the
terminal has no clock and never ends one itself. Updating from
a handler is allowed: an update reads the terminal and consumes its change
tracking without changing what it shows, and effects fire between whole
steps of the parse. Writing, resizing, or disposing the terminal from a
handler still throws `GhosttyReentrancyError`.

**Keyboard input.** A key reaches a program as bytes, and which bytes
depends on modes the program sets in its output: the up arrow is `ESC [ A`
until it turns on application cursor mode, then `ESC O A`; under the Kitty
keyboard protocol most keys become `CSI … u` sequences. libghostty-vt's key
encoder holds those modes as options, and its sync call copies them from a
terminal when it's made — it doesn't stay attached. `GhosttyKeyEncoder`
syncs before every encode, so a mode set by output written just before a
key press decides what the key sends:

```
keydown ─ FuzTerminalState.handle_key
   │ not ready, composing, or a key the browser keeps → not taken (default runs)
   └ to_fuz_terminal_key_input(event) → {action, key, mods, consumed_mods, text, unshifted}
        GhosttyKeyEncoder.encode ─ set_from_terminal ─ set the event ─ encode
           │ out of space → grow the output buffer to the size asked, encode again
           └ bytes → ondata, and preventDefault; none → default runs
```

- **The encoder** keeps one key event and its own buffers for its life: the
  event points into the encoder's text buffer (the library doesn't copy
  text), the output buffer grows once if a sequence doesn't fit, and after
  the first keys an encode allocates nothing in the module. A terminal may
  have any number; encoding reads the terminal and changes nothing. The
  bytes are the library's encodings, Ghostty's own: Ctrl+Shift+letter is
  CSI u, distinct from
  Ctrl+letter, and modified Enter, Tab, and Escape send the library's
  distinct sequences in every mode (Shift+Enter and Ctrl+Enter are
  `CSI 27;2;13~` and `CSI 27;5;13~`). Mode 1035 is on by default, so
  application keypad mode (DECKPAM) leaves the keypad numeric until a
  program turns 1035 off.
- **Classic Ctrl chords** are the one place the encoder departs from the
  library, on purpose (`to_classic_ctrl_chord_bytes`). The library keeps
  Ctrl+[, Ctrl+I, Ctrl+M, and Ctrl+@ distinct from Escape, Tab, Enter, and
  NUL even in legacy mode, as fixterms `CSI … u` — junk to a program that
  asked for no keyboard protocol (bash's readline, whose vi mode takes
  Ctrl+[ for Escape; less; nano; a plain REPL). So when the program has
  asked for nothing, those four send ESC, Tab, CR, and NUL — ESC-prefixed
  with Alt, as the library prefixes its other Ctrl+Alt chords. Two
  conditions say it asked for nothing: the active screen's Kitty keyboard
  flags are zero (read from the terminal, `KITTY_KEYBOARD_FLAGS`, after the
  encode), and the library's output is its fixterms form — under
  modifyOtherKeys 2, which the C API doesn't expose, the output is
  `CSI 27;…~` instead, so it's left as the program asked. The chord's
  character is found as the library finds it for its other C0 chords: the
  text when it's one byte, else, with Ctrl alone, the physical key's — so
  German Ctrl+Ü, on the US `[` key, is ESC, and a `[` typed with AltGr isn't
  a Ctrl chord at all. Ctrl+Shift+I and Ctrl+Shift+M stay the library's (`@`
  takes Shift on a US layout, so Ctrl+Shift+2 is NUL).
- **The mapping** (`to_fuz_terminal_key_input`) reads only the event's
  fields. The key comes from `code`: the library's key names follow the UI
  Events codes (`A` for `KeyA`, `DIGIT_1` for `Digit1`, `F12` for `F12`), so
  the table is built from the manifest's names by that rule, plus a few
  legacy aliases and the numpad with NumLock off, which a browser reports as
  the digit's `code` with the navigation key's `key` (`Numpad1` + `End` →
  `NUMPAD_END`). A unit test holds the rule to every name in the manifest,
  and a wasm test holds the module's key enum to the fixture's, so an
  upgrade that adds keys fails until they're mapped. The text is `key` when
  it's a character — never a key name (`Enter`, `Dead`, `Process`,
  `Unidentified`) or a control character — and before any Ctrl
  transformation, as the encoder wants (`c` for Ctrl+C). Meta is the super
  modifier, CapsLock and NumLock come from `getModifierState`, a side bit is
  set only on a right-hand modifier's own event, and when AltGraph made the
  text Ctrl and Alt are dropped (Windows reports AltGr as Ctrl+Alt). The
  modifiers the text used up (`get_fuz_terminal_consumed_mods`) let the
  encoder send the text as typed: Shift whenever it's held and the key made
  text — Shift+A's `A`, AZERTY's Shift+`&` `1`, CapsLock with Shift's `a`
  are plain text to the Kitty protocol — except on Space and the numpad, so
  Shift+Space stays a shifted space. On macOS Option is the layout's level
  for typing characters, so Option that typed a character — with neither
  Ctrl nor Meta held — is not reported as Alt: it's dropped from the
  modifiers, as AltGraph's Ctrl and Alt are. A German Mac's Option+5 `[` and
  Option+L `@` are sent as `[` and `@`, not with the alt escape prefix
  (`ESC [` would start a sequence), and under the Kitty protocol's
  report-all flag the `[` arrives as the key's text; the price is that such
  a program can't tell Option was held. Option+Left, which makes no text,
  and Option with Ctrl are still Alt. The platform is
  `FuzTerminalDeps.key_platform`, from the client hints or
  `navigator.platform` by default (`to_fuz_terminal_key_platform`); the
  mapping takes it as an argument, so it's tested both ways. Option as Meta
  is still to come, as a host option.
- **The unshifted code point** is the key's text lowercased when it's a
  cased letter, the key's own text when nothing (Shift, Alt, AltGraph)
  changed it, and otherwise the character a US layout has on that physical
  key — or, for a key the US layout hasn't (`IntlBackslash`, `IntlRo`,
  `IntlYen`, an empty `code`), the text's own character, lowercased, so the
  key keeps its modifiers and its release. That's right for letters on any
  layout and for unshifted keys, and wrong for a shifted digit or
  punctuation key on a layout that puts another character there unshifted
  (German Shift+ß, `?`, reports the US `-`); under the Kitty protocol that's
  the key code sent, and its base-layout alternates assume US too. A
  browser's layout map (`navigator.keyboard.getLayoutMap()`) would fix it,
  but only Chromium has one.
- **Copy chords**: Ctrl+Alt+C and Ctrl+Insert, with no Shift or Meta,
  copy the page's selection when it takes some of the view's text — one
  that only touches the view's edge, as a triple-click on the block above
  it does, doesn't count (`is_fuz_terminal_copy_key`,
  `FuzTerminalDeps.read_selection`). The copy is the whole selection's
  text, even where it reaches outside the view — what the user selected,
  and what the browser's own copy would take — written with
  `navigator.clipboard.writeText` (`write_clipboard`; a secure context,
  which `localhost` is, and the key press is the user activation it needs).
  A key that copied sends nothing, is prevented, and isn't held, so it
  sends no release either; it copies whatever the status or
  `accepts_input`, since a stopped view still shows its last frame. A write
  that fails or rejects is reported through `onerror` and the notice, never
  thrown, and the next copy that succeeds clears that notice. With no
  selection there the chord is the program's, as any other key. Ctrl+C is
  always the program's. The view writes the clipboard itself rather than
  leave the chord to the browser: Ctrl+Alt+C is no browser shortcut, and
  Ctrl+Insert, which browsers on Linux and Windows copy with, must reach
  the program when nothing is selected. C is matched by the layout's
  character, or by the physical key when the layout's is a letter of
  another script (Cyrillic `с`), never with AltGraph held, nor when
  Ctrl+Alt made a Latin letter or a symbol — Windows reports AltGr as
  Ctrl+Alt, and Polish AltGr+C types `ć`. On macOS neither chord copies:
  Cmd+C is the platform's copy and passes to the browser as a Meta
  combination, so, as with the zoom keys, Ctrl+Option+C and Ctrl+Insert
  stay the program's.
- **What the terminal doesn't take** keeps its default: a key while the
  view isn't ready; a keydown in a composition — an IME's (`isComposing`,
  `Process`, key code 229) or a dead key — whose text arrives later (a dead
  key's composed character comes as the next keydown's `key`, and is sent;
  an IME's needs a text input, still to come); any combination with Meta,
  the OS's and the browser's shortcuts; Ctrl+Shift+C and Ctrl+Shift+V,
  reserved for copy and paste; and, except on macOS, the browser's page
  zoom: Ctrl with `=`, `+`, `-`, `_`, or `0`, Shift or not, the numpad's
  `+`, `-`, and `0` included (`should_fuz_terminal_pass_key`, one function
  so a host override can be added). The zoom keys are matched by the
  layout's character, so on a German layout Ctrl with the `+` key passes
  and Ctrl+ß doesn't. With Alt held they stay the program's: Windows reports
  AltGr as Ctrl+Alt, and browsers don't zoom on Ctrl+Alt. On macOS the
  browser zooms with Cmd, a Meta combination already passed, and Ctrl with
  them is the program's. Everything else the encoder has bytes for is the
  program's, as in other browser terminals: Tab, Escape, the function keys,
  Ctrl+W, Ctrl+digit. A modifier alone, or a key the encoder has nothing
  for, sends nothing and keeps its default.
- **Errors** go the way writes' do: a library failure while encoding fails
  the view and an escape poisons it — neither leaves the event handler —
  and an `ondata` that throws is reported, not fatal. Key bytes and the
  terminal's replies share `ondata`, in the order they happen.

**The Kitty keyboard protocol** lets a program ask for unambiguous key
reports — every key and modifier as an escape code, presses, repeats, and
releases told apart, the text a key produced. It can't be left
unadvertised: the library always takes a program's push, set, and pop of
the flags, and answers its query (`CSI ? u`) through `write_pty`; no
terminal option, mode, or build feature turns that off — so a program
that asks (neovim, helix, fish) finds it and turns it on. Encoding legacy
while the terminal told the program otherwise would have it misparse keys,
so the encoder follows the flags as set — each screen has its own, so a
program leaving the alternate screen leaves its flags there — and the view
supports the protocol as far as browser events allow. A `keyup` is encoded
as a release, which sends bytes only while the program has event reporting
on (legacy encoding and the protocol's other flags send nothing for one),
and only for a key whose press was taken — it reached the encoder, whether
or not it sent anything. A taken press's release is encoded whatever the
modifiers are by then (Meta added while the key was held, or Shift making
a Ctrl+C into Ctrl+Shift+C), and once; a release whose press went to the
browser, was composed, or came before the view had focus is dropped, and
the keys held when focus leaves are forgotten. The protocol's key codes are
the unshifted code points above, so their US-layout fallback carries over.

**The DOM renderer.** `FuzTerminal` draws one terminal's screen as DOM
text, and takes its keys (above) and the text its host pastes (*Paste*,
below). It takes no paste events of its own (Ctrl+Shift+V, Shift+Insert, a
middle click), IME, focus reporting, or mouse reporting yet, doesn't scroll
into the scrollback, and has no selection of its own: the rows are text, so
the browser's selection works over them, and the copy chords (above) copy
it. Each row is a block of
inline runs, so a selection copies a row as one line and a block of rows as
one line per row — a soft-wrapped line copies broken at the wrap (the rows
don't carry the wrap flag yet). It has no dependency on zzz's app — no
cells, no actions.

*Ownership.* The host loads and compiles the module and passes it — or the
promise of it, a fetch and compile in flight — as `module`; the view is
`loading` until it settles and `failed` if it rejects. The view
instantiates its own instance, terminal, and render-state reader, and frees
the terminal (which frees the reader first) and drops the instance on
unmount; unmounted before the module arrives, it instantiates nothing. One
instance per view: an escape that poisons an instance stops only that view,
a huge terminal's memory growth is its own, and an unmounted view's linear
memory can be collected (wasm memory never shrinks while its instance
lives). Instantiating from a compiled module and creating the terminal and
reader is cheap next to the compile the host does once; each instance
parses its own type manifest, the larger part of that cost.

*Modes.* Every view's terminal is created with `FUZ_TERMINAL_MODES`, set as
the modes' reset defaults (`GhosttyTerminalOptions.modes`, the library's
`GHOSTTY_TERMINAL_OPT_MODE_DEFAULT`), so a full reset (RIS) keeps them:
grapheme clustering (mode 2027) on, so an emoji sequence or a base and its
combining marks take one cell, and a mark in a write of its own is drawn. A
program can still turn it off. It's the view's, not a prop: a host has no
reason to want the stale rows that come with it off.

*Host API.* Props: `module`; `scrollback_max_bytes` (unset, the library's
default, which keeps a single page of history; zzz's `TerminalView` passes
`TERMINAL_SCROLLBACK_MAX_BYTES`); `label`, the
accessible name; `accepts_input` (default on — off, a key is neither encoded
nor prevented, so the browser's default runs, and the cursor is drawn
hollow, as when unfocused: hollow rather than hidden, so where the program
left it stays visible; drawing, selection, copy, resizing, and replies to
queries go on); and the callbacks `ondata` (bytes for the PTY: the keys
typed, and the terminal's replies), `onresize`
(the size in cells, at creation and on each change), `ontitle`, `onbell`,
`onstatus`, and `onerror`. `module` and `scrollback_max_bytes` are read once,
when the view starts; the callbacks whenever they're called, and never once
the view is destroyed. Through `bind:this` the host calls:

- `write(data, options?)` — bytes or a string, written in call order:
  queued while the module loads; from a callback inside a write, written
  right after that write rather than reentering it. Callbacks may make at
  most `FUZ_TERMINAL_MAX_CALLBACK_WRITES` writes during one outermost write
  or resize — past that they're dropped and reported through `onerror`, so
  an `ondata` that writes its replies back as output can't loop forever.
  `{replay: true}` marks output replayed from a buffer: it's processed with
  the reply effects (`write_pty`, `bell`) unregistered, whether it arrives
  while loading or later, so a query in it is never answered and a bell in it
  never rings, whatever it's interleaved with. A title it sets reaches
  `ontitle`, a render hold it starts is honored, and what it does to the
  terminal's state carries forward (above).
- `paste(text, options?)` — the text sent to `ondata` as a paste (*Paste*,
  below), returning what happened.
- `get_text()` — the screen as plain text through the formatter, for a
  copy-all.
- `focus()`, `get_status()`, `get_size()`.

The status is `loading`, `ready`, `failed` (the module didn't arrive,
compile, or instantiate, the terminal couldn't be created, or the library
failed), or `poisoned` (`GhosttyVt.poisoned`); a failed or poisoned view
keeps its last frame, shows a plain-text message, ignores writes, and a host
recovers by mounting a new one. `onstatus` hears of `ready` after the writes
queued while loading are written, so a write it makes follows them, and
replies to those writes reach `ondata` before it. A
callback that throws — inside a write, from a frame, or on a resize — never
escapes: it's handed to `onerror` (or the console) and shown as a notice,
and the view goes on; so is a failed copy (above), with its own notice.

*Paste.* `paste(text, {allow_unsafe?, max_length?})` sends text as the
person pasting it: encoded under the terminal's modes as they are now
(`GhosttyTerminal.encode_paste`, over the library's `ghostty_paste_encode`)
and handed to `ondata` in one call, like a key's bytes. The encoder replaces
the control bytes xterm strips from a paste (NUL, BS, ENQ, EOT, ESC, DEL,
and the tty's special characters such as Ctrl+C, Ctrl+Z, and Ctrl+U) with
spaces, then frames the text in `ESC [200~` … `ESC [201~` when the program
has turned on bracketed paste (mode 2004), or turns each newline into a
carriage return when it hasn't. Every change is an ASCII byte for an ASCII
byte, never a byte of a multi-byte sequence, so the encoded length is
known before encoding (`to_ghostty_paste_length`: the text's length in
UTF-16 code units, plus the frame's 12 when bracketed).

Before encoding comes the library's terminal-aware safety rule
(`get_ghostty_paste_hazard`, its `isSafeWith`), on the text as given:
bracketed, text holding the end sequence `ESC [201~` is unsafe
(`paste_end`); unbracketed, so is a newline or carriage return
(`line_break`), since each reaches the program as Enter. Unbracketed text
holding both is reported as `line_break` — that's what runs commands as the
text arrives, while the end sequence's ESC is replaced anyway; whether text
is safe is the library's call, which hazard is named the binding's. Unsafe
text is refused (`rejected`, with the hazard and whether the paste is
bracketed) unless `allow_unsafe` names that risk: the host asks the person,
then pastes again passing the `rejected` result's hazard and mode
(`GhosttyPasteRisk`). A confirmation covers only what was asked — if the
program toggled bracketed paste in between and the text's hazard or mode
changed, it's rejected again as it is now, and text the toggle made safe is
sent.

Nothing is sent while the view takes no input (`unavailable`: not ready,
`accepts_input` off, or from a callback inside a write, where the bytes
would land among its replies, a replay's included), for empty text
(`empty`), or when the encoded text is longer than `max_length`
(`too_large`, in UTF-16 code units of its bytes decoded as UTF-8, framing
included). The length is checked before the text's safety, so a paste that
can't fit is reported `too_large`, never `rejected`, and is never asked
about: a paste goes whole or not at all. The library's own
`ghostty_terminal_paste` makes the same bytes — a Kitty paste event (mode
5522) needs a clipboard-read effect, which the view never registers — but
reads its text through a callback and streams the result through
`write_pty`; encoding in one call lets the host measure it before anything
is sent, and needs no callback into the library's writer.
`ghostty_paste.wasm.test.ts` checks the two against each other — the rule,
the bytes, and the length, a rejection's too — over texts that probe the
rule and the encoder and over seeded random ones.

*Keys and the page.* While the view takes keys — ready, `accepts_input` on
— its root carries `data-fuz-terminal-keys` (`FUZ_TERMINAL_KEYS_ATTRIBUTE`),
and `is_fuz_terminal_key_target(target)` says whether an event target is
inside such a view. A page's global shortcuts check it beside their check
for a text field: the view takes keys on a focusable `div`, which isn't an
editable element, and every key typed into it may be the program's.

*What a host provides.* A sized box: the view fills its container (`width`
and `height` 100%), and its own content never sizes it — the rows are a
layer positioned over the root's box. So the container needs a definite
size: an explicit height, or a stretched flex or grid item (`min-height: 0`
in a flex column). A container with no size leaves the view unmeasurable,
and the terminal keeps its size (`FUZ_TERMINAL_DEFAULT_SIZE` at first)
until the box has one. A view whose first frame finds no size warns once in
the console, naming what's missing (a hidden view warns too); it's never a
failure.

*The frame loop.* A frame is requested after output, after the box changes
size, and when a render hold ends, and at most one is pending
(`FuzTerminalFrameLoop`); with nothing changing nothing is scheduled. A
frame resizes the terminal if the box changed, then updates the reader and
takes `rows` when the update wasn't clean, and the `cursor` and colors by
reference every frame, since those change on clean updates too, then cleans
it. The rows are held in `$state.raw` and drawn by a keyed `{#each}` over the
row ids: an unchanged row is the same object, and Svelte skips a keyed item
whose value is the same reference, so its elements aren't touched; an
ordinary scroll moves the elements of the rows still on screen. A scroll
inside a scroll region, or inserted or deleted lines, gives every row of the
library's page a new id, so those frames recreate every row's elements.

*Render holds.* On the `render_hold` effect's start the view updates from
inside the handler — the frame the program wants left on screen — and
updates nothing more until the hold ends or `FUZ_TERMINAL_RENDER_HOLD_TIMEOUT_MS`
passes; after that it draws again. It can't end the hold in the terminal
(that needs the mode option, unbound), so a hold the program starts before
resetting a timed-out one isn't seen. A hold that begins after the view was
destroyed or stopped — later in the same write — does nothing.

*Drawing a row.* The rows stack in block flow in the screen layer, so row
`y` starts `y` rows down, where the cursor is placed; a row is a block with a
pinned height, and each run is an inline box (`inline-block`, top-aligned) as
wide as its columns. A run is drawn at its own column, never after the runs
before it: an engine rounds each box's width to its layout unit, and a
fractional cell width rounded run by run drifts a style-dense row
(`ls --color`, htop) a pixel or more off its columns, the cursor sitting off
the text. So a run takes no room in the line — its
`margin-right` is its `width` negated, the same length, which rounds to the
same magnitude — and is offset from the row's start by `position: relative`
with `left` of its column (`--run_x`) times the cell width, the expression
the cursor is placed by: every run and the cursor are one rounding of
`x × cell` from the row's start, however many runs come before. A run's box
is a sixteenth of a pixel wider than its columns, so it overlaps the next
run's box, which paints over it, and the two roundings that end one run
and start the next can't leave a hairline of the row's background between
them. The runs are still inline boxes in DOM order, so a row copies as one
line. The layer and the rows set their own `display`, and
their classes are prefixed (`fuz-terminal-screen`, `fuz-terminal-row`): no
class the component renders is a fuz_css utility or base-style class
(`FuzTerminal.classes.test.ts`), since a utility of the same name would lay
them out too. Every box —
runs, clusters, the cursor — is sized in one cell width, the probe's
measurement, set on the root as `--fuz_terminal_cell_width` and
`--fuz_terminal_cell_height` in pixels (falling back to the font's own `1ch`
and line until there's a measurement), never each run's own font: a bold
face whose advance differs can't shift the columns after it. So a glyph from
a fallback font can't shift what follows either. A cluster run (a wide
character, a multi-code-point grapheme) is one box of its width; a run whose
text mixes ASCII and other code points is split where it changes between
them (`split_fuz_terminal_runs`), so a stretch of glyphs the font lacks
shifts at most within itself. The root resets the text properties a host
would pass down that move runs off their columns or change their glyphs:
`direction`, `writing-mode`, `text-align` and `text-align-last`,
`text-indent`, `text-transform`, letter and word spacing, kerning,
`font-weight` and `font-style` (so only a program's style makes text bold or
italic), the font variants (ligatures off), font feature and variation
settings, and `user-select` (a host's `none` would leave nothing to select).
The font and its size are the host's through `--fuz_terminal_font_family`
and `--fuz_terminal_font_size`, which the root reads instead of inheriting
them; what else a host passes down — paint such as `text-shadow`, or
`font-stretch` — is the host's to set.
Trailing blanks make no run, so the row's background shows. Text reaches
the DOM only as text nodes; a run's `style` attribute holds only
declarations built from the style's flags and colors formatted from numbers
(`to_fuz_terminal_style_css`, cached by style key and bounded): colors,
`inverse` swapping the resolved colors (defaults included), `faint` as the
text color mixed toward transparent, `invisible` as transparent text and
lines, bold, italic, and the underline kinds, strikethrough, and overline
as `text-decoration` lines. Blink and hyperlinks are classes: blinking
text, off under `prefers-reduced-motion`; a hyperlink underlined on hover,
with no link to follow.

*Colors.* Colors are never read from the theme into JS. Runs name custom
properties — `--fuz_terminal_fg`, `--fuz_terminal_bg`, and
`--fuz_terminal_palette_0` … `_255` — that the root defines. The stylesheet
gives the defaults and the base 16 from the theme; the root's inline style
(`to_fuz_terminal_theme_css`) sets palette entries 16–255 from the frame,
and overrides a base-16 entry only when it differs from the palette the
reader reported before any output (a program changed it with OSC 4; OSC 104
gives the theme's back). The default text color and background are the
theme's while the reader reports the library's placeholders, and the
program's once it has set both (OSC 10 and 11 — the library takes them only
as a pair). Reverse video (DECSCNM) isn't drawn while the defaults are the
theme's: the library swaps only colors a program set, so with its
placeholders the frame's colors don't change. A cursor color the program
sets (OSC 12) is its own property on the root, so a program that recolors
the cursor often (vim, per mode) leaves the palette's style alone. A host
themes the view by setting, on an ancestor:

| custom property | default |
| --- | --- |
| `--fuz_terminal_foreground` | `--text_color` |
| `--fuz_terminal_background` | `--shade_00` |
| `--fuz_terminal_cursor_color` | the text color in effect (a program's own included) |
| `--fuz_terminal_color_0` (black), `_8` (bright black) | `#1c1c1c`, `#808080` |
| `--fuz_terminal_color_7` (white), `_15` (bright white) | `#c8c8c8`, `#f8f8f8` |
| `--fuz_terminal_color_1`–`_6` (red, green, yellow, blue, magenta, cyan) | `--palette_c_50`, `_b_`, `_e_`, `_a_`, `_d_`, `_i_` |
| `--fuz_terminal_color_9`–`_14` (the bright ones) | the same hues at `_70` |
| `--fuz_terminal_font_family` | `--font_family_mono` |
| `--fuz_terminal_font_size` | `--font_size_sm` |
| `--fuz_terminal_line_height` | `1.2` |

Only the default foreground and background follow the color scheme. ANSI
black is dark and white light in either scheme — programs rely on that
(black text on a green status bar, white on blue) — and fuz_css's gray
scales follow the scheme (its only fixed opaque neutrals are pure black and
white), so these are literal grays. The six
hues are fuz_css palette stops, the bright ones the higher-contrast stops in
either scheme. The terminal itself isn't told the theme, so a program that
queries a color (OSC 10, 11, or 4) gets the library's placeholders.

*The cursor.* One element over the rows at the cursor's cell, two cells
wide over a wide character (on either of its cells), in the shape the
program set — a block (drawing the cell's text in the background color, or
a blank over invisible text), a bar, an underline, or a hollow block — and
hidden when the program hides it or it's out of the viewport. Without focus
a block is hollow and nothing blinks; a blinking cursor blinks by CSS, not
under `prefers-reduced-motion`.

*Sizing.* A hidden probe — a run of cells in the terminal's font, with the
line height the rows fall back to, unselectable so no copy takes its text —
measures the cell (its width over its length, its height a row's), and the
root's box is the area; `to_fuz_terminal_size` turns them into cols and
rows — whole cells, at least `FUZ_TERMINAL_MIN_COLS` ×
`FUZ_TERMINAL_MIN_ROWS`, at most
`GHOSTTY_TERMINAL_MAX_SIZE` — or `null` when anything is zero or not finite
(not laid out, `display: none`, no size from the container), which never
resizes the terminal. A `ResizeObserver` on the root and the probe (so a font
that loads late re-measures too) requests a frame, so a storm of size
changes costs one resize per frame. The terminal is created at the measured
size, or `FUZ_TERMINAL_DEFAULT_SIZE` when there's nothing to measure yet.

*Accessibility.* The root is focusable (`tabindex="0"`, a `group` with the
`terminal` role description and `label` as its name) and takes the keys
typed while it has focus; the rows are plain
text in the accessibility tree, the cursor and probe are hidden from it,
and nothing is a live region, so a repaint announces nothing. A deliberate
screen-reader mode is still to come.

The module is a static asset (`static/fuz_terminal/ghostty-vt.wasm`) built by
`cargo xtask ghostty-vt`, not an import, so a build without it still
succeeds.

## Recording

`Recorder` (`recorder.svelte.ts`) is an app-level cell that records the microphone to a file on disk. Being app-level, a recording carries on across route changes; `RecorderIndicator` in the root layout shows it — status, duration, pause and stop — on every page while the microphone may be open.

It's two layers. `AudioCapture` (`audio_capture.svelte.ts`) owns the microphone — the user-gesture check, the format, `MediaRecorder`, pause and resume, duration and level — and hands each chunk to an `AudioCaptureSink` it is given, knowing nothing about the app or where chunks go. `Recorder` supplies the sink (a `ChunkUpload` to a file) and owns what happens after: the path, finalizing, and transcribing. Capture has no backend or AI dependency, so another app can record into its own sink.

```
click → Recorder.start(dir)
          ├─ a user gesture is in effect, or it refuses
          ├─ pick_recording_format    Opus in WebM, else Ogg, else MP4
          ├─ getUserMedia({audio})    status: starting
          ├─ ChunkUpload.create       POST   /api/files/bytes?path=…   (exclusive, empty)
          └─ MediaRecorder.start(chunk_duration)                       status: recording
dataavailable → ChunkUpload.enqueue   PATCH  /api/files/bytes?path=…&offset=N
Recorder.stop()                                                        status: stopping
          ├─ MediaRecorder.stop       the last chunk arrives before `stop`
          ├─ close the microphone
          ├─ ChunkUpload.flush        every chunk has landed
          └─ media_finalize           remux, so the file has a duration and seeks
```

**The file is the recording.** It is created under its final name — the local time it started, like `2026-01-31_09-05-07.webm` — in the directory `start` is given (the files page passes `Diskfiles.new_files_dir`), and grows in place as chunks arrive. Nothing is buffered for the length of the recording: a crashed tab loses at most the last chunk (`chunk_duration`, a few seconds), and the file left behind still plays.

**Chunks land exactly once, in order.** `ChunkUpload` (`chunk_upload.ts`) sends one chunk at a time, each as an append at the offset it expects (see [File Bytes](#file-bytes)). A request that gets no answer, or a server error, is retried with backoff; when the retry is refused because the file already grew by exactly this chunk, the first attempt landed and only its reply was lost. Any other refusal — the file changed on disk, the session ended — fails the upload, which ends the recording with the reason in `Recorder.error`.

**Stopping finalizes.** A browser's `MediaRecorder` streams its output, so the file's header has no duration or seek index. Once every chunk has landed, `media_finalize` has the daemon rewrite the file in place with both (an `ffmpeg` stream copy — nothing is re-encoded). If finalizing fails the recording is kept as it is, and `Recorder.error` says so.

**The microphone.** Capture starts in exactly one place, `AudioCapture.start` (which `Recorder.start` calls), and it refuses unless a user gesture is in effect (`navigator.userActivation`; a browser without that API can't be asked, and is let through) — so it follows a click or a key press, and nothing the backend sends can open the microphone. `Recorder.active` is true from the permission prompt until the recording is saved; while it is, the indicator shows on every page and leaving the page asks first (`confirm_unload_while_recording`). Disposing the app — a logout, a session found revoked — closes the microphone and doesn't finalize; the chunks the uploader already holds, and the last one the browser hands over as it stops, are still sent. A track that ends on its own (the device unplugged, the permission revoked) stops the recording normally.

The browser's side of all this — `getUserMedia`, `MediaRecorder`, the clock — is behind `AudioCaptureDeps`, which `RecorderDeps` extends with `fetch`, so tests stand in for the microphone and the network.

### Playing audio

The files page routes a file to its view by content kind (see [File Editing](#file-editing)); audio gets `DiskfileAudioView`.

The audio view (with its transcript beside it — see [Transcription](#transcription)) is an `<audio>` element whose `src` is the file's byte-route URL (see [File Bytes](#file-bytes)); the browser streams and seeks with `Range` requests, so the file is never loaded into the app. A file's content being unloaded means its `content` can't show that it changed, so `Diskfile.mtime` — the disk node's modification time, kept current by every `filer_change` — keys the player: when the bytes change (a finalize, an external write) it remounts and loads them. While the recorder is writing a file, its view says so and shows no player. The view's finalize button runs `media_finalize` on the file — for a recording cut off before it was saved, which plays but has no duration.

### Jobs

Some work takes minutes — a transcription — and can't be tied to one request: closing the tab or dropping the socket would end it. A **job** is that work on the daemon (`crates/zzz_server/src/job_manager.rs`), reported to the frontend as it changes.

- A job has an id, a kind, a status (`queued`, `running`, `succeeded`, `failed`, `cancelled`), a progress, the file it works on, the file it wrote, the command lines it ran, and — when it failed — why, with the tail of the tool's stderr (`job_types.ts`).
- Jobs run **one at a time**, in the order they were asked for. The rest wait as `queued`.
- A job belongs to the account that created it. Each kind has its own create action (`transcription_create`); what works on any job is generic: `job_cancel`, and the `job_changed` notification, which carries the job's whole state on every change.
- Jobs live in the daemon's memory, like terminals: a restart forgets them. Finished ones are kept as a bounded history.

On the frontend, `Jobs` (`jobs.svelte.ts`) mirrors the backend's list and holds nothing of its own: `job_changed` adds or updates a `Job` in place, and every session snapshot (`session_load`'s `jobs`) replaces the collection — so a reload shows the running job again, and after a daemon restart the list is empty. The `/jobs` page lists them plainly; the place a transcription is actually watched is the audio file's view.

### Transcription

`transcription_create` transcribes an audio file with a speech model that runs **on this machine** (whisper.cpp). Nothing is sent anywhere: there is no hosted transcription.

```
transcribe → transcription_create {path}         → {job_id}, a queued job
job runs:    hash the audio (blake3)
             ffmpeg: decode to 16 kHz mono PCM     (handles only)
             whisper-cli: PCM on stdin
               ├─ each segment as it's decoded   → transcription_progress
               └─ progress                       → job_changed
             write <name>.<model>.transcript.json  (exclusive)
```

**The transcript is a sidecar file** beside the audio (`transcript_types.ts`): timed segments, each with its words and their probabilities, plus provenance — the audio's hash and size, the backend and its version, the model and its hash, the parameters. It's tool output, so it is **written once and never edited**: the model's name is in the file name, so a better model's transcript sits beside it rather than replacing it, and transcribing again with the same model is refused until the sidecar is deleted. A sidecar is found for an audio file by its name and by what it says it was made from (`find_transcripts`) — a model's name has dots in it, so the name alone can't say.

**Batch, with a preview.** The transcript is made from the finished file. The recognizer decodes in windows and reports segments as it goes, so `transcription_progress` fills in `Job.live_segments` while the job runs; when it succeeds the sidecar arrives through the file index and replaces the preview.

**Reading it.** An audio file's view shows its transcript under the player — the one on disk (a picker when there are several models'), or the running job's preview — and clicking a segment plays from there; with none, a transcribe button. A sidecar opened on its own (`DiskfileTranscriptView`) shows the same segments read-only, with the audio's player when the audio is beside it.

**Editing a copy.** "Edit a copy" (`transcript_to_text`) creates `<name>.md` beside the audio — a link to it, then the speech as paragraphs split at pauses — and opens it in the editor. That file is yours; the sidecar stays as the tool wrote it.

**Transcribe on stop.** The recorder queues a transcription for a recording once it's saved, when its `transcribe_on_stop` toggle is on (the default). That's the person's choice, made by leaving the toggle on — nothing else starts one, and a file that merely appears in a workspace is never decoded or transcribed.

A transcript's text is whatever was said near the microphone. It's rendered as text, and nothing places it in a chat, a prompt, or a terminal on its own.

### The recordings page

`/recordings` is the purpose-built view over the same pieces: a record button with a level meter (`Recorder.level`, read from a Web Audio analyser on the live stream), and the recordings with their transcripts' first lines. It records to `recordings/` in the app directory, so it works with no workspace open. Recordings, transcripts, and jobs are all ordinary files and cells — the files page and the jobs page show the same things raw.

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

- `single` — One key → one item (`create_single_index`). Read with
  `by_optional('name', 'gpt-5')` or `single_index('name')` (the map)
- `multi` — One key → many items (`create_multi_index`). Read with
  `where('provider_name', 'claude')`, which returns a `ReadonlyArray` — the
  index's own bucket, or a shared frozen empty array for a missing key, so copy
  it before changing it
- `derived` — Computed array, optionally sorted (`create_derived_index`). Read
  with `derived_index('ordered_by_name')`

The typed readers throw when the key isn't an index of their type. A custom
`IndexDefinition` without a `type` (say an aggregate stats object) is read
through `indexes[key]`.

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
  upserting by path in a loop — plus `Workspaces.by_path`). Derived-array
  indexes (`create_derived_index`) are incremental and can be replaced by
  assignment (e.g. `items.indexes.manual_order = reordered`).

`onremove` hooks run after the removed items have left `by_id`, so a single
index falling back to another holder of a key never picks an item removed in the
same `remove_many`.

### Ownership and Disposal

A collection that owns its items passes `dispose_item`, which runs for every
item leaving through `remove`, `remove_many`, or `clear` (including a decoder
re-populating the collection). Every app collection owns its cells, so removed
cells leave the cell registry and release their resources — trimmed `Actions`
still in flight stop observing their action events, a disposed `Thread`
cancels its in-flight completion and disposes its turns, and a disposed
`Prompt` disposes its parts (a prompt's parts are its own instances, not in
`app.parts`).

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
interface IndexDefinition<T extends IndexedItem, TResult = any> {
	key: string;
	type?: 'single' | 'multi' | 'derived'; // checked by the typed readers
	compute: (collection: IndexedCollection<T>) => TResult;
	matches?: (item: T) => boolean; // skip the hooks for items it rejects
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
items.by_optional('name', 'gpt-5'); // single → Model | undefined
items.where('provider_name', 'claude'); // multi → ReadonlyArray<Model>
items.derived_index('ordered_by_name'); // derived → Array<Model>
```

## Filesystem

Two separate concerns:

- App directory (`PUBLIC_ZZZ_DIR`) — Zzz's own files: `cache/` holds scratch for tool runs, `recordings/` what the recordings page records, and `state/` and `run/` are reserved
- Scoped dirs (`PUBLIC_ZZZ_SCOPED_DIRS`) — User file access (comma-separated paths)

### ScopedFs

All filesystem operations go through `ScopedFs` (Rust: `crates/zzz_server/src/scoped_fs.rs`). Security: paths validated against allowed roots, symlinks rejected, absolute paths required, parent directories checked recursively.

The allowed roots are the permanent boot-time set (the app directory + scoped dirs) plus one runtime root per open workspace. A path is allowed when any root covers it, and removing a workspace's root never touches a permanent root — so closing a workspace opened on, nested in, or containing the app directory or a scoped dir leaves the access those roots grant intact.

### File Bytes

The file actions (`diskfile_update`, `diskfile_create`) carry contents as UTF-8 strings inside one JSON-RPC message, and the file index holds contents only for UTF-8 files under its size limit. Bytes have their own path: plain HTTP routes at `/api/files/bytes?path=<absolute path>` (Rust: `crates/zzz_server/src/file_bytes.rs`; `src/lib/file_bytes.ts` builds the URLs).

- **Read** — `GET` returns the file's bytes and honors one `Range: bytes=` range (206, or 416 past the end), which is what a media element needs to seek. The URL works directly as an `<audio>` or `<img>` `src`: the request carries the session cookie.
- **Create** — `POST` creates the file exclusively from the request body, like `diskfile_create`.
- **Append** — `PATCH` with `&offset=` appends the body only if the file is exactly `offset` bytes long, and otherwise answers 409 `offset_mismatch` with the file's current `size`, having written nothing. A writer that streams a file as chunks sends each at the offset it expects: a retried chunk can't land twice, and the reply's size tells it whether the first attempt landed.

Paths go through `ScopedFs`, and errors carry the same reasons as the file actions' (`path_not_allowed`, `already_exists`, …) in a flat `{error}` body. The routes need a session or a full-scope API token.

A file in a workspace is untrusted content, so a read never hands the browser something to run: only allowlisted raster image, audio, and video extensions are served with their media type, and everything else — HTML, SVG, XML, scripts, text — is an `application/octet-stream` download. Every response that serves or describes a file — a read, a write's reply, a file error — carries `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy`, and `Cross-Origin-Resource-Policy: same-origin`, and is never cached (`no-store`); a refusal at a gate (a bad query, no credential, an oversized body, a foreign origin) is a plain JSON error without them.

These routes are outside the action system — they don't appear in the actions log or in ./reference.md.

### Filer

`FilerManager` starts one `Filer` watcher per unique directory — the app dir, each scoped dir, and each open workspace dir. Each filer keeps an in-memory file index and broadcasts changes to clients via debounced `filer_change` notifications over WebSocket. Notify events are treated as hints: for every event, removes and renames included, the filer `lstat`s the path and decides `add` / `change` / `delete` from the disk and its index, so renames resolve to a delete of the old path plus an add of the new one, and late or reordered events can't delete a file that exists. A change that moved an indexed file's timestamps and left the contents the index holds for it as they were (a `touch`, a rewrite of the same bytes) is a `touch`: its `disknode` is the file's metadata with no `contents` key (`DisknodeMetadata`), so the contents aren't sent again — a client holding the file keeps the content it has (`Diskfiles.touch`), and one that doesn't ignores it. The index holds no contents for a file it didn't load, so every change to such a file is a `touch`, and what shows it changed is its `mtime`. Every other change carries the whole disknode, where `contents: null` keeps its one meaning: not loaded. A touch folded into an unbroadcast `add` or `change` is sent as that change, contents included. Broadcasts are debounced per path (80ms quiet, at most 500ms): a delete then re-create becomes one `change`, and a file created and deleted inside the window is sent only as a `delete` (a no-op for clients that never saw it). Ignored directories (`.git`, `node_modules`, `target`, …) are filtered before the event channel; if events are still dropped (or the OS queue overflows), the filer rebuilds its watches on a fresh watcher, rescans its root, and broadcasts the diff. Symlinks are skipped entirely — never followed, never indexed, never watched — matching `ScopedFs`.

Watches are per directory: the filer's own walk (on a blocking thread) adds one non-recursive watch to each directory it indexes — never inside ignored, symlinked, or non-UTF-8 directories — watching each before listing it, so nothing created in between is missed. A directory that appears gets watches for its subtree when it's synced; one that's removed or renamed away has them dropped (two paths sharing one inode, like a renamed directory's old and new path or a bind mount, share one kernel watch, removed only with its last path). An unreadable subdirectory is skipped and logged once, and picked up once it's readable again; one made unreadable later drops out of the index. A listing that fails transiently (`EMFILE`, `EIO`) keeps what's indexed under it and retries. Rescans (`session_load`, overflow recovery) re-read only files whose `lstat` identity or change stamps moved, and trust a stamp only once the file has been still for two seconds (git's "racily clean" rule), since same-size writes within one timestamp tick look identical.

When the OS runs out of watches (inotify's `max_user_watches`), or no watcher can be created at all (`max_user_instances`), the filer runs **degraded**: the index still comes from the scan, and the directories without a watch are rescanned every 5 seconds or more (retrying their watches each time), so changes there show up late. `workspace_open` returns this as `watch_status` (`'full'` or `'degraded'`), which the tab that opened it keeps on its `Workspace` cell and shows on the workspaces page and in the desk menu. It's reported at open time only (another tab or a reload shows `'full'`) — a filer that degrades or recovers later is just logged. A workspace root that can't be listed fails `workspace_open` (`forbidden` / `permission_denied`, or `not_found`); a running filer whose root disappears polls it until it's back.

### Daemon Info

`~/.zzz/run/daemon.json` tracks the running daemon (boot id, pid, kernel start time, port, version). The Rust CLI (`crates/zzz/src/daemon_lifecycle.rs`) writes it atomically once the spawned `zzzd` holds the listening socket and answers `/health`, reads it back for discovery and `status`, and identifies the daemon by boot id, pid, and start time — a dead or reused pid reads as stale and is never signalled; a record it can't read (an older or newer zzz's, or a corrupt one) is reported and never signalled, removed, or overwritten, so `zzz` and `zzz daemon start` refuse to start a daemon while it's there. The file is removed on `daemon stop`, when the foreground `daemon start` exits, and when found stale, each time only if it still records that same process.

## File Editing

The files page picks a file's view in one place, `DiskfileView`, by its
content kind (`to_diskfile_content_kind` — the extension, since the file index
carries no type): audio gets the player (`DiskfileAudioView`, see
[Playing audio](#playing-audio)), a transcript sidecar `DiskfileTranscriptView`,
markdown (`.md`, `.markdown`) `DiskfileMarkdownView`, and everything else the
text editor (`DiskfileEditorView`). The markdown view is the text editor's
twin over the same editing state: its source in `SourceEditor` (fuz_code's
highlighted `CodeTextarea`) beside a live `MarkdownPreview`, or either alone —
split, preview, or source, a mode chosen per file and kept on its
`DiskfileEditorState`, defaulting to the split, or to the preview while the
content isn't loaded. Ctrl+Shift+1, 2, and 3 switch to split, preview, and
source from anywhere on the page — the textarea included, since Ctrl+Shift
types nothing — except an input or contenteditable outside the view, or while
a modal dialog is open. The editor's sidebar is a
drawer there, adding the document's outline and its broken links: clicking
either scrolls the preview to it and puts the editor's caret at its source,
in whichever panes are shown. The view parses the source once with
`mdz_parse` and hands the nodes to the preview, the outline, and the link
list.

`MarkdownPreview`'s links never navigate the app (`markdown_links.ts` resolves
them; the preview only acts). An external link opens in a new tab; a
`#fragment` scrolls the preview; and with the file's `path`, a relative link
resolves against the file's directory, a root-relative `/docs/x.md` against
the open root holding the file (a workspace, usually the repository — the way
a repository host reads it), with any query dropped and the fragment kept. A
link to an indexed file opens it in the preview tab — a middle- or
Ctrl/Cmd-click in a kept tab instead — and a fragment on a markdown file
reveals that heading once its view shows (`markdown_pending_fragment` on the
target's `DiskfileEditorState`). A link to a folder opens the folder's README
if the index has one. A link the file index says is missing — inside a root
it covers and outside the folders it skips (`FILE_INDEX_IGNORED_DIR_NAMES`,
mirroring the filer) — is marked broken, and one outside every root, in a
skipped folder, or root-relative and not found is marked unknown, never
broken, since the index can't see there; each mark has a title saying why,
and follows the index and the content as they change. Everything else —
protocol-relative, other schemes, same-origin absolute URLs, a root-relative
`..` past its root, or any `..` past `/`, and any relative link in a preview
without a `path` — is inert (a relative `..` climbing out of the workspace
reads as outside it, so unknown). The index lists only files, so what it never
indexes reads as missing — an empty folder, a symlink, a file in an
unreadable subdirectory, or a path that isn't UTF-8 is marked broken. A test
holds `FILE_INDEX_IGNORED_DIR_NAMES` and the staging-file prefix to the
filer's Rust source. The preview pairs each link with its rendered anchor by
document order, since mdz can rewrite a root-relative `href` (SvelteKit's
`resolve`), and follows a click from the link's reference.

The frontend file pipeline is six Cells plus a per-file editing-state class:

- `Diskfiles` — `IndexedCollection<Diskfile>` (`by_path` single index,
  `immutable_key` since a path is a diskfile's disk identity); its
  `handle_change` is the `filer_change` dispatch point
- `Diskfile` — one file: `{path, source_dir, content}`; the Cell `id` is
  client-side identity, `path` is the disk identity used for backend
  correlation
- `DiskfilesEditor` → `DiskfileTabs` → `DiskfileTab` — VS-Code-style tabs:
  single-click opens a reusable _preview_ tab, editing or an explicit open
  promotes it to permanent; tab order, recent-tab history, and
  reopen-closed-tab state live on `DiskfileTabs`. A file has at most one
  tab: reopening a closed tab skips (and drops) entries whose file is open
  again and reopens the next, as a permanent tab, like VS Code's "reopen
  closed editor". Closing all tabs pushes them onto the reopen stack above
  the earlier closed ones (reopening one by one restores their order); the
  stack, and the back/forward navigation stacks, keep the 50 most recent. A file appearing on disk — seeded by a snapshot or created
  by another tool — never moves the selection or opens a tab; only a file
  created from zzz (`Diskfiles.create_file`) is selected and opened in a
  permanent tab — at once if its `filer_change` already arrived, else when
  it arrives (under the path as the backend normalizes it), unless the user
  selects another file or tab or closes its workspace first
- `DiskfileHistory` — one file's edit history (disk changes, the draft,
  saved and discarded edits), newest first; capped at 100 entries and 16M
  characters of content, trimming the oldest but never the draft, the
  newest saved state, or the entry an editor shows — in-memory only, lost
  on reload
- `DiskfileEditorState` (plain class, not a Cell) — one file's editing
  state, like a VS Code text model: the selected history entry
  (`current_content`), the draft, the conflict flag, and `save_changes()`.
  `Diskfiles.get_editor_state` creates it on first use, detached from the
  calling component (see below), and keeps it until the diskfile is removed.
  The `/files` editor, file-part editors, and tabs are views over it, so a
  tab switch or remount shows the same draft, selection, and save state; a
  file part sends its draft (see "What gets saved and sent")

Save round trip:

```
User edits → DiskfileEditorState.current_content setter
  → the file's draft (one unsaved-edit entry in its DiskfileHistory)
Save → save_changes() → app.api.diskfile_update({path, content})
  → ScopedFs::write_file (response is null — no content echo)
→ notify watcher fires → Filer updates its index immediately
  → debounced (80ms) filer_change broadcast to all sockets
    → Diskfiles.handle_change → upsert → existing Diskfile.set_json(...)
      → DiskfileEditorState.check_disk_changes → disk-change history entry
```

The confirmation is the broadcast, not the RPC response — a save and an
external edit look identical to the frontend. The response still gates the
editor: `save_changes()` runs one save per file at a time, and records the
saved entry and clears the modified flag only when the write succeeds — a
failure keeps the edit unsaved and sets `save_error`. If anything moves while
the write is in flight — more typing, another history entry picked, or an
external edit landing after the save's own broadcast — the saved content is
recorded in history but the editor keeps its content and selection, and an
external edit stays the last-seen disk state. Ctrl+S saves the focused
editor; the main `/files` view also takes it from anywhere on the page, the
markdown view included when its preview is shown alone and no editor is
mounted.

**Disk changes and drafts.** `Diskfiles.upsert` records every content change
in the file's editing state, if it has one — whether or not an editor is
mounted — so a file reopens on the disk content, never text a save would
write back over an external change. A clean editor follows the disk. Editing
keeps one draft per file, updated in place and dated to the latest edit;
editing from another entry picked in the history starts a new draft and sets
the previous one aside as a _discarded_ entry. A draft itself is only ever
deleted by saving it, editing it back to the disk content, or the explicit
"clear unsaved edits"; discarded entries are ordinary history, so the
history caps and "clear history" can drop them. Saving records a saved-state
entry of its own even when a discarded entry holds the same text, and "clear
history" always keeps an entry for the disk content (recording one if none
holds it), so it never leaves the editor on an older state that a save would
write back. A file with a draft or
showing something other than the disk is marked ● in its tab and in the
explorer (the accessible name says "unsaved changes", or "changed on disk").

**Closing tabs.** Like VS Code: closing the last tab of a file with a draft
(the close button, Ctrl+Q, or the contextmenu) asks **save**, **don't
save**, or **cancel** (`DiskfilesEditor.request_close_tab`,
`DiskfileCloseDialog`). "Don't save" discards the draft into the history
(`discard_draft`) — for a file deleted on disk, the file is forgotten with
it. The question lapses if the draft goes away meanwhile (saved or
discarded elsewhere), and a cancel during the save keeps the tab. A reopen shows the draft if there is one, else the disk
content. Unlike VS Code a draft doesn't depend on its tab — it's app-level —
so programmatic closes (`close_tab`, `close_all_tabs`, a preview tab reused
for another file) close without asking and keep the draft, reachable from
the explorer's ● and file parts.

**What gets saved and sent.** Saving writes what the editor shows
(`current_content`) — the draft, or an older entry picked to restore it. A
file part (`DiskfilePart.content`) sends the draft if there is one, else the
disk content — never merely an entry an editor is viewing — and its XML tag
says so with `unsaved="true"` (plus `changed_on_disk="true"` or
`deleted_on_disk="true"`, replacing user attributes with those keys only
while they're added); the part view labels it "unsaved draft" too. The close
dialog's "save" and the conflict notice's "overwrite with your draft" save
the draft (`save_draft`), showing it first, even when the editor showed an
older entry; with no draft, "overwrite with this version" saves what's
shown. VS
Code's AI features likewise read the dirty buffer; zzz marks it, since a
model otherwise can't tell a draft from the file.

**Conflicts.** A disk change under the user's content (the draft, or a
picked older entry) keeps that content and sets `disk_conflict`. While the
editor shows content that differs from the disk (`has_conflict`), saving is
paused: Ctrl+S (which moves focus to the notice) and the save button write
nothing, and a notice offers **overwrite with your draft**
(`save_draft({overwrite: true})`) or **reload from disk**
(`discard_draft`); either returns focus to the editor, and both versions
are in the history to compare. A disk change equal to the draft settles it,
the content of our own save in flight landing on disk (our broadcast, with
typing continuing past it) resolves rather than raises a conflict, and a
new draft typed on the new disk content starts clean. VS Code keeps a dirty
buffer on an external change too, but only reports the conflict when saving
("the content of the file is newer", with Compare / Overwrite); zzz shows it
as soon as it lands, since agents and tools write files while you edit, and
keeps both versions in its history instead of opening a diff view (zzz has
none yet). The check is frontend-only: an external write that lands after
the backend received our save, but before our broadcast arrives, is
overwritten without a conflict — closing that window needs the backend to
compare against the version the save was based on.

**Cells outlive components.** Svelte owns a `$derived` by the effect running
when it was created and can stop recomputing it once that effect is
destroyed, so app-level state constructed during component init silently
freezes when the component unmounts (and code in `onMount` or an `$effect`
runs inside an effect too). Such state is created with `create_detached`
(`reactive_helpers.svelte.ts`): editing states
(`Diskfiles.get_editor_state`), the `Action` cells `app.api` calls create, the
`App` itself, and the route-cached `Projects` / `Browser`.

The initial file listing comes from `session_load` (the backend rescans and
flattens every active filer's index, and lists the filers' roots as
`file_roots`), and `workspace_open` returns the opened workspace's index so
the new tree appears immediately. `Frontend.load_session` runs `session_load`
and retries a failure with backoff (1s doubling to 30s) until it succeeds,
tracking progress in `session_status` / `session_error`; `Workspaces.open`
does the same snapshot handling for `workspace_open`. Both record what
`filer_change` reports while their request is in flight
(`Diskfiles.track_changes`) and apply the snapshot around it: a path with an
`add`, `change`, or `delete` keeps what the notification left — its snapshot
entry is skipped, so a file deleted mid-request isn't resurrected and newer
content isn't reverted. A `touch` carries no contents, so it never makes the
snapshot yield: the snapshot's entry is applied (or the file pruned), and
the touch's metadata is then applied again, unless a full change was also
reported for the path.

**Reconnect resync.** Notifications sent while the socket is down —
`filer_change`, `workspace_changed`, `terminal_data`, `terminal_exited`,
`completion_progress` — are lost, and reconnects are routine (heartbeat
timeouts, sleep/wake, daemon restarts). So the app root feeds the socket's
`last_connect_time` to `Frontend.handle_socket_connect`, and any connect
that follows a session load reloads it (queued behind a load already in
flight, whose snapshot may predate the connect). The boot load
(`Frontend.boot_session`) waits for the first connect so its snapshot comes
over the socket that then carries the notifications; if the socket hasn't
opened within 2s it loads over HTTP, and the first connect then resyncs —
as it does after a failed first load, instead of waiting out the retry
backoff. `receive_session` reconciles rather than adds:

- **Workspaces** are replaced (`Workspaces.reconcile`): listed ones added,
  the rest removed — another client closed them. After a zzzd restart (a
  new `server_instance_id`), the runtime workspaces it lost are reopened
  instead (`Workspaces.open` with the same path, reconciling their files),
  so their files, tabs, and unsaved edits stay. A reopen the backend
  refuses because the directory is gone, forbidden, or not a directory
  drops the workspace and the files only it covered (logged); any other
  failure keeps it, and the next snapshot retries once — there's no retry
  loop. Closing a workspace (`Frontend.close_workspace`) cancels a pending
  reopen, and a `workspace_not_open` reply removes it here too, so a
  workspace the backend forgot can still be closed. A close while a reopen
  is in flight sticks: the backend's open scans before registering, so the
  close finds nothing open and the open lands anyway — the reopen then
  closes it again.
- **Files** under a snapshot root, or under a workspace the reconcile just
  removed, that the snapshot lacks are removed through the same path as a
  `delete` (`Diskfiles.reconcile`), so a file open with unsaved edits stays,
  flagged `deleted_on_disk`. Files outside those directories are left
  alone — the snapshot says nothing about them.
- **Terminals** running when the request went out that the snapshot's
  `terminal_ids` lacks become `lost` (`Terminals.reconcile`).
- **Jobs** are replaced with the snapshot's `jobs` (`Jobs.reconcile`): they
  live on the backend, so its list is the truth, and after a restart it's
  empty. A running transcription's preview segments aren't in the snapshot —
  a reload shows the job without them until more arrive.

Changes made while the request is in flight win: paths a `filer_change`
added, changed, or deleted are skipped as above (a `touch` keeps only its
metadata, so a client that missed a `change` while disconnected still gets
the snapshot's contents), workspaces opened or closed meanwhile
(`Workspaces.track_changes`) keep their state and their files aren't
pruned, and terminals started meanwhile aren't judged. A completion whose
`completion_create` was in flight when the socket closed is rejected by the
WebSocket client (`service_unavailable` — it can't be correlated after the
reconnect), which settles its turn as errored; the chunks it had streamed
stay. `Diskfiles` upserts by
path — for seeds and for both `add` and `change` — so a path never has two
`Diskfile`s. A `delete` closes the file's tabs, moves selection, and drops its
editing state and history — unless the file has a draft (edited in a tab, a
file part, anywhere): then the `Diskfile` is kept, flagged `deleted_on_disk`
(marked in its tab, the explorer, and the editors), so saving writes the path
back (always allowed while flagged; a successful save clears the flag right
away) and the `add` broadcast reattaches it (same id). It's forgotten once nothing holds it — no draft
(discarded from the editor's notice or a "don't save") and no tab
(`Diskfiles.release_if_unneeded`). The explorer lists it for its draft
(`Diskfiles.listed`); pickers don't (`on_disk`); a `DiskfilePart` shows and
sends the draft, marked deleted. Tabs, history, and editor state are
UI-session-only — a reload restores only what `session_load` provides.

The explorer and the file picker stay responsive with tens of thousands of
files: their `SortableList`s are `windowed`, rendering only the rows in or near
the scroll viewport (every row the same, measured height) with padding standing
in for the rest, and re-sorting from the previous order (`sort_with_hint`), so
a file added or removed doesn't pay for a full sort. The picker also filters by
path (case-insensitive substring). Rows scrolled out of range unmount, so focus
on one is lost when it scrolls away.

## Spaces and Workspaces

Two layers of directory scoping on top of the Filesystem section's "two
separate concerns":

- **Workspace** (backend-tracked) — an open directory the server watches and
  serves. `workspace_open` validates and canonicalizes the path — refusing
  (`forbidden`, `zzz_home_not_allowed`) a directory named `.zzz`, or one
  inside it, other than the app directory: that's the CLI's daemon home, whose
  `.env` and `bootstrap_token` must never be indexed and broadcast — starts (or
  finds) its workspace-lifetime `Filer` — the initial scan runs before the
  workspace lifecycle lock is taken, and concurrent opens of one path share
  it; a root that can't be listed fails the open here, with nothing
  registered — then, under the lock, records the workspace, re-ensures the
  filer, adds the path to `ScopedFs`, broadcasts `workspace_changed`, and
  returns the files with the `watch_status`;
  `workspace_close` reverses that — except that the boot-time app directory
  and `PUBLIC_ZZZ_SCOPED_DIRS` keep their permanent filers and `ScopedFs`
  roots, so closing a workspace that overlaps one never revokes its access.
  Backend state is an in-memory map — a restart forgets all workspaces, and
  clients reopen the ones they had when they resync after reconnecting (see
  **Reconnect resync** under File Editing).
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
collection in sync. A workspace opened elsewhere arrives without its files
(the initial scan broadcasts nothing), so the client adds it — without
activating it — and resyncs the session to fetch them
(`Workspaces.receive_remote_open`); the notification for the client's own
open, which can land before the reply, is recognized and skips the resync.

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
  fails, so periodic pings don't flicker it. A successful `session_load`
  re-pings a backend whose last ping failed (say at mount, while the daemon
  restarted), so it and the filesystem capability don't read unavailable for
  good
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
