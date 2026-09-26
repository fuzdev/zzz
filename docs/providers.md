# AI Providers

Integration guide for AI providers and adding new ones.

## Supported Providers

- Claude (`provider/anthropic.rs`) — Full (non-streaming + SSE streaming). Type: Remote (BYOK). API Key Env: `SECRET_ANTHROPIC_API_KEY`
- ChatGPT (`provider/openai.rs`) — Full (non-streaming + SSE streaming). Type: Remote (BYOK). API Key Env: `SECRET_OPENAI_API_KEY`
- Gemini (`provider/gemini.rs`) — Full (non-streaming + SSE streaming). Type: Remote (BYOK). API Key Env: `SECRET_GOOGLE_API_KEY`

### Remote Providers (Claude, ChatGPT, Gemini)

Add the API key to the env file the backend is launched with — `.env.development`
for `cargo xtask dev`, `~/.zzz/.env` for the `zzz` CLI's daemon (or export it in
the environment). Keys are env-only; restart the daemon after changing one:

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
`quick test`), and the utility models in `BOTS_DEFAULT` — `namerbot`, the cheap
model that names chats. Tests keep every template and bot model in the catalog
and keep retired Claude IDs out of it; the API rejects a retired ID with a 404
on every request.

### Chat Auto-Naming

After a chat's first successful reply, `Chat.init_name_from_turns` asks the
`namerbot` model for a title. It only runs while the chat's `autoname` flag is
set — true for a chat created with a default name, cleared once auto-naming
succeeds or the user renames the chat (`Chat.rename`), and inherited by a
duplicate — so it never replaces a name the user chose. A failed attempt is
retried on a later send — at most one attempt per send, even across a
multi-thread send — up to `CHAT_AUTONAME_ATTEMPTS_MAX` (3) attempts, except a
failure that can't change on retry, which ends it at once: a JSON-RPC
`invalid_params`, `not_found`, `unauthenticated`, `forbidden`, …, or a provider
API status of 400, 401, 403, or 404 (from the error's `data.status`). The last
failure is logged and, while auto-naming still applies, shown as a tooltip on
the chat's name; renaming the chat clears it.

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
Anthropic and Gemini also drop any history before the first `user` message,
since both require the conversation to open with one. Gemini also merges
adjacent same-role messages into one multi-part content, keeping its
user/model alternation intact when the history has gaps.

The frontend builds the history (`render_completion_messages`) from each turn's
current content, so an edited assistant reply is what later requests send. It
skips disabled, errored, and blank turns, and drops assistant turns before the
first user turn — e.g. when the first user turn is disabled.
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

Every provider failure is an `internal_error` (-32603) whose message is
prefixed with the provider name. When the provider's API answered with a
non-2xx status, the error's `data` is
`{reason: 'provider_http_error', status}` with the upstream HTTP status
(`ai_provider_http_error`), so a client can tell a request that can't succeed
(400, 401, 403, 404 — e.g. a retired model) from one worth retrying (408,
429, 5xx).

Streaming responses carry usage: OpenAI requests it with
`stream_options.include_usage`, and Anthropic merges `message_start`'s input
counts with `message_delta`'s output counts.

### Stop Reasons

A response that arrives complete is still checked for why it stopped — the
same check runs on the streaming and non-streaming paths:

- **Refusals and blocks are errors** naming the provider's reason:
  Anthropic's `stop_reason: "refusal"` (with the `stop_details` category and
  explanation when present), OpenAI's `refusal` text (`message.refusal`, or
  `delta.refusal` when streaming — it never streams as reply text) and
  `finish_reason: "content_filter"`, and Gemini's `promptFeedback.blockReason`
  or any candidate `finishReason` other than `STOP` / `MAX_TOKENS` (`SAFETY`,
  `RECITATION`, `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `OTHER`, …). As with
  mid-stream errors, text that streamed in first stays on the turn.
- **Truncated replies pass through** with the provider's reason in the
  response data (`stop_reason: "max_tokens"` or
  `"model_context_window_exceeded"`, `finish_reason: "length"`,
  `finishReason: "MAX_TOKENS"`); the turn shows a "truncated (max tokens)"
  note, or "truncated (context window)" for Claude's
  `model_context_window_exceeded` (`Turn.truncation`, from
  `response_helpers.ts`).
- **A truncated reply with no text is an error**, since there is nothing to
  show — typically a reasoning model that spent its whole output budget
  thinking.

Every other stop reason is a normal success. The frontend reads Claude text
from every `text` content block, skipping `thinking` blocks.

### CompletionOptions

The backend's `CompletionOptions` (`provider/mod.rs`) holds the generation
settings each provider maps onto its API:

```
frequency_penalty?: number
output_token_max?: number
presence_penalty?: number
seed?: number
stop_sequences?: Array<string>
system_message: string
temperature?: number
top_k?: number
top_p?: number
```

They aren't configurable yet: `CompletionRequest` carries no options, and every
completion uses `CompletionOptions::default()` — everything unset and an empty
`system_message`, so each provider's own defaults apply.

`output_token_max` counts hidden reasoning/thinking tokens as well as the reply,
so a fixed cap sized for a chat model can starve a reasoning model. Unset, each
provider picks its own:

- **Anthropic** requires `max_tokens`, so the provider sends 64,000 when
  streaming (`OUTPUT_TOKEN_MAX_STREAMING`, within every current Claude model's
  output limit) and 16,000 otherwise (`OUTPUT_TOKEN_MAX_NON_STREAMING`, keeping
  a non-streaming request well inside the API's time limit).
- **OpenAI** and **Gemini** omit `max_completion_tokens` / `maxOutputTokens`,
  so the model's own output limit applies.

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
          → provider calls its API (stream: true when a progress token is present
            and the request came over WebSocket)
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
const result = await app.api.provider_load_status({provider_name: 'claude'});
// result.value.status:
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
