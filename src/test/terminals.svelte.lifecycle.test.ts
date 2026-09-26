// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '$lib/frontend.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	calls_of,
	flush,
	result_error,
	result_ok,
	stub_terminal_api,
	type StubbedTerminalCall
} from './terminal_test_helpers.ts';

let app: Frontend;
let calls: Array<StubbedTerminalCall>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = stub_terminal_api(app);
});

const last_call = (method: string): StubbedTerminalCall => calls_of(calls, method).at(-1)!;

describe('Terminals.create', () => {
	test('adds a starting terminal, spawns a shell, then types the command', async () => {
		const created = app.terminals.create({ command: 'echo', args: ['hi'] });
		const terminal = app.terminals.items.values[0]!;
		assert.strictEqual(terminal.status, 'starting');
		assert.deepEqual(last_call('terminal_create').input, { command: 'sh', args: [] });

		const terminal_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		assert.strictEqual(await created, terminal);
		assert.strictEqual(terminal.status, 'running');
		assert.strictEqual(terminal.terminal_id, terminal_id);
		assert.strictEqual(app.terminals.get_by_terminal_id(terminal_id), terminal);
		assert.strictEqual(last_call('terminal_data_send').input.data, 'echo hi\n');
	});

	test('records a spawn failure on the terminal', async () => {
		const created = app.terminals.create({ command: 'ls' });
		last_call('terminal_create').resolve(
			result_error(JSONRPC_ERROR_CODES.internal_error, 'no pty')
		);
		const terminal = await created;
		assert.strictEqual(terminal.status, 'failed');
		assert.include(terminal.error_message, 'no pty');
		assert.strictEqual(calls_of(calls, 'terminal_data_send').length, 0);
	});

	test('adopts output and exit that arrived before the create response', async () => {
		const created = app.terminals.create({ command: 'true' });
		const terminal_id = create_uuid();
		app.terminals.receive_output(terminal_id, '$ ');
		app.terminals.receive_exited(terminal_id, 3);
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		const terminal = await created;
		assert.strictEqual(terminal.output.text, '$ ');
		assert.strictEqual(terminal.status, 'exited');
		assert.strictEqual(terminal.exit_code, 3);
		assert.strictEqual(calls_of(calls, 'terminal_data_send').length, 0);
	});

	test('discards input queued while starting when the exit beat the create reply', async () => {
		const created = app.terminals.create({ command: 'true' });
		const terminal = app.terminals.items.values[0]!;
		terminal.send_input('typed early\n');
		const terminal_id = create_uuid();
		app.terminals.receive_exited(terminal_id, 0);
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		await created;
		await flush();
		assert.strictEqual(terminal.status, 'exited');
		assert.strictEqual(terminal.terminal_id, terminal_id);
		assert.strictEqual(calls_of(calls, 'terminal_data_send').length, 0);
	});

	test('types the command line ahead of input sent while starting', async () => {
		const created = app.terminals.create({ command: 'gro', args: ['check'] });
		const terminal = app.terminals.items.values[0]!;
		terminal.send_input('y\n');
		last_call('terminal_create').resolve(result_ok({ terminal_id: create_uuid() }));
		await created;
		assert.strictEqual(last_call('terminal_data_send').input.data, 'gro check\ny\n');
	});

	test('caps the output held for an unknown terminal id', async () => {
		const created = app.terminals.create({ command: 'ls' });
		const terminal_id = create_uuid();
		for (let i = 0; i < 100; i++) {
			app.terminals.receive_output(terminal_id, 'x'.repeat(1023) + '\n');
		}
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		const terminal = await created;
		assert.isAtMost(terminal.output.length, 64 * 1024);
		assert.isAbove(terminal.output.length, 0);
		// the dropped early output carries over, so the view shows the truncation note
		assert.ok(terminal.attach_output(() => undefined).truncated);
	});

	test('ignores output for unknown terminals when nothing is spawning', async () => {
		const created = app.terminals.create({ command: 'ls' });
		last_call('terminal_create').resolve(result_ok({ terminal_id: create_uuid() }));
		await created;
		const other_id = create_uuid();
		app.terminals.receive_output(other_id, 'not ours');
		// a later spawn that happens to get this id doesn't see the stale output
		const second = app.terminals.create({ command: 'ls' });
		last_call('terminal_create').resolve(result_ok({ terminal_id: other_id }));
		assert.strictEqual((await second).output.text, '');
	});

	test('closes the process of a terminal removed while starting', async () => {
		const created = app.terminals.create({ command: 'ls' });
		const terminal = app.terminals.items.values[0]!;
		await app.terminals.remove(terminal);
		assert.strictEqual(app.terminals.items.size, 0);

		const terminal_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		await created;
		assert.strictEqual(last_call('terminal_close').input.terminal_id, terminal_id);
		assert.isUndefined(app.terminals.get_by_terminal_id(terminal_id));
	});
});

