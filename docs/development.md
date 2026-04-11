# Development

Development workflow, extension points, and common patterns.

## Setup

```bash
git clone https://github.com/fuzdev/zzz.git && cd zzz
deno task dev:setup
npm install
```

Optionally add API keys to `.env.development` for remote providers (Anthropic, OpenAI, Google). Ollama requires no key.

### PTY support (optional)

Terminal integration uses a Rust shared library (`fuz_pty`) for real PTY
support via Deno FFI. Without it, terminals fall back to `Deno.Command` pipes
(commands run but no echo, no prompt, no interactivity).

```bash
cd ~/dev/private_fuz && cargo build -p fuz_pty --release
```

This produces `target/release/libfuz_pty.so`, which zzz loads at runtime via
`Deno.dlopen()`. The dev server needs `--allow-ffi` (already set in
`gro.config.ts`). The compiled binary also has `--allow-ffi`.

For bundled/compiled binaries, place `libfuz_pty.so` next to the `zzz`
executable. The library lookup checks exe-relative path first, then falls back
to the dev path (`~/dev/private_fuz/target/release/`).

## Commands

| Command | Purpose |
|---------|---------|
| `gro check` | All checks (typecheck, test, gen, format, lint) |
| `gro typecheck` | Type checking only (faster iteration) |
| `gro test` | Run Vitest tests |
| `gro test -- --watch` | Tests in watch mode |
| `gro gen` | Regenerate `*.gen.ts` files |
| `gro format` | Format with Prettier |
| `gro lint` | ESLint checking |
| `gro build` | Production build |
| `gro deploy` | Deploy to production |

Never run `gro dev` — the user manages the dev server.

## Code Generation

`gro gen` regenerates these files from action specs. Never edit them manually:

| Generated file | Source |
|---------------|--------|
| `src/lib/action_metatypes.gen.ts` | Action method types |
| `src/lib/action_collections.gen.ts` | Action spec collections |
| `src/lib/frontend_action_types.gen.ts` | Frontend handler types |
| `src/routes/library.gen.ts` | Route metadata |

Run `gro gen` after changing `action_specs.ts`.

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
| `Ollama` | Ollama-specific | `OllamaManager`, `OllamaPullModel` |
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
  auth: 'public',
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

4. Add handler (`src/lib/server/zzz_action_handlers.ts`):

```typescript
my_action: async (input, ctx) => {
  const {message} = input;
  return {result: `Processed: ${message}`};
},
```

Both HTTP RPC and WebSocket paths automatically pick up the new handler.

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
const ollama_models = app.models.items.where('provider_name', 'ollama');

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
