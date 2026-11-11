/**
 * The render-state reader: a terminal's screen as plain frame data a
 * renderer draws — the rows in order, each a list of styled runs of text
 * placed on their columns, the cursor, and the colors.
 *
 * A `GhosttyRenderState` is libghostty-vt's render state — a copy of what
 * one frame needs, updated in place and tracking what changed — read into JS
 * values once per update. The renderer calls `GhosttyRenderState.update` once
 * per animation frame, draws what changed, and calls
 * `GhosttyRenderState.clean`. Everything it reads is plain data with no
 * reference into wasm memory, and is never mutated: a value that changes is
 * replaced, so comparing references tells a renderer what to redraw.
 *
 * No DOM here: turning a run's style into CSS, boxing wide characters, and
 * drawing the cursor are the renderer's.
 *
 * @module
 */

import { GhosttyDisposedError, GhosttyLoadError, GhosttyManifestError } from './ghostty_errors.ts';
import {
	read_ghostty_bits,
	to_ghostty_bit_reader,
	type GhosttyBitReader,
	type GhosttyManifest,
	type GhosttyManifestBits
} from './ghostty_manifest.ts';
import { GHOSTTY_HOST_LITTLE_ENDIAN } from './ghostty_memory.ts';
import type { GhosttyTerminal, GhosttyTerminalDependent } from './ghostty_terminal.ts';
import type { GhosttyVt } from './ghostty_vt.ts';

/**
 * What an update found changed since the render state was last cleaned:
 * nothing (`clean`), some rows (`partial`), or everything (`full` — the first
 * update, a resize, a scroll, a screen switch, a palette change).
 *
 * The cursor and the default colors aren't part of it: a cursor shape or a
 * default color can change on a `clean` update. Compare
 * `GhosttyRenderState.cursor` and `GhosttyRenderState.colors` by reference.
 */
export type GhosttyRenderDirty = 'clean' | 'partial' | 'full';

/**
 * A color a style sets: an index into the palette (`GhosttyRenderColors.palette`),
 * or a direct `0xRRGGBB` value. A style's `null` color is the default — the
 * terminal's foreground or background, or for an underline, the text color.
 *
 * Palette colors stay indices, so a palette change (OSC 4) recolors without
 * changing any run, and a renderer can apply its own policy (bold text in
 * bright colors).
 */
export type GhosttyRenderColor =
	| { readonly kind: 'palette'; readonly index: number }
	| { readonly kind: 'rgb'; readonly rgb: number };

/** An underline's kind (SGR 4 and its subparameters). */
export type GhosttyRenderUnderline = 'none' | 'single' | 'double' | 'curly' | 'dotted' | 'dashed';

/**
 * How a run of cells looks. Equal styles have the same `key`; within one
 * reader they're the same object while the style is read in consecutive
 * updates that read rows (a row kept unchanged doesn't count as a read);
 * one that goes unread for such an update is let go, and a later equal one
 * is a new object with the same key — so compare keys. Derive CSS from it
 * and cache that by `key`.
 */
export interface GhosttyRenderStyle {
	/** Equal for equal styles, from any reader, across frames. */
	readonly key: string;
	/** The text color; `null` is the default foreground. */
	readonly fg: GhosttyRenderColor | null;
	/** The background; `null` is the default background (draw nothing). */
	readonly bg: GhosttyRenderColor | null;
	/** The underline's color; `null` is the text color. */
	readonly underline_color: GhosttyRenderColor | null;
	readonly bold: boolean;
	readonly italic: boolean;
	readonly faint: boolean;
	readonly blink: boolean;
	/** Draw with the foreground and background swapped — after resolving defaults. */
	readonly inverse: boolean;
	/** Draw the background only. */
	readonly invisible: boolean;
	readonly strikethrough: boolean;
	readonly overline: boolean;
	readonly underline: GhosttyRenderUnderline;
}

/**
 * Consecutive cells of a row drawn as one piece: they share a style and
 * whether they're a hyperlink.
 *
 * A run is placed without measuring text. It starts at column `x` and covers
 * `width` columns. When `cluster` is `false`, every code point of `text` is
 * one narrow cell, in order — `width` of them; a blank cell is a space. When
 * `cluster` is `true`, `text` is one grapheme cluster — a wide character
 * (`width` 2; its second cell, the spacer, has no text of its own) or a
 * character with combining marks or joiners, such as an accented letter or a
 * ZWJ emoji sequence — to be drawn boxed to `width` columns, since a font's
 * glyph for it needn't be that wide.
 */
export interface GhosttyRenderRun {
	/** The first column. */
	readonly x: number;
	/** How many columns it covers. */
	readonly width: number;
	readonly text: string;
	/** Whether `text` is one grapheme cluster to box to `width` columns. */
	readonly cluster: boolean;
	readonly style: GhosttyRenderStyle;
	/**
	 * Whether the cells are part of a hyperlink (OSC 8). Only the flag: the
	 * link's URI isn't read.
	 */
	// TODO: the URI, which the library exposes only with grid introspection,
	// a feature this module isn't built with
	readonly hyperlink: boolean;
}

/**
 * One row of the screen. Its runs cover its columns from 0 without gaps,
 * except that trailing blank cells of the default style are left out — a
 * blank row has no runs.
 *
 * A row is never mutated. An update gives a row the same object it had in
 * the previous update when its id and contents are unchanged — after an
 * ordinary scroll too, though the library rebuilds every row then — so a
 * keyed list can skip a row whose object is the same reference.
 */
export interface GhosttyRenderRow {
	/**
	 * The row's identity, a key for a keyed list: it stays with a row as the
	 * screen scrolls, and a new line gets a new one. An edit that moves rows
	 * within the library's page — a scroll inside a scroll region (DECSTBM),
	 * inserted or deleted lines, some erases — gives every row of that page
	 * a new id, rows outside the edit included, so those rows come back as
	 * new objects. Unique within one update. The library numbers each
	 * screen's rows on its own, so after switching between the primary and
	 * alternate screens an id can come back for a different row — its object
	 * then has that row's contents, as always.
	 */
	readonly id: string;
	readonly runs: ReadonlyArray<GhosttyRenderRun>;
}

/** A cursor's shape (DECSCUSR). */
export type GhosttyRenderCursorStyle = 'bar' | 'block' | 'underline' | 'block_hollow';

/** Where the cursor is in the viewport. */
export interface GhosttyRenderCursorViewport {
	/** Its column. */
	readonly x: number;
	/** Its row: the index into `GhosttyRenderState.rows`. */
	readonly y: number;
	/**
	 * Whether it's on the second cell of a wide character, so a renderer may
	 * draw it over the whole character, one column left.
	 */
	readonly wide_tail: boolean;
}

/** The cursor, as the terminal's modes have it. */
export interface GhosttyRenderCursor {
	/** Whether the program shows it (DECTCEM); draw nothing when `false`. */
	readonly visible: boolean;
	/** Whether it should blink. */
	readonly blinking: boolean;
	/** Whether it's at a password prompt (the terminal's own heuristic). */
	readonly password_input: boolean;
	readonly style: GhosttyRenderCursorStyle;
	/** Its position, or `null` when it isn't in the viewport (scrolled away). */
	readonly viewport: GhosttyRenderCursorViewport | null;
}

/**
 * The frame's colors, each `0xRRGGBB`.
 *
 * The default foreground and background are the library's placeholders —
 * white on black — until the terminal has both set (OSC 10 and 11, or the
 * host's theme): the library takes the terminal's defaults only as a pair, so
 * one set alone reports the placeholder for both.
 */
// TODO: the host's theme, through the terminal's default-color options,
// set by the renderer
export interface GhosttyRenderColors {
	/** The default text color — already swapped with `background` under reverse video (DECSCNM). */
	readonly foreground: number;
	/** The default background. */
	readonly background: number;
	/** The cursor's color when the program set one (OSC 12), else `null`: draw it as you choose. */
	readonly cursor: number | null;
	/** The 256-color palette a `GhosttyRenderColor` of kind `palette` indexes. */
	readonly palette: ReadonlyArray<number>;
}

