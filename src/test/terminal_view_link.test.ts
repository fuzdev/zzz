// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import type {
	FuzTerminalStatus,
	FuzTerminalWriteOptions
} from '#lib/fuz_terminal/fuz_terminal_state.svelte.ts';
import type { Terminal, TerminalOutputListener } from '#lib/terminal.svelte.ts';
import { TERMINAL_ACK_DELAY } from '#lib/terminal_helpers.ts';
import {
	TERMINAL_TRUNCATED_NOTICE,
	TerminalViewLink,
	type TerminalViewLinkTerminal,
	type TerminalViewLinkView
} from '#lib/terminal_view_link.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	calls_of,
	flush,
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

/** A running terminal, the ack of 0 its start announces settled and dropped from `calls`. */
const create_running = async (terminal_id: Uuid = create_uuid()): Promise<Terminal> => {
	const terminal = app.terminals.add({ command: 'sh' });
	terminal.start(terminal_id);
	const announce = calls_of(calls, 'terminal_ack');
	assert.deepEqual(
		announce.map((c) => c.input),
		[{ terminal_id, bytes: 0 }],
		'the start announces 0'
	);
	calls.splice(calls.indexOf(announce[0]!), 1);
	announce[0]!.resolve(result_ok());
	await flush();
	return terminal;
};

/** A view recording its writes, in `status` (ready unless set); `write` throws while `fail` is set. */
const create_view = (): TerminalViewLinkView & {
	writes: Array<{ data: string; options: FuzTerminalWriteOptions | undefined }>;
	fail: boolean;
	status: FuzTerminalStatus;
} => {
	const view = {
		writes: [] as Array<{ data: string; options: FuzTerminalWriteOptions | undefined }>,
		fail: false,
		status: { kind: 'ready' } as FuzTerminalStatus,
		write: (data: string, options?: FuzTerminalWriteOptions) => {
			if (view.fail) throw new Error('write failed');
			view.writes.push({ data, options });
		},
		get_status: () => view.status
	};
	return view;
};

const LOADING: FuzTerminalStatus = { kind: 'loading' };

/**
 * The `bytes` of the acks sent since the last call, once the ack delay has
 * run out — each answered, so the next can go out.
 */
const new_acks = async (): Promise<Array<number>> => {
	await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY);
	const acks = calls_of(calls, 'terminal_ack');
	for (const call of acks) {
		calls.splice(calls.indexOf(call), 1);
		call.resolve(result_ok());
	}
	await flush();
	return acks.map((c) => c.input.bytes);
};

/** Answer every call in flight, so the next one can go out. */
const settle_calls = async (): Promise<void> => {
	for (const call of calls.splice(0)) call.resolve(result_ok());
	await flush();
};

