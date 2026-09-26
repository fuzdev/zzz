/**
 * Cross-backend integration tests for `terminal_*` actions.
 *
 * Each test mints a fresh per-test account via
 * `default_cross_process_setup` and exercises the terminal RPC +
 * WebSocket data/exit notification path against the spawned test
 * binary. The ownership test mints a second account to check that a
 * terminal's notifications and controls stay with the account that
 * created it.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

type WsClient = Awaited<ReturnType<typeof create_ws_transport>>;

const open_ws = async (): Promise<WsClient> => {
	const fixture = await setup_test();
	const ws = await create_ws_transport({
		base_url: handle.config.base_url,
		ws_path: handle.config.ws_path,
		cookies: fixture.transport.cookies()
	});
	await ws.request('_warmup', 'ping', undefined);
	return ws;
};

const is_notification = (msg: unknown, method: string, terminal_id: string): boolean => {
	if (!msg || typeof msg !== 'object') return false;
	const m = msg as Record<string, unknown>;
	if (m.method !== method) return false;
	const params = m.params as Record<string, unknown> | undefined;
	return params?.terminal_id === terminal_id;
};

/** Concatenate every `terminal_data` payload received so far for `terminal_id`, in order. */
const terminal_output = (ws: WsClient, terminal_id: string): string =>
	ws.messages
		.filter((msg) => is_notification(msg, 'terminal_data', terminal_id))
		.map((msg) => String(((msg as Record<string, unknown>).params as Record<string, unknown>).data))
		.join('');

/** Wait until the accumulated output of `terminal_id` satisfies `done`. */
const wait_for_output = async (
	ws: WsClient,
	terminal_id: string,
	done: (output: string) => boolean,
	timeout_ms = 10_000
): Promise<string> => {
	await ws.wait_for(
		(msg) =>
			is_notification(msg, 'terminal_data', terminal_id) && done(terminal_output(ws, terminal_id)),
		timeout_ms
	);
	return terminal_output(ws, terminal_id);
};

const wait_for_exited = async (
	ws: WsClient,
	terminal_id: string,
	timeout_ms = 10_000
): Promise<Record<string, unknown>> => {
	const msg = await ws.wait_for(
		(m) => is_notification(m, 'terminal_exited', terminal_id),
		timeout_ms
	);
	return (msg as Record<string, unknown>).params as Record<string, unknown>;
};

const create_terminal = async (
	ws: WsClient,
	id: string,
	params: Record<string, unknown>
): Promise<string> => {
	const result = await ws.request<Record<string, unknown>>(id, 'terminal_create', params);
	const terminal_id = result.terminal_id as string;
	assert.equal(typeof terminal_id, 'string');
	return terminal_id;
};

const process_exists = async (pid: number): Promise<boolean> => {
	try {
		await readFile(`/proc/${pid}/stat`, 'utf8');
		return true; // running or a zombie — either way not reaped
	} catch {
		return false;
	}
};

