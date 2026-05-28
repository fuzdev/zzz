# Server (Backend Reference Implementation)

This directory contains Zzz's backend server - a **reference implementation** using Hono and Deno. A Rust backend (`crates/zzz_server`) is in development, validated by cross-process integration tests under `src/test/cross_backend/` that run the same assertions against both backends via a shared TS contract. See [crates/CLAUDE.md](../../../crates/CLAUDE.md).

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
- Admin surface (RPC): accounts, role_grants, audit log reads, sessions, invites, app settings — bundled via `create_standard_rpc_actions` on the same `/api/rpc` endpoint as zzz domain actions
- Origin-based request verification

## Files

| File                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_zzz_app.ts`             | Shared app factory — `create_app_backend` + `create_app_server`. Optional `extra_rpc_actions_factory` hook plumbs caller-supplied actions (used by the test binary to inject `_testing_reset` alongside env-gated `_testing_emit_notifications`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `server_env.ts`                 | Env schema (extends `BaseServerEnv`) + loader                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `server.ts`                     | Deno entry — calls factory, binds `Deno.serve`, daemon lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `testing_server_build.ts`       | zzz domain seams for the cross-process test binary. Keeps only what's zzz-specific: env loading (`resolve_zzz_testing_config`) + the `create_zzz_app` build with forced `enable_test_actions: true`, `stub_password_deps`, `_testing_reset` registration via fuz*app's `create_testing_actions` factory with the zzz `reset_state` closure (workspaces + terminals + optional `ZZZ_TESTING_SCRATCH_DIR`), and the WS mount hook. The runtime-neutral orchestration (serve, daemon-info, WS attach, drain) + the Node/Deno adapters now live in fuz_app's `testing/cross_backend/testing_server*{core,node,deno}.js`. **Never ships in a release.** |
| `testing_server_deno.ts`        | Deno spawn entry — thin wiring of fuz_app's `create_deno_testing_adapter` + `start_testing_server` onto `build_zzz_testing_app`. Counterpart to the Node entry; together they isolate the JS-runtime axis (Deno vs Node V8) on identical TS canonical surfaces. **Never ships in a release.**                                                                                                                                                                                                                                                                                                                                                      |
| `testing_server_node.ts`        | Node spawn entry — thin wiring of fuz_app's `create_node_testing_adapter` + `start_testing_server` onto `build_zzz_testing_app`. Mirrors the Rust `testing_zzz_server` posture for cross-process integration tests against the TS canonical backend. **Never ships in a release** — reaches into fuz_app's `testing/cross_backend/` modules which throw on production load.                                                                                                                                                                                                                                                                        |
| `zzz_route_specs.ts`            | Route spec factory (auth, admin, RPC endpoint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `zzz_action_handlers.ts`        | Handler factory `create_zzz_action_handlers(backend)` — single source of truth for all 23 actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `zzz_rpc_actions.ts`            | Thin adapter pairing factory-bound handlers with specs for fuz_app's `RpcAction` format                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `db/zzz_schema.ts`              | Database schema init (auth migrations, zzz-specific DDL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `backend.ts`                    | `Backend` class - core domain state, file watchers, workspaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `backend_actions_api.ts`        | Backend-initiated notifications (streaming, file changes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `backend_provider.ts`           | Base classes for AI providers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `backend_provider_ollama.ts`    | Ollama provider (local)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `backend_provider_claude.ts`    | Claude/Anthropic provider (remote)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `backend_provider_chatgpt.ts`   | OpenAI provider (remote)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `backend_provider_gemini.ts`    | Google Gemini provider (remote)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pty_backend.ts`                | Runtime-neutral `PtyBackend` / `PtySession` DI contract for terminal spawning. `PtyManager` delegates to an injected backend; the runtime is chosen at the server entry, never sniffed in the manager.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pty_backend_deno.ts`           | Deno `PtyBackend` — real PTY via `fuz_pty` FFI, `Deno.Command` pipe fallback. The only PTY module touching Deno globals. Injected by `server.ts` + `testing_server_deno.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pty_backend_node.ts`           | Node/Bun `PtyBackend` — `node:child_process` pipes (no real PTY). Injected by `testing_server_node.ts` + `testing_server_bun.ts`, where Deno FFI is unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pty_ffi.ts`                    | Deno FFI bindings for `libfuz_pty` (forkpty spawn/read/write/resize/close/kill/waitpid). Consumed only by `pty_backend_deno.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `backend_pty_manager.ts`        | `PtyManager` — terminal-id bookkeeping + `terminal_data`/`terminal_exited` fan-out. Delegates spawn/IO to the injected `PtyBackend`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `scoped_fs.ts`                  | Secure filesystem wrapper                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `security.ts`                   | Host header validation middleware (DNS rebinding defense)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `register_websocket_actions.ts` | Thin wrapper over fuz_app's `register_action_ws` — supplies specs, factory-bound handlers, and the pool `Db`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Architecture

### Handler Dispatch

All 23 request_response handlers are built by
`create_zzz_action_handlers(backend)` in `zzz_action_handlers.ts`. The
factory closes over the zzz `Backend` once at server boot; handlers
themselves receive fuz_app's unified `ActionContext` (auth, db,
request_id, notify, signal, …) — no zzz-specific context wrapper.
Both HTTP RPC and WebSocket transports dispatch into the same handler
map:

- **HTTP RPC** — `zzz_rpc_actions.ts` pairs each spec with the
  factory-bound handler and hands the array to fuz_app's
  `create_rpc_endpoint`. fuz_app owns envelope parsing, the
  authorization phase, per-action auth, and input validation.
- **WebSocket** — `register_websocket_actions.ts` is a thin wrapper
  over fuz_app's `register_action_ws`: zzz supplies `all_action_specs`,
  the handler map, and the pool-level `Db`. fuz_app owns envelope
  parsing, batch rejection, per-action auth, Zod validation,
  transaction scope, socket-scoped `notify`, and per-socket `signal`.

```
Per-request ctx (built by fuz_app's perform_action — see
`@fuzdev/fuz_app/actions/action_rpc.js`):
  ActionContext {
    auth: RequestContext | null;
    request_id: JsonrpcRequestId;
    connection_id?: Uuid;        // WS only
    db: Db;                      // transactional for side_effects: true
    pending_effects, post_commit_effects, client_ip, log;
    notify: (method, params) => void;
    signal: AbortSignal;
  }