describe('TerminalViewLink output', () => {
	test('replays the buffered history, then writes live output plainly', async () => {
		const terminal = await create_running();
		terminal.receive_output('one\r\n', 5);
		terminal.receive_output('two\r\n', 10);
		const view = create_view();
		new TerminalViewLink(terminal).connect(view);
		assert.deepEqual(view.writes, [{ data: 'one\r\ntwo\r\n', options: { replay: true } }]);
		terminal.receive_output('three', 15);
		assert.deepEqual(view.writes[1], { data: 'three', options: undefined });
	});

	test('writes nothing for an empty history', async () => {
		const terminal = await create_running();
		const view = create_view();
		new TerminalViewLink(terminal).connect(view);
		assert.deepEqual(view.writes, []);
	});

	test('replays the truncated notice ahead of a history that lost output', async () => {
		const terminal = await create_running();
		terminal.receive_output('kept', 4);
		terminal.output.mark_dropped();
		const view = create_view();
		new TerminalViewLink(terminal).connect(view);
		assert.deepEqual(view.writes, [
			{ data: TERMINAL_TRUNCATED_NOTICE, options: { replay: true } },
			{ data: 'kept', options: { replay: true } }
		]);
	});

	test('a ready view consumes each chunk as soon as it is written', async () => {
		const terminal = await create_running();
		const view = create_view();
		new TerminalViewLink(terminal).connect(view);
		terminal.receive_output('a', 1);
		assert.deepEqual(await new_acks(), [1]);
		terminal.receive_output('b', 2);
		assert.deepEqual(await new_acks(), [2]);
	});

	test('a throwing write is logged, never thrown into the cell, and still consumed', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const terminal = await create_running();
		const view = create_view();
		const other: Array<string> = [];
		new TerminalViewLink(terminal).connect(view);
		terminal.attach_output((data, consumed) => {
			other.push(data);
			consumed();
		});
		view.fail = true;
		terminal.receive_output('a', 1);
		assert.deepEqual(other, ['a'], 'the other listener still got it');
		assert.strictEqual(error.mock.calls.length, 1);
		assert.deepEqual(await new_acks(), [1]);
		error.mockRestore();
	});

	test('after disconnect nothing is written and the terminal waits on nothing', async () => {
		const terminal = await create_running();
		const view = create_view();
		const link = new TerminalViewLink(terminal);
		link.connect(view);
		terminal.receive_output('a', 1);
		assert.deepEqual(await new_acks(), [1]);
		link.disconnect();
		link.disconnect();
		terminal.receive_output('b', 2);
		assert.strictEqual(view.writes.length, 1);
		assert.deepEqual(await new_acks(), [2], 'acked as buffered, with no view attached');
	});

	test('connects once', async () => {
		const terminal = await create_running();
		terminal.receive_output('one', 3);
		const view = create_view();
		const link = new TerminalViewLink(terminal);
		link.connect(view);
		link.connect(view);
		assert.strictEqual(view.writes.length, 1);
	});
});

describe('TerminalViewLink acks while the view loads', () => {
	const connect_loading = (
		terminal: Terminal
	): { view: ReturnType<typeof create_view>; link: TerminalViewLink } => {
		const view = create_view();
		view.status = LOADING;
		const link = new TerminalViewLink(terminal);
		link.connect(view);
		return { view, link };
	};

	test('chunks are written but not consumed until the view is ready, then in order', async () => {
		const terminal = await create_running();
		const { view, link } = connect_loading(terminal);
		terminal.receive_output('a', 1);
		terminal.receive_output('b', 2);
		assert.deepEqual(
			view.writes.map((w) => w.data),
			['a', 'b'],
			'written, for the view to queue'
		);
		assert.deepEqual(await new_acks(), []);
		link.view_status_changed();
		assert.deepEqual(await new_acks(), [], 'still loading: nothing changes');
		view.status = { kind: 'ready' };
		link.view_status_changed();
		assert.deepEqual(await new_acks(), [2]);
		// once ready, at once again
		terminal.receive_output('c', 3);
		assert.deepEqual(await new_acks(), [3]);
	});

	test('the waiting chunks are consumed in the order they arrived', () => {
		// a stand-in cell, to see each chunk's own `consumed`
		let listener: TerminalOutputListener | null = null;
		const cell: TerminalViewLinkTerminal = {
			attach_output: (l) => {
				listener = l;
				return { buffered: '', truncated: false, detach: () => (listener = null) };
			},
			send_input: () => {},
			resize: () => {}
		};
		const view = create_view();
		view.status = LOADING;
		const link = new TerminalViewLink(cell);
		link.connect(view);
		const consumed: Array<string> = [];
		for (const data of ['a', 'b', 'c']) listener!(data, () => consumed.push(data));
		assert.deepEqual(consumed, []);
		view.status = { kind: 'ready' };
		link.view_status_changed();
		assert.deepEqual(consumed, ['a', 'b', 'c']);
		link.view_status_changed();
		assert.deepEqual(consumed, ['a', 'b', 'c'], 'each once');
	});

	test('a waiting chunk whose consumed throws doesn’t drop the rest', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		let listener: TerminalOutputListener | null = null;
		const cell: TerminalViewLinkTerminal = {
			attach_output: (l) => {
				listener = l;
				return { buffered: '', truncated: false, detach: () => (listener = null) };
			},
			send_input: () => {},
			resize: () => {}
		};
		const view = create_view();
		view.status = LOADING;
		const link = new TerminalViewLink(cell);
		link.connect(view);
		const consumed: Array<string> = [];
		listener!('a', () => consumed.push('a'));
		listener!('b', () => {
			throw new Error('consumed failed');
		});
		listener!('c', () => consumed.push('c'));
		view.status = { kind: 'ready' };
		link.view_status_changed();
		assert.deepEqual(consumed, ['a', 'c']);
		assert.strictEqual(error.mock.calls.length, 1);
		error.mockRestore();
	});

	for (const status of [
		{ kind: 'failed', error: null, message: 'no module' },
		{ kind: 'poisoned', error: null, message: 'trap' }
	] as const) {
		test(`a view that goes ${status.kind} while loading consumes what waited`, async () => {
			const terminal = await create_running();
			const { view, link } = connect_loading(terminal);
			terminal.receive_output('a', 1);
			assert.deepEqual(await new_acks(), []);
			view.status = status;
			link.view_status_changed();
			assert.deepEqual(await new_acks(), [1]);
			terminal.receive_output('b', 2);
			assert.deepEqual(await new_acks(), [2], 'and what follows, at once');
		});
	}

	test('a detach while loading releases the waiting chunks through the cell, once', async () => {
		const terminal = await create_running();
		const { link } = connect_loading(terminal);
		// a second view, ready, consumes as it goes: the cell acks the least of the two
		const ready = create_view();
		const ready_link = new TerminalViewLink(terminal);
		ready_link.connect(ready);
		terminal.receive_output('a', 1);
		terminal.receive_output('b', 2);
		assert.deepEqual(await new_acks(), [], 'held back by the loading view');
		link.disconnect();
		assert.deepEqual(await new_acks(), [2], 'the ready view had consumed through 2');
		// a late status change on the detached link consumes nothing more
		link.view_status_changed();
		terminal.receive_output('c', 3);
		assert.deepEqual(await new_acks(), [3]);
		ready_link.disconnect();
	});
});

