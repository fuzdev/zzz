import { test, describe, assert } from 'vitest';

import {
	GHOSTTY_TERMINAL_EFFECTS,
	type GhosttyTerminalEffectName
} from '#lib/fuz_terminal/ghostty_effects.ts';
import {
	GhosttyDisposedError,
	GhosttyEffectError,
	GhosttyReentrancyError
} from '#lib/fuz_terminal/ghostty_errors.ts';
import { GhosttyTerminal } from '#lib/fuz_terminal/ghostty_terminal.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

import { load_test_ghostty_vt, load_wrapped_ghostty_vt } from './ghostty_vt_test_helpers.ts';
import { ESC, BEL, ST, CPR } from './vt_sequences.ts';

/** Primary device attributes. */
const DA1 = `${ESC}[c`;
/** DECRQM for wraparound (mode 7). */
const DECRQM_WRAP = `${ESC}[?7$p`;

const decoder = new TextDecoder();

/** A terminal whose `write_pty` replies collect as strings, and the replies. */
const create_replying_terminal = (
	vt: GhosttyVt,
	cols = 80,
	rows = 24
): { terminal: GhosttyTerminal; replies: Array<string> } => {
	const terminal = new GhosttyTerminal(vt, { cols, rows });
	const replies: Array<string> = [];
	terminal.set_effect('write_pty', (data) => replies.push(decoder.decode(data)));
	return { terminal, replies };
};

/** The error `fn` throws, failing when it throws nothing. */
const catch_error = (fn: () => unknown): unknown => {
	try {
		fn();
	} catch (error) {
		return error;
	}
	assert.fail('expected a throw');
};

/** The `GhosttyEffectError` `fn` throws, failing when it throws nothing or something else. */
const catch_effect_error = (fn: () => unknown): GhosttyEffectError => {
	const error = catch_error(fn);
	assert(error instanceof GhosttyEffectError, String(error));
	return error;
};

describe('write_pty', () => {
	test('answers real queries, in order, once registered', async () => {
		const { terminal, replies } = create_replying_terminal(await load_test_ghostty_vt());
		terminal.write(`hello${CPR}${DA1}${ESC}[>c${DECRQM_WRAP}`);
		assert.deepEqual(replies, [
			`${ESC}[1;6R`, // row 1, column 6: after `hello`
			`${ESC}[?62;22c`, // the library's default: a VT220 with ANSI color
			`${ESC}[>1;0;0c`,
			`${ESC}[?7;1$y` // wraparound is set
		]);
		// queries leave no text
		assert.strictEqual(terminal.format_text(), 'hello');
		terminal.dispose();
	});

	test('replay without replies: nothing until registered, nothing once cleared', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const replies: Array<string> = [];
		const on_write_pty = (data: Uint8Array): void => void replies.push(decoder.decode(data));
		// history, fed with no handler: its stale queries get no answer
		terminal.write(`old prompt$ ${CPR}${DA1}${DECRQM_WRAP}\r\n`);
		assert.deepEqual(replies, []);
		// live output answers
		terminal.set_effect('write_pty', on_write_pty);
		terminal.write(`${CPR}${DA1}${DECRQM_WRAP}`);
		assert.deepEqual(replies, [`${ESC}[2;1R`, `${ESC}[?62;22c`, `${ESC}[?7;1$y`]);
		// cleared, the library ignores queries again
		terminal.set_effect('write_pty', null);
		terminal.write(`${CPR}${DA1}${DECRQM_WRAP}`);
		assert.strictEqual(replies.length, 3);
		// clearing twice is harmless, and registering again answers again
		terminal.set_effect('write_pty', null);
		terminal.set_effect('write_pty', on_write_pty);
		terminal.write(CPR);
		assert.deepEqual(replies.slice(3), [`${ESC}[2;1R`]);
		assert.strictEqual(terminal.format_text(), 'old prompt$');
		terminal.dispose();
	});

	test('the reply is a copy, intact after the memory it came from is reused or grows', async () => {
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, {
			cols: 80,
			rows: 24,
			scrollback_max_bytes: Infinity
		});
		const replies: Array<Uint8Array> = [];
		terminal.set_effect('write_pty', (data) => void replies.push(data));
		terminal.write(CPR);
		const size = vt.memory.size;
		for (let i = 0; i < 50; i++) terminal.write(`${CPR}${DA1}`);
		terminal.write('line\r\n'.repeat(200_000));
		assert.isAbove(vt.memory.size, size, 'memory grew');
		assert.notStrictEqual(replies[0]!.buffer, vt.exports.memory.buffer);
		assert.strictEqual(decoder.decode(replies[0]), `${ESC}[1;1R`);
		assert.strictEqual(replies.length, 101);
		terminal.dispose();
	});

	test('state fed with no handler carries into the live stream that continues it', async () => {
		const vt = await load_test_ghostty_vt();
		// fed history turned on the in-band size report: the first resize
		// after registering reports
		const a = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
		a.write(`${ESC}[?2048h`);
		const a_replies: Array<string> = [];
		a.set_effect('write_pty', (data) => void a_replies.push(decoder.decode(data)));
		a.resize({ cols: 100, rows: 30 });
		assert.deepEqual(a_replies, [`${ESC}[48;30;100;0;0t`]);
		// fed history ended mid-query: the output that completes it is answered
		const b = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
		b.write(`${ESC}[6`);
		const b_replies: Array<string> = [];
		b.set_effect('write_pty', (data) => void b_replies.push(decoder.decode(data)));
		b.write('n');
		assert.deepEqual(b_replies, [`${ESC}[1;1R`]);
		a.dispose();
		b.dispose();
	});

	test('replacing the handler routes to the new one only', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const seen: Array<string> = [];
		terminal.set_effect('write_pty', () => void seen.push('first'));
		terminal.write(CPR);
		terminal.set_effect('write_pty', () => void seen.push('second'));
		terminal.write(CPR);
		assert.deepEqual(seen, ['first', 'second']);
		terminal.dispose();
	});

	test('a resize sends its in-band size report through write_pty', async () => {
		const { terminal, replies } = create_replying_terminal(await load_test_ghostty_vt());
		terminal.write(`${ESC}[?2048h`);
		assert.deepEqual(replies, []);
		terminal.resize({ cols: 100, rows: 30, cell_width_px: 9, cell_height_px: 18 });
		assert.deepEqual(replies, [`${ESC}[48;30;100;540;900t`]);
		terminal.dispose();
	});
});

