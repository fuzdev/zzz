import { test, describe, assert } from 'vitest';

import {
	GhosttyDisposedError,
	GhosttyManifestError,
	GhosttyResultError
} from '#lib/fuz_terminal/ghostty_errors.ts';
import {
	GHOSTTY_MODE_GRAPHEME_CLUSTER,
	GHOSTTY_TERMINAL_MAX_SIZE,
	GhosttyTerminal,
	type GhosttyTerminalMode
} from '#lib/fuz_terminal/ghostty_terminal.ts';

import {
	load_doctored_ghostty_vt,
	load_test_ghostty_vt,
	load_wrapped_ghostty_vt
} from './ghostty_vt_test_helpers.ts';
import { ESC } from './vt_sequences.ts';

/** The `GhosttyResultError` `fn` throws, failing when it throws nothing or something else. */
const catch_result_error = (fn: () => unknown): GhosttyResultError => {
	try {
		fn();
	} catch (error) {
		assert(error instanceof GhosttyResultError, String(error));
		return error;
	}
	assert.fail('expected a GhosttyResultError');
};

describe('writing and reading text', () => {
	test('a new terminal is empty', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		assert.strictEqual(terminal.format_text(), '');
		terminal.dispose();
	});

	test('escape sequences style and move, and never show as text', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		terminal.write(`hello\r\n${ESC}[1;32mgreen${ESC}[0m world   \r\n`);
		assert.strictEqual(terminal.format_text(), 'hello\ngreen world');
		// clear, home, then a cursor move to row 3 column 5
		terminal.write(`${ESC}[2J${ESC}[H${ESC}[3;5Hx${ESC}[1;1Htop`);
		assert.strictEqual(terminal.format_text(), 'top\n\n    x');
		// a query gets no reply and leaves no text
		terminal.write(`${ESC}[6n${ESC}[c`);
		assert.strictEqual(terminal.format_text(), 'top\n\n    x');
		terminal.dispose();
	});

	test('trailing spaces are kept on request', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 20, rows: 4 });
		terminal.write('a  \r\nb');
		assert.strictEqual(terminal.format_text(), 'a\nb');
		assert.strictEqual(terminal.format_text({ trim: false }), 'a  \nb');
		assert.strictEqual(terminal.format_text(), 'a\nb');
		terminal.dispose();
	});

	test('bytes split mid-character and mid-sequence are carried across writes', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 20, rows: 4 });
		const bytes = new TextEncoder().encode(`a${ESC}[31m你b`);
		for (const byte of bytes) terminal.write(new Uint8Array([byte]));
		assert.strictEqual(terminal.format_text(), 'a你b');
		terminal.dispose();
	});

	test('wide characters and a combining grapheme', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 5, rows: 4 });
		terminal.write('a你好b');
		// `你` and `好` take two cells each, so `b` wraps
		assert.strictEqual(terminal.format_text({ unwrap: false }), 'a你好\nb');
		assert.strictEqual(terminal.format_text(), 'a你好b');
		// e + COMBINING ACUTE ACCENT is one cell, its codepoints kept as written
		terminal.write('\r\néx');
		assert.strictEqual(terminal.format_text(), 'a你好b\néx');
		terminal.dispose();
	});
});

