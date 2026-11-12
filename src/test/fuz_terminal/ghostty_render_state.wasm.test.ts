import { test, describe, assert } from 'vitest';

import {
	GhosttyDisposedError,
	GhosttyLoadError,
	GhosttyManifestError,
	GhosttyPoisonedError
} from '#lib/fuz_terminal/ghostty_errors.ts';
import {
	GHOSTTY_RENDER_DEFAULT_STYLE,
	type GhosttyRenderColor,
	type GhosttyRenderRow,
	type GhosttyRenderStyle
} from '#lib/fuz_terminal/ghostty_render_frame.ts';
import {
	GhosttyRenderState,
	resolve_ghostty_render_constants
} from '#lib/fuz_terminal/ghostty_render_state.ts';
import { GhosttyTerminal } from '#lib/fuz_terminal/ghostty_terminal.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

import {
	load_doctored_ghostty_vt,
	load_test_ghostty_vt,
	load_wrapped_ghostty_vt
} from './ghostty_vt_test_helpers.ts';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
const RESET = `${ESC}[0m`;

/** A terminal and a render state over it. */
const create = async (
	cols = 80,
	rows = 24,
	vt?: GhosttyVt
): Promise<{ vt: GhosttyVt; terminal: GhosttyTerminal; frame: GhosttyRenderState }> => {
	const instance = vt ?? (await load_test_ghostty_vt());
	const terminal = new GhosttyTerminal(instance, { cols, rows });
	return { vt: instance, terminal, frame: new GhosttyRenderState(terminal) };
};

/** An instance whose every call into the module is recorded, by export name, in `calls`. */
const load_counted_ghostty_vt = async (): Promise<{ vt: GhosttyVt; calls: Array<string> }> => {
	const calls: Array<string> = [];
	const vt = await load_wrapped_ghostty_vt((exports) => {
		const wrapped: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(exports)) {
			if (typeof value !== 'function') continue;
			wrapped[name] = (...args: Array<unknown>): unknown => {
				calls.push(name);
				return (value as (...a: Array<unknown>) => unknown)(...args);
			};
		}
		return wrapped;
	});
	return { vt, calls };
};

const describe_color = (color: GhosttyRenderColor | null): string | null => {
	if (color === null) return null;
	return color.kind === 'palette'
		? `p${color.index}`
		: `#${color.rgb.toString(16).padStart(6, '0')}`;
};

/** A style's settings as words, empty for the default: `fg:p1 bold underline:curly`. */
const describe_style = (style: GhosttyRenderStyle): string => {
	const words: Array<string> = [];
	const fg = describe_color(style.fg);
	const bg = describe_color(style.bg);
	const ul = describe_color(style.underline_color);
	if (fg) words.push(`fg:${fg}`);
	if (bg) words.push(`bg:${bg}`);
	if (ul) words.push(`ul:${ul}`);
	for (const flag of [
		'bold',
		'italic',
		'faint',
		'blink',
		'inverse',
		'invisible',
		'strikethrough',
		'overline'
	] as const) {
		if (style[flag]) words.push(flag);
	}
	if (style.underline !== 'none') words.push(`underline:${style.underline}`);
	return words.join(' ');
};

/**
 * A row's runs as exact strings: `x+width "text"`, then `cluster` and
 * `link` when set, then the style.
 */
const describe_runs = (row: GhosttyRenderRow): Array<string> =>
	row.runs.map((run) =>
		[
			`${run.x}+${run.width} ${JSON.stringify(run.text)}`,
			run.cluster ? 'cluster' : '',
			run.hyperlink ? 'link' : '',
			describe_style(run.style)
		]
			.filter(Boolean)
			.join(' ')
	);

/** The rows' text, a space for each blank cell and trailing blanks dropped. */
const rows_text = (rows: ReadonlyArray<GhosttyRenderRow>): Array<string> =>
	rows.map((row) => row.runs.map((run) => run.text).join(''));

