/**
 * The plain, immutable data a frame reader produces and a renderer draws
 * from: the update's dirtiness, rows of styled runs placed on their columns,
 * the cursor, and the colors.
 *
 * None of it references wasm memory, and none of it is mutated: a value that
 * changes is replaced, so comparing references tells a renderer what to
 * redraw. `GhosttyRenderState` (`ghostty_render_state.ts`) reads it from the
 * library; the renderer's pure helpers take it without that dependency.
 *
 * @module
 */

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