describe('modes', () => {
	/** The DECRPM state of DEC private mode `mode`: 1 set, 2 reset, 0 unrecognized. */
	const query_mode = (terminal: GhosttyTerminal, mode: number): number => {
		const replies: Array<string> = [];
		const decoder = new TextDecoder();
		terminal.set_effect('write_pty', (data) => void replies.push(decoder.decode(data)));
		terminal.write(`${ESC}[?${mode}$p`);
		terminal.set_effect('write_pty', null);
		const match = new RegExp(`^${ESC}\\[\\?${mode};(\\d)\\$y$`).exec(replies.join(''));
		assert.ok(match, JSON.stringify(replies));
		return Number(match[1]);
	};

	const create = async (modes?: ReadonlyArray<GhosttyTerminalMode>): Promise<GhosttyTerminal> =>
		new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 20, rows: 4, modes });

	test('grapheme clustering is off by default, and a full reset keeps it off', async () => {
		const terminal = await create();
		assert.strictEqual(query_mode(terminal, GHOSTTY_MODE_GRAPHEME_CLUSTER), 2);
		terminal.write(`${ESC}[?2027h`);
		assert.strictEqual(query_mode(terminal, GHOSTTY_MODE_GRAPHEME_CLUSTER), 1);
		terminal.write(`${ESC}c`);
		assert.strictEqual(query_mode(terminal, GHOSTTY_MODE_GRAPHEME_CLUSTER), 2);
		terminal.dispose();
	});

	test('a mode it starts with is its reset default too', async () => {
		const terminal = await create([{ mode: GHOSTTY_MODE_GRAPHEME_CLUSTER, value: true }]);
		assert.strictEqual(query_mode(terminal, GHOSTTY_MODE_GRAPHEME_CLUSTER), 1);
		// a program can still turn it off, and a full reset turns it back on
		terminal.write(`${ESC}[?2027l`);
		assert.strictEqual(query_mode(terminal, GHOSTTY_MODE_GRAPHEME_CLUSTER), 2);
		terminal.write(`${ESC}c`);
		assert.strictEqual(query_mode(terminal, GHOSTTY_MODE_GRAPHEME_CLUSTER), 1);
		terminal.dispose();
	});

	test('a mode can start off, and an ANSI mode is told apart from a DEC one', async () => {
		// DEC private mode 7 (autowrap) is on by default; ANSI mode 4 (insert) is off
		const terminal = await create([
			{ mode: 7, value: false },
			{ mode: 4, ansi: true, value: true }
		]);
		assert.strictEqual(query_mode(terminal, 7), 2);
		// insert mode on: text written before the cursor's cell pushes it right
		terminal.write(`ab${ESC}[1GX`);
		assert.strictEqual(terminal.format_text(), 'Xab');
		terminal.dispose();
	});

	test('a mode number out of range is refused', async () => {
		const vt = await load_test_ghostty_vt();
		assert.throws(
			() => new GhosttyTerminal(vt, { cols: 20, rows: 4, modes: [{ mode: 0x8000, value: true }] }),
			RangeError
		);
	});

	test('a reshaped mode struct fails creation only when modes are given', async () => {
		const vt = await load_doctored_ghostty_vt((manifest) => {
			manifest.types.GhosttyTerminalModeConfig.fields.value.type = 'u32';
		});
		new GhosttyTerminal(vt, { cols: 20, rows: 4 }).dispose();
		assert.throws(
			() => new GhosttyTerminal(vt, { cols: 20, rows: 4, modes: [{ mode: 2027, value: true }] }),
			GhosttyManifestError,
			/GhosttyTerminalModeConfig\.value/
		);
	});

	test('a mode the library refuses as a reset default fails creation, naming the option', async () => {
		const vt = await load_test_ghostty_vt();
		// 1049 (alternate screen with cursor save) is a transition, not a configurable default
		const error = catch_result_error(
			() => new GhosttyTerminal(vt, { cols: 20, rows: 4, modes: [{ mode: 1049, value: true }] })
		);
		assert.include(error.message, 'MODE_DEFAULT');
	});
});

