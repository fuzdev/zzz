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

import type {BackendConfig} from './config.ts';

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

const assert_deep_equal = (actual: unknown, expected: unknown, label: string): void => {
	const a = JSON.stringify(sort_keys(actual));
	const e = JSON.stringify(sort_keys(expected));
	if (a !== e) {
		throw new Error(`${label}\n  expected: ${e}\n  actual:   ${a}`);
	}
};

const assert_equal = (actual: unknown, expected: unknown, label: string): void => {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
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

// TODO Deno HTTP RPC parity — fuz_app's create_rpc_endpoint has wire format
// differences from the Rust backend. Each skip documents the specific gap.
// See grimoire/lore/zzz/TODO.md "Integration Test Parity" for the full list.
// Once fuz_app is aligned, remove the skips and these tests become cross-backend.
const http_cases: readonly HttpCase[] = [
	// Ping — happy path
	{
		name: 'ping_http',
		body: {jsonrpc: '2.0', id: 'test-1', method: 'ping'},
		status: 200,
		expected: {jsonrpc: '2.0', id: 'test-1', result: {ping_id: 'test-1'}},
		// TODO Deno returns {ping_id: 'rpc'} because fuz_app ActionContext doesn't
		// include the JSON-RPC request ID. Fix: thread request_id through ActionContext
		// (fuz_app action_rpc.ts:41-52), then update zzz_rpc_actions.ts:70.
		skip: ['deno'],
	},
	{
		name: 'ping_numeric_id',
		body: {jsonrpc: '2.0', id: 42, method: 'ping'},
		status: 200,
		expected: {jsonrpc: '2.0', id: 42, result: {ping_id: 42}},
		skip: ['deno'], // same as ping_http
	},
	{
		name: 'null_id_is_request',
		body: {jsonrpc: '2.0', id: null, method: 'nonexistent'},
		status: 200,
		expected: {
			jsonrpc: '2.0',
			id: null,
			error: {code: -32601, message: 'method not found: nonexistent'},
		},
		comment: 'id:null is a request not a notification — uses method_not_found to avoid ping output validation',
		// TODO Deno returns HTTP 404 for method_not_found. Fix: fuz_app should return
		// HTTP 200 for all JSON-RPC responses (error info in body per convention).
		// File: fuz_app/src/lib/http/jsonrpc_errors.ts:230-244
		skip: ['deno'],
	},

	// Parse errors — bare error object, status 400
	{
		name: 'parse_error_http',
		body: 'not json at all',
		status: 400,
		expected: {code: -32700, message: 'parse error'},
		// TODO Deno wraps parse errors in full JSON-RPC envelope {jsonrpc, id: null, error}.
		// Rust returns bare error {code, message}. Pick one format and align both.
		// File: fuz_app/src/lib/actions/action_rpc.ts:287-292
		skip: ['deno'],
	},
	{
		name: 'parse_error_empty_body',
		body: '',
		status: 400,
		expected: {code: -32700, message: 'parse error'},
		skip: ['deno'], // same as parse_error_http
	},

	// Method not found
	{
		name: 'method_not_found_http',
		body: {jsonrpc: '2.0', id: 'mnf-1', method: 'nonexistent'},
		status: 200,
		expected: {
			jsonrpc: '2.0',
			id: 'mnf-1',
			error: {code: -32601, message: 'method not found: nonexistent'},
		},
		// TODO Deno returns HTTP 404. Fix: fuz_app HTTP status mapping.
		skip: ['deno'],
	},

	// Invalid requests — status 200, JSON-RPC error envelope
	{
		name: 'invalid_request_missing_method',
		body: {jsonrpc: '2.0', id: 'ir-1'},
		status: 200,
		expected: {jsonrpc: '2.0', id: 'ir-1', error: {code: -32600, message: 'invalid request'}},
		comment: 'valid JSON-RPC object with id but no method',
		// TODO Deno returns HTTP 400. Fix: fuz_app HTTP status mapping.
		skip: ['deno'],
	},
	{
		name: 'invalid_request_not_object',
		body: '"just a string"',
		status: 200,
		expected: {
			jsonrpc: '2.0',
			id: 'just a string',
			error: {code: -32600, message: 'invalid request'},
		},
		comment: 'Deno to_jsonrpc_message_id extracts raw value as id for strings/numbers',
		skip: ['deno'], // same status issue
	},
	{
		name: 'invalid_request_bad_version',
		body: {jsonrpc: '1.0', id: 'bv-1', method: 'ping'},
		status: 200,
		expected: {jsonrpc: '2.0', id: 'bv-1', error: {code: -32600, message: 'invalid request'}},
		comment: 'wrong jsonrpc version',
		skip: ['deno'],
	},
	{
		name: 'invalid_request_missing_version',
		body: {id: 'mv-1', method: 'ping'},
		status: 200,
		expected: {jsonrpc: '2.0', id: 'mv-1', error: {code: -32600, message: 'invalid request'}},
		comment: 'missing jsonrpc field entirely',
		skip: ['deno'],
	},

	// Notifications — has method but no id → null response, status 200
	{
		name: 'notification_http',
		body: {jsonrpc: '2.0', method: 'ping'},
		status: 200,
		expected: null,
		// TODO Deno rejects notifications (fuz_app JsonrpcRequest schema requires id).
		// Fix: support notifications in fuz_app/src/lib/http/jsonrpc.ts:36-43.
		skip: ['deno'],
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
		expected: {code: -32700, message: 'parse error'},
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
		assert_deep_equal(body, c.expected, 'body');
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

	return tests;
};

export const run_tests = async (
	config: BackendConfig,
	filter?: string,
	session_cookie?: string,
): Promise<TestResult[]> => {
	const tests = build_test_list(config, session_cookie);
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
