// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Terminal } from '#lib/terminal.svelte.ts';
import {
	TERMINAL_ACK_DELAY,
	TERMINAL_ACK_RETRY_DELAY,
	TERMINAL_ACK_THRESHOLD_BYTES
} from '#lib/terminal_helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	calls_of,
	result_error,
	result_ok,
	stub_terminal_api,
	type StubbedTerminalCall
} from './terminal_test_helpers.ts';

let app: Frontend;
let calls: Array<StubbedTerminalCall>;

beforeEach(() => {
	vi.useFakeTimers();
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = stub_terminal_api(app);
});

afterEach(() => {
	vi.useRealTimers();
});

const acks = (): Array<StubbedTerminalCall> => calls_of(calls, 'terminal_ack');

/**
 * Settles the ack a start announces and drops it from `calls`, so a test
 * counts only the acks its output causes.
 */
const settle_start_announce = async (terminal_id: Uuid): Promise<void> => {
	const announce = acks().at(-1);
	assert.deepEqual(announce?.input, { terminal_id, bytes: 0 }, 'the start announces 0');
	calls.splice(calls.indexOf(announce!), 1);
	announce!.resolve(result_ok());
	await vi.advanceTimersByTimeAsync(0);
};

/**
 * A terminal whose process is already running as `terminal_id`, its start's
 * announce settled (see `settle_start_announce`).
 */
const create_running = async (terminal_id: Uuid = create_uuid()): Promise<Terminal> => {
	const terminal = app.terminals.add({ command: 'sh' });
	terminal.start(terminal_id);
	await settle_start_announce(terminal_id);
	return terminal;
};

/** Runs the ack delay out, so anything consumed has been acked. */
const settle_acks = async (): Promise<void> => {
	await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY);
};

/** A listener that holds each chunk's `consumed` callback for the test to call. */
const create_view = (): {
	listener: (data: string, consumed: () => void) => void;
	consumed: Array<() => void>;
} => {
	const consumed: Array<() => void> = [];
	return { listener: (_data, done) => consumed.push(done), consumed };
};

