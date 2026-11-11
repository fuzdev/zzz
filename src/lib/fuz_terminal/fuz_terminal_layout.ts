/**
 * The DOM renderer's geometry — pure functions over plain frame data and
 * measurements, no DOM: the terminal's size in cells from its box, the
 * pieces a row's runs are drawn as, and where the cursor goes.
 *
 * @module
 */

import type {
	GhosttyRenderCursor,
	GhosttyRenderCursorStyle,
	GhosttyRenderRow,
	GhosttyRenderRun
} from './ghostty_render_state.ts';
import { GHOSTTY_TERMINAL_MAX_SIZE } from './ghostty_terminal.ts';

/** The narrowest a terminal view makes its terminal, in cells. */
export const FUZ_TERMINAL_MIN_COLS = 2;
/** The shortest a terminal view makes its terminal, in cells. */
export const FUZ_TERMINAL_MIN_ROWS = 1;

/** A terminal's size in cells. */
export interface FuzTerminalSize {
	readonly cols: number;
	readonly rows: number;
}

/** A terminal view's box and one cell of its font, in CSS pixels. */
export interface FuzTerminalMeasurement {
	/** The box's width — the area the rows fill. */
	readonly width: number;
	/** The box's height. */
	readonly height: number;
	/** One cell's width: the font's advance, `1ch`. */
	readonly cell_width: number;
	/** One cell's height: a row's height. */
	readonly cell_height: number;
}

/** Whether a length is usable to divide by or into: finite and positive. */
const is_length = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * Floors a quotient, forgiving the float error of a box that's an exact
 * multiple of a fractional cell (`10 * 8.4` is `84.00000000000001`).
 */
const floor_cells = (length: number, cell: number): number => Math.floor(length / cell + 1e-6);

/**
 * How many cells fit a box: as many whole cells as fit each way, clamped to
 * `FUZ_TERMINAL_MIN_COLS` / `FUZ_TERMINAL_MIN_ROWS` and
 * `GHOSTTY_TERMINAL_MAX_SIZE`.
 *
 * @returns the size, or `null` when anything is zero, negative, or not a
 *   finite number — a view not laid out yet, hidden (`display: none`), or
 *   without layout at all — which must never resize the terminal
 */
export const to_fuz_terminal_size = (
	measurement: FuzTerminalMeasurement
): FuzTerminalSize | null => {
	const { width, height, cell_width, cell_height } = measurement;
	if (
		!is_length(width) ||
		!is_length(height) ||
		!is_length(cell_width) ||
		!is_length(cell_height)
	) {
		return null;
	}
	const clamp = (cells: number, min: number): number =>
		Math.min(GHOSTTY_TERMINAL_MAX_SIZE, Math.max(min, cells));
	return {
		cols: clamp(floor_cells(width, cell_width), FUZ_TERMINAL_MIN_COLS),
		rows: clamp(floor_cells(height, cell_height), FUZ_TERMINAL_MIN_ROWS)
	};
};

/** Whether two sizes are the same, `null` meaning none. */
export const fuz_terminal_size_equals = (
	a: FuzTerminalSize | null,
	b: FuzTerminalSize | null
): boolean => (a === null || b === null ? a === b : a.cols === b.cols && a.rows === b.rows);

/** Text that's only ASCII, which the terminal's own monospace font is trusted to draw. */
const ASCII_TEXT = /^[\0-\x7f]*$/;

/**
 * A row's runs as the pieces they're drawn as, each boxed to its columns:
 * a run is split where its text moves between ASCII and anything else.
 *
 * A run's box keeps what follows it in place, whatever its glyphs measure.
 * Within a run, a code point the monospace font lacks is drawn from a
 * fallback font whose advance needn't be a cell, shifting the rest of the
 * run. Splitting at those boundaries confines the shift to a stretch of
 * such code points: the ASCII after them starts back on its column. A
 * `cluster` run (a wide character, a multi-code-point grapheme) is one
 * piece, boxed to its width.
 *
 * @returns `runs` itself when nothing splits — the common case allocates
 *   nothing — else new runs in column order, each with its own `x`, `width`,
 *   and `text`, the style and hyperlink of the run it came from
 */
// TODO: a stretch of fallback glyphs (braille graphs, box drawing in a font
// without it, icon fonts) still shifts within itself; boxing each such code
// point to a cell is the next step if a browser shows it mattering
export const split_fuz_terminal_runs = (
	runs: ReadonlyArray<GhosttyRenderRun>
): ReadonlyArray<GhosttyRenderRun> => {
	let split: Array<GhosttyRenderRun> | null = null;
	for (let i = 0; i < runs.length; i++) {
		const run = runs[i]!;
		if (run.cluster || ASCII_TEXT.test(run.text)) {
			split?.push(run);
			continue;
		}
		split ??= runs.slice(0, i);
		let x = run.x;
		let text = '';
		let width = 0;
		let ascii: boolean | null = null;
		const flush = (): void => {
			if (width === 0) return;
			split!.push({ ...run, x, width, text });
			x += width;
			text = '';
			width = 0;
		};
		for (const code_point of run.text) {
			const is_ascii = code_point.charCodeAt(0) < 0x80;
			if (ascii !== null && is_ascii !== ascii) flush();
			ascii = is_ascii;
			text += code_point;
			width++;
		}
		flush();
	}
	return split ?? runs;
};

/** Where and how to draw the cursor, in cells of the viewport. */
export interface FuzTerminalCursorBox {
	/** The first column it covers. */
	readonly x: number;
	/** Its row: an index into the frame's rows. */
	readonly y: number;
	/** How many columns it covers: 2 over a wide character. */
	readonly width: number;
	/** Its shape — a block drawn hollow when the view doesn't have focus. */
	readonly shape: GhosttyRenderCursorStyle;
	readonly blinking: boolean;
	/**
	 * The text of the cell under it, which a block cursor draws in the
	 * background color: a space for a blank or invisible cell.
	 */
	readonly text: string;
}

/**
 * The cursor's box, or `null` when nothing is drawn: the program hid it,
 * it's out of the viewport, or its row isn't in the frame. Over a wide
 * character — on its first cell, or its second (`wide_tail`) — it covers
 * both columns. Without focus a block is hollow and nothing blinks.
 */
export const to_fuz_terminal_cursor_box = (
	cursor: GhosttyRenderCursor,
	rows: ReadonlyArray<GhosttyRenderRow>,
	focused: boolean
): FuzTerminalCursorBox | null => {
	const viewport = cursor.viewport;
	if (!cursor.visible || viewport === null) return null;
	const row = rows[viewport.y];
	if (row === undefined) return null;
	let x = viewport.wide_tail ? Math.max(0, viewport.x - 1) : viewport.x;
	let width = viewport.wide_tail ? 2 : 1;
	let text = ' ';
	for (const run of row.runs) {
		if (x < run.x || x >= run.x + run.width) continue;
		if (run.cluster) {
			x = run.x;
			width = run.width;
			text = run.text;
		} else {
			text = Array.from(run.text)[x - run.x] ?? ' ';
		}
		// invisible text (SGR 8) stays hidden under a block cursor
		if (run.style.invisible) text = ' ';
		break;
	}
	return {
		x,
		y: viewport.y,
		width,
		shape: !focused && cursor.style === 'block' ? 'block_hollow' : cursor.style,
		blinking: cursor.blinking && focused,
		text
	};
};