describe('the dirty protocol', () => {
	test('the first update is full: every row, the size, the cursor, the colors', async () => {
		const { terminal, frame } = await create(80, 24);
		assert.strictEqual(frame.dirty, 'clean');
		assert.deepEqual(frame.rows, []);
		assert.strictEqual(frame.update(), 'full');
		assert.strictEqual(frame.dirty, 'full');
		assert.strictEqual(frame.cols, 80);
		assert.strictEqual(frame.rows.length, 24);
		for (const row of frame.rows) assert.deepEqual(row.runs, []);
		assert.strictEqual(new Set(frame.rows.map((row) => row.id)).size, 24);
		assert.deepEqual(frame.cursor, {
			visible: true,
			blinking: false,
			password_input: false,
			style: 'block',
			viewport: { x: 0, y: 0, wide_tail: false }
		});
		assert.strictEqual(frame.colors.palette.length, 256);
		terminal.dispose();
	});

	test('an update without a change is clean, two calls in, and replaces nothing', async () => {
		const { vt, calls } = await load_counted_ghostty_vt();
		const { terminal, frame } = await create(80, 24, vt);
		terminal.write('hello');
		frame.update();
		frame.clean();
		const { rows, cursor, colors } = frame;
		calls.length = 0;
		assert.strictEqual(frame.update(), 'clean');
		assert.deepEqual(calls, ['ghostty_render_state_update', 'ghostty_render_state_get_multi']);
		assert.strictEqual(frame.rows, rows);
		assert.strictEqual(frame.cursor, cursor);
		assert.strictEqual(frame.colors, colors);
		terminal.dispose();
	});

	test('one character dirties one row: one new row object, ids read for all', async () => {
		const { vt, calls } = await load_counted_ghostty_vt();
		const { terminal, frame } = await create(80, 24, vt);
		terminal.write('one\r\ntwo');
		frame.update();
		frame.clean();
		const before = frame.rows;
		calls.length = 0;
		terminal.write('!');
		const write_calls = calls.length;
		assert.strictEqual(frame.update(), 'partial');
		const counts = new Map<string, number>();
		for (const call of calls.slice(write_calls)) counts.set(call, (counts.get(call) ?? 0) + 1);
		assert.deepEqual(Object.fromEntries(counts), {
			ghostty_render_state_update: 1,
			ghostty_render_state_get_multi: 1,
			ghostty_render_state_get: 1, // the row iterator
			ghostty_render_state_row_iterator_next: 24,
			ghostty_render_state_row_get_multi: 24
			// a plain row's runs need nothing more: no style, no grapheme read
		});
		assert.notStrictEqual(frame.rows, before);
		assert.deepEqual(rows_text(frame.rows).slice(0, 2), ['one', 'two!']);
		for (let i = 0; i < 24; i++) {
			assert.strictEqual(frame.rows[i] === before[i], i !== 1, `row ${i}`);
			assert.strictEqual(frame.rows[i]!.id, before[i]!.id);
		}
		terminal.dispose();
	});

	test('a styled row reads each style once, and a cluster’s code points once', async () => {
		const { vt, calls } = await load_counted_ghostty_vt();
		const { terminal, frame } = await create(20, 1, vt);
		frame.update();
		frame.clean();
		// red, green, red again (read once for the row), a wide character (no call), a cluster
		terminal.write(`${ESC}[31mab${ESC}[32mcd${ESC}[31mef${RESET}你é`);
		calls.length = 0;
		frame.update();
		const extra = calls.filter((call) => call.startsWith('ghostty_render_state_row_cells_'));
		assert.deepEqual(extra, [
			'ghostty_render_state_row_cells_select',
			'ghostty_render_state_row_cells_get', // red
			'ghostty_render_state_row_cells_select',
			'ghostty_render_state_row_cells_get', // green
			'ghostty_render_state_row_cells_select',
			'ghostty_render_state_row_cells_get' // the cluster
		]);
		assert.deepEqual(describe_runs(frame.rows[0]!), [
			'0+2 "ab" fg:p1',
			'2+2 "cd" fg:p2',
			'4+2 "ef" fg:p1',
			'6+2 "你" cluster',
			`8+1 ${JSON.stringify('é')} cluster`
		]);
		terminal.dispose();
	});

	test('an update only adds dirt: clean clears it', async () => {
		const { terminal, frame } = await create(20, 4);
		frame.update();
		assert.strictEqual(frame.update(), 'full', 'still full without a clean');
		frame.clean();
		assert.strictEqual(frame.update(), 'clean');
		terminal.write('x');
		assert.strictEqual(frame.update(), 'partial');
		assert.strictEqual(frame.update(), 'partial', 'still partial without a clean');
		frame.clean();
		assert.strictEqual(frame.update(), 'clean');
		terminal.dispose();
	});

	test('a resize is full, with the new size', async () => {
		const { terminal, frame } = await create(20, 4);
		terminal.write('abc');
		frame.update();
		frame.clean();
		terminal.resize({ cols: 30, rows: 6 });
		assert.strictEqual(frame.update(), 'full');
		assert.strictEqual(frame.cols, 30);
		assert.strictEqual(frame.rows.length, 6);
		assert.deepEqual(rows_text(frame.rows), ['abc', '', '', '', '', '']);
		terminal.dispose();
	});

	test('a cursor move with no new text keeps every row object', async () => {
		const { terminal, frame } = await create(20, 4);
		terminal.write('ab\r\ncd');
		frame.update();
		frame.clean();
		const rows = frame.rows;
		terminal.write(`${ESC}[4;5H`);
		// the library marks the cursor's old and new rows dirty; their contents are the same
		assert.strictEqual(frame.update(), 'partial');
		assert.notStrictEqual(frame.rows, rows);
		for (let i = 0; i < 4; i++) assert.strictEqual(frame.rows[i], rows[i], `row ${i}`);
		assert.deepEqual(frame.cursor.viewport, { x: 4, y: 3, wide_tail: false });
		terminal.dispose();
	});
});

describe('row identity', () => {
	test('ids stay with rows as they scroll; new rows get new ids, never an old one', async () => {
		const { terminal, frame } = await create(20, 4);
		terminal.write('line 0');
		frame.update();
		frame.clean();
		const seen = new Set(frame.rows.map((row) => row.id));
		let previous = frame.rows;
		for (let n = 1; n <= 40; n++) {
			terminal.write(`\r\nline ${n}`);
			// a scroll rebuilds every row: a full update
			assert.strictEqual(frame.update(), n < 4 ? 'partial' : 'full', `line ${n}`);
			frame.clean();
			const rows = frame.rows;
			if (n >= 4) {
				// every row moved up one: the top three are the previous update's last three
				for (let i = 0; i < 3; i++) {
					assert.strictEqual(rows[i]!.id, previous[i + 1]!.id);
					// rebuilt by the library, unchanged: the same object
					assert.strictEqual(rows[i], previous[i + 1]);
				}
				assert.isFalse(seen.has(rows[3]!.id), `line ${n}'s row has a new id`);
				seen.add(rows[3]!.id);
			}
			previous = rows;
		}
		assert.deepEqual(rows_text(frame.rows), ['line 37', 'line 38', 'line 39', 'line 40']);
		terminal.dispose();
	});

	test('rows keep their objects across a scroll of several lines at once', async () => {
		const { terminal, frame } = await create(20, 6);
		terminal.write(['a', 'b', 'c', 'd', 'e', 'f'].join('\r\n'));
		frame.update();
		frame.clean();
		const before = frame.rows;
		terminal.write('\r\ng\r\nh');
		assert.strictEqual(frame.update(), 'full');
		assert.deepEqual(rows_text(frame.rows), ['c', 'd', 'e', 'f', 'g', 'h']);
		for (let i = 0; i < 4; i++) assert.strictEqual(frame.rows[i], before[i + 2]);
		terminal.dispose();
	});

	test('an edit that moves rows in the page gives every row of it a new id', async () => {
		const { terminal, frame } = await create(10, 5);
		terminal.write('a\r\nb\r\nc\r\nd\r\ne');
		frame.update();
		frame.clean();
		const before = frame.rows;
		// a scroll inside a scroll region (rows 2 to 4): only part of the screen moves
		terminal.write(`${ESC}[2;4r${ESC}[4;1H\n`);
		assert.strictEqual(frame.update(), 'partial');
		assert.deepEqual(rows_text(frame.rows), ['a', 'c', 'd', '', 'e']);
		// the rows outside the region kept their contents, not their ids or objects
		for (const y of [0, 4]) {
			assert.notStrictEqual(frame.rows[y]!.id, before[y]!.id, `row ${y}`);
			assert.notStrictEqual(frame.rows[y], before[y], `row ${y}`);
		}
		frame.clean();
		const region = frame.rows;
		// an inserted line, the same
		terminal.write(`${ESC}[r${ESC}[1;1H${ESC}[L`);
		assert.strictEqual(frame.update(), 'partial');
		assert.deepEqual(rows_text(frame.rows), ['', 'a', 'c', 'd', '']);
		for (let y = 0; y < 5; y++) assert.notStrictEqual(frame.rows[y]!.id, region[y]!.id);
		terminal.dispose();
	});

	test('the alternate screen numbers its rows on its own; objects follow contents', async () => {
		const { terminal, frame } = await create(20, 3);
		terminal.write('primary');
		frame.update();
		frame.clean();
		const primary = frame.rows;
		terminal.write(`${ESC}[?1049h${ESC}[Halt`);
		assert.strictEqual(frame.update(), 'full');
		assert.deepEqual(rows_text(frame.rows), ['alt', '', '']);
		// the library's ids for the alternate screen's rows repeat the primary's
		assert.deepEqual(
			frame.rows.map((row) => row.id),
			primary.map((row) => row.id)
		);
		// a key that came back holds the new row's contents, in a new object
		assert.notStrictEqual(frame.rows[0], primary[0]);
		frame.clean();
		terminal.write(`${ESC}[?1049l`);
		assert.strictEqual(frame.update(), 'full');
		assert.deepEqual(rows_text(frame.rows), ['primary', '', '']);
		terminal.dispose();
	});
});