describe('wrapping and resize', () => {
	test('a soft-wrapped line unwraps, and reflows on resize', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 10, rows: 5 });
		terminal.write('abcdefghijklmno\r\nnext');
		assert.strictEqual(terminal.format_text({ unwrap: false }), 'abcdefghij\nklmno\nnext');
		assert.strictEqual(terminal.format_text(), 'abcdefghijklmno\nnext');

		terminal.resize({ cols: 20, rows: 5 });
		assert.strictEqual(terminal.format_text({ unwrap: false }), 'abcdefghijklmno\nnext');

		terminal.resize({ cols: 5, rows: 5, cell_width_px: 9, cell_height_px: 18 });
		assert.strictEqual(terminal.format_text({ unwrap: false }), 'abcde\nfghij\nklmno\nnext');
		assert.strictEqual(terminal.format_text(), 'abcdefghijklmno\nnext');
		terminal.dispose();
	});

	test('a hard line break never unwraps', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 10, rows: 5 });
		terminal.write('abcdefghij\r\nklm');
		assert.strictEqual(terminal.format_text(), 'abcdefghij\nklm');
		terminal.dispose();
	});

	test('sizes the C ABI can’t hold are refused before any call', async () => {
		const vt = await load_test_ghostty_vt();
		for (const cols of [65536, -1, 1.5, NaN]) {
			assert.throws(() => new GhosttyTerminal(vt, { cols, rows: 24 }), RangeError, 'cols');
		}
		const terminal = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
		assert.throws(() => terminal.resize({ cols: 80, rows: 65536 }), RangeError, 'rows');
		assert.throws(
			() => terminal.resize({ cols: 80, rows: 24, cell_width_px: 2 ** 32 }),
			RangeError,
			'cell_width_px'
		);
		// the largest pixel sizes are accepted (an i32 parameter above 2^31 included)
		terminal.resize({ cols: 80, rows: 24, cell_width_px: 2 ** 32 - 1, cell_height_px: 2 ** 31 });
		terminal.dispose();
	});

	test('sizes are capped, on create and resize, before any call', async () => {
		const max = GHOSTTY_TERMINAL_MAX_SIZE;
		assert.strictEqual(max, 2048);
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
		const size_before = vt.memory.size;
		for (const options of [
			{ cols: max + 1, rows: 24 },
			{ cols: 80, rows: max + 1 },
			{ cols: 65535, rows: 65535 }
		]) {
			assert.throws(
				() => new GhosttyTerminal(vt, options),
				RangeError,
				`must be an integer from 0 to ${max}`
			);
		}
		for (const options of [
			{ cols: max + 1, rows: 24 },
			{ cols: 80, rows: max + 1 },
			{ cols: 30000, rows: 30000 }
		]) {
			assert.throws(() => terminal.resize(options), RangeError, `from 0 to ${max}`);
		}
		// refused before reaching the library: nothing grew
		assert.strictEqual(vt.memory.size, size_before);
		terminal.write('fits');
		terminal.resize({ cols: max, rows: max });
		assert.strictEqual(terminal.format_text(), 'fits');
		terminal.dispose();
		const largest = new GhosttyTerminal(vt, { cols: max, rows: max });
		largest.write('largest');
		assert.strictEqual(largest.format_text(), 'largest');
		largest.dispose();
	});

	test('a size the library refuses is a named result error', async () => {
		const vt = await load_test_ghostty_vt();
		for (const options of [
			{ cols: 0, rows: 24 },
			{ cols: 80, rows: 0 }
		]) {
			const error = catch_result_error(() => new GhosttyTerminal(vt, options).dispose());
			assert.strictEqual(error.call, 'ghostty_terminal_new');
			assert.strictEqual(error.result_name, 'INVALID_VALUE');
		}
		const terminal = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
		terminal.write('still here');
		const error = catch_result_error(() => terminal.resize({ cols: 0, rows: 24 }));
		assert.strictEqual(error.call, 'ghostty_terminal_resize');
		assert.strictEqual(error.result_name, 'INVALID_VALUE');
		assert.strictEqual(terminal.format_text(), 'still here');
		terminal.dispose();
	});
});

