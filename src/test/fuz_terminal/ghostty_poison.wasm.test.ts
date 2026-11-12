import { readFile } from 'node:fs/promises';
import { test, describe, assert } from 'vitest';

import { GhosttyEffectError, GhosttyPoisonedError } from '#lib/fuz_terminal/ghostty_errors.ts';
import { GhosttyTerminal } from '#lib/fuz_terminal/ghostty_terminal.ts';
import { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

import {
	GHOSTTY_VT_MODULE_URL,
	load_test_ghostty_vt,
	load_wrapped_ghostty_vt
} from './ghostty_vt_test_helpers.ts';
import { ESC, BEL, ST } from './vt_sequences.ts';

/** The error `fn` throws, failing when it throws nothing. */
const catch_error = (fn: () => unknown): unknown => {
	try {
		fn();
	} catch (error) {
		return error;
	}
	assert.fail('expected a throw');
};

/** Assert every method of `terminal` that calls in refuses with the poison, naming `escaped_call`. */
const assert_refuses = (terminal: GhosttyTerminal, escaped_call: string, cause: unknown): void => {
	const attempts: Array<[string, () => unknown]> = [
		['write', () => terminal.write('x')],
		['resize', () => terminal.resize({ cols: 30, rows: 5 })],
		['format_text', () => terminal.format_text()],
		['set_effect', () => terminal.set_effect('bell', () => {})],
		['set_effect', () => terminal.set_effect('bell', null)]
	];
	for (const [method, attempt] of attempts) {
		const error = catch_error(attempt);
		assert(error instanceof GhosttyPoisonedError, String(error));
		assert.strictEqual(error.call, `GhosttyTerminal.${method}`);
		assert.strictEqual(error.escaped_call, escaped_call);
		assert.strictEqual(error.cause, cause);
	}
};

/**
 * An instance whose exports count their calls (by name, and in all), and
 * whose export `fail.call` throws `fail.error` while that's set — the
 * deterministic stand-in for an exception escaping the module.
 */
const load_failable_vt = async (): Promise<{
	vt: GhosttyVt;
	calls: { count: number; by_name: Map<string, number> };
	fail: { error: unknown; call: string };
}> => {
	const calls = { count: 0, by_name: new Map<string, number>() };
	const fail: { error: unknown; call: string } = { error: null, call: 'ghostty_terminal_vt_write' };
	const vt = await load_wrapped_ghostty_vt((exports) => {
		const counted: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(exports)) {
			if (typeof value !== 'function') continue;
			counted[name] = (...args: Array<unknown>): unknown => {
				calls.count++;
				calls.by_name.set(name, (calls.by_name.get(name) ?? 0) + 1);
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				if (name === fail.call && fail.error) throw fail.error;
				return value(...args);
			};
		}
		return counted;
	});
	return { vt, calls, fail };
};