describe('runs', () => {
	/** The runs of the first row after writing `output` to a fresh 20-column terminal. */
	const first_row_runs = async (output: string, cols = 20): Promise<Array<string>> => {
		const { terminal, frame } = await create(cols, 2);
		terminal.write(output);
		frame.update();
		const runs = describe_runs(frame.rows[0]!);
		terminal.dispose();
		return runs;
	};

	test('plain text is one run; inner blanks are spaces; trailing blanks are dropped', async () => {
		assert.deepEqual(await first_row_runs('hello  world   '), ['0+12 "hello  world"']);
		assert.deepEqual(await first_row_runs(`${ESC}[5Cx`), ['0+6 "     x"']);
		assert.deepEqual(await first_row_runs(''), []);
	});

	test('16-color, 256-color, and RGB colors, foreground and background', async () => {
		assert.deepEqual(
			await first_row_runs(
				`${ESC}[31ma${ESC}[42mb${ESC}[91;104mc${RESET}${ESC}[38;5;123md${ESC}[48;5;200me${RESET}` +
					`${ESC}[38;2;255;128;0mf${ESC}[48;2;1;2;3mg${ESC}[39mh${ESC}[49mi`
			),
			[
				'0+1 "a" fg:p1',
				'1+1 "b" fg:p1 bg:p2',
				'2+1 "c" fg:p9 bg:p12',
				'3+1 "d" fg:p123',
				'4+1 "e" fg:p123 bg:p200',
				'5+1 "f" fg:#ff8000',
				'6+1 "g" fg:#ff8000 bg:#010203',
				'7+1 "h" bg:#010203',
				'8+1 "i"'
			]
		);
	});

	test('each flag, the underline kinds, and the underline color', async () => {
		assert.deepEqual(
			await first_row_runs(
				`${ESC}[1ma${RESET}${ESC}[3mb${RESET}${ESC}[2mc${RESET}${ESC}[5md${RESET}` +
					`${ESC}[7me${RESET}${ESC}[8mf${RESET}${ESC}[9mg${RESET}${ESC}[53mh${RESET}` +
					`${ESC}[4mi${ESC}[4:2mj${ESC}[4:3mk${ESC}[4:4ml${ESC}[4:5mm${ESC}[21mn` +
					`${ESC}[4;58;5;3mo${ESC}[58;2;10;20;30mp${RESET}`
			),
			[
				'0+1 "a" bold',
				'1+1 "b" italic',
				'2+1 "c" faint',
				'3+1 "d" blink',
				'4+1 "e" inverse',
				'5+1 "f" invisible',
				'6+1 "g" strikethrough',
				'7+1 "h" overline',
				'8+1 "i" underline:single',
				'9+1 "j" underline:double',
				'10+1 "k" underline:curly',
				'11+1 "l" underline:dotted',
				'12+1 "m" underline:dashed',
				'13+1 "n" underline:double',
				'14+1 "o" ul:p3 underline:single',
				'15+1 "p" ul:#0a141e underline:single'
			]
		);
	});

	test('inverse is a flag: the colors stay as set, for the renderer to swap', async () => {
		assert.deepEqual(await first_row_runs(`${ESC}[31;42;7minv`), ['0+3 "inv" fg:p1 bg:p2 inverse']);
	});

	test('adjacent cells of one style coalesce; equal styles are one object', async () => {
		const { terminal, frame } = await create(20, 3);
		terminal.write(
			`${ESC}[1;31mab${ESC}[1;31mcd${RESET}  ${ESC}[31;1mef${RESET}\r\n${ESC}[31;1mgh${RESET}`
		);
		frame.update();
		assert.deepEqual(describe_runs(frame.rows[0]!), [
			'0+4 "abcd" fg:p1 bold',
			'4+2 "  "',
			'6+2 "ef" fg:p1 bold'
		]);
		const a = frame.rows[0]!.runs[0]!.style;
		assert.strictEqual(frame.rows[0]!.runs[2]!.style, a);
		// another row, a page-local style id read again: the same interned style
		assert.strictEqual(frame.rows[1]!.runs[0]!.style, a);
		assert.strictEqual(frame.rows[0]!.runs[1]!.style, GHOSTTY_RENDER_DEFAULT_STYLE);
		frame.clean();
		// and in a later update
		terminal.write(`\r\n${ESC}[1;31mij`);
		frame.update();
		assert.strictEqual(frame.rows[2]!.runs[0]!.style, a);
		terminal.dispose();
	});

	test('a color as text and the same color as background are separate cached styles', async () => {
		const { terminal, frame } = await create(20, 6);
		// rows alternating red text and red background, redrawn with new text
		// each frame: each style is one object, in a frame and across frames
		const draw = (n: number): void => {
			terminal.write(`${ESC}[H`);
			for (let y = 0; y < 6; y++) {
				terminal.write(`${ESC}[${y % 2 === 0 ? 31 : 41}m${n}:${y}${RESET}${y < 5 ? '\r\n' : ''}`);
			}
		};
		draw(0);
		frame.update();
		const fg = frame.rows[0]!.runs[0]!.style;
		const bg = frame.rows[1]!.runs[0]!.style;
		assert.notStrictEqual(fg.key, bg.key);
		for (let n = 0; n < 3; n++) {
			if (n > 0) {
				draw(n);
				frame.update();
			}
			for (const [y, row] of frame.rows.entries()) {
				assert.strictEqual(row.runs[0]!.text, `${n}:${y}`);
				assert.strictEqual(row.runs[0]!.style, y % 2 === 0 ? fg : bg, `frame ${n} row ${y}`);
			}
			frame.clean();
		}
		terminal.dispose();
	});

	test('wide characters are clusters of two columns; the spacer has no text', async () => {
		assert.deepEqual(await first_row_runs('a你好b'), [
			'0+1 "a"',
			'1+2 "你" cluster',
			'3+2 "好" cluster',
			'5+1 "b"'
		]);
		// a wide character that doesn't fit wraps, leaving a blank at the row's end
		const { terminal, frame } = await create(4, 2);
		terminal.write('abc你');
		frame.update();
		// the spacer head left in the last column draws nothing
		assert.deepEqual(describe_runs(frame.rows[0]!), ['0+3 "abc"']);
		assert.deepEqual(describe_runs(frame.rows[1]!), ['0+2 "你" cluster']);
		terminal.dispose();
		// a row that's blank but for a spacer head has no runs
		const blank = await create(10, 2);
		blank.terminal.write(`${ESC}[10G中`);
		blank.frame.update();
		assert.deepEqual(describe_runs(blank.frame.rows[0]!), []);
		assert.deepEqual(describe_runs(blank.frame.rows[1]!), ['0+2 "中" cluster']);
		// a styled one is kept, like any styled blank
		blank.terminal.write(`\r\n${ESC}[41m${ESC}[2K${ESC}[10G中${RESET}`);
		blank.frame.update();
		assert.deepEqual(describe_runs(blank.frame.rows[0]!), ['0+10 "          " bg:p1']);
		blank.terminal.dispose();
	});

	test('combining marks and ZWJ sequences are clusters', async () => {
		const accented = 'e\u0301';
		assert.deepEqual(await first_row_runs(`${accented}x`), [
			`0+1 ${JSON.stringify(accented)} cluster`,
			'1+1 "x"'
		]);
		// with grapheme clustering (mode 2027), a ZWJ family is one wide cluster
		assert.deepEqual(await first_row_runs(`${ESC}[?2027h👨‍👩‍👧!`), ['0+2 "👨‍👩‍👧" cluster', '2+1 "!"']);
		// a cluster longer than the reader's first buffer
		const long = 'a' + '́'.repeat(40);
		assert.deepEqual(await first_row_runs(`${long}b`), [
			`0+1 ${JSON.stringify(long)} cluster`,
			'1+1 "b"'
		]);
	});

	test('a styled cluster carries its style; a run around it splits', async () => {
		assert.deepEqual(await first_row_runs(`${ESC}[32mx你y${RESET}`), [
			'0+1 "x" fg:p2',
			'1+2 "你" cluster fg:p2',
			'3+1 "y" fg:p2'
		]);
	});

	test('cells of background only paint, palette and RGB', async () => {
		assert.deepEqual(await first_row_runs(`ab${ESC}[42m${ESC}[K`, 8), [
			'0+2 "ab"',
			'2+6 "      " bg:p2'
		]);
		assert.deepEqual(await first_row_runs(`${ESC}[48;2;1;2;3m${ESC}[2K`, 4), [
			'0+4 "    " bg:#010203'
		]);
		// an erase paints the background alone, whatever else the style has
		assert.deepEqual(await first_row_runs(`${ESC}[4;1;41m${ESC}[K`, 4), ['0+4 "    " bg:p1']);
	});

	test('styled blanks are kept; trailing default blanks after them are dropped', async () => {
		assert.deepEqual(await first_row_runs(`a${ESC}[41m  ${RESET}   `), [
			'0+1 "a"',
			'1+2 "  " bg:p1'
		]);
	});

	test('a hyperlink splits runs by the flag', async () => {
		assert.deepEqual(
			await first_row_runs(`a${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}b`),
			['0+1 "a"', '1+4 "link" link', '5+1 "b"']
		);
	});

	test('astral code points: one narrow cell each, two code units', async () => {
		const { terminal, frame } = await create(10, 1);
		// mathematical letters: narrow, outside the BMP
		terminal.write('𝐀𝐁c');
		frame.update();
		assert.deepEqual(describe_runs(frame.rows[0]!), ['0+3 "𝐀𝐁c"']);
		terminal.dispose();
	});

	test('a full-width row of mixed content', async () => {
		const { terminal, frame } = await create(200, 3);
		const pieces: Array<string> = [];
		for (let i = 0; i < 40; i++) pieces.push(`${ESC}[3${i % 8}mab${RESET}c你`);
		terminal.write(pieces.join(''));
		frame.update();
		const row = frame.rows[0]!;
		// the runs tile the row from column 0
		let x = 0;
		for (const run of row.runs) {
			assert.strictEqual(run.x, x);
			x += run.width;
		}
		assert.strictEqual(x, 200);
		assert.strictEqual(row.runs.length, 40 * 3);
		terminal.dispose();
	});
});