/** The manifest constants a render state uses, resolved once per module. */
export interface GhosttyRenderConstants {
	/** `GhosttyRenderStateData` keys read once per update, in order. */
	frame_keys: ReadonlyArray<number>;
	/** `GhosttyRenderStateData.ROW_ITERATOR`. */
	data_row_iterator: number;
	/** `GhosttyRenderStateDirty` values. */
	dirty_false: number;
	dirty_partial: number;
	dirty_full: number;
	/** `GhosttyRenderStateRowData` keys read per row, in order: `DIRTY`, `ID`, `CELLS_RAW`, `CELLS`. */
	row_keys: ReadonlyArray<number>;
	/** `GhosttyRenderStateRowCellsData.STYLE`. */
	cells_data_style: number;
	/** `GhosttyRenderStateRowCellsData.GRAPHEMES_BUF`. */
	cells_data_graphemes: number;
	/** `GHOSTTY_OUT_OF_SPACE`. */
	out_of_space: number;
	/** `sizeof(GhosttyRenderStateCursor)` and its fields' offsets. */
	cursor_size: number;
	cursor_viewport_has_value: number;
	cursor_viewport_x: number;
	cursor_viewport_y: number;
	cursor_wide_tail: number;
	cursor_visible: number;
	cursor_blinking: number;
	cursor_password_input: number;
	cursor_visual_style: number;
	/** Each `GhosttyCursorStyle` value's shape. */
	cursor_styles: ReadonlyMap<number, GhosttyRenderCursorStyle>;
	/** `sizeof(GhosttyRenderStateColors)` and its fields' offsets. */
	colors_size: number;
	colors_background: number;
	colors_foreground: number;
	colors_cursor: number;
	colors_cursor_has_value: number;
	colors_palette: number;
	/** `sizeof(GhosttyColorRgb)` and its channels' offsets. */
	rgb_size: number;
	rgb_r: number;
	rgb_g: number;
	rgb_b: number;
	/** `sizeof(GhosttyRenderStateRowId)`. */
	row_id_size: number;
	/** `sizeof(GhosttyCellsView)` and its fields' offsets. */
	cells_view_size: number;
	cells_view_ptr: number;
	cells_view_len: number;
	/** `sizeof(GhosttyCodepointBuffer)` and its fields' offsets. */
	codepoints_size: number;
	codepoints_ptr: number;
	codepoints_cap: number;
	codepoints_len: number;
	/** `sizeof(GhosttyStyle)` and its fields' offsets. */
	style_size: number;
	style_fg: number;
	style_bg: number;
	style_underline: number;
	style_flags: number;
	/** Offsets within a `GhosttyStyleColor`: its tag, and its value's palette index and RGB. */
	color_tag: number;
	color_palette: number;
	color_rgb: number;
	/** `GhosttyStyleColorTag` values. */
	color_tag_palette: number;
	color_tag_rgb: number;
	/** The `GhosttyStyleFlags` bits, as single-bit masks, and the underline field. */
	flag_bold: number;
	flag_italic: number;
	flag_faint: number;
	flag_blink: number;
	flag_inverse: number;
	flag_invisible: number;
	flag_strikethrough: number;
	flag_overline: number;
	underline_shift: number;
	underline_mask: number;
	/** Every bit `GhosttyStyleFlags` defines. */
	flags_mask: number;
	/** Each `GhosttySgrUnderline` value's kind. */
	underlines: ReadonlyMap<number, GhosttyRenderUnderline>;
	/** `GhosttyCell` bit fields. */
	cell_content_tag: GhosttyBitReader;
	cell_codepoint: GhosttyBitReader;
	cell_bg_palette: GhosttyBitReader;
	cell_bg_r: GhosttyBitReader;
	cell_bg_g: GhosttyBitReader;
	cell_bg_b: GhosttyBitReader;
	cell_style_id: GhosttyBitReader;
	cell_wide: GhosttyBitReader;
	cell_hyperlink: GhosttyBitReader;
	/**
	 * Whether the fast path for the common cell — narrow, one code point,
	 * the default style, no hyperlink — is on: it is when each of those
	 * fields' plain value is zero, so the cell is recognized by `plain_lo`
	 * and `plain_hi`, the bits of those fields in its low and high words,
	 * all being zero.
	 */
	plain: boolean;
	plain_lo: number;
	plain_hi: number;
	/** `GhosttyCellContentTag` values. */
	content_codepoint: number;
	content_grapheme: number;
	content_bg_palette: number;
	content_bg_rgb: number;
	/** `GhosttyCellWide` values. */
	wide_narrow: number;
	wide_wide: number;
	wide_spacer_tail: number;
	wide_spacer_head: number;
}

/**
 * The `GhosttyRenderStateData` keys an update reads in one call, in order,
 * with the type each gives (`cursor` and `colors` the sized structs).
 */
const FRAME_KEYS: ReadonlyArray<readonly [string, string]> = [
	['DIRTY', 'GhosttyRenderStateDirty'],
	['COLS', 'u16'],
	['ROWS', 'u16'],
	['CURSOR', 'cursor'],
	['COLORS', 'colors']
];

/** The `GhosttyRenderStateRowData` keys read per row in one call, in order, with their types. */
const ROW_KEYS: ReadonlyArray<readonly [string, string]> = [
	['DIRTY', 'bool'],
	['ID', 'GhosttyRenderStateRowId'],
	['CELLS_RAW', 'GhosttyCellsView'],
	['CELLS', 'GhosttyRenderStateRowCells']
];

/** A struct field's offset, checked to be of `type` and, when given, `size` bytes. */
const field_offset = (
	manifest: GhosttyManifest,
	struct: string,
	field: string,
	type: string,
	size?: number
): number => {
	const found = manifest.struct_field(struct, field);
	if (found.type !== type || (size !== undefined && found.size !== size)) {
		throw new GhosttyManifestError(
			`the manifest's ${struct}.${field} is ${found.type} of size ${found.size}, not ${type}${size === undefined ? '' : ` of size ${size}`}`
		);
	}
	return found.offset;
};

/** A key enum's value, checked to give `type`. */
const key_value = (
	manifest: GhosttyManifest,
	enum_name: string,
	key: string,
	type: string
): number => {
	const found = manifest.enum_key(enum_name, key, 'out');
	if (found.type !== type) {
		throw new GhosttyManifestError(
			`the manifest's ${enum_name}.${key} gives ${found.type}, not ${type}`
		);
	}
	return manifest.enum_value(enum_name, key);
};

/** A field's bits set, in the low and high words of a `u64`. */
const bits_mask = (bits: GhosttyManifestBits): [number, number] => {
	let lo = 0;
	let hi = 0;
	for (let bit = bits.lsb; bit < bits.lsb + bits.width; bit++) {
		if (bit < 32) lo |= 1 << bit;
		else hi |= 1 << (bit - 32);
	}
	return [lo, hi];
};

/**
 * An enum's named values, each checked to fit the bit field it's read from.
 *
 * @throws GhosttyManifestError when one is missing or can't fit
 */
const enum_in_bits = (
	manifest: GhosttyManifest,
	enum_name: string,
	bits: GhosttyManifestBits,
	names: ReadonlyArray<string>
): Record<string, number> => {
	const values: Record<string, number> = {};
	for (const name of names) {
		const value = manifest.enum_value(enum_name, name);
		if (value < 0 || value >= 2 ** bits.width) {
			throw new GhosttyManifestError(
				`the manifest's ${enum_name}.${name} is ${value}, which doesn't fit the ${bits.width}-bit field it's read from`
			);
		}
		values[name] = value;
	}
	return values;
};

/** Each named value of an enum, checked to exist, mapped to its name for a JS value. */
const enum_names = <T extends string>(
	manifest: GhosttyManifest,
	enum_name: string,
	names: Record<string, T>
): Map<number, T> => {
	const mapped: Map<number, T> = new Map();
	for (const [value_name, name] of Object.entries(names)) {
		mapped.set(manifest.enum_value(enum_name, value_name), name);
	}
	return mapped;
};

/**
 * Resolve a render state's constants from a manifest: its data keys and
 * their value types, the layouts of the structs it reads, and the bit
 * positions of the packed `GhosttyCell` and `GhosttyStyleFlags`, which
 * aren't ABI.
 *
 * @throws GhosttyManifestError when an entry is missing or reshaped
 */
