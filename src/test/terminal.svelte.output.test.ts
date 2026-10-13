// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';
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

/** A terminal whose process is already running as `terminal_id`. */
const create_running = (terminal_id: Uuid = create_uuid()): Terminal => {
	const terminal = app.terminals.add({ command: 'sh' });
	terminal.start(terminal_id);
	return terminal;
};

const acks = (): Array<StubbedTerminalCall> => calls_of(calls, 'terminal_ack');

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
		const terminal = create_running(terminal_id);
		terminal.receive_output('one', 3);
		terminal.receive_output('two', 6);
		assert.strictEqual(acks().length, 0, 'batched, not per chunk');
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 6 }]
		);
	});

	test('acks at once when a threshold of output is waiting', () => {
		const terminal = create_running();
		terminal.receive_output('x'.repeat(100), TERMINAL_ACK_THRESHOLD_BYTES);
		assert.strictEqual(acks().length, 1);
		assert.strictEqual(acks()[0]!.input.bytes, TERMINAL_ACK_THRESHOLD_BYTES);
	});

	test('with a view attached, acks only what the view has consumed', async () => {
		const terminal = create_running();
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
		const terminal = create_running();
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
		const terminal = create_running();
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
		const terminal = create_running();
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
		const terminal = create_running();
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
		const terminal = create_running();
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
		await settle_acks();
		assert.deepEqual(
			acks().map((c) => c.input),
			[{ terminal_id, bytes: 2 }]
		);
	});

	test("never acks another client's terminal", async () => {
		create_running();
		app.terminals.receive_output(create_uuid(), 'x'.repeat(100), 10 * TERMINAL_ACK_THRESHOLD_BYTES);
		await settle_acks();
		assert.strictEqual(acks().length, 0);
	});

	test('stops acking once the process has ended', async () => {
		const terminal = create_running();
		terminal.receive_output('one', 3);
		terminal.receive_exited(0);
		await settle_acks();
		assert.strictEqual(acks().length, 0);
	});

	test('a not_found ack ends the acks without marking the terminal lost', async () => {
		const terminal = create_running();
		terminal.receive_output('x', TERMINAL_ACK_THRESHOLD_BYTES);
		acks()[0]!.resolve(result_error(JSONRPC_ERROR_CODES.not_found, 'terminal not found'));
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(terminal.status, 'running');
		terminal.receive_output('y', 3 * TERMINAL_ACK_THRESHOLD_BYTES);
		await vi.advanceTimersByTimeAsync(TERMINAL_ACK_RETRY_DELAY * 2);
		assert.strictEqual(acks().length, 1, 'neither retried nor followed by another');
	});

	test("a restarted terminal acks the new process' counts under its new id", async () => {
		const old_id = create_uuid();
		const terminal = create_running(old_id);
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
