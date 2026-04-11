/**
 * Integration test suite for zzz backends.
 *
 * Tests JSON-RPC 2.0 over HTTP and WebSocket, asserting identical behaviour
 * between the Deno reference backend and the Rust backend.
 *
 * Most tests are data-driven tables (http_cases, ws_cases) — adding a test
 * case is just adding a row. Special tests that need unique control flow
 * (silence assertions, persistent connections, non-RPC endpoints) are
 * separate functions in `special_tests`.
 */

import {INTEGRATION_SCOPED_DIR, type BackendConfig} from './config.ts';

export interface TestResult {
	name: string;
	passed: boolean;
	duration_ms: number;
	error?: string;
}

// -- Helpers ------------------------------------------------------------------

const rpc_url = (config: BackendConfig): string => `${config.base_url}${config.rpc_path}`;
const ws_url = (config: BackendConfig): string => {
	const url = new URL(config.ws_path, config.base_url);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.href;
};

/** POST a raw string body to the RPC endpoint. */
const post_rpc = async (
	config: BackendConfig,
	body: string,
	session_cookie?: string,
): Promise<{status: number; body: unknown}> => {
	const headers: Record<string, string> = {'Content-Type': 'application/json'};
	if (session_cookie) headers['Cookie'] = session_cookie;
	const res = await fetch(rpc_url(config), {
		method: 'POST',
		headers,
		body,
	});
	const json = await res.json();
	return {status: res.status, body: json};
};

// -- WebSocket helpers --------------------------------------------------------

/** Persistent WebSocket connection handle for multi-message tests. */
interface WsConnection {
	send(message: string): void;
	receive(timeout_ms?: number): Promise<unknown>;
	expect_silence(timeout_ms?: number): Promise<void>;
	close(): void;
}

/** Open a WebSocket connection, resolves once connected. */
const open_ws = (config: BackendConfig, session_cookie?: string): Promise<WsConnection> =>
	new Promise((resolve, reject) => {
		// Deno's WebSocket supports a headers option (non-standard extension)
		const ws_options: {headers: Record<string, string>} | undefined = session_cookie
			? {headers: {Cookie: session_cookie}}
			: undefined;
		const ws = new WebSocket(ws_url(config), ws_options as unknown as string[]);
		const pending: Array<{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			silent: boolean;
		}> = [];

		ws.onmessage = (event) => {
			const data = JSON.parse(String(event.data));
			const waiter = pending.shift();
			if (!waiter) return;
			clearTimeout(waiter.timer);
			if (waiter.silent) {
				waiter.reject(new Error(`expected no response, got: ${JSON.stringify(data)}`));
			} else {
				waiter.resolve(data);
			}
		};

		ws.onerror = (event) => {
			const err = new Error(`WebSocket error: ${event}`);
			if (pending.length > 0) {
				const waiter = pending.shift()!;
				clearTimeout(waiter.timer);
				waiter.reject(err);
			} else {
				reject(err);
			}
		};

		ws.onopen = () =>
			resolve({
				send: (message) => ws.send(message),
				receive: (timeout_ms = 5_000) =>
					new Promise((res, rej) => {
						const timer = setTimeout(() => {
							pending.shift();
							rej(new Error('WebSocket response timeout'));
						}, timeout_ms);
						pending.push({resolve: res, reject: rej, timer, silent: false});
					}),
				expect_silence: (timeout_ms = 1_000) =>
					new Promise((res, rej) => {
						const timer = setTimeout(() => {
							pending.shift();
							res();
						}, timeout_ms);
						pending.push({resolve: res, reject: rej, timer, silent: true});
					}),
				close: () => ws.close(),
			});
	});

// -- Assertion helpers --------------------------------------------------------

const assert_equal = (actual: unknown, expected: unknown, label: string): void => {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
};

