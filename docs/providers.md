# AI Providers

Integration guide for AI providers and adding new ones.

## Supported Providers

| Provider | Type | Class | SDK | API Key Env |
|----------|------|-------|-----|-------------|
| Ollama | Local | `BackendProviderOllama` | `ollama` | None required |
| Claude | Remote (BYOK) | `BackendProviderClaude` | `@anthropic-ai/sdk` | `SECRET_ANTHROPIC_API_KEY` |
| ChatGPT | Remote (BYOK) | `BackendProviderChatgpt` | `openai` | `SECRET_OPENAI_API_KEY` |
| Gemini | Remote (BYOK) | `BackendProviderGemini` | `@google/generative-ai` | `SECRET_GOOGLE_API_KEY` |

### Ollama (Local)

No API key. Auto-detects available models. Model management UI at `/providers/ollama`.

Setup: Install Ollama, run `ollama serve`, zzz auto-detects.

### Remote Providers (Claude, ChatGPT, Gemini)

Add API key to `.env.development` or via the UI at `/providers`:

```bash
SECRET_ANTHROPIC_API_KEY=sk-ant-api03-...
SECRET_OPENAI_API_KEY=sk-...
SECRET_GOOGLE_API_KEY=AIza...
```

## Default Models

Defined in `src/lib/config_defaults.ts` (`models_default`):

### Ollama

| Model | Tags |
|-------|------|
| `gemma3n:e2b`, `gemma3n:e4b` | small |
| `gemma3:1b`, `gemma3:4b` | small |
| `qwen3:0.6b`, `qwen3:1.7b`, `qwen3:4b`, `qwen3:8b` | small / (none) |
| `deepseek-r1:1.5b`, `deepseek-r1:7b`, `deepseek-r1:8b` | reasoning |
| `llama3.2:1b`, `llama3.2:3b` | small |
| `phi4-mini:3.8b` | (none) |
| `smollm2:135m`, `smollm2:360m`, `smollm2:1.7b` | small |

### Claude (Anthropic)

| Model | Tags |
|-------|------|
| `claude-sonnet-4-5-20250929` | smart |
| `claude-opus-4-1-20250805` | smart, smartest |
| `claude-3-5-haiku-20241022` | cheap |

### ChatGPT (OpenAI)

| Model | Tags |
|-------|------|
| `gpt-5-2025-08-07` | smart |
| `gpt-5-nano-2025-08-07` | cheap, cheaper |
| `gpt-5-mini-2025-08-07` | cheap |
| `gpt-4.1-2025-04-14` | smart |

### Gemini (Google)

| Model | Tags |
|-------|------|
| `gemini-2.5-pro` | smart |
| `gemini-2.5-flash` | cheap |
| `gemini-2.5-flash-lite` | cheap, cheaper |

### Chat Templates

Pre-configured model groups in `config_defaults.ts` (`chat_template_defaults`): `frontier`, `cheap frontier`, `local 3-4b`, `local 1-2b`, `local <1b`, `local gemmas`, `quick test`.

## Provider Architecture

### Class Hierarchy

```
BackendProvider<TClient>              (backend_provider.ts)
├── BackendProviderLocal<TClient>     (for locally-installed services)
│   └── BackendProviderOllama         (backend_provider_ollama.ts)
└── BackendProviderRemote<TClient>    (for API-based services, manages API keys)
    ├── BackendProviderClaude         (backend_provider_claude.ts)
    ├── BackendProviderChatgpt        (backend_provider_chatgpt.ts)
    └── BackendProviderGemini         (backend_provider_gemini.ts)
```

### BackendProvider Base

From `server/backend_provider.ts`:

```typescript
abstract class BackendProvider<TClient = unknown> {
  abstract readonly name: string;
  protected client: TClient | null = null;
  protected provider_status: ProviderStatus | null = null;

  /** Default broadcast callback — set at construction, used when no per-call on_progress is threaded in. */
  protected readonly on_completion_progress: OnCompletionProgress;

  abstract handle_streaming_completion(options: CompletionHandlerOptions): Promise<ActionOutputs['completion_create']>;
  abstract handle_non_streaming_completion(options: CompletionHandlerOptions): Promise<ActionOutputs['completion_create']>;

  get_handler(streaming: boolean): CompletionHandler {
    return streaming
      ? this.handle_streaming_completion.bind(this)
      : this.handle_non_streaming_completion.bind(this);
  }

  abstract create_client(): void;
  abstract get_client(): TClient;
  abstract load_status(reload?: boolean): Promise<ProviderStatus>;

  protected validate_streaming_requirements(progress_token?: Uuid): asserts progress_token { ... }
  /**
   * Per-call `on_progress` (from `CompletionHandlerOptions`) wins over the
   * constructor-level `on_completion_progress` — lets the handler route
   * chunks to the originating socket via `ctx.notify` rather than broadcast.
   */
  protected async send_streaming_progress(
    progress_token: Uuid,
    chunk: ...,
    on_progress?: OnCompletionProgress,
  ): Promise<void> { ... }
}
```

### BackendProviderRemote

Adds API key management. `set_api_key()` recreates the client. Returns error status if no key configured.