describe('Terminals output and exit without a mounted view', () => {
	const create_running = async () => {
		const created = app.terminals.create({ command: 'ls' });
		const terminal_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		return { terminal: await created, terminal_id };
	};

	test('buffers output and replays it to a view attached later', async () => {
		const { terminal, terminal_id } = await create_running();
		app.terminals.receive_output(terminal_id, 'one ');
		app.terminals.receive_output(terminal_id, 'two ');

		// the buffered history is returned for replay, apart from the live stream
		const received: Array<string> = [];
		const first = terminal.attach_output((data) => received.push(data));
		assert.strictEqual(first.buffered, 'one two ');
		assert.ok(!first.truncated);
		assert.deepEqual(received, []);

		app.terminals.receive_output(terminal_id, 'three');
		assert.deepEqual(received, ['three']);

		first.detach();
		app.terminals.receive_output(terminal_id, ' four');
		assert.deepEqual(received, ['three']);

		// a remounted view replays everything, including what arrived while detached
		const second = terminal.attach_output(() => undefined);
		assert.strictEqual(second.buffered, 'one two three four');
	});

	test('records a natural exit with its code', async () => {
		const { terminal, terminal_id } = await create_running();
		app.terminals.receive_exited(terminal_id, 2);
		assert.strictEqual(terminal.status, 'exited');
		assert.strictEqual(terminal.exit_code, 2);
	});
});

describe('Terminal.close', () => {
	const create_running = async () => {
		const created = app.terminals.create({ command: 'ls' });
		const terminal_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		return { terminal: await created, terminal_id };
	};

	test('marks the terminal closed with the exit code from the response', async () => {
		const { terminal, terminal_id } = await create_running();
		const closing = terminal.close();
		assert.ok(terminal.closing);
		assert.strictEqual(last_call('terminal_close').input.terminal_id, terminal_id);
		last_call('terminal_close').resolve(result_ok({ exit_code: 143 }));
		await closing;
		assert.strictEqual(terminal.status, 'closed');
		assert.strictEqual(terminal.exit_code, 143);
		assert.ok(!terminal.closing);
	});

	test('marks the terminal closed with an unknown code when the process outlived the grace', async () => {
		const { terminal } = await create_running();
		const closing = terminal.close();
		last_call('terminal_close').resolve(result_ok({ exit_code: null }));
		await closing;
		assert.strictEqual(terminal.status, 'closed');
		assert.isNull(terminal.exit_code);
	});

	test('keeps a natural exit that raced the close', async () => {
		const { terminal, terminal_id } = await create_running();
		const closing = terminal.close();
		app.terminals.receive_exited(terminal_id, 0);
		last_call('terminal_close').resolve(result_ok({ exit_code: null }));
		await closing;
		assert.strictEqual(terminal.status, 'exited');
		assert.strictEqual(terminal.exit_code, 0);
	});

	test('surfaces a failed close and stays running', async () => {
		const { terminal } = await create_running();
		const closing = terminal.close();
		last_call('terminal_close').resolve(result_error(JSONRPC_ERROR_CODES.internal_error, 'nope'));
		await closing;
		assert.strictEqual(terminal.status, 'running');
		assert.include(terminal.error_message, 'nope');
		assert.ok(!terminal.closing);
	});

	test('closes without an error when the backend no longer has the process', async () => {
		const { terminal } = await create_running();
		const closing = terminal.close();
		last_call('terminal_close').resolve(
			result_error(JSONRPC_ERROR_CODES.not_found, 'terminal not found')
		);
		await closing;
		assert.strictEqual(terminal.status, 'closed');
		assert.isNull(terminal.exit_code);
		assert.isNull(terminal.error_message);
		assert.ok(!terminal.closing);
	});

	test('does nothing once the process ended', async () => {
		const { terminal, terminal_id } = await create_running();
		app.terminals.receive_exited(terminal_id, 0);
		await terminal.close();
		assert.strictEqual(calls_of(calls, 'terminal_close').length, 0);
	});
});

