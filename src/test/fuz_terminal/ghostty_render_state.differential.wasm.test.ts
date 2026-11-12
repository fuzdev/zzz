import { test, describe, assert } from 'vitest';

import type { GhosttyRenderRow } from '#lib/fuz_terminal/ghostty_render_frame.ts';
import { GhosttyRenderState } from '#lib/fuz_terminal/ghostty_render_state.ts';
import { GhosttyTerminal } from '#lib/fuz_terminal/ghostty_terminal.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

import { load_test_ghostty_vt } from './ghostty_vt_test_helpers.ts';
import { ESC, CSI, ST } from './vt_sequences.ts';

/*
 * The reader against a slow oracle: generated output, written frame by frame,
 * and after each update the reader's rows compared column by column with a
 * walk of the same frame through the library's own per-cell getters — raw
 * cell, style, and UTF-8 graphemes, one call each.
 *
 * The oracle walks its own render-state handle, made and freed inside each
 * read through the raw exports, since a terminal has one `GhosttyRenderState`.
 * An update consumes the terminal's change tracking, so the order matters:
 * the reader updates first, then the oracle reads, with no write between —
 * the reader has just consumed every change, so the oracle's update finds
 * none to take, and the reader's next update sees the same changes it would
 * with no oracle at all. The oracle's own handle is new each read, so its
 * first and only update is a full one: it never depends on change tracking.
 *
 * Zero-width marks: with grapheme clustering (mode 2027) off, the library
 * doesn't mark a row changed when a mark arriving in a later write joins a
 * cell on it (pinned in `ghostty_render_state.wasm.test.ts`), which the
 * reader can't see. So every run turns mode 2027 on, the generator never
 * turns it off, and a full reset (RIS, which turns it off) is followed by
 * turning it on again.
 */