describe('an exception escaping the module poisons the instance', () => {
	test('the first call throws the original; every later one refuses before calling in', async () => {
		const { vt, calls, fail } = await load_failable_vt();
		const a = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		const b = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		b.set_effect('bell', () => {});
		a.write('a');
		b.write('b');
		assert.isNull(vt.poisoned);

		const boom = new Error('boom');
		fail.error = boom;
		assert.strictEqual(
			catch_error(() => a.write('x')),
			boom,
			'the original propagates'
		);
		assert.deepEqual(vt.poisoned, { call: 'ghostty_terminal_vt_write', cause: boom });

		fail.error = null;
		const before = calls.count;
		assert_refuses(a, 'ghostty_terminal_vt_write', boom);
		assert_refuses(b, 'ghostty_terminal_vt_write', boom);
		// the raw exports refuse too, for code that calls them directly
		const error = catch_error(() => vt.exports.ghostty_version());
		assert(error instanceof GhosttyPoisonedError, String(error));
		assert.strictEqual(error.call, 'ghostty_version');
		assert.strictEqual(calls.count, before, 'nothing reached the module');

		// dispose drops the handles without freeing: quiet, idempotent, no call
		a.dispose();
		b.dispose();
		b.dispose();
		assert.isTrue(a.disposed);
		assert.isTrue(b.disposed);
		assert.strictEqual(calls.count, before);
		assert.strictEqual(vt.effect_router.attached_count, 0);
	});

	test('a real trap poisons, and a fresh instance of the module works', async () => {
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		terminal.write('before');
		// a read past the end of linear memory traps inside the parser
		const trap = catch_error(() =>
			vt.exports.ghostty_terminal_vt_write(0x7fff_fff0, vt.memory.size - 4, 64)
		);
		assert(trap instanceof WebAssembly.RuntimeError, String(trap));
		assert.strictEqual(vt.poisoned?.cause, trap);
		assert_refuses(terminal, 'ghostty_terminal_vt_write', trap);
		terminal.dispose();
		assert.isTrue(terminal.disposed);

		const fresh = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 20, rows: 4 });
		fresh.write('fresh');
		assert.strictEqual(fresh.format_text(), 'fresh');
		fresh.dispose();
	});

	test('the JS stack running out inside the module poisons', async () => {
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		let bells = 0;
		terminal.set_effect('bell', () => bells++);
		terminal.write('warm'); // the write buffer exists, so the overflow arises in vt_write
		// recurse until the stack is exhausted, then write at each depth on the
		// way back up: some write's call into the module overflows — at its
		// entry, in its frames, or at the callback boundary; the guard can't
		// tell these apart, so any of them poisons
		const errors: Array<unknown> = [];
		const recurse = (): void => {
			try {
				recurse();
			} catch {
				// the overflow, or a deeper write's error
			}
			if (vt.poisoned) return;
			try {
				terminal.write(`a${BEL}`);
			} catch (error) {
				errors.push(error);
			}
		};
		recurse();
		assert.isNotNull(vt.poisoned, 'an overflow escaped the module');
		assert(vt.poisoned.cause instanceof RangeError, String(vt.poisoned.cause));
		assert.strictEqual(vt.poisoned.call, 'ghostty_terminal_vt_write');
		// the escape itself propagated to its write, before any refusal
		assert.include(errors, vt.poisoned.cause);
		assert_refuses(terminal, vt.poisoned.call, vt.poisoned.cause);
		terminal.dispose();
	});

	test('a handler exception is caught inside the callback and never poisons', async () => {
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		terminal.set_effect('bell', () => {
			throw new Error('handler');
		});
		for (let i = 0; i < 1000; i++) {
			assert(catch_error(() => terminal.write(BEL)) instanceof GhosttyEffectError);
		}
		assert.isNull(vt.poisoned);
		terminal.set_effect('bell', null);
		terminal.write('still fine');
		assert.strictEqual(terminal.format_text(), 'still fine');
		terminal.dispose();
	});

	test('an escape inside a handler’s own call wins, and no handler runs after it', async () => {
		const { vt, fail } = await load_failable_vt();
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		let bells = 0;
		terminal.set_effect('title_changed', () => {});
		terminal.set_effect('bell', () => bells++);
		const trap = new Error('trap in the title read');
		fail.call = 'ghostty_terminal_get';
		fail.error = trap;
		const error = catch_error(() => terminal.write(`${ESC}]2;t${ST}${BEL}x`));
		assert(error instanceof GhosttyPoisonedError, String(error));
		assert.strictEqual(error.call, 'GhosttyTerminal.write');
		assert.strictEqual(error.escaped_call, 'ghostty_terminal_get');
		assert.strictEqual(error.cause, trap);
		assert.strictEqual(bells, 0, 'the bell later in the same write never ran');
		terminal.dispose();
	});

	test('a poisoning in the first chunk of a longer write abandons the rest', async () => {
		// longer than one chunk, as a string and as bytes
		const text = `${ESC}]2;t${ST}${'x'.repeat(200_000)}`;
		for (const data of [text, new TextEncoder().encode(text)]) {
			const { vt, calls, fail } = await load_failable_vt();
			const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
			terminal.set_effect('title_changed', () => {});
			const trap = new Error('trap in the title read');
			fail.call = 'ghostty_terminal_get';
			fail.error = trap;
			const writes = calls.by_name.get('ghostty_terminal_vt_write') ?? 0;
			const error = catch_error(() => terminal.write(data));
			assert(error instanceof GhosttyPoisonedError, String(error));
			assert.strictEqual(error.call, 'GhosttyTerminal.write');
			assert.strictEqual(error.cause, trap);
			assert.strictEqual(
				(calls.by_name.get('ghostty_terminal_vt_write') ?? 0) - writes,
				1,
				'no chunk after the first was written'
			);
			terminal.dispose();
		}
	});

	test('an escape from another terminal’s write inside a handler poisons the outer write', async () => {
		const { vt, fail } = await load_failable_vt();
		const a = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		const b = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		let a_bells = 0;
		const trap = new Error('trap in b');
		a.set_effect('bell', () => {
			a_bells++;
			fail.error = trap;
			b.write('b');
		});
		const error = catch_error(() => a.write(`${BEL}${BEL}`));
		assert(error instanceof GhosttyPoisonedError, String(error));
		assert.strictEqual(error.call, 'GhosttyTerminal.write');
		assert.strictEqual(error.cause, trap);
		assert.strictEqual(a_bells, 1, 'the second bell never ran its handler');
		a.dispose();
		b.dispose();
	});

	test('cleanup skips its frees, so the original exception reaches the caller', async () => {
		const FREES = [
			'ghostty_wasm_free',
			'ghostty_wasm_free_opaque',
			'ghostty_free',
			'ghostty_formatter_free',
			'ghostty_terminal_free'
		];
		const count_frees = (by_name: Map<string, number>): number =>
			FREES.map((name) => by_name.get(name) ?? 0).reduce((a, b) => a + b);

		const { vt, calls, fail } = await load_failable_vt();
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		terminal.write('x');
		// the formatter and its options are set up (with their own scratch) first
		assert.strictEqual(terminal.format_text(), 'x');
		const trap = new Error('trap in format');
		fail.call = 'ghostty_formatter_format_alloc';
		fail.error = trap;
		const before = count_frees(calls.by_name);
		assert.strictEqual(
			catch_error(() => terminal.format_text()),
			trap
		);
		assert.strictEqual(vt.poisoned?.call, 'ghostty_formatter_format_alloc');
		assert.strictEqual(count_frees(calls.by_name), before, 'no free was attempted');
		terminal.dispose();
		assert.strictEqual(count_frees(calls.by_name), before);

		// and a constructor whose create traps
		const second = await load_failable_vt();
		const create_trap = new Error('trap in create');
		second.fail.call = 'ghostty_terminal_new';
		second.fail.error = create_trap;
		const second_before = count_frees(second.calls.by_name);
		assert.strictEqual(
			catch_error(() => new GhosttyTerminal(second.vt, { cols: 20, rows: 4 })),
			create_trap
		);
		assert.strictEqual(second.vt.poisoned?.call, 'ghostty_terminal_new');
		assert.strictEqual(count_frees(second.calls.by_name), second_before, 'no free was attempted');
		// constructing on a poisoned instance names the operation
		const refused = catch_error(() => new GhosttyTerminal(second.vt, { cols: 20, rows: 4 }));
		assert(refused instanceof GhosttyPoisonedError, String(refused));
		assert.strictEqual(refused.call, 'new GhosttyTerminal');
		assert.strictEqual(refused.cause, create_trap);
	});

	test('poison belongs to the instance: every wrapper of it sees it', async () => {
		const bytes = await readFile(GHOSTTY_VT_MODULE_URL);
		const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {});
		const one = new GhosttyVt(instance);
		const two = new GhosttyVt(instance);
		const terminal = new GhosttyTerminal(two, { cols: 20, rows: 4 });
		const trap = catch_error(() =>
			one.exports.ghostty_terminal_vt_write(0x7fff_fff0, one.memory.size - 4, 64)
		);
		assert(trap instanceof WebAssembly.RuntimeError, String(trap));
		assert.strictEqual(two.poisoned?.cause, trap);
		assert_refuses(terminal, 'ghostty_terminal_vt_write', trap);
		terminal.dispose();
		// another instance is untouched
		assert.isNull((await load_test_ghostty_vt()).poisoned);
	});
});