describe('memory', () => {
	test('a write that grows linear memory leaves later reads valid', async () => {
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, {
			cols: 80,
			rows: 24,
			scrollback_max_bytes: Infinity
		});
		terminal.write('before\r\n');
		const size_before = vt.memory.size;
		const lines: Array<string> = [];
		for (let i = 0; i < 100_000; i++) lines.push(`line ${i}:${'·'.repeat(i % 50)}`);
		terminal.write(lines.join('\r\n'));
		assert.isAbove(vt.memory.size, size_before, 'memory grew');
		const text = terminal.format_text();
		const read = text.split('\n');
		assert.strictEqual(read[0], 'before');
		assert.strictEqual(read.length, lines.length + 1);
		assert.strictEqual(read[1], lines[0]);
		assert.strictEqual(read.at(-1), lines.at(-1));
		assert.strictEqual(read[54_321], lines[54_320]);
		// and more output after the growth reads back too
		terminal.write('\r\nafter');
		assert.strictEqual(terminal.format_text().split('\n').at(-1), 'after');
		terminal.dispose();
	});

	test('scrollback limits bound the history kept', async () => {
		const vt = await load_test_ghostty_vt();
		const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\r\n');
		const unlimited = new GhosttyTerminal(vt, {
			cols: 80,
			rows: 24,
			scrollback_max_bytes: Infinity
		});
		const limited = new GhosttyTerminal(vt, {
			cols: 80,
			rows: 24,
			scrollback_max_bytes: Infinity,
			scrollback_max_lines: 100
		});
		const by_default = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
		for (const terminal of [unlimited, limited, by_default]) terminal.write(lines);
		const kept = (terminal: GhosttyTerminal): number => terminal.format_text().split('\n').length;
		assert.strictEqual(kept(unlimited), 20_000);
		// pruned in whole pages, so more than the limit is kept — but far fewer than all
		assert.isAtLeast(kept(limited), 100);
		assert.isBelow(kept(limited), 20_000);
		assert.isBelow(kept(by_default), 20_000);
		for (const terminal of [unlimited, limited, by_default]) terminal.dispose();
		for (const scrollback_max_bytes of [-1, 1.5, NaN, 2 ** 32]) {
			assert.throws(
				() => new GhosttyTerminal(vt, { cols: 80, rows: 24, scrollback_max_bytes }),
				RangeError,
				'scrollback_max_bytes'
			);
		}
	});
});

describe('the write buffer', () => {
	test('a string larger than one chunk, with surrogate pairs at every boundary', async () => {
		const vt = await load_test_ghostty_vt();
		// one chunk holds 21845 code units; all-astral text puts a pair across
		// a chunk end whatever the parity, and the prefix shifts it once more;
		// three-byte characters fill a chunk to its byte bound
		for (const text of [
			'😀'.repeat(30_000),
			'你'.repeat(30_000),
			`x${'𝄞'.repeat(30_000)}y`,
			`${'a'.repeat(21_844)}😀${'b'.repeat(21_843)}🎉${'c'.repeat(100)}`
		]) {
			const terminal = new GhosttyTerminal(vt, {
				cols: 2000,
				rows: 24,
				scrollback_max_bytes: Infinity
			});
			terminal.write(text);
			const read = terminal.format_text();
			assert.notInclude(read, '\ufffd', 'no pair was split');
			assert.strictEqual(read, text);
			terminal.dispose();
		}
	});

	test('a lone surrogate is written as U+FFFD', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 20, rows: 4 });
		terminal.write('a\ud800b\udc00c');
		assert.strictEqual(terminal.format_text(), 'a\ufffdb\ufffdc');
		terminal.dispose();
	});

	test('many small writes reuse the buffer', async () => {
		let allocs = 0;
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_wasm_alloc: (len: number): number => {
				allocs++;
				return exports.ghostty_wasm_alloc(len);
			}
		}));
		const terminal = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
		terminal.write('warm up\r\n');
		terminal.write(new Uint8Array([0x20]));
		allocs = 0;
		const size = vt.memory.size;
		for (let i = 0; i < 20_000; i++) {
			terminal.write(`\r${i}`);
			terminal.write(new Uint8Array([0x2e]));
		}
		assert.strictEqual(allocs, 0, 'no write allocated');
		assert.strictEqual(vt.memory.size, size);
		assert.strictEqual(terminal.format_text(), 'warm up\n19999.');
		terminal.dispose();
	});

	test('a view taken after a write that grows memory is the live one', async () => {
		const vt = await load_test_ghostty_vt();
		const terminal = new GhosttyTerminal(vt, {
			cols: 80,
			rows: 24,
			scrollback_max_bytes: Infinity
		});
		const before = vt.memory.bytes();
		assert.strictEqual(vt.memory.bytes(), before, 'cached while memory is unchanged');
		terminal.write('line\r\n'.repeat(200_000));
		const after = vt.memory.bytes();
		assert.notStrictEqual(after, before);
		assert.strictEqual(before.byteLength, 0, 'the old view detached');
		assert.strictEqual(after.byteLength, vt.memory.size);
		assert.strictEqual(vt.memory.view().byteLength, vt.memory.size);
		terminal.dispose();
	});
});