```

### Server Initialization Flow

```
server_env.ts: load_server_env(env_get, defaults)
    │
    ▼
create_zzz_app.ts: create_zzz_app({config, password, runtime, get_connection_ip})
    │
    ├── validate_server_env() — keyring + origin patterns from BaseServerEnv
    ├── create_app_backend() — DB + auth migrations
    ├── Create Backend instance (domain state: ScopedFs, Filer)
    ├── Add providers (Ollama, Claude, ChatGPT, Gemini)
    ├── create_app_server() with:
    │   ├── fuz_session_config (cookie auth — from `@fuzdev/fuz_app/auth/session_cookie.js`)
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
2. **`Backend`** (zzz domain) — files, terminals, AI providers, workspaces, ActionPeer (notifications only)

The `AppBackend` is passed to `create_app_server` for auth infrastructure.
The zzz `Backend` is threaded through route deps for domain logic.

### Route Architecture

Routes are defined as data via fuz_app's route spec system:

```
create_zzz_app_route_specs(ctx, zzz_deps)
    ├── Health check route
    ├── Account routes (login, logout, password, verify, status) + server status
    └── Audit log SSE stream (admin)

(Bootstrap routes are factory-managed by `create_app_server` — mounted
under `/api/account` via the `bootstrap` option, not in
`create_zzz_app_route_specs`. Both backends now mount `/signup`: the
Deno backend via `create_signup_route_specs` in `create_zzz_app`'s
route set (added in cross-process 3d.4 Issue 5), the Rust backend via
`fuz_auth::signup_routes`. The cross-process test harness mints per-test
accounts through this production endpoint.)

build_rpc_endpoint_specs(ctx, zzz_deps) → /api/rpc
    ├── zzz domain actions (create_zzz_action_handlers(backend))
    └── create_standard_rpc_actions(ctx.deps)
        — admin (account list, sessions, audit log, invites, app settings)
        — role-grant-offer lifecycle (create / accept / decline / retract / list / history)
        — account self-service (verify, sessions, tokens)
```

