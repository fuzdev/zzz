import { test, describe, assert } from 'vitest';

import {
	FUZ_TERMINAL_MIN_COLS,
	FUZ_TERMINAL_MIN_ROWS,
	fuz_terminal_size_equals,
	split_fuz_terminal_runs,
	to_fuz_terminal_cursor_box,
	to_fuz_terminal_size
} from '#lib/fuz_terminal/fuz_terminal_layout.ts';
import {
	GHOSTTY_RENDER_DEFAULT_STYLE,
	type GhosttyRenderCursor,
	type GhosttyRenderRow,
	type GhosttyRenderRun
} from '#lib/fuz_terminal/ghostty_render_frame.ts';
import { GHOSTTY_TERMINAL_MAX_SIZE } from '#lib/fuz_terminal/ghostty_terminal.ts';

const run = (
	x: number,
	text: string,
	overrides: Partial<GhosttyRenderRun> = {}
): GhosttyRenderRun => ({
	x,
	width: Array.from(text).length,
	text,
	cluster: false,
	style: GHOSTTY_RENDER_DEFAULT_STYLE,
	hyperlink: false,
	...overrides
});

describe('to_fuz_terminal_size', () => {
	test('whole cells each way', () => {
		assert.deepEqual(
			to_fuz_terminal_size({ width: 805, height: 400, cell_width: 8, cell_height: 16.5 }),
			{ cols: 100, rows: 24 }
		);
	});

	test('a box an exact multiple of a fractional cell gets every cell', () => {
		assert.deepEqual(
			to_fuz_terminal_size({
				width: 10 * 8.4,
				height: 3 * 16.8,
				cell_width: 8.4,
				cell_height: 16.8
			}),
			{ cols: 10, rows: 3 }
		);
	});

	test('clamped to the minimum and to GHOSTTY_TERMINAL_MAX_SIZE', () => {
		assert.deepEqual(
			to_fuz_terminal_size({ width: 3, height: 3, cell_width: 8, cell_height: 16 }),
			{
				cols: FUZ_TERMINAL_MIN_COLS,
				rows: FUZ_TERMINAL_MIN_ROWS
			}
		);
		assert.deepEqual(
			to_fuz_terminal_size({ width: 1e9, height: 1e9, cell_width: 0.001, cell_height: 0.001 }),
			{ cols: GHOSTTY_TERMINAL_MAX_SIZE, rows: GHOSTTY_TERMINAL_MAX_SIZE }
		);
	});

	test('anything unmeasurable is null, never a size', () => {
		const ok = { width: 800, height: 400, cell_width: 8, cell_height: 16 };
		for (const key of ['width', 'height', 'cell_width', 'cell_height'] as const) {
			for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
				assert.isNull(to_fuz_terminal_size({ ...ok, [key]: bad }), `${key} ${bad}`);
			}
		}
	});

	test('size equality', () => {
		assert.isTrue(fuz_terminal_size_equals({ cols: 1, rows: 2 }, { cols: 1, rows: 2 }));
		assert.isFalse(fuz_terminal_size_equals({ cols: 1, rows: 2 }, { cols: 2, rows: 2 }));
		assert.isFalse(fuz_terminal_size_equals({ cols: 1, rows: 2 }, { cols: 1, rows: 3 }));
		assert.isFalse(fuz_terminal_size_equals(null, { cols: 1, rows: 2 }));
		assert.isTrue(fuz_terminal_size_equals(null, null));
	});
});

describe('split_fuz_terminal_runs', () => {
	test('ASCII runs and clusters come back as the same array', () => {
		const runs = [run(0, 'hello '), run(6, '漢', { width: 2, cluster: true }), run(8, 'x')];
		assert.strictEqual(split_fuz_terminal_runs(runs), runs);
		const empty: Array<GhosttyRenderRun> = [];
		assert.strictEqual(split_fuz_terminal_runs(empty), empty);
	});

	test('a run splits where its text moves between ASCII and anything else', () => {
		const bold = { ...GHOSTTY_RENDER_DEFAULT_STYLE, key: 'bold', bold: true };
		const first = run(0, 'ab');
		const mixed = run(2, 'xé─┼y𝐀z', { style: bold, hyperlink: true });
		const last = run(10, 'end');
		const split = split_fuz_terminal_runs([first, mixed, last]);
		assert.deepEqual(
			split.map((r) => [r.x, r.width, r.text]),
			[
				[0, 2, 'ab'],
				[2, 1, 'x'],
				[3, 3, 'é─┼'],
				[6, 1, 'y'],
				// an astral code point is one cell, though two UTF-16 units
				[7, 1, '𝐀'],
				[8, 1, 'z'],
				[10, 3, 'end']
			]
		);
		// the pieces keep the run's style and hyperlink, and the untouched runs are themselves
		for (const piece of split.slice(1, 6)) {
			assert.strictEqual(piece.style, bold);
			assert.isTrue(piece.hyperlink);
			assert.isFalse(piece.cluster);
		}
		assert.strictEqual(split[0], first);
		assert.strictEqual(split[6], last);
	});

	test('a run wholly non-ASCII is one piece', () => {
		const runs = [run(0, '────')];
		const split = split_fuz_terminal_runs(runs);
		assert.notStrictEqual(split, runs);
		assert.deepEqual(
			split.map((r) => [r.x, r.width, r.text]),
			[[0, 4, '────']]
		);
	});
});

