/**
 * Integration test suite for zzz backends.
 *
 * Tests JSON-RPC 2.0 over HTTP and WebSocket, asserting identical behaviour
 * between the Deno reference backend and the Rust backend.
 *
 * Most tests are data-driven tables (http_cases, ws_cases) — adding a test
 * case is just adding a row. Special tests that need unique control flow
 * (silence assertions, persistent connections, non-RPC endpoints) are
 * separate functions in `special_tests`. Tests requiring a non-keeper
 * authenticated cookie are in `non_keeper_tests`.
 */

import {INTEGRATION_SCOPED_DIR, INTEGRATION_ZZZ_DIR, type BackendConfig} from './config.ts';
import {
	post_rpc,
	open_ws,
	ensure_ws_registered,
	assert_equal,
	assert_deep_equal,
	ws_url,
} from './test_helpers.ts';

export interface TestResult {
	name: string;
	passed: boolean;
	duration_ms: number;
	error?: string;
}

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
			const conn = await open_ws(config, {cookie: session_cookie});
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
			const conn = await open_ws(config, {cookie: session_cookie});
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
					{cookie: session_cookie},
				);
				assert_equal(open_res.status, 200, 'open status');
				const open_rpc = open_res.body as Record<string, unknown>;
				assert_equal(open_rpc.id, 'wo-1', 'open id');
				const open_result = open_rpc.result as Record<string, unknown>;
				const workspace = open_result.workspace as Record<string, unknown>;

				// WorkspaceInfoJson shape (path, name, opened_at)
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
					{cookie: session_cookie},
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
					{cookie: session_cookie},
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
					{cookie: session_cookie},
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
				{cookie: session_cookie},
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
				{cookie: 'fuz_session=garbage-invalid-cookie-value'},
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
					{cookie: session_cookie},
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
					{cookie: session_cookie},
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
					{cookie: session_cookie},
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
				// Both backends return -32602 (invalid_params, 400).
				const close2_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wc-close2',
						method: 'workspace_close',
						params: {path: workspace.path},
					}),
					{cookie: session_cookie},
				);
				assert_equal(close2_res.status, 400, 'double close status');
				const close2_rpc = close2_res.body as Record<string, unknown>;
				const error = close2_rpc.error as Record<string, unknown>;
				assert_equal(error.code, -32602, 'double close error code');
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
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.id, 'sl-1', 'id');
			const result = rpc.result as Record<string, unknown>;
			const data = result.data as Record<string, unknown>;

			// zzz_dir is the canonicalized INTEGRATION_ZZZ_DIR with trailing slash
			const zzz_dir = data.zzz_dir as string;
			assert_equal(zzz_dir.startsWith('/'), true, 'zzz_dir is absolute');
			assert_equal(zzz_dir.endsWith('/'), true, 'zzz_dir has trailing slash');

			// scoped_dirs contains the integration scoped dir, absolute with trailing slash
			const scoped_dirs = data.scoped_dirs as Array<string>;
			assert_equal(scoped_dirs.length >= 1, true, `scoped_dirs has entries (got ${scoped_dirs.length})`);
			assert_equal(scoped_dirs[0].startsWith('/'), true, 'scoped_dirs[0] is absolute');
			assert_equal(scoped_dirs[0].endsWith('/'), true, 'scoped_dirs[0] has trailing slash');

			assert_equal(Array.isArray(data.files), true, 'files is array');
			assert_equal(Array.isArray(data.provider_status), true, 'provider_status is array');
			assert_equal(Array.isArray(data.workspaces), true, 'workspaces is array');
		},
	},
	{
		name: 'session_load_returns_zzz_dir_files',
		fn: async (config, session_cookie) => {
			// Create a test file in zzz_dir before loading session
			const test_content = 'session load file test';
			await Deno.writeTextFile(`${INTEGRATION_ZZZ_DIR}/test_session.txt`, test_content);

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'slf-1',
					method: 'session_load',
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			const result = rpc.result as Record<string, unknown>;
			const data = result.data as Record<string, unknown>;
			const files = data.files as Array<Record<string, unknown>>;

			// Find our test file — fail with useful context if missing
			const test_file = files.find((f) => (f.id as string).endsWith('/test_session.txt'));
			if (!test_file) {
				const ids = files.map((f) => f.id);
				throw new Error(`test file not found in ${files.length} files: ${JSON.stringify(ids)}`);
			}

			assert_equal(test_file.contents, test_content, 'file contents match');
			assert_equal((test_file.source_dir as string).startsWith('/'), true, 'source_dir is absolute');
			assert_equal((test_file.source_dir as string).endsWith('/'), true, 'source_dir has trailing slash');
			assert_equal((test_file.id as string).startsWith('/'), true, 'file id is absolute path');
			assert_deep_equal(test_file.dependents, [], 'dependents is empty array');
			assert_deep_equal(test_file.dependencies, [], 'dependencies is empty array');
			assert_equal(typeof test_file.mtime, 'number', 'mtime is number');

			// Clean up
			await Deno.remove(`${INTEGRATION_ZZZ_DIR}/test_session.txt`);
		},
	},
	{
		name: 'diskfile_update_in_zzz_dir',
		fn: async (config, session_cookie) => {
			// ScopedFs should allow writes to zzz_dir
			const file_path = `${INTEGRATION_ZZZ_DIR}/test_scoped_write.txt`;
			const content = 'write to zzz_dir';

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfu-zzz-1',
					method: 'diskfile_update',
					params: {path: file_path, content},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.result, null, 'result is null');

			// Verify the file exists and has the right content
			const actual = await Deno.readTextFile(file_path);
			assert_equal(actual, content, 'file content');

			// Clean up
			await Deno.remove(file_path);
		},
	},
	{
		name: 'session_load_returns_nested_files',
		fn: async (config, session_cookie) => {
			// Create a file in a subdirectory of zzz_dir
			await Deno.mkdir(`${INTEGRATION_ZZZ_DIR}/state/nested`, {recursive: true});
			await Deno.writeTextFile(`${INTEGRATION_ZZZ_DIR}/state/nested/deep.txt`, 'nested content');

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'sln-1',
					method: 'session_load',
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			const result = rpc.result as Record<string, unknown>;
			const data = result.data as Record<string, unknown>;
			const files = data.files as Array<Record<string, unknown>>;

			const nested_file = files.find((f) => (f.id as string).endsWith('/state/nested/deep.txt'));
			if (!nested_file) {
				const ids = files.map((f) => f.id);
				throw new Error(`nested file not found in ${files.length} files: ${JSON.stringify(ids)}`);
			}
			assert_equal(nested_file.contents, 'nested content', 'nested file contents');

			// Clean up
			await Deno.remove(`${INTEGRATION_ZZZ_DIR}/state`, {recursive: true});
		},
	},
	{
		name: 'diskfile_update_in_zzz_dir_subdirectory',
		fn: async (config, session_cookie) => {
			// ScopedFs should allow writes to existing subdirectories under zzz_dir
			await Deno.mkdir(`${INTEGRATION_ZZZ_DIR}/state/sub`, {recursive: true});
			const file_path = `${INTEGRATION_ZZZ_DIR}/state/sub/new_file.txt`;
			const content = 'nested write';

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfu-zzz-sub-1',
					method: 'diskfile_update',
					params: {path: file_path, content},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.result, null, 'result is null');

			const actual = await Deno.readTextFile(file_path);
			assert_equal(actual, content, 'file content');

			// Clean up
			await Deno.remove(`${INTEGRATION_ZZZ_DIR}/state`, {recursive: true});
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
				{cookie: session_cookie},
			);
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.id, 'pls-1', 'id');
			if (config.name === 'rust') {
				// Rust has no provider support — returns method_not_found
				assert_equal(res.status, 404, 'status');
				const error = rpc.error as Record<string, unknown>;
				assert_equal(error.code, -32601, 'error code');
			} else {
				// Deno returns {status: ProviderStatus} per the action spec
				assert_equal(res.status, 200, 'status');
				const result = rpc.result as Record<string, unknown>;
				const status = result.status as Record<string, unknown>;
				assert_equal(status.name, 'ollama', 'status.name');
				assert_equal(typeof status.available, 'boolean', 'status.available is boolean');
				assert_equal(typeof status.checked_at, 'number', 'status.checked_at is number');
				if (status.available === false) {
					assert_equal(typeof status.error, 'string', 'status.error is string when unavailable');
				}
			}
		},
	},

	// -- WebSocket authenticated action test --------------------------------------
	{
		name: 'ws_workspace_list',
		fn: async (config, session_cookie) => {
			// Authenticated action over WS — workspace_list returns {workspaces: [...]}
			const conn = await open_ws(config, {cookie: session_cookie});
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

	// -- workspace_changed notification tests -------------------------------------
	{
		name: 'workspace_changed_on_open',
		fn: async (config, session_cookie) => {
			// Open a WS connection, then open a workspace via HTTP
			// → WS client should receive a workspace_changed notification
			const conn = await open_ws(config, {cookie: session_cookie});
			await ensure_ws_registered(conn);
			const tmp_dir = await Deno.makeTempDir({prefix: 'zzz_test_wc_'});
			try {
				// Open workspace via HTTP RPC
				const open_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wco-1',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					{cookie: session_cookie},
				);
				assert_equal(open_res.status, 200, 'open status');

				// WS should receive workspace_changed notification
				const notification = (await conn.receive()) as Record<string, unknown>;
				assert_equal(notification.jsonrpc, '2.0', 'jsonrpc version');
				assert_equal(notification.method, 'workspace_changed', 'method');
				assert_equal('id' in notification, false, 'no id (notification)');
				const params = notification.params as Record<string, unknown>;
				assert_equal(params.type, 'open', 'change type');
				const workspace = params.workspace as Record<string, unknown>;
				assert_equal(typeof workspace.path, 'string', 'workspace.path is string');
				assert_equal((workspace.path as string).endsWith('/'), true, 'path ends with /');
				assert_equal(typeof workspace.name, 'string', 'workspace.name is string');
				assert_equal(typeof workspace.opened_at, 'string', 'workspace.opened_at is string');
			} finally {
				conn.close();
				// Clean up: close workspace
				await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wco-cleanup',
						method: 'workspace_close',
						params: {path: tmp_dir},
					}),
					{cookie: session_cookie},
				);
				await Deno.remove(tmp_dir, {recursive: true});
			}
		},
	},
	{
		name: 'workspace_changed_on_close',
		fn: async (config, session_cookie) => {
			// Open a workspace, then open WS, then close the workspace
			// → WS client should receive a workspace_changed close notification
			const tmp_dir = await Deno.makeTempDir({prefix: 'zzz_test_wc_'});
			try {
				// Open workspace first
				const open_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wcc-open',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					{cookie: session_cookie},
				);
				assert_equal(open_res.status, 200, 'open status');
				const workspace = (
					(open_res.body as Record<string, unknown>).result as Record<string, unknown>
				).workspace as Record<string, unknown>;

				// Now open WS connection
				const conn = await open_ws(config, {cookie: session_cookie});
				await ensure_ws_registered(conn);
				try {
					// Close workspace via HTTP
					const close_res = await post_rpc(
						config,
						JSON.stringify({
							jsonrpc: '2.0',
							id: 'wcc-close',
							method: 'workspace_close',
							params: {path: workspace.path},
						}),
						{cookie: session_cookie},
					);
					assert_equal(close_res.status, 200, 'close status');

					// WS should receive workspace_changed close notification
					const notification = (await conn.receive()) as Record<string, unknown>;
					assert_equal(notification.jsonrpc, '2.0', 'jsonrpc version');
					assert_equal(notification.method, 'workspace_changed', 'method');
					assert_equal('id' in notification, false, 'no id (notification)');
					const params = notification.params as Record<string, unknown>;
					assert_equal(params.type, 'close', 'change type');
					const ws_info = params.workspace as Record<string, unknown>;
					assert_equal(ws_info.path, workspace.path, 'same workspace path');
				} finally {
					conn.close();
				}
			} finally {
				await Deno.remove(tmp_dir, {recursive: true});
			}
		},
	},
	{
		name: 'workspace_changed_idempotent_no_notification',
		fn: async (config, session_cookie) => {
			// Opening an already-open workspace should NOT send a notification
			const tmp_dir = await Deno.makeTempDir({prefix: 'zzz_test_wc_'});
			try {
				// First open (creates workspace)
				await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wci-1',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					{cookie: session_cookie},
				);

				// Open WS after first open
				const conn = await open_ws(config, {cookie: session_cookie});
				await ensure_ws_registered(conn);
				try {
					// Second open (idempotent — should NOT broadcast)
					await post_rpc(
						config,
						JSON.stringify({
							jsonrpc: '2.0',
							id: 'wci-2',
							method: 'workspace_open',
							params: {path: tmp_dir},
						}),
						{cookie: session_cookie},
					);

					// Should NOT receive any notification
					await conn.expect_silence();
				} finally {
					conn.close();
				}
			} finally {
				// Cleanup
				await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wci-cleanup',
						method: 'workspace_close',
						params: {path: tmp_dir},
					}),
					{cookie: session_cookie},
				);
				await Deno.remove(tmp_dir, {recursive: true});
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
				{cookie: session_cookie},
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
				{cookie: session_cookie},
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
				{cookie: session_cookie},
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
				{cookie: session_cookie},
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
				{cookie: session_cookie},
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
			// Relative path (not absolute) → rejected as invalid params
			// Deno rejects at Zod validation, Rust rejects at handler validation.
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'dfr-1',
					method: 'diskfile_update',
					params: {path: 'relative/path.txt', content: 'nope'},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 400, 'status');
			const rpc = res.body as Record<string, unknown>;
			const error = rpc.error as Record<string, unknown>;
			assert_equal(error.code, -32602, 'error code');
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
				{cookie: session_cookie},
			);
			assert_equal(res.status, 500, 'status');
			const rpc = res.body as Record<string, unknown>;
			const error = rpc.error as Record<string, unknown>;
			assert_equal(error.code, -32603, 'error code');
		},
	},

	{
		name: 'directory_create_already_exists',
		fn: async (config, session_cookie) => {
			// Creating an already-existing directory should succeed (idempotent)
			const dir_path = `${INTEGRATION_SCOPED_DIR}/idempotent_dir_${Date.now()}`;
			try {
				// Create it once
				const r1 = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'dcae-1',
						method: 'directory_create',
						params: {path: dir_path},
					}),
					{cookie: session_cookie},
				);
				assert_equal(r1.status, 200, 'first create status');

				// Create it again — should still succeed
				const r2 = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'dcae-2',
						method: 'directory_create',
						params: {path: dir_path},
					}),
					{cookie: session_cookie},
				);
				assert_equal(r2.status, 200, 'second create status');
				assert_equal((r2.body as Record<string, unknown>).result, null, 'result is null');
			} finally {
				try {
					await Deno.remove(dir_path, {recursive: true});
				} catch {
					// ignore cleanup errors
				}
			}
		},
	},
	{
		name: 'workspace_open_not_directory',
		fn: async (config, session_cookie) => {
			// Opening a file (not a directory) as a workspace → error
			const file_path = `${INTEGRATION_SCOPED_DIR}/not_a_dir_${Date.now()}.txt`;
			try {
				await Deno.writeTextFile(file_path, 'content');
				const res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'wond-1',
						method: 'workspace_open',
						params: {path: file_path},
					}),
					{cookie: session_cookie},
				);
				assert_equal(res.status, 500, 'status');
				const rpc = res.body as Record<string, unknown>;
				const error = rpc.error as Record<string, unknown>;
				assert_equal(error.code, -32603, 'error code');
			} finally {
				try {
					await Deno.remove(file_path);
				} catch {
					// ignore cleanup errors
				}
			}
		},
	},
	{
		name: 'filer_change_on_file_create',
		fn: async (config, session_cookie) => {
			// Open a workspace, create a file in it, verify filer_change notification
			const tmp_dir = await Deno.makeTempDir({prefix: 'zzz_test_filer_'});
			try {
				// Open workspace
				const open_res = await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'fc-open',
						method: 'workspace_open',
						params: {path: tmp_dir},
					}),
					{cookie: session_cookie},
				);
				assert_equal(open_res.status, 200, 'open status');

				// Open WS and wait for connection to register
				const conn = await open_ws(config, {cookie: session_cookie});
				try {
					await ensure_ws_registered(conn);

					// Create a file in the workspace
					const new_file = `${tmp_dir}/filer_test_${Date.now()}.txt`;
					await Deno.writeTextFile(new_file, 'hello from filer test');

					// Wait for filer_change notification (file watchers have latency)
					let got_notification = false;
					for (let i = 0; i < 5 && !got_notification; i++) {
						try {
							const msg = (await conn.receive(3_000)) as Record<string, unknown>;
							if (msg.method === 'filer_change') {
								const params = msg.params as Record<string, unknown>;
								const change = params.change as Record<string, unknown>;
								assert_equal(typeof change.path, 'string', 'change has path');
								assert_equal(typeof change.type, 'string', 'change has type');
								got_notification = true;
							}
						} catch {
							// timeout — retry
						}
					}
					assert_equal(got_notification, true, 'received filer_change notification');
				} finally {
					conn.close();
				}

				// Clean up workspace
				await post_rpc(
					config,
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'fc-close',
						method: 'workspace_close',
						params: {path: tmp_dir},
					}),
					{cookie: session_cookie},
				);
			} finally {
				try {
					await Deno.remove(tmp_dir, {recursive: true});
				} catch {
					// ignore
				}
			}
		},
	},

	// -- Terminal tests -----------------------------------------------------------

	{
		name: 'terminal_create_echo',
		fn: async (config, session_cookie) => {
			// Spawn "echo hello" via WS, receive terminal_data notification with
			// output containing "hello", then terminal_exited with exit_code 0.
			const conn = await open_ws(config, {cookie: session_cookie});
			try {
				await ensure_ws_registered(conn);

				// Create terminal
				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'tc-1',
						method: 'terminal_create',
						params: {command: 'echo', args: ['hello']},
					}),
				);
				const create_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(create_res.id, 'tc-1', 'create id');
				const create_result = create_res.result as Record<string, unknown>;
				assert_equal(typeof create_result.terminal_id, 'string', 'terminal_id is string');
				assert_equal(
					(create_result.terminal_id as string).length > 0,
					true,
					'terminal_id not empty',
				);

				// Collect notifications — expect terminal_data with "hello" and
				// terminal_exited with exit_code 0. Order may vary, collect up to 10.
				let got_data = false;
				let got_exited = false;
				let exit_code: number | null = null;
				for (let i = 0; i < 10 && !(got_data && got_exited); i++) {
					const msg = (await conn.receive(5_000)) as Record<string, unknown>;
					if (msg.method === 'terminal_data') {
						const params = msg.params as Record<string, unknown>;
						assert_equal(
							params.terminal_id,
							create_result.terminal_id,
							'data terminal_id matches',
						);
						if ((params.data as string).includes('hello')) {
							got_data = true;
						}
					} else if (msg.method === 'terminal_exited') {
						const params = msg.params as Record<string, unknown>;
						assert_equal(
							params.terminal_id,
							create_result.terminal_id,
							'exited terminal_id matches',
						);
						exit_code = params.exit_code as number | null;
						got_exited = true;
					}
				}
				assert_equal(got_data, true, 'received terminal_data with hello');
				assert_equal(got_exited, true, 'received terminal_exited');
				assert_equal(exit_code, 0, 'exit_code is 0');
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'terminal_close',
		fn: async (config, session_cookie) => {
			// Spawn a long-running process, then close it explicitly.
			// The close response and terminal_exited notification may arrive
			// in either order — collect both.
			const conn = await open_ws(config, {cookie: session_cookie});
			try {
				await ensure_ws_registered(conn);

				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'tcl-1',
						method: 'terminal_create',
						params: {command: 'sleep', args: ['60']},
					}),
				);
				const create_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(create_res.id, 'tcl-1', 'create id');
				const terminal_id = (create_res.result as Record<string, unknown>)
					.terminal_id as string;

				// Close the terminal
				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'tcl-2',
						method: 'terminal_close',
						params: {terminal_id},
					}),
				);

				// Collect up to 3 messages — expect the close response and
				// possibly a terminal_exited notification (order varies by backend)
				let got_close_response = false;
				for (let i = 0; i < 3 && !got_close_response; i++) {
					const msg = (await conn.receive(5_000)) as Record<string, unknown>;
					if (msg.id === 'tcl-2') {
						got_close_response = true;
						const close_result = msg.result as Record<string, unknown>;
						assert_equal(
							close_result.exit_code === null || typeof close_result.exit_code === 'number',
							true,
							'exit_code is number or null',
						);
					}
					// terminal_exited or terminal_data notifications are fine — skip them
				}
				assert_equal(got_close_response, true, 'received close response');
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'terminal_write_and_read',
		fn: async (config, session_cookie) => {
			// Spawn cat, write data, verify it's echoed back via terminal_data
			const conn = await open_ws(config, {cookie: session_cookie});
			try {
				await ensure_ws_registered(conn);

				// Create terminal running cat (echoes stdin to stdout)
				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'twr-1',
						method: 'terminal_create',
						params: {command: 'cat', args: []},
					}),
				);
				const create_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(create_res.id, 'twr-1', 'create id');
				const terminal_id = (create_res.result as Record<string, unknown>)
					.terminal_id as string;

				// Write data to the terminal
				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'twr-2',
						method: 'terminal_data_send',
						params: {terminal_id, data: 'integration test\n'},
					}),
				);
				const write_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(write_res.id, 'twr-2', 'write id');
				assert_equal(write_res.result, null, 'write result is null');

				// Collect terminal_data notifications until we see our echoed text
				let got_echo = false;
				for (let i = 0; i < 20 && !got_echo; i++) {
					const msg = (await conn.receive(5_000)) as Record<string, unknown>;
					if (msg.method === 'terminal_data') {
						const params = msg.params as Record<string, unknown>;
						if ((params.data as string).includes('integration test')) {
							got_echo = true;
						}
					}
				}
				assert_equal(got_echo, true, 'received echoed data');

				// Clean up
				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'twr-3',
						method: 'terminal_close',
						params: {terminal_id},
					}),
				);
				// Drain close response (and any notifications)
				for (let i = 0; i < 3; i++) {
					const msg = (await conn.receive(5_000)) as Record<string, unknown>;
					if (msg.id === 'twr-3') break;
				}
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'terminal_resize_live',
		fn: async (config, session_cookie) => {
			// Spawn a process, resize it, verify no error
			const conn = await open_ws(config, {cookie: session_cookie});
			try {
				await ensure_ws_registered(conn);

				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'trl-1',
						method: 'terminal_create',
						params: {command: 'sleep', args: ['60']},
					}),
				);
				const create_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(create_res.id, 'trl-1', 'create id');
				const terminal_id = (create_res.result as Record<string, unknown>)
					.terminal_id as string;

				// Resize
				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'trl-2',
						method: 'terminal_resize',
						params: {terminal_id, cols: 120, rows: 40},
					}),
				);
				const resize_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(resize_res.id, 'trl-2', 'resize id');
				assert_equal(resize_res.result, null, 'resize result is null');

				// Clean up
				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'trl-3',
						method: 'terminal_close',
						params: {terminal_id},
					}),
				);
				for (let i = 0; i < 3; i++) {
					const msg = (await conn.receive(5_000)) as Record<string, unknown>;
					if (msg.id === 'trl-3') break;
				}
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'terminal_create_with_cwd',
		fn: async (config, session_cookie) => {
			// Spawn pwd with explicit cwd, verify output contains the cwd path
			const conn = await open_ws(config, {cookie: session_cookie});
			try {
				await ensure_ws_registered(conn);

				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'tcc-1',
						method: 'terminal_create',
						params: {command: 'pwd', args: [], cwd: '/tmp'},
					}),
				);
				const create_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(create_res.id, 'tcc-1', 'create id');
				const terminal_id = (create_res.result as Record<string, unknown>)
					.terminal_id as string;

				let got_tmp = false;
				for (let i = 0; i < 10 && !got_tmp; i++) {
					const msg = (await conn.receive(5_000)) as Record<string, unknown>;
					if (
						msg.method === 'terminal_data' &&
						((msg.params as Record<string, unknown>).data as string).includes('/tmp')
					) {
						got_tmp = true;
					}
				}
				assert_equal(got_tmp, true, 'pwd output contains /tmp');
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'terminal_create_nonexistent_command',
		fn: async (config, session_cookie) => {
			// Spawning a nonexistent binary. Two valid behaviors:
			// - Rust (forkpty): spawn succeeds, child exits 127, terminal_exited notification
			// - Deno fallback (Deno.Command): spawn fails, error response
			const conn = await open_ws(config, {cookie: session_cookie});
			try {
				await ensure_ws_registered(conn);

				conn.send(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'tcne-1',
						method: 'terminal_create',
						params: {command: '/nonexistent/binary_zzz_test', args: []},
					}),
				);
				const create_res = (await conn.receive()) as Record<string, unknown>;
				assert_equal(create_res.id, 'tcne-1', 'create id');

				if (create_res.error) {
					// Deno fallback: spawn failed → error response
					const error = create_res.error as Record<string, unknown>;
					assert_equal(error.code, -32603, 'error code');
				} else {
					// Rust / Deno FFI: forkpty succeeded, child exits 127
					const create_result = create_res.result as Record<string, unknown>;
					assert_equal(typeof create_result.terminal_id, 'string', 'terminal_id is string');

					let got_exited = false;
					let exit_code: number | null = null;
					for (let i = 0; i < 10 && !got_exited; i++) {
						const msg = (await conn.receive(5_000)) as Record<string, unknown>;
						if (msg.method === 'terminal_exited') {
							got_exited = true;
							exit_code = (msg.params as Record<string, unknown>).exit_code as
								| number
								| null;
						}
					}
					assert_equal(got_exited, true, 'received terminal_exited');
					assert_equal(exit_code, 127, 'exit_code is 127 (command not found)');
				}
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'terminal_data_send_missing',
		fn: async (config, session_cookie) => {
			// terminal_data_send with a nonexistent terminal_id → silent null
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'tdsm-1',
					method: 'terminal_data_send',
					params: {terminal_id: '00000000-0000-0000-0000-000000000000', data: 'hello'},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.result, null, 'result is null');
		},
	},
	{
		name: 'terminal_close_missing',
		fn: async (config, session_cookie) => {
			// terminal_close with a nonexistent terminal_id → {exit_code: null}
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'tclm-1',
					method: 'terminal_close',
					params: {terminal_id: '00000000-0000-0000-0000-000000000000'},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_deep_equal(rpc.result, {exit_code: null}, 'result');
		},
	},
	{
		name: 'terminal_resize_missing',
		fn: async (config, session_cookie) => {
			// terminal_resize with a nonexistent terminal_id → silent null
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'trm-1',
					method: 'terminal_resize',
					params: {terminal_id: '00000000-0000-0000-0000-000000000000', cols: 80, rows: 24},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const rpc = res.body as Record<string, unknown>;
			assert_equal(rpc.result, null, 'result is null');
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
		name: 'non_keeper_authenticated_action',
		fn: async (config, _session_cookie, non_keeper_cookie) => {
			// Non-keeper users CAN access authenticated (non-keeper) actions
			if (!non_keeper_cookie) throw new Error('non_keeper_cookie not available');
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'nka-1',
					method: 'workspace_list',
				}),
				{cookie: non_keeper_cookie},
			);
			assert_equal(status, 200, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'nka-1', 'id');
			const result = r.result as Record<string, unknown>;
			assert_equal(Array.isArray(result.workspaces), true, 'has workspaces array');
		},
	},
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
				{cookie: non_keeper_cookie},
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
	const {status, body} = await post_rpc(config, raw_body, session_cookie ? {cookie: session_cookie} : undefined);
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
	const conn = await open_ws(config, {cookie: session_cookie});
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