/** Recursively sort object keys so key order doesn't affect comparison. */
const sort_keys = (v: unknown): unknown => {
	if (v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.map(sort_keys);
	const sorted: Record<string, unknown> = {};
	for (const k of Object.keys(v as Record<string, unknown>).sort()) {
		sorted[k] = sort_keys((v as Record<string, unknown>)[k]);
	}
	return sorted;
};

/** Exact deep equality (key-order-independent). */
const assert_deep_equal = (actual: unknown, expected: unknown, label: string): void => {
	const a = JSON.stringify(sort_keys(actual));
	const e = JSON.stringify(sort_keys(expected));
	if (a !== e) {
		throw new Error(`${label}\n  expected: ${e}\n  actual:   ${a}`);
	}
};

/**
 * Omit `error.data` from a JSON-RPC error response ONLY when the expected
 * response doesn't specify it. This handles a known asymmetry: Deno (fuz_app)
 * includes Zod validation issues in `error.data`, Rust omits it pending
 * Phase 2 validation detail support. See TODO in `crates/zzz_server/src/rpc.rs`.
 *
 * NOT a general tolerance — if expected specifies `error.data`, exact match
 * is enforced. If actual has unexpected non-data fields, the comparison fails.
 */
const normalize_error_data = (
	actual: unknown,
	expected: unknown,
): {actual: unknown; expected: unknown} => {
	if (
		actual !== null &&
		typeof actual === 'object' &&
		!Array.isArray(actual) &&
		expected !== null &&
		typeof expected === 'object' &&
		!Array.isArray(expected)
	) {
		const a = actual as Record<string, unknown>;
		const e = expected as Record<string, unknown>;
		if (
			'error' in a &&
			typeof a.error === 'object' &&
			a.error !== null &&
			'error' in e &&
			typeof e.error === 'object' &&
			e.error !== null
		) {
			const a_err = a.error as Record<string, unknown>;
			const e_err = e.error as Record<string, unknown>;
			// Only omit if actual has data but expected doesn't mention it
			if ('data' in a_err && !('data' in e_err)) {
				const {data: _, ...a_err_rest} = a_err;
				return {actual: {...a, error: a_err_rest}, expected};
			}
		}
	}
	return {actual, expected};
};

// == Table-driven test cases ==================================================
//
// Each row is a test. The runner posts the body, asserts the status and
// response. To add a test case, add a row — no function needed.

/** HTTP test case: POST body → assert status + response. */
interface HttpCase {
	readonly name: string;
	/** Object → JSON.stringify'd, string → sent raw. */
	readonly body: unknown;
	readonly status: number;
	/** Expected response body. Use `assert_equal` for primitives, `assert_deep_equal` for objects. */
	readonly expected: unknown;
	/** Optional comment shown in test output on failure. */
	readonly comment?: string;
	/** Skip for specific backends. */
	readonly skip?: readonly string[];
}

/** WebSocket test case: send message → assert response. */
interface WsCase {
	readonly name: string;
	/** Always sent as a string (raw text frame). Object bodies need JSON.stringify in the value. */
	readonly message: string;
	readonly expected: unknown;
	readonly comment?: string;
	readonly skip?: readonly string[];
}

// -- HTTP cases ---------------------------------------------------------------

// Rust backend wire format aligned with fuz_app's create_rpc_endpoint (2026-04-11).
// HTTP status mapping, parse error envelopes, notification rejection, and id
// validation now match Deno. All tests pass on both backends with 0 skips.
const http_cases: readonly HttpCase[] = [
	// Ping — happy path
	{
		name: 'ping_http',
		body: {jsonrpc: '2.0', id: 'test-1', method: 'ping'},
		status: 200,
		expected: {jsonrpc: '2.0', id: 'test-1', result: {ping_id: 'test-1'}},
	},
	{
		name: 'ping_numeric_id',
		body: {jsonrpc: '2.0', id: 42, method: 'ping'},
		status: 200,
		expected: {jsonrpc: '2.0', id: 42, result: {ping_id: 42}},
	},
	{
		name: 'null_id_is_invalid',
		body: {jsonrpc: '2.0', id: null, method: 'nonexistent'},
		status: 400,
		expected: {
			jsonrpc: '2.0',
			id: null,
			error: {code: -32600, message: 'invalid request'},
		},
		comment: 'id:null is not a valid JsonrpcRequestId (string|number only, per MCP)',
	},

	// Parse errors — full JSON-RPC envelope, HTTP 400
	{
		name: 'parse_error_http',
		body: 'not json at all',
		status: 400,
		expected: {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error'}},
	},
	{
		name: 'parse_error_empty_body',
		body: '',
		status: 400,
		expected: {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error'}},
	},

	// Method not found — HTTP 404
	{
		name: 'method_not_found_http',
		body: {jsonrpc: '2.0', id: 'mnf-1', method: 'nonexistent'},
		status: 404,
		expected: {
			jsonrpc: '2.0',
			id: 'mnf-1',
			error: {code: -32601, message: 'method not found: nonexistent'},
		},
	},

	// Invalid requests — HTTP 400
	{
		name: 'invalid_request_missing_method',
		body: {jsonrpc: '2.0', id: 'ir-1'},
		status: 400,
		expected: {jsonrpc: '2.0', id: 'ir-1', error: {code: -32600, message: 'invalid request'}},
		comment: 'valid JSON-RPC object with id but no method',
	},
	{
		name: 'invalid_request_not_object',
		body: '"just a string"',
		status: 400,
		expected: {
			jsonrpc: '2.0',
			id: null,
			error: {code: -32600, message: 'invalid request'},
		},
		comment: 'non-object body — fuz_app safeParse returns id: null',
	},
	{
		name: 'invalid_request_bad_version',
		body: {jsonrpc: '1.0', id: 'bv-1', method: 'ping'},
		status: 400,
		expected: {jsonrpc: '2.0', id: 'bv-1', error: {code: -32600, message: 'invalid request'}},
		comment: 'wrong jsonrpc version',
	},
	{
		name: 'invalid_request_missing_version',
		body: {id: 'mv-1', method: 'ping'},
		status: 400,
		expected: {jsonrpc: '2.0', id: 'mv-1', error: {code: -32600, message: 'invalid request'}},
		comment: 'missing jsonrpc field entirely',
	},

	// Notifications — has method but no id → rejected on HTTP
	{
		name: 'notification_http',
		body: {jsonrpc: '2.0', method: 'ping'},
		status: 400,
		expected: {
			jsonrpc: '2.0',
			id: null,
			error: {code: -32600, message: 'invalid request'},
		},
		comment: 'HTTP requires id — notifications rejected until WS Phase 5',
	},
];

// -- WebSocket cases ----------------------------------------------------------

const ws_cases: readonly WsCase[] = [
	{
		name: 'ping_ws',
		message: JSON.stringify({jsonrpc: '2.0', id: 'ws-1', method: 'ping'}),
		expected: {jsonrpc: '2.0', id: 'ws-1', result: {ping_id: 'ws-1'}},
	},
	{
		name: 'parse_error_ws',
		message: 'not json at all',
		expected: {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error'}},
	},
	{
		name: 'method_not_found_ws',
		message: JSON.stringify({jsonrpc: '2.0', id: 'mnf-ws-1', method: 'nonexistent'}),
		expected: {
			jsonrpc: '2.0',
			id: 'mnf-ws-1',
			error: {code: -32601, message: 'method not found: nonexistent'},
		},
	},
	{
		name: 'invalid_request_ws',
		message: JSON.stringify({jsonrpc: '2.0', id: 'ir-ws-1'}),
		expected: {
			jsonrpc: '2.0',
			id: 'ir-ws-1',
			error: {code: -32600, message: 'invalid request'},
		},
		comment: 'missing method over WS',
	},
];

// == Special tests ============================================================
//
// Tests that need unique control flow: silence assertions, persistent
// connections, non-RPC endpoints.

type TestFn = (config: BackendConfig, session_cookie?: string) => Promise<void>;

const special_tests: ReadonlyArray<{name: string; fn: TestFn}> = [
	{
		name: 'notification_ws',
		fn: async (config, session_cookie) => {
			// Notification over WS → no response sent
			const conn = await open_ws(config, session_cookie);
			try {
				conn.send(JSON.stringify({jsonrpc: '2.0', method: 'ping'}));
				await conn.expect_silence();
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'multi_message_ws',
		fn: async (config, session_cookie) => {
			// Multiple messages on one connection — verify it stays alive
			const conn = await open_ws(config, session_cookie);
			try {
				conn.send(JSON.stringify({jsonrpc: '2.0', id: 'multi-1', method: 'ping'}));
				const r1 = await conn.receive();
				assert_deep_equal(
					r1,
					{jsonrpc: '2.0', id: 'multi-1', result: {ping_id: 'multi-1'}},
					'first',
				);

				conn.send(JSON.stringify({jsonrpc: '2.0', id: 'multi-2', method: 'ping'}));
				const r2 = await conn.receive();
				assert_deep_equal(
					r2,
					{jsonrpc: '2.0', id: 'multi-2', result: {ping_id: 'multi-2'}},
					'second',
				);
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'health_check',
		fn: async (config) => {
			const res = await fetch(`${config.base_url}${config.health_path}`);
			assert_equal(res.status, 200, 'status');
			const body = await res.json();
			assert_equal(body.status, 'ok', 'health status');
		},
	},
	{
		name: 'workspace_open_and_list',
		fn: async (config, session_cookie) => {
			const tmp_dir = await Deno.makeTempDir({prefix: 'zzz_test_'});
			try {
				// 1. Open workspace
				const open_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wo-1',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					session_cookie,
				);
				assert_equal(open_res.status, 200, 'open status');
				const open_rpc = open_res.body as Record<string, unknown>;
				assert_equal(open_rpc.id, 'wo-1', 'open id');
				const open_result = open_rpc.result as Record<string, unknown>;
				const workspace = open_result.workspace as Record<string, unknown>;

				// Shape assertions — handles Deno/Rust differences
				assert_equal(typeof workspace.path, 'string', 'path is string');
				assert_equal((workspace.path as string).endsWith('/'), true, 'path ends with /');
				assert_equal(typeof workspace.name, 'string', 'name is string');
				assert_equal(typeof workspace.opened_at, 'string', 'opened_at is string');
				assert_equal(Array.isArray(open_result.files), true, 'files is array');

				// 2. List workspaces — opened workspace must appear
				const list_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wl-1',
						method: 'workspace_list',
					}),
					session_cookie,
				);
				assert_equal(list_res.status, 200, 'list status');
				const list_rpc = list_res.body as Record<string, unknown>;
				const list_result = list_rpc.result as Record<string, unknown>;
				const workspaces = list_result.workspaces as Array<Record<string, unknown>>;
				assert_equal(Array.isArray(workspaces), true, 'workspaces is array');
				const found = workspaces.some((w) => w.path === workspace.path);
				assert_equal(found, true, 'opened workspace in list');
			} finally {
				await Deno.remove(tmp_dir, {recursive: true});
			}
		},
	},
	{
		name: 'workspace_open_idempotent',
		fn: async (config, session_cookie) => {
			const tmp_dir = await Deno.makeTempDir({prefix: 'zzz_test_'});
			try {
				// Open same path twice
				const r1 = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wi-1',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					session_cookie,
				);
				assert_equal(r1.status, 200, 'first open status');
				const w1 = ((r1.body as Record<string, unknown>).result as Record<string, unknown>)
					.workspace as Record<string, unknown>;

				const r2 = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wi-2',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					session_cookie,
				);
				assert_equal(r2.status, 200, 'second open status');
				const w2 = ((r2.body as Record<string, unknown>).result as Record<string, unknown>)
					.workspace as Record<string, unknown>;

				// Same opened_at — workspace was not re-created
				assert_equal(w1.opened_at, w2.opened_at, 'same opened_at');
				assert_equal(w1.path, w2.path, 'same path');
			} finally {
				await Deno.remove(tmp_dir, {recursive: true});
			}
		},
	},
	{
		name: 'workspace_open_nonexistent',
		fn: async (config, session_cookie) => {
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'wne-1',
					method: 'workspace_open',
					params: {path: `/tmp/zzz_nonexistent_${Date.now()}`},
				}),
				session_cookie,
			);
			assert_equal(res.status, 500, 'status');
			const r = res.body as Record<string, unknown>;
			assert_equal(r.id, 'wne-1', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32603, 'error code');
			assert_equal(
				(error.message as string).startsWith(
					'failed to open workspace: directory does not exist:',
				),
				true,
				'error message format',
			);
		},
	},
	{
		name: 'auth_required_without_cookie',
		fn: async (config) => {
			// Authenticated action without any Cookie header → 401
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'auth-1',
					method: 'workspace_list',
				}),
				// no session_cookie
			);
			assert_equal(status, 401, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'auth-1', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32001, 'error code');
			assert_equal(error.message, 'unauthenticated', 'error message');
		},
	},
	{
		name: 'auth_required_invalid_cookie',
		fn: async (config) => {
			// Authenticated action with garbage cookie → 401
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'auth-2',
					method: 'workspace_list',
				}),
				'fuz_session=garbage-invalid-cookie-value',
			);
			assert_equal(status, 401, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'auth-2', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32001, 'error code');
			assert_equal(error.message, 'unauthenticated', 'error message');
		},
	},
	{
		name: 'auth_public_no_cookie',
		fn: async (config) => {
			// Public action without any Cookie header → 200 success
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'auth-3',
					method: 'ping',
				}),
				// no session_cookie
			);
			assert_equal(status, 200, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'auth-3', 'id');
			const result = r.result as Record<string, unknown>;
			assert_equal(result.ping_id, 'auth-3', 'ping_id');
		},
	},
	{
		name: 'workspace_close',
		fn: async (config, session_cookie) => {
			const tmp_dir = await Deno.makeTempDir({prefix: 'zzz_test_'});
			try {
				// 1. Open workspace
				const open_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wc-open',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					session_cookie,
				);
				assert_equal(open_res.status, 200, 'open status');
				const workspace = (
					(open_res.body as Record<string, unknown>).result as Record<string, unknown>
				).workspace as Record<string, unknown>;

				// 2. Close workspace — use the normalized path from open response
				const close_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wc-close',
						method: 'workspace_close',
						params: {path: workspace.path},
					}),
					session_cookie,
				);
				assert_equal(close_res.status, 200, 'close status');
				const close_rpc = close_res.body as Record<string, unknown>;
				assert_equal(close_rpc.result, null, 'close result is null');

				// 3. List — workspace should be gone
				const list_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wc-list',
						method: 'workspace_list',
					}),
					session_cookie,
				);
				assert_equal(list_res.status, 200, 'list status');
				const list_result = (list_res.body as Record<string, unknown>).result as Record<
					string,
					unknown
				>;
				const workspaces = list_result.workspaces as Array<Record<string, unknown>>;
				const found = workspaces.some((w) => w.path === workspace.path);
				assert_equal(found, false, 'closed workspace not in list');

				// 4. Close again — should error (not open)
				// Rust returns -32602 (invalid_params, 400); Deno returns -32603
				// (internal_error, 500) due to ThrownJsonrpcError class mismatch
				// between zzz and fuz_app (see TODO in src/lib/jsonrpc_errors.ts)
				const close2_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wc-close2',
						method: 'workspace_close',
						params: {path: workspace.path},
					}),
					session_cookie,
				);
				assert_equal(close2_res.status >= 400, true, 'double close fails');
				const close2_rpc = close2_res.body as Record<string, unknown>;
				const error = close2_rpc.error as Record<string, unknown>;
				assert_equal(typeof error.code, 'number', 'double close has error code');
				assert_equal(
					(error.message as string).startsWith('workspace not open:'),
					true,
					'double close error message format',
				);
			} finally {
				await Deno.remove(tmp_dir, {recursive: true});
			}
		},
	},

	// -- WebSocket auth tests -----------------------------------------------------
	{
		name: 'ws_auth_required',
		fn: async (config) => {
			// Attempt WebSocket connect without cookies → should be rejected
			const url = ws_url(config);
			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(url);
				const timer = setTimeout(() => {
					ws.close();
					reject(new Error('WebSocket timeout — expected rejection'));
				}, 5_000);

				ws.onopen = () => {
					clearTimeout(timer);
					ws.close();
					reject(new Error('WebSocket connected without auth — expected rejection'));
				};

				ws.onerror = () => {
					clearTimeout(timer);
					// Error before open = connection rejected (401 at upgrade)
					resolve();
				};

				ws.onclose = (event) => {
					clearTimeout(timer);
					// Closed without ever opening = rejection
					if (event.code !== 1000) {
						resolve();
					} else {
						reject(new Error('WebSocket closed normally — expected rejection'));
					}
				};
			});
		},
	},

	// -- Session load + provider status -------------------------------------------
	{
		name: 'session_load_basic',
		fn: async (config, session_cookie) => {
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'sl-1',
					method: 'session_load',
				}),
				session_cookie,
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.id, 'sl-1', 'id');
			const result = rpc.result as Record<string, unknown>;
			const data = result.data as Record<string, unknown>;
			assert_equal(typeof data.zzz_dir, 'string', 'zzz_dir is string');
			assert_equal(Array.isArray(data.scoped_dirs), true, 'scoped_dirs is array');
			assert_equal(Array.isArray(data.files), true, 'files is array');
			assert_equal(Array.isArray(data.provider_status), true, 'provider_status is array');
			assert_equal(Array.isArray(data.workspaces), true, 'workspaces is array');
		},
	},
	{
		name: 'provider_load_status_empty',
		fn: async (config, session_cookie) => {
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'pls-1',
					method: 'provider_load_status',
					params: {provider_name: 'ollama'},
				}),
				session_cookie,
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.id, 'pls-1', 'id');
			// Deno returns {status: {...}}, Rust stub returns []
			// Verify it's a success (has result, no error)
			assert_equal('result' in rpc, true, 'has result');
			assert_equal('error' in rpc, false, 'no error');
		},
	},

	// -- WebSocket authenticated action test --------------------------------------
	{
		name: 'ws_workspace_list',
		fn: async (config, session_cookie) => {
			// Authenticated action over WS — workspace_list returns {workspaces: [...]}
			const conn = await open_ws(config, session_cookie);
			try {
				conn.send(
					JSON.stringify({jsonrpc: '2.0', id: 'wsl-1', method: 'workspace_list'}),
				);
				const r = (await conn.receive()) as Record<string, unknown>;
				assert_equal(r.id, 'wsl-1', 'id');
				const result = r.result as Record<string, unknown>;
				assert_equal(Array.isArray(result.workspaces), true, 'workspaces is array');
			} finally {
				conn.close();
			}
		},
	},

	// -- Filesystem tests ---------------------------------------------------------
	{
		name: 'diskfile_update_and_read',
		fn: async (config, session_cookie) => {
			const file_path = `${INTEGRATION_SCOPED_DIR}/test_write.txt`;
			const content = 'hello from integration test';

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfu-1',
					method: 'diskfile_update',
					params: {path: file_path, content},
				}),
				session_cookie,
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.result, null, 'result is null');

			// Verify the file exists and has the right content
			const actual = await Deno.readTextFile(file_path);
			assert_equal(actual, content, 'file content');
		},
	},
	{
		name: 'diskfile_delete',
		fn: async (config, session_cookie) => {
			const file_path = `${INTEGRATION_SCOPED_DIR}/test_delete.txt`;
			// Create the file first
			await Deno.writeTextFile(file_path, 'to be deleted');

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfd-1',
					method: 'diskfile_delete',
					params: {path: file_path},
				}),
				session_cookie,
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.result, null, 'result is null');

			// Verify file is gone
			try {
				await Deno.stat(file_path);
				throw new Error('file should not exist after delete');
			} catch (e) {
				if (!(e instanceof Deno.errors.NotFound)) throw e;
			}
		},
	},
	{
		name: 'directory_create',
		fn: async (config, session_cookie) => {
			const dir_path = `${INTEGRATION_SCOPED_DIR}/nested/deep/dir`;

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dc-1',
					method: 'directory_create',
					params: {path: dir_path},
				}),
				session_cookie,
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.result, null, 'result is null');

			// Verify directory exists
			const stat = await Deno.stat(dir_path);
			assert_equal(stat.isDirectory, true, 'is directory');
		},
	},
	{
		name: 'diskfile_update_outside_scope',
		fn: async (config, session_cookie) => {
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfo-1',
					method: 'diskfile_update',
					params: {path: '/tmp/zzz_outside_scope/evil.txt', content: 'nope'},
				}),
				session_cookie,
			);
			assert_equal(res.status, 500, 'status');
			const rpc = res.body as Record<string, unknown>;
			const error = rpc.error as Record<string, unknown>;
			assert_equal(error.code, -32603, 'error code');
			assert_equal(
				(error.message as string).startsWith('failed to write file:'),
				true,
				'error message format',
			);
		},
	},
	{
		name: 'diskfile_update_path_traversal',
		fn: async (config, session_cookie) => {
			// Path traversal via ../ — normalized path escapes scope
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dft-1',
					method: 'diskfile_update',
					params: {path: `${INTEGRATION_SCOPED_DIR}/../../../tmp/evil.txt`, content: 'nope'},
				}),
				session_cookie,
			);
			assert_equal(res.status, 500, 'status');
			const rpc = res.body as Record<string, unknown>;
			const error = rpc.error as Record<string, unknown>;
			assert_equal(error.code, -32603, 'error code');
		},
	},
	{
		name: 'diskfile_update_relative_path',
		fn: async (config, session_cookie) => {
			// Relative path (not absolute) → rejected
			// Deno rejects at Zod validation (400/-32602), Rust at ScopedFs (500/-32603)
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfr-1',
					method: 'diskfile_update',
					params: {path: 'relative/path.txt', content: 'nope'},
				}),
				session_cookie,
			);
			assert_equal(res.status >= 400, true, 'error status');
			const rpc = res.body as Record<string, unknown>;
			const error = rpc.error as Record<string, unknown>;
			assert_equal(typeof error.code, 'number', 'has error code');
			// -32602 (Deno: invalid params from Zod) or -32603 (Rust: ScopedFs rejection)
			assert_equal(
				error.code === -32602 || error.code === -32603,
				true,
				`error code is validation or internal (got ${error.code})`,
			);
		},
	},
	{
		name: 'diskfile_delete_nonexistent',
		fn: async (config, session_cookie) => {
			// Delete a file that doesn't exist → error
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfdn-1',
					method: 'diskfile_delete',
					params: {path: `${INTEGRATION_SCOPED_DIR}/does_not_exist_${Date.now()}.txt`},
				}),
				session_cookie,
			);
			assert_equal(res.status, 500, 'status');
			const rpc = res.body as Record<string, unknown>;
			const error = rpc.error as Record<string, unknown>;
			assert_equal(error.code, -32603, 'error code');
		},
	},
];