describe('Terminals.restart', () => {
	test('closes a running terminal and respawns it with a new id and cleared output', async () => {
		const created = app.terminals.create({ command: 'ls' });
		const old_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id: old_id }));
		const terminal = await created;
		app.terminals.receive_output(old_id, 'old output');

		const restarting = app.terminals.restart(terminal);
		last_call('terminal_close').resolve(result_ok({ exit_code: 0 }));
		await flush();
		assert.strictEqual(terminal.status, 'starting');
		assert.strictEqual(terminal.output.text, '');
		assert.strictEqual(terminal.run, 1); // one bump per process, so the view remounts once
		assert.isUndefined(app.terminals.get_by_terminal_id(old_id));

		const new_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id: new_id }));
		await restarting;
		assert.strictEqual(terminal.status, 'running');
		assert.strictEqual(terminal.terminal_id, new_id);
		assert.isNull(terminal.exit_code);
		assert.strictEqual(app.terminals.get_by_terminal_id(new_id), terminal);
		assert.strictEqual(app.terminals.items.size, 1);
		assert.strictEqual(terminal.run, 1);

		// the old process' trailing output doesn't leak into the new run
		app.terminals.receive_output(old_id, 'stale');
		assert.strictEqual(terminal.output.text, '');
	});

	test("the new run's input waits for the old process' in-flight send, then goes to the new id", async () => {
		const created = app.terminals.create({ command: 'ls' });
		last_call('terminal_create').resolve(result_ok({ terminal_id: create_uuid() }));
		const terminal = await created;
		const old_send = last_call('terminal_data_send'); // the command line, still in flight

		const restarting = app.terminals.restart(terminal);
		last_call('terminal_close').resolve(result_ok({ exit_code: 0 }));
		await flush();
		const new_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id: new_id }));
		await restarting;
		assert.strictEqual(calls_of(calls, 'terminal_data_send').length, 1);

		old_send.resolve(result_ok());
		await flush();
		const new_send = last_call('terminal_data_send');
		assert.notStrictEqual(new_send, old_send);
		assert.strictEqual(new_send.input.terminal_id, new_id);
		assert.strictEqual(new_send.input.data, 'ls\n');
	});

	test('respawns an exited terminal without closing it', async () => {
		const created = app.terminals.create({ command: 'ls' });
		const old_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id: old_id }));
		const terminal = await created;
		app.terminals.receive_exited(old_id, 0);

		const restarting = app.terminals.restart(terminal);
		assert.strictEqual(calls_of(calls, 'terminal_close').length, 0);
		last_call('terminal_create').resolve(result_ok({ terminal_id: create_uuid() }));
		await restarting;
		assert.strictEqual(terminal.status, 'running');
	});

	test('does not respawn when the close fails', async () => {
		const created = app.terminals.create({ command: 'ls' });
		last_call('terminal_create').resolve(result_ok({ terminal_id: create_uuid() }));
		const terminal = await created;

		const restarting = app.terminals.restart(terminal);
		last_call('terminal_close').resolve(result_error(JSONRPC_ERROR_CODES.internal_error, 'x'));
		await restarting;
		assert.strictEqual(calls_of(calls, 'terminal_create').length, 1);
		assert.strictEqual(terminal.status, 'running');
	});
});

describe('Terminals.remove', () => {
	test('removes a terminal whose process the backend no longer has', async () => {
		const created = app.terminals.create({ command: 'ls' });
		last_call('terminal_create').resolve(result_ok({ terminal_id: create_uuid() }));
		const terminal = await created;

		const removing = app.terminals.remove(terminal);
		last_call('terminal_close').resolve(
			result_error(JSONRPC_ERROR_CODES.not_found, 'terminal not found')
		);
		await removing;
		assert.strictEqual(app.terminals.items.size, 0);
	});

	test('closes a running terminal, then removes and disposes it', async () => {
		const created = app.terminals.create({ command: 'ls' });
		const terminal_id = create_uuid();
		last_call('terminal_create').resolve(result_ok({ terminal_id }));
		const terminal = await created;
		assert.ok(app.cell_registry.all.has(terminal.id));

		const removing = app.terminals.remove(terminal);
		last_call('terminal_close').resolve(result_ok({ exit_code: 0 }));
		await removing;
		assert.strictEqual(app.terminals.items.size, 0);
		assert.ok(!app.cell_registry.all.has(terminal.id));
		assert.isUndefined(app.terminals.get_by_terminal_id(terminal_id));
	});

	test('keeps a running terminal whose close fails', async () => {
		const created = app.terminals.create({ command: 'ls' });
		last_call('terminal_create').resolve(result_ok({ terminal_id: create_uuid() }));
		const terminal = await created;

		const removing = app.terminals.remove(terminal);
		last_call('terminal_close').resolve(result_error(JSONRPC_ERROR_CODES.internal_error, 'x'));
		await removing;
		assert.strictEqual(app.terminals.items.size, 1);
		assert.ok(app.cell_registry.all.has(terminal.id));
	});
});