describe('bell, title, and pwd', () => {
	test('the bell rings once per BEL, and not once cleared', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		let bells = 0;
		terminal.write(BEL);
		terminal.set_effect('bell', () => bells++);
		terminal.write(`a${BEL}b${BEL}${BEL}`);
		assert.strictEqual(bells, 3);
		terminal.set_effect('bell', null);
		terminal.write(BEL);
		assert.strictEqual(bells, 3);
		assert.strictEqual(terminal.format_text(), 'ab');
		terminal.dispose();
	});

	test('the title handler gets the new title, decoded', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const titles: Array<string> = [];
		terminal.set_effect('title_changed', (title) => void titles.push(title));
		terminal.write(`${ESC}]2;hello${ST}${ESC}]0;你好 😀${BEL}${ESC}]2;${ST}`);
		assert.deepEqual(titles, ['hello', '你好 😀', '']);
		// an OSC carries no text to the screen, and a title change rings no bell
		assert.strictEqual(terminal.format_text(), '');
		terminal.dispose();
	});

	test('the pwd handler gets what the program sent, undecoded, and a clear', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const pwds: Array<string> = [];
		terminal.set_effect('pwd_changed', (pwd) => void pwds.push(pwd));
		terminal.write(`${ESC}]7;file://host/tmp/a%20b${ST}${ESC}]7;${ST}`);
		assert.deepEqual(pwds, ['file://host/tmp/a%20b', '']);
		terminal.dispose();
	});

	test('the render hold handler gets each begin and end, in pairs', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const holds: Array<boolean> = [];
		terminal.write(`${ESC}[?2026h`);
		terminal.set_effect('render_hold', (held) => void holds.push(held));
		// a hold begun before registering ends once registered
		terminal.write(`${ESC}[?2026l${ESC}[?2026h${ESC}[?2026h${ESC}[?2026l${ESC}[?2026l`);
		assert.deepEqual(holds, [false, true, false]);
		// from the handler, the terminal can't be written
		terminal.set_effect('render_hold', () => terminal.write('x'));
		const error = catch_effect_error(() => terminal.write(`${ESC}[?2026h`));
		assert.strictEqual(error.effect, 'render_hold');
		assert(error.cause instanceof GhosttyReentrancyError, String(error.cause));
		terminal.dispose();
	});

	test('every effect at once, from one write, in output order', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const events: Array<string> = [];
		terminal.set_effect('write_pty', (data) => void events.push(`pty ${decoder.decode(data)}`));
		terminal.set_effect('bell', () => void events.push('bell'));
		terminal.set_effect('title_changed', (title) => void events.push(`title ${title}`));
		terminal.set_effect('pwd_changed', (pwd) => void events.push(`pwd ${pwd}`));
		terminal.write(`${ESC}]2;t${ST}x${BEL}${ESC}]7;/p${ST}${CPR}`);
		assert.deepEqual(events, ['title t', 'bell', 'pwd /p', `pty ${ESC}[1;2R`]);
		terminal.dispose();
	});

	test('a handler that’s not a function is refused', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		for (const handler of [undefined, 'bell', {}]) {
			assert.throws(() => terminal.set_effect('bell', handler as any), TypeError);
		}
		terminal.dispose();
	});
});

