# AI Providers

Integration guide for AI providers and adding new ones.

## Supported Providers

- Claude (`provider/anthropic.rs`) — Full (non-streaming + SSE streaming). Type: Remote (BYOK). API Key Env: `SECRET_ANTHROPIC_API_KEY`
- ChatGPT (`provider/openai.rs`) — Full (non-streaming + SSE streaming). Type: Remote (BYOK). API Key Env: `SECRET_OPENAI_API_KEY`
- Gemini (`provider/gemini.rs`) — Full (non-streaming + SSE streaming). Type: Remote (BYOK). API Key Env: `SECRET_GOOGLE_API_KEY`

### Remote Providers (Claude, ChatGPT, Gemini)

Add the API key to `.env.development` (keys are env-only; restart the daemon after changing one):

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
`ProviderManager` owns the set; each provider builds its `reqwest` client once
at construction from its `SECRET_*_API_KEY` environment variable, and reports
an error status when no key is configured (an empty or whitespace-only value
counts as unconfigured) or the key is malformed (anything but visible ASCII,
e.g. a pasted smart quote). Keys travel only in request headers (`x-api-key`,
`Authorization: Bearer`, `x-goog-api-key`), marked sensitive, and never in a
URL. Keys are env-only — there is no
runtime key-update action, so changing a key means restarting the daemon. All three providers — Anthropic (`provider/anthropic.rs`), OpenAI
(`provider/openai.rs`), and Gemini (`provider/gemini.rs`) — are fully
implemented with non-streaming and SSE-streaming completions through the shared
`provider/sse.rs`. See ../crates/CLAUDE.md for the
backend details.

### Request Shaping

Each provider's request builder normalizes the conversation history the same
way: blank (empty or whitespace-only) messages are dropped, and `system`-role
messages are lifted out of the history — combined with the configured system
message into Anthropic's top-level `system` field and Gemini's
`systemInstruction`. OpenAI accepts `system` messages in place, so they pass
through, and the configured system message is sent only when non-blank.
Gemini also merges adjacent same-role messages into one multi-part content,
keeping its user/model alternation intact when the history has gaps.
`completion_create` refuses a blank prompt with `invalid_params`, and Gemini
refuses a model name outside `[A-Za-z0-9._-]+`, since it becomes a URL path
segment.

### Errors and Cancellation

A completion either returns a complete response or an error — never a
truncated success:

- **Mid-stream provider errors** — Anthropic's `event: error` (e.g.
  `overloaded_error`) and OpenAI / Gemini `{"error": ...}` data chunks fail
  the request with the provider's message.
- **Incomplete streams** — a stream that ends without the provider's terminal
  signal (Anthropic `message_stop`, OpenAI `data: [DONE]`, Gemini a chunk
  with a `finishReason` or a prompt `blockReason`) is an error. Reading stops
  at the terminal signal, so a later cancel or read error can't fail a
  complete response.
- **Cancellation** — every upstream await (sending the request, reading a
  non-streaming body, each stream chunk) is raced against the request's
  cancellation signal, and a cancelled completion returns `request_cancelled`.

The frontend keeps any text that streamed in before an error and shows the
error separately. Transport error messages have the request URL stripped.
The shared HTTP client bounds connection setup at 30 seconds; there is no
overall request timeout, since streaming completions run long.

Streaming responses carry usage: OpenAI requests it with
`stream_options.include_usage`, and Anthropic merges `message_start`'s input
counts with `message_delta`'s output counts.

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
	completion_messages: z.array(CompletionMessage).optional()
});

const CompletionResponse = z.strictObject({
	created: DatetimeNow,
	provider_name: ProviderName,
	model: z.string(),
	data: ProviderDataSchema
});
```

## Real Provider Example

The Anthropic provider (`crates/zzz_server/src/provider/anthropic.rs`) calls
the Messages API with a `reqwest` client. For streaming completions it sets
`stream: true`, parses the SSE response (`provider/sse.rs`, manual `\r\n`
normalization), and forwards each `content_block_delta` text chunk to the
originating WebSocket connection as a `completion_progress` notification. The
OpenAI (Chat Completions) and Gemini (Generative Language) providers follow the
same pattern against their respective APIs, sharing `provider/sse.rs`.
See ../crates/CLAUDE.md.

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
`cancel_pending()` also marks the in-flight assistant turn `cancelled`, so it
stops showing as pending even when no content streamed in, and any later
`completion_progress` chunks for it are ignored.

### Provider Status

```typescript
const status = await provider.load_status();
// { name: 'claude', available: true, checked_at: 1234567890 }
// { name: 'claude', available: false, error: 'needs API key', checked_at: ... }
```

Remote providers: `available` = `true` when a valid API key is configured
(set, non-blank, visible ASCII).

## Adding a New Provider

Providers live in the Rust backend (`crates/zzz_server/src/provider/`), enum-
dispatched via the `Provider` enum (no trait objects). To add one:

1. Add a variant to the `Provider` enum and `ProviderName` in `provider/mod.rs`
2. Create `crates/zzz_server/src/provider/newprovider.rs` implementing the
   completion path (status, non-streaming, and SSE streaming via `provider/sse.rs`)
3. Wire it into `ProviderManager` and the exhaustive match arms — construction
   and registration happen at boot in `crates/zzz_server/src/lib.rs`
   (`provider_manager.add(Provider::...)`, reading the key with
   `provider::read_api_key_env`, and building the client through
   `common::ProviderClient::from_api_key`)
4. Add env var to `.env.development.example` and `.env.production.example`:
   `SECRET_NEWPROVIDER_API_KEY=`
5. Add default models to `src/lib/config_defaults.ts` (`models_default`)

See ../crates/CLAUDE.md for the backend architecture.