describe('cursor', () => {
	test('position, DECTCEM, and DECSCUSR shapes; a new object only on change', async () => {
		const { terminal, frame } = await create(20, 4);
		terminal.write('ab');
		frame.update();
		frame.clean();
		const first = frame.cursor;
		assert.deepEqual(first.viewport, { x: 2, y: 0, wide_tail: false });
		frame.update();
		assert.strictEqual(frame.cursor, first, 'unchanged: the same object');
		terminal.write(`${ESC}[?25l`);
		frame.update();
		assert.isFalse(frame.cursor.visible);
		terminal.write(`${ESC}[?25h`);
		frame.update();
		assert.isTrue(frame.cursor.visible);
		const shapes: Array<[number, string, boolean]> = [
			[1, 'block', true],
			[2, 'block', false],
			[3, 'underline', true],
			[4, 'underline', false],
			[5, 'bar', true],
			[6, 'bar', false]
		];
		for (const [param, style, blinking] of shapes) {
			terminal.write(`${ESC}[${param} q`);
			// a shape changes on a clean update: the cursor isn't row state
			const dirty = frame.update();
			assert.strictEqual(frame.cursor.style, style, `DECSCUSR ${param}`);
			assert.strictEqual(frame.cursor.blinking, blinking, `DECSCUSR ${param}`);
			assert.strictEqual(dirty, 'clean', `DECSCUSR ${param}`);
		}
		terminal.dispose();
	});

	test('on the second cell of a wide character', async () => {
		const { terminal, frame } = await create(20, 4);
		terminal.write(`你${ESC}[1;2H`);
		frame.update();
		assert.deepEqual(frame.cursor.viewport, { x: 1, y: 0, wide_tail: true });
		terminal.dispose();
	});
});

