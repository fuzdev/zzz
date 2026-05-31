# Development

Development workflow, extension points, and common patterns.

## Setup

```bash
git clone https://github.com/fuzdev/zzz.git && cd zzz
deno task dev:setup
npm install
```

Optionally add API keys to `.env.development` for remote providers (Anthropic, OpenAI, Google).

### PTY terminals

Terminal integration uses the `fuz_pty` Rust crate, a native dependency of
the `zzz_server` backend (no FFI indirection). Building the backend
(`cargo build -p zzz_server`) pulls it in. `fuz_pty` lives in a sibling
Rust workspace, which must be checked out alongside this repo.

## Commands

| Command | Purpose |
|---------|---------|
| `gro check` | All checks (typecheck, test, gen, format, lint) |
| `gro typecheck` | Type checking only (faster iteration) |
| `gro test` | Run Vitest tests |
| `gro test -- --watch` | Tests in watch mode |
| `gro gen` | Run `*.gen.ts` generators (regenerate their outputs) |
| `gro format` | Format with Prettier |
| `gro lint` | ESLint checking |
| `gro build` | Production build |
| `gro deploy` | Deploy to production |

`deno task dev` runs the dev server (Rust backend + Vite frontend) — the
user manages it; don't start it yourself.

Three task runners, by role: **`gro`** for checks, build, gen, and tests
(`gro check` / `build` / `gen` / `test`); **`deno task`** for the dev server and
env setup (`dev`, `dev:setup`, `prod:setup`); **`npm run`** for the package
scripts, notably `test:cross` (the Rust cross-process suites). `npm run dev` is
an alias for `deno task dev`.

## Code Generation

The `*.gen.ts` files are hand-written generators; `gro gen` runs them and writes
their outputs. Edit the generators, never the outputs (each output carries a
`DO NOT EDIT` banner):

| Generator | Output | Contents |
|-----------|--------|----------|
| `action_collections.gen.ts` | `src/lib/action_collections.ts` | Action spec collections, input/output type maps |
| `action_metatypes.gen.ts` | `src/lib/action_metatypes.ts` | Action method types, handler enums |
| `frontend_action_types.gen.ts` | `src/lib/frontend_action_types.ts` | Frontend handler types |
| `reference.gen.ts` | `docs/reference.md` | Action-spec + cell-class reference tables |

Run `gro gen` after changing `action_specs.ts` (or `cell_classes.ts`). `gro check`
fails if any output is stale.

## File Naming

| Pattern | Purpose | Example |
|---------|---------|---------|
| `snake_case.ts` | TypeScript modules | `helpers.ts`, `action_peer.ts` |
| `snake_case.svelte.ts` | Svelte 5 reactive state | `chat.svelte.ts` |
| `PascalCase.svelte` | Svelte components | `ChatView.svelte` |
| `snake_case.test.ts` | Test files (in `src/test/`) | `cell.svelte.base.test.ts` |
| `*_types.ts` | Type definitions | `action_types.ts` |
| `*_helpers.ts` | Utility functions | `jsonrpc_helpers.ts` |

### Component Naming

Components use `PascalCase` with domain prefixes:

| Prefix | Domain | Examples |
|--------|--------|----------|
| `Chat` | Chat UI | `ChatView`, `ChatListitem` |
| `Diskfile` | File editor | `DiskfileEditorView`, `DiskfileExplorer` |
| `Model` | Model management | `ModelListitem`, `ModelPickerDialog` |
| `Part` | Content parts | `PartView`, `PartEditorForText` |
| `Prompt` | Prompts | `PromptList`, `PromptPickerDialog` |
| `Terminal` | Terminals | `TerminalRunner`, `TerminalView`, `TerminalContextmenu` |
| `Thread` | Threads | `ThreadList`, `ThreadContextmenu` |
| `Turn` | Turns | `TurnView`, `TurnListitem` |

## Extension Points

### Adding a New Cell

1. Define schema (in the `*.svelte.ts` file or a separate `*_types.ts`):

```typescript
export const MyThingJson = CellJson.extend({
  name: z.string().default(''),
  value: z.number().default(0),
}).meta({cell_class_name: 'MyThing'});
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
  MyThing,
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
    message: z.string(),
  }),
  output: z.strictObject({
    result: z.string(),
  }),
  async: true,
} satisfies ActionSpecUnion;
```

2. Run `gro gen` to regenerate handler types.

3. Add frontend handler (`src/lib/frontend_action_handlers.ts`):

```typescript
my_action: {
  send_request: ({data: {input}}) => {
    console.log('sending:', input.message);
  },
  receive_response: ({app, data: {output}}) => {
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
+ `completion_progress` is the worked example. Broadcasts to all connected
sockets (server-wide events like `filer_change` or `workspace_changed`) go
through the backend's realtime connection registry. See ../crates/CLAUDE.md
for the Rust handler patterns.

### Adding a New Route

Create `src/routes/my_route/+page.svelte`:

```svelte
<script lang="ts">
  import {frontend_context} from '$lib/frontend.svelte.js';

  const app = frontend_context.get();
</script>

<h1>My Route</h1>
```

## Common Patterns

### State Access

```svelte
<script lang="ts">
  import {frontend_context} from '$lib/frontend.svelte.js';

  const app = frontend_context.get();
  const {chats, models, prompts} = app;
</script>
```

### Collection Operations

```typescript
// Add
const chat = app.chats.add({name: 'New Chat'});

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
  import type {Snippet} from 'svelte';

  const {
    title,
    children,
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
import {test, expect} from 'vitest';

import {providers_default, models_default} from '$lib/config_defaults.js';

test('all model provider_names exist in providers_default', () => {
  const model_provider_names = new Set(models_default.map((model) => model.provider_name));
  const provider_names = new Set(providers_default.map((provider) => provider.name));

  for (const provider_name of model_provider_names) {
    expect(
      provider_names.has(provider_name),
      `Provider "${provider_name}" does not exist in providers_default`,
    ).toBe(true);
  }
});
```

### Test File Naming

| Pattern | Example |
|---------|---------|
| `module.test.ts` | `action_event.test.ts` |
| `module.aspect.test.ts` | `cell.svelte.base.test.ts`, `cell.svelte.decoders.test.ts` |
| `module.aspect.test.ts` | `indexed_collection.svelte.queries.test.ts` |

## Code Style

### Naming

| Type | Convention | Example |
|------|-----------|---------|
| Variables/functions | `snake_case` | `send_message`, `user_input` |
| Classes | `PascalCase` | `ChatView`, `ActionPeer` |
| Types/interfaces | `PascalCase` | `ChatOptions`, `ActionSpec` |
| Zod schemas | `PascalCase` | `ChatJson`, `CompletionRequest` |
| Private fields | `#field` | `#internal_state` |

### Code Markers

| Marker | Meaning |
|--------|---------|
| `// @slop [Model]` | LLM-generated code needing review |
| `// TODO` | Work item |
| `// TODO @many` | Affects multiple locations |
| `// TODO @api` | API design question |
| `// TODO @db` | Database-related |

### Import Order

1. External packages (`svelte`, `zod`, etc.)
2. Internal aliases (`$lib/...`, `$env/...`)
3. Relative imports (`./...`)

```typescript
import {z} from 'zod';
import {SvelteMap} from 'svelte/reactivity';

import {Cell} from '$lib/cell.svelte.js';
import type {Frontend} from '$lib/frontend.svelte.js';

import {helper_function} from './helpers.js';
```

All imports use `.js` extensions (ESM convention).

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