describe('to_fuz_terminal_cursor_box', () => {
	const cursor = (overrides: Partial<GhosttyRenderCursor> = {}): GhosttyRenderCursor => ({
		visible: true,
		blinking: false,
		password_input: false,
		style: 'block',
		viewport: { x: 1, y: 0, wide_tail: false },
		...overrides
	});
	const rows: Array<GhosttyRenderRow> = [
		{ id: 'a', runs: [run(0, 'abc'), run(3, '漢', { width: 2, cluster: true }), run(5, 'é')] },
		{ id: 'b', runs: [] }
	];

	test('on a narrow cell: that cell, its text', () => {
		assert.deepEqual(to_fuz_terminal_cursor_box(cursor(), rows, true), {
			x: 1,
			y: 0,
			width: 1,
			shape: 'block',
			blinking: false,
			text: 'b'
		});
		assert.strictEqual(
			to_fuz_terminal_cursor_box(cursor({ viewport: { x: 5, y: 0, wide_tail: false } }), rows, true)
				?.text,
			'é'
		);
	});

	test('past the row’s runs, or on a blank row: a blank cell', () => {
		const box = to_fuz_terminal_cursor_box(
			cursor({ viewport: { x: 9, y: 1, wide_tail: false } }),
			rows,
			true
		);
		assert.deepEqual(box && [box.x, box.y, box.width, box.text], [9, 1, 1, ' ']);
	});

	test('on a wide character, by its first cell or its tail: both columns', () => {
		for (const viewport of [
			{ x: 3, y: 0, wide_tail: false },
			{ x: 4, y: 0, wide_tail: true }
		]) {
			const box = to_fuz_terminal_cursor_box(cursor({ viewport }), rows, true);
			assert.deepEqual(box && [box.x, box.width, box.text], [3, 2, '漢'], JSON.stringify(viewport));
		}
	});

	test('over invisible text: a blank, so the block doesn’t reveal it', () => {
		const hidden = { ...GHOSTTY_RENDER_DEFAULT_STYLE, key: 'invisible', invisible: true };
		const secret: Array<GhosttyRenderRow> = [
			{ id: 's', runs: [run(0, 'pw'), run(2, 'secret', { style: hidden })] },
			{ id: 'w', runs: [run(0, '漢', { width: 2, cluster: true, style: hidden })] }
		];
		const at = (x: number, y: number): string | undefined =>
			to_fuz_terminal_cursor_box(cursor({ viewport: { x, y, wide_tail: false } }), secret, true)
				?.text;
		assert.strictEqual(at(1, 0), 'w');
		assert.strictEqual(at(3, 0), ' ');
		assert.strictEqual(at(0, 1), ' ');
	});

	test('hidden, out of the viewport, or off the frame’s rows: nothing', () => {
		assert.isNull(to_fuz_terminal_cursor_box(cursor({ visible: false }), rows, true));
		assert.isNull(to_fuz_terminal_cursor_box(cursor({ viewport: null }), rows, true));
		assert.isNull(
			to_fuz_terminal_cursor_box(cursor({ viewport: { x: 0, y: 2, wide_tail: false } }), rows, true)
		);
	});

	test('each shape; without focus a block is hollow and nothing blinks', () => {
		for (const style of ['bar', 'block', 'underline', 'block_hollow'] as const) {
			const focused = to_fuz_terminal_cursor_box(cursor({ style, blinking: true }), rows, true);
			assert.strictEqual(focused?.shape, style);
			assert.isTrue(focused?.blinking);
			const blurred = to_fuz_terminal_cursor_box(cursor({ style, blinking: true }), rows, false);
			assert.strictEqual(blurred?.shape, style === 'block' ? 'block_hollow' : style);
			assert.isFalse(blurred?.blinking);
		}
		assert.isFalse(to_fuz_terminal_cursor_box(cursor({ blinking: false }), rows, true)?.blinking);
	});
});
