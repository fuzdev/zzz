# Architecture

Core systems: actions, cells, content model, data flow, terminals and
fuz_terminal, recording, indexed collections, the app directory, filesystem,
file editing, projects, the auth gate, security posture, capabilities, and
known limitations.

## Action System

Symmetric peer-to-peer JSON-RPC 2.0 — by design either end can initiate. The
frontend runs the TypeScript `ActionDispatcher` (from `@fuzdev/fuz_app`);
the Rust `zzz_server` backend implements the same spec + wire contract via
`fuz_actions`.

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

- `request_response` — Standard RPC. Phases: `send_request` →
  `receive_request` → `send_response` → `receive_response`. Transport: HTTP
  or WebSocket
- `remote_notification` — Backend → frontend push (progress, broadcast).
  Phases: `send` → `receive`. Transport: WebSocket only
- `local_call` — Frontend-only UI intents (§ Intents). Phases: `execute`.
  Transport: None

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
  (`filer_change`, `project_changed`).

### Action Spec Fields

- `method` (`string`) — Action name (e.g. `'completion_create'`)
- `kind` (`ActionKind`) — `'request_response'` | `'remote_notification'` | `'local_call'`
- `initiator` (`ActionInitiator`) — `'frontend'` | `'backend'` | `'both'`
- `auth` (`RouteAuth | null`) —
  `{account, actor, roles?, credential_types?, required_scope?}`; required
  on `request_response` specs, `null` on `remote_notification` /
  `local_call`
- `side_effects` (`boolean`) — Whether action mutates state (also keeps it
  off the side-effect-free `GET /api/rpc` path)
