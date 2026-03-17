# Server (Backend Reference Implementation)

This directory contains Zzz's backend server - a **reference implementation** using Hono and Deno. The architecture demonstrated here may be implemented in Rust via `fuzd` in the future.

## Contents

- [Overview](#overview)
- [Files](#files)
- [Architecture](#architecture)
- [AI Providers](#ai-providers)
- [Security](#security)
- [Action Handling](#action-handling)
- [Adding Features](#adding-features)

## Overview

The server provides:

- JSON-RPC 2.0 API over HTTP and WebSocket
- AI provider integration (Ollama, Claude, ChatGPT, Gemini)
- Secure filesystem operations via `ScopedFs`
- File watching and change notifications
- Origin-based request verification

**Not included yet**: Authentication, database.

## Files

| File                             | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `create_zzz_app.ts`              | Shared app factory — Backend, providers, endpoints               |
| `server_env.ts`                  | Env loading (replaces `$env` for server)                         |
| `server.ts`                      | Deno entry — calls factory, binds `Deno.serve`, daemon lifecycle |
| `backend.ts`                     | `Backend` class - core state, action handling, file watchers     |
| `backend_action_handlers.ts`     | Handler implementations for all backend actions                  |
| `backend_actions_api.ts`         | Backend-initiated notifications (streaming, file changes)        |
| `backend_provider.ts`            | Base classes for AI providers                                    |
| `backend_provider_ollama.ts`     | Ollama provider (local)                                          |
| `backend_provider_claude.ts`     | Claude/Anthropic provider (remote)                               |
| `backend_provider_chatgpt.ts`    | OpenAI provider (remote)                                         |
| `backend_provider_gemini.ts`     | Google Gemini provider (remote)                                  |
| `scoped_fs.ts`                   | Secure filesystem wrapper                                        |
| `security.ts`                    | Origin verification middleware                                   |
| `register_http_actions.ts`       | HTTP endpoint registration                                       |
| `register_websocket_actions.ts`  | WebSocket endpoint registration                                  |
| `backend_websocket_transport.ts` | WebSocket transport implementation                               |
| `pty_ffi.ts`                     | Deno FFI bindings for `libfuz_pty.so` (PTY operations)           |
| `backend_pty_manager.ts`         | PTY process management (FFI real PTY or fallback pipes)          |
| `env_file_helpers.ts`            | `.env` file manipulation                                         |
| `helpers.ts`                     | Completion response persistence                                  |
| `server_helpers.ts`              | Server utilities                                                 |

**Generated files** (do not edit):

- `backend_action_types.ts` - Handler type definitions
- `backend_action_types.gen.ts` - Generated handler types

## Architecture

### Server Initialization Flow

Single Deno entry point calls the shared factory:

```
server_env.ts: load_server_env(env_get, defaults)
    │
    ▼
create_zzz_app.ts: create_zzz_app({env})
    │
    ├── Import upgradeWebSocket from hono/deno
    ├── Parse allowed_origins → security patterns
    ├── Create Hono app with logging + origin verification
    ├── Create Backend instance (ScopedFs, Filer, handlers)
    ├── Add providers (Ollama, Claude, ChatGPT, Gemini)
    ├── Register WebSocket endpoint
    ├── Register HTTP RPC endpoint
    └── Return {app, backend}
    │
    ▼
server.ts (Deno — dev via gro_plugin_deno_server, prod via zzz daemon start)
    ├── Load env from Deno.env.get
    ├── Call create_zzz_app()
    ├── Add /health endpoint
    ├── Write daemon.json via fuz_app write_daemon_info
    ├── Bind via Deno.serve
    └── Signal handlers for graceful shutdown
```

### Backend Class

The `Backend` class implements `ActionEventEnvironment`:

```typescript
class Backend implements ActionEventEnvironment {
	readonly executor = 'backend';
	readonly zzz_dir: DiskfileDirectoryPath;
	readonly config: ZzzConfig;
	readonly peer: ActionPeer;
	readonly api: BackendActionsApi;
	readonly scoped_fs: ScopedFs;
	readonly filers: Map<string, FilerInstance>;
	readonly action_registry: ActionRegistry;
	readonly providers: Array<BackendProvider>;

	lookup_action_handler(method, phase): Handler | undefined;
	lookup_action_spec(method): ActionSpecUnion | undefined;
	lookup_provider(name): BackendProvider;
	receive(message): Promise<JsonrpcMessage | null>;
	destroy(): Promise<void>;
}
```

### Request Flow

```
HTTP/WebSocket Request
    ↓
Hono middleware (logging, origin check)
    ↓
register_*_actions handler
    ↓
backend.receive(json)
    ↓
backend.peer.receive(message)
    ↓
ActionEvent lifecycle:
    ├── Parse input via Zod schema
    ├── Lookup handler: backend.lookup_action_handler(method, phase)
    ├── Execute handler
    └── Build response
    ↓
JSON-RPC response
```

## AI Providers

### Class Hierarchy

```
BackendProvider<TClient>
├── BackendProviderLocal<TClient>
│   └── BackendProviderOllama
└── BackendProviderRemote<TClient>
    ├── BackendProviderClaude
    ├── BackendProviderChatgpt
    └── BackendProviderGemini
```

### Provider Interface

```typescript
abstract class BackendProvider<TClient> {
	abstract readonly name: string;
	protected client: TClient | null;

	// Completion handling
	abstract handle_streaming_completion(options): Promise<CompletionResult>;
	abstract handle_non_streaming_completion(options): Promise<CompletionResult>;
	get_handler(streaming: boolean): CompletionHandler;

	// Client management
	abstract create_client(): void;
	abstract get_client(): TClient;

	// Status
	abstract load_status(reload?: boolean): Promise<ProviderStatus>;

	// Streaming helpers
	protected validate_streaming_requirements(progress_token): void;
	protected send_streaming_progress(progress_token, chunk): Promise<void>;
}
```

### Local vs Remote

**`BackendProviderLocal`** (Ollama):

- Creates client on construction
- `load_status()` checks if service is available locally

**`BackendProviderRemote`** (Claude, ChatGPT, Gemini):

- Requires API key to create client
- `set_api_key()` updates key and recreates client
- Returns error status if no API key configured

### Streaming Flow

```
Handler receives options with progress_token
    ↓
Call provider SDK with stream: true
    ↓
For each chunk:
    ├── Accumulate content
    └── provider.send_streaming_progress(progress_token, chunk)
            ↓
        backend.api.completion_progress({progressToken, chunk})
            ↓
        WebSocket broadcast to all clients
    ↓
Return final CompletionResult
```

## Security

### ScopedFs

Secure filesystem wrapper preventing path traversal and symlink attacks:

```typescript
class ScopedFs {
  constructor(allowed_paths: Array<string>);

  // All operations validate paths before execution
  read_file(path, options?): Promise<Buffer | string>;
  write_file(path, data, options?): Promise<void>;
  rm(path, options?): Promise<void>;
  mkdir(path, options?): Promise<string | undefined>;
  readdir(path, options?): Promise<Array<...>>;
  stat(path, options?): Promise<Stats>;
  copy_file(source, destination, mode?): Promise<void>;
  exists(path): Promise<boolean>;

  // Path validation
  is_path_allowed(path): boolean;
  is_path_safe(path): Promise<boolean>;
}
```

**Security features**:

- Paths normalized to prevent `../` traversal
- Absolute paths required
- Symlinks rejected (checked via `lstat`)
- Parent directories validated recursively
- Zod schema validation via `ScopedFsPath`

### Origin Verification

NOT CSRF protection - simple origin/referer allowlist:

```typescript
// Parse patterns from env
const patterns = parse_allowed_origins(ALLOWED_ORIGINS);

// Middleware checks requests
app.use(verify_request_source(patterns));
```

**Pattern support**:

- Exact: `https://api.example.com`
- Wildcard subdomain: `https://*.example.com`
- Wildcard port: `http://localhost:*`
- IPv6: `http://[::1]:3000`
- Combined: `https://*.example.com:*`

**Behavior**:

1. Check `Origin` header first
2. Fall back to `Referer` header
3. Allow requests without either (curl, direct access)

## Action Handling

### Handler Structure

Handlers are organized by method and phase:

```typescript
const backend_action_handlers: BackendActionHandlers = {
	completion_create: {
		receive_request: async ({backend, data: {input}}) => {
			// Extract request data
			const {prompt, provider_name, model} = input.completion_request;

			// Get provider and handler
			const provider = backend.lookup_provider(provider_name);
			const handler = provider.get_handler(!!progress_token);

			// Execute and return
			return await handler(options);
		},
	},

	diskfile_update: {
		receive_request: async ({backend, data: {input}}) => {
			await backend.scoped_fs.write_file(input.path, input.content);
			return null;
		},
	},
};
```

### Error Handling

```typescript
// Throw structured errors
throw jsonrpc_errors.invalid_params('Missing required field');
throw jsonrpc_errors.ai_provider_error(provider_name, error_message);
throw jsonrpc_errors.internal_error('Operation failed');

// Let ThrownJsonrpcError bubble through
if (error instanceof ThrownJsonrpcError) {
	throw error;
}
```

### Backend-Initiated Notifications

Via `backend.api`:

```typescript
// File change notification
await backend.api.filer_change({
	change: {type: 'update', path},
	disknode: serializable_disknode,
});

// Streaming progress
await backend.api.completion_progress({
	chunk: 'partial response...',
	_meta: {progressToken: turn_id},
});

// Ollama model loading progress
await backend.api.ollama_progress({
	status: 'downloading',
	completed: 50,
	total: 100,
	_meta: {progressToken},
});
```

## PTY Management

Terminal processes are managed by `PtyManager` in `backend_pty_manager.ts`.
On construction, it checks `is_ffi_available()` from `pty_ffi.ts` to select
between two modes:

**FFI mode** (real PTY): Loads `libfuz_pty.so` via `Deno.dlopen()`. Uses
`forkpty()` for a single merged output stream with echo, prompts, colors,
and resize support. The read loop polls the master fd with 10ms delay on
EAGAIN. Requires `--allow-ffi` (set in `gro.config.ts`).

**Fallback mode** (pipes): Uses `Deno.Command` with piped stdin/stdout/stderr.
No echo, no prompt, no interactivity. stdout and stderr race into xterm.
Used when `libfuz_pty.so` is not found.

Build the library: `cd ~/dev/private_fuz && cargo build -p fuz_pty --release`

The mode is logged on startup: `PTY mode: FFI (real PTY)` or
`PTY mode: fallback (Deno.Command pipes)`.

## Adding Features

### Adding an Action (Full Workflow)

Adding a `request_response` action touches 4-6 files:

1. **Define spec** in `../action_specs.ts` — add to `all_action_specs` array
2. **Run `gro gen`** — regenerates `BackendActionHandlers` type and 3 other files
3. **Add backend handler** in `backend_action_handlers.ts`
4. **Add frontend handler** in `../frontend_action_handlers.ts`
5. **Call from frontend** via `app.api.method_name(input)` — returns `Result`
6. **For `remote_notification` only**: add to `BackendActionsApi` interface + impl

Backend handler:

```typescript
my_action: {
  receive_request: async ({backend, data: {input}}) => {
    const {param} = input; // typed from spec
    const result = await doSomething(param);
    return {result}; // must match spec output schema
  },
},
```

Frontend handler (for `request_response`):

```typescript
my_action: {
  receive_response: ({app, data: {output}}) => { /* update UI state */ },
  receive_error: ({data: {error}}) => { console.error(error); },
},
```

Frontend handler (for `remote_notification`):

```typescript
my_notification: {
  receive: ({app, data: {input}}) => { /* handle push from backend */ },
},
```

Frontend call:

```typescript
const result = await app.api.my_action({param: 'value'});
if (result.ok) {
	// result.value is typed from the output schema
} else {
	// result.error has code, message, data
}
```

### Adding a Provider

1. Create `backend_provider_newprovider.ts`:

```typescript
import {BackendProviderRemote} from './backend_provider.js';

export class BackendProviderNewProvider extends BackendProviderRemote<SDKClient> {
	readonly name = 'newprovider';

	constructor(options: BackendProviderOptions) {
		const api_key = process.env.SECRET_NEWPROVIDER_API_KEY;
		super({...options, api_key});
	}

	protected create_client(): void {
		this.client = this.api_key ? new SDKClient({apiKey: this.api_key}) : null;
	}

	async handle_streaming_completion(options): Promise<CompletionResult> {
		this.validate_streaming_requirements(options.progress_token);
		const client = this.get_client();
		// ... implementation
	}

	async handle_non_streaming_completion(options): Promise<CompletionResult> {
		const client = this.get_client();
		// ... implementation
	}
}
```

2. Register in `create_zzz_app.ts`:

```typescript
backend.add_provider(new BackendProviderNewProvider(provider_options));
```

3. Add response helper in `../response_helpers.ts`

### Adding a Backend Notification

1. Define spec in `../action_specs.ts` with `kind: 'remote_notification'`
2. Run `gro gen`
3. Add to `BackendActionsApi` interface in `backend_actions_api.ts`
4. Implement in `create_backend_actions_api()`:

```typescript
my_notification: async (input) => {
  const event = create_action_event(backend, my_notification_spec, input, 'send');
  await event.parse().handle_async();
  if (event.data.step === 'handled' && event.data.notification) {
    await backend.peer.send(event.data.notification);
  }
},
```

## Environment Variables

| Variable                   | Purpose                                         |
| -------------------------- | ----------------------------------------------- |
| `ALLOWED_ORIGINS`          | Comma-separated origin patterns                 |
| `SECRET_ANTHROPIC_API_KEY` | Claude API key                                  |
| `SECRET_OPENAI_API_KEY`    | OpenAI API key                                  |
| `SECRET_GOOGLE_API_KEY`    | Google Gemini API key                           |
| `PUBLIC_ZZZ_DIR`           | Zzz app directory (default `.zzz`)              |
| `PUBLIC_ZZZ_SCOPED_DIRS`   | Comma-separated filesystem paths for user files |

## Constants

From `../constants.ts` (**frontend/SvelteKit only** — server uses `server_env.ts`):

| Constant                            | Purpose                  |
| ----------------------------------- | ------------------------ |
| `SERVER_HOST`                       | Server hostname          |
| `SERVER_PROXIED_PORT`               | Server port              |
| `WEBSOCKET_PATH`                    | WebSocket endpoint path  |
| `API_PATH_FOR_HTTP_RPC`             | HTTP RPC endpoint path   |
| `ZZZ_DIR`                           | Zzz app directory        |
| `ZZZ_SCOPED_DIRS`                   | Parsed scoped dirs array |
| `ZZZ_DIR_STATE`                     | `state` subdirectory     |
| `ZZZ_DIR_RUN`                       | `run` subdirectory       |
| `ZZZ_DIR_CACHE`                     | `cache` subdirectory     |
| `BACKEND_ARTIFICIAL_RESPONSE_DELAY` | Testing delay (ms)       |