export const resolve_ghostty_render_constants = (
	manifest: GhosttyManifest
): GhosttyRenderConstants => {
	const usize = manifest.usize_scalar;
	const data = (key: string, type: string): number =>
		key_value(manifest, 'GhosttyRenderStateData', key, type);
	const row = (key: string, type: string): number =>
		key_value(manifest, 'GhosttyRenderStateRowData', key, type);
	const cells = (key: string, type: string): number =>
		key_value(manifest, 'GhosttyRenderStateRowCellsData', key, type);
	// the key arrays the `_get_multi` calls take are of these enums, written as i32s
	for (const name of [
		'GhosttyRenderStateData',
		'GhosttyRenderStateRowData',
		'GhosttyRenderStateDirty',
		'GhosttyCursorStyle'
	]) {
		if (manifest.scalar(name) !== 'i32') {
			throw new GhosttyManifestError(`the manifest's ${name} is not an i32 enum`);
		}
	}

	const rgb_size = manifest.struct_size('GhosttyColorRgb');
	const cursor = 'GhosttyRenderStateCursor';
	const colors = 'GhosttyRenderStateColors';
	// a sized struct's `size` comes first, where the reader sets it before each read
	for (const sized of [cursor, colors]) {
		if (field_offset(manifest, sized, 'size', usize, 4) !== 0) {
			throw new GhosttyManifestError(`the manifest's ${sized}.size is not its first field`);
		}
	}
	const row_id_size = manifest.struct_size('GhosttyRenderStateRowId');
	if (row_id_size !== 16) {
		throw new GhosttyManifestError(
			`the manifest's GhosttyRenderStateRowId is ${row_id_size} bytes, not two u64 words`
		);
	}
	const palette = manifest.struct_field(colors, 'palette');
	if (palette.type !== 'array' || palette.size !== 256 * rgb_size) {
		throw new GhosttyManifestError(
			`the manifest's ${colors}.palette is ${palette.type} of size ${palette.size}, not 256 GhosttyColorRgb`
		);
	}
	const style_color_size = manifest.struct_size('GhosttyStyleColor');
	const flags_bit = (name: string): number => {
		const bits = manifest.packed_bits('GhosttyStyleFlags', [name]);
		if (bits.width !== 1 || bits.type !== 'bool') {
			throw new GhosttyManifestError(
				`the manifest's GhosttyStyleFlags.${name} is ${bits.width} bits of ${bits.type}, not one bool`
			);
		}
		return 1 << bits.lsb;
	};
	const underline = manifest.packed_bits('GhosttyStyleFlags', ['underline']);
	if (underline.type !== 'GhosttySgrUnderline' || underline.lsb + underline.width > 16) {
		throw new GhosttyManifestError("the manifest's GhosttyStyleFlags.underline is reshaped");
	}
	const underline_mask = (1 << underline.width) - 1;
	const flags = {
		flag_bold: flags_bit('bold'),
		flag_italic: flags_bit('italic'),
		flag_faint: flags_bit('faint'),
		flag_blink: flags_bit('blink'),
		flag_inverse: flags_bit('inverse'),
		flag_invisible: flags_bit('invisible'),
		flag_strikethrough: flags_bit('strikethrough'),
		flag_overline: flags_bit('overline')
	};

	const cell_field = (path: ReadonlyArray<string>, type: string): GhosttyManifestBits => {
		const bits = manifest.packed_bits('GhosttyCell', path);
		if (bits.type !== type) {
			throw new GhosttyManifestError(
				`the manifest's GhosttyCell.${path.join('.')} is ${bits.type}, not ${type}`
			);
		}
		return bits;
	};
	if (manifest.type_entry('GhosttyCell', 'packed').size !== 8) {
		throw new GhosttyManifestError("the manifest's GhosttyCell is not 8 bytes");
	}
	const content_tag = cell_field(['content_tag'], 'GhosttyCellContentTag');
	const codepoint = cell_field(['content', 'CODEPOINT', 'codepoint'], 'u21');
	const grapheme_codepoint = cell_field(['content', 'CODEPOINT_GRAPHEME', 'codepoint'], 'u21');
	if (grapheme_codepoint.lsb !== codepoint.lsb || grapheme_codepoint.width !== codepoint.width) {
		throw new GhosttyManifestError(
			"the manifest's GhosttyCell codepoint arms put the codepoint in different bits"
		);
	}
	const style_id = cell_field(['style_id'], 'GhosttyStyleId');
	const wide = cell_field(['wide'], 'GhosttyCellWide');
	const hyperlink = cell_field(['hyperlink'], 'bool');
	const bg_palette = cell_field(
		['content', 'BG_COLOR_PALETTE', 'index'],
		'GhosttyColorPaletteIndex'
	);
	const bg_rgb = ['r', 'g', 'b'].map((channel) =>
		cell_field(['content', 'BG_COLOR_RGB', channel], 'u8')
	);
	// fields moved onto each other would read each other's bits: refuse
	for (const content of [codepoint, bg_palette, ...bg_rgb]) {
		const fields = [content_tag, content, style_id, wide, hyperlink];
		for (let i = 0; i < fields.length; i++) {
			for (let j = i + 1; j < fields.length; j++) {
				const a = fields[i]!;
				const b = fields[j]!;
				if (a.lsb < b.lsb + b.width && b.lsb < a.lsb + a.width) {
					throw new GhosttyManifestError(
						`the manifest's GhosttyCell fields overlap: bits ${a.lsb}..${a.lsb + a.width} and ${b.lsb}..${b.lsb + b.width}`
					);
				}
			}
		}
	}
	// every enum value read from a bit field must fit in it, or it decodes as another
	const content_tags = enum_in_bits(manifest, 'GhosttyCellContentTag', content_tag, [
		'CODEPOINT',
		'CODEPOINT_GRAPHEME',
		'BG_COLOR_PALETTE',
		'BG_COLOR_RGB'
	]);
	const wides = enum_in_bits(manifest, 'GhosttyCellWide', wide, [
		'NARROW',
		'WIDE',
		'SPACER_TAIL',
		'SPACER_HEAD'
	]);
	enum_in_bits(manifest, 'GhosttySgrUnderline', underline, [
		'NONE',
		'SINGLE',
		'DOUBLE',
		'CURLY',
		'DOTTED',
		'DASHED'
	]);
	const content_codepoint = content_tags.CODEPOINT!;
	const narrow = wides.NARROW!;
	// the fast path reads a cell as plain when these fields are all zero,
	// which is right only when zero is the plain value of each
	const plain = content_codepoint === 0 && narrow === 0;
	let plain_lo = 0;
	let plain_hi = 0;
	for (const bits of [content_tag, style_id, wide, hyperlink]) {
		const [lo, hi] = bits_mask(bits);
		plain_lo |= lo;
		plain_hi |= hi;
	}

	return {
		frame_keys: FRAME_KEYS.map(([key, type]) =>
			data(key, type === 'cursor' ? cursor : type === 'colors' ? colors : type)
		),
		data_row_iterator: data('ROW_ITERATOR', 'GhosttyRenderStateRowIterator'),
		dirty_false: manifest.enum_value('GhosttyRenderStateDirty', 'FALSE'),
		dirty_partial: manifest.enum_value('GhosttyRenderStateDirty', 'PARTIAL'),
		dirty_full: manifest.enum_value('GhosttyRenderStateDirty', 'FULL'),
		row_keys: ROW_KEYS.map(([key, type]) => row(key, type)),
		cells_data_style: cells('STYLE', 'GhosttyStyle'),
		cells_data_graphemes: cells('GRAPHEMES_BUF', 'GhosttyCodepointBuffer'),
		out_of_space: manifest.enum_value('GhosttyResult', 'OUT_OF_SPACE'),
		cursor_size: manifest.struct_size(cursor),
		cursor_viewport_has_value: field_offset(manifest, cursor, 'viewport_has_value', 'bool', 1),
		cursor_viewport_x: field_offset(manifest, cursor, 'viewport_x', 'u16', 2),
		cursor_viewport_y: field_offset(manifest, cursor, 'viewport_y', 'u16', 2),
		cursor_wide_tail: field_offset(manifest, cursor, 'wide_tail', 'bool', 1),
		cursor_visible: field_offset(manifest, cursor, 'visible', 'bool', 1),
		cursor_blinking: field_offset(manifest, cursor, 'blinking', 'bool', 1),
		cursor_password_input: field_offset(manifest, cursor, 'password_input', 'bool', 1),
		cursor_visual_style: field_offset(manifest, cursor, 'visual_style', 'GhosttyCursorStyle', 4),
		cursor_styles: enum_names(manifest, 'GhosttyCursorStyle', {
			BAR: 'bar',
			BLOCK: 'block',
			UNDERLINE: 'underline',
			BLOCK_HOLLOW: 'block_hollow'
		}),
		colors_size: manifest.struct_size(colors),
		colors_background: field_offset(manifest, colors, 'background', 'GhosttyColorRgb', rgb_size),
		colors_foreground: field_offset(manifest, colors, 'foreground', 'GhosttyColorRgb', rgb_size),
		colors_cursor: field_offset(manifest, colors, 'cursor', 'GhosttyColorRgb', rgb_size),
		colors_cursor_has_value: field_offset(manifest, colors, 'cursor_has_value', 'bool', 1),
		colors_palette: palette.offset,
		rgb_size,
		rgb_r: field_offset(manifest, 'GhosttyColorRgb', 'r', 'u8', 1),
		rgb_g: field_offset(manifest, 'GhosttyColorRgb', 'g', 'u8', 1),
		rgb_b: field_offset(manifest, 'GhosttyColorRgb', 'b', 'u8', 1),
		row_id_size,
		cells_view_size: manifest.struct_size('GhosttyCellsView'),
		cells_view_ptr: field_offset(manifest, 'GhosttyCellsView', 'ptr', 'pointer', 4),
		cells_view_len: field_offset(manifest, 'GhosttyCellsView', 'len', usize, 4),
		codepoints_size: manifest.struct_size('GhosttyCodepointBuffer'),
		codepoints_ptr: field_offset(manifest, 'GhosttyCodepointBuffer', 'ptr', 'pointer', 4),
		codepoints_cap: field_offset(manifest, 'GhosttyCodepointBuffer', 'cap', usize, 4),
		codepoints_len: field_offset(manifest, 'GhosttyCodepointBuffer', 'len', usize, 4),
		style_size: manifest.struct_size('GhosttyStyle'),
		style_fg: field_offset(
			manifest,
			'GhosttyStyle',
			'fg_color',
			'GhosttyStyleColor',
			style_color_size
		),
		style_bg: field_offset(
			manifest,
			'GhosttyStyle',
			'bg_color',
			'GhosttyStyleColor',
			style_color_size
		),
		style_underline: field_offset(
			manifest,
			'GhosttyStyle',
			'underline_color',
			'GhosttyStyleColor',
			style_color_size
		),
		style_flags: field_offset(manifest, 'GhosttyStyle', 'flags', 'GhosttyStyleFlags', 2),
		color_tag: field_offset(manifest, 'GhosttyStyleColor', 'tag', 'GhosttyStyleColorTag', 1),
		color_palette:
			field_offset(manifest, 'GhosttyStyleColor', 'value', 'GhosttyStyleColorValue') +
			field_offset(manifest, 'GhosttyStyleColorValue', 'palette', 'GhosttyColorPaletteIndex', 1),
		color_rgb:
			field_offset(manifest, 'GhosttyStyleColor', 'value', 'GhosttyStyleColorValue') +
			field_offset(manifest, 'GhosttyStyleColorValue', 'rgb', 'GhosttyColorRgb', rgb_size),
		color_tag_palette: manifest.enum_value('GhosttyStyleColorTag', 'PALETTE'),
		color_tag_rgb: manifest.enum_value('GhosttyStyleColorTag', 'RGB'),
		...flags,
		underline_shift: underline.lsb,
		underline_mask,
		flags_mask:
			Object.values(flags).reduce((mask, bit) => mask | bit, 0) | (underline_mask << underline.lsb),
		underlines: enum_names(manifest, 'GhosttySgrUnderline', {
			NONE: 'none',
			SINGLE: 'single',
			DOUBLE: 'double',
			CURLY: 'curly',
			DOTTED: 'dotted',
			DASHED: 'dashed'
		}),
		cell_content_tag: to_ghostty_bit_reader(content_tag, 'GhosttyCell.content_tag'),
		cell_codepoint: to_ghostty_bit_reader(codepoint, 'GhosttyCell codepoint'),
		cell_bg_palette: to_ghostty_bit_reader(bg_palette, 'GhosttyCell palette index'),
		cell_bg_r: to_ghostty_bit_reader(bg_rgb[0]!, 'GhosttyCell red'),
		cell_bg_g: to_ghostty_bit_reader(bg_rgb[1]!, 'GhosttyCell green'),
		cell_bg_b: to_ghostty_bit_reader(bg_rgb[2]!, 'GhosttyCell blue'),
		cell_style_id: to_ghostty_bit_reader(style_id, 'GhosttyCell.style_id'),
		cell_wide: to_ghostty_bit_reader(wide, 'GhosttyCell.wide'),
		cell_hyperlink: to_ghostty_bit_reader(hyperlink, 'GhosttyCell.hyperlink'),
		plain,
		plain_lo,
		plain_hi,
		content_codepoint,
		content_grapheme: content_tags.CODEPOINT_GRAPHEME!,
		content_bg_palette: content_tags.BG_COLOR_PALETTE!,
		content_bg_rgb: content_tags.BG_COLOR_RGB!,
		wide_narrow: narrow,
		wide_wide: wides.WIDE!,
		wide_spacer_tail: wides.SPACER_TAIL!,
		wide_spacer_head: wides.SPACER_HEAD!
	};
};