describe('colors', () => {
	test('OSC 4 changes the palette: a full update and a new palette array', async () => {
		const { terminal, frame } = await create(20, 2);
		frame.update();
		frame.clean();
		const { palette } = frame.colors;
		terminal.write(`${ESC}]4;1;rgb:12/34/56${ST}`);
		assert.strictEqual(frame.update(), 'full');
		assert.notStrictEqual(frame.colors.palette, palette);
		assert.strictEqual(frame.colors.palette[1], 0x123456);
		for (let i = 0; i < 256; i++) {
			if (i !== 1) assert.strictEqual(frame.colors.palette[i], palette[i], `palette ${i}`);
		}
		terminal.dispose();
	});

	test('OSC 10, 11, and 12 change on a clean update, the palette kept', async () => {
		const { terminal, frame } = await create(20, 2);
		frame.update();
		frame.clean();
		const colors = frame.colors;
		assert.strictEqual(colors.cursor, null);
		terminal.write(`${ESC}]10;#102030${BEL}${ESC}]11;#405060${BEL}${ESC}]12;#708090${BEL}`);
		assert.strictEqual(frame.update(), 'clean');
		assert.notStrictEqual(frame.colors, colors);
		assert.strictEqual(frame.colors.foreground, 0x102030);
		assert.strictEqual(frame.colors.background, 0x405060);
		assert.strictEqual(frame.colors.cursor, 0x708090);
		assert.strictEqual(frame.colors.palette, colors.palette);
		const set = frame.colors;
		frame.update();
		assert.strictEqual(frame.colors, set, 'unchanged: the same object');
		// reverse video swaps the defaults
		terminal.write(`${ESC}[?5h`);
		frame.update();
		assert.strictEqual(frame.colors.foreground, 0x405060);
		assert.strictEqual(frame.colors.background, 0x102030);
		terminal.dispose();
	});
});

describe('what the library leaves untracked or unset', () => {
	test('without mode 2027, a zero-width mark in its own write doesn’t dirty its row', async () => {
		// libghostty-vt joins the mark to the cell before it without marking
		// the row changed; with mode 2027 it does. Pinned so an upgrade that
		// fixes it says so.
		const fixed =
			'libghostty-vt now tracks a zero-width mark written on its own: remove the note on GhosttyRenderState and in docs/architecture.md, this test, and the differential test’s guard against it';
		const accented = 'p\u0301';
		const { terminal, frame } = await create(10, 2);
		terminal.write('p');
		frame.update();
		frame.clean();
		terminal.write('\u0301');
		assert.strictEqual(frame.update(), 'clean', fixed);
		assert.deepEqual(rows_text(frame.rows), ['p', ''], fixed);
		// the terminal has it: a new render state's first frame shows it
		frame.dispose();
		const fresh = new GhosttyRenderState(terminal);
		fresh.update();
		assert.deepEqual(describe_runs(fresh.rows[0]!), [`0+1 ${JSON.stringify(accented)} cluster`]);
		fresh.clean();
		// and anything else touching the row brings an incremental reader back
		terminal.write('\u0301');
		assert.strictEqual(fresh.update(), 'clean', fixed);
		terminal.write('x');
		assert.strictEqual(fresh.update(), 'partial');
		assert.deepEqual(rows_text(fresh.rows), [`${accented}\u0301x`, '']);
		terminal.dispose();
		// with mode 2027 on, the same input is tracked
		const clustered = await create(10, 2);
		clustered.terminal.write(`${ESC}[?2027hp`);
		clustered.frame.update();
		clustered.frame.clean();
		clustered.terminal.write('\u0301');
		assert.strictEqual(clustered.frame.update(), 'partial');
		assert.deepEqual(describe_runs(clustered.frame.rows[0]!), [
			`0+1 ${JSON.stringify(accented)} cluster`
		]);
		clustered.terminal.dispose();
	});

	test('the default colors are placeholders until both are set', async () => {
		const { terminal, frame } = await create(10, 2);
		frame.update();
		// the library's white on black
		assert.strictEqual(frame.colors.foreground, 0xffffff);
		assert.strictEqual(frame.colors.background, 0x000000);
		// a background alone isn't taken: the library takes the defaults as a pair
		terminal.write(`${ESC}]11;#405060${BEL}`);
		frame.update();
		assert.strictEqual(frame.colors.foreground, 0xffffff);
		assert.strictEqual(frame.colors.background, 0x000000);
		terminal.write(`${ESC}]10;#102030${BEL}`);
		frame.update();
		assert.strictEqual(frame.colors.foreground, 0x102030);
		assert.strictEqual(frame.colors.background, 0x405060);
		terminal.dispose();
	});
});