describe('a handler that throws', () => {
	test('the write finishes, then throws the first exception', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const first = new Error('first');
		let bells = 0;
		terminal.set_effect('bell', () => {
			bells++;
			throw bells === 1 ? first : new Error('later');
		});
		const error = catch_effect_error(() => terminal.write(`a${BEL}b${BEL}c${BEL}d`));
		assert.strictEqual(error.effect, 'bell');
		assert.strictEqual(error.cause, first);
		assert.strictEqual(error.thrown_count, 3);
		assert.include(
			error.message,
			'the bell effect handler threw (and 2 more handler calls threw): first'
		);
		// every call was made, and everything after each throwing sequence written
		assert.strictEqual(bells, 3);
		assert.strictEqual(terminal.format_text(), 'abcd');
		// the terminal still works, and the failure doesn't carry into the next call
		terminal.set_effect('bell', null);
		terminal.write(`${BEL}e`);
		assert.strictEqual(terminal.format_text(), 'abcde');
		terminal.dispose();
	});

	test('a thrown value with no usable message is still the cause', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		const no_message = Object.create(null);
		for (const thrown of [no_message, proxy]) {
			terminal.set_effect('bell', () => {
				throw thrown;
			});
			const error = catch_effect_error(() => terminal.write(`${BEL}x`));
			assert.strictEqual(error.cause, thrown);
			assert.include(error.message, 'a value that has no message');
		}
		assert.strictEqual(terminal.format_text(), 'xx');
		assert.isNull(terminal.vt.poisoned, 'a handler exception never poisons');
		terminal.dispose();
	});

	test('a throw mid-query leaves the parser sound for the rest of a long write', async () => {
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, {
			cols: 80,
			rows: 24,
			scrollback_max_bytes: Infinity
		});
		const replies: Array<string> = [];
		terminal.set_effect('write_pty', (data) => {
			replies.push(decoder.decode(data));
			// a thrown non-Error is kept as the cause too
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			if (replies.length === 1) throw 'not an Error';
		});
		// several write chunks, a query at the very start and another at the end
		const lines = Array.from({ length: 10_000 }, (_, i) => `line ${i}`);
		const error = catch_effect_error(() =>
			terminal.write(`${CPR}${lines.join('\r\n')}\r\n${ESC}[1;31mred${ESC}[0m${CPR}`)
		);
		assert.strictEqual(error.effect, 'write_pty');
		assert.strictEqual(error.cause, 'not an Error');
		assert.strictEqual(error.thrown_count, 1);
		assert.strictEqual(replies.length, 2);
		assert.strictEqual(replies[1], `${ESC}[24;4R`);
		const text = terminal.format_text().split('\n');
		assert.deepEqual(text, [...lines, 'red']);
		terminal.dispose();
	});

	test('a resize finishes, then throws', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 10, rows: 4 });
		terminal.write(`abcdefghijklmno${ESC}[?2048h`);
		terminal.set_effect('write_pty', () => {
			throw new Error('no pty');
		});
		const error = catch_effect_error(() => terminal.resize({ cols: 20, rows: 4 }));
		assert.strictEqual(error.effect, 'write_pty');
		// resized: the line reflowed onto one row
		assert.strictEqual(terminal.format_text({ unwrap: false }), 'abcdefghijklmno');
		terminal.dispose();
	});
});