/**
 * A style as the reader interns it: its colors as codes — `-1` for the
 * default, `0..=255` a palette index, `RGB_CODE | 0xRRGGBB` a direct color —
 * and its flags, with the public value made from them.
 */
interface StyleEntry {
	fg: number;
	bg: number;
	underline: number;
	flags: number;
	style: GhosttyRenderStyle;
}

/** The bit marking a color code as direct RGB rather than a palette index. */
const RGB_CODE = 0x100_0000;
const DEFAULT_COLOR = -1;

/** The palette colors, shared: they're values. */
const PALETTE_COLORS: ReadonlyArray<GhosttyRenderColor> = Array.from(
	{ length: 256 },
	(_, index) => ({ kind: 'palette', index }) as const
);

/** The default style: no colors set, no flags. */
export const GHOSTTY_RENDER_DEFAULT_STYLE: GhosttyRenderStyle = {
	key: '-1.-1.-1.0',
	fg: null,
	bg: null,
	underline_color: null,
	bold: false,
	italic: false,
	faint: false,
	blink: false,
	inverse: false,
	invisible: false,
	strikethrough: false,
	overline: false,
	underline: 'none'
};

const DEFAULT_STYLE_ENTRY: StyleEntry = {
	fg: DEFAULT_COLOR,
	bg: DEFAULT_COLOR,
	underline: DEFAULT_COLOR,
	flags: 0,
	style: GHOSTTY_RENDER_DEFAULT_STYLE
};

/** Whether an interned style has these codes. */
const same_style = (
	entry: StyleEntry,
	fg: number,
	bg: number,
	underline: number,
	flags: number
): boolean =>
	entry.fg === fg && entry.bg === bg && entry.underline === underline && entry.flags === flags;

/** A codepoint buffer's first capacity, in code points; it grows to fit a longer cluster. */
const CODEPOINTS_MIN_CAP = 16;

const EMPTY_RUNS: ReadonlyArray<GhosttyRenderRun> = [];
const EMPTY_BYTES = new Uint8Array();
const EMPTY_WORDS = new Uint32Array();

/**
 * Each terminal's render state, while it's live: an update consumes the
 * terminal's change tracking, so a terminal has at most one.
 */
const live_render_states: WeakMap<GhosttyTerminal, GhosttyRenderState> = new WeakMap();

/** A row id's words, its key, and the row last read under it. */
interface RowEntry {
	w0: number;
	w1: number;
	w2: number;
	w3: number;
	key: string;
	row: GhosttyRenderRow;
}

const INITIAL_CURSOR: GhosttyRenderCursor = {
	visible: false,
	blinking: false,
	password_input: false,
	style: 'block',
	viewport: null
};

const INITIAL_COLORS: GhosttyRenderColors = {
	foreground: 0,
	background: 0,
	cursor: null,
	palette: Array.from({ length: 256 }, () => 0)
};

/** Where each value lives in a render state's scratch block, from its start. */
interface ScratchLayout {
	frame_keys: number;
	frame_values: number;
	written: number;
	dirty: number;
	cols: number;
	rows: number;
	cursor: number;
	colors: number;
	iterator_slot: number;
	row_keys: number;
	row_values: number;
	row_dirty: number;
	row_id: number;
	cells_view: number;
	cells_slot: number;
	style: number;
	codepoints: number;
	/** The block's whole length. */
	len: number;
}

const to_scratch_layout = (constants: GhosttyRenderConstants): ScratchLayout => {
	let len = 0;
	// every value 8-aligned: the row id holds u64 words, and the block is aligned for any value
	const take = (size: number): number => {
		const offset = len;
		len += Math.ceil(size / 8) * 8;
		return offset;
	};
	const offsets = {
		frame_keys: take(4 * constants.frame_keys.length),
		frame_values: take(4 * constants.frame_keys.length),
		written: take(4),
		dirty: take(4),
		cols: take(2),
		rows: take(2),
		cursor: take(constants.cursor_size),
		colors: take(constants.colors_size),
		iterator_slot: take(4),
		row_keys: take(4 * constants.row_keys.length),
		row_values: take(4 * constants.row_keys.length),
		row_dirty: take(1),
		row_id: take(constants.row_id_size),
		cells_view: take(constants.cells_view_size),
		cells_slot: take(4),
		style: take(constants.style_size),
		codepoints: take(constants.codepoints_size)
	};
	return { ...offsets, len };
};