describe('memory', () => {
	test('a write after an update leaves what it read intact', async () => {
		const { terminal, frame } = await create(20, 2);
		terminal.write(`${ESC}[31mred${RESET} 你`);
		frame.update();
		const rows = frame.rows;
		const runs = describe_runs(rows[0]!);
		// overwrite, and grow memory, before reading what the update gave
		terminal.write(`\r${ESC}[42mxxxxxxxxxx`);
		terminal.write('y'.repeat(100_000));
		assert.strictEqual(frame.rows, rows);
		assert.deepEqual(describe_runs(rows[0]!), runs);
		assert.deepEqual(runs, ['0+3 "red" fg:p1', '3+1 " "', '4+2 "你" cluster']);
		terminal.dispose();
	});

	test('an update after memory grows reads the live memory', async () => {
		const { vt, terminal, frame } = await create(40, 4);
		frame.update();
		frame.clean();
		const size = vt.memory.size;
		const other = new GhosttyTerminal(vt, { cols: 40, rows: 4, scrollback_max_bytes: Infinity });
		other.write('grow\r\n'.repeat(200_000));
		assert.isAbove(vt.memory.size, size, 'memory grew');
		terminal.write(`${ESC}[1mbold${RESET} 你好`);
		assert.strictEqual(frame.update(), 'partial');
		assert.deepEqual(describe_runs(frame.rows[0]!), [
			'0+4 "bold" bold',
			'4+1 " "',
			'5+2 "你" cluster',
			'7+2 "好" cluster'
		]);
		other.dispose();
		terminal.dispose();
	});

	test('memory growing mid-row, as the grapheme buffer grows, leaves the rest of the row right', async () => {
		let grow = false;
		let grows = 0;
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_wasm_alloc: (len: number): number => {
				if (grow) {
					exports.memory.grow(1);
					grows++;
				}
				return exports.ghostty_wasm_alloc(len);
			}
		}));
		const { terminal, frame } = await create(40, 2, vt);
		frame.update();
		frame.clean();
		const long = 'e' + '\u0301'.repeat(30);
		const longer = 'o' + '\u0302'.repeat(50);
		terminal.write(`ab${ESC}[31mc${long}d${ESC}[32mf中${RESET}gh${longer}z`);
		grow = true;
		frame.update();
		grow = false;
		// one growth for each cluster longer than the buffer so far
		assert.strictEqual(grows, 2);
		assert.deepEqual(describe_runs(frame.rows[0]!), [
			'0+2 "ab"',
			'2+1 "c" fg:p1',
			`3+1 ${JSON.stringify(long)} cluster fg:p1`,
			'4+1 "d" fg:p1',
			'5+1 "f" fg:p2',
			'6+2 "中" cluster fg:p2',
			'8+2 "gh"',
			`10+1 ${JSON.stringify(longer)} cluster`,
			'11+1 "z"'
		]);
		terminal.dispose();
	});

	test('updates allocate nothing in the module once running; dispose frees all', async () => {
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
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 4 });
		terminal.write('x');
		const base_allocs = allocs;
		const base_frees = frees;
		const frame = new GhosttyRenderState(terminal);
		// the scratch block and the codepoint buffer
		assert.strictEqual(allocs - base_allocs, 2);
		for (let i = 0; i < 50; i++) {
			terminal.write(`\r\n${ESC}[3${i % 8}m${i}é 你${RESET}`);
			frame.update();
			frame.clean();
		}
		// the terminal's write buffer was made by the first write; nothing else allocated
		assert.strictEqual(allocs - base_allocs, 2);
		frame.dispose();
		assert.strictEqual(frees - base_frees, 2);
		terminal.dispose();
	});
});

