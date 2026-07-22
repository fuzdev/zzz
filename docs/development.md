# Development

Development workflow, extension points, and common patterns.

## Setup

Requires Node (>=24.14), a Rust toolchain, PostgreSQL, and the sibling fuz
Rust workspace checked out alongside this repo (path deps — including `fuz_pty`).

```bash
git clone https://github.com/fuzdev/zzz.git && cd zzz
createdb zzz          # PostgreSQL database the backend connects to
cargo xtask dev-setup   # generate .env.development (idempotent)
npm install           # Node dependencies
cargo xtask dev         # build the Rust backend + run it with the Vite frontend
```

`cargo xtask dev` rebuilds `zzz_server` (`cargo build -p zzz_server`) on every run,
binds the backend on `4461`, and serves the Vite frontend on `5173` (proxying
`/api` → `4461`). Browse to `localhost:5173`.

Optionally add API keys to `.env.development` for remote providers (Anthropic,
OpenAI, Google), or set them at runtime on `/capabilities`.

### PTY terminals

Terminal integration uses the `fuz_pty` Rust crate, a native dependency of
the `zzz_server` backend (no FFI indirection). Building the backend
(`cargo build -p zzz_server`) pulls it in. `fuz_pty` lives in a sibling
Rust workspace, which must be checked out alongside this repo.

## Commands

- `gro check` — All checks (typecheck, test, gen, format, lint)
- `gro typecheck` — Type checking only (faster iteration)
- `gro test` — Run Vitest tests
- `gro test -- --watch` — Tests in watch mode
- `gro gen` — Run `*.gen.ts` generators (regenerate their outputs)
- `gro format` — Format with Prettier
- `gro lint` — ESLint checking
- `gro build` — Production build
- `gro deploy` — Deploy to production

`cargo xtask dev` runs the dev server (Rust backend + Vite frontend) — the
user manages it; don't start it yourself.

Three task runners, by role: **`gro`** for checks, build, gen, and tests
(`gro check` / `build` / `gen` / `test`); **`cargo xtask`** for the dev server and
env setup (`dev`, `dev-setup`, `prod-setup`); **`npm run`** for the package
scripts, notably `test:cross` (the Rust cross-process suites). `npm run dev`,
`npm run dev:setup`, and `npm run prod:setup` alias the matching `cargo xtask`
commands.

## Production build

There are two production targets:

- **Static-only** — `gro build` prerenders the SPA into `build/`, and `gro deploy`
  publishes it to a static host (zzz.software). No Rust backend, so the
  filesystem, terminals, AI, and auth are unavailable — the "diminished
  capabilities" build.
- **Full self-hosted** — the same `build/` SPA served by the Rust `zzz_server`
  daemon, which also serves `/api`. This is the complete app, and needs **both**
  a frontend build and a backend build (`gro build` only does the SPA).

Build and run the full self-hosted server:

```bash
cargo xtask prod-setup                      # writes .env.production — edit its secrets
gro build                                 # frontend → build/
cargo build -p zzz_server --release       # backend  → target/release/zzzd
./target/release/zzzd --static-dir build  # serve SPA + /api (port 4460; --port/ZZZ_PORT overrides)
```

`zzzd` reads its config from the **process environment** — it does _not_ load
`.env.production` itself (unlike `cargo xtask dev`, which loads `.env.development`
and injects it into the child processes). Supply the env via your process manager, a systemd
`EnvironmentFile`, or, in a shell, `set -a && . ./.env.production && set +a` before
running. It requires `DATABASE_URL`, `SECRET_FUZ_COOKIE_KEYS`, and a non-empty
`FUZ_ALLOWED_ORIGINS` (it hard-fails at boot otherwise). `--static-dir` (or
`ZZZ_STATIC_DIR`) points it at the built frontend; CLI flags win over env. In
production the SPA and API share one origin, so `.env.production` sets every
`PUBLIC_ZZZ_SERVER_*` port to the backend port (4460).

## Code Generation

The `*.gen.ts` files are hand-written generators; `gro gen` runs them and writes
their outputs. Edit the generators, never the outputs (each output carries a
`DO NOT EDIT` banner):

- `action_collections.gen.ts` (`src/lib/action_collections.ts`) — Action spec collections, input/output type maps
- `action_metatypes.gen.ts` (`src/lib/action_metatypes.ts`) — Action method types, handler enums
- `frontend_action_types.gen.ts` (`src/lib/frontend_action_types.ts`) — Frontend handler types
- `reference.gen.ts` (`docs/reference.md`) — Action-spec + cell-class reference lists

Run `gro gen` after changing `action_specs.ts` (or `cell_classes.ts`). `gro check`
fails if any output is stale.

## File Naming