/**
 * A terminal's render state and the reader over it: the frame data a
 * renderer draws, updated once per animation frame.
 *
 * ```ts
 * const frame = new GhosttyRenderState(terminal);
 * // each animation frame
 * if (frame.update() !== 'clean') draw_rows(frame.rows);
 * draw_cursor(frame.cursor, frame.colors);
 * frame.clean();
 * ```
 *
 * `GhosttyRenderState.update` copies everything out of wasm memory, so what
 * it gives is plain data that stays valid through later writes, until the
 * next update replaces it. Every value is immutable and replaced only when it
 * changes: `rows` is a new array after every update that isn't `clean`, but
 * each row in it is the previous update's object when the row is unchanged;
 * `cursor`, `colors`, and `colors.palette` are new objects only when they
 * changed. So a renderer compares references to skip work — a keyed list of
 * rows by `GhosttyRenderRow.id` re-renders only rows whose object changed.
 *
 * It's freed by `GhosttyRenderState.dispose`, or with its terminal, which
 * disposes it first. Any use afterward throws `GhosttyDisposedError`; on a
 * poisoned instance (`GhosttyVt.poisoned`) every method but `dispose` throws
 * `GhosttyPoisonedError` before calling in, and `dispose` frees nothing.
 *
 * A terminal has at most one live render state: an update consumes the
 * terminal's change tracking, so a second one would miss what the first
 * took. Its output is plain immutable data, so any number of views can share
 * one reader's rows. Once it's disposed, a new one can be made; its first
 * update is a full frame.
 *
 * All of it may be used from the terminal's effect handlers, which run in
 * the middle of its `write` or `resize`: an update reads the terminal and
 * consumes its change tracking but never changes what it shows, and the
 * library fires every effect between whole steps of the parse, so the
 * terminal is consistent there. That's what a `render_hold` handler does
 * (`GhosttyTerminalEffectHandlers.render_hold`). Nothing here throws
 * `GhosttyReentrancyError`.
 *
 * The library misses one change: with grapheme clustering (mode 2027) off, a
 * combining mark or other zero-width character that arrives in a write of
 * its own joins the cell before it without marking the row changed, so the
 * update is `clean` and the row keeps showing the cell without it — until
 * anything else changes that row, which brings it back right. With mode
 * 2027 on, or the mark in the same write as its base, it's tracked.
 */
// TODO: the selection — `ROW_DATA_SELECTION` per row, once selections are
// bound — as a column range on the row, so it changes without new runs
// TODO: overscan for smooth scrolling (`GHOSTTY_RENDER_STATE_OPT_OVERSCAN`):
// rows above and below the viewport, placed by `ROW_DATA_VIEWPORT_Y`
// TODO: image placements (the image iterator), with kitty graphics built in
export class GhosttyRenderState implements GhosttyTerminalDependent {
	/** The terminal it reads. */
	readonly terminal: GhosttyTerminal;

	readonly #vt: GhosttyVt;
	readonly #constants: GhosttyRenderConstants;
	readonly #layout: ScratchLayout;
	/** The render state handle; `0` once disposed. */
	#state = 0;
	#iterator = 0;
	#cells = 0;
	/** The scratch block, laid out by `#layout`. */
	#scratch = 0;
	/** The grapheme codepoint buffer and its capacity in code points. */
	#codepoints = 0;
	#codepoints_cap = 0;

	#dirty: GhosttyRenderDirty = 'clean';
	#cols = 0;
	#rows: ReadonlyArray<GhosttyRenderRow> = [];
	#cursor: GhosttyRenderCursor = INITIAL_CURSOR;
	#colors: GhosttyRenderColors = INITIAL_COLORS;
	/** The palette's bytes as last read, to tell when it changed. */
	readonly #palette_bytes: Uint8Array;

	/** The rows of the last update by a hash of their id, and a spare map for the next. */
	#row_entries: Map<number, RowEntry> = new Map();
	#spare_entries: Map<number, RowEntry> = new Map();
	/**
	 * Interned styles by a hash of their codes, in two generations: the ones
	 * this update has read, and the previous update's. A style the previous
	 * update read moves up when it's read again, and the rest go when the
	 * generations turn at the next update that reads rows — so the cache
	 * holds about two screens' worth of styles, however many a program
	 * makes, and a style read in consecutive updates that read rows keeps
	 * its object. A row kept without being decoded reads none, so a style
	 * only it holds can go while the row still uses it.
	 */
	#styles: Map<number, StyleEntry> = new Map();
	#previous_styles: Map<number, StyleEntry> = new Map();
	/** The styles of the row being decoded, by style id: ids are only meaningful within a row's page. */
	readonly #row_styles: Map<number, StyleEntry> = new Map();
	/** The code units of the run being built. */
	#units: Uint16Array = new Uint16Array(256);
	/** The column the cells handle is at, so a style and graphemes at one column select once. */
	#cells_x = -1;
	/**
	 * Views of memory for one update, taken after its first calls and taken
	 * again only when a later call detached them — growing a wasm memory
	 * detaches every view of it, leaving it empty — or after a call of ours
	 * that allocates. Never kept past the update.
	 */
	#bytes: Uint8Array = new Uint8Array();
	#words: Uint32Array = new Uint32Array();