// == Non-keeper tests =========================================================
//
// Tests that require a non-keeper authenticated cookie (separate from the
// admin session cookie used by most tests).

type NonKeeperTestFn = (
	config: BackendConfig,
	session_cookie?: string,
	non_keeper_cookie?: string,
) => Promise<void>;

const non_keeper_tests: ReadonlyArray<{name: string; fn: NonKeeperTestFn}> = [
	{
		name: 'auth_keeper_forbidden',
		fn: async (config, _session_cookie, non_keeper_cookie) => {
			// Authenticated non-keeper user calling a keeper action → 403
			if (!non_keeper_cookie) throw new Error('non_keeper_cookie not available');
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'akf-1',
					method: 'provider_update_api_key',
					params: {provider_name: 'claude', api_key: 'sk-test'},
				}),
				non_keeper_cookie,
			);
			assert_equal(status, 403, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'akf-1', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32002, 'error code');
			assert_equal(error.message, 'forbidden', 'error message');
		},
	},
];

// == Test runner ===============================================================

/** Run an HTTP test case. */
const run_http_case = async (
	config: BackendConfig,
	c: HttpCase,
	session_cookie?: string,
): Promise<void> => {
	const raw_body = typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
	const {status, body} = await post_rpc(config, raw_body, session_cookie);
	assert_equal(status, c.status, 'status');
	if (c.expected === null) {
		assert_equal(body, null, 'body');
	} else {
		// Exact match. error.data is normalized only when actual includes it
		// but expected doesn't — handles Deno/Rust validation detail asymmetry.
		const normalized = normalize_error_data(body, c.expected);
		assert_deep_equal(normalized.actual, normalized.expected, 'body');
	}
};