- `snake_case.ts` — TypeScript modules. Example: `helpers.ts`, `action_dispatcher.ts`
- `snake_case.svelte.ts` — Svelte 5 reactive state. Example: `chat.svelte.ts`
- `PascalCase.svelte` — Svelte components. Example: `ChatView.svelte`
- `snake_case.test.ts` — Test files (in `src/test/`). Example: `cell.svelte.base.test.ts`
- `*_types.ts` — Type definitions. Example: `action_types.ts`
- `*_helpers.ts` — Utility functions. Example: `jsonrpc_helpers.ts`

### Component Naming

Components use `PascalCase` with domain prefixes:

- `Chat` — Chat UI. Examples: `ChatView`, `ChatListitem`
- `Diskfile` — File editor. Examples: `DiskfileEditorView`, `DiskfileExplorer`
- `Model` — Model management. Examples: `ModelListitem`, `ModelPickerDialog`
- `Part` — Content parts. Examples: `PartView`, `PartEditorForText`
- `Prompt` — Prompts. Examples: `PromptList`, `PromptPickerDialog`
- `Terminal` — Terminals. Examples: `TerminalRunner`, `TerminalView`, `TerminalContextmenu`
- `Thread` — Threads. Examples: `ThreadList`, `ThreadContextmenu`
- `Turn` — Turns. Examples: `TurnView`, `TurnListitem`

## Extension Points

### Adding a New Cell

1. Define schema (in the `*.svelte.ts` file or a separate `*_types.ts`):

```typescript
export const MyThingJson = CellJson.extend({
	name: z.string().default(''),
	value: z.number().default(0)
}).meta({ cell_class_name: 'MyThing' });
```

2. Create the class (`src/lib/my_thing.svelte.ts`):

```typescript
export class MyThing extends Cell<typeof MyThingJson> {
	name: string = $state.raw()!;
	value: number = $state.raw()!;

	readonly doubled = $derived(this.value * 2);

	constructor(options: MyThingOptions) {
		super(MyThingJson, options);
		this.init(); // Must call at end
	}
}
```

3. Register in `src/lib/cell_classes.ts`:

```typescript
export const cell_classes = {
	// ... existing classes
	MyThing
} satisfies Record<string, typeof Cell<any>>;
```

### Adding a New Action

1. Define the spec in `src/lib/action_specs.ts`:

```typescript
export const my_action_action_spec = {
	method: 'my_action',
	kind: 'request_response',
	initiator: 'frontend',
	auth: null, // public; or {account: 'required', actor: 'none'} to require a session
	side_effects: true,
	input: z.strictObject({
		message: z.string()
	}),
	output: z.strictObject({
		result: z.string()
	}),
	async: true
} satisfies ActionSpecUnion;
```

2. Run `gro gen` to regenerate handler types.

3. Add frontend handler (`src/lib/frontend_action_handlers.ts`) — handlers go
   inside `create_frontend_action_handlers(frontend)` and reach app state via the
   closed-over `frontend` (the action event itself carries no `app`):

```typescript
my_action: {
  send_request: ({data: {input}}) => {
    console.log('sending:', input.message);
  },
  receive_response: ({data: {output}}) => {
    console.log('received:', output.result);
  },
  receive_error: ({data: {error}}) => {
    console.error('failed:', error);
  },
},
```

4. Add the backend handler in the Rust backend (`crates/zzz_server`): a spec
   builder in `zzz_action_specs/` and the handler fn in `handlers/`. Both
   HTTP RPC and WebSocket paths dispatch through the same `ActionRegistry`,
   so the handler is picked up on both transports. See ../crates/CLAUDE.md.

### Streaming Handlers

For actions that push progress notifications back to the requester while
running, pair the `request_response` action with a companion
`remote_notification` action and name the companion in the `streams` field:

```typescript
export const my_long_job_action_spec = {
  method: 'my_long_job',
  kind: 'request_response',
  initiator: 'frontend',
  auth: {account: 'required', actor: 'none'},
  streams: 'my_long_job_progress', // name of the companion notification
  input: z.strictObject({...}),
  output: z.null(),
  async: true,
} satisfies ActionSpecUnion;

export const my_long_job_progress_action_spec = {
  method: 'my_long_job_progress',
  kind: 'remote_notification',
  initiator: 'backend',
  input: z.strictObject({...}),
  async: false,
} satisfies ActionSpecUnion;
```

The backend handler sends progress chunks to the originating socket
(request-scoped) and terminates early when the socket closes; `completion_create`

- `completion_progress` is the worked example. Broadcasts to all connected
  sockets (server-wide events like `filer_change` or `workspace_changed`) go
  through the backend's realtime connection registry. See ../crates/CLAUDE.md
  for the Rust handler patterns.

### Adding a New Route

Create `src/routes/my_route/+page.svelte`:

```svelte
<script lang="ts">
	import { frontend_context } from '$lib/frontend.svelte.ts';

	const app = frontend_context.get();
</script>

<h1>My Route</h1>
```

## Common Patterns

### State Access

```svelte
<script lang="ts">
	import { frontend_context } from '$lib/frontend.svelte.ts';

	const app = frontend_context.get();
	const { chats, models, prompts } = app;
</script>
```

### Collection Operations

```typescript
// Add
const chat = app.chats.add({ name: 'New Chat' });

// Get by ID
const chat = app.chats.items.by_id.get(id);

// Get by single index
const model = app.models.items.by('name', 'gpt-5-2025-08-07');

// Query multi-index
const claude_models = app.models.items.where('provider_name', 'claude');

// Iterate
for (const chat of app.chats.items.values) {
	console.log(chat.name);
}
```

### Action Invocation

```typescript
// Request/response
const result = await app.api.completion_create({
  completion_request: {...},
  _meta: {progressToken: turn.id},
});

// Local action (sync)
app.api.toggle_main_menu();
```

### Component Pattern (Svelte 5)

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';

	const {
		title,
		children
	}: {
		title: string;
		children?: Snippet;
	} = $props();
</script>

<div class="my-component">
	<h2>{title}</h2>
	{#if children}
		{@render children()}
	{/if}
</div>
```

### Context Menus

```svelte
<script lang="ts">
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
</script>

<Contextmenu>
	{#snippet entries()}
		<ContextmenuEntry onclick={() => doSomething()}>Action Label</ContextmenuEntry>
	{/snippet}
	<div>Right-click me</div>
</Contextmenu>
```

## Testing

Tests live in `src/test/` (not co-located). Split large suites by aspect with dot-separated names.

```bash
gro test                                    # all tests
gro test -- --watch                         # watch mode
gro test -- src/test/cell.svelte.base.test.ts  # specific file
```

### Test Pattern

Uses Vitest with `test` and `expect`:

```typescript
import { test, expect } from 'vitest';

import { providers_default, models_default } from '$lib/config_defaults.ts';

test('all model provider_names exist in providers_default', () => {
	const model_provider_names = new Set(models_default.map((model) => model.provider_name));
	const provider_names = new Set(providers_default.map((provider) => provider.name));

	for (const provider_name of model_provider_names) {
		expect(
			provider_names.has(provider_name),
			`Provider "${provider_name}" does not exist in providers_default`
		).toBe(true);
	}
});
```

### Test File Naming

- `module.test.ts` — `action_event.test.ts`
- `module.aspect.test.ts` — `cell.svelte.base.test.ts`, `cell.svelte.decoders.test.ts`
- `module.aspect.test.ts` — `indexed_collection.svelte.queries.test.ts`

## Code Style

### Naming

- Variables/functions — `snake_case`. Example: `send_message`, `user_input`
- Classes — `PascalCase`. Example: `ChatView`, `ActionDispatcher`
- Types/interfaces — `PascalCase`. Example: `ChatOptions`, `ActionSpec`
- Zod schemas — `PascalCase`. Example: `ChatJson`, `CompletionRequest`
- Private fields — `#field`. Example: `#internal_state`

### Code Markers

- `// @slop [Model]` — LLM-generated code needing review
- `// TODO` — Work item
- `// TODO @many` — Affects multiple locations
- `// TODO @api` — API design question
- `// TODO @db` — Database-related

### Import Order

1. External packages (`svelte`, `zod`, etc.)
2. Internal aliases (`$lib/...`, `$env/...`)
3. Relative imports (`./...`)

```typescript
import { z } from 'zod';
import { SvelteMap } from 'svelte/reactivity';

import { Cell } from '$lib/cell.svelte.ts';
import type { Frontend } from '$lib/frontend.svelte.ts';

import { helper_function } from './helpers.ts';
```

Imports use the real source extension (`.ts` / `.svelte.ts` / `.svelte`) —
library code (`src/lib`) imports relative, while `src/routes` and `src/test`
use the `$lib` alias.

### Svelte 5 Runes in State Classes

```typescript
// Schema fields — $state.raw()! by default, initialized by Cell.init()
name: string = $state.raw()!;

// $state()! only for arrays/objects mutated in place (push, splice, etc.)
thread_ids: Array<Uuid> = $state()!;

// Derived values
readonly doubled = $derived(this.count * 2);
readonly complex = $derived.by(() => expensiveCalculation(this.count));
```

No `$effect` in Cell classes — effects belong in Svelte components only.

### Error Handling

```typescript
// Structured JSON-RPC errors
throw jsonrpc_errors.invalid_params('Missing required field');
throw jsonrpc_errors.ai_provider_error(provider_name, error_message);

// Let ThrownJsonrpcError bubble through
if (error instanceof ThrownJsonrpcError) {
	throw error;
}
```
