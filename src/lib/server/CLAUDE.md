# Server (Backend Reference Implementation)

This directory contains Zzz's backend server - a **reference implementation** using Hono and Deno. A Rust backend (`crates/zzz_server`) is in development — Phase 1 (ping, static files) is complete, validated by integration tests in `test/integration/` that run the same assertions against both backends. See [crates/CLAUDE.md](../../../crates/CLAUDE.md).

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

- JSON-RPC 2.0 API over HTTP (via fuz_app `create_rpc_endpoint`) and WebSocket
- Authentication (cookie sessions, bearer tokens, bootstrap flow) via fuz_app
- Database (PGlite in-memory for dev, PostgreSQL for production) via fuz_app
- AI provider integration (Ollama, Claude, ChatGPT, Gemini)
- Secure filesystem operations via `ScopedFs`
- File watching and change notifications
- Admin routes (accounts, permits, audit log, sessions, app settings)
- Origin-based request verification

## Files

| File                            | Purpose                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `create_zzz_app.ts`             | Shared app factory — `create_app_backend` + `create_app_server`     |
| `server_env.ts`                 | Env schema (extends `BaseServerEnv`) + loader                       |
| `server.ts`                     | Deno entry — calls factory, binds `Deno.serve`, daemon lifecycle    |
| `zzz_route_specs.ts`            | Route spec factory (auth, admin, RPC endpoint)                      |
| `zzz_rpc_actions.ts`            | RPC actions bridging Backend handlers to fuz_app `RpcAction` format |
| `routes/account.ts`             | Session config (`zzz_session_config`)                               |
| `db/zzz_schema.ts`              | Database schema init (auth migrations, zzz-specific DDL)            |
| `backend.ts`                    | `Backend` class - core domain state, file watchers, workspaces      |
| `backend_action_handlers.ts`    | Handler implementations for all backend actions (ActionPeer path)   |
| `backend_actions_api.ts`        | Backend-initiated notifications (streaming, file changes)           |
| `backend_provider.ts`           | Base classes for AI providers                                       |
| `backend_provider_ollama.ts`    | Ollama provider (local)                                             |
| `backend_provider_claude.ts`    | Claude/Anthropic provider (remote)                                  |
| `backend_provider_chatgpt.ts`   | OpenAI provider (remote)                                            |
| `backend_provider_gemini.ts`    | Google Gemini provider (remote)                                     |
| `scoped_fs.ts`                  | Secure filesystem wrapper                                           |
| `security.ts`                   | Host header validation middleware (DNS rebinding defense)           |
| `register_websocket_actions.ts` | WebSocket endpoint registration                                     |

**Generated files** (do not edit):

- `backend_action_types.ts` - Handler type definitions
- `backend_action_types.gen.ts` - Generated handler types

## Architecture

### Server Initialization Flow

```
server_env.ts: load_server_env(env_get, defaults)
    │
    ▼
create_zzz_app.ts: create_zzz_app({config, password, runtime, get_connection_ip})
    │
    ├── validate_server_env() — keyring + origin patterns from BaseServerEnv
    ├── create_app_backend() — DB + auth migrations
    ├── Create Backend instance (domain state: ScopedFs, Filer, handlers)
    ├── Add providers (Ollama, Claude, ChatGPT, Gemini)
    ├── create_app_server() with:
    │   ├── zzz_session_config (cookie auth)
    │   ├── Host validation via transform_middleware
    │   ├── Bootstrap flow (initial admin account)
    │   ├── create_zzz_app_route_specs() → auth + admin + RPC routes
    │   └── Audit log SSE
    └── Return {app, backend, app_backend, surface, env, close}
    │
    ▼
server.ts (Deno — dev via gro_plugin_deno_server, prod via zzz daemon start)
    ├── Load env, validate bind address
    ├── Call create_zzz_app()
    ├── Register WebSocket endpoint (with origin check)
    ├── Add /health endpoint
    ├── Write daemon.json
    └── Deno.serve + signal handlers
```

### Two Backends

zzz has two distinct "backend" concepts:

1. **`AppBackend`** (fuz_app) — database, auth migrations, keyring, password deps
2. **`Backend`** (zzz domain) — files, terminals, AI providers, workspaces, ActionPeer

The `AppBackend` is passed to `create_app_server` for auth infrastructure.
The zzz `Backend` is threaded through route deps for domain logic.

### Route Architecture

Routes are defined as data via fuz_app's route spec system:

```
create_zzz_app_route_specs(ctx, zzz_deps)
    ├── Health check route
    ├── Account routes (login, logout, status, sessions, tokens)
    ├── RPC endpoint (GET + POST /api/rpc) — 23 action methods
    └── Admin routes (accounts, audit log, app settings)
```

The RPC endpoint (`create_rpc_endpoint`) handles all zzz domain actions:

- Envelope parsing → method lookup → per-action auth → input validation → handler

### Auth Levels

| Auth            | Actions                                                         |
| --------------- | --------------------------------------------------------------- |
| `public`        | `ping`                                                          |
| `authenticated` | All file, terminal, workspace, completion, ollama, provider ops |
| `keeper`        | `provider_update_api_key`                                       |