The single RPC endpoint (auto-mounted by `create_app_server` from
`rpc_endpoints`) handles both zzz domain actions and the standard fuz_app
admin/role-grant-offer/account surface:

- Envelope parsing → method lookup → per-action auth → input validation → handler

### Auth Levels

zzz specs use fuz_app's four-axis `RouteAuth` shape (`{account, actor,
roles?, credential_types?}`). The three buckets in zzz today:

| Bucket        | Shape                                                                                             | Actions                                                         |
| ------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Public        | `{account: 'none', actor: 'none'}`                                                                | `ping`                                                          |
| Authenticated | `{account: 'required', actor: 'none'}`                                                            | All file, terminal, workspace, completion, ollama, provider ops |
| Keeper        | `{account: 'required', actor: 'required', roles: ['keeper'], credential_types: ['daemon_token']}` | `provider_update_api_key`                                       |

Keeper actions require both the `daemon_token` credential type (via
`X-Daemon-Token` header) AND the keeper role; the input schema must
declare `acting: ActingActor` (registry-time invariant 2 in fuz_app's
`auth/auth_shape.ts`). Session cookies and API tokens cannot access
keeper actions even if the account has the keeper role_grant. Enforced
on both HTTP RPC and WebSocket via the shared `perform_action` core in
fuz_app.

### Request Flow (RPC)

```
HTTP POST /api/rpc
    ↓
fuz_app middleware (pending effects, logging, body limit, proxy, origin, session, request context, bearer auth)
    ↓
create_rpc_endpoint dispatcher → perform_action:
    ├── Parse JSON-RPC envelope
    ├── Lookup RpcAction by method
    ├── Pre-validation auth (401 if account required but missing)
    ├── Authorization phase (resolve acting actor when actor !== 'none')
    ├── Post-authorization auth (roles / credential_types)
    ├── Validate params (Zod)
    ├── Rate limit (if spec.rate_limit set)
    ├── Transaction scope (mutations vs reads)
    └── Call factory-bound handler with ActionContext
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
fuz_app `register_action_ws` upgrade handler (extract account_id, credential_type, token_hash)
    ↓
transport.add_connection(ws, token_hash, account_id)
    ↓
fuz_app dispatch loop (per message → perform_action):
    ├── Reject batch, intercept cancel notifications, drop others
    ├── Pre-validation auth → authorization phase → post-auth gates
    ├── Spec lookup + Zod input validation
    ├── Transaction scope (mutations vs reads)
    ├── Build ActionContext (auth, db, request_id, connection_id, notify, signal, …)
    ├── Call factory-bound handler
    ├── DEV-only output validation
    └── JSON-RPC response
    ↓
JSON-RPC response via WebSocket
```

## Environment Variables

### BaseServerEnv (from fuz_app — ecosystem standard)

| Variable                 | Purpose                                  |
| ------------------------ | ---------------------------------------- |
| `NODE_ENV`               | `development` or `production`            |
| `PORT`                   | HTTP server port (default 4040)          |
| `HOST`                   | Bind address (default `localhost`)       |
| `DATABASE_URL`           | `memory://`, `file://`, or `postgres://` |
| `SECRET_FUZ_COOKIE_KEYS` | HMAC signing keys (min 32 chars)         |

