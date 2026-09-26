// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import type { Terminal } from '$lib/terminal.svelte.ts';
import { TERMINAL_INPUT_PENDING_MAX_LENGTH } from '$lib/terminal_helpers.ts';

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

/** A terminal whose process is already running as `terminal_id`. */
const create_running = (terminal_id: Uuid = create_uuid()): Terminal => {
	const terminal = app.terminals.add({ command: 'sh' });
	terminal.start(terminal_id);
	return terminal;
};

const sends = (): Array<StubbedTerminalCall> => calls_of(calls, 'terminal_data_send');

describe('Terminal.send_input', () => {
	test('keeps at most one send in flight and coalesces input typed meanwhile', async () => {
		const terminal = create_running();
		terminal.send_input('a');
		terminal.send_input('b');
		terminal.send_input('c');
		assert.strictEqual(sends().length, 1);
		assert.strictEqual(sends()[0]!.input.data, 'a');

		sends()[0]!.resolve(result_ok());
		await flush();
		assert.strictEqual(sends().length, 2);
		assert.strictEqual(sends()[1]!.input.data, 'bc');

		terminal.send_input('d');
		assert.strictEqual(sends().length, 2);
		sends()[1]!.resolve(result_ok());
		await flush();
		assert.strictEqual(sends()[2]!.input.data, 'd');
		sends()[2]!.resolve(result_ok());
		await flush();
		assert.strictEqual(sends().length, 3);
	});

	test('sends in order to the terminal id', async () => {
		const terminal_id = create_uuid();
		const terminal = create_running(terminal_id);
		terminal.send_input('x');
		assert.strictEqual(sends()[0]!.input.terminal_id, terminal_id);
		sends()[0]!.resolve(result_ok());
		await flush();
	});

	test('queues input while starting and sends it once started', async () => {
		const terminal = app.terminals.add({ command: 'sh' });
		terminal.send_input('early');
		assert.strictEqual(sends().length, 0);
		terminal.start(create_uuid());
		assert.strictEqual(sends().length, 1);
		assert.strictEqual(sends()[0]!.input.data, 'early');
	});

	test('ignores input after the process ended', () => {
		const terminal = create_running();
		terminal.receive_exited(0);
		terminal.send_input('late');
		assert.strictEqual(sends().length, 0);
	});

	test('surfaces a non-retryable failure without resending, then clears on success', async () => {
		const terminal = create_running();
		terminal.send_input('a');
		sends()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.internal_error, 'boom'));
		await flush();
		assert.include(terminal.error_message, 'boom');
		assert.strictEqual(sends().length, 1);

		terminal.send_input('b');
		assert.strictEqual(sends()[1]!.input.data, 'b');
		sends()[1]!.resolve(result_ok());
		await flush();
		assert.isNull(terminal.error_message);
	});

	test('refuses input past the pending cap and surfaces it', () => {
		const terminal = create_running();
		terminal.send_input('a'); // in flight, not pending
		terminal.send_input('x'.repeat(TERMINAL_INPUT_PENDING_MAX_LENGTH));
		assert.isNull(terminal.error_message);
		terminal.send_input('y');
		assert.include(terminal.error_message as string | null, 'input dropped'); // widen the narrowing from `isNull`
	});
});

describe('Terminal.send_input queue_overflow', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test('retries the refused data first, with input typed meanwhile appended', async () => {
		const terminal = create_running();
		terminal.send_input('a');
		terminal.send_input('b');
		sends()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.queue_overflow, 'full'));
		await flush();
		assert.include(terminal.error_message, "isn't reading its input");
		assert.strictEqual(sends().length, 1); // waits out the backoff

		terminal.send_input('c');
		assert.strictEqual(sends().length, 1);

		await vi.advanceTimersByTimeAsync(100);
		assert.strictEqual(sends().length, 2);
		assert.strictEqual(sends()[1]!.input.data, 'abc');

		sends()[1]!.resolve(result_ok());
		await flush();
		assert.isNull(terminal.error_message);
	});

	test('backs off exponentially while the child stays blocked', async () => {
		const terminal = create_running();
		terminal.send_input('a');
		sends()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.queue_overflow, 'full'));
		await flush();
		await vi.advanceTimersByTimeAsync(100);
		sends()[1]!.resolve(result_error(JSONRPC_ERROR_CODES.queue_overflow, 'full'));
		await flush();
		await vi.advanceTimersByTimeAsync(199);
		assert.strictEqual(sends().length, 2);
		await vi.advanceTimersByTimeAsync(1);
		assert.strictEqual(sends().length, 3);
	});

	test('drops the queued input and stops retrying when the process ends', async () => {
		const terminal = create_running();
		terminal.send_input('a');
		sends()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.queue_overflow, 'full'));
		await flush();
		terminal.receive_exited(1);
		await vi.advanceTimersByTimeAsync(5000);
		assert.strictEqual(sends().length, 1);
	});
});

describe('Terminal.resize', () => {
	test('coalesces to the latest size while one is in flight', async () => {
		const terminal = create_running();
		const resizes = (): Array<StubbedTerminalCall> => calls_of(calls, 'terminal_resize');
		terminal.resize(80, 24);
		terminal.resize(100, 30);
		terminal.resize(120, 40);
		assert.strictEqual(resizes().length, 1);
		resizes()[0]!.resolve(result_ok());
		await flush();
		assert.strictEqual(resizes().length, 2);
		assert.deepEqual(
			{ cols: resizes()[1]!.input.cols, rows: resizes()[1]!.input.rows },
			{ cols: 120, rows: 40 }
		);
	});

	test('holds a resize requested while starting until started', () => {
		const terminal = app.terminals.add({ command: 'sh' });
		terminal.resize(100, 30);
		assert.strictEqual(calls_of(calls, 'terminal_resize').length, 0);
		terminal.start(create_uuid());
		assert.strictEqual(calls_of(calls, 'terminal_resize').length, 1);
	});
});