### BackendProviderLocal

Creates client on construction. `load_status()` checks if the service is available locally.

### CompletionHandlerOptions

```typescript
interface CompletionHandlerOptions {
  model: string;
  completion_options: CompletionOptions;
  completion_messages: Array<CompletionMessage> | undefined;
  prompt: string;
  progress_token?: Uuid;  // Opts into streaming when provided
  /**
   * Per-call progress callback. When provided, overrides the provider's
   * constructor-level `on_completion_progress` for this request — lets
   * the caller route progress to the originating WS socket via `ctx.notify`
   * rather than broadcasting through `backend.api.*`.
   */
  on_progress?: OnCompletionProgress;
}

type OnCompletionProgress = (input: ActionInputs['completion_progress']) => Promise<void>;

interface CompletionOptions {
  frequency_penalty?: number;
  output_token_max: number;
  presence_penalty?: number;
  seed?: number;
  stop_sequences?: Array<string>;
  system_message: string;
  temperature?: number;
  top_k?: number;
  top_p?: number;
}
```

### CompletionRequest / CompletionResponse

From `completion_types.ts`:

```typescript
const CompletionRequest = z.strictObject({
  created: DatetimeNow,
  provider_name: ProviderName,
  model: z.string(),
  prompt: z.string(),
  completion_messages: z.array(CompletionMessage).optional(),
});

const CompletionResponse = z.strictObject({
  created: DatetimeNow,
  provider_name: ProviderName,
  model: z.string(),
  data: ProviderDataSchema,
});
```

## Real Provider Example

From `server/backend_provider_claude.ts`:

```typescript
export class BackendProviderClaude extends BackendProviderRemote<Anthropic> {
  readonly name = 'claude';

  constructor(options: BackendProviderOptions) {
    super({...options, api_key: options.api_key ?? (SECRET_ANTHROPIC_API_KEY || null)});
  }

  protected override create_client(): void {
    this.client = this.api_key ? new Anthropic({apiKey: this.api_key}) : null;
  }

  async handle_streaming_completion(options: CompletionHandlerOptions): Promise<ActionOutputs['completion_create']> {
    const {model, completion_options, completion_messages, prompt, progress_token, on_progress} = options;
    this.validate_streaming_requirements(progress_token);

    const stream = await this.get_client().messages.create(
      create_claude_completion_options(model, completion_options, completion_messages, prompt, true),
    );

    let accumulated_content = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        accumulated_content += event.delta.text;
        // Thread the caller's on_progress through — when called from the WS
        // handler, this routes chunks to the originating socket via ctx.notify.
        void this.send_streaming_progress(
          progress_token,
          { message: { role: 'assistant', content: event.delta.text } },
          on_progress,
        );
      }
    }

    return to_completion_result('claude', model, api_response, progress_token);
  }
}
```

## Completion Flow

```
User sends message
  → Thread.send_message(content)
    → Build CompletionRequest (provider_name, model, prompt, completion_messages)
    → app.api.completion_create({completion_request, _meta: {progressToken}})
      → WS dispatch builds ctx {backend, request_id, notify, signal}
      → zzz_action_handlers.completion_create(input, ctx)
        → Backend: backend.lookup_provider(provider_name)
          → provider.get_handler(!!progress_token)
            → provider.handle_streaming_completion({..., on_progress: ctx.notify-adapter})
              → Call provider SDK with stream: true
              → For each chunk:
                → provider.send_streaming_progress(progress_token, chunk, on_progress)
                  → on_progress({progressToken, chunk})
                    → ctx.notify('completion_progress', ...)
                      → WS notification to originating socket
                        → Turn content updated incrementally
              → Return CompletionResult
```

`ollama_pull` and `ollama_create` use the same pattern inline: they call
`ctx.notify('ollama_progress', ...)` directly from the handler loop and
check `ctx.signal.aborted` to terminate early on socket close.

The request-scoped routing (`ctx.notify`) is the default for streaming
progress. The constructor-level `on_completion_progress` (broadcast through
`backend.api.completion_progress`) stays as the fallback — used when a
provider is invoked outside a WS handler context.

### Provider Status

```typescript
const status = await provider.load_status();
// { name: 'claude', available: true, checked_at: 1234567890 }
// { name: 'claude', available: false, error: 'API key required', checked_at: ... }
```

Remote providers: `available` = `true` when API key is set and client created.
Local providers (Ollama): `available` = `true` when service responds.

## Adding a New Provider

1. Create `src/lib/server/backend_provider_newprovider.ts` extending `BackendProviderRemote<SDKClient>`
2. Implement `create_client()`, `handle_streaming_completion()`, `handle_non_streaming_completion()`
3. Register in `src/lib/server/server.ts`: `backend.add_provider(new BackendProviderNewProvider(provider_options))`
4. Add response helper in `src/lib/response_helpers.ts`
5. Add env var to `.env.development.example` and `.env.production.example`: `SECRET_NEWPROVIDER_API_KEY=`
6. Add default models to `src/lib/config_defaults.ts` (`models_default`)

See [src/lib/server/CLAUDE.md](../src/lib/server/CLAUDE.md) for detailed backend architecture.