/** A seeded generator of numbers in `[0, 1)`. */
const create_random = (seed: number): (() => number) => {
	let state = seed | 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** One column as drawn: its text, style, link, and whether it's a cluster of `width`; or covered by the wide cluster before it. */
type DrawnColumn =
	{ text: string; style: string; link: boolean; cluster: boolean; width: number } | 'covered';

interface OracleCell {
	wide: number;
	tag: number;
	link: boolean;
	style_id: number;
	text: string;
	style: string;
}

/** The oracle's walk of the current frame: every row's id and cells. */
const create_oracle = (
	vt: GhosttyVt,
	terminal: GhosttyTerminal
): { read: () => Array<{ id: string; cells: Array<OracleCell> }>; dispose: () => void } => {
	const { exports, memory, manifest } = vt;
	const e = exports as unknown as Record<string, (...args: Array<number>) => number>;
	const data = (name: string): number => manifest.enum_value('GhosttyRenderStateData', name);
	const row_data = (name: string): number => manifest.enum_value('GhosttyRenderStateRowData', name);
	const cell_data = (name: string): number =>
		manifest.enum_value('GhosttyRenderStateRowCellsData', name);
	const field = (path: Array<string>): ((raw: bigint) => number) => {
		const { lsb, width } = manifest.packed_bits('GhosttyCell', path);
		return (raw) => Number((raw >> BigInt(lsb)) & ((1n << BigInt(width)) - 1n));
	};
	const wide = field(['wide']);
	const tag = field(['content_tag']);
	const link = field(['hyperlink']);
	const style_id = field(['style_id']);
	const bg_index = field(['content', 'BG_COLOR_PALETTE', 'index']);
	const [bg_r, bg_g, bg_b] = ['r', 'g', 'b'].map((c) => field(['content', 'BG_COLOR_RGB', c]));
	const tag_bg_palette = manifest.enum_value('GhosttyCellContentTag', 'BG_COLOR_PALETTE');
	const tag_bg_rgb = manifest.enum_value('GhosttyCellContentTag', 'BG_COLOR_RGB');
	const style_fields = ['fg_color', 'bg_color', 'underline_color'].map(
		(name) => manifest.struct_field('GhosttyStyle', name).offset
	);
	const flags_offset = manifest.struct_field('GhosttyStyle', 'flags').offset;
	const scratch = memory.alloc(64);
	const text_cap = 4096;
	const text_buffer = memory.alloc(text_cap);
	const slot = scratch; // a handle's slot
	const out = scratch + 8; // 8 bytes: a raw cell, an id's first half
	const style_out = scratch + 32; // 16 bytes
	const buffer = scratch + 48; // a GhosttyBuffer: ptr, cap, len
	const handle = (create: (slot: number) => number): number => {
		vt.check(create(slot), 'oracle create');
		return memory.view().getUint32(slot, true);
	};
	const iterator = handle((s) => e.ghostty_render_state_row_iterator_new!(0, s));
	const cells = handle((s) => e.ghostty_render_state_row_cells_new!(0, s));
	const decoder = new TextDecoder();
	const read = (): Array<{ id: string; cells: Array<OracleCell> }> => {
		const state = handle((s) => e.ghostty_render_state_new!(0, s));
		try {
			vt.check(e.ghostty_render_state_update!(state, terminal.handle('oracle')), 'oracle update');
			memory.view().setUint32(slot, iterator, true);
			vt.check(e.ghostty_render_state_get!(state, data('ROW_ITERATOR'), slot), 'oracle iterator');
			const rows: Array<{ id: string; cells: Array<OracleCell> }> = [];
			while (e.ghostty_render_state_row_iterator_next!(iterator)) {
				vt.check(e.ghostty_render_state_row_get!(iterator, row_data('ID'), scratch + 16), 'id');
				const v = memory.view();
				const id = [0, 4, 8, 12].map((o) => v.getUint32(scratch + 16 + o, true)).join('.');
				memory.view().setUint32(slot, cells, true);
				vt.check(e.ghostty_render_state_row_get!(iterator, row_data('CELLS'), slot), 'cells');
				const row: Array<OracleCell> = [];
				while (e.ghostty_render_state_row_cells_next!(cells)) {
					vt.check(e.ghostty_render_state_row_cells_get!(cells, cell_data('RAW'), out), 'raw');
					const raw = memory.view().getBigUint64(out, true);
					const bv = memory.view();
					bv.setUint32(buffer, text_buffer, true);
					bv.setUint32(buffer + 4, text_cap, true);
					bv.setUint32(buffer + 8, 0, true);
					vt.check(
						e.ghostty_render_state_row_cells_get!(cells, cell_data('GRAPHEMES_UTF8'), buffer),
						'utf8'
					);
					const len = memory.view().getUint32(buffer + 8, true);
					const text = decoder.decode(memory.bytes().slice(text_buffer, text_buffer + len));
					vt.check(
						e.ghostty_render_state_row_cells_get!(cells, cell_data('STYLE'), style_out),
						'style'
					);
					const b = memory.bytes();
					const color = (at: number): string => {
						const t = b[at];
						if (t === 0) return 'n';
						if (t === 1) return `p${b[at + 1]}`;
						return `r${((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!).toString(16)}`;
					};
					const [fg, bg, ul] = style_fields.map((o) => color(style_out + o));
					const flags =
						(b[style_out + flags_offset]! | (b[style_out + flags_offset + 1]! << 8)) & 0x7ff;
					const cell_tag = tag(raw);
					const cell_bg =
						cell_tag === tag_bg_palette
							? `p${bg_index(raw)}`
							: cell_tag === tag_bg_rgb
								? `r${((bg_r!(raw) << 16) | (bg_g!(raw) << 8) | bg_b!(raw)).toString(16)}`
								: bg;
					row.push({
						wide: wide(raw),
						tag: cell_tag,
						link: link(raw) !== 0,
						style_id: style_id(raw),
						text,
						style: `${fg}|${cell_bg}|${ul}|${flags}`
					});
				}
				rows.push({ id, cells: row });
			}
			return rows;
		} finally {
			e.ghostty_render_state_free!(state);
		}
	};
	const dispose = (): void => {
		e.ghostty_render_state_row_cells_free!(cells);
		e.ghostty_render_state_row_iterator_free!(iterator);
		memory.free(text_buffer, text_cap);
		memory.free(scratch, 64);
	};
	return { read, dispose };
};

/** A string's code points, each as a string — a grapheme's marks apart from its base. */
const to_code_points = (text: string): Array<string> => {
	const code_points: Array<string> = [];
	for (const code_point of text) code_points.push(code_point);
	return code_points;
};

/** What the oracle's cells should draw: the columns up to the last that draws anything. */
const expect_columns = (vt: GhosttyVt, cells: Array<OracleCell>): Array<DrawnColumn> => {
	const m = vt.manifest;
	const narrow = m.enum_value('GhosttyCellWide', 'NARROW');
	const wide = m.enum_value('GhosttyCellWide', 'WIDE');
	const tail = m.enum_value('GhosttyCellWide', 'SPACER_TAIL');
	const head = m.enum_value('GhosttyCellWide', 'SPACER_HEAD');
	const codepoint = m.enum_value('GhosttyCellContentTag', 'CODEPOINT');
	const columns: Array<DrawnColumn> = [];
	for (let x = 0; x < cells.length; x++) {
		const c = cells[x]!;
		const before = cells[x - 1];
		if (c.wide === tail && before?.wide === wide && before.text !== '') {
			columns.push('covered');
			continue;
		}
		const text =
			c.tag !== codepoint && c.tag !== m.enum_value('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME')
				? ' '
				: c.text === ''
					? ' '
					: c.text;
		const cluster = (c.wide === wide && c.text !== '') || to_code_points(text).length > 1;
		columns.push({
			text,
			style: c.style,
			link: c.link,
			cluster,
			width: cluster && c.wide === wide ? 2 : 1
		});
	}
	const blank = (c: OracleCell): boolean =>
		c.tag === codepoint && c.style_id === 0 && !c.link && (c.text === '' || c.text === ' ');
	let end = cells.length;
	// an unstyled spacer head in the last column draws nothing
	if (end > 0 && cells[end - 1]!.wide === head && blank(cells[end - 1]!)) end--;
	while (end > 0 && cells[end - 1]!.wide === narrow && blank(cells[end - 1]!)) end--;
	return columns.slice(0, end);
};

/** The reader's row as columns, with any shape problem it has. */
const drawn_columns = (row: GhosttyRenderRow, problems: Array<string>): Array<DrawnColumn> => {
	const color = (
		c: { kind: 'palette'; index: number } | { kind: 'rgb'; rgb: number } | null
	): string => (c === null ? 'n' : c.kind === 'palette' ? `p${c.index}` : `r${c.rgb.toString(16)}`);
	const underlines = ['none', 'single', 'double', 'curly', 'dotted', 'dashed'];
	const columns: Array<DrawnColumn> = [];
	let x = 0;
	for (const run of row.runs) {
		if (run.x !== x) problems.push(`a run at ${run.x}, after one ending at ${x}`);
		const s = run.style;
		const flags =
			(s.bold ? 1 : 0) |
			(s.italic ? 2 : 0) |
			(s.faint ? 4 : 0) |
			(s.blink ? 8 : 0) |
			(s.inverse ? 16 : 0) |
			(s.invisible ? 32 : 0) |
			(s.strikethrough ? 64 : 0) |
			(s.overline ? 128 : 0) |
			(underlines.indexOf(s.underline) << 8);
		const style = `${color(s.fg)}|${color(s.bg)}|${color(s.underline_color)}|${flags}`;
		if (run.cluster) {
			columns.push({ text: run.text, style, link: run.hyperlink, cluster: true, width: run.width });
			if (run.width === 2) columns.push('covered');
		} else {
			const code_points = to_code_points(run.text);
			if (code_points.length !== run.width) {
				problems.push(`a run of ${code_points.length} code points covering ${run.width} columns`);
			}
			for (const text of code_points) {
				columns.push({ text, style, link: run.hyperlink, cluster: false, width: 1 });
			}
		}
		x = run.x + run.width;
	}
	return columns;
};

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789 .,;:!?-_=+*/()[]{}<>~';
const SGRS = [
	'0',
	'1',
	'2',
	'3',
	'4',
	'5',
	'7',
	'8',
	'9',
	'53',
	'4:0',
	'4:1',
	'4:2',
	'4:3',
	'4:4',
	'4:5',
	'21',
	'22',
	'23',
	'24',
	'25',
	'27',
	'28',
	'29',
	'55',
	'39',
	'49',
	'59'
];
// wide characters, emoji, flags, graphemes with their marks, and zero-width
// marks on their own, which join the cell before them (tracked, with mode 2027 on)
const GLYPHS = [
	'中',
	'文字',
	'😀',
	'👍🏽',
	'👨‍👩‍👧',
	'🇺🇸',
	'é',
	'à́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔',
	'𝐀',
	'ｱ',
	'❤️',
	'☃',
	'한',
	'x⃝',
	'\u200b',
	'\u0301',
	'\ufe0f',
	'\u200d'
];
/** Modes toggled by the output: never 2027 (see the file comment). */
const MODES = ['6', '7', '1049', '47', '1047', '5'];

/** One frame's output. */
const generate = (random: () => number, cols: number, rows: number): string => {
	const int = (n: number): number => Math.floor(random() * n);
	const pick = <T>(items: ReadonlyArray<T>): T => items[int(items.length)]!;
	let out = '';
	const pieces = 1 + int(12);
	for (let i = 0; i < pieces; i++) {
		const k = int(30);
		if (k < 6) {
			const len = int(cols * 2);
			for (let j = 0; j < len; j++) out += ASCII[int(ASCII.length)];
		} else if (k < 10) {
			const p = int(8);
			const sgr =
				p === 0
					? `38;5;${int(256)}`
					: p === 1
						? `48;5;${int(256)}`
						: p === 2
							? `38;2;${int(256)};${int(256)};${int(256)}`
							: p === 3
								? `48;2;${int(256)};${int(256)};${int(256)}`
								: p === 4
									? `58;5;${int(256)}`
									: p === 5
										? `58:2::${int(256)}:${int(256)}:${int(256)}`
										: p === 6
											? `${30 + int(8)};${40 + int(8)}`
											: pick(SGRS);
			out += `${CSI}${sgr}m`;
		} else if (k < 13) {
			const n = int(4);
			for (let j = 0; j <= n; j++) out += pick(GLYPHS);
		} else if (k === 13) out += pick(['\r\n', '\n', '\r', '\t', '\b', '\r\n\r\n']);
		else if (k === 14) out += `${CSI}${pick(['', '1', '2'])}K`;
		else if (k === 15) out += `${CSI}${pick(['', '1', '2', '3'])}J`;
		else if (k === 16) out += `${CSI}${1 + int(cols)}X`;
		else if (k === 17) out += `${CSI}${1 + int(4)}${pick(['L', 'M', '@', 'P', 'S', 'T'])}`;
		else if (k === 18) {
			const top = 1 + int(rows);
			out += `${CSI}${top};${top + int(rows - top + 1)}r`;
		} else if (k === 19) out += `${CSI}${1 + int(rows)};${1 + int(cols + 1)}H`;
		else if (k === 20) out += `${CSI}?${pick(MODES)}${pick(['h', 'l'])}`;
		else if (k === 21) out += random() < 0.2 ? `${ESC}c${CSI}?2027h` : `${ESC}#8`;
		else if (k === 22)
			out += random() < 0.5 ? `${ESC}]8;;http://e/${int(5)}${ST}` : `${ESC}]8;;${ST}`;
		else if (k === 23) out += pick([`${ESC}V`, `${ESC}W`, `${CSI}1"q`, `${CSI}0"q`]);
		else if (k === 24) out += `${ESC}]4;${int(256)};rgb:${int(256).toString(16)}/00/ff${ST}`;
		else if (k === 25)
			out += pick([
				`${ESC}]10;rgb:12/34/56${ST}`,
				`${ESC}]11;rgb:65/43/21${ST}`,
				`${ESC}]104${ST}`
			]);
		else if (k === 26) out += `${CSI}${1 + int(cols)}G${pick(GLYPHS)}`;
		else if (k === 27) out += `${CSI}${int(7)} q`;
		else if (k === 28) out += `${CSI}${pick(['?25l', '?25h', '?12h', '?12l'])}`;
		else out += `${CSI}${cols}G${pick(['中', '😀', 'x'])}${pick(['中', 'y'])}`;
	}
	return out;
};

/** Run one seed's frames, returning the first problems found, each naming the seed and frame. */
const run_seed = async (seed: number, frames: number): Promise<Array<string>> => {
	const random = create_random(seed);
	const vt = await load_test_ghostty_vt();
	let cols = 4 + Math.floor(random() * 40);
	let rows = 2 + Math.floor(random() * 12);
	const terminal = new GhosttyTerminal(vt, {
		cols,
		rows,
		scrollback_max_lines: Math.floor(random() * 50)
	});
	terminal.write(`${CSI}?2027h`);
	const reader = new GhosttyRenderState(terminal);
	const oracle = create_oracle(vt, terminal);
	const problems: Array<string> = [];
	// what each id last drew, and the object it drew with
	const last = new Map<string, { row: GhosttyRenderRow; drawn: string }>();
	let previous_rows: ReadonlyArray<GhosttyRenderRow> | null = null;
	for (let f = 0; f < frames && problems.length === 0; f++) {
		const at = `seed ${seed} frame ${f}`;
		const output = generate(random, cols, rows);
		if (random() < 0.05) {
			cols = 2 + Math.floor(random() * 40);
			rows = 1 + Math.floor(random() * 12);
			terminal.resize({ cols, rows });
		}
		// sometimes only part of the output, as a write split across frames would
		terminal.write(random() < 0.15 ? output.slice(0, output.length >> 1) : output);
		// the reader first, then the oracle, with no write between
		const dirty = reader.update();
		if (random() < 0.7) reader.clean();
		const expected = oracle.read();
		const got = reader.rows;
		if (previous_rows !== null && (dirty === 'clean') !== (got === previous_rows)) {
			problems.push(
				`${at}: a ${dirty} update ${got === previous_rows ? 'kept' : 'replaced'} the rows array`
			);
		}
		previous_rows = got;
		if (got.length !== expected.length) {
			problems.push(`${at}: ${got.length} rows, the oracle ${expected.length}`);
			break;
		}
		if (reader.cols !== cols) problems.push(`${at}: ${reader.cols} columns, not ${cols}`);
		const ids = new Set<string>();
		for (let y = 0; y < got.length; y++) {
			const row = got[y]!;
			if (ids.has(row.id)) problems.push(`${at} row ${y}: the id ${row.id} twice`);
			ids.add(row.id);
			if (row.id !== expected[y]!.id)
				problems.push(`${at} row ${y}: id ${row.id}, the oracle ${expected[y]!.id}`);
			const shape: Array<string> = [];
			const drawn = JSON.stringify(drawn_columns(row, shape));
			const want = JSON.stringify(expect_columns(vt, expected[y]!.cells));
			for (const problem of shape) problems.push(`${at} row ${y}: ${problem}`);
			if (drawn !== want) {
				problems.push(
					`${at} row ${y} (${dirty}): drew ${drawn.slice(0, 300)}, the oracle ${want.slice(0, 300)}; the output was ${JSON.stringify(output)}`
				);
			}
			const before = last.get(row.id);
			if (before?.row === row && before.drawn !== want) {
				problems.push(`${at} row ${y}: the object kept for id ${row.id} drew something else`);
			}
			last.set(row.id, { row, drawn: want });
		}
	}
	oracle.dispose();
	reader.dispose();
	terminal.dispose();
	return problems;
};

describe('the reader against the library’s per-cell getters', () => {
	test('generated output, frame by frame, draws what the oracle reads', async () => {
		const failures: Array<string> = [];
		for (let seed = 1; seed <= 50; seed++) {
			const problems = await run_seed(seed, 30);
			failures.push(...problems.slice(0, 3));
		}
		assert.deepEqual(failures, []);
	});
});