describe('lifetime', () => {
	test('dispose is idempotent; any use after it throws', async () => {
		const { terminal, frame } = await create(20, 2);
		frame.update();
		frame.dispose();
		frame.dispose();
		assert.isTrue(frame.disposed);
		assert.throws(() => frame.update(), GhosttyDisposedError, 'GhosttyRenderState.update');
		assert.throws(() => frame.clean(), GhosttyDisposedError, 'GhosttyRenderState.clean');
		// what it read stays readable
		assert.strictEqual(frame.rows.length, 2);
		// the terminal goes on, and disposes without it
		terminal.write('still here');
		terminal.dispose();
	});

	test('disposing the terminal disposes its render states first', async () => {
		const order: Array<string> = [];
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_render_state_free: (state: number): void => {
				order.push('render_state');
				exports.ghostty_render_state_free(state);
			},
			ghostty_terminal_free: (terminal: number): void => {
				order.push('terminal');
				exports.ghostty_terminal_free(terminal);
			}
		}));
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		const disposed_early = new GhosttyRenderState(terminal);
		disposed_early.dispose();
		assert.deepEqual(order, ['render_state']);
		const a = new GhosttyRenderState(terminal);
		terminal.dispose();
		assert.deepEqual(order, ['render_state', 'render_state', 'terminal']);
		assert.isTrue(a.disposed);
		assert.throws(() => a.update(), GhosttyDisposedError);
		a.dispose();
		assert.strictEqual(order.length, 3);
		assert.throws(() => new GhosttyRenderState(terminal), GhosttyDisposedError);
	});

	test('a terminal has one live render state; after it, a new one starts with a full frame', async () => {
		const { vt, terminal, frame } = await create(20, 2);
		assert.throws(() => new GhosttyRenderState(terminal), 'already has a GhosttyRenderState');
		// another terminal's is its own
		const other = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		const other_frame = new GhosttyRenderState(other);
		terminal.write('hello');
		frame.update();
		frame.clean();
		terminal.write(' world');
		frame.update();
		frame.clean();
		frame.dispose();
		// the terminal's change tracking is consumed: still, a new reader sees everything
		const next = new GhosttyRenderState(terminal);
		assert.strictEqual(next.update(), 'full');
		assert.deepEqual(rows_text(next.rows), ['hello world', '']);
		next.clean();
		terminal.write('!');
		assert.strictEqual(next.update(), 'partial');
		assert.deepEqual(rows_text(next.rows), ['hello world!', '']);
		other_frame.dispose();
		other.dispose();
		terminal.dispose();
	});

	test('a module without the render_state feature is refused at construction', async () => {
		const real = await load_test_ghostty_vt();
		const feature = real.manifest.enum_value('GhosttyBuildInfo', 'FEATURE_RENDER_STATE');
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_build_info: (data: number, out: number): number => {
				const result = exports.ghostty_build_info(data, out);
				if (data === feature) new Uint8Array(exports.memory.buffer)[out] = 0;
				return result;
			}
		}));
		assert.isFalse(vt.has_feature('render_state'));
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		assert.throws(() => new GhosttyRenderState(terminal), GhosttyLoadError, 'render_state');
		terminal.dispose();
	});

	test('a constructor that fails partway frees what it made', async () => {
		const freed: Array<string> = [];
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			// fails as allocation failing does, before filling its slot
			ghostty_render_state_row_cells_new: (): number => -1, // GHOSTTY_OUT_OF_MEMORY
			ghostty_render_state_free: (state: number): void => {
				freed.push('render_state');
				exports.ghostty_render_state_free(state);
			},
			ghostty_render_state_row_iterator_free: (iterator: number): void => {
				freed.push('row_iterator');
				exports.ghostty_render_state_row_iterator_free(iterator);
			}
		}));
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		assert.throws(() => new GhosttyRenderState(terminal), 'OUT_OF_MEMORY');
		assert.deepEqual(freed, ['row_iterator', 'render_state']);
		terminal.dispose();
	});

	test('once poisoned, nothing calls in: updates refuse and dispose drops', async () => {
		const calls: Array<string> = [];
		let fail = false;
		const vt = await load_wrapped_ghostty_vt((exports) => {
			const wrapped: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(exports)) {
				if (typeof value !== 'function') continue;
				wrapped[name] = (...args: Array<unknown>): unknown => {
					calls.push(name);
					if (fail && name === 'ghostty_render_state_row_get_multi') {
						throw new Error('a trap');
					}
					return (value as (...a: Array<unknown>) => unknown)(...args);
				};
			}
			return wrapped;
		});
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		const frame = new GhosttyRenderState(terminal);
		frame.update();
		terminal.write('x');
		fail = true;
		assert.throws(() => frame.update(), 'a trap');
		assert.ok(vt.poisoned);
		calls.length = 0;
		assert.throws(() => frame.update(), GhosttyPoisonedError);
		assert.throws(() => frame.clean(), GhosttyPoisonedError);
		frame.dispose();
		terminal.dispose();
		assert.deepEqual(calls, []);
		assert.isTrue(frame.disposed);
	});
});

describe('render holds', () => {
	test('an update inside the hold-begin handler captures the frame before the hold', async () => {
		const { terminal, frame } = await create(20, 2);
		const holds: Array<boolean> = [];
		let held = false;
		terminal.set_effect('render_hold', (h) => {
			holds.push(h);
			held = h;
			if (h) frame.update();
		});
		terminal.write(`done${ESC}[?2026h\r${ESC}[2Kha`);
		assert.deepEqual(holds, [true]);
		assert.isTrue(held);
		// the frame the program wants left on screen, though later bytes were parsed
		assert.deepEqual(rows_text(frame.rows), ['done', '']);
		assert.strictEqual(terminal.format_text(), 'ha');
		// setting the mode again during a hold fires nothing
		terminal.write(`lf${ESC}[?2026h`);
		assert.deepEqual(holds, [true]);
		terminal.write(`${ESC}[?2026l`);
		assert.deepEqual(holds, [true, false]);
		frame.update();
		assert.deepEqual(rows_text(frame.rows), ['half', '']);
		terminal.dispose();
	});

	test('a resize and a full reset end a hold', async () => {
		const { terminal, frame } = await create(20, 2);
		const holds: Array<boolean> = [];
		terminal.set_effect('render_hold', (h) => {
			holds.push(h);
			// the terminal is consistent when the end fires, mid-resize included
			frame.update();
		});
		terminal.write(`${ESC}[?2026h`);
		terminal.resize({ cols: 30, rows: 3 });
		assert.deepEqual(holds, [true, false]);
		assert.strictEqual(frame.cols, 30);
		terminal.write(`${ESC}[?2026h${ESC}c`);
		assert.deepEqual(holds, [true, false, true, false]);
		// resetting the mode with no hold fires nothing
		terminal.write(`${ESC}[?2026l`);
		assert.strictEqual(holds.length, 4);
		terminal.dispose();
	});
});