/** Run a WebSocket test case. */
const run_ws_case = async (
	config: BackendConfig,
	c: WsCase,
	session_cookie?: string,
): Promise<void> => {
	const conn = await open_ws(config, session_cookie);
	try {
		conn.send(c.message);
		const body = await conn.receive();
		assert_deep_equal(body, c.expected, 'body');
	} finally {
		conn.close();
	}
};

/** Collect all test cases into a flat list for the runner. */
const build_test_list = (
	config: BackendConfig,
	session_cookie?: string,
	non_keeper_cookie?: string,
): Array<{name: string; fn: () => Promise<void>}> => {
	const tests: Array<{name: string; fn: () => Promise<void>}> = [];

	for (const c of http_cases) {
		if (c.skip?.includes(config.name)) continue;
		tests.push({name: c.name, fn: () => run_http_case(config, c, session_cookie)});
	}
	for (const c of ws_cases) {
		if (c.skip?.includes(config.name)) continue;
		tests.push({name: c.name, fn: () => run_ws_case(config, c, session_cookie)});
	}
	for (const t of special_tests) {
		tests.push({name: t.name, fn: () => t.fn(config, session_cookie)});
	}
	for (const t of non_keeper_tests) {
		tests.push({name: t.name, fn: () => t.fn(config, session_cookie, non_keeper_cookie)});
	}

	return tests;
};

export const run_tests = async (
	config: BackendConfig,
	filter?: string,
	session_cookie?: string,
	non_keeper_cookie?: string,
): Promise<TestResult[]> => {
	const tests = build_test_list(config, session_cookie, non_keeper_cookie);
	const results: TestResult[] = [];

	for (const test of tests) {
		if (filter && !test.name.includes(filter)) {
			continue;
		}
		const start = performance.now();
		try {
			await test.fn();
			results.push({name: test.name, passed: true, duration_ms: performance.now() - start});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			results.push({
				name: test.name,
				passed: false,
				duration_ms: performance.now() - start,
				error: message,
			});
		}
	}

	return results;
};