describe('Terminal output acks', () => {
	test('acks output on receipt when no view is attached', async () => {
		const terminal_id = create_uuid();
		const terminal = await create_running(terminal_id);
		terminal.receive_output('one', 3);
		terminal.receive_output('two', 6);
		assert.strictEqual(acks().length, 0, 'batched, not per chunk');
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 6 }]
		);
	});

	test('acks at once when a threshold of output is waiting', async () => {
		const terminal = await create_running();
		terminal.receive_output('x'.repeat(100), TERMINAL_ACK_THRESHOLD_BYTES);
		assert.strictEqual(acks().length, 1);
		assert.strictEqual(acks()[0]!.input.bytes, TERMINAL_ACK_THRESHOLD_BYTES);
	});

	test('with a view attached, acks only what the view has consumed', async () => {
		const terminal = await create_running();
		const view = create_view();
		terminal.attach_output(view.listener);
		terminal.receive_output('one', 3);
		terminal.receive_output('two', 6);
		terminal.receive_output('three', 11);
		await settle_acks();
		assert.strictEqual(acks().length, 0, 'the view has consumed nothing yet');

		view.consumed[1]!(); // through `two`
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input.bytes),
			[6]
		);
	});

	test('with several views, acks what the slowest has consumed', async () => {
		const terminal = await create_running();
		const fast = create_view();
		const slow = create_view();
		terminal.attach_output(fast.listener);
		terminal.attach_output(slow.listener);
		terminal.receive_output('one', 3);
		terminal.receive_output('two', 6);
		fast.consumed[1]!();
		await settle_acks();
		assert.strictEqual(acks().length, 0);
		slow.consumed[0]!();
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input.bytes),
			[3]
		);
	});

	test('a view that detaches no longer holds its unconsumed output back', async () => {
		const terminal = await create_running();
		const view = create_view();
		const attachment = terminal.attach_output(view.listener);
		terminal.receive_output('one', 3);
		await settle_acks();
		assert.strictEqual(acks().length, 0);
		attachment.detach();
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input.bytes),
			[3]
		);
		// its late callback changes nothing
		view.consumed[0]!();
		await settle_acks();
		assert.strictEqual(acks().length, 1);
	});

	test('a view attached later starts caught up with the buffered output', async () => {
		const terminal = await create_running();
		terminal.receive_output('one', 3);
		const view = create_view();
		terminal.attach_output(view.listener);
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input.bytes),
			[3],
			'the replayed history is not waited on'
		);
	});

	test('a view attached mid-stream is not waited on for output it replays', async () => {
		const terminal = await create_running();
		const first = create_view();
		terminal.attach_output(first.listener);
		terminal.receive_output('one', 3);
		terminal.receive_output('two', 6);
		// the second view replays both chunks from the buffer — it never gets
		// their callbacks, so the ack must not wait for them
		terminal.attach_output(create_view().listener);
		first.consumed[1]!();
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input.bytes),
			[6]
		);
	});

	test("a restarted terminal's counts start over with no view attached", async () => {
		const terminal = await create_running();
		terminal.receive_output('old', TERMINAL_ACK_THRESHOLD_BYTES * 4);
		acks()[0]!.resolve(result_ok());

		const restarting = app.terminals.restart(terminal);
		calls_of(calls, 'terminal_close')
			.at(-1)!
			.resolve(result_ok({ exit_code: 0 }));
		await vi.advanceTimersByTimeAsync(0);
		const new_id = create_uuid();
		calls_of(calls, 'terminal_create')
			.at(-1)!
			.resolve(result_ok({ terminal_id: new_id }));
		await restarting;
		await settle_start_announce(new_id);

		app.terminals.receive_output(new_id, 'new', 3);
		await settle_acks();
		assert.deepEqual(acks().at(-1)!.input, { terminal_id: new_id, bytes: 3 });
	});

	test('acks output that arrived before the create reply once the process starts', async () => {
		const created = app.terminals.create({ command: 'ls' });
		const terminal_id = create_uuid();
		app.terminals.receive_output(terminal_id, '$ ', 2);
		await settle_acks();
		assert.strictEqual(acks().length, 0, 'not ours to ack until the create reply claims it');
		calls_of(calls, 'terminal_create').at(-1)!.resolve(result_ok({ terminal_id }));
		await created;
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 2 }],
			'announced at the start, without the delay'
		);
	});

	test("never acks another client's terminal", async () => {
		await create_running();
		app.terminals.receive_output(create_uuid(), 'x'.repeat(100), 10 * TERMINAL_ACK_THRESHOLD_BYTES);
		await settle_acks();
		assert.strictEqual(acks().length, 0);
	});

	test('stops acking once the process has ended', async () => {
		const terminal = await create_running();
		terminal.receive_output('one', 3);
		terminal.receive_exited(0);
		await settle_acks();
		assert.strictEqual(acks().length, 0);
	});

	test('a not_found ack ends the acks, silently, without marking the terminal lost', async () => {
		const console_error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const terminal = await create_running();
			terminal.receive_output('x', TERMINAL_ACK_THRESHOLD_BYTES);
			acks()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.not_found, 'terminal not found'));
			await vi.advanceTimersByTimeAsync(0);
			assert.strictEqual(terminal.status, 'running');
			terminal.receive_output('y', 3 * TERMINAL_ACK_THRESHOLD_BYTES);
			await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY * 2);
			assert.strictEqual(acks().length, 1, 'neither retried nor followed by another');
			assert.strictEqual(
				console_error.mock.calls.length,
				0,
				'an ack racing its terminal is expected'
			);
		} finally {
			console_error.mockRestore();
		}
	});

	test('any other failed ack is reported and retried', async () => {
		const console_error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const terminal = await create_running();
			terminal.receive_output('x', TERMINAL_ACK_THRESHOLD_BYTES);
			acks()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.internal_error, 'boom'));
			await vi.advanceTimersByTimeAsync(0);
			assert.deepEqual(console_error.mock.calls, [['[terminal] terminal_ack failed:', 'boom']]);
			await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY);
			assert.strictEqual(acks().length, 2);
		} finally {
			console_error.mockRestore();
		}
	});

	test("a restarted terminal acks the new process' counts under its new id", async () => {
		const old_id = create_uuid();
		const terminal = await create_running(old_id);
		const view = create_view();
		terminal.attach_output(view.listener);
		terminal.receive_output('old', TERMINAL_ACK_THRESHOLD_BYTES * 4);

		const restarting = app.terminals.restart(terminal);
		calls_of(calls, 'terminal_close')
			.at(-1)!
			.resolve(result_ok({ exit_code: 0 }));
		await vi.advanceTimersByTimeAsync(0);
		const new_id = create_uuid();
		calls_of(calls, 'terminal_create')
			.at(-1)!
			.resolve(result_ok({ terminal_id: new_id }));
		await restarting;
		await settle_start_announce(new_id);

		// the old process' chunk, consumed late, acks nothing against the new one
		view.consumed[0]!();
		await settle_acks();
		assert.strictEqual(acks().length, 0);

		app.terminals.receive_output(new_id, 'new', 3);
		view.consumed[1]!();
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id: new_id, bytes: 3 }]
		);
	});
});