### Request Flow (RPC)

```
HTTP POST /api/rpc
    ↓
fuz_app middleware (pending effects, logging, body limit, proxy, origin, session, request context, bearer auth)
    ↓
create_rpc_endpoint dispatcher:
    ├── Parse JSON-RPC envelope
    ├── Lookup RpcAction by method
    ├── Check auth (per-action)
    ├── Validate params (Zod)
    ├── Transaction scope (mutations vs reads)
    └── Call handler (captures Backend via closure)
    ↓
JSON-RPC response
```

### Request Flow (WebSocket)

```
GET /api/ws (upgrade)
    ↓
fuz_app middleware (session, request context, bearer auth)
    ↓
Origin verification middleware
    ↓
require_auth middleware (reject 401 if unauthenticated)
    ↓
register_websocket_actions handler (extract account_id, credential_type, token_hash)
    ↓
transport.add_connection(ws, token_hash, account_id)
    ↓
Per-action auth check (reject batch, check keeper/role auth)
    ↓
backend.receive(json) → ActionPeer lifecycle
    ↓
JSON-RPC response via WebSocket
```

## Environment Variables

### BaseServerEnv (from fuz_app)

| Variable               | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `NODE_ENV`             | `development` or `production`            |
| `PORT`                 | HTTP server port (default 4040)          |
| `HOST`                 | Bind address (default `localhost`)       |
| `DATABASE_URL`         | `memory://`, `file://`, or `postgres://` |
| `SECRET_COOKIE_KEYS`   | HMAC signing keys (min 32 chars)         |
| `ALLOWED_ORIGINS`      | Origin patterns for API verification     |
| `BOOTSTRAP_TOKEN_PATH` | One-shot admin bootstrap token path      |

### zzz-specific

| Variable                                   | Purpose                            |
| ------------------------------------------ | ---------------------------------- |
| `PUBLIC_ZZZ_DIR`                           | Zzz app directory (default `.zzz`) |
| `PUBLIC_ZZZ_SCOPED_DIRS`                   | Comma-separated filesystem paths   |
| `PUBLIC_BACKEND_ARTIFICIAL_RESPONSE_DELAY` | Testing delay (ms)                 |
| `SECRET_ANTHROPIC_API_KEY`                 | Claude API key                     |
| `SECRET_OPENAI_API_KEY`                    | OpenAI API key                     |
| `SECRET_GOOGLE_API_KEY`                    | Google Gemini API key              |

## Security

Four layers protect the daemon:

1. **Binding restriction** — refuses to start on `0.0.0.0`/`::` (until daemon token auth is wired)
2. **Host header validation** (`security.ts`) — rejects DNS rebinding attacks
3. **Origin/Referer verification** (fuz_app middleware) — rejects browser cross-origin requests
4. **Authentication** (fuz_app) — cookie sessions + bearer tokens, bootstrap flow for initial admin

### WebSocket Auth

WebSocket connections are authenticated at upgrade time, and per-action auth
is enforced on each message:

1. **Path under `/api/*`** — fuz_app's session + request_context middleware
   resolves the session cookie automatically. Bearer token auth (API tokens,
   daemon tokens) is also resolved.
2. **`require_auth` middleware** — rejects unauthenticated upgrades with 401.
3. **Auth extraction** — `register_websocket_actions` extracts the account ID,
   credential type, and (for session auth) hashed session token from the Hono
   context. Bearer token connections pass `null` for token_hash — they're still
   reachable via `close_sockets_for_account` but not `close_sockets_for_session`.
4. **Per-action auth** — Each incoming WS message is checked against the action
   spec's `auth` field before reaching `backend.receive()`. `keeper` actions
   require `daemon_token` credential type AND the keeper role (matching
   `require_keeper` parity). Role-based auth (`{role: string}`) is rejected
   as not yet supported. Batch JSON-RPC arrays are rejected. `public` and
   `authenticated` actions pass through (upgrade-time auth is sufficient).
5. **Audit event revocation** — `server.ts` hooks `on_audit_event` to close
   sockets on `session_revoke`, `logout`, `session_revoke_all`,
   `password_change`, `token_revoke`, and `token_revoke_all` events.

No per-message session revalidation — event-driven revocation via audit events
is sufficient. ActionPeer and Backend have no auth awareness; auth stays in the
transport and middleware layers.

## Adding Features

### Adding an Action (Full Workflow)

Adding a `request_response` action touches these files:

1. **Define spec** in `../action_specs.ts` — set appropriate `auth` level
2. **Run `gro gen`** — regenerates handler types
3. **Add RPC handler** in `zzz_rpc_actions.ts` — `{spec, handler}` in the actions array
4. **Add backend handler** in `backend_action_handlers.ts` — for ActionPeer (WebSocket) path
5. **Add frontend handler** in `../frontend_action_handlers.ts`

For `remote_notification` (server push): add to `BackendActionsApi` interface + impl.
