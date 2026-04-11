# zzz Rust Backend

Shadow implementation of the Deno/Hono server using axum. Same JSON-RPC 2.0
protocol, same wire format — the Deno server is ground truth and the
integration tests enforce identical behaviour between both backends.

Phase 1 scope: `ping`, `workspace_list`, `workspace_open`, and `workspace_close`
are implemented. No auth, no database. The purpose is to validate the build
pipeline, static file serving, protocol compatibility, and the App/Ctx/dispatch
pattern for handler dispatch. All other methods return `method_not_found`.

## Prerequisites

`private_fuz` must be checked out as a sibling directory:

```
~/dev/zzz/               (this repo)
~/dev/private_fuz/        (path dep: fuz_common)
```

If the path dep is missing, `cargo build` will fail with
`failed to read .../private_fuz/crates/fuz_common/Cargo.toml`.

## Build and Run

```bash
cargo build -p zzz_server
cargo clippy -p zzz_server        # workspace lints: pedantic + nursery

# Run (port defaults to 1174; add --static-dir after `gro build`)
./target/debug/zzz_server --port 1174 --static-dir ./build

# Quick smoke test
curl http://localhost:1174/health
curl -X POST http://localhost:1174/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"ping"}'
# → {"jsonrpc":"2.0","id":"1","result":{"ping_id":"1"}}
```

CLI args (`--port`, `--static-dir`) take precedence over env vars
(`ZZZ_PORT`, `ZZZ_STATIC_DIR`).

## Endpoints

| Method | Path      | Description                    |
|--------|-----------|--------------------------------|
| POST   | `/rpc`    | JSON-RPC 2.0 (HTTP transport)  |
| GET    | `/ws`     | JSON-RPC 2.0 (WebSocket)       |
| GET    | `/health` | Health check (`{"status":"ok"}`) |
| GET    | `/*`      | Static files (if `--static-dir`) |

Note: the Deno server uses `/api/rpc`; the Rust server uses `/rpc`. The
integration test configs handle this difference.

## Integration Tests

The key deliverable. Tests start a backend, run JSON-RPC assertions, and
stop it. Deno backend bootstraps auth (admin account + session cookie)
before tests. Rust backend runs unauthenticated (Phase 1, no auth).

**WS tests (both backends):** `ping_ws`, `parse_error_ws`,
`method_not_found_ws`, `invalid_request_ws`, `notification_ws`,
`multi_message_ws` — 6 tests verify identical WS behaviour.

**HTTP tests (both backends):** `null_id_is_invalid`, `parse_error_http`,
`parse_error_empty_body`, `method_not_found_http`, `invalid_request_*`
(4 variants), `notification_http` — 9 tests verify identical HTTP behaviour.
Error `data` field (Zod validation issues on Deno, absent on Rust) is
normalized before comparison — Rust omits `data` pending Phase 2 validation
detail support (see TODO in `rpc.rs`).

**HTTP tests (both backends):** `ping_http`, `ping_numeric_id` — ping handler
echoes the JSON-RPC request id back as `ping_id`. Both backends produce
identical responses.

**Cross-backend:** `health_check` — 1 test on both backends.

**Workspace tests (both backends):** `workspace_open_and_list` (open temp dir,
verify response shape, list includes workspace), `workspace_open_idempotent`
(open same path twice, same `opened_at`), `workspace_open_nonexistent`
(nonexistent path returns -32603), `workspace_close` (open, close, verify
removal from list, double-close returns error) — 4 tests. Shape assertions
handle Deno/Rust differences (populated vs empty `files`, additional Cell
fields). Double-close error code/status differs due to zzz/fuz_app
`ThrownJsonrpcError` class mismatch — test checks error presence, not code.

```bash
deno task test:integration --backend=rust   # Rust only
deno task test:integration --backend=deno   # Deno only
deno task test:integration --backend=both   # Both (default)
deno task test:integration --filter=ping    # Substring match on test name
```

The test runner (`test/integration/run.ts`) starts the backend via
`cargo run` or `deno task dev:start`, polls `/health` until ready, runs
the suite, then sends SIGTERM and waits for exit. Backend configs
(ports, paths) are in `test/integration/config.ts`.

Tests are **table-driven**: most cases are rows in `http_cases` and
`ws_cases` arrays — adding a test is adding one object. Special tests
(silence assertions, persistent connections, non-RPC endpoints) are
separate functions.