describe('Terminal output acks across socket connects', () => {
	test('a terminal starting with no output announces 0 at once', () => {
		const terminal_id = create_uuid();
		const terminal = app.terminals.add({ command: 'sh' });
		terminal.start(terminal_id);
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 0 }],
			'before any output, so the backend paces it from its first byte'
		);
	});

	test('a terminal starting with a view still holding its output announces 0', () => {
		const terminal_id = create_uuid();
		const terminal = app.terminals.add({ command: 'sh' });
		terminal.attach_output(create_view().listener);
		terminal.receive_output('$ ', 2);
		terminal.start(terminal_id);
		assert.deepEqual(
			acks().map((c) => c.input.bytes),
			[0]
		);
	});

	test('an exit that beat the create reply announces nothing', async () => {
		const terminal = app.terminals.add({ command: 'sh' });
		terminal.start(create_uuid(), { exit_code: 0 });
		await settle_acks();
		assert.strictEqual(acks().length, 0);
	});

	test('after a reconnect, holds the old position and announces where the new output starts', async () => {
		const terminal_id = create_uuid();
		const terminal = await create_running(terminal_id);
		const view = create_view();
		terminal.attach_output(view.listener);
		terminal.receive_output('one', 3);
		terminal.receive_output('two', 6);
		view.consumed[0]!(); // its ack is waiting out the delay

		app.terminals.receive_socket_connect();
		// the old chunk, consumed late, would ack a position from before the
		// connection: the backend may have sent far more while the socket was down
		view.consumed[1]!();
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY * 10);
		assert.strictEqual(acks().length, 0, 'held, the pending ack cancelled');

		// the first chunk on the new connection: `sent_bytes` 1000, so it starts at 995
		terminal.receive_output('three', 1000);
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 995 }],
			'at once, before the view consumes it'
		);
		acks()[0]!.resolve(result_ok());
		await vi.advanceTimersByTimeAsync(0);

		view.consumed[2]!();
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input.bytes),
			[995, 1000],
			'then by the batching rule'
		);
	});

	test('after a reconnect with no view, announces through the first new chunk', async () => {
		const terminal_id = create_uuid();
		const terminal = await create_running(terminal_id);
		app.terminals.receive_socket_connect();
		terminal.receive_output('abc', 500);
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 500 }],
			'buffering it was consuming it'
		);
	});

	test("after a reconnect, the new output's start is counted in UTF-8 bytes, as the backend counts", async () => {
		const terminal_id = create_uuid();
		const terminal = await create_running(terminal_id);
		terminal.attach_output(create_view().listener); // a view still loading holds it
		app.terminals.receive_socket_connect();
		// 2 + 3 + 4 bytes in UTF-8, but 4 UTF-16 code units
		terminal.receive_output('é→😀', 1000);
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 991 }]
		);
	});

	test('an ack the old socket failed is not retried, and the announce follows it at once', async () => {
		const console_error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const terminal_id = create_uuid();
			const terminal = await create_running(terminal_id);
			terminal.receive_output('x', TERMINAL_ACK_THRESHOLD_BYTES);
			assert.strictEqual(acks().length, 1, 'in flight on the old socket');

			app.terminals.receive_socket_connect();
			terminal.receive_output('y', 5 * TERMINAL_ACK_THRESHOLD_BYTES);
			assert.strictEqual(acks().length, 1, 'one ack in flight');

			// the old socket's close rejects it
			acks()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.service_unavailable, 'socket torn down'));
			await vi.advanceTimersByTimeAsync(0);
			assert.deepEqual(
				acks().map((c) => c.input.bytes),
				[TERMINAL_ACK_THRESHOLD_BYTES, 5 * TERMINAL_ACK_THRESHOLD_BYTES],
				'the announce, not a retry of the old count'
			);
			await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY * 10);
			assert.strictEqual(acks().length, 2);
		} finally {
			console_error.mockRestore();
		}
	});

	test('a reconnect while starting holds the acks past the create reply', async () => {
		const created = app.terminals.create({ command: 'ls' });
		const terminal_id = create_uuid();
		const terminal = app.terminals.items.values.at(-1)!;
		app.terminals.receive_socket_connect();
		calls_of(calls, 'terminal_create').at(-1)!.resolve(result_ok({ terminal_id }));
		await created;
		await settle_acks();
		assert.strictEqual(acks().length, 0, 'output before the connect may be missing');
		assert.strictEqual(terminal.status, 'running');

		app.terminals.receive_output(terminal_id, 'abc', 2_000_000);
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 2_000_000 }]
		);
	});

	test('a restart after a reconnect announces the new process from 0', async () => {
		const terminal = await create_running();
		app.terminals.receive_socket_connect();
		const restarting = app.terminals.restart(terminal);
		calls_of(calls, 'terminal_close')
			.at(-1)!
			.resolve(result_ok({ exit_code: 0 }));
		await vi.advanceTimersByTimeAsync(0);
		const new_id = create_uuid();
		calls_of(calls, 'terminal_create')
			.at(-1)!
			.resolve(result_ok({ terminal_id: new_id }));
		await restarting;
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id: new_id, bytes: 0 }]
		);
	});

	test('a terminal that has ended announces nothing', async () => {
		const exited = await create_running();
		exited.receive_exited(0);
		const lost = await create_running();
		lost.mark_lost('gone');
		app.terminals.receive_socket_connect();
		exited.receive_output('x', 10);
		lost.receive_output('x', 10);
		await settle_acks();
		assert.strictEqual(acks().length, 0);
	});

	test("never announces another client's terminal", async () => {
		app.terminals.receive_socket_connect();
		app.terminals.receive_output(create_uuid(), 'x', 10 * TERMINAL_ACK_THRESHOLD_BYTES);
		await settle_acks();
		assert.strictEqual(acks().length, 0);
	});
});