describe('terminal cross-backend', () => {
	test('terminal_create_echo', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const result = await ws.request<Record<string, unknown>>('tc-1', 'terminal_create', {
				command: 'echo',
				args: ['hello']
			});
			const terminal_id = result.terminal_id as string;
			assert.equal(typeof terminal_id, 'string');
			assert.ok(terminal_id.length > 0, 'terminal_id not empty');

			// Wait for terminal_data containing 'hello'.
			const data_msg = await ws.wait_for<Record<string, unknown>>((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_data') return false;
				const params = m.params as Record<string, unknown> | undefined;
				if (!params) return false;
				return params.terminal_id === terminal_id && String(params.data).includes('hello');
			}, 5_000);
			assert.ok(data_msg);

			const exited_msg = await ws.wait_for<Record<string, unknown>>((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_exited') return false;
				const params = m.params as Record<string, unknown> | undefined;
				return params?.terminal_id === terminal_id;
			}, 5_000);
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
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = await ws.request<Record<string, unknown>>('tcl-1', 'terminal_create', {
				command: 'sleep',
				args: ['60']
			});
			const terminal_id = create_result.terminal_id as string;

			const close_result = await ws.request<Record<string, unknown>>('tcl-2', 'terminal_close', {
				terminal_id
			});
			assert.ok(
				close_result.exit_code === null || typeof close_result.exit_code === 'number',
				'exit_code is number or null'
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
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = await ws.request<Record<string, unknown>>('twr-1', 'terminal_create', {
				command: 'cat',
				args: []
			});
			const terminal_id = create_result.terminal_id as string;
			assert.equal(typeof terminal_id, 'string');

			const write_result = await ws.request('twr-2', 'terminal_data_send', {
				terminal_id,
				data: 'integration test\n'
			});
			assert.equal(write_result, null, 'write result is null');

			const echo_msg = await ws.wait_for<Record<string, unknown>>((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_data') return false;
				const params = m.params as Record<string, unknown> | undefined;
				if (!params || params.terminal_id !== terminal_id) return false;
				return String(params.data).includes('integration test');
			}, 5_000);
			assert.ok(echo_msg);

			await ws.request('twr-3', 'terminal_close', { terminal_id }).catch(() => undefined);
		} finally {
			await ws.close();
		}
	});

	test('terminal_resize_live', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = await ws.request<Record<string, unknown>>('trl-1', 'terminal_create', {
				command: 'sleep',
				args: ['60']
			});
			const terminal_id = create_result.terminal_id as string;

			const resize_result = await ws.request('trl-2', 'terminal_resize', {
				terminal_id,
				cols: 120,
				rows: 40
			});
			assert.equal(resize_result, null, 'resize result is null');

			await ws.request('trl-3', 'terminal_close', { terminal_id }).catch(() => undefined);
		} finally {
			await ws.close();
		}
	});

	test('terminal_create_with_cwd', async () => {
		const fixture = await setup_test();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			await ws.request('_warmup', 'ping', undefined);

			const create_result = await ws.request<Record<string, unknown>>('tcc-1', 'terminal_create', {
				command: 'pwd',
				args: [],
				cwd: '/tmp'
			});
			assert.equal(typeof create_result.terminal_id, 'string');

			const data_msg = await ws.wait_for<Record<string, unknown>>((msg) => {
				if (!msg || typeof msg !== 'object') return false;
				const m = msg as Record<string, unknown>;
				if (m.method !== 'terminal_data') return false;
				const params = m.params as Record<string, unknown> | undefined;
				return !!params && String(params.data).includes('/tmp');
			}, 5_000);
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
			cookies: fixture.transport.cookies()
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
				const create_result = await ws.request<Record<string, unknown>>(
					'tcne-1',
					'terminal_create',
					{
						command: '/nonexistent/binary_zzz_test',
						args: []
					}
				);
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
				const exited = await ws.wait_for<Record<string, unknown>>((msg) => {
					if (!msg || typeof msg !== 'object') return false;
					const m = msg as Record<string, unknown>;
					if (m.method !== 'terminal_exited') return false;
					const params = m.params as Record<string, unknown> | undefined;
					return params?.terminal_id === terminal_id;
				}, 5_000);
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
			params: { terminal_id: NIL_UUID, data: 'hello' },
			headers: fixture.create_session_headers()
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
			params: { terminal_id: NIL_UUID },
			headers: fixture.create_session_headers()
		});
		assert.ok(res.ok);
		assert.deepEqual(res.result, { exit_code: null }, 'result is {exit_code: null}');
	});

	test('terminal_resize_missing', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'terminal_resize',
			params: { terminal_id: NIL_UUID, cols: 80, rows: 24 },
			headers: fixture.create_session_headers()
		});
		assert.ok(res.ok);
		assert.equal(res.result, null, 'silent null for missing terminal');
	});

	test('terminal_create_bad_cwd_fails', async () => {
		const ws = await open_ws();
		try {
			let create_error: Error | undefined;
			try {
				await ws.request('tbc-1', 'terminal_create', {
					command: 'pwd',
					args: [],
					cwd: '/nonexistent/zzz_cross_test_cwd'
				});
			} catch (e) {
				create_error = e as Error;
			}
			// a bad cwd must fail the spawn, not run the command in the daemon's cwd
			assert.ok(create_error, 'terminal_create should fail for a nonexistent cwd');
			assert.match(create_error.message, /-32603/);
			assert.match(create_error.message, /cwd/);
		} finally {
			await ws.close();
		}
	});

	test('terminal_large_paste_roundtrip', async () => {
		const ws = await open_ws();
		try {
			// echo off so the output is cat's copy alone
			const terminal_id = await create_terminal(ws, 'tlp-1', {
				command: 'sh',
				args: ['-c', 'stty -echo; echo READY; exec cat']
			});
			await wait_for_output(ws, terminal_id, (out) => out.includes('READY'));

			// ~22KB in one send — far past the PTY input buffer, so it only
			// arrives intact if partial writes are continued
			const lines = Array.from(
				{ length: 2000 },
				(_, i) => `line-${String(i + 1).padStart(5, '0')}`
			);
			await ws.request('tlp-2', 'terminal_data_send', {
				terminal_id,
				data: lines.join('\n') + '\n'
			});

			const output = await wait_for_output(ws, terminal_id, (out) =>
				out.includes(lines[lines.length - 1]!)
			);
			const echoed = output
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.startsWith('line-'));
			assert.deepEqual(echoed, lines, 'every pasted line arrives once, in order');

			await ws.request('tlp-3', 'terminal_close', { terminal_id }).catch(() => undefined);
		} finally {
			await ws.close();
		}
	});

	test('terminal_multibyte_output_split_across_reads', async () => {
		const ws = await open_ws();
		try {
			// 20000 3-byte characters: 60KB of output, so PTY reads split
			// characters at their boundaries
			const count = 20_000;
			const terminal_id = await create_terminal(ws, 'tmb-1', {
				command: 'awk',
				args: [`BEGIN { for (i = 0; i < ${count}; i++) printf "€" }`]
			});
			const exited = await wait_for_exited(ws, terminal_id);
			assert.equal(exited.exit_code, 0);
			const output = terminal_output(ws, terminal_id);
			assert.notInclude(output, '\uFFFD', 'no character mangled by a read boundary');
			assert.equal(output, '€'.repeat(count));
		} finally {
			await ws.close();
		}
	});

	test('terminal_env_scrubs_daemon_secrets', async () => {
		const ws = await open_ws();
		try {
			const terminal_id = await create_terminal(ws, 'tes-1', { command: 'env', args: [] });
			await wait_for_exited(ws, terminal_id);
			const names = terminal_output(ws, terminal_id)
				.split(/\r?\n/)
				.map((line) => line.split('=')[0]!)
				.filter(Boolean);
			assert.include(names, 'PATH', 'the user environment passes through');
			const leaked = names.filter(
				(name) =>
					/^(SECRET_|FUZ_|ZZZ_|PUBLIC_ZZZ_)/.test(name) ||
					name === 'DATABASE_URL' ||
					name === 'PORT'
			);
			assert.deepEqual(leaked, [], 'daemon secrets and config are withheld');
		} finally {
			await ws.close();
		}
	});

	test('terminal_close_reaps_child_ignoring_term_and_hup', async () => {
		const ws = await open_ws();
		try {
			// `exec` keeps the pid; the ignored dispositions survive it, so
			// neither the SIGTERM nor the hangup from closing ends the process
			const terminal_id = await create_terminal(ws, 'trp-1', {
				command: 'sh',
				args: ['-c', `trap '' TERM HUP; echo PID=$$; exec sleep 30`]
			});
			const output = await wait_for_output(ws, terminal_id, (out) => /PID=\d+/.test(out));
			const pid = Number(/PID=(\d+)/.exec(output)![1]);
			assert.ok(await process_exists(pid), 'child is running');

			const close_result = await ws.request<Record<string, unknown>>('trp-2', 'terminal_close', {
				terminal_id
			});
			assert.equal(close_result.exit_code, null, 'still running when close returns');

			// escalated to SIGKILL and reaped in the background — no zombie left
			const deadline = Date.now() + 10_000;
			while ((await process_exists(pid)) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(!(await process_exists(pid)), `pid ${pid} reaped (not running, not a zombie)`);
		} finally {
			await ws.close();
		}
	}, 20_000);

	test('terminal_output_and_control_are_scoped_to_the_owner', async () => {
		const fixture = await setup_test();
		const owner_ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		// the owner's second socket, e.g. another tab
		const owner_ws_2 = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		const other = await fixture.create_account();
		const other_ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: [`${handle.config.cookie_name}=${other.session_cookie}`]
		});
		try {
			await owner_ws.request('_warmup', 'ping', undefined);
			await owner_ws_2.request('_warmup', 'ping', undefined);
			await other_ws.request('_warmup', 'ping', undefined);

			const terminal_id = await create_terminal(owner_ws, 'own-1', { command: 'cat', args: [] });
			await owner_ws.request('own-2', 'terminal_data_send', { terminal_id, data: 'mine\n' });
			await wait_for_output(owner_ws, terminal_id, (out) => out.includes('mine'));
			// every socket of the owning account gets the output
			await wait_for_output(owner_ws_2, terminal_id, (out) => out.includes('mine'));

			// another account can't drive it: each call acts as for an unknown id
			assert.equal(
				await other_ws.request('oth-1', 'terminal_data_send', { terminal_id, data: 'theirs\n' }),
				null
			);
			assert.equal(
				await other_ws.request('oth-2', 'terminal_resize', { terminal_id, cols: 100, rows: 30 }),
				null
			);
			assert.deepEqual(await other_ws.request('oth-3', 'terminal_close', { terminal_id }), {
				exit_code: null
			});

			// still running for its owner, and the other account's input never reached it
			await owner_ws.request('own-3', 'terminal_data_send', { terminal_id, data: 'still\n' });
			const output = await wait_for_output(owner_ws, terminal_id, (out) => out.includes('still'));
			assert.ok(!output.includes('theirs'), 'other account input not written');

			// an exit notification reaches the owner only
			const exiting_id = await create_terminal(owner_ws, 'own-4', {
				command: 'echo',
				args: ['bye']
			});
			assert.equal((await wait_for_exited(owner_ws, exiting_id)).exit_code, 0);

			// a round-trip on the other socket flushes anything queued to it before
			await other_ws.request('oth-4', 'ping', undefined);
			const leaked = other_ws.messages.filter(
				(msg) =>
					is_notification(msg, 'terminal_data', terminal_id) ||
					is_notification(msg, 'terminal_data', exiting_id) ||
					is_notification(msg, 'terminal_exited', exiting_id)
			);
			assert.deepEqual(leaked, [], 'no terminal notifications reach another account');

			const close = await owner_ws.request<Record<string, unknown>>('own-5', 'terminal_close', {
				terminal_id
			});
			assert.ok(close.exit_code === null || typeof close.exit_code === 'number');
		} finally {
			await owner_ws.close();
			await owner_ws_2.close();
			await other_ws.close();
		}
	});

	test('terminal_processes_end_when_their_account_is_deleted', async () => {
		const fixture = await setup_test();
		const doomed = await fixture.create_account();
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: [`${handle.config.cookie_name}=${doomed.session_cookie}`]
		});
		let pid: number;
		try {
			await ws.request('_warmup', 'ping', undefined);
			const terminal_id = await create_terminal(ws, 'del-1', {
				command: 'sh',
				args: ['-c', 'echo PID=$$; exec sleep 60']
			});
			const output = await wait_for_output(ws, terminal_id, (out) => /PID=\d+/.test(out));
			pid = Number(/PID=(\d+)/.exec(output)![1]);
			assert.ok(await process_exists(pid), 'terminal process running');
		} finally {
			// the delete below closes this socket server-side
			await ws.close();
		}

		// self-delete — the spine revokes the account's sessions and sockets,
		// and zzz's audit listener closes its terminals
		const res = await rpc_call({
			app: fixture.fresh_transport(),
			path: handle.config.rpc_path,
			method: 'account_delete',
			params: {},
			headers: doomed.create_session_headers()
		});
		assert.ok(res.ok, JSON.stringify(res));

		const deadline = Date.now() + 10_000;
		while ((await process_exists(pid)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(!(await process_exists(pid)), `pid ${pid} reaped after the account was deleted`);
	}, 20_000);

	test('terminal_resize_rejects_out_of_range', async () => {
		const fixture = await setup_test();
		for (const [cols, rows] of [
			[0, 24],
			[80, 0],
			[65_536, 24],
			[80, 65_536]
		] as const) {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'terminal_resize',
				params: { terminal_id: NIL_UUID, cols, rows },
				headers: fixture.create_session_headers()
			});
			assert.ok(!res.ok, `cols=${cols} rows=${rows} rejected`);
			assert.equal(res.error.code, -32602);
		}
	});
});