	/**
	 * Create a render state for a terminal. Nothing is read until the first
	 * `GhosttyRenderState.update`; until then `rows` is empty.
	 *
	 * @throws GhosttyLoadError when the module was built without its
	 *   `render_state` feature, or the host isn't little-endian
	 * @throws GhosttyManifestError when the manifest lacks what it reads
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws Error when the terminal already has a live render state
	 * @throws GhosttyDisposedError when the terminal is disposed
	 */
	constructor(terminal: GhosttyTerminal) {
		terminal.handle('new GhosttyRenderState');
		if (live_render_states.has(terminal)) {
			throw new Error(
				"the terminal already has a GhosttyRenderState: an update consumes the terminal's change tracking, so a second would miss changes — share the first one's frame data, or dispose it first"
			);
		}
		const vt = terminal.vt;
		if (!vt.has_feature('render_state')) {
			throw new GhosttyLoadError(
				'this libghostty-vt module was built without the render_state feature, so it has no render state'
			);
		}
		if (!GHOSTTY_HOST_LITTLE_ENDIAN) {
			throw new GhosttyLoadError(
				"the render state reads libghostty-vt's memory as little-endian words, but this host is big-endian"
			);
		}
		this.terminal = terminal;
		this.#vt = vt;
		this.#constants = vt.resolve(resolve_ghostty_render_constants);
		this.#layout = to_scratch_layout(this.#constants);
		this.#palette_bytes = new Uint8Array(256 * this.#constants.rgb_size);
		const { exports, memory } = vt;
		const take = (create: (slot: number) => number, name: string): number =>
			memory.with_opaque((slot) => {
				vt.check(create(slot), name);
				return memory.take_opaque(slot);
			});
		this.#state = take(
			(slot) => exports.ghostty_render_state_new(0, slot),
			'ghostty_render_state_new'
		);
		try {
			this.#iterator = take(
				(slot) => exports.ghostty_render_state_row_iterator_new(0, slot),
				'ghostty_render_state_row_iterator_new'
			);
			this.#cells = take(
				(slot) => exports.ghostty_render_state_row_cells_new(0, slot),
				'ghostty_render_state_row_cells_new'
			);
			this.#scratch = memory.alloc(this.#layout.len);
			this.#codepoints = memory.alloc(4 * CODEPOINTS_MIN_CAP);
			this.#codepoints_cap = CODEPOINTS_MIN_CAP;
			this.#write_scratch_constants();
			terminal.add_dependent(this);
			live_render_states.set(terminal, this);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	/** Whether `GhosttyRenderState.dispose` has freed it (itself, or with its terminal). */
	get disposed(): boolean {
		return this.#state === 0;
	}

	/** What the last update found changed; `clean` before the first. */
	get dirty(): GhosttyRenderDirty {
		return this.#dirty;
	}

	/** The width in cells the last update captured. */
	get cols(): number {
		return this.#cols;
	}

	/**
	 * Every row the last update captured, top to bottom — the viewport, so
	 * its length is the height in cells. Replaced, never mutated; see the
	 * class doc for which rows keep their objects.
	 */
	get rows(): ReadonlyArray<GhosttyRenderRow> {
		return this.#rows;
	}

	/** The cursor as of the last update; a new object only when it changed. */
	get cursor(): GhosttyRenderCursor {
		return this.#cursor;
	}

	/** The colors as of the last update; a new object only when one changed. */
	get colors(): GhosttyRenderColors {
		return this.#colors;
	}

	/**
	 * Capture the terminal's current frame, and read what changed into
	 * `rows`, `cursor`, `colors`, and `cols`. A `clean` update costs two calls
	 * into the module and allocates nothing (unless the cursor or a color
	 * changed). An update only ever adds to what's dirty — the result stays
	 * `partial` or `full` until `GhosttyRenderState.clean`.
	 *
	 * @returns what changed since the render state was last cleaned
	 * @throws GhosttyResultError when the library fails (`OUT_OF_MEMORY`)
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyDisposedError after `dispose`, its terminal's included
	 */
	update(): GhosttyRenderDirty {
		const state = this.#live('update');
		const terminal = this.terminal.handle('GhosttyRenderState.update');
		const vt = this.#vt;
		const { exports, memory } = vt;
		const c = this.#constants;
		const layout = this.#layout;
		const scratch = this.#scratch;
		vt.check(exports.ghostty_render_state_update(state, terminal), 'ghostty_render_state_update');
		// the sized structs' sizes, set before every read as sized-struct callers do
		let view = memory.view();
		view.setUint32(scratch + layout.cursor, c.cursor_size, true);
		view.setUint32(scratch + layout.colors, c.colors_size, true);
		this.#check_multi(
			exports.ghostty_render_state_get_multi(
				state,
				c.frame_keys.length,
				scratch + layout.frame_keys,
				scratch + layout.frame_values,
				scratch + layout.written
			),
			'ghostty_render_state_get_multi',
			FRAME_KEYS
		);
		this.#take_views();
		view = memory.view();
		const dirty_value = view.getInt32(scratch + layout.dirty, true);
		const dirty: GhosttyRenderDirty =
			dirty_value === c.dirty_false
				? 'clean'
				: dirty_value === c.dirty_partial
					? 'partial'
					: 'full';
		this.#dirty = dirty;
		this.#cols = view.getUint16(scratch + layout.cols, true);
		const rows = view.getUint16(scratch + layout.rows, true);
		try {
			const bytes = this.#bytes;
			this.#read_cursor(bytes, view);
			// the library copies the palette into the render state only on a full update
			this.#read_colors(bytes, dirty === 'full');
			if (dirty !== 'clean') this.#read_rows(rows, dirty === 'full');
		} finally {
			// views of memory are never kept past the update
			this.#bytes = EMPTY_BYTES;
			this.#words = EMPTY_WORDS;
		}
		return dirty;
	}

	/**
	 * Check a `_get_multi` call's result, naming the key that failed: the
	 * library stops at the first, and writes how many it read before it.
	 */
	#check_multi(result: number, call: string, keys: ReadonlyArray<readonly [string, string]>): void {
		const vt = this.#vt;
		if (result === vt.constants.success) return;
		const written = vt.memory.view().getUint32(this.#scratch + this.#layout.written, true);
		vt.check(result, `${call}(${keys[written]?.[0] ?? `key ${written}`})`);
	}

	/** Take this update's views of memory: after any call that can allocate. */
	#take_views(): void {
		const memory = this.#vt.memory;
		this.#bytes = memory.bytes();
		this.#words = memory.words();
	}

	/**
	 * Take the views again if a call detached them. Every call this reader
	 * makes after an update's first ones only writes buffers the reader
	 * passed — none reaches the library's allocator, so none can grow memory
	 * — but this keeps a view from being read detached if one ever did.
	 */
	#check_views(): void {
		if (this.#words.length === 0) this.#take_views();
	}

	/**
	 * Mark the frame drawn: the render state's dirty tracking — the frame's
	 * and every row's — is cleared, so the next update reports only what
	 * changes after this. Call it once a frame has been drawn completely.
	 *
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyDisposedError after `dispose`
	 */
	clean(): void {
		const state = this.#live('clean');
		this.#vt.check(
			this.#vt.exports.ghostty_render_state_clean(state),
			'ghostty_render_state_clean'
		);
	}

	/**
	 * Free the render state and its scratch memory. Idempotent and total; its
	 * terminal calls it first when it's disposed. On a poisoned instance
	 * nothing is freed — no call goes into the module.
	 */
	dispose(): void {
		const state = this.#state;
		const iterator = this.#iterator;
		const cells = this.#cells;
		const scratch = this.#scratch;
		const codepoints = this.#codepoints;
		const codepoints_cap = this.#codepoints_cap;
		if (state === 0) return;
		// cleared before the frees, so nothing can free a handle twice
		this.#state = 0;
		this.#iterator = 0;
		this.#cells = 0;
		this.#scratch = 0;
		this.#codepoints = 0;
		this.#codepoints_cap = 0;
		this.terminal.remove_dependent(this);
		if (live_render_states.get(this.terminal) === this) live_render_states.delete(this.terminal);
		const vt = this.#vt;
		if (vt.poisoned) return;
		const { exports, memory } = vt;
		if (cells !== 0) exports.ghostty_render_state_row_cells_free(cells);
		if (iterator !== 0) exports.ghostty_render_state_row_iterator_free(iterator);
		if (scratch !== 0) memory.free(scratch, this.#layout.len);
		if (codepoints !== 0) memory.free(codepoints, 4 * codepoints_cap);
		exports.ghostty_render_state_free(state);
	}

	#live(method: string): number {
		if (this.#state === 0) {
			throw new GhosttyDisposedError(`GhosttyRenderState.${method} called after dispose`);
		}
		this.#vt.assert_not_poisoned(`GhosttyRenderState.${method}`);
		return this.#state;
	}

	/**
	 * Write what the scratch block holds for the life of the render state:
	 * the key arrays, the out-pointer arrays pointing into the block, and the
	 * handles the iterator and cells outputs are filled through.
	 */
	#write_scratch_constants(): void {
		const view = this.#vt.memory.view();
		const c = this.#constants;
		const layout = this.#layout;
		const scratch = this.#scratch;
		const frame_outs = [layout.dirty, layout.cols, layout.rows, layout.cursor, layout.colors];
		for (let i = 0; i < c.frame_keys.length; i++) {
			view.setInt32(scratch + layout.frame_keys + 4 * i, c.frame_keys[i]!, true);
			view.setUint32(scratch + layout.frame_values + 4 * i, scratch + frame_outs[i]!, true);
		}
		const row_outs = [layout.row_dirty, layout.row_id, layout.cells_view, layout.cells_slot];
		for (let i = 0; i < c.row_keys.length; i++) {
			view.setInt32(scratch + layout.row_keys + 4 * i, c.row_keys[i]!, true);
			view.setUint32(scratch + layout.row_values + 4 * i, scratch + row_outs[i]!, true);
		}
		// the library reads these handles from their slots and fills what they point to
		view.setUint32(scratch + layout.iterator_slot, this.#iterator, true);
		view.setUint32(scratch + layout.cells_slot, this.#cells, true);
	}

	#read_cursor(bytes: Uint8Array, view: DataView): void {
		const c = this.#constants;
		const at = this.#scratch + this.#layout.cursor;
		const visible = bytes[at + c.cursor_visible] !== 0;
		const blinking = bytes[at + c.cursor_blinking] !== 0;
		const password_input = bytes[at + c.cursor_password_input] !== 0;
		const style = c.cursor_styles.get(view.getInt32(at + c.cursor_visual_style, true)) ?? 'block';
		const in_viewport = bytes[at + c.cursor_viewport_has_value] !== 0;
		// the position fields are undefined when the cursor isn't in the viewport
		const x = in_viewport ? view.getUint16(at + c.cursor_viewport_x, true) : 0;
		const y = in_viewport ? view.getUint16(at + c.cursor_viewport_y, true) : 0;
		const wide_tail = in_viewport && bytes[at + c.cursor_wide_tail] !== 0;
		const prev = this.#cursor;
		const prev_viewport = prev.viewport;
		if (
			prev.visible === visible &&
			prev.blinking === blinking &&
			prev.password_input === password_input &&
			prev.style === style &&
			(prev_viewport === null
				? !in_viewport
				: in_viewport &&
					prev_viewport.x === x &&
					prev_viewport.y === y &&
					prev_viewport.wide_tail === wide_tail)
		) {
			return;
		}
		this.#cursor = {
			visible,
			blinking,
			password_input,
			style,
			viewport: in_viewport ? { x, y, wide_tail } : null
		};
	}

	#read_colors(bytes: Uint8Array, read_palette: boolean): void {
		const c = this.#constants;
		const at = this.#scratch + this.#layout.colors;
		const foreground = read_rgb(bytes, at + c.colors_foreground, c);
		const background = read_rgb(bytes, at + c.colors_background, c);
		const cursor =
			bytes[at + c.colors_cursor_has_value] !== 0 ? read_rgb(bytes, at + c.colors_cursor, c) : null;
		const prev = this.#colors;
		let palette = prev.palette;
		if (read_palette) {
			const start = at + c.colors_palette;
			const stored = this.#palette_bytes;
			let same = true;
			for (let i = 0; i < stored.length; i++) {
				if (stored[i] !== bytes[start + i]) {
					same = false;
					break;
				}
			}
			if (!same) {
				stored.set(bytes.subarray(start, start + stored.length));
				const next: Array<number> = new Array(256);
				for (let i = 0; i < 256; i++) next[i] = read_rgb(bytes, start + i * c.rgb_size, c);
				palette = next;
			}
		}
		if (
			prev.foreground === foreground &&
			prev.background === background &&
			prev.cursor === cursor &&
			prev.palette === palette
		) {
			return;
		}
		this.#colors = { foreground, background, cursor, palette };
	}

	/** Walk every captured row: ids for all, contents for the dirty ones. */
	#read_rows(count: number, full: boolean): void {
		const vt = this.#vt;
		const { exports } = vt;
		const c = this.#constants;
		const layout = this.#layout;
		const scratch = this.#scratch;
		const iterator = this.#iterator;
		vt.check(
			exports.ghostty_render_state_get(
				this.#state,
				c.data_row_iterator,
				scratch + layout.iterator_slot
			),
			'ghostty_render_state_get(ROW_ITERATOR)'
		);
		if (this.#units.length < 2 * this.#cols) this.#units = new Uint16Array(2 * this.#cols);
		const prev = this.#row_entries;
		const next = this.#spare_entries;
		next.clear();
		// the style generations turn: last update's styles become the previous ones
		const oldest = this.#previous_styles;
		oldest.clear();
		this.#previous_styles = this.#styles;
		this.#styles = oldest;
		const rows: Array<GhosttyRenderRow> = [];
		const id_word = (scratch + layout.row_id) >>> 2;
		for (let i = 0; i < count; i++) {
			if (!exports.ghostty_render_state_row_iterator_next(iterator)) {
				throw new GhosttyLoadError(
					`libghostty-vt's render state reports ${count} rows but its row iterator holds ${i}`
				);
			}
			this.#check_multi(
				exports.ghostty_render_state_row_get_multi(
					iterator,
					c.row_keys.length,
					scratch + layout.row_keys,
					scratch + layout.row_values,
					scratch + layout.written
				),
				'ghostty_render_state_row_get_multi',
				ROW_KEYS
			);
			this.#check_views();
			const words = this.#words;
			const row_dirty = full || this.#bytes[scratch + layout.row_dirty] !== 0;
			const w0 = words[id_word]!;
			const w1 = words[id_word + 1]!;
			const w2 = words[id_word + 2]!;
			const w3 = words[id_word + 3]!;
			const hash =
				(Math.imul(w0, 0x9e37_79b1) ^
					Math.imul(w1, 0x85eb_ca6b) ^
					Math.imul(w2, 0xc2b2_ae35) ^
					Math.imul(w3, 0x27d4_eb2f)) |
				0;
			const found = prev.get(hash);
			const entry =
				found !== undefined &&
				found.w0 === w0 &&
				found.w1 === w1 &&
				found.w2 === w2 &&
				found.w3 === w3
					? found
					: null;
			let row: GhosttyRenderRow;
			if (entry !== null && !row_dirty) {
				// the library's guarantee: the same id, not dirty, is unchanged
				row = entry.row;
			} else {
				const view_at = (scratch + layout.cells_view) >>> 2;
				const cells_ptr = words[view_at + (c.cells_view_ptr >>> 2)]!;
				const cells_len = words[view_at + (c.cells_view_len >>> 2)]!;
				const key = entry?.key ?? `${w0}.${w1}.${w2}.${w3}`;
				row = this.#read_row(key, cells_ptr, cells_len);
				// rebuilt but unchanged (every row is after a scroll): keep the object
				if (entry !== null && rows_equal(entry.row, row)) row = entry.row;
			}
			if (entry !== null) {
				entry.row = row;
				next.set(hash, entry);
			} else {
				next.set(hash, { w0, w1, w2, w3, key: row.id, row });
			}
			rows.push(row);
		}
		this.#row_entries = next;
		this.#spare_entries = prev;
		this.#rows = rows;
	}

	/**
	 * Decode one row's cells into runs. `cells_ptr` is the borrowed view of
	 * the row's raw cells, valid until the next update. The views of memory
	 * are re-read from `#words` after each call — checked by the call's
	 * method, taken again after an allocation.
	 */
	#read_row(key: string, cells_ptr: number, cells_len: number): GhosttyRenderRow {
		const c = this.#constants;
		let words = this.#words;
		// a GhosttyCell is a u64, 8-aligned: its low word, then its high word
		const base = cells_ptr >>> 2;
		const { plain_lo, plain_hi, cell_codepoint } = c;
		// with the fast path off, every cell takes the full decode
		const plain = c.plain;

		let end = cells_len;
		// a wide character that didn't fit wrapped to the next row, leaving a
		// spacer head in this row's last column: unstyled, it draws nothing
		if (end > 0) {
			const lo = words[base + 2 * end - 2]!;
			const hi = words[base + 2 * end - 1]!;
			if (
				read_ghostty_bits(lo, hi, c.cell_wide) === c.wide_spacer_head &&
				read_ghostty_bits(lo, hi, c.cell_style_id) === 0 &&
				read_ghostty_bits(lo, hi, c.cell_hyperlink) === 0 &&
				read_ghostty_bits(lo, hi, c.cell_content_tag) === c.content_codepoint &&
				read_ghostty_bits(lo, hi, cell_codepoint) === 0
			) {
				end--;
			}
		}
		// trailing cells that are blank or spaces, and plain, draw nothing
		while (end > 0) {
			const lo = words[base + 2 * end - 2]!;
			const hi = words[base + 2 * end - 1]!;
			if (!this.#is_plain_cell(lo, hi)) break;
			const cp = read_ghostty_bits(lo, hi, cell_codepoint);
			if (cp !== 0 && cp !== 0x20) break;
			end--;
		}
		if (end === 0) return { id: key, runs: EMPTY_RUNS };

		this.#row_styles.clear();
		this.#cells_x = -1;
		const runs: Array<GhosttyRenderRun> = [];
		const units = this.#units;
		let unit_count = 0;
		let run_x = 0;
		let run_cells = 0;
		let run_style = DEFAULT_STYLE_ENTRY;
		let run_link = false;
		// the style of the last styled cell, by its id
		let last_style_id = 0;
		let last_style = DEFAULT_STYLE_ENTRY;
		let after_wide = false;

		const flush = (): void => {
			if (run_cells === 0) return;
			runs.push({
				x: run_x,
				width: run_cells,
				text: units_to_string(units, unit_count),
				cluster: false,
				style: run_style.style,
				hyperlink: run_link
			});
			run_cells = 0;
			unit_count = 0;
		};

		for (let x = 0; x < end; x++) {
			const lo = words[base + 2 * x]!;
			const hi = words[base + 2 * x + 1]!;
			if (plain && (lo & plain_lo) === 0 && (hi & plain_hi) === 0) {
				// the common cell: narrow, one code point, default style, no link
				after_wide = false;
				if (run_style !== DEFAULT_STYLE_ENTRY || run_link) {
					flush();
					run_style = DEFAULT_STYLE_ENTRY;
					run_link = false;
				}
				if (run_cells === 0) run_x = x;
				const cp = read_ghostty_bits(lo, hi, cell_codepoint);
				unit_count = push_code_point(units, unit_count, cp === 0 ? 0x20 : cp);
				run_cells++;
				continue;
			}
			const wide = read_ghostty_bits(lo, hi, c.cell_wide);
			if (wide === c.wide_spacer_tail && after_wide) {
				// the second cell of the wide character before it, drawn with it
				after_wide = false;
				continue;
			}
			after_wide = wide === c.wide_wide;
			const tag = read_ghostty_bits(lo, hi, c.cell_content_tag);
			const link = read_ghostty_bits(lo, hi, c.cell_hyperlink) !== 0;
			const style_id = read_ghostty_bits(lo, hi, c.cell_style_id);
			let style: StyleEntry;
			if (style_id === 0) {
				// style id 0 is the default style, which the library never stores
				style = DEFAULT_STYLE_ENTRY;
			} else if (style_id === last_style_id) {
				style = last_style;
			} else {
				style = this.#row_styles.get(style_id) ?? this.#read_style(x, style_id);
				last_style_id = style_id;
				last_style = style;
				words = this.#words;
			}
			if (tag === c.content_bg_palette || tag === c.content_bg_rgb) {
				// a cell of background only: its color is in the cell, over the style's
				const bg =
					tag === c.content_bg_palette
						? read_ghostty_bits(lo, hi, c.cell_bg_palette)
						: RGB_CODE |
							(read_ghostty_bits(lo, hi, c.cell_bg_r) << 16) |
							(read_ghostty_bits(lo, hi, c.cell_bg_g) << 8) |
							read_ghostty_bits(lo, hi, c.cell_bg_b);
				style = this.#intern_style(style.fg, bg, style.underline, style.flags);
			}
			const cp =
				tag === c.content_codepoint || tag === c.content_grapheme
					? read_ghostty_bits(lo, hi, cell_codepoint)
					: 0;
			if (cp !== 0 && (wide === c.wide_wide || tag === c.content_grapheme)) {
				// one grapheme cluster, boxed to its own columns
				flush();
				let text = String.fromCodePoint(cp);
				if (tag === c.content_grapheme) {
					text = this.#read_grapheme(x);
					words = this.#words;
				}
				runs.push({
					x,
					width: wide === c.wide_wide ? 2 : 1,
					text,
					cluster: true,
					style: style.style,
					hyperlink: link
				});
				continue;
			}
			if (style !== run_style || link !== run_link) {
				flush();
				run_style = style;
				run_link = link;
			}
			if (run_cells === 0) run_x = x;
			// a blank, a spacer, or a background-only cell is a space
			unit_count = push_code_point(units, unit_count, cp === 0 ? 0x20 : cp);
			run_cells++;
			// a wide cell without text is drawn as one space, so its spacer
			// isn't skipped: it's drawn as a space of its own
			if (after_wide && cp === 0) after_wide = false;
		}
		flush();
		return { id: key, runs };
	}

	/** Whether a cell is narrow, one code point (or none), the default style, no hyperlink. */
	#is_plain_cell(lo: number, hi: number): boolean {
		const c = this.#constants;
		if (c.plain) return (lo & c.plain_lo) === 0 && (hi & c.plain_hi) === 0;
		return (
			read_ghostty_bits(lo, hi, c.cell_wide) === c.wide_narrow &&
			read_ghostty_bits(lo, hi, c.cell_content_tag) === c.content_codepoint &&
			read_ghostty_bits(lo, hi, c.cell_style_id) === 0 &&
			read_ghostty_bits(lo, hi, c.cell_hyperlink) === 0
		);
	}

	/** Read the style of the cell at `x` of the current row, interned, and keep it for the row. */
	#read_style(x: number, style_id: number): StyleEntry {
		const vt = this.#vt;
		const c = this.#constants;
		const out = this.#scratch + this.#layout.style;
		this.#select(x);
		vt.check(
			vt.exports.ghostty_render_state_row_cells_get(this.#cells, c.cells_data_style, out),
			'ghostty_render_state_row_cells_get(STYLE)'
		);
		this.#check_views();
		const bytes = this.#bytes;
		const flags =
			(bytes[out + c.style_flags]! | (bytes[out + c.style_flags + 1]! << 8)) & c.flags_mask;
		const entry = this.#intern_style(
			read_style_color(bytes, out + c.style_fg, c),
			read_style_color(bytes, out + c.style_bg, c),
			read_style_color(bytes, out + c.style_underline, c),
			flags
		);
		this.#row_styles.set(style_id, entry);
		return entry;
	}

	/** The grapheme cluster of the cell at `x` of the current row: its code points as a string. */
	#read_grapheme(x: number): string {
		const vt = this.#vt;
		const c = this.#constants;
		const { memory } = vt;
		const buffer = this.#scratch + this.#layout.codepoints;
		this.#select(x);
		for (;;) {
			const view = memory.view();
			view.setUint32(buffer + c.codepoints_ptr, this.#codepoints, true);
			view.setUint32(buffer + c.codepoints_cap, this.#codepoints_cap, true);
			view.setUint32(buffer + c.codepoints_len, 0, true);
			const result = vt.exports.ghostty_render_state_row_cells_get(
				this.#cells,
				c.cells_data_graphemes,
				buffer
			);
			const len = memory.view().getUint32(buffer + c.codepoints_len, true);
			if (result === c.out_of_space && len > this.#codepoints_cap) {
				// a longer cluster than the buffer holds: grow it to fit, and read again
				const old = this.#codepoints;
				const old_cap = this.#codepoints_cap;
				this.#codepoints = 0;
				this.#codepoints_cap = 0;
				memory.free(old, 4 * old_cap);
				this.#codepoints = memory.alloc(4 * len);
				this.#codepoints_cap = len;
				continue;
			}
			vt.check(result, 'ghostty_render_state_row_cells_get(GRAPHEMES_BUF)');
			// the buffer may have grown, and memory with it
			this.#take_views();
			const words = this.#words;
			const start = this.#codepoints >>> 2;
			let text = '';
			for (let i = 0; i < len; i++) text += String.fromCodePoint(words[start + i]!);
			return text;
		}
	}

	/** Move the cells handle to column `x`, unless it's there. */
	#select(x: number): void {
		if (this.#cells_x === x) return;
		const vt = this.#vt;
		vt.check(
			vt.exports.ghostty_render_state_row_cells_select(this.#cells, x),
			'ghostty_render_state_row_cells_select'
		);
		this.#cells_x = x;
		this.#check_views();
	}

	/** The interned style with these codes, made the first time it's seen. */
	#intern_style(fg: number, bg: number, underline: number, flags: number): StyleEntry {
		if (
			fg === DEFAULT_COLOR &&
			bg === DEFAULT_COLOR &&
			underline === DEFAULT_COLOR &&
			flags === 0
		) {
			return DEFAULT_STYLE_ENTRY;
		}
		// chained, so a code moved between fields (red text, red background)
		// hashes apart: xor-ing per-field products would cancel
		let h = Math.imul(fg ^ 0x5bd1_e995, 0x9e37_79b1);
		h = Math.imul(h ^ (h >>> 15) ^ bg, 0x85eb_ca6b);
		h = Math.imul(h ^ (h >>> 13) ^ underline, 0xc2b2_ae35);
		h = Math.imul(h ^ (h >>> 16) ^ flags, 0x27d4_eb2f);
		const hash = (h ^ (h >>> 15)) | 0;
		// this update's styles, then the previous update's, which carry over
		const current = this.#styles.get(hash);
		if (current !== undefined && same_style(current, fg, bg, underline, flags)) return current;
		const previous = this.#previous_styles.get(hash);
		if (previous !== undefined && same_style(previous, fg, bg, underline, flags)) {
			this.#styles.set(hash, previous);
			return previous;
		}
		// new, or its hash taken by another style this update: the slot goes to this one
		const entry: StyleEntry = {
			fg,
			bg,
			underline,
			flags,
			style: this.#create_style(fg, bg, underline, flags)
		};
		this.#styles.set(hash, entry);
		return entry;
	}

	#create_style(fg: number, bg: number, underline: number, flags: number): GhosttyRenderStyle {
		const c = this.#constants;
		return {
			key: `${fg}.${bg}.${underline}.${flags}`,
			fg: to_render_color(fg),
			bg: to_render_color(bg),
			underline_color: to_render_color(underline),
			bold: (flags & c.flag_bold) !== 0,
			italic: (flags & c.flag_italic) !== 0,
			faint: (flags & c.flag_faint) !== 0,
			blink: (flags & c.flag_blink) !== 0,
			inverse: (flags & c.flag_inverse) !== 0,
			invisible: (flags & c.flag_invisible) !== 0,
			strikethrough: (flags & c.flag_strikethrough) !== 0,
			overline: (flags & c.flag_overline) !== 0,
			// a kind this binding doesn't know (a later library's) draws as a plain underline
			underline: c.underlines.get((flags >>> c.underline_shift) & c.underline_mask) ?? 'single'
		};
	}
}