describe('handles', () => {
	test('two terminals are independent', async () => {
		const vt = await load_test_ghostty_vt();
		const a = new GhosttyTerminal(vt, { cols: 10, rows: 4 });
		const b = new GhosttyTerminal(vt, { cols: 10, rows: 4 });
		a.write('alpha 1234567');
		b.write(`${ESC}[31mbravo`);
		b.resize({ cols: 4, rows: 4 });
		assert.strictEqual(a.format_text({ unwrap: false }), 'alpha 1234\n567');
		assert.strictEqual(b.format_text({ unwrap: false }), 'brav\no');
		a.dispose();
		b.write('!');
		assert.strictEqual(b.format_text(), 'bravo!');
		b.dispose();
	});

	test('dispose is idempotent, and any use after it throws', async () => {
		const terminal = new GhosttyTerminal(await load_test_ghostty_vt(), { cols: 80, rows: 24 });
		terminal.write('x');
		assert.strictEqual(terminal.format_text(), 'x'); // the formatter now exists too
		assert.isFalse(terminal.disposed);
		terminal.dispose();
		assert.isTrue(terminal.disposed);
		terminal.dispose();
		assert.throws(() => terminal.write('y'), GhosttyDisposedError, 'GhosttyTerminal.write');
		assert.throws(() => terminal.write(new Uint8Array()), GhosttyDisposedError);
		assert.throws(
			() => terminal.format_text(),
			GhosttyDisposedError,
			'GhosttyTerminal.format_text'
		);
		assert.throws(
			() => terminal.resize({ cols: 80, rows: 24 }),
			GhosttyDisposedError,
			'GhosttyTerminal.resize'
		);
	});

	test('a constructor that fails after creating the terminal frees it', async () => {
		// a doctored manifest makes the scrollback option a u16, so setting
		// 70000 throws after `ghostty_terminal_new` has succeeded
		const vt = await load_doctored_ghostty_vt((manifest) => {
			const keys = manifest.types.GhosttyTerminalOption.keys;
			keys.SCROLLBACK_MAX_BYTES.type = 'u16';
			keys.SCROLLBACK_MAX_LINES.type = 'u16';
		});
		const attempt = (): unknown => {
			try {
				new GhosttyTerminal(vt, { cols: 80, rows: 24, scrollback_max_bytes: 70_000 }).dispose();
			} catch (error) {
				return error;
			}
			return undefined;
		};
		const first = attempt();
		assert(first instanceof RangeError, String(first));
		assert.include(first.message, 'a u16');
		const size = vt.memory.size;
		for (let i = 0; i < 5000; i++) assert(attempt() instanceof RangeError);
		assert.strictEqual(vt.memory.size, size, 'each failed terminal was freed');
	});

	test('freed handles are reused without leaking into new terminals', async () => {
		const vt = await load_test_ghostty_vt();
		const cycles = (count: number): void => {
			for (let i = 0; i < count; i++) {
				const terminal = new GhosttyTerminal(vt, { cols: 80, rows: 24 });
				terminal.write(`terminal ${i}`);
				assert.strictEqual(terminal.format_text(), `terminal ${i}`);
				terminal.dispose();
			}
		};
		// the allocator settles within the first batch (a page, at most), and a
		// leak would keep growing through the second
		cycles(5000);
		const size = vt.memory.size;
		cycles(5000);
		assert.strictEqual(vt.memory.size, size);
	});
});
