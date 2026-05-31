# AI Providers

Integration guide for AI providers and adding new ones.

## Supported Providers

| Provider | Type | Backend module | Status | API Key Env |
|----------|------|----------------|--------|-------------|
| Claude | Remote (BYOK) | `provider/anthropic.rs` | Full (non-streaming + SSE streaming) | `SECRET_ANTHROPIC_API_KEY` |
| ChatGPT | Remote (BYOK) | `provider/openai.rs` | Status-only stub | `SECRET_OPENAI_API_KEY` |
| Gemini | Remote (BYOK) | `provider/gemini.rs` | Status-only stub | `SECRET_GOOGLE_API_KEY` |

### Remote Providers (Claude, ChatGPT, Gemini)

Add API key to `.env.development` or via the UI at `/providers`:

```bash
SECRET_ANTHROPIC_API_KEY=sk-ant-api03-...
SECRET_OPENAI_API_KEY=sk-...
SECRET_GOOGLE_API_KEY=AIza...
```

## Default Models

The default model catalog is the source of truth in `src/lib/config_defaults.ts`
(`models_default`) — model IDs churn, so it isn't duplicated here. Each entry
carries a `provider_name` (`claude` / `chatgpt` / `gemini`) and `tags` drawn from
`smart`, `smartest`, `cheap`, `cheaper`. Pre-configured model groups live
alongside it in `chat_template_defaults` (`frontier`, `cheap frontier`,
`quick test`).

## Provider Architecture

Providers live in the Rust backend (`crates/zzz_server/src/provider/`),
enum-dispatched via the `Provider` enum (`provider/mod.rs`) — the providers
are known at compile time and matched exhaustively, no trait objects.
`ProviderManager` owns the set; `set_api_key` recreates the underlying
`reqwest` client; a provider reports an error status when no key is
configured. Anthropic (`provider/anthropic.rs`) is fully implemented with
non-streaming and SSE-streaming completions (`provider/sse.rs`); OpenAI and
Gemini are status-only stubs. See [../crates/CLAUDE.md](../crates/CLAUDE.md)
for the backend details.

### CompletionOptions

The per-completion options the backend passes to a provider:

```
frequency_penalty?: number
output_token_max: number
presence_penalty?: number
seed?: number
stop_sequences?: Array<string>
system_message: string
temperature?: number
top_k?: number
top_p?: number
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

The Anthropic provider (`crates/zzz_server/src/provider/anthropic.rs`) calls
the Messages API with a `reqwest` client. For streaming completions it sets
`stream: true`, parses the SSE response (`provider/sse.rs`, manual `\r\n`
normalization), and forwards each `content_block_delta` text chunk to the
originating WebSocket connection as a `completion_progress` notification.
See [../crates/CLAUDE.md](../crates/CLAUDE.md).

## Completion Flow

```
User sends message
  → Thread.send_message(content)
    → Build CompletionRequest (provider_name, model, prompt, completion_messages)
    → app.api.completion_create({completion_request, _meta: {progressToken}})
      → WS dispatch → backend completion_create handler
        → ProviderManager looks up the provider by name
          → provider calls its API (stream: true when a progress token is present)
            → For each text chunk:
              → completion_progress notification to the originating WS connection
                → Turn content updated incrementally
        → Return the completion result
```

Streaming progress is socket-scoped — the chunks go only to the originating
WebSocket connection, never broadcast. Cancellation is supported:
`Thread.cancel_pending()` fires from the client side, the frontend WS client
sends the `cancel` notification and rejects the pending promise with
`request_cancelled` so the UI can distinguish user-initiated cancels from
real provider failures; the backend aborts the in-flight request.

### Provider Status

```typescript
const status = await provider.load_status();
// { name: 'claude', available: true, checked_at: 1234567890 }
// { name: 'claude', available: false, error: 'API key required', checked_at: ... }
```

Remote providers: `available` = `true` when API key is set and client created.

## Adding a New Provider

Providers live in the Rust backend (`crates/zzz_server/src/provider/`), enum-
dispatched via the `Provider` enum (no trait objects). To add one:

1. Add a variant to the `Provider` enum and `ProviderName` in `provider/mod.rs`
2. Create `crates/zzz_server/src/provider/newprovider.rs` implementing the
   completion path (status, non-streaming, and SSE streaming via `provider/sse.rs`)
3. Wire it into `ProviderManager` and the exhaustive match arms
4. Add env var to `.env.development.example` and `.env.production.example`:
   `SECRET_NEWPROVIDER_API_KEY=`
5. Add default models to `src/lib/config_defaults.ts` (`models_default`)

See [../crates/CLAUDE.md](../crates/CLAUDE.md) for the backend architecture.