- `input` (`AnySchema`) — schema for request params (zzz's are fuz_schema)
- `output` (`AnySchema`) — schema for response
- `async` (`boolean`) — Whether handler is async
- `description` (`string`) — What the action does (rendered into ./reference.md)
- `streams` (`string` (optional)) — Name of the companion request-scoped
  `remote_notification` method this action emits (e.g.
  `'completion_progress'`)
- `error_reasons`, `rate_limit` (optional) — see fuz_app's `ActionSpec`

### Core Components

- `ActionSpec` (`action_spec.ts`) — Action metadata schema
- `ActionEvent` (`action_event.ts`) — Lifecycle state machine (initial →
  parsed → handling → handled/failed)
- `ActionDispatcher` (`action_dispatcher.ts`) — Send/receive on both sides
- `ActionRegistry` (`action_registry.ts`) — Type-safe action lookup

These live in `@fuzdev/fuz_app/actions/` — the SAES runtime lives in
fuz_app, and zzz imports it. Cell patterns (the `Cell` base class,
`IndexedCollection`) remain in zzz.

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

Frontend implementations: `FrontendHttpTransport`,
`FrontendWebsocketTransport`. The Rust backend serves the matching
`/api/rpc` + `/api/ws` endpoints directly.

### JSON-RPC 2.0

MCP-compatible subset, no batching:

```typescript
// Request:     { jsonrpc: "2.0", id: "uuid", method: "completion_create", params: {...} }
// Response:    { jsonrpc: "2.0", id: "uuid", result: {...} }
// Error:       { jsonrpc: "2.0", id: "uuid", error: { code: -32000, message: "..." } }
// Notification (no id): { jsonrpc: "2.0", method: "completion_progress", params: {...} }
```

### Actions

Defined in `src/lib/action_specs.ts`. A representative subset below —
several families are omitted here; see [reference.md](./reference.md)
(generated from the specs) for the full list:

- `ping` — Health check. Kind: `request_response`. Initiator: `both`
- `session_load` — Load the session snapshot, at boot and after each
  reconnect. Kind: `request_response`. Initiator: `frontend`
- `filer_change` — File system change notification. Kind:
  `remote_notification`. Initiator: `backend`
- `diskfile_read` — Read a file's contents as text, with their hash, its
  size, and timestamps. Kind: `request_response`. Initiator: `frontend`
- `diskfile_update` — Write file content, only if the file still holds what
  the edit was based on (`expected_hash`). Kind: `request_response`.
  Initiator: `frontend`
- `diskfile_delete` — Delete a file. Kind: `request_response`. Initiator: `frontend`
- `directory_create` — Create a new directory (and missing parents); a taken
  name is `conflict`. Kind: `request_response`. Initiator: `frontend`
- `completion_create` — Start AI completion. Kind: `request_response`. Initiator: `frontend`
- `completion_progress` — Stream completion chunks. Kind:
  `remote_notification`. Initiator: `backend`
- `provider_load_status` — Check provider availability. Kind:
  `request_response`. Initiator: `frontend`

### Actions Log

Every `app.api` call (not the intents, § Intents) is recorded as an
`Action` cell in `app.actions` (shown on the actions page), which keeps the
newest 512 (`HISTORY_LIMIT_DEFAULT`) —
except calls of the flow-control methods in `QUIET_ACTION_METHODS`
(`terminal_ack`), which arrive many a second under a flood of terminal output
and would turn the whole history over. The
log keeps each call's method, lifecycle (kind, phase, step), timing, and error,
but only a bounded copy of its payloads: an `input`, `output`, `progress`,
request `params`, response `result`, notification `params`, or error `data`
whose JSON is over `ACTION_PAYLOAD_BUDGET` (8192 characters) is replaced by a
`{zzz_payload_omitted: '…'}` marker, and a longer error `message` is truncated
and flagged with `zzz_message_truncated_from` (`bound_action_event_data` in
`action_helpers.ts`). So a `session_load` snapshot, a file read, or a save
doesn't keep a whole file tree or file per call, and `completion_create`
requests, each carrying the chat history so far, don't add up quadratically.
An `Action` stops observing its `ActionEvent` and drops it once the call
completes, so the event's full payloads can be collected.

### Intents

A UI intent is a user's action at the grain of open, close, move, select,
run, save — never a keystroke, cursor, scroll, or pointer move. Each is a
`local_call` spec declared `satisfies IntentActionSpec` (`intent_spec.ts`)
and listed in `all_intent_specs`; every `local_call` spec is one (a test
holds the roster to it). An intent spec adds two fields fuz_app doesn't
know: `version`, bumped when its input's meaning changes, and `history` —
`layout` (open, close, move, toggle: what a later undo reverses),
`navigation` (what back / forward walks), or `none`.

- **One surface for every driver.** A click, a keyboard shortcut, the
  command palette, and tests call `app.intents.*` (typed
  `FrontendIntentsApi`). `app.api` is the RPC surface and resolves no
  intent; `app.intents` resolves nothing else.
- **Sync.** The handler applies the change before the call returns. An
  expected no-op is reported in the output; a call throws only on a bug —
  input or output that fails its schema, or a handler that throws (an
  output failure comes after the handler's change applied). The call runs
  untracked, so an `$effect` that calls an intent doesn't depend on what
  the handler reads; never call one from a `$derived` or a template
  expression, which the untrack would let through. A handler changes
  state through cell methods, never `app.intents` — a nested call would
  record one gesture twice (development builds warn).
- **Recorded apart from the wire log.** Each call lands in
  `app.recent_intents` (`RecentIntents`, the newest 200), never in
  `app.actions`: `{seq, method, version, history, input, at, outcome,
  error, inverse}`, with `inverse` `null` until layout undo is built, and
  the input left out (`null`) when it failed its schema. Nothing persists
  it. The actions page shows it beside the wire log.
- **Local only.** A wire message naming an intent finds no handler for its
  phase; a remote driver (the CLI's navigate, later agents) will reach
  intents through a bridge of its own.

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
  get schema_keys(): ReadonlyArray<SchemaKeys<TSchema>>; // shared per schema (`get_cell_schema_introspection`)
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
	Turn /* ... */
} satisfies Record<string, typeof Cell<any>>;

// frontend.svelte.ts — auto-registers all classes under their keys
for (const [class_name, constructor] of Object.entries(cell_classes)) {
	this.cell_registry.register(class_name, constructor);
}

// Lookup by ID at runtime
const cell = app.cell_registry.all.get(id);
```

The registered classes (./reference.md has the generated roster). `Socket`
is not a Cell — it's a plain `.svelte.ts` wrapper around fuz_app's
`FrontendWebsocketClient` — so it isn't listed:

- `Parts` (`parts.svelte.ts`) — Collection of all parts
- `TextPart` (`part.svelte.ts`) — Direct text content
- `DiskfilePart` (`part.svelte.ts`) — File reference content
- `Capabilities` (`capabilities.svelte.ts`) — Feature capability tracking
- `Chat` (`chat.svelte.ts`) — Chat container with threads
- `Chats` (`chats.svelte.ts`) — Collection of chats
- `Diskfile` (`diskfile.svelte.ts`) — Single file on disk (its content when
  loaded, its `size` in bytes, and its `mtime`)
- `DiskfileTab` (`diskfile_tab.svelte.ts`) — Editor tab for a file
- `DiskfileTabs` (`diskfile_tabs.svelte.ts`) — Tab manager
- `DiskfileHistory` (`diskfile_history.svelte.ts`) — File edit history
  (owned by the file's app-level `DiskfileEditorState`)
- `Diskfiles` (`diskfiles.svelte.ts`) — Collection of disk files
- `DiskfilesEditor` (`diskfiles_editor.svelte.ts`) — Multi-file editor state
- `Job` (`job.svelte.ts`) — A backend job: long-running work on a file (a
  transcription), its status and progress
- `Jobs` (`jobs.svelte.ts`) — The account's jobs, mirroring the backend's
- `Model` (`model.svelte.ts`) — AI model definition
- `Models` (`models.svelte.ts`) — Model catalog with indexes
- `Action` (`action.svelte.ts`) — Single action event state
- `Actions` (`actions.svelte.ts`) — Action history: the newest 512 calls,
  payloads over 8192 characters of JSON replaced by markers (§ Actions Log)
- `Prompt` (`prompt.svelte.ts`) — Reusable prompt template
- `Prompts` (`prompts.svelte.ts`) — Collection of prompts
- `Provider` (`provider.svelte.ts`) — AI provider config
- `Providers` (`providers.svelte.ts`) — Collection of providers
- `Recorder` (`recorder.svelte.ts`) — App-level microphone recording to a
  file: the upload sink, finalize, transcribe-on-stop, over an
  `AudioCapture` (`audio_capture.svelte.ts`, app-free: microphone, pause /
  resume, duration, level, chunks to any sink)
- `Turn` (`turn.svelte.ts`) — Single conversation message
- `Thread` (`thread.svelte.ts`) — Linear conversation with one model
- `Threads` (`threads.svelte.ts`) — Collection of threads
- `Terminal` (`terminal.svelte.ts`) — PTY terminal run: status, buffered output, ordered input
- `Terminals` (`terminals.svelte.ts`) — App-level terminal runs; routes output/exit notifications
- `TerminalPreset` (`terminal_preset.svelte.ts`) — Saved terminal command config
- `TerminalPresets` (`terminal_presets.svelte.ts`) — Collection of terminal presets
- `Time` (`time.svelte.ts`) — Reactive time state
- `Ui` (`ui.svelte.ts`) — UI state (menus, layout)
- `Project` (`project.svelte.ts`) — Open project: its root, kind, registry
  entries, and focused directories
- `Projects` (`projects.svelte.ts`) — Collection of open projects, keyed by root

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
- Diskfile (`DiskfilePart`) — `path: DiskfilePath | null` → sends the file's draft (`Diskfiles.drafts`) if it has one, else its disk content;
  attaching one loads the file's content and keeps it current (see
  [Contents on demand](#file-editing))

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

Container for multi-model comparison. Holds `thread_ids`, resolves to Thread
instances. `view_mode: 'simple' | 'multi'` controls single-thread vs
side-by-side display.

## Data Flow

### Completion Request

```
User types message in Chat UI
  → Thread.send_message(content)
    → Create user Turn with TextPart
    → Create empty assistant Turn (progressToken = turn.id), `pending` set
    → Await the history's file parts still loading, retrying a failed read once (`load_parts_content`)
    → Build CompletionMessage[] from thread history (before the new message,
      which is sent as `prompt`)
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
reserved for genuine broadcasts (`filer_change`, `project_changed`).

A chunk updates only its own turn: `Turn.length` / `token_count` and
`Thread.length` / `token_count` are summed from the parts' and turns' lengths
(`joined_content_length`, `render_messages_length`), so a thread's token count
doesn't re-concatenate the conversation per chunk. `Thread.content` builds the
full text only when something reads it, like "copy conversation".

## Terminals

PTY terminals drawn by zzz's own terminal view (`TerminalView.svelte`, a
`FuzTerminal` over Ghostty's emulator — see [fuz_terminal](./fuz_terminal.md)
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
  `consumed` waits until the view leaves `loading` (the view's `onstatus`,
  which calls `TerminalViewLink.view_status_changed`):
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
  more. A `write` that throws is logged and its chunk still consumed: an
  exception never reaches the cell's delivery to its other listeners.
  `TerminalOutputAcker` batches the acks: one at once when 256 KiB are
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
  hosts one `FuzTerminal`, whose module comes from
  `load_fuz_terminal_module` (`fuz_terminal_module.ts`):
  `static/fuz_terminal/ghostty-vt.wasm`, fetched and compiled once per page
  and shared by every view, a failed load dropped so the next view retries.
  A missing module — a 404, or an HTML page in its place — leaves the view
  `failed` with a message naming `cargo xtask ghostty-vt`, and so does a
  load that hasn't settled within `FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS`
  (about 30 seconds; the fetch is aborted), which is what ends a load that
  would never finish: the view fails, the output it held is released, and
  its retry is offered; the process runs regardless and its output buffers,
  though nothing answers its queries, so a shell that waits for a reply at
  startup stalls until its own timeout. A view whose emulator is `poisoned`
  shows "reopen", and a `failed` one "retry": either remounts it — a fresh
  instance, replayed from the cell's buffer — and a retry loads the module
  again, so building it and retrying recovers without a page reload. The
  view takes keys (`accepts_input`) exactly while `send_input` takes bytes,
  so a terminal whose process ended leaves keys — Tab included — to the
  browser. It never takes focus on its own: a click or Tab focuses it. A
  view taking keys marks its root (`data-fuz-terminal-keys`), and the
  dashboard's global shortcuts (`dashboard_shortcuts.ts`: ``
  ` ``, `~`, Escape) leave keys whose target is inside one (`is_fuz_terminal_key_target`) to the terminal, as they leave a text field's — so with focus in a terminal, Escape goes to the program and leaves an open desk menu open. The app's other global key handlers are on pages that host no terminal, and a context menu takes keys only while it's open; a new global shortcut makes the same check. The copy button and the context menu's "copy output" read the emulator's text (`get_text`: the scrollback and screen, soft wraps joined). The view passes `TERMINAL_SCROLLBACK_MAX_BYTES` (2 MiB) as the emulator's `scrollback_max_bytes`: the limit counts the emulator's memory, pruned in whole pages, so a wider or more styled terminal keeps fewer lines, dropping the oldest; the library's default keeps a single page. A remount replays the whole output buffer, which usually holds more than that, so the fresh emulator keeps the newest history up to the limit. The context menu's "paste" (enabled exactly while the terminal takes input) reads the clipboard (`read_clipboard_text`, `navigator.clipboard.readText`, started in the entry's activation, since a browser allows the read only with a user gesture — Chrome asks for permission once, Firefox shows its own paste button) and hands the read to the view, which runs `paste_terminal_text` (`terminal_paste.ts`) over `FuzTerminal.paste` (./fuz_terminal.md, *Paste*). A paste longer than the terminal's input takes now (`Terminal.input_room`: what's left of `TERMINAL_INPUT_PENDING_MAX_LENGTH` after the input waiting to be sent, which `send_input` would otherwise drop the whole paste past) is refused whole, naming the limit — measured as `send_input` measures, the bracketed frame included, and before the text's safety, so a paste that can't fit is never asked about. Unsafe text (`get_ghostty_paste_hazard`) is pasted only once the person confirms it (`confirm`), and the confirmation covers only the hazard asked about: the second paste allows that hazard in that mode, so if the program toggled bracketed paste while the person was asked and the text is unsafe in the new mode (its hazard, or only the mode, differs from what was asked), nothing is sent and the notice says to paste again, which asks about the text as it is then (text the toggle made safe is pasted). Asking again at once instead could repeat for as long as a program kept toggling; the refusal is bounded. A failed or empty read, a refusal, or a view that takes no input is shown in the view as a notice until the next paste that doesn't fail, or it's dismissed — never thrown. A paste that goes through focuses the terminal. `TerminalViewLink` (`terminal_view_link.ts`) is the wiring between the cell and one view — attach and replay, acks, input decoding, resize — kept out of the component so tests drive it with a real `Terminal` cell.
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

A terminal the backend no longer has becomes `lost`, with an `error_message`
saying why, and its queued input is dropped: when `terminal_data_send` or
`terminal_resize` answers `not_found`, or when the session snapshot loaded
after a reconnect doesn't list a terminal that was running (the message
tells a zzzd restart — a new `server_instance_id` — from a process that
ended or was closed from another tab while the connection was down, whose
`terminal_exited` was missed). A lost terminal can be restarted. The backend
drops a terminal just before sending its `terminal_exited`, so one can be
marked lost moments before its real exit arrives; the exit then wins
(`exited` with its code). Output sent while the socket was down is lost too,
so a reconnect flags each running terminal's `output_gap`, and its view
shows a dismissible "connection lost — some output may be missing" notice.

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

The emulator binding, the renderer, and zzz's adapter — mechanics, the frame
data, the key mapping, drawing, the host API, and the view's wiring — are in
./fuz_terminal.md.

## Recording

`Recorder` (`recorder.svelte.ts`) is an app-level cell that records the
microphone to a file on disk. Being app-level, a recording carries on across
route changes; `RecorderIndicator` in the root layout shows it — status,
duration, pause and stop — on every page while the microphone may be open.

It's two layers. `AudioCapture` (`audio_capture.svelte.ts`) owns the
microphone — the user-gesture check, the format, `MediaRecorder`, pause and
resume, duration and level — and hands each chunk to an `AudioCaptureSink`
it is given, knowing nothing about the app or where chunks go. `Recorder`
supplies the sink (a `ChunkUpload` to a file) and owns what happens after:
the path, finalizing, and transcribing. Capture has no backend or AI
dependency, so another app can record into its own sink.

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

**The file is the recording.** It is created under its final name — the
local time it started, like `2026-01-31_09-05-07.webm` — in the directory
`start` is given (the files page passes `Diskfiles.new_files_dir`), and
grows in place as chunks arrive. Nothing is buffered for the length of the
recording: a crashed tab loses at most the last chunk (`chunk_duration`, a
few seconds), and the file left behind still plays.

**Chunks land exactly once, in order.** `ChunkUpload` (`chunk_upload.ts`)
sends one chunk at a time, each as an append at the offset it expects (see
[File Bytes](#file-bytes)). A request that gets no answer, or a server
error, is retried with backoff; when the retry is refused because the file
already grew by exactly this chunk, the first attempt landed and only its
reply was lost. Any other refusal — the file changed on disk, the session
ended — fails the upload, which ends the recording with the reason in
`Recorder.error`.

**Stopping finalizes.** A browser's `MediaRecorder` streams its output, so
the file's header has no duration or seek index. Once every chunk has
landed, `media_finalize` has the daemon rewrite the file in place with both
(an `ffmpeg` stream copy — nothing is re-encoded). If finalizing fails the
recording is kept as it is, and `Recorder.error` says so.

**The microphone.** Capture starts in exactly one place,
`AudioCapture.start` (which `Recorder.start` calls), and it refuses unless a
user gesture is in effect (`navigator.userActivation`; a browser without
that API can't be asked, and is let through) — so it follows a click or a
key press, and nothing the backend sends can open the microphone.
`Recorder.active` is true from the permission prompt until the recording is
saved; while it is, the indicator shows on every page and leaving the page
asks first (`confirm_unload_while_recording`). Disposing the app — a logout,
a session found revoked — closes the microphone and doesn't finalize; the
chunks the uploader already holds, and the last one the browser hands over
as it stops, are still sent. A track that ends on its own (the device
unplugged, the permission revoked) stops the recording normally.

The browser's side of all this — `getUserMedia`, `MediaRecorder`, the clock
— is behind `AudioCaptureDeps`, which `RecorderDeps` extends with `fetch`,
so tests stand in for the microphone and the network.

### Playing audio

The files page routes a file to its view by content kind (see [File
Editing](#file-editing)); audio gets `DiskfileAudioView`.

The audio view (with its transcript beside it — see
[Transcription](#transcription)) is an `<audio>` element whose `src` is the
file's byte-route URL (see [File Bytes](#file-bytes)); the browser streams
and seeks with `Range` requests, so the file is never loaded into the app. A
file's content being unloaded means its `content` can't show that it
changed, so `Diskfile.mtime` — the disk node's modification time, kept
current by every `filer_change` — keys the player: when the bytes change (a
finalize, an external write) it remounts and loads them. While the recorder
is writing a file, its view says so and shows no player. The view's finalize
button runs `media_finalize` on the file — for a recording cut off before it
was saved, which plays but has no duration.

### Jobs

Some work takes minutes — a transcription — and can't be tied to one
request: closing the tab or dropping the socket would end it. A **job** is
that work on the daemon (`crates/zzz_server/src/job_manager.rs`), reported
to the frontend as it changes.

- A job has an id, a kind, a status (`queued`, `running`, `succeeded`,
  `failed`, `cancelled`), a progress, the file it works on, the file it
  wrote, the command lines it ran, and — when it failed — why, with the tail
  of the tool's stderr (`job_types.ts`).
- Jobs run **one at a time**, in the order they were asked for. The rest wait as `queued`.
- A job belongs to the account that created it. Each kind has its own create
  action (`transcription_create`); what works on any job is generic:
  `job_cancel`, and the `job_changed` notification, which carries the job's
  whole state on every change.
- Jobs live in the daemon's memory, like terminals: a restart forgets them.
  Finished ones are kept as a bounded history.

On the frontend, `Jobs` (`jobs.svelte.ts`) mirrors the backend's list and
holds nothing of its own: `job_changed` adds or updates a `Job` in place,
and every session snapshot (`session_load`'s `jobs`) replaces the collection
— so a reload shows the running job again, and after a daemon restart the
list is empty. The `/jobs` page lists them plainly; the place a
transcription is actually watched is the audio file's view.

### Transcription

`transcription_create` transcribes an audio file with a speech model that
runs **on this machine** (whisper.cpp). Nothing is sent anywhere: there is
no hosted transcription.

```
transcribe → transcription_create {path}         → {job_id}, a queued job
job runs:    hash the audio (blake3)
             ffmpeg: decode to 16 kHz mono PCM     (handles only)
             whisper-cli: PCM on stdin
               ├─ each segment as it's decoded   → transcription_progress
               └─ progress                       → job_changed
             write <name>.<model>.transcript.json  (exclusive)
```

**The transcript is a sidecar file** beside the audio
(`transcript_types.ts`): timed segments, each with its words and their
probabilities, plus provenance — the audio's hash and size, the backend and
its version, the model and its hash, the parameters. It's tool output, so it
is **written once and never edited**: the model's name is in the file name,
so a better model's transcript sits beside it rather than replacing it, and
transcribing again with the same model is refused until the sidecar is
deleted. A sidecar is found for an audio file by its name and by what it
says it was made from (`find_transcripts`) — a model's name has dots in it,
so the name alone can't say.

**Batch, with a preview.** The transcript is made from the finished file.
The recognizer decodes in windows and reports segments as it goes, so
`transcription_progress` fills in `Job.live_segments` while the job runs;
when it succeeds the sidecar arrives through the file index and replaces the
preview.

**Reading it.** An audio file's view shows its transcript under the player —
the one on disk (a picker when there are several models'), or the running
job's preview — and clicking a segment plays from there; with none, a
transcribe button. A sidecar opened on its own (`DiskfileTranscriptView`)
shows the same segments read-only, with the audio's player when the audio is
beside it.

**Editing a copy.** "Edit a copy" (`transcript_to_text`) creates `<name>.md`
beside the audio — a link to it, then the speech as paragraphs split at
pauses — and opens it in the editor. That file is yours; the sidecar stays
as the tool wrote it.

**Transcribe on stop.** The recorder queues a transcription for a recording
once it's saved, when its `transcribe_on_stop` toggle is on (the default).
That's the person's choice, made by leaving the toggle on — nothing else
starts one, and a file that merely appears in a project is never decoded or
transcribed.

A transcript's text is whatever was said near the microphone. It's rendered
as text, and nothing places it in a chat, a prompt, or a terminal on its
own.

### The recordings page

`/recordings` is the purpose-built view over the same pieces: a record
button with a level meter (`Recorder.level`, read from a Web Audio analyser
on the live stream), and the recordings with their transcripts' first lines.
It records to `recordings/` in the app directory, so it works with no
project open. Recordings, transcripts, and jobs are all ordinary files and
cells — the files page and the jobs page show the same things raw.

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
  large or busy collections (`Projects.by_root`, and `Jobs`' id index). Derived-array
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

## Zzz App Directory

The app directory stores zzz's own files. Configured via `PUBLIC_ZZZ_DIR`
(default `.zzz`, relative to the daemon's working directory): `./.zzz` under
`cargo xtask dev`, `~/.zzz/.zzz` for the CLI's daemon, whose working directory
is the daemon home `~/.zzz/` (see ./development.md § The `zzz` CLI).

- `state/` — Persistent data (reserved — the Rust backend currently keeps domain state in memory)
- `cache/` — Regenerable data, safe to delete: scratch for tool runs —
  unnamed temp files (unlinked as soon as they're created) and, during a
  transcription, a `.zzz-tmp-<uuid>/` directory removed when it ends
- `recordings/` — where the recordings page records: audio files and their transcript sidecars
- `run/` — Runtime ephemeral (the test binary's `daemon_token`)

It's a permanent `ScopedFs` root with its own filer, so the frontend can
read and write files there. A project or scoped-dir filer whose root contains the
app directory skips it by its full path (its own filer covers it), so a
custom-named app dir (say `data`) doesn't hide other `data/` folders.

A directory named `.zzz` other than the app dir — the CLI's daemon home, which
holds `.env` and `bootstrap_token`, or another daemon's app dir — is off limits
whatever root covers it, and so are the credential directories (`.ssh`,
`.gnupg`, `.aws`, `.kube`, `.docker`, `.password-store`). `ScopedFs` refuses
every operation on a path in one of these protected directories — reads,
writes, creates, appends, deletes, through the file actions, the media
actions, and the byte routes alike — with `forbidden` /
`protected_dir_not_allowed` (403 on the byte routes; the message names the
directory), whether or not the path exists. Every filer skips them, and
`project_open` refuses one (same error), whether it's the opened directory
or the project's root, so `zzz ~/.zzz/.env` (which opens `~/.zzz/`) can't
index and broadcast those secrets. The app dir and the paths inside it stay openable, readable, and
writable (the boot refuses an app dir inside a credential directory).
`.env` files elsewhere are ordinary files.

The daemon home holds the CLI's files beside it: `config.json`, `.env`,
`bootstrap_token`, `static/` (the UI build), an optional `bin/` (searched
for `zzzd`), and `run/`
(`daemon.json` — boot id, pid, start time, port — `daemon.log`, and an
opener's `opener.log`).

All filesystem access goes through `ScopedFs` — path validation, no
symlinks, absolute paths only. A save based on a read is a compare-and-swap
(`expected_hash`, see § File Editing, "Conflicts"). Saves are atomic:
`diskfile_update` stages the content in a hidden `.zzz-tmp-<uuid>` file
beside the target (never indexed or broadcast by the filer), fsyncs it, and
renames it over the target, so a failed or concurrent save never leaves an
empty or mixed file. The file's mode is kept — except setuid and setgid,
which zzz always drops on a save — and its owner best-effort (a file owned
by another user becomes the daemon user's when zzz can't restore it); being
a new inode, a saved file **loses its hardlinks** (other names keep the old
content) and any xattrs/ACLs. An existing file must be writable by the
daemon — a read-only file is refused (`permission_denied`) even though its
directory would allow the rename. When the rename can't happen but the file
itself is writable — its directory isn't writable, or the file is a bind
mount (`EBUSY`) or in a sticky directory (`EPERM`) — the save falls back to
writing in place (truncate + write + fsync), which is **not atomic**: a
failure midway leaves the file truncated or partial. A new file in a
non-writable directory fails with `directory_not_writable`. Only regular
files are written — a directory, FIFO, socket, or device node target is
refused. A crash mid-save can orphan a staging file; the filer's walk
deletes exact `.zzz-tmp-<uuid>` regular files older than an hour (ones
inside ignored directories stay). The files page's header buttons for a new
file and a new folder create in the active project (`Project.new_files_dir`:
the directory this client's last open of it focused, while still focused,
else its root) and are disabled while no project is open; a new file or
folder in a registry project where the index doesn't look — an unfocused
repo, a directory no entry names — is refused before anything is written
(`Diskfiles.is_unfocused_path`: it would never show); the file tree's folder
menu creates in that folder (see § File Editing, creating in the tree). In
the list the name is asked for with a prompt, and a failure (say a
non-writable directory) is reported in an alert, never silent, as is a
failed delete (each alert leads with the name or path); in the tree it's
typed inline, and a failure shows there. The entered name is trimmed,
leading slashes dropped; refused (`parse_new_diskfile_name`): a blank name,
one naming the root itself, a whitespace-only path segment, a `..` climbing
out of the root, and a file name whose last segment is empty, `.`, or `..`.
"New file" uses `diskfile_create`, which creates the final name exclusively
(`O_EXCL`) and fails with `conflict` / `already_exists` instead of
overwriting; "new folder" (`directory_create`) fails the same way when the
name is taken, directory or not. For both, a symlink at the name is refused
as `forbidden` / `symlink_not_allowed` (zzz never follows symlinks), and a
missing parent folder that can't be created under a read-only ancestor
reports `permission_denied` rather than `directory_not_writable`. The UI
shows a path inside the app directory relative to it and any other path
absolute — including a file part's `path` attribute in the prompt XML sent
to models.

## Filesystem

Two separate concerns:

- App directory (`PUBLIC_ZZZ_DIR`) — Zzz's own files: `cache/` holds scratch
  for tool runs, `recordings/` what the recordings page records, `run/`
  the test binary's `daemon_token`, and `state/` is reserved
- Scoped dirs (`PUBLIC_ZZZ_SCOPED_DIRS`) — User file access (comma-separated paths)

### Root scope

Which directories can be roots at all — an open project's root or a scoped dir —
is one rule (Rust: `crates/zzz_server/src/root_policy.rs`), checked on the
canonical path, so no symlink or `..` spelling changes the answer:

- **Never** `/`, the home directory (`$HOME`, the daemon's, canonicalized at
  boot) or any ancestor of it, or anything under `/proc`, `/sys`, or `/dev`.
- **Otherwise strictly inside `$HOME`**, or at or inside a directory
  `ZZZ_ROOTS_OUTSIDE_HOME` names (comma-separated; an entry the first rule
  refuses fails the boot).

`project_open` (and so `zzz <path>`) answers a refused directory — the
opened one, or the project root it resolves to — with
`forbidden` / `root_outside_home` when the allowlist would admit it and
`root_not_allowed` when nothing would; a scoped dir it refuses fails the
boot. A scoped dir that doesn't exist at boot is checked as spelled — a `..`
in the spelling fails the boot — and again on its canonical path when its
filer starts, which skips it (with a warning) if that path is refused or
isn't the one the boot checked. A `$HOME` that can't be resolved, isn't a
directory, or is `/` admits nothing but the allowlist (with a boot warning). The app dir is the
operator's own and exempt from the `$HOME` rule, not from the first. So a
project can't take in the whole home directory with its dotfiles, the
whole filesystem, or `/proc/<pid>/environ`; credential directories inside
an admitted root stay refused by `ScopedFs` (§ Zzz App Directory).

### ScopedFs

All filesystem operations go through `ScopedFs` (Rust:
`crates/zzz_server/src/scoped_fs.rs`). Security: paths validated against
allowed roots, protected directories (credential directories, and `.zzz`
directories other than the app dir) refused under every root (see § Zzz App
Directory), symlinks rejected, absolute paths required, parent directories
checked recursively.

The allowed roots are the permanent boot-time set (the app directory +
scoped dirs) plus one runtime root per open project — its whole root,
focused or not (a registry's root is `~/dev`, every repo under it in scope).
A path is allowed when any root covers it, and removing a project's root
never touches a permanent root — so closing a project rooted at, nested in,
or containing the app directory or a scoped dir leaves the access those
roots grant intact.

### Reading Files

`diskfile_read` reads one file as text:
`{contents, unloaded_reason, size, ctime, mtime}`. Any regular file in scope
can be read, whether the filer indexes it or not — except a file in a
protected directory — a credential directory, or a `.zzz` directory other
than the app dir (`forbidden` / `protected_dir_not_allowed`, refused whether
or not the file exists). It reads the disk as it is now — nothing is cached,
and the filer's index holds no contents — so it returns what's there even
before the filer has seen the latest write. A file over 4 MiB or not valid
UTF-8 comes back with `contents: null` and an `unloaded_reason`
(`too_large`, `not_utf8`), and its `size`. The timestamps come from the
handle the contents were read from, taken before the read, so a write racing
the read leaves them older than the contents, never newer; `size` is the
contents' length when they're loaded. Errors carry the file actions' reasons
(`path_not_found`, `path_not_allowed`, `symlink_not_allowed`,
`is_a_directory`, `not_a_regular_file`, …). Larger files and bytes go over
the byte routes below.

### File Bytes

The file actions carry contents as UTF-8 strings inside one JSON-RPC message
(`diskfile_update`, `diskfile_create`), and `diskfile_read` returns text
only for UTF-8 files under its size limit. Bytes have their own path: plain
HTTP routes at `/api/files/bytes?path=<absolute path>` (Rust:
`crates/zzz_server/src/file_bytes.rs`; `src/lib/file_bytes.ts` builds the
URLs).

- **Read** — `GET` returns the file's bytes and honors one `Range: bytes=`
  range (206, or 416 past the end), which is what a media element needs to
  seek. The URL works directly as an `<audio>` or `<img>` `src`: the request
  carries the session cookie.
- **Create** — `POST` creates the file exclusively from the request body, like `diskfile_create`.
- **Append** — `PATCH` with `&offset=` appends the body only if the file is
  exactly `offset` bytes long, and otherwise answers 409 `offset_mismatch`
  with the file's current `size`, having written nothing. A writer that
  streams a file as chunks sends each at the offset it expects: a retried
  chunk can't land twice, and the reply's size tells it whether the first
  attempt landed.

Paths go through `ScopedFs`, and errors carry the same reasons as the file
actions' (`path_not_allowed`, `protected_dir_not_allowed`, `already_exists`,
…) in a flat `{error}` body. The routes need a session or a full-scope API
token.

A file in a project is untrusted content, so a read never hands the browser
something to run: only allowlisted raster image, audio, and video extensions
are served with their media type, and everything else — HTML, SVG, XML,
scripts, text — is an `application/octet-stream` download. Every response
that serves or describes a file — a read, a write's reply, a file error —
carries `X-Content-Type-Options: nosniff`, a sandboxing
`Content-Security-Policy`, and `Cross-Origin-Resource-Policy: same-origin`,
and is never cached (`no-store`); a refusal at a gate (a bad query, no
credential, an oversized body, a foreign origin) is a plain JSON error
without them.

These routes are outside the action system — they don't appear in the
actions log or in ./reference.md.

### Filer

`FilerManager` starts one `Filer` watcher per unique directory — the app
dir, each scoped dir, and each open project's root and focused directories
(§ Projects). A registry's root is watched at its top level alone
(`FilerDepth::TopLevel`): its loose files are indexed, its subdirectories
never listed or watched — a directory appearing there isn't indexed — so a
focused repo's own filer is the only one under it. Every other filer indexes
its whole tree. Each filer keeps an in-memory file index and broadcasts
changes to clients via debounced `filer_change` notifications over
WebSocket. Each file travels as a disknode,
`{id, source_dir, size, ctime, mtime}` — metadata only: `id` is its path and
`size` its bytes from the filer's `lstat`, `null` only on a `delete`'s node.
No disknode carries contents; a client reads them with `diskfile_read` (see
[File Editing](#file-editing)). A snapshot — `session_load`, `project_open`,
`repo_focus`, `repo_files` — carries its files compactly instead
(`SnapshotFiles`): one `{dir, files}` group per filer dir, each file a tuple
`[rel, size, mtime, ctime?]` with its path relative to `dir` and `ctime`
left off when it equals `mtime`, which the frontend decodes back to
disknodes (`decode_snapshot_files`) — about half the bytes of the objects
for a large tree. Timestamps are whole milliseconds since the epoch. Notify
events are treated as hints: for every event, removes and renames included,
the filer `lstat`s the path and decides `add` / `change` / `delete` from the
disk and its index, so renames resolve to a delete of the old path plus an
add of the new one, and late or reordered events can't delete a file that
exists. The index is stat-only — the filer reads no file — and a file is
unchanged only when its `lstat` stamp (device, inode, size, mtime, ctime)
matches the indexed one; any other is a `change` carrying the new metadata,
a `touch` and a rewrite of the same bytes included. The stamp's `ctime` is
the inode change time (`st_ctime`), which every write, chmod, and `utimes`
moves and userspace can't set on a kernel-managed filesystem; the wire
`ctime` is the birth time. So a chmod, chown, or new hard link is a `change`
too, with the same wire metadata as before. A stamp is trusted only when its
inode change time lay more than three seconds before it was taken (git's
"racily clean" rule: same-size writes within one timestamp tick look
identical), so a file indexed while it might still have been written is a
`change` the next time an event or a rescan looks at it, even with its stamp
unmoved. An `mtime` in the future (`touch -d`, `cp -p`) doesn't matter. A
client holding the file's content reads it again if it holds it eagerly and
otherwise drops it, to load on next access (`Diskfiles.upsert`), and a
re-read of the same text changes nothing. Broadcasts are debounced per path
(80ms quiet, at most 500ms): a delete then re-create becomes one `change`,
and a file created and deleted inside the window is sent only as a `delete`
(a no-op for clients that never saw it). Ignored paths (see below) are
filtered before the event channel; if events are still dropped (or the OS
queue overflows), the filer rebuilds its watches on a fresh watcher, rescans
its root, and broadcasts the diff. Symlinks are skipped entirely — never
followed, never indexed, never watched — matching `ScopedFs`.

Watches are per directory: the filer's own walk (on a blocking thread) adds
one non-recursive watch to each directory it indexes — never inside ignored,
symlinked, or non-UTF-8 directories — watching each before listing it, so
nothing created in between is missed. A directory that appears gets watches
for its subtree when it's synced; one that's removed or renamed away has
them dropped (two paths sharing one inode, like a renamed directory's old
and new path or a bind mount, share one kernel watch, removed only with its
last path). An unreadable subdirectory is skipped and logged once, and
picked up once it's readable again; one made unreadable later drops out of
the index. A listing that fails transiently (`EMFILE`, `EIO`) keeps what's
indexed under it and retries. A walk or a rescan (`session_load`, overflow
recovery) costs one `lstat` per file and reads none, and broadcasts only the
files whose stamps moved or weren't trusted yet.

What a filer ignores is decided once, when it starts, from its root alone
(`filer::ignore`). A root whose own `.git` is a directory or a gitfile by
`lstat` — a checkout, as § Projects resolves one — indexed whole takes
**git's rule**; anything else (a plain directory, a registry's root at its
top level) keeps **fixed names**: `node_modules`, `.svelte-kit`, `target`,
and `dist`, wherever they appear. Under both, `.git`, `.zzz`, the credential
directories, and `.zzz-tmp-` staging files are never indexed, whatever a
`.gitignore` says. Under git's rule everything else is git's call: at start
the filer lists what git ignores
(`git ls-files --others --ignored --exclude-standard --directory`, every
`.gitignore`, `info/exclude`, and the user's global excludes file), confirms
each folded directory with one `git check-ignore` (git folds a directory
whose untracked contents are all ignored even when nothing names it — zzz's
own `.claude/` — so those are walked and watched, their ignored files
skipped one by one), and prunes the walk by the result. A tracked file is
never ignored, so a tracked `dist/` is indexed, and so is a `node_modules/`
no pattern names. A repo of its own below the root — a nested repo, a
populated submodule, a directory whose `.git` is a symlink — is neither
walked nor indexed. Every listing is taken twice, around its walk, so what
was created in between is listed rather than indexed unvetted. Live, a burst
of events that adds paths not yet indexed asks one `check-ignore` about them
before they're indexed — up to 128 paths; git's check costs per path about
what reading its index does, so past that a rebuild of the set (below) is
cheaper on a large tree — and a new directory git doesn't ignore has its own
ignored paths listed before its walk; a `.gitignore` changing anywhere under
the root or `.git/info/exclude` changing (watched by the filer's own
watcher, for a root whose `.git` is a directory) rebuilds the set and
rescans once the changes settle (400 ms of quiet, at most 5 s), so a
checkout's intermediate states aren't applied one by one, and lost events do
so at once — removing what's newly ignored and adding what no longer is. git
runs with the daemon's allowlisted environment, its discovery ceilinged at
the root's parent, implicit bare repos refused, and short timeouts (5 s per
listing call, 2 s per vetting call), after re-checking that the root is
still the real directory it was. When git is unusable or its first listing
fails, the filer keeps fixed names; a later listing that fails keeps the
last set until the next rebuild — a `.gitignore` or `info/exclude` change,
lost events, or, while the last rebuild failed, the next `session_load`
rescan or degraded poll — and the filer keeps fixed names for the rest of
its life once three rebuilds in a row that a change on disk asked for fail —
a `.gitignore` or `info/exclude` change, lost events, new files git couldn't
vet, or a set grown past its budget (a load's or poll's retry failing
doesn't count) — or at once when the root is no longer the checkout it was
(swapped for a symlink).

When the OS runs out of watches (inotify's `max_user_watches`), or no
watcher can be created at all (`max_user_instances`), the filer runs
**degraded**: the index still comes from the scan, and the directories
without a watch are rescanned every 5 seconds or more (retrying their
watches each time), so changes there show up late. `project_open` returns
this as `watch_status` (`'full'` or `'degraded'`, degraded when any of the
project's filers is), which the tab that opened it keeps on its `Project`
cell and shows on the projects page and in the desk menu. It's reported at
open time only (another tab or a reload shows `'full'`) — a filer that
degrades or recovers later is just logged. A project root or focused
directory that can't be listed fails `project_open` (`forbidden` /
`permission_denied`, or `not_found`); a running filer whose root disappears
polls it until it's back.

### Daemon Info

`~/.zzz/run/daemon.json` tracks the running daemon (boot id, pid, kernel
start time, port, version). The Rust CLI
(`crates/zzz/src/daemon_lifecycle.rs`) writes it atomically once the spawned
`zzzd` holds the listening socket and answers `/health`, reads it back for
discovery and `status`, and identifies the daemon by boot id, pid, and start
time — a dead or reused pid reads as stale and is never signalled; a record
it can't read (an older or newer zzz's, or a corrupt one) is reported and
never signalled, removed, or overwritten, so `zzz` and `zzz daemon start`
refuse to start a daemon while it's there. The file is removed on
`daemon stop`, when the foreground `daemon start` exits, and when found
stale, each time only if it still records that same process.

## File Editing

The files page picks a file's view in one place, `DiskfileView`, by its
content kind (`to_diskfile_content_kind` — the extension, since the file index
carries no type): audio gets the player (`DiskfileAudioView`, see
[Playing audio](#playing-audio)), a transcript sidecar `DiskfileTranscriptView`,
markdown (`.md`, `.markdown`) `DiskfileMarkdownView`, and everything else the
text editor (`DiskfileEditorView`). The markdown view is the text editor's
twin over the same editing state: its source in `SourceEditor` (fuz_code's
highlighted `CodeTextarea`) beside a live `MarkdownPreview`, or either alone —
split, preview, or source, a mode chosen per file and kept by path
(`Diskfiles.markdown_view_modes`, outlasting the editing state),
defaulting to the split, or to the preview when the content can't be
loaded. Ctrl+Shift+1, 2, and 3 switch to split, preview, and
source from anywhere on the page — the textarea included, since Ctrl+Shift
types nothing — except an input or contenteditable outside the view, or while
a modal dialog is open. The markdown view's details add the document's
outline and its broken links: clicking either scrolls the preview to it and
puts the editor's caret at its source, in whichever panes are shown.

Every file view keeps its details — the file's actions, info, and history —
in one drawer at its right edge (`DiskfileDetailsDrawer`). The drawer is
open by default and its state is app-wide (`Ui.show_diskfile_details`), so
it holds across files and views; with it closed, an error from an action
in it (a failed save, say) shows beside the view instead
(`DiskfileSaveErrorNotice`). One icon toggle in the files header, at
the tab strip's right end after the tabs, writes it, and the drawer
follows. Toggling resizes the panes beside it once, at the start — its
wrapper takes the drawer's width in the flow, or gives it up, at once — and
only its content animates, sliding in from beyond the view's edge or back
out over the widened panes, at the drawer's width so nothing re-wraps,
clipped to the drawer's box. Opening mounts the content off the edge first
and styles it there before the drawer opens, so its move transitions; a
first render or a remount starts in place, unanimated. Closing, the content
is inert, and gone once its slide ends (at once with reduced motion). Each
view's root is a stacking context (`isolation:isolate`), so the drawer's
`z-index` over the panes, and the markdown source editor's own, stay under
the desk menu's overlay. The desk menu's button is fixed over the header's
right end while it shows, so the header ends with an invisible copy of it
that keeps the toggle and the tabs out from under it.
`DiskfileView` keys the view on the file, so a switch mounts a fresh one and
nothing a view holds for its file — a caret, the outline's lights, a playback
position — carries over to the next, and a return to a file shows it from
its top. The markdown view parses the source once with `mdz_parse` and hands
the nodes to the preview, the outline, and the link list.

The outline lights where the reader is, as a docs page's links do
(`markdown_outline.ts`). A heading's section runs to the next heading at
its level or above, or to the document's end, so sections nest. Every
section overlapping the source range the pane being read shows — the
preview, or the editor alone — is dimly lit, a parent with any child; the
section the reader is at is brighter, with `aria-current="location"`.
Wherever the editor shows, it's the innermost section holding the caret,
however the panes are scrolled; placing a caret ends any heading followed
before it. With no caret — the preview alone, or before the editor has
one — it's the topmost heading fully in the pane: going down,
the next takes over as soon as the current one starts to leave the top;
going up, the previous only once its heading is back in view; with no
heading in view, the current holds while its section shows. The view
re-reads the pane on scroll sync's frame (`onframe`) after a scroll, a
resize, a re-render, a mode switch, or the drawer opening, measuring by
binary search a few of the preview's cached leaf blocks or the editor's
characters, each on its line on the backdrop, and nothing while the drawer
is closed or closing, whose lights clear as it closes.

The preview renders with mdz's source offsets (`source_offsets`: each
element carries its node's `data-mdz-start` / `data-mdz-end`), which map it
back to the source (`markdown_source_map.ts`). The editor holds and mdz
parses the source as a textarea reads it — a CRLF file's line breaks as
`\n` (`to_textarea_value`) — so the caret, the offsets, and the outline's
positions index one string; the draft is untouched until an edit. In the
split, three things track the editor:

- **The caret's block** — the innermost block whose range holds the caret
  (its end included, so typing at a line's end stays in its block) gets
  the `markdown-caret-block` class, a sliver in the gutter. The preview
  queries its blocks once per render, so a caret move reads no DOM.
- **Click-to-source** — a plain click in the preview puts the caret at the
  source start of the innermost element under it, inline marks included,
  and focuses the editor, which scrolls to match the preview, so nothing
  moves under the pointer. A link, a control, a multi-click, a modified
  click, or the end of a selection drag acts as it would anywhere, and a
  touch tap jumps nowhere, since focusing the editor would open the
  on-screen keyboard. In the preview alone a click does nothing more: that
  mode is for reading, and a click there switching layouts would be a jump
  the reader didn't ask for.
- **Scroll sync, in lockstep** (`MarkdownScrollSync`) — the pane the user
  last touched (wheel, pointer, touch, key, or focus) leads, and the other
  follows its scroll on the next frame, aligned on the tops and bottoms of
  the innermost blocks (a table's rows, not their cells) and interpolated
  between them, so it moves smoothly through a long block; over the
  leader's last screenful the follower eases to its own bottom. A
  follower's scroll never syncs back, so there's no feedback loop, and a
  re-render or a resize realigns the follower. The editor measures its
  lines on `CodeTextarea`'s highlight backdrop. Lockstep rather than the
  preview following only the caret's block, so reading the source by
  scrolling it reads the preview too; the mapping is one pure function
  (`to_synced_scroll_top`), so another policy is another caller.

mdz gives a paragraph interrupted by a block inside a blockquote an `end`
that runs into the next line's `> ` prefix, so a caret on that prefix
marks the paragraph above.

`MarkdownPreview`'s links never navigate the app (`markdown_links.ts`
resolves them; the preview only acts). An external link opens in a new tab;
a `#fragment` scrolls the preview; and with the file's `path`, a relative
link resolves against the file's directory, a root-relative `/docs/x.md`
against the innermost indexed directory holding the file (a focused repo, or
a checkout's or directory's root — usually the repository, the way a
repository host reads it), with any query dropped and the fragment kept. A
link to an indexed file opens it in the preview tab — a middle- or
Ctrl/Cmd-click in a kept tab instead — and a fragment on a markdown file
reveals that heading once its view shows (`markdown_pending_fragment` on the
target's `DiskfileEditorState`). A link to a folder opens the folder's
README if the index has one. A link the file index says is missing — inside
a root it covers and outside what it skips (`to_innermost_unindexed_part`,
each holding root's rule — § Projects) — is marked broken, and one outside
every root, in a registry project's unfocused repo (the index covers a
registry's root at its top level and its focused repos only; a link to an
entry's dir counts with or without its trailing slash, while an unregistered
directory linked without one reads as a missing loose file), in what the
index skips (titled "not indexed" with why: an ignored name, or under a
focused git root what git ignores or a repo of its own — so a link into a
tracked `dist/` there can be broken), or root-relative and not found is
marked unknown, never broken, since the index can't see there; each mark has
a title saying why, and follows the index and the content as they change.
Everything else — protocol-relative, other schemes, same-origin absolute
URLs, a root-relative `..` past its root, or any `..` past `/`, and any
relative link in a preview without a `path` — is inert (a relative `..`
climbing out of the root reads as outside it, so unknown). The index lists
only files, so what it never indexes reads as missing — an empty folder, a
symlink, a file in an unreadable subdirectory, or a path that isn't UTF-8 is
marked broken. The preview pairs each link with its rendered anchor by their
source offsets, not the `href`, since mdz can rewrite a root-relative `href`
(SvelteKit's `resolve`) — an anchor matching no link node, like one an
injected component renders, is left alone — and follows a click from the
link's reference.

The frontend file pipeline is these Cells plus three plain classes — the
per-file editing state, the drafts store, and the metadata index:

- `Diskfiles` — the pipeline's root: the cells of files in use, by path
  (`cells`, a `SvelteMap`; a `Diskfile` exists only while something holds
  its path), beside every indexed file's metadata record (`Diskfiles.index`,
  a `DiskfileIndex`, described below); its `handle_change` is the
  `filer_change` dispatch point
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
  stack, and the back/forward navigation stacks, keep the 50 most recent. A
  file appearing on disk — seeded by a snapshot or created by another tool —
  never moves the selection or opens a tab; only a file created from zzz
  (`Diskfiles.create_file`) is selected and opened in a permanent tab — at
  once if its `filer_change` already arrived, else when it arrives (under
  the path as the backend normalizes it), unless the user selects another
  file or tab or closes its project first
- `Drafts` (`Diskfiles.drafts`, plain classes, not Cells) — each file's
  draft, keyed by path: its text, the innermost root it was made under
  (`root`, recorded, not part of the key, since a path can sit under
  several open roots), and `base_hash`, the BLAKE3 of the disk content it's
  based on (what a save sends as `expected_hash`). It's kept apart from the
  `Diskfile`, which mirrors the disk, and from the editing state, so it can
  outlive both (for now a draft still keeps its cell). Its `status` is
  derived, never set: `bound`, `stale` (the
  disk's hash isn't `base_hash`, or the editing state saw the disk move),
  `deleted` (the file is deleted on disk), or `dormant` (under no open
  root — its project closed; see "A kept file under no open root" below). In-memory only, lost on
  reload
- `DiskfileHistory` — one file's disk, saved, and discarded states (not
  the draft), newest first; capped at 100 entries and 16M characters of
  content (the draft not counted), trimming the oldest but never the
  newest saved state or the entry an editor shows — in-memory only, lost
  on reload
- `DiskfileEditorState` (plain class, not a Cell) — one file's editing
  state, like a VS Code text model: the selected history entry or the draft
  (`current_content`), the conflict flag, and `save_changes()`. It reads and
  writes the file's draft in `Drafts`, and lists it with the history
  (`content_history`); a state made for a file that already has a draft
  shows it.
  `Diskfiles.get_editor_state` creates it on first use, detached from the
  calling component (see below), and keeps it until nothing holds the file
  and it has nothing to keep (`can_drop`: no draft or other unsaved
  content, no discarded edit, no save under way, no heading to reveal) —
  closing a clean file's last tab drops it with the cell, and its saved and
  disk history goes with it — or the diskfile is removed. A markdown view mode chosen is kept by
  path (`Diskfiles.markdown_view_modes`), so it outlives the state.
  The `/files` editor, file-part editors, and tabs are views over it, so a
  tab switch or remount shows the same draft, selection, and save state; a
  file part sends its draft (see "What gets saved and sent")

Save round trip:

```
User edits → DiskfileEditorState.current_content setter
  → the file's draft (Diskfiles.drafts, based on the disk content's hash)
Save → save_changes() → app.api.diskfile_update({path, content, expected_hash})
  → ScopedFs::write_file (compares the file's bytes to expected_hash, then
    writes; the response is the written bytes' hash — no content echo)
→ notify watcher fires → Filer updates its index immediately
  → debounced (80ms) filer_change broadcast to all sockets
    → Diskfiles.handle_change → upsert (metadata in place; a held file re-read)
      → diskfile_read lands → DiskfileEditorState.check_disk_changes
        → disk-change history entry
```

The confirmation is the broadcast, not the RPC response — a save and an
external edit look identical to the frontend. The response still gates the
editor: `save_changes()` runs one save per file at a time, and records the
saved entry, clears the modified flag, and takes the response's `hash` as
the next save's base only when the write succeeds — a failure keeps the
edit unsaved and sets `save_error` (a `disk_changed` refusal reads the file
again instead; see "Conflicts" below). If anything moves while
the write is in flight — more typing, another history entry picked, or an
external edit landing after the save's own broadcast — the saved content is
recorded in history but the editor keeps its content and selection, and an
external edit stays the last-seen disk state. Ctrl+S saves the focused
editor; the main `/files` view also takes it from anywhere on the page, the
markdown view included when its preview is shown alone and no editor is
mounted.

**Contents on demand.** A diskfile's content loads when something needs
it, over `diskfile_read` — the only way content arrives: the backend's
disknodes carry metadata alone. `Diskfile.content_status` says where
the content stands: `unrequested`, `loading`, `loaded`, or `unloadable` — a
read found no text (`unloaded_reason`: over 4 MiB, or not UTF-8) or failed
(`content_error`). `Diskfiles.ensure_content` is single-flight per file:
callers share the read in flight, and a change on disk while it's in flight
reads again, resolving with the newer content. Reads queue at most
`DISKFILE_READ_CONCURRENCY` at once (JSON-RPC batches aren't supported),
the selected tab's file first, then the other tabs'. A read never touches
`size` or `mtime`, which stay the index's. What loads content:

- **The editors** — text, markdown, transcript, and file-part editors —
  on view. Until it lands an editor is read-only with a "loading" notice,
  distinct from a file that can't load, and nothing saves
  (`Diskfiles.update` refuses too). The first content to land seeds the
  editing state's original entry: it's how the file was first seen, not a
  disk change, and never a conflict.
- **A `DiskfilePart`** as it attaches (it holds its file —
  `Diskfiles.acquire`), so its content, length, and token counts follow;
  until then a formatted prompt shows a `[loading the content]`
  placeholder for it.
- **The audio view and the recordings page** load the files named like the
  audio's transcript sidecars (`to_transcript_candidate_paths`), holding
  them while shown, whose contents say which audio they were made from.
- **Sending and copying** await what's missing: `Thread.send_message`
  creates the turns and sets `pending` at once, then awaits the history's
  file parts still loading before building the request (a cancel meanwhile
  sends nothing). A part whose read failed (`content_error`) is read once
  more, the send being an explicit ask; if that fails too, it stops the
  send: nothing is sent and the assistant turn shows the error, naming each
  such file and saying to remove the parts or disable their turns to send
  without them. A part whose file can't load as text is sent as a marker
  naming the file and why (`[/home/me/big.log: content not loaded — the file
  is over 4 MiB]`, the path relative only inside the app directory, as the
  XML `path` attribute has it), which is what `Turn.content` holds for it,
  so a turn's copy says it too. The copy entries for a file, part, prompt,
  turn, and thread copy loaded content at once, with no await before the
  clipboard write; content still to load is loaded on click, and a read that
  failed is retried once, as a send does (`load_parts_content`,
  `Diskfiles.load_content`); if that wait cost the click's user activation
  the entry stays open saying "loaded — copy again". A file's and a file
  part's entry never shows for an empty file — known by its `size` before
  its content loads.

A file is held eagerly while it has an editing state or a holder
(`Diskfiles.acquire`, released by `release`): an open tab, a
`DiskfilePart` referencing it, a view reading it (the audio view's and
recordings page's transcript sidecars), its context menu while open
(`DiskfileHold`), or a copy in flight. A hold is by path, so it holds
the next cell at the path too. It doesn't keep a file the index no
longer has (deleted on disk, or uncovered): only a draft or a tab does,
so a part referencing a deleted file finds it missing — though a kept
file whose draft is saved while it's out of the index stays until its
last holder lets go. A path whose last holder lets go is released in a
microtask (`release_if_unneeded`) unless held again first, so an effect
re-running doesn't release it. Only then does a file have a `Diskfile`
cell: every other file is its index record (`DiskfileIndex`,
`get_by_path(path)`), and `acquire` makes the cell from the record. When
a path's last holder lets go, the cell of a file on disk is dropped with
its editing state, unless that has something to keep
(`DiskfileEditorState.can_drop`) — its record stays, and the next hold
makes a fresh cell, its content read again on demand.
`peek(path)` reads the cell without holding or making one. Every
disknode that arrives for a file already held — an `add` or `change`, a
`project_open` index, a reconnect's snapshot entries — re-reads an
eagerly held file, keeping its content until the new one lands so its
editor never turns read-only meanwhile, and drops any other file's
content back to `unrequested`, to load again on next access. A re-read
of unchanged text changes nothing (`check_disk_changes` compares
strings), so a resync raises no spurious conflict.

**Disk changes and drafts.** `Diskfiles` records every content change
in the file's editing state, if it has one — whether or not an editor is
mounted — so a file reopens on the disk content, never text a save would
write back over an external change. A clean editor follows the disk. Editing
keeps one draft per file, updated in place and dated to the latest edit;
editing from another entry picked in the history starts a new draft and sets
the previous one aside as a _discarded_ entry (under the draft's id, so its
history row stays). A draft is based on the disk content it started from
(`base_hash`), and rebased when our own save lands under it (typing
continued past the save) or the user writes over the disk. A draft itself is only ever
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
save**, or **cancel** (the `tab_close` intent answers `asking`;
`DiskfilesEditor.request_close_tab`, `DiskfileCloseDialog`). "Don't save"
discards the draft into the history (`discard_draft`) — for a file deleted
on disk, the file is forgotten with it. The question lapses if the draft
goes away meanwhile (saved or discarded elsewhere), and a cancel during the
save keeps the tab. A reopen shows the draft if there is one, else the disk
content. Unlike VS Code a draft doesn't
depend on its tab — it's app-level — so programmatic closes (`close_tab`,
`close_all_tabs`, a preview tab reused for another file) close without
asking and keep the draft, reachable from the explorer's ● and file parts.

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
model otherwise can't tell a draft from the file. Line endings aren't kept:
a textarea reads a CRLF file's line breaks as `\n`, so its first edit saves
it with `\n` throughout, with no indicator.

**Conflicts.** A disk change under the user's content (the draft, or a
picked older entry) keeps that content and sets `disk_conflict`; a draft
whose `base_hash` isn't the disk's is stale too, even one made before this
editing state (it outlived an earlier one). While the
editor shows content that differs from the disk (`has_conflict`), saving is
paused: Ctrl+S (which moves focus to the notice) and the save button write
nothing, and a notice offers **overwrite with your draft**
(`save_draft({overwrite: true})`) or **keep the disk version**
(`discard_draft`, the draft set aside in the history); either returns
focus to the editor, and both versions are in the history to compare. Its
**show disk version** toggle (while it shows, it reads **show your draft**,
or **show your version** for a picked entry) shows the file on disk in
place of the draft — in the editor, the markdown preview, and file-part
editors alike, read-only (`showing_disk`, `shown_content`): a look, not a
choice. It never changes the draft, the history, what's marked ●, what a
save writes, or what a file part sends — only the views read
`shown_content`; a newer disk change shows as it lands, and in the markdown
view a click on the preview only moves the read-only editor's caret. It
ends with the conflict — however that resolves — when an entry is picked
from the history, or when the file is deleted on disk (so its return shows
the draft), and isn't offered while the file is gone. A disk change equal
to the draft settles the conflict, the content of our own save in flight
landing on disk (our broadcast, with typing continuing past it) resolves
rather than raises a conflict, and a new draft typed on the new disk
content starts clean. VS Code keeps a dirty
buffer on an external change too, but only reports the conflict when saving
("the content of the file is newer", with Compare / Overwrite); zzz shows it
as soon as it lands, since agents and tools write files while you edit, and
keeps both versions in its history instead of opening a diff view (zzz has
none yet). A change on disk arrives as metadata and its content by a read,
so a save first waits for any read of the file in flight or queued
(`Diskfiles.pending_read`) — the re-read a `filer_change` or a reconnect's
snapshot starts — then decides on the content it brought; the save buttons
are busy meanwhile (`save_pending`), and a conflict the wait uncovers takes
the focus (unless the user moved on meanwhile). If the file's last read
failed, the save reads it once more, and refuses ("couldn't check the file
on disk") if that fails too — so short of an explicit overwrite, a change
the frontend was told of is never written over unchecked.

The backend checks too, for the write the frontend hasn't heard of yet. A
read returns the BLAKE3 `hash` of the bytes it read (bare lowercase hex),
and a save sends the hash of the disk content it's based on — the last disk
content the editor recorded (`last_seen_disk_hash`), the same content
`has_conflict` weighs the edit against — as `expected_hash`. `zzzd` stages
the content, then reads the file again and writes only if its bytes still
hash to it; otherwise nothing is written and the save fails `conflict` /
`disk_changed` — a file changed, grown past the 4 MiB a read returns as
text, or gone. The editor then reads the file again (`save_pending`
meanwhile), so the change lands like any other: a conflict under the draft,
its notice saying why the save stopped, or — when the disk now holds what
was being saved — a save that's done. A failed re-read says so in
`save_error`, the draft kept. The response to a save carries the hash of
the bytes it wrote, which becomes the base at once, so a save queued behind
it is based on what it wrote, not on the re-read its broadcast starts.

An overwrite (**overwrite with your draft**) is checked the same way,
against the disk version the conflict showed — the one the user chose to
write over, its `last_seen_disk_hash` taken at the click, so a newer
version whose read lands while the save waits for it doesn't move it. A
newer write is refused and read, and shows as a new conflict rather than
being replaced: the notice stays and takes the focus back (unless the user
moved it elsewhere while the save waited), and `save_error` says the file
changed on disk again, until the disk settles on the draft. When the file's last read had failed
(`content_error`) at the click, there's no version the user can trust as
shown, so the overwrite sends no hash and writes over whatever is there:
the way to force a save. An overwrite queued behind a save in flight takes
its base when it runs, after that save. A save of a file deleted on disk
compares too, expecting it absent: it's an exclusive create, refused if
anything is at the path, so a file something else recreated before the
filer reported it is read and shown, not replaced. Unchecked too: a save of
content that came without a read (seeded from JSON — no app path does).
What remains for every checked save is the gap between the backend's
compare and its rename (or, on the in-place fallback, its truncate): a
write landing in it is replaced unseen. No lock spans another process's
write, so the compare narrows the window to that gap rather than closing
it.

**Cells outlive components.** Svelte owns a `$derived` by the effect running
when it was created and can stop recomputing it once that effect is
destroyed, so app-level state constructed during component init silently
freezes when the component unmounts (and code in `onMount` or an `$effect`
runs inside an effect too). Such state is created with `create_detached`
(`reactive_helpers.svelte.ts`): editing states
(`Diskfiles.get_editor_state`), the `Action` cells `app.api` calls create, the
`App` itself, and the route-cached `Projects` / `Browser`.

The initial file listing comes from `session_load` (the backend rescans and
flattens the index of every permanent filer and every filer the open
projects keep, and lists their roots as `file_roots` — a filer an open or
focus still in flight started isn't listed before its project's change is),
and `project_open` returns the index of every filer of the opened project so
the new tree appears immediately (`repo_focus` and `repo_files` a focused
repo's alone). `Frontend.load_session` runs `session_load` and retries a
failure with backoff (1s doubling to 30s) until it succeeds, tracking
progress in `session_status` / `session_error`; `Projects.open` does the
same snapshot handling for `project_open`. Both record what `filer_change`
reports while their request is in flight (`Diskfiles.track_changes`) and
apply the snapshot around it: a path with an `add`, `change`, or `delete`
keeps what the notification left — its snapshot entry is skipped, so a file
deleted mid-request isn't resurrected and newer metadata isn't reverted; the
change itself re-read or dropped the file's content.

**Reconnect resync.** Notifications sent while the socket is down —
`filer_change`, `project_changed`, `terminal_data`, `terminal_exited`,
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

- **Projects** are reconciled by their rev (`Projects.reconcile`, see
  **The lifecycle rev** under Projects): each listed one applies when it's newer
  than the state held, and a held one the snapshot doesn't list is removed
  — another client closed it — only when what's held of it is no newer
  than the snapshot's `projects_rev`; a held project newer than the
  snapshot keeps its state, and its files aren't pruned, nor the
  snapshot's added where that state doesn't index them (a focus it
  dropped); a listed one closed here since the snapshot was read stays
  closed, and the snapshot's files under it aren't added. After a zzzd
  restart (a new `server_instance_id`), every rev held is forgotten first
  (`Projects.reset_revs`): the new instance's snapshot is the truth,
  whatever revs the old one stamped (if any project state or close
  arrived while the snapshot was in flight — applied, or dropped by the
  old instance's revs — another snapshot follows, since the reset let
  this one win over it). The projects it lost are
  reopened instead of removed, each by one `Projects.open` of its root
  requesting every directory it had focused before the snapshot applied
  (`Project.reopen_paths`) as the open's `focus`
  — reconciling only the focused directories' files, the complete trees
  so far — so their files, tabs, and unsaved edits stay. The project is
  reopened once the open lands on its root. The reply's focus is the
  daemon's, applied by its rev, so a requested focus it refuses
  (`refused`: no longer a present entry, unlistable, or the root no longer
  a registry) is dropped and its files released, except that one that
  couldn't be indexed for a passing cause (`repo_index_failed`) is kept
  for the next snapshot to retry (a snapshot listing the project without
  it retries it too). When
  the open is refused (the root gone or forbidden, the registry unusable)
  or lands on another root, the project and the files only it covered are
  dropped (logged) — files another open root covers stay; when it fails
  otherwise, it's kept and the next snapshot retries it once — there's no
  retry loop. A root that's no longer a registry reopens as the checkout
  or plain directory it is now, its old focus refused. Closing a project
  (`Frontend.close_project`, or another client's close, which arrives as
  `project_changed`) cancels a pending reopen, and a `project_not_open`
  reply removes it here too, so a project the backend forgot can still be
  closed. A close while
  a reopen is in flight sticks: the backend's open scans before
  registering, so the close finds nothing open and the open lands anyway —
  the reopen then closes it again, but only when its own open created the
  project (`opened`) and nothing changed it since. One that merged into a
  project open already, or that a later change reached first, was acted
  on by someone after the close, which stands. Another restart while a reopen is in
  flight queues the project's whole focus again once that reopen settles
  (what it opened was on the instance that's gone, so the rev its reply
  stamped is forgotten too), and after a restart a
  project another client already reopened gets the rest of its focus when
  a retry of it was pending; otherwise the snapshot's focus stands.
- **Files** under a snapshot root, or under a project the reconcile just
  removed, that the snapshot lacks are removed through the same path as a
  `delete` (`Diskfiles.reconcile`), so a file with a draft or a tab stays,
  flagged `deleted_on_disk` — unless the index no longer covers it (its
  repo dropped from the registry or unfocused, its project closed): the
  snapshot doesn't look there, so it's released as a narrowing would
  (§ Projects), kept for a draft or a tab flagged `uncovered`. Files
  outside those directories are left alone — the snapshot says nothing
  about them. The snapshot is metadata,
  so every file held eagerly is read again (the shown ones first) and any
  other loaded file drops its content; one that changed while disconnected
  shows the change, or a conflict under a draft.
- **Terminals** running when the request went out that the snapshot's
  `terminal_ids` lacks become `lost` (`Terminals.reconcile`).
- **Jobs** are replaced with the snapshot's `jobs` (`Jobs.reconcile`): they
  live on the backend, so its list is the truth, and after a restart it's
  empty. A running transcription's preview segments aren't in the snapshot —
  a reload shows the job without them until more arrive.

Changes made while the request is in flight win: paths a `filer_change`
added, changed, or deleted are skipped as above, project state is ordered
by its rev (a project opened, changed, or closed after the snapshot was
read is newer than it), and terminals started meanwhile aren't judged. A completion
whose `completion_create` was in flight when the socket closed is rejected
by the WebSocket client (`service_unavailable` — it can't be correlated
after the reconnect), which settles its turn as errored; the chunks it had
streamed stay. `Diskfiles` upserts by path — for seeds and for both `add`
and `change` — so a path never has two `Diskfile`s. A `delete` drops the
file's editing state and history — unless the file has a draft (edited in
a tab, a file part, anywhere) or a tab: then the `Diskfile` is kept,
flagged `deleted_on_disk` (marked in its tab, the explorer, and the
editors), so saving writes the path back (always allowed while flagged; a
successful save clears the flag right away) and the `add` broadcast
reattaches it (same id). That save is an exclusive create
(`diskfile_create`, `O_EXCL`, recreating missing parent directories),
never a blind overwrite: a delete reported for a file still on disk (a
re-prune) or one recreated unwatched (its project closed meanwhile) makes
it fail (`already_exists`), and the file is flagged `uncovered` and read
again, so the disk version shows as any refused save's does — a conflict
under a draft. A rename arrives as a delete plus an add, so an
open tab stays on the old path, marked deleted, and the new path isn't
opened. It's forgotten once nothing holds it — no
draft (discarded from the editor's notice or a "don't save") and no tab
(`Diskfiles.release_if_unneeded`). A file that leaves the index because its
repo was unfocused isn't deleted: it's forgotten, unless it has a draft or
a tab, which keep it as it is, unflagged (§ Projects); a refused save whose
re-read finds it gone flags it deleted, as for an uncovered one below. One that leaves the
index otherwise — its project closed, its repo dropped from the registry —
isn't deleted either, and may still be on disk: it's forgotten, unless a
draft or a tab keeps it, flagged `uncovered` ("not indexed by an open
project" in its tab, the explorer, and the editors, apart from "deleted").
Saving it isn't forced as a deleted file's is, and sends the hash of its
last read as any save does, so an edit made on disk meanwhile is refused
(`disk_changed`, then a conflict); a refused save whose re-read finds the
file gone flags it deleted, so saving again recreates it. A kept file
under no open root at all (`Diskfiles.is_dormant` — its project closed)
is _dormant_: the daemon would refuse it (`path_not_allowed`), so it isn't
sent. Its tab says "(project closed)", the editors offer **reopen
project** (`Projects.open` on the file's directory, as `zzz <file>` would —
the file may be gone — reconciling the files known there), and the close
dialog offers **keep draft** in place of save. Nothing is lost, and
closing the project doesn't ask first: reopening it reattaches the file
(same id), and its draft is checked against the disk then by its
`base_hash` — stale if the disk moved while it was closed, deleted if the
file is gone (under the directories the reopen focuses; a registry root's
loose file is found gone only when it's next read or saved). It's
forgotten once nothing holds it, as a deleted one is.
The explorer lists either for its draft or tab
(`Diskfiles.listed`); pickers don't (`on_disk`); a `DiskfilePart` shows and
sends the draft, marked deleted only when it's deleted on disk. Tabs, history, and editor state are
UI-session-only — a reload restores only what `session_load` provides.

The index's metadata lives in `DiskfileIndex` (`Diskfiles.index`): one
record per file on disk the index reports (its disknode, keyed by path) —
not the files kept for a draft or a tab after leaving it. It owns what
derives from the records: the folder tree (`tree_index`), how many files
each directory holds and which hold any (`directory_paths`), and so the
markdown link checks (`Diskfiles.link_index`). Reactivity is two counters
and per-path watches: `membership` moves when a file is added or removed,
`meta` when a record changes in place, each at most once per write or
batch, so a whole snapshot moves each once; `get` and `has` subscribe a
reactive reader to that one path, and a write to a path no reader holds
notifies nothing. A `$derived` read outside any effect leaves its path's
watch behind for good, so read `get` and `has` per path only in component
effects or deriveds that live in one, and anything bulk or imperative from
the counters.

The explorer and the file picker stay responsive with tens of thousands of
files: their `SortableList`s are `windowed`, rendering only the rows in or near
the scroll viewport (every row the same, measured height) with padding standing
in for the rest, and re-sorting from the previous order (`sort_with_hint`), so
a file added or removed doesn't pay for a full sort. Both list the index's
records, not cells (`Diskfiles.on_disk`, and `listed`, which adds a record
made from each file kept for a draft or a tab), and their rows take a path
(`DiskfileListitem`), so a row looks its cell up only for its status and its
menu's content entries. Their orders go by the metadata on disk — the size
in bytes, `mtime`, and `ctime` — so a file of unknown size or time goes last
in both directions, and equal values tie by path (every `sort_by_text` and
`sort_by_numeric` breaks ties by `id`). The picker also filters by path
(case-insensitive substring). Rows scrolled out of range unmount, so focus
on one is lost when it scrolls away.

**The explorer's two modes.** The files page's explorer (`DiskfileExplorer`)
shows the same files as a flat, sortable list (`DiskfileList`) or as a
folder tree (`DiskfileTree`), switched by the folder toggle in its header
(`DiskfilesEditor.explorer_mode`); the sort controls belong to the list, and
"collapse all" to the tree. The tree has one top row per indexed root — the
app directory, each scoped directory, each open project's root — labeled
with the root's path, and under it folders before files, each sorted by name
(case-insensitive, numbers by value), with names relative to their folder. A
chain of folders that each hold only the next shows as one row, `a/b/c`,
expanded or collapsed as one, and expanded only while every folder in it is,
so a row that joins a folder below it (`x` and `a/b` become `x/a/b` when
`x`'s other files go) never opens one the user didn't. Folders come from the
files (`DiskfileIndex`, kept in step as files come and go), so an empty
folder doesn't show — except one created from the tree, which it keeps until
a reload (`DiskfileTreeState.created_dirs`; one deleted meanwhile by another
program lingers until then too); a root nested in another shows under it as
a folder holding the same files, once it holds any, and those files stay in
the outer root after the nested one closes — unless the outer root's walk
never enters it (the app directory, whatever its name; what the root's rule
skips — `to_unindexed_part`: a `.git` or other always-ignored name, a
`.zzz-tmp-` staging name, and `node_modules` and the other fixed names, or
under a focused git root what git ignores or a repo of its own (`nested`)),
where it shows only as its own root. Under a focused git root a tracked
`dist/` shows. A file deleted on disk or uncovered but kept for its draft or
tab stays in its folder, marked like in the list. The expanded folders live
on `DiskfilesEditor.tree` (`DiskfileTreeState`), so they survive a switch to
the list and back. The tree is one flat, windowed list of its visible rows,
and deriving them walks only the expanded folders, so a large index costs
what is open, not what is indexed. Keyboard: Up and Down move, Right expands
a folder or moves into it, Left collapses it or moves to the parent, Home
and End jump, Enter opens a file in a permanent tab, Space previews it, and
either toggles a folder; the ContextMenu key (or Shift+F10) opens the active
row's menu. Focus stays on the tree, which names the active row by
`aria-activedescendant`, so it survives the row scrolling away. A click
previews a file, a double click opens it, and a click toggles a folder. A
registry's repos that aren't focused show as lazy rows that expanding
focuses (§ Projects).

**The explorer's contextmenus.** A file's menu (`DiskfileContextmenu`, on list
and tree rows, tabs, and the file views) copies the file's absolute path, its
path relative to the innermost indexed root holding it (the same from any row
showing it, `to_diskfile_copy_paths`), and its name; opens a terminal in its
folder, unless the file is deleted on disk (a shell with that `cwd`, shown on
the terminals page and named by its folder, since it runs no command); and, on
list rows and tabs, reveals it in the tree (`DiskfilesEditor.reveal_in_tree`:
switches the explorer to the tree, expands its folders, makes its row active,
and scrolls to it). A folder or root row's menu (`DiskfileDirectoryContextmenu`)
creates a new file or folder inside it, opens a terminal there, expands every
folder below it or collapses them, and copies its path, relative path, and name
— a root only its path. Expanding skips the folders the rows never show, and
past `EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT` files below (counted from the index's
links, not walked) asks first: every file then shows, and each file change
under it rederives them all — an unfocused repo isn't focused by it. A
compact row acts on its innermost folder. A registry's focused repo's menu
also unfocuses it; an unfocused repo's lazy row has a "repo" menu instead —
focus it, open a terminal there, copy its path. Rename, move, and deleting
a folder wait on backend actions.

**Creating in the tree** names the new file or folder inline, VS Code style:
an input (`DiskfileTreeCreateInput`) shows as the folder's first child,
expanded first; in tree mode the header's create buttons open it at the
active project's root row. Enter creates and Escape cancels, both returning
focus to the tree unless the user has moved it elsewhere meanwhile; the tree
leaves every key typed in the input to it, and its own arrows pass over the
input's row. Leaving the input creates a valid name and drops a blank or
refused one (a name the backend already refused isn't sent again), but not
when the whole window lost focus or the row scrolled out of the window — the
name being typed lives on the state (`DiskfileTreeState.creating`), and the
input refocuses when it remounts with focus lost — if focus went elsewhere
meanwhile, it's dropped instead. An input is dropped too when its folder
stops showing (collapsed, emptied, its root closed) or the tree goes (a
switch to the list). A name's problem shows under the row as it's typed,
announced politely, except a file name's trailing `/`, a step on the way to
`sub/x.md`; a refused commit's shows the same place as an alert. The box
sits over the rows below — they keep one height for windowing — and lets
clicks through. A `/` in the name creates the folders on the way. A new file
opens in a permanent tab and is revealed in the tree, now or when its
`filer_change` arrives, unless another input has opened meanwhile; a new
folder is revealed and expanded. What the file index skips
(`Diskfiles.to_unindexed`, by every holding root's rule: any part with an
ignored name, such as a folder `node_modules` on the way under fixed names,
or a `.zzz-tmp-` name; under a focused git root a path git ignores or a repo
of its own) is created but never shows, so a note says why — the name it
skips, the path git ignores, or the repo — kept in view at the top of the
tree until it's dismissed, the next key in the tree, or the next create —
not a click, which would shift the rows under a double click — and a file
there isn't waited for. Any file this client creates
(`Diskfiles.create_file_at`) is revealed the same way, an audio or
transcript view's "edit a copy" included.

## Projects

Directory scoping on top of the Filesystem section's "two separate
concerns":

- **Project** — the root a path opens, which the server
  serves and indexes in part. `project_open` takes a file or directory and
  resolves its project on a blocking thread (`crates/zzz_server/src/project.rs`,
  `resolve_project` — a file opens its parent):
  1. **A registry** — a `repos.toml` found walking up by `fuz_repos`'s
     discovery, rooted where a link above a checkout names it (so
     `~/dev/repos.toml`, a link to a copy in one of its repos, roots at `~/dev`),
     else at its own directory. The walk stops below `$HOME` (or within
     the allowlisted root holding the path), and a candidate must be
     trusted — the file and every directory from it up to `$HOME`, that one
     included, owned by the daemon's user or root, never `o+w`, and `g+w`
     only by the user's private group (Debian sshd's rule,
     `file_trust.rs`; the owner is read once at boot) — and, when a
     symlink, confined to the root it would make. Any candidate that fails
     refuses the open with its reason (`registry_untrusted`,
     `registry_not_confined`, `registry_changed`, `registry_unreadable`,
     `registry_invalid`) rather than being skipped, since a skip would widen
     the root to a registry further up — unless it's kept inside a
     checkout (below). Each entry is canonicalized and confined to the
     root: one that escapes it, is protected, can't be resolved, isn't a
     directory, or is in a git dir (an entry named `.git`) is refused alone
     (`entry_not_confined`, `entry_in_git_dir`, …), and one not yet cloned
     is `missing`. The registry roots the project when the path is in one
     of its present entries, or is its root or outside it (a linked
     worktree) — unless no entry is present and the root is a checkout; a
     path under its root in no present entry falls back, as do the root of
     a checkout with no entry present and a linked worktree of it, so a
     root has one kind whichever path opens it. A path under a `.git`
     component opens as the directory holding the outermost one.
  2. **A git checkout** — the nearest directory at or above the path, inside
     the same bound, holding a `.git` that is itself a directory or a
     regular file (a linked worktree's), by `lstat`; anything else named
     `.git` is ignored — a symlink too, whatever it points at, so a
     directory whose `.git` is a symlink is no checkout. Rule 1's
     discovery reads a checkout the same way, runs no git in a directory
     whose own `.git` is a symlink, and stops git's own search (which
     passes over a `.git` it can't use and walks on up) below the nearest
     symlinked `.git` above where it runs, so no git call goes through a
     symlinked `.git` to a git dir elsewhere — never followed, as
     `ScopedFs` refuses symlinks. A registry in a directory whose own
     `.git` is a symlink opens as a registry rooted there, where the
     `repos` CLI refuses that root (`root_git_symlink`): zzz never clones,
     so the sync that refusal guards against can't happen.
  3. **The directory itself.**

  **Fallbacks** — a registry found by rule 1 that doesn't root the project
  hands it to rules 2 and 3 and is reported as the project's `fallback`
  (`{kind, registry_path, reason?}`, on the reply, `project_changed`, and
  `project_list`):

  - `unregistered` — the path is under the registry's root in none of its
    present entries (`~/dev/scratch`, a checkout `~/dev/repos.toml`
    doesn't list), or is the root of a checkout holding the registry with
    no entry present (a repo's own `repos.toml`, nothing cloned), or is a
    linked worktree of that checkout outside the root, which opens as its
    own checkout (the one rule 2 alone would find). Otherwise its checkout
    is looked for at or below the root, never above it, and strictly below
    it when any entry is present: a root
    holding clones is a workspace that a checkout there would index whole.
  - `registry_refused` — a registry kept inside a checkout (the nearest
    one, with no link above its checkout naming the same file) that is
    untrusted, unconfined, protected, unreadable, or invalid, carrying that
    `reason`, falls back to a checkout holding the path at or below the
    registry's own directory — what the open would root at without the
    file. A registry outside any checkout, one a link above names (that
    link would have rooted the open), one whose checkout is above its
    directory (falling back would widen), and one replaced mid-open still
    refuse. A root inside a checkout of one of its own entries falls
    back the same way, at or below its own directory — or, from a linked
    worktree outside it, that worktree's own checkout, the one rule 2 alone
    would find (`registry_root_in_entry`).

  No fallback widens: each root is at or below the root the registry
  would have made, or, from a linked worktree outside it, the worktree's
  own checkout, and nothing read from the registry passed over decides
  it but a root-in-entry registry's entries.

  The opened directory and the root must both pass the root rules (§ Root
  scope) and lie outside every protected directory. The open **focuses** the
  repo holding the path — the deepest present registry entry containing it,
  or a checkout's or directory's root; opening a registry's root itself, or
  a linked worktree outside it, focuses nothing. Focus is daemon-wide; each
  open of a path in another repo adds its focus (`project_changed`
  `update`), and `repo_focus` / `repo_unfocus` add or drop a registry's
  present entries one by one without resolving the registry again. A focus
  lasts until it's unfocused, the project closes, or a later open finds its
  entry gone; a checkout's or plain directory's root is its one focus while
  it's open (`project_not_registry`), and a registry may keep none, as
  opening its root alone leaves it. An open may also request more focus
  (`focus`, the shape a reopen after a restart takes): each requested
  directory is checked against the fresh resolve as a kept focus is (a
  present entry; a checkout's or plain directory's root lands, anything else
  on one is `project_not_registry`) and lands or is refused alone, reported
  in the reply's `refused` with the code `repo_focus` would refuse it with
  (`repo_not_in_project`, `repo_not_present`, `permission_denied`, or
  `repo_index_failed` for a listing that failed otherwise). A focused
  directory gets a whole-tree filer; a registry's root gets one at its top
  level alone (its loose files) — an unfocused repo and an unregistered
  directory under it aren't indexed by the registry's project (an
  unregistered directory opened by a path in it is its own project, indexed
  whole), so a root of hundreds of thousands of files costs only what's
  focused. Filers are keyed by canonical path, so two entries resolving to
  one directory share one. The root is one `ScopedFs` root, writable whole.

  The filers start before the project manager's lock is taken (the root or
  the path's own focus that can't be listed fails the open, with nothing
  registered, while a requested focus that can't is refused alone; and
  concurrent opens of one path share a scan), then, under the lock, the
  project is recorded — merged into an open one with the same root: the
  fresh kind, entries, and `fallback` (why it's rooted there now — a change
  counts as one, stamping a new rev), the union of the focus that the fresh
  resolve still supports (a present entry's dir, or the root of a checkout
  or plain directory; a whole-tree filer on a root now indexed at its top
  level is replaced by a top-level one) — the filers re-ensured, the root
  added to `ScopedFs`, and `project_changed` broadcast (`open`, or `update`
  when an open project changed) — one commit and one notification for the
  open and every focus it requested. Each requested focus's filer is ensured
  again under the lock before the commit, so one stopped since its scan (a
  racing unfocus or close) is refused alone rather than failing the commit.
  The reply carries the project, the open's `focus`, every filer's files
  (each requested focus that landed included), the `watch_status`, and
  `refused`. `repo_focus` checks the entry is present as the project's last
  resolve left it (`repo_not_in_project`, or `repo_not_present` for one not
  cloned or refused), starts its filer before the lock, then under it
  records the focus, re-ensures the filers, and broadcasts `update`,
  replying with the project, the focused repo's files alone (the rest of the
  project is the client's already), and the project's `watch_status`;
  focusing a focused repo changes and broadcasts nothing. `repo_files` reads
  a focused directory's files under the lock, so it never sees a filer a
  commit has stopped or narrowed but not yet published, refusing a root that
  isn't open (`project_not_open`) and a directory the project doesn't focus
  (`repo_not_focused`) rather than answering with no files, as an empty repo
  would. `repo_unfocus` drops the focus under the lock and releases its
  filer as an open's narrowing does — stopped unless another open project
  keeps it, narrowed to a top-level one if that's all one keeps (a nested
  registry's root) — then broadcasts `update`. `project_close` reverses an
  open, stopping the filers no other open project keeps and narrowing a
  whole-tree one another keeps at its top level alone — except that the
  boot-time app directory and `PUBLIC_ZZZ_SCOPED_DIRS` keep their permanent
  filers and `ScopedFs` roots, so closing a project that overlaps one never
  revokes its access. Backend state is an in-memory map — a restart forgets
  all projects, and clients reopen the ones they had when they resync after
  reconnecting (see **Reconnect resync** under File Editing). Scoped dirs
  aren't listed as projects: they're the operator-configured always-on
  layer; projects are the user-opened runtime layer. A scoped dir (or the
  app directory) can still be opened, and closing it leaves its permanent
  access in place.

One open project is the **active** one on each client (`Projects.active`):
new files and folders default into it (`Project.new_files_dir` — its
last open's focus while that's still focused, else its root).
`DeskMenu.svelte` lists the open projects to switch it. Opening happens on
`/projects`, the projects page, from its open form or the `?open=<path>`
query param — this is how the CLI's `zzz <path>` lands the browser there.
Both run `project_open`, activate the project it returns, and then open a
file the open indexed in a tab on `/files`; a directory, or a file the
index skips, leaves the page showing where it landed. Both take an
absolute path or one starting `~` or `~/`, expanded to the daemon's home
(`session_load`'s `home_dir`; the param waits for the session) — `~user`
is refused. The query param is handled once and then stripped from the
URL, so a reload doesn't reopen a project the user has since closed. The
page lists each open project with its kind, and a registry's registry file
and each of its entries: a present one with a button to focus or unfocus
it and its git status (§ Repo status below), a missing or refused one with
why.

**The lifecycle rev.** Every change to the open projects — an open that
changed something, a focus, an unfocus, a close — bumps the daemon's
project rev and stamps it on the project it changed (`ProjectInfoJson.rev`;
a close's on the closed project), so every reply and every
`project_changed` carries the rev its state was committed at:
`project_open` and `repo_focus` and `repo_unfocus` with the project,
`project_close` as `{rev}`, `repo_files` as the project's rev when it read
the index, and `session_load` as `projects_rev`, the rev its projects were
read at. The counter starts at the clock (microseconds since the epoch),
so revs keep increasing across a restart; they stay under 2^53, exact as
JSON numbers. A reply's files are read under the lock its change committed
under, so they're the index of exactly the state its rev names.

**Ignored paths on the wire.** Each project carries, for each focused
directory whose filer is on git's rule (§ Filer), what git ignores there
(`ProjectInfoJson.ignored`, keyed by the directory): `paths`, relative to it
and sorted — a directory git prunes whole with a trailing `/` (the directory
itself as `./`), a file it skips alone without — `nested`, the directories
the filer leaves unindexed as repos of their own (a nested repo, a
submodule, populated or not — git's paths never name them), relative,
sorted, each with a trailing `/`, and `resyncs`, a count. A focused
directory on fixed names has no entry, and neither has a registry's root
(indexed at its top level, on fixed names); a permanent filer's set (the app
directory, a scoped dir) is on the wire only while an open project focuses
its directory. Every commit reads the sets from the filers under the lock,
so a set that moved is a change of its project like any other, stamping a
new rev, and a reply carries the set its rev names. A filer whose set
changes on its own — a `.gitignore` or `info/exclude` edit re-pruning it, a
new file vetted as ignored, a `.git` appearing in a directory (one removed
is seen at the next rescan) — asks for that commit itself
(`refresh_ignored`, from a task of its own, at most once a second per filer,
since each refresh resends every changed project's whole set to every
client), once the step that changed it is done, so a refresh after a
re-prune reads the index that re-prune left. A re-prune that would send more
than 1024 `filer_change`s for one focused directory (un-ignoring a
`node_modules/` would be tens of MB to every socket) sends none and bumps
`resyncs` instead, dropping their pending changes too.

The client reads the sets as each root's rule (`Project.ignore_rules`,
merged in `Projects.ignore_rules`): one predicate, `to_unindexed_part` in
`diskfile_helpers.ts`, decides what the index skips for markdown links, the
file tree, the create notice, and whether a created file is waited for. The
daemon indexes the union of its filers, so a path is skipped only where
every root holding it skips it (`to_innermost_unindexed_part`; a registry's
root holds only its direct children), each by its own rule — git's paths and
nested repos for a focused directory with an entry (each folder prefix and
the path itself looked up in a set, never by the daemon's sort order), fixed
names for every other root — and the always-ignored names under both: a
`build/` git ignores in a checkout that a plain directory around it also
indexes reads as indexed. The names are copies of the filer's
(`FILE_INDEX_ALWAYS_IGNORED_NAMES`, `FILE_INDEX_PLAIN_DIR_IGNORED_NAMES`),
which a test holds to its Rust source. A refresh replaces `ignored`, so
links, the tree, and the notice follow it.

`Projects` applies project state from the daemon by one rule, whatever
order replies and notifications arrive in — this client's own
`project_changed` reaches it before its own reply, an HTTP reply can trail
a notification, and two clients' changes interleave:

- A held project takes a state only when its rev is newer than the one
  held; an older state is dropped whole, its reply's files with it (a
  reply's files are applied only when its state is the one held).
- A close older than the state held — the project opened again since —
  changes nothing. Any other leaves a tombstone, `(root, rev)`, and
  removes the project if held, releasing its files the index no longer
  covers as a narrowed state does (below): a root not held is added only
  by a state newer than its tombstone and than the last snapshot's
  `projects_rev` (state at or below it is one the snapshot saw). A
  snapshot that lists a root closed here after it was read leaves it
  closed and doesn't add its files.
- A newer state that narrows — drops a focus, a kind change included,
  since a checkout's or plain directory's one focus is its root — releases
  the dropped directories' files here (`Diskfiles.release_uncovered`),
  since stopping a filer deletes nothing on clients: a file still indexed
  (another focus, another root, a registry root's loose files) stays; one
  in a present but unfocused repo is forgotten unless a draft or a tab
  holds it, kept as it is — not flagged deleted, since it's still on disk —
  until the repo is focused again or nothing holds it; any other (its
  entry out of the registry or missing, under a root become a registry's,
  or under a closed project's root) is kept flagged `uncovered` (§ File
  Editing). A repo that leaves the registry or goes missing releases its
  files too, focused or not.
  A kept file isn't watched meanwhile, so a change on disk shows only once
  the repo is focused again, or as a conflict when it's saved: an
  uncovered file's save sends the disk version it was based on
  (`expected_hash`), and a deleted file's creates it exclusively, refused
  if it's there.
- A newer state that widens — a project new here, opened elsewhere
  (another tab, `zzz <path>`), or a focus added elsewhere — arrives
  without its files (a filer's initial scan broadcasts nothing). What it
  needs is held pending, each directory with the state's rev, until no
  open or focus of this client's is in flight; an applied reply at or
  after that rev that carries the directory settles it. Then each repo
  still focused is pulled alone (`repo_files`, reconciled under the repo as
  a focus's reply is), and a project new here resyncs the session. A pull
  of an earlier focus than the one held — across an unfocus and a focus
  again — is dropped, as is one the daemon refuses as `repo_not_focused`
  or whose focus is gone here: the change that dropped it settles it.
- A newer state whose `ignored` entry for a directory focused before and
  after has a different `resyncs`, or came or went (a git root falling back
  to fixed names), marks a re-prune whose changes weren't sent
  (`is_resynced`): the directory goes pending like a new focus, settled by a
  reply carrying it or pulled once nothing is in flight — a checkout's root
  too, pulled rather than resyncing the session — and the pull reconciles it
  whole, pruning what's now ignored and adding what no longer is. The
  resync's rev becomes the directory's focus rev, so a pull read before it,
  of the index it replaced, is dropped like one of an earlier focus, in
  whatever order the pulls land. A change of the paths alone pulls nothing:
  a re-prune under the threshold sent its changes, and a file vetted as
  ignored was never indexed.

`Projects.focus_repo` applies its reply like an open's, reconciling the
repo's files (a draft kept while it was unfocused whose file is gone is
flagged deleted then); `Projects.unfocus_repo` applies its reply by the
same rule, so a reply older than another client's later focus of the repo
neither drops that focus nor releases its files.

The file tree shows one root row per open project's root, and under a
registry's root its present entries from the project (`Projects.repos`),
not from the index: a focused repo as a folder row, an unfocused one as a
dimmed lazy row with nothing under it, which expanding — Right, Enter,
Space, a click, or its menu's "focus repo" — focuses
(`DiskfileTreeState.focus_repo`), turning it into its folder row, expanded.
A missing or refused entry isn't shown (the projects page says why). A
repo's folder is always a row of its own, never part of a compact one, so
its row keeps its identity as it's focused or unfocused. A focused repo's
folder menu unfocuses it. A restart's reopen restores every focus however
it was made, in one `project_open` of the root with each focused directory
in its `focus`.

**Repo status.** The projects page shows each present registry entry's git
state from local refs — the branch when it isn't the followed one, an
operation in progress, uncommitted counts, distance from origin, stashes —
read as `repos status` reads it, no fetch (`project_status`,
`crates/zzz_server/src/repo_status.rs`). A poll never waits on git: it
answers with what the daemon knows and starts probes of the stale entries,
so the page (`RepoStatusPoll`) polls while it's shown and the tab is
visible, faster while a probe runs. An entry is stale when something under
its `.git` moved (refs, HEAD, an index, the stash, the config — a stat
stamp, no git run), when its focused checkout's filer broadcast a change
(editing a tracked file moves nothing under `.git`; at most every few
seconds), when it was never probed, on a refresh, or — one per poll — when
its status is past the sweep age, which is how an unfocused repo edited by
another program catches up. A "refresh status" button re-probes every
entry at once; a failed poll shows its error above the list. The status
line of a present repo uses `repos status`'s words, the reasons `repos
sync` would leave it to a person included. Only registry projects have status; the daemon
holds each registry's resolved entries while it's open, set and dropped
under the projects lock with the open and close.

## Auth gate

The about and docs routes are public: they render (and prerender) without
a session or a backend, so a static-only build still shows them. Every
other route sits behind the root layout's auth gate
(`src/lib/auth_gate.ts`) — a bootstrap or login form, or, when no zzz
backend answers `/health`, a page saying the route needs the zzz daemon. A
login or bootstrap returns to the page it replaced (path, query, and hash).

## Security posture

zzz is a single-operator local app: one person, their own machine, the daemon
running as their OS user on loopback. Accounts and the auth stack keep other
OS users' processes and other browser origins out — not same-user processes,
which can read `~/.zzz/.env` and the bootstrap token — and they don't separate
accounts from each other.

- Every session and every full-scope API token effectively has the daemon OS
  user's powers (a method-scoped token is limited to its listed methods):
  terminals (a shell as that user), `project_open` of any directory the root
  rules admit — strictly inside `$HOME`, or allowlisted in
  `ZZZ_ROOTS_OUTSIDE_HOME`, and never `/`, `$HOME` or an ancestor of it, or
  `/proc`, `/sys`, `/dev` (see § Root scope) — which makes the root it
  resolves to writable and scans what it focuses, and file reads and writes
  anywhere in scope but the protected directories (credential directories
  and `.zzz` directories other than the app dir; the file actions, and the
  byte routes at `/api/files/bytes`, which a method-scoped token can't use
  at all). So the file API can't reach `~/.ssh` and the other credential
  directories, the daemon's own `/proc/<pid>/environ`, or a root over the
  whole home or filesystem unless the operator allowlists a directory for it
  — a smaller reach and a guard against mistakes, not a boundary: a terminal
  is still a shell that can read all of them.
- The daemon's own git calls (resolving a project, the ignore rule,
  `project_status`) never run hooks, an fsmonitor, or background
  maintenance, but `project_status` runs `git status` in each present
  registry entry, which runs the clean filters a repo's config defines on
  files whose stat changed — the same exposure as `repos status` or a
  git-aware shell prompt. Only the registry's resolved, confined entries
  are probed, never an unregistered directory.
- Terminal output and control — and jobs — are scoped to the account that
  created them, and a deleted or purged account's terminals are closed and
  its jobs cancelled — but that
  isn't a security boundary: any account can open its own shell.
- Revisit — role-gating the `terminal_*`, `project_*`, and file actions —
  if multi-account use ever matters.

Only zzz's own UI can drive the daemon from a browser. The session cookie is
`HttpOnly; Secure; SameSite=Strict`, which keeps other sites' pages out but not
pages on other `localhost` ports, so every request, the static frontend and
an unrouted path included, also passes three gates — each behind a body cap,
so a request declaring a `Content-Length` over its route's cap is a 413
whatever else is wrong with it (`crates/zzz_server/src/router.rs`):

- **Origin** — a request with an `Origin` must match `FUZ_ALLOWED_ORIGINS`
  (403 `forbidden_origin`), on the WebSocket upgrade too. A request without
  one passes (a non-browser client, or a same-origin `GET` such as a media
  element's `src`).
- **Host** — `Host` must be loopback (`localhost`, `127.0.0.0/8`, `[::1]`, at
  any port) or named by an allowed origin (403 `forbidden_host`). This stops
  DNS rebinding: a page that re-points its own domain at `127.0.0.1` talks to
  `zzzd` same-origin, sending no `Origin`, but its `Host` is its domain.
- **CORS simple requests** — a `POST` with no `Content-Type`, or a form or
  text one, is refused (415 `unsupported_content_type`). A browser sends those
  cross-origin without a preflight, and same-site ignores the port, so a page
  on another `localhost` port would carry the session cookie. Any other type
  makes the browser preflight first, and `zzzd` answers no preflight, so the
  request is never sent. JSON calls send `application/json` and byte uploads
  `application/octet-stream`.

`src/test/cross_backend/browser_gates.cross.test.ts` pins them.

`zzzd` can't tell which process serves an allowed origin — it trusts whatever
page is there. So the allowlist names only origins that are zzz's own:

- **Production** — `zzzd` serves the UI itself (`--static-dir`), so the
  allowed origins are its own, `http://localhost:<port>` and
  `http://127.0.0.1:<port>` (the CLI's default, and `.env.production.example`):
  the page comes from the process that checks the list. `zzzd` binds
  `127.0.0.1` only; a browser reaches it as `localhost` by falling back from
  `[::1]`. So the `localhost` name is `zzzd`'s only while nothing else listens
  on `[::1]` at that port: a process bound there is what the browser reaches
  first as `http://localhost:<port>`, an allowed origin, and it is sent the
  session cookie.
- **Development** — Vite serves the UI at `http://localhost:5460`, the one
  origin `.env.development.example` allows. `vite.config.ts` pins the port
  with `strictPort`, so Vite fails to start rather than move to a port `zzzd`
  refuses, and the port is zzz's own, not Vite's default — a default port is
  the one another project's dev server holds whenever zzz's doesn't, and a
  `zzzd` that allowed it would take that project's page for its UI. This makes
  the origin zzz's in practice, not by construction: any local process can
  bind `5460` while zzz's dev server is down. Only `localhost` is listed —
  Vite binds what that name resolves to, often `[::1]` alone, so
  `http://127.0.0.1:5460` may be another process's page. `vite preview` is
  pinned to `5461`, which is allowed only when listed.
  `src/test/cross_backend/dev_origins.cross.test.ts` runs a backend on the
  template's list.
- **Another origin** goes in `FUZ_ALLOWED_ORIGINS` (it replaces the list). A
  port wildcard (`http://localhost:*`) lets every page served on any local
  port act with the session, and a host wildcard (`https://*.example.com`)
  every page on a matching host, which the `Host` gate then answers to as
  well; `zzzd` refuses to boot on either unless `FUZ_ALLOW_ORIGIN_WILDCARDS=true`
  is set, which boots it with a warning for each, and refuses to boot on a
  malformed entry. A plain `http` origin that isn't loopback passes
  the gates but can't hold a session: the cookie is `Secure`, which a browser
  accepts only over `https` or on loopback.

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

## Known Limitations

- **WebSocket auth** — Auth is enforced at upgrade time — the spine resolves
  credentials from the request headers (cookie sessions, bearer tokens —
  bearer silently discarded in browser context via Origin/Referer defense)
  before upgrading and re-reads them once the connection is registered, before
  admitting it. Per-action auth checks enforce spec-level auth: `keeper`
  requires `daemon_token` + keeper role; `{role}` requires a global grant of
  the named role (matches the HTTP path). Batch JSON-RPC is rejected (not yet
  supported). Sockets are closed on session/token revocation, logout, and
  password change via audit events — `token_revoke` closes only the revoked
  token's sockets (granular), `logout` / `session_revoke_all` /
  `token_revoke_all` / `password_change` close all sockets on the account
  (logout included, per the fuz_app contract — so another tab's logout closes
  this tab's socket while its session stays valid). RPC revocations close
  sockets only after their transaction commits. An expired session's sockets
  are closed by the auth cleanup, within one cleanup interval of the expiry.
  An account holds at most 50 sockets
  (`fuz_realtime::DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT`); one more closes its
  oldest with 4004. A socket closed with 4004 stays closed until the user
  reconnects — reconnecting would close a newer socket in turn — so the
  frontend never reopens it on its own (`Socket.superseded`) and shows a
  notice saying why, with a reconnect button. No per-message session
  revalidation. ActionPeer itself has no auth awareness. On the frontend, a
  revoked socket, an `unauthenticated` RPC error, or repeated failed
  reconnects (a browser can't see an upgrade's 401) trigger a session recheck
  (`src/lib/session_recheck.ts`); only a definitive 401 from the account
  status route drops the App and shows the login gate, so a daemon restart
  doesn't log anyone out. A recheck that finds the session still valid after a
  revoked close reconnects the socket (`Socket.reconnect_revoked`).
- **Bearer auth soft-fails** — bearer resolution soft-fails for
  invalid/expired/empty tokens (no early error response). Auth enforcement
  happens downstream via the per-action auth checks, producing `{code: -32001,
  message: "unauthenticated"}` JSON-RPC errors. Public actions are not blocked
  by bad bearer credentials.
- **Domain state is in-memory** — auth/accounts are in the PostgreSQL DB, but
  zzz domain state (files, terminals, projects, jobs) is in-memory, lost on
  restart — a running transcription included, though the transcripts already
  written are files and stay. The frontend resyncs after every reconnect (a
  restart included): it reloads `session_load` and reconciles — projects the
  daemon no longer has are dropped (after a restart they're reopened instead,
  focus and all, and dropped only if the reopen is refused or lands on
  another root), files it no longer
  indexes are pruned (a file with a draft or a tab stays, flagged deleted
  on disk, or `uncovered` when the index no longer covers it — dormant if
  no open root holds it), and running terminals it doesn't list become
  `lost`. Notifications
  sent while the socket was down aren't replayed, so terminal output from that
  window is missing (the terminal view says so). See § File Editing.
- **16 MiB messages** — a JSON-RPC message is capped at 16 MiB on both
  transports (`RPC_MESSAGE_MAX_BYTES`: the `/api/rpc` body limit and the
  `/api/ws` message limit). The server closes the socket on an oversized
  WebSocket message, so the frontend's `Socket` refuses any request over the
  cap before sending (`invalid_request`, `data.reason` `payload_too_large`;
  `src/lib/rpc_message_limit.ts`) — a huge save or a very long completion
  history fails cleanly instead of dropping the socket. Saving any file
  `diskfile_read` loads (at most 4 MiB) fits, except in the worst case: JSON
  escapes a control character to 6 bytes, so a file dense with them can
  exceed the cap, and that save is refused the same clean way. The cap isn't
  confined to authenticated callers on HTTP (see ../crates/CLAUDE.md), which
  is acceptable only because the bind is loopback
- **32 MiB outbound queue per socket** — what the server has queued for a
  WebSocket and not yet written is bounded at 32 MiB
  (`WS_OUTBOUND_QUEUE_BYTES`); past it the server closes the socket (code
  4005) instead of holding more, and the frontend reconnects and resyncs like
  after any drop. Every frame is small — a `filer_change` carries a file's
  metadata, not its text — so the budget is how far a burst can get ahead: a
  change across a tree (a `git checkout`) queues one frame per file. A batch
  of file changes is sent with a yield after each, so each socket's writer
  can take a frame before the next is queued — a client that keeps up gets
  the batch frame by frame, and one that falls more than the budget behind
  is closed like any other.
  Terminal output is paced instead (see Terminal output pacing below), so a
  terminal that prints faster than the browser takes it slows down rather than
  closing the socket; a client that doesn't ack output (not zzz's UI) isn't
  paced, and falling more than the budget behind closes its socket — the
  terminal keeps running (see ../crates/CLAUDE.md)
- **Terminal output pacing** — the UI acks terminal output as it consumes it
  (`terminal_ack`, batched): once a view's emulator has parsed it, or as it's
  buffered with no view mounted (./fuz_terminal.md; § Terminals has the
  details). The backend stops reading a terminal's PTY while more than 1 MiB
  of its output is unacked, resuming at 256 KiB — the kernel then blocks the
  process in its write, as a slow local terminal would. Input, resize, and
  close still work while it's blocked. So a flood (`cat` of a huge file,
  `yes`) runs at the speed the browser parses it — drawing is separate, at
  most once per animation frame, and skips the frames in between — and a tab
  in the background, where the browser throttles timers, may slow such a
  process further. A terminal is paced only against connections that have
  acked it and are still open, and against the fastest of those; a client that
  never acks (a raw API client) gets the output unpaced. So the UI announces
  each terminal's position — an ack sent at once — when its process starts,
  which paces a new terminal from its first byte, and again with the first
  chunk after each socket connect, holding its acks until then: a position
  consumed before the connect is behind the output sent while the socket was
  down, which never arrives, so acking it could leave the terminal paused for
  good. Between a reconnect and that announce reaching the backend — about a
  round trip after the first chunk — the output is unpaced. Output for a
  terminal this tab doesn't show — another tab's, or one left running by a
  reload — is dropped unacked, so a flood from one closes this tab's socket
  once it falls the outbound budget behind, and again after each reconnect
  while the flood lasts. Nothing times a stalled client out: a tab that stays
  connected and stops acking (its JavaScript frozen) keeps the terminals it
  alone shows blocked until it resumes or its socket closes
- **Unloadable files are read-only** — a file's content loads only when it's
  UTF-8 text up to 4 MiB the backend could read; any other file is
  `unloadable` (`Diskfile.content_status`). The editor shows it read-only and
  empty with a "content not loaded" notice, saying why when the read did (no
  stale earlier text, no copy entry), and never saves it
  (`DiskfileEditorState` ignores edits and refuses `save_changes`;
  `Diskfiles.update` refuses to write over it too, with `conflict` /
  `content_not_loaded`), since a save would overwrite a file nobody has seen
  — as for a file whose content is still loading. A file part for it
  contributes a `[content not loaded — …]` placeholder saying why to a
  formatted prompt (inside its XML tag, or naming the file without one) and
  a marker naming the file to a chat turn's text and request
  (`Turn.content`) instead of silently dropping out. A failed read settles a
  file unloadable until its next change on disk or an explicit ask — a copy
  entry's click or a send needing it, which reads it once more; the send
  stops with an error if that fails too — and a failed re-read keeps the
  content it had
- **No persistent undo** — saves overwrite the file on disk; the editor keeps
  an in-memory per-file history (`DiskfileHistory`) you can restore from, lost
  on reload, as are unsaved drafts — leaving the page while any file has
  unsaved changes asks first (`beforeunload`), and a session that ends
  (logout, or a recheck finding it revoked) drops the App and its drafts with
  it. A file's editing state is app-level (`Diskfiles.get_editor_state`): disk
  changes are recorded with no editor open, a draft survives tab switches and,
  like a tab, keeps a file deleted on disk, closing a draft's last tab asks save / don't
  save / cancel, and a disk change under a draft pauses saving until you
  overwrite or keep the disk version (see § File Editing). A save carries the
  hash of the content it was based on and the backend refuses it if the file
  moved (`disk_changed`) — an overwrite too, against the version the
  conflict showed. Overwritten silently still: a write landing between that
  compare and the rename, and whatever an overwrite after a failed read
  replaces; a file kept deleted on disk is recreated exclusively, refused if
  anything is at the path. A file rewritten faster than a read
  round trip can't be overwritten from zzz: each overwrite is refused, read
  again, and refused again. Histories of files
  you've opened stay in memory for the session (each capped by entries and
  size)
- **Symlinks are invisible** — the filer never follows or indexes a symlink
  (file or directory), and `ScopedFs` rejects symlinked paths, so linked files
  don't appear in the file tree
- **File watching** — the filer adds one inotify watch per directory it
  indexes (never inside ignored directories), and those watches come out of
  the user's `max_user_watches` budget, shared with every other process. An
  unreadable subdirectory is skipped (logged once) and picked up if it
  becomes readable; an unreadable root or focused directory fails
  `project_open` with `forbidden` (`permission_denied`). When the watch
  limit is reached (or no watcher can be created), the project still opens
  with every file the scans found, but in **degraded mode**: `project_open`
  returns `watch_status: 'degraded'` (kept on the opening tab's `Project`
  cell; the projects page and the desk menu show it — another tab or a
  reload shows `'full'`), and the directories without a watch are rescanned
  every 5 seconds or more (retrying their watches each time), so changes
  there show up late. A project that degrades or recovers after it opened
  isn't re-announced — only the daemon log says so. A file is re-announced
  as changed when its `lstat` stamp moves (a `touch` or a chmod included, so
  clients holding it read it again), and once more at the next look after a
  change seen within 3 seconds of its inode change time (a stamp that fresh
  isn't trusted)
- **Change detection is by stat stamp** — the filer reads no file, so a
  write that doesn't move the file's `lstat` stamp goes unnoticed until the
  stamp next moves: an `mmap` store to an already-dirty page, or a remote or
  FUSE filesystem whose server clock lags this machine's by more than the
  3-second margin, or a FUSE filesystem that reports `st_ctime` as the
  `mtime` (sshfs), where a `touch -r` after a same-size rewrite hides it. A
  wall clock stepped back by more than the margin can hide a write that
  lands in the same timestamp tick as the stored stamp. An inode change time
  in the future (a clock stepped back, a remote server's clock ahead) is
  never trusted, so the file is a `change` on every look until the clock
  passes it
- **Project scope** — opening a project makes its root a writable
  `ScopedFs` root, with filers on what's focused, until it's closed; closing
  never revokes
  the permanent roots (`PUBLIC_ZZZ_DIR` and `PUBLIC_ZZZ_SCOPED_DIRS`). A
  directory strictly inside `$HOME`, or in `ZZZ_ROOTS_OUTSIDE_HOME`, can be
  opened — never `/`, `$HOME` or an ancestor of it, or a pseudo-filesystem
  (§ Root scope) — and no root makes a credential directory or a `.zzz`
  directory other than the app dir readable or writable. A project opened
  in another tab (or by `zzz <path>`) appears here unactivated, and its files
  arrive with a session resync
- **Projects and focus** — focus is by hand: a repo is indexed only once
  it's focused (opening a path in it, the file tree's lazy row, the
  projects page), and stays focused until it's unfocused, its project
  closes, or a later open finds its entry missing or the root's kind
  changed. Under a registry's root the registry's project indexes only
  its loose files and its focused repos — an unregistered directory only
  as its own project, once a path in it is opened. A new file where
  nothing indexes it is refused, since it would never show; a file another
  tool creates there doesn't appear. A registry's entries are
  resolved when it's opened, again on each later open, never in between —
  so `repo_focus` of an entry cloned since refuses it until a path in it
  is opened. A file kept from an unfocused repo for its draft or tab
  isn't watched: a change on disk meanwhile shows only when the repo is
  focused again, or as a conflict when it's saved
- **Git's ignore rule** (§ Filer) — what a checkout's filer ignores is
  git's answer as of its last listing plus the paths it vetted since: the
  user's global excludes file isn't watched (an edit there shows at the next
  re-prune), nor is `info/exclude` for a linked worktree or a submodule's
  checkout (its common directory is named only by the repo's own files,
  which the filer doesn't follow). A `.git` appearing in an indexed
  directory drops it from the index; one removed from a directory that
  wasn't indexed shows only at the next rescan. A directory whose `.git`
  is a symlink is indexed by no filer: git lists nothing in it, and a path
  in it resolves to the outer checkout. A file created by hand inside an
  unpopulated submodule makes git refuse the burst's check; that submodule
  is then left unindexed, as a populated one is, until the next rebuild of
  the set. A file git ignores replaced by a directory it doesn't (a
  `.gitignore` naming `x` and `!x/`) stays skipped as the file was; the
  directory is picked up at the next rebuild of the set or rescan. A
  rebuild whose listing fails or times out leaves the change it was for
  unapplied — and a new file git couldn't vet meanwhile unindexed — until
  the next `session_load` (a reload or a reconnect) or degraded poll
  rebuilds the set again; three failing in a row that a change on disk
  asked for (a rule edit, lost events, new files git couldn't vet, a set
  grown past its budget) fall back to fixed names, but a load's or poll's
  retry failing doesn't count, so a git that never answers costs a
  listing's timeout (5 s) per degraded poll and per load until such
  changes fail too — on a quiet degraded tree, possibly never. Each load
  waits out the 5 s with the filer blocked; polls back off to about 50 s
  apart (ten times their own duration, roughly a 10% duty cycle).
  Any `.git` entry — even one git wouldn't read as a repo — makes its
  directory a repo of its own here, so its files aren't indexed; the wire
  names it (`nested`), so a link into one reads "not indexed" and a file
  created there isn't waited for. A `.git` removed from a nested repo is
  seen only at the next rescan (no watch is inside it), so until then its
  files stay unindexed and it stays `nested`. A permanent filer on a
  checkout (the app directory, a scoped dir) runs git's rule, but its set
  is off the wire unless a project focuses it, so the frontend holds it to
  fixed names — a tracked `dist/` in it is indexed but hidden in the tree,
  and a file git ignores there reads as broken in a link, and is waited
  for, without a notice, when created. What the wire says is ignored can lag
  a second behind the filer (refreshes are coalesced), and a re-prune
  resynced while its project closes and a permanent filer stays on the
  directory leaves clients' permanent copy of it stale until the next
  `session_load`; and a filer started by a focus scan before the lock is
  off the wire until its commit marks it, so a re-prune past the threshold
  in that window sends each change
- **Large trees cost the client** — every indexed file of a focused repo
  ships in the focus reply and is kept as a metadata record
  (`DiskfileIndex`); a `Diskfile` cell is made only for a file in use (see
  § File Editing), so focusing a big clone costs the reply's size and
  parse more than the cells, and a reply of roughly 180k files passes the
  16 MiB message size (replies aren't capped, so it still arrives). A re-prune past the
  flood guard costs each client the same pull of the whole repo
- **Terminals** — any authenticated account can create a terminal, which runs
  a command as the daemon's OS user (see § Security posture). Each terminal
  belongs to the account that created it: its output (`terminal_data`,
  `terminal_exited`) reaches only that account's sockets, and other accounts'
  `terminal_data_send` / `terminal_resize` / `terminal_close` act as if it
  didn't exist (`not_found`, as for an unknown or ended id). `terminal_create`
  takes only an absolute `cwd`, and `terminal_close` only `SIGTERM` (the
  default) or `SIGKILL`. The frontend's terminal list is in-memory, so a page
  reload loses it while the backend processes keep running. A view mounted
  later (coming back to the terminals page, a restart's fresh view, a reopen)
  is replayed from the cell's output buffer (`TERMINAL_OUTPUT_MAX_LENGTH`),
  not from an earlier view's scrollback, and keeps the newest of it up to its
  scrollback limit (`TERMINAL_SCROLLBACK_MAX_BYTES`) — the buffer usually
  holds more than that
- **Terminal emulator** — terminals are drawn by `FuzTerminal`
  (./fuz_terminal.md), which doesn't do everything a desktop terminal does
  yet.
  - **Paste is from zzz's context menu only** (right-click the terminal →
    paste): it's bracketed when the program has turned on bracketed paste (a
    shell then holds a multi-line paste for Enter, as bash 5.1+ does by
    default), and text that could run commands as it arrives — a line break
    when the program hasn't, or the bracketed-paste end sequence in either
    case — is pasted only once you confirm it (if the program switches
    bracketed paste while you're asked and the text is unsafe in the new mode,
    nothing is sent, and a notice says to paste again; a line break the switch
    made safe is pasted bracketed). A paste longer than the terminal's input
    queue takes (64 Ki characters, less any input still waiting to be sent) is
    refused whole, with a notice. The browser asks before the first clipboard
    read (Firefox shows a paste button each time). Ctrl+Shift+V does nothing
    in the terminal, Shift+Insert reaches the program as a key, a middle click
    pastes no primary selection, and the browser's own menu
    (Shift+right-click) has no usable Paste over the terminal. The input box
    under each terminal sends text.
  - **No scrollback scrolling**: the wheel over a terminal scrolls the page's
    list of runs, never the terminal — inside `less`, `man`, or vim on the
    alternate screen too — and Shift+PgUp / Shift+PgDn go to the program;
    there's no scrollbar. The history is still in the emulator, up to its
    scrollback limit (`TERMINAL_SCROLLBACK_MAX_BYTES`, 2 MiB of the emulator's
    memory, so a wider terminal keeps fewer lines, the oldest dropped first),
    and the copy button copies all of it.
  - **No IME composition**: text an input method composes, and dead keys on
    platforms that deliver them as a composition, isn't typed, nor is a
    virtual keyboard's.
  - **No mouse reporting**: a program that asks for mouse events (vim with
    `mouse=a`, htop, tmux) gets none; a click focuses, a drag selects.
  - **No reverse video** (DECSCNM) while the default colors are the theme's.
  - **The look follows the app**: the default foreground and background are
    the theme's, while ANSI white and bright white stay light in both schemes,
    so text a program colors white is hard to read on a light theme, as in any
    light-themed terminal; the type is the app's monospace at the component's
    size.
  - **Selection** is the browser's over the visible rows: a row copies as one
    line and a soft-wrapped line copies with a break per row (the copy button
    joins it), and a selection over rows that redraw is lost.
  - **Copy** is Ctrl+Alt+C or Ctrl+Insert while a selection takes some of the
    terminal's text (with none, the key goes to the program); Ctrl+C is always
    the program's, and Ctrl+Shift+C is the browser's own shortcut (the element
    inspector in Chrome and Firefox). On macOS Cmd+C copies, and the two
    chords are the program's. The browser's menu (Shift+right-click) copies
    too.
  - **Focus**: Tab and Shift+Tab are the program's while a terminal has focus,
    so keyboard focus doesn't leave it by Tab — click elsewhere; a terminal
    whose process ended takes no keys, Tab included.
  - **Keys** follow Ghostty's encodings, which differ from what xterm-style
    terminals commonly send — Shift+Enter is `CSI 27;2;13~`, which a plain
    shell prints as junk, and Ctrl+Shift+letter is `CSI … u`;
    ./fuz_terminal.md (*Keyboard input*) lists the differences. Ctrl+digit is
    taken by the terminal while it has focus, its default prevented — whether
    a browser still switches tabs on it is the browser's decision. The Kitty
    keyboard protocol is supported when a program turns it on. Meta
    combinations, Ctrl+Shift+C, Ctrl+Shift+V, and (except on macOS) the page
    zoom keys — Ctrl with `=`, `+`, `-`, `_`, or `0` — stay the browser's, so
    a program never gets them (Emacs's Ctrl+_ undo included). Without the
    built module (`cargo xtask ghostty-vt`, Zig 0.17) each terminal shows a
    message instead, with a retry button; its process still runs
- **PTY terminals** — terminal spawning uses the `fuz_pty` Rust crate as a
  native dependency of `zzz_server` (no FFI indirection). `PtyManager` runs
  one I/O task per terminal (readiness-driven reads paced by the client's
  output acks, an ordered input queue — at most 256 chunks and 4 MiB per
  terminal, beyond which input is refused with `queue_overflow` — that writes
  large pastes in full, reaping with `SIGKILL` escalation so closed terminals
  leave no zombies). Terminal children inherit zzzd's environment **minus**
  `SECRET_*`, `FUZ_*`, `ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, and `PORT` —
  this keeps the daemon's API keys, cookie keys, and DB URL out of the child's
  environment, but it is not isolation (the shell runs as the same user and
  can read `/proc/<zzzd pid>/environ` or the `.env` files). The prefix match
  also drops the user's own `FUZ_*` variables from terminals; everything else
  (`PATH`, `HOME`, `SSH_AUTH_SOCK`, …) passes through, and `fuz_pty` sets
  `TERM=xterm-256color`, the xterm-compatible terminal Ghostty's emulator is.
  See ../crates/CLAUDE.md for details. Requires the sibling Rust workspace
  checked out alongside this repo (path dep).
- **Recording** — two places record, over the same `Recorder`: the files
  page's record button (beside new file and new folder; disabled without an
  open project) records in the active project (`Diskfiles.new_files_dir`), and the recordings page
  (`/recordings`: a record button, a level meter, and the recordings with
  their transcripts) records to `recordings/` in the app directory, which
  needs no project and keeps voice notes out of a repository. Deleting on
  the recordings page removes a recording with its transcripts; on the files
  page, exactly the file selected. A recording is a new file named for the
  local time (`2026-01-31_09-05-07.webm`) — Opus in WebM where the browser
  records it, else Ogg, else MP4. The file is created under its final name and
  grows as chunks upload every few seconds (the byte routes), so a crashed or
  closed tab loses at most the last chunk and leaves a file that still plays
  but has no duration; `media_finalize` on it later fixes that. Stopping
  uploads the rest and finalizes, then queues a transcription when the
  recorder's "transcribe" toggle is on (the default; with no speech model set
  up it quietly doesn't). The microphone opens only from a click or key press
  in the UI — `Recorder.start` refuses without a user gesture, and no action
  the backend can send starts capture. While it may be open an indicator with
  pause and stop shows on every page (`RecorderIndicator` in the root layout),
  leaving the page asks first, and a session that ends (logout, or a recheck
  finding it revoked) closes it with the App. One recording at a time, per
  tab. The filer sees the file grow: it broadcasts a `change` with the new
  size on each chunk. An upload that fails for good
  — the session ended, the file changed on disk — ends the recording and says
  why; the file keeps what landed. See § Recording
- **Transcription** — batch, not live: the transcript is made from the
  finished file, and text fills in while the job runs (whisper.cpp decodes in
  windows of about thirty seconds), not while you speak. It needs `ffmpeg`,
  whisper.cpp, and a model the operator placed and pointed
  `ZZZ_WHISPER_CPP_MODEL` at; without whisper.cpp or a model, recording still
  works and transcribing says what's missing. Without `ffmpeg`, recording
  still saves the audio, but every stop reports that it couldn't finalize, and
  the file has no duration. The UI offers transcription on audio extensions
  (`.webm`, `.ogg`, `.mp3`, `.wav`, `.flac`, `.m4a`, …); the action itself
  takes any container `ffmpeg` is told how to read here, a `.mkv` or `.mp4`
  included, and transcribes its first audio stream. The format is taken from
  the extension, so a mislabeled file fails to decode. The language is
  detected unless given. The model loads on every job. Word timings are
  whisper.cpp's own estimates. A transcript isn't checked against its audio
  afterward — if the audio's bytes change, the sidecar still shows (its
  recorded hash no longer matches). A sidecar over `diskfile_read`'s 4 MiB
  limit wouldn't load in the UI. One job runs at a time; jobs and their
  history are lost on a daemon restart, and a crash mid-transcription can
  leave a `.zzz-tmp-*` scratch directory in the app directory's `cache/`
  (hidden from the file index). A transcript's text is whatever was said near
  the microphone — it's shown as text, and nothing sends it to a chat, a
  prompt, or a terminal on its own
- **Audio files** — the files page shows a file with an audio extension
  (`diskfile_content_kind.ts`: `.webm`, `.ogg`, `.mp3`, `.wav`, `.flac`,
  `.m4a`, …) in a player instead of the text editor (`DiskfileView` picks;
  `DiskfileAudioView` plays it from the byte route, with finalize, download,
  and delete), with its transcript beside it — click a segment to play from
  there — or a transcribe button when it has none. A transcript sidecar
  (`*.transcript.json`) opens read-only in `DiskfileTranscriptView`, with the
  audio's player when the audio is beside it. The kind comes from the
  extension alone — the file index carries no type — so a `.webm` holding
  video plays as its audio, and a text file named `.ogg` gets a player that
  can't play it. The player reloads when the file's `mtime` moves
  (`Diskfile.mtime`, from the index's disk node), and the file being recorded
  shows as recording, with no player, until it's saved. Images and video have
  no viewer yet
- **No git integration** beyond read-only repo status — no commit/push/pull from the UI
- **No MCP/A2A** — protocol support planned but not implemented
- **Backend** — `zzz_server` serves the full RPC surface with the full auth
  stack. `cargo xtask dev` runs it with the Vite frontend. Anthropic, OpenAI,
  and Gemini providers fully implemented (non-streaming + SSE streaming). No
  batch JSON-RPC. A single `/api/rpc` + `/api/ws` serves the boot-compiled
  `ActionRegistry` (handlers in `handlers/`), plus the admin audit-log SSE
  stream at `GET /api/admin/audit/stream` and the file byte routes at
  `/api/files/bytes`.