describe('reentrancy', () => {
	test('write, resize, dispose, and set_effect from a handler are refused', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const attempts: Array<[string, () => unknown]> = [
			['write', () => terminal.write('x')],
			['write', () => terminal.write(new Uint8Array([0x78]))],
			['resize', () => terminal.resize({ cols: 40, rows: 10 })],
			['dispose', () => terminal.dispose()],
			['set_effect', () => terminal.set_effect('bell', null)],
			['set_effect', () => terminal.set_effect('write_pty', () => {})]
		];
		const refused: Array<unknown> = [];
		terminal.set_effect('bell', () => {
			for (const [, attempt] of attempts) refused.push(catch_error(attempt));
		});
		terminal.write(`a${BEL}b`);
		assert.strictEqual(refused.length, attempts.length);
		for (const [i, error] of refused.entries()) {
			const method = attempts[i]![0];
			assert(error instanceof GhosttyReentrancyError, String(error));
			assert.include(error.message, `GhosttyTerminal.${method} called from an effect handler`);
		}
		// nothing the handler tried happened
		assert.isFalse(terminal.disposed);
		assert.strictEqual(terminal.format_text(), 'ab');
		terminal.write(CPR); // `write_pty` wasn't registered: no handler to throw from
		terminal.write(BEL); // the bell handler is still registered
		assert.strictEqual(refused.length, attempts.length * 2);
		terminal.resize({ cols: 40, rows: 10 });
		terminal.dispose();
		assert.isTrue(terminal.disposed);
	});

	test('an uncaught refusal surfaces from the write as its cause', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		terminal.set_effect('write_pty', () => terminal.dispose());
		const error = catch_effect_error(() => terminal.write(`${CPR}after`));
		assert(error.cause instanceof GhosttyReentrancyError, String(error.cause));
		assert.isFalse(terminal.disposed, 'not freed under the running write');
		assert.strictEqual(terminal.format_text(), 'after');
		terminal.set_effect('write_pty', null);
		terminal.dispose();
	});

	test('a handler may read the terminal', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		const read: Array<string> = [];
		terminal.set_effect('bell', () => {
			assert.isFalse(terminal.disposed);
			read.push(terminal.format_text());
		});
		terminal.write(`one${BEL}two${BEL}`);
		assert.deepEqual(read, ['one', 'onetwo']);
		terminal.dispose();
	});

	test('a handler may write another terminal, whose own effects fire, while memory grows', async () => {
		const vt = await load_test_ghostty_vt();
		const options = { cols: 80, rows: 24, scrollback_max_bytes: Infinity };
		const a = new GhosttyTerminal(vt, options);
		const b = new GhosttyTerminal(vt, options);
		const b_titles: Array<string> = [];
		b.set_effect('title_changed', (title) => void b_titles.push(title));
		// a's bell writes enough to b to grow linear memory, in the middle of
		// a's write: a's later chunks must still be read from live memory
		const size = vt.memory.size;
		a.set_effect('bell', () => b.write(`${ESC}]2;from a${ST}${'line\r\n'.repeat(200_000)}`));
		const tail = 'x'.repeat(100_000);
		a.write(`${BEL}${tail}`);
		assert.isAbove(vt.memory.size, size, 'memory grew inside the callback');
		assert.deepEqual(b_titles, ['from a']);
		assert.strictEqual(a.format_text(), tail);
		// and a's bytes path, too
		a.write(new TextEncoder().encode(`\r\n${BEL}${tail}`));
		assert.strictEqual(a.format_text(), `${tail}\n${tail}`);
		a.dispose();
		b.dispose();
	});
});