### zzz-specific

| Variable                              | Purpose                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `FUZ_ALLOWED_ORIGINS`                 | Origin patterns for API verification                                       |
| `FUZ_BOOTSTRAP_TOKEN_PATH`            | One-shot admin bootstrap token path                                        |
| `PUBLIC_ZZZ_DIR`                      | Zzz app directory (default `.zzz`)                                         |
| `PUBLIC_ZZZ_SCOPED_DIRS`              | Comma-separated filesystem paths                                           |
| `PUBLIC_ZZZ_BACKEND_ARTIFICIAL_DELAY` | Testing delay (ms)                                                         |
| `ZZZ_ENABLE_TEST_ACTIONS`             | Register `_testing_*` actions on live dispatchers (integration tests only) |
| `SECRET_ANTHROPIC_API_KEY`            | Claude API key                                                             |
| `SECRET_OPENAI_API_KEY`               | OpenAI API key                                                             |
| `SECRET_GOOGLE_API_KEY`               | Google Gemini API key                                                      |

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
3. **Auth extraction** — fuz_app's `register_action_ws` extracts the account ID,
   credential type, (for session auth) hashed session token, and (for bearer
   auth) `api_token.id` from the Hono context. Bearer token connections pass
   `null` for token_hash — they're reachable via `close_sockets_for_token`
   (granular — only this token's sockets) and `close_sockets_for_account`
   (all sockets on the account), but not `close_sockets_for_session`.
4. **Per-action auth** — Each incoming WS message runs through the shared
   `perform_action` core: pre-validation auth (401 when account is required
   but missing), authorization phase (resolves the acting actor when
   `auth.actor !== 'none'`), and post-authorization gates (`roles`,
   `credential_types`). Keeper actions require the keeper role AND
   `daemon_token` credential type. Batch JSON-RPC arrays are rejected.
   Public and account-only actions skip the authorization phase.
5. **Audit event revocation** — `server.ts` appends fuz_app's
   `create_ws_auth_guard` and `create_ws_logout_closer` to
   `app_backend.deps.audit.on_event_chain`. The guard dispatches
   `session_revoke` → `close_sockets_for_session`, `token_revoke` →
   `close_sockets_for_token` (granular — only that token's sockets close),
   and `session_revoke_all` / `token_revoke_all` / `password_change` →
   `close_sockets_for_account`. The logout closer covers explicit logouts
   (account-scoped close) since fuz_app emits `logout`, not `session_revoke`,
   on user-initiated logout.

No per-message session revalidation — event-driven revocation via audit events
is sufficient. ActionPeer and Backend have no auth awareness; auth stays in the
transport and middleware layers.

## Adding Features

### Adding an Action (Full Workflow)

Adding a `request_response` action touches these files:

1. **Define spec** in `../action_specs.ts` — pick the four-axis auth shape
   (see the Auth Levels table). Actor-implying specs (`actor !== 'none'`)
   must declare `acting: ActingActor` on their input schema (registry-time
   invariant 2 in fuz_app's `auth/auth_shape.ts`).
2. **Run `gro gen`** — regenerates collection types
3. **Add handler** inside `create_zzz_action_handlers` in
   `zzz_action_handlers.ts` — pure function `(input, ctx) → output`. The
   factory closes over `backend`; handlers receive `ActionContext` directly.
4. **Add frontend handler** in `../frontend_action_handlers.ts`

Both HTTP RPC and WebSocket paths automatically pick up the new handler — no
separate registration needed. The RPC adapter iterates `all_action_specs` and
looks up handlers by method name.

For `remote_notification` (server push): the `BackendActionsApi` interface +
`broadcast_action_specs` array are regenerated by
`backend_action_types.gen.ts` — derived from any backend-initiated
`remote_notification` spec (excluding `streams` targets). Call
`backend.api.my_notification(input)` to broadcast.