describe('the manifest', () => {
	const doctored_error = async (edit: (types: Record<string, any>) => void): Promise<string> => {
		const vt = await load_doctored_ghostty_vt((manifest) => edit(manifest.types));
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		try {
			new GhosttyRenderState(terminal).dispose();
		} catch (error) {
			assert(error instanceof GhosttyManifestError, String(error));
			return error.message;
		} finally {
			terminal.dispose();
		}
		assert.fail('expected a GhosttyManifestError');
	};

	test('a GhosttyCell bit field dropped, moved onto another, or out of range fails at construction', async () => {
		assert.include(
			await doctored_error((types) => delete types.GhosttyCell.bits.wide),
			'no usable bit field GhosttyCell.wide'
		);
		assert.include(
			await doctored_error((types) => (types.GhosttyCell.bits.style_id.lsb = 30)),
			'GhosttyCell fields overlap'
		);
		assert.include(
			await doctored_error((types) => (types.GhosttyCell.bits.hyperlink.lsb = 64)),
			'no usable bit field GhosttyCell.hyperlink'
		);
		assert.include(
			await doctored_error(
				(types) => delete types.GhosttyCell.bits.content.arms.CODEPOINT.bits.codepoint
			),
			'GhosttyCell.content.CODEPOINT.codepoint'
		);
		assert.include(
			await doctored_error((types) => (types.GhosttyCell.bits.wide.type = 'u2')),
			'GhosttyCell.wide is u2, not GhosttyCellWide'
		);
	});

	test('an enum value that can’t fit the bit field it’s read from fails at construction', async () => {
		assert.include(
			await doctored_error((types) => (types.GhosttyCellContentTag.values.CODEPOINT = 5)),
			"GhosttyCellContentTag.CODEPOINT is 5, which doesn't fit the 2-bit field"
		);
		assert.include(
			await doctored_error((types) => (types.GhosttyCellWide.values.SPACER_HEAD = -1)),
			"GhosttyCellWide.SPACER_HEAD is -1, which doesn't fit"
		);
		assert.include(
			await doctored_error((types) => (types.GhosttySgrUnderline.values.DASHED = 8)),
			"GhosttySgrUnderline.DASHED is 8, which doesn't fit the 3-bit field"
		);
	});

	test('with the fast path’s zero values not plain, no cell takes it', async () => {
		// the manifest swaps the content tags, so a zero tag means a grapheme:
		// every cell is decoded in full, by the manifest's values
		const vt = await load_doctored_ghostty_vt((manifest) => {
			const tags = manifest.types.GhosttyCellContentTag.values;
			[tags.CODEPOINT, tags.CODEPOINT_GRAPHEME] = [tags.CODEPOINT_GRAPHEME, tags.CODEPOINT];
		});
		assert.isFalse(vt.resolve(resolve_ghostty_render_constants).plain);
		const { terminal, frame } = await create(4, 1, vt);
		frame.update();
		// an all-zero cell is a blank grapheme by this manifest, so it isn't trimmed as plain
		assert.deepEqual(describe_runs(frame.rows[0]!), ['0+4 "    "']);
		terminal.dispose();
	});

	test('a reshaped struct or key fails at construction, naming it', async () => {
		assert.include(
			await doctored_error((types) => (types.GhosttyRenderStateCursor.fields.visible.size = 2)),
			'GhosttyRenderStateCursor.visible'
		);
		assert.include(
			await doctored_error((types) => (types.GhosttyStyleFlags.bits.bold.width = 2)),
			'GhosttyStyleFlags.bold'
		);
		assert.include(
			await doctored_error(
				(types) => (types.GhosttyRenderStateRowData.keys.ID.type = 'GhosttyRenderStateRowSelection')
			),
			'GhosttyRenderStateRowData.ID gives GhosttyRenderStateRowSelection'
		);
		assert.include(
			await doctored_error((types) => delete types.GhosttySgrUnderline.values.CURLY),
			'GhosttySgrUnderline.CURLY'
		);
	});
});

describe('the style id 0 the reader takes for the default style', () => {
	test('an unstyled cell has style id 0, and the library reads it as the default', async () => {
		// the fast path reads a cell whose style id is 0 without asking for its
		// style; this holds the library to it
		const { vt, terminal } = await create(20, 2);
		terminal.write(`a${ESC}[1mb${RESET}c`);
		const { exports, memory } = vt;
		const state = memory.with_opaque((slot) => {
			vt.check(exports.ghostty_render_state_new(0, slot), 'new');
			return memory.take_opaque(slot);
		});
		const iterator = memory.with_opaque((slot) => {
			vt.check(exports.ghostty_render_state_row_iterator_new(0, slot), 'new');
			return memory.take_opaque(slot);
		});
		const cells = memory.with_opaque((slot) => {
			vt.check(exports.ghostty_render_state_row_cells_new(0, slot), 'new');
			return memory.take_opaque(slot);
		});
		vt.check(exports.ghostty_render_state_update(state, terminal.handle('test')), 'update');
		const m = vt.manifest;
		const style_id_bits = m.packed_bits('GhosttyCell', ['style_id']);
		const style_ids: Array<number> = [];
		const default_styles: Array<boolean> = [];
		memory.with_scratch(64, (out) => {
			memory.view().setUint32(out, iterator, true);
			vt.check(
				exports.ghostty_render_state_get(
					state,
					m.enum_value('GhosttyRenderStateData', 'ROW_ITERATOR'),
					out
				),
				'get'
			);
			assert.strictEqual(exports.ghostty_render_state_row_iterator_next(iterator), 1);
			// fill the cells handle for the row: one key, its out pointer at the handle's slot
			const view = memory.view();
			view.setUint32(out, cells, true);
			view.setInt32(out + 32, m.enum_value('GhosttyRenderStateRowData', 'CELLS'), true);
			view.setUint32(out + 40, out, true);
			vt.check(
				exports.ghostty_render_state_row_get_multi(iterator, 1, out + 32, out + 40, 0),
				'row_get_multi(CELLS)'
			);
			for (let x = 0; x < 3; x++) {
				vt.check(exports.ghostty_render_state_row_cells_select(cells, x), 'select');
				vt.check(
					exports.ghostty_render_state_row_cells_get(
						cells,
						m.enum_value('GhosttyRenderStateRowCellsData', 'RAW'),
						out + 8
					),
					'raw'
				);
				const view = memory.view();
				const lo = view.getUint32(out + 8, true);
				const hi = view.getUint32(out + 12, true);
				const raw = (BigInt(hi) << 32n) | BigInt(lo);
				style_ids.push(
					Number((raw >> BigInt(style_id_bits.lsb)) & ((1n << BigInt(style_id_bits.width)) - 1n))
				);
				vt.check(
					exports.ghostty_render_state_row_cells_get(
						cells,
						m.enum_value('GhosttyRenderStateRowCellsData', 'STYLE'),
						out + 16
					),
					'style'
				);
				const bytes = memory.bytes().subarray(out + 16, out + 32);
				default_styles.push(bytes.every((byte) => byte === 0));
			}
		});
		assert.strictEqual(style_ids[0], 0);
		assert.notStrictEqual(style_ids[1], 0);
		assert.strictEqual(style_ids[2], 0);
		assert.deepEqual(default_styles, [true, false, true]);
		exports.ghostty_render_state_row_cells_free(cells);
		exports.ghostty_render_state_row_iterator_free(iterator);
		exports.ghostty_render_state_free(state);
		terminal.dispose();
	});
});
