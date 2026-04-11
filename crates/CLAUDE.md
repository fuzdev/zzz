# zzz Rust Backend

Shadow implementation of the Deno/Hono server using axum. Same JSON-RPC 2.0
protocol, same wire format — the Deno server is ground truth and the
integration tests enforce identical behaviour between both backends.

Phase 1 scope: only `ping` is implemented. No auth, no database, no action
system. The purpose is to validate the build pipeline, static file serving,
and protocol compatibility. All other methods return `method_not_found`.

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
(4 variants), `notification_http` ��� 9 tests verify identical HTTP behaviour.
Error `data` field (Zod issues on Deno, absent on Rust) is stripped before
comparison since it's optional per JSON-RPC spec.

**HTTP tests (Rust only):** `ping_http`, `ping_numeric_id` — skipped on Deno
because the ping handler returns `{ping_id: 'rpc'}` instead of echoing the
request id. Needs `request_id` in `ActionContext` (fuz_app) + zzz handler update.

**Cross-backend:** `health_check` — 1 test on both backends.

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
├── main.rs    # Entry, run() → Result pattern, graceful shutdown (CancellationToken)
├── rpc.rs     # JSON-RPC dispatch, HTTP handler (uses fuz_common::JsonRpcError)
├── ws.rs      # WebSocket upgrade + message loop
└── error.rs   # ServerError (Bind, Serve)
```

Uses `fuz_common::JsonRpcError` for the error object type (spec-compliant,
includes optional `data` field). Defines its own envelope types
(`JsonRpcResponse`, `JsonRpcErrorResponse`) because zzz classifies arbitrary
JSON-RPC messages via `Value` — `fuz_common`'s single response type targets
typed request/response.

Message classification (`rpc::classify_and_dispatch`) parses raw
`serde_json::Value` and returns an `RpcOutcome` enum:

- **`Success`** (has `method` + valid `id`) → dispatch → id + result
- **`Error`** (invalid envelope, unknown method, bad id) → id + error
- **`Notification`** (has `method`, no `id`) → caller decides

The `RpcOutcome` enum is transport-agnostic. Each transport applies its
own semantics:

- **HTTP** (`rpc_handler`): maps error codes to HTTP statuses (matching
  `fuz_app`'s `jsonrpc_error_code_to_http_status`), wraps parse errors in
  full JSON-RPC envelopes, rejects notifications as `invalid_request`
- **WS** (`ws.rs`): sends bare parse errors, silences notifications

Id validation matches `fuz_app`: id must be string or number (excludes
null, per MCP). Non-object values get `id: null`.

## Known Phase 1 Limitations

- Only `ping` — hardcoded dispatch in `rpc::dispatch_method()`
- No batch request support (JSON arrays)
- No auth, no database, no file operations
- No WebSocket connection tracking for broadcast notifications
- Minimal logging (`tracing::debug` for requests)

## What's Next

Phase 2 (SAES design), Phase 3 (codegen from Zod specs), Phase 4 (full
action port). See the [Rust Backends quest](../../grimoire/quests/rust-backends.md).