/** A `GhosttyColorRgb` at `at`, as `0xRRGGBB`. */
const read_rgb = (bytes: Uint8Array, at: number, c: GhosttyRenderConstants): number =>
	(bytes[at + c.rgb_r]! << 16) | (bytes[at + c.rgb_g]! << 8) | bytes[at + c.rgb_b]!;

/** A `GhosttyStyleColor` at `at`, as a color code. */
const read_style_color = (bytes: Uint8Array, at: number, c: GhosttyRenderConstants): number => {
	const tag = bytes[at + c.color_tag];
	if (tag === c.color_tag_palette) return bytes[at + c.color_palette]!;
	if (tag === c.color_tag_rgb) {
		const rgb = at + c.color_rgb;
		return (
			RGB_CODE |
			(bytes[rgb + c.rgb_r]! << 16) |
			(bytes[rgb + c.rgb_g]! << 8) |
			bytes[rgb + c.rgb_b]!
		);
	}
	return DEFAULT_COLOR;
};

const to_render_color = (code: number): GhosttyRenderColor | null => {
	if (code === DEFAULT_COLOR) return null;
	if (code < 256) return PALETTE_COLORS[code]!;
	return { kind: 'rgb', rgb: code & 0xff_ffff };
};

/** Append a code point to `units` as UTF-16, returning the new count. */
const push_code_point = (units: Uint16Array, count: number, cp: number): number => {
	if (cp < 0x1_0000) {
		units[count] = cp;
		return count + 1;
	}
	const offset = cp - 0x1_0000;
	units[count] = 0xd800 | (offset >>> 10);
	units[count + 1] = 0xdc00 | (offset & 0x3ff);
	return count + 2;
};

