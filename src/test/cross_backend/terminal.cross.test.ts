/**
 * Cross-backend integration tests for `terminal_*` actions.
 *
 * Ported from `test/integration/tests.ts`. Each test mints a fresh
 * per-test account via `default_cross_process_setup` and exercises the
 * terminal RPC + WebSocket data/exit notification path against the
 * spawned test binary.
 *
 * @module
 */

import {describe, test, inject, assert} from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {rpc_call} from '@fuzdev/fuz_app/testing/rpc_helpers.js';
import {create_ws_transport} from '@fuzdev/fuz_app/testing/transports/ws_transport.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

describe('terminal cross-backend', () => {
	test('terminal_create_echo', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies(),
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const result = (await ws.request('tc-1', 'terminal_create', {
				command: 'echo',
				args: ['hello'],
			})) as Record<string, unknown>;
			const terminal_id = result.terminal_id as string;
			assert.equal(typeof terminal_id, 'string');
			assert.ok(terminal_id.length > 0, 'terminal_id not empty');

			// Wait for terminal_data containing 'hello'.
			const data_msg = (await ws.wait_for((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_data') return false;
				const params = m.params as Record<string, unknown> | undefined;
				if (!params) return false;
				return params.terminal_id === terminal_id && String(params.data).includes('hello');
			}, 5_000)) as Record<string, unknown>;
			assert.ok(data_msg);

			const exited_msg = (await ws.wait_for((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_exited') return false;
				const params = m.params as Record<string, unknown> | undefined;
				return params?.terminal_id === terminal_id;
			}, 5_000)) as Record<string, unknown>;
			const exit_params = exited_msg.params as Record<string, unknown>;
			assert.equal(exit_params.exit_code, 0, 'exit_code is 0');
		} finally {
			await ws.close();
		}
	});

	test('terminal_close', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies(),
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = (await ws.request('tcl-1', 'terminal_create', {
				command: 'sleep',
				args: ['60'],
			})) as Record<string, unknown>;
			const terminal_id = create_result.terminal_id as string;

			const close_result = (await ws.request('tcl-2', 'terminal_close', {
				terminal_id,
			})) as Record<string, unknown>;
			assert.ok(
				close_result.exit_code === null || typeof close_result.exit_code === 'number',
				'exit_code is number or null',
			);
		} finally {
			await ws.close();
		}
	});

	test('terminal_write_and_read', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies(),
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = (await ws.request('twr-1', 'terminal_create', {
				command: 'cat',
				args: [],
			})) as Record<string, unknown>;
			const terminal_id = create_result.terminal_id as string;
			assert.equal(typeof terminal_id, 'string');

			const write_result = await ws.request('twr-2', 'terminal_data_send', {
				terminal_id,
				data: 'integration test\n',
			});
			assert.equal(write_result, null, 'write result is null');

			const echo_msg = (await ws.wait_for((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_data') return false;
				const params = m.params as Record<string, unknown> | undefined;
				if (!params || params.terminal_id !== terminal_id) return false;
				return String(params.data).includes('integration test');
			}, 5_000)) as Record<string, unknown>;
			assert.ok(echo_msg);

			await ws.request('twr-3', 'terminal_close', {terminal_id}).catch(() => undefined);
		} finally {
			await ws.close();
		}
	});

	test('terminal_resize_live', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies(),
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = (await ws.request('trl-1', 'terminal_create', {
				command: 'sleep',
				args: ['60'],
			})) as Record<string, unknown>;
			const terminal_id = create_result.terminal_id as string;

			const resize_result = await ws.request('trl-2', 'terminal_resize', {
				terminal_id,
				cols: 120,
				rows: 40,
			});
			assert.equal(resize_result, null, 'resize result is null');

			await ws.request('trl-3', 'terminal_close', {terminal_id}).catch(() => undefined);
		} finally {
			await ws.close();
		}
	});

	test('terminal_create_with_cwd', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies(),
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = (await ws.request('tcc-1', 'terminal_create', {
				command: 'pwd',
				args: [],
				cwd: '/tmp',
			})) as Record<string, unknown>;
			assert.equal(typeof create_result.terminal_id, 'string');

			const data_msg = (await ws.wait_for((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_data') return false;
				const params = m.params as Record<string, unknown> | undefined;
				return !!params && String(params.data).includes('/tmp');
			}, 5_000)) as Record<string, unknown>;
			assert.ok(data_msg);
		} finally {
			await ws.close();
		}
	});

	test('terminal_create_nonexistent_command', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies(),
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			// Two valid behaviors across backends — either an error response
			// from the create call, or a successful create followed by an
			// exited notification with exit_code 127. Catch the error path
			// from `ws.request` (it throws on error frames) and fall through
			// to the success-path branch.
			let terminal_id: string | undefined;
			let create_error: Error | undefined;
			try {
				const create_result = (await ws.request('tcne-1', 'terminal_create', {
					command: '/nonexistent/binary_zzz_test',
					args: [],
				})) as Record<string, unknown>;
				terminal_id = create_result.terminal_id as string;
				assert.equal(typeof terminal_id, 'string');
			} catch (e) {
				create_error = e as Error;
			}

			if (create_error) {
				// Spawn failed at the create call — message includes the code.
				assert.match(create_error.message, /-32603/);
			} else {
				// Forkpty path: child exits 127. Wait for the terminal_exited
				// notification matching the just-created terminal_id.
				const exited = (await ws.wait_for((msg) => {
					if (!msg || typeof msg !== 'object') return false;
					const m = msg as Record<string, unknown>;
					if (m.method !== 'terminal_exited') return false;
					const params = m.params as Record<string, unknown> | undefined;
					return params?.terminal_id === terminal_id;
				}, 5_000)) as Record<string, unknown>;
				const exit_params = exited.params as Record<string, unknown>;
				assert.equal(exit_params.exit_code, 127, 'exit_code is 127');
			}
		} finally {
			await ws.close();
		}
	});

	test('terminal_data_send_missing', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'terminal_data_send',
			params: {terminal_id: NIL_UUID, data: 'hello'},
			headers: fixture.create_session_headers(),
		});
		assert.ok(res.ok);
		assert.equal(res.result, null, 'silent null for missing terminal');
	});

	test('terminal_close_missing', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'terminal_close',
			params: {terminal_id: NIL_UUID},
			headers: fixture.create_session_headers(),
		});
		assert.ok(res.ok);
		assert.deepEqual(res.result, {exit_code: null}, 'result is {exit_code: null}');
	});

	test('terminal_resize_missing', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'terminal_resize',
			params: {terminal_id: NIL_UUID, cols: 80, rows: 24},
			headers: fixture.create_session_headers(),
		});
		assert.ok(res.ok);
		assert.equal(res.result, null, 'silent null for missing terminal');
	});
});