describe('lifetime and the function table', () => {
	const EFFECT_NAMES = Object.keys(GHOSTTY_TERMINAL_EFFECTS) as Array<GhosttyTerminalEffectName>;

	/** Register every effect, with handlers that count their calls into `counts`. */
	const register_all = (terminal: GhosttyTerminal, counts: Map<string, number>): void => {
		const count = (name: string) => (): void => void counts.set(name, (counts.get(name) ?? 0) + 1);
		terminal.set_effect('write_pty', count('write_pty'));
		terminal.set_effect('bell', count('bell'));
		terminal.set_effect('title_changed', count('title_changed'));
		terminal.set_effect('pwd_changed', count('pwd_changed'));
		terminal.set_effect('render_hold', count('render_hold'));
	};

	/** Fires every effect once — the render hold twice, a begin and an end. */
	const FIRE_ALL = `${CPR}${BEL}${ESC}]2;t${ST}${ESC}]7;/p${ST}${ESC}[?2026h${ESC}[?2026l`;

	test('the table grows by one slot per effect, however many terminals come and go', async () => {
		const vt = await load_test_ghostty_vt();
		const table = vt.exports.__indirect_function_table;
		const initial = table.length;
		const counts = new Map<string, number>();
		for (let i = 0; i < 300; i++) {
			const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
			register_all(terminal, counts);
			// registering again, and clearing, adds no slot either
			terminal.set_effect('bell', null);
			terminal.set_effect('bell', () => void counts.set('bell', (counts.get('bell') ?? 0) + 1));
			terminal.write(FIRE_ALL);
			terminal.dispose();
		}
		assert.strictEqual(table.length, initial + EFFECT_NAMES.length);
		assert.strictEqual(vt.callbacks.length, table.length);
		for (const name of EFFECT_NAMES) {
			assert.strictEqual(counts.get(name), name === 'render_hold' ? 600 : 300, name);
		}
		assert.strictEqual(vt.effect_router.attached_count, 0);
	});

	test('create, register, fire, dispose cycles allocate and free in balance', async () => {
		let allocs = 0;
		let frees = 0;
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_wasm_alloc: (len: number): number => {
				allocs++;
				return exports.ghostty_wasm_alloc(len);
			},
			ghostty_wasm_free: (ptr: number, len: number): void => {
				frees++;
				exports.ghostty_wasm_free(ptr, len);
			}
		}));
		const counts = new Map<string, number>();
		const cycle = (): void => {
			const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
			register_all(terminal, counts);
			terminal.write(FIRE_ALL);
			terminal.dispose();
		};
		// the first cycle resolves constants and adds the trampolines
		cycle();
		const table_length = vt.exports.__indirect_function_table.length;
		allocs = 0;
		frees = 0;
		for (let i = 0; i < 2000; i++) cycle();
		const size = vt.memory.size;
		for (let i = 0; i < 2000; i++) cycle();
		// the write buffer, plus the title's and the pwd's scratch, each cycle
		assert.strictEqual(allocs, 4000 * 3);
		assert.strictEqual(frees, allocs);
		assert.strictEqual(vt.memory.size, size);
		assert.strictEqual(vt.exports.__indirect_function_table.length, table_length);
		assert.strictEqual(counts.get('title_changed'), 4001);
	});

	test('a terminal is detached from dispatch before its handle is freed', async () => {
		let attached_at_free: Array<number> = [];
		const loaded: { vt?: GhosttyVt } = {};
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_terminal_free: (terminal: number): void => {
				attached_at_free.push(loaded.vt!.effect_router.attached_count);
				exports.ghostty_terminal_free(terminal);
			}
		}));
		loaded.vt = vt;
		const a = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		const b = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		a.set_effect('bell', () => {});
		assert.strictEqual(vt.effect_router.attached_count, 2);
		a.dispose();
		b.dispose();
		assert.deepEqual(attached_at_free, [1, 0]);
		attached_at_free = [];
		a.dispose();
		assert.deepEqual(attached_at_free, [], 'idempotent');
	});

	test('a new terminal at a freed handle gets none of the old one’s effects', async () => {
		// capture each terminal's handle as the constructor takes it from its slot
		const handles: Array<number> = [];
		let creating = false;
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_terminal_new: (...args: Array<number>): number => {
				creating = true;
				return exports.ghostty_terminal_new(...args);
			},
			ghostty_wasm_take_opaque: (slot: number): number => {
				const handle = exports.ghostty_wasm_take_opaque(slot);
				if (creating) handles.push(handle >>> 0);
				creating = false;
				return handle;
			}
		}));
		let old_calls = 0;
		const old = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		old.set_effect('bell', () => old_calls++);
		old.set_effect('write_pty', () => old_calls++);
		old.dispose();
		const next = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		assert.strictEqual(handles.length, 2);
		assert.strictEqual(handles[1], handles[0], 'the allocator reused the handle');
		next.write(`${BEL}${CPR}`);
		let next_bells = 0;
		next.set_effect('bell', () => next_bells++);
		next.write(BEL);
		assert.strictEqual(next_bells, 1);
		assert.strictEqual(old_calls, 0);
		next.dispose();
	});

	test('set_effect after dispose throws', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 20, rows: 4 });
		terminal.set_effect('bell', () => {});
		terminal.dispose();
		assert.throws(
			() => terminal.set_effect('bell', null),
			GhosttyDisposedError,
			'GhosttyTerminal.set_effect'
		);
	});
});