/** The most code units passed to one `String.fromCharCode` call. */
const UNITS_PER_CALL = 1024;

const units_to_string = (units: Uint16Array, count: number): string => {
	if (count === 1) return String.fromCharCode(units[0]!);
	if (count <= UNITS_PER_CALL) {
		return String.fromCharCode.apply(null, units.subarray(0, count) as unknown as Array<number>);
	}
	// a long run in pieces, so no one call takes too many arguments; few pieces, so few joins
	const pieces: Array<string> = [];
	for (let start = 0; start < count; start += UNITS_PER_CALL) {
		pieces.push(
			String.fromCharCode.apply(
				null,
				units.subarray(start, Math.min(start + UNITS_PER_CALL, count)) as unknown as Array<number>
			)
		);
	}
	return pieces.join('');
};

/** Whether two reads of a row drew the same. */
const rows_equal = (a: GhosttyRenderRow, b: GhosttyRenderRow): boolean => {
	if (a.id !== b.id || a.runs.length !== b.runs.length) return false;
	for (let i = 0; i < a.runs.length; i++) {
		const x = a.runs[i]!;
		const y = b.runs[i]!;
		if (
			x.x !== y.x ||
			x.width !== y.width ||
			x.text !== y.text ||
			x.cluster !== y.cluster ||
			x.hyperlink !== y.hyperlink ||
			(x.style !== y.style && x.style.key !== y.style.key)
		) {
			return false;
		}
	}
	return true;
};