describe('TerminalViewLink input and size', () => {
	test('decodes UTF-8 split across sends', async () => {
		const terminal = await create_running();
		const link = new TerminalViewLink(terminal);
		link.connect(create_view());
		const bytes = new TextEncoder().encode('é€');
		link.send(bytes.subarray(0, 1));
		link.send(bytes.subarray(1, 3));
		link.send(bytes.subarray(3));
		const sends: Array<StubbedTerminalCall> = [];
		// one send in flight at a time: answer each to let the next out
		for (let i = 0; i < 3; i++) {
			await flush();
			const sent = calls_of(calls, 'terminal_data_send');
			sends.push(...sent);
			await settle_calls();
		}
		assert.strictEqual(sends.map((c) => c.input.data).join(''), 'é€');
		assert.ok(
			sends.every((c) => !c.input.data.includes('�')),
			'no partial character is sent alone'
		);
	});

	test('forwards the view size as a PTY resize', async () => {
		const terminal_id = create_uuid();
		const terminal = await create_running(terminal_id);
		const link = new TerminalViewLink(terminal);
		link.connect(create_view());
		link.resize({ cols: 100, rows: 30 });
		await flush();
		assert.deepEqual(
			calls_of(calls, 'terminal_resize').map((c) => c.input),
			[{ terminal_id, cols: 100, rows: 30 }]
		);
	});

	test('sends and resizes nothing once disconnected', async () => {
		const terminal = await create_running();
		const link = new TerminalViewLink(terminal);
		link.connect(create_view());
		link.disconnect();
		link.send(new TextEncoder().encode('x'));
		link.resize({ cols: 10, rows: 5 });
		await flush();
		assert.strictEqual(calls_of(calls, 'terminal_data_send').length, 0);
		assert.strictEqual(calls_of(calls, 'terminal_resize').length, 0);
	});
});