When running `--backend=both`, a comparison table shows per-test
timing with speedup multipliers (e.g. `2.08x faster`). Silence tests
(`notification_ws`) have a fixed wait floor and are excluded from
the overall comparison.

## Architecture

```
crates/zzz_server/src/
├── main.rs      # Entry, run() → Result pattern, graceful shutdown (CancellationToken)
├── handlers.rs  # App (server state), Ctx (per-request), dispatch, handler functions
├── rpc.rs       # JSON-RPC classify, error constructors, HTTP handler
├── ws.rs        # WebSocket upgrade + message loop
└── error.rs     # ServerError (Bind, Serve)
```

Uses `fuz_common::JsonRpcError` for the error object type (spec-compliant,
includes optional `data` field). Defines its own envelope types
(`JsonRpcResponse`, `JsonRpcErrorResponse`) because zzz classifies arbitrary
JSON-RPC messages via `Value` — `fuz_common`'s single response type targets
typed request/response.

**App/Ctx/dispatch pattern**: `App` holds long-lived server state (workspaces
in `RwLock<HashMap>`, future: `tokio-postgres` pool), constructed once in
`main`, wrapped in `Arc`. `Ctx` is per-request context (borrows `App` and
`request_id`), constructed by each transport before calling
`handlers::dispatch`. Future fields added lazily — `auth`, `db()` method
(handlers that don't need them don't pay). Dispatch is async for forward
compat (DB handlers will await); current handlers are sync with zero async
overhead. Match statement dispatch — zero overhead, compiler can inline.

Message classification (`rpc::classify`) parses raw `serde_json::Value` and
returns a `Classified` enum:

- **`Request`** (has `method` + valid `id` + `params`) → ready for dispatch
- **`Invalid`** (invalid envelope, bad id) → id + error
- **`Notification`** (has `method`, no `id`) → caller decides

The `Classified` enum is transport-agnostic. Each transport applies its
own semantics:

- **HTTP** (`rpc_handler`): maps error codes to HTTP statuses (matching
  `fuz_app`'s `jsonrpc_error_code_to_http_status`), rejects notifications
  as `invalid_request`
- **WS** (`ws.rs`): silences notifications

Both transports wrap all errors (including parse errors) in full JSON-RPC
envelopes `{jsonrpc, id, error}`. Both construct `Ctx` from `Arc<App>` and
the request id, then call `handlers::dispatch(method, params, &ctx)`.

Id validation matches `fuz_app`: id must be string or number (excludes
null, per MCP). Non-object values get `id: null`.

## Known Phase 1 Limitations

- Only `ping`, `workspace_list`, `workspace_open`, `workspace_close` — match dispatch in `handlers::dispatch()`
- No batch request support (JSON arrays)
- No auth, no database, no file operations
- No WebSocket connection tracking for broadcast notifications
- Minimal logging (`tracing::debug` for requests)

## Design Decisions

- **DB**: `tokio-postgres` with connection pool in `App`. Lazy `db()` method
  on `Ctx` — handlers that don't need DB don't pay for a pool checkout.
- **Dispatch is async**: forward compat for DB/IO handlers. Current handlers
  are sync (no await points, zero overhead). `#[allow(clippy::unused_async)]`.
- **Codegen**: action specs will generate Rust handler signatures and dispatch
  match arms once patterns stabilize. Goal: maximum performance + clean design.
- **`std::sync::RwLock`** (not tokio): current handlers are sync. When async
  handlers arrive, scope lock guards before await points (current pattern
  already does this). Switch to `tokio::sync::RwLock` only if needed.
- **TS unification next**: after Rust refinements, unify the 23 duplicate
  TypeScript handlers into a single file with shared dispatch. Fix
  `ThrownJsonrpcError` class mismatch (zzz vs fuz_app) during unification.
- **Path handling**: `workspace_open` canonicalizes (must exist, follows
  symlinks). `workspace_close` does pure HashMap lookup (clients send the
  normalized path back, no filesystem calls). Both normalize trailing `/`.
- **Error messages**: match Deno format — `"failed to open workspace: ..."`,
  `"workspace not open: ..."`. Include trailing `/` in error paths for parity
  with Deno's `resolve()` output. Tests verify message format prefixes.
- **UTF-8 paths**: explicit rejection via `to_str()` — no lossy replacement
  with U+FFFD. Fails fast on non-UTF-8 paths instead of silently corrupting.

## What's Next

Phase 2 (SAES design), Phase 3 (codegen from Zod specs), Phase 4 (full
action port). See the [Rust Backends quest](../../grimoire/quests/rust-backends.md).
