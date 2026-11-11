/**
 * Turning the render-state reader's styles and colors into CSS for the DOM
 * renderer — pure functions over plain frame data, no DOM.
 *
 * Colors reach CSS through custom properties on the terminal's root element,
 * never as colors read into JS from the theme:
 *
 * - `--fuz_terminal_fg` / `--fuz_terminal_bg` — the default text color and
 *   background in effect. The stylesheet sets them from the theme; the root's
 *   inline style overrides them once a program has set its own (OSC 10 and
 *   11; `to_fuz_terminal_theme_css`).
 * - `--fuz_terminal_palette_0` … `--fuz_terminal_palette_255` — every palette
 *   entry. The first 16 come from the theme in the stylesheet unless a
 *   program changed one (OSC 4); the rest are the frame's own colors, set
 *   inline.
 * - `--fuz_terminal_cursor` — the cursor's color: the theme's, falling back
 *   to the text color in effect, unless a program set one (OSC 12), which
 *   the view sets on its own.
 *
 * A style's CSS (`to_fuz_terminal_style_css`) names only those properties
 * and colors formatted here from numbers, so it depends on the style alone:
 * a palette change restyles every run through the custom properties without
 * re-rendering a row.
 *
 * @module
 */

import type {
	GhosttyRenderColor,
	GhosttyRenderColors,
	GhosttyRenderStyle,
	GhosttyRenderUnderline
} from './ghostty_render_state.ts';

/** How many palette entries the theme supplies: the base 16 (SGR 30–37, 90–97). */
export const FUZ_TERMINAL_THEME_PALETTE_SIZE = 16;

/** The CSS for the default text color in effect. */
const DEFAULT_FG = 'var(--fuz_terminal_fg)';
/** The CSS for the default background in effect. */
const DEFAULT_BG = 'var(--fuz_terminal_bg)';

/**
 * A `0xRRGGBB` color as a CSS hex color. The value is masked to 24 bits, so
 * whatever number arrives, the result is `#` and six hex digits.
 */
export const format_fuz_terminal_rgb = (rgb: number): string =>
	`#${(rgb & 0xff_ffff).toString(16).padStart(6, '0')}`;

/** The CSS for a color a style sets: its palette entry's custom property, or the RGB value. */
export const to_fuz_terminal_color_css = (color: GhosttyRenderColor): string =>
	color.kind === 'palette'
		? `var(--fuz_terminal_palette_${color.index & 0xff})`
		: format_fuz_terminal_rgb(color.rgb);

const UNDERLINE_STYLES: Readonly<Record<Exclude<GhosttyRenderUnderline, 'none'>, string>> = {
	single: 'solid',
	double: 'double',
	curly: 'wavy',
	dotted: 'dotted',
	dashed: 'dashed'
};

/**
 * A style's CSS declarations, for a run's `style` attribute: `''` for the
 * default style, which inherits everything from the row. Blinking isn't
 * here — it's an animation, drawn by a class.
 *
 * - colors — the style's, else the defaults in effect; `inverse` swaps the
 *   text color and background after resolving the defaults, so default
 *   inverse text is the background color on the text color
 * - `faint` — the text color mixed halfway to transparent, so the
 *   background stays as it is
 * - `invisible` — transparent text and lines, the background kept
 * - `bold`, `italic` — the font's weight and style; bold doesn't brighten
 * - underline (each kind its own line style), `strikethrough`, and `overline`
 *   — `text-decoration` lines, colored by `underline_color` when it's set
 */
// TODO: CSS draws every decoration line in one style and color, so a
// strikethrough on curly or colored underlined text is curly or colored too
export const to_fuz_terminal_style_css = (style: GhosttyRenderStyle): string => {
	let fg = style.fg === null ? null : to_fuz_terminal_color_css(style.fg);
	let bg = style.bg === null ? null : to_fuz_terminal_color_css(style.bg);
	if (style.inverse) {
		const inverse_fg = bg ?? DEFAULT_BG;
		bg = fg ?? DEFAULT_FG;
		fg = inverse_fg;
	}
	const declarations: Array<string> = [];
	if (style.invisible) {
		declarations.push('color: transparent');
	} else if (style.faint) {
		declarations.push(`color: color-mix(in srgb, ${fg ?? DEFAULT_FG} 50%, transparent)`);
	} else if (fg !== null) {
		declarations.push(`color: ${fg}`);
	}
	if (bg !== null) declarations.push(`background-color: ${bg}`);
	if (style.bold) declarations.push('font-weight: bold');
	if (style.italic) declarations.push('font-style: italic');
	const lines: Array<string> = [];
	if (style.underline !== 'none') lines.push('underline');
	if (style.overline) lines.push('overline');
	if (style.strikethrough) lines.push('line-through');
	if (lines.length > 0) {
		declarations.push(`text-decoration-line: ${lines.join(' ')}`);
		if (style.underline !== 'none') {
			declarations.push(`text-decoration-style: ${UNDERLINE_STYLES[style.underline]}`);
		}
		if (style.invisible) {
			declarations.push('text-decoration-color: transparent');
		} else if (style.underline_color !== null && style.underline !== 'none') {
			declarations.push(
				`text-decoration-color: ${to_fuz_terminal_color_css(style.underline_color)}`
			);
		}
	}
	return declarations.join('; ');
};

/** The most styles a `FuzTerminalStyleCache` holds before it starts over. */
export const FUZ_TERMINAL_STYLE_CACHE_MAX = 1024;

/**
 * `to_fuz_terminal_style_css` cached by `GhosttyRenderStyle.key` — equal
 * styles share a key across frames, even when the reader hands out a new
 * object for one. Bounded: once it holds `max` styles it's cleared and
 * refills, so a program that makes unbounded styles (a truecolor gradient)
 * costs recomputing, never memory.
 */
export class FuzTerminalStyleCache {
	readonly #css: Map<string, string> = new Map();
	readonly #max: number;

	/** @param max - the most entries kept; at least 1 */
	constructor(max: number = FUZ_TERMINAL_STYLE_CACHE_MAX) {
		this.#max = Math.max(1, max);
	}

	/** How many styles are cached. */
	get size(): number {
		return this.#css.size;
	}

	/** A style's CSS, computed the first time its key is seen. */
	get(style: GhosttyRenderStyle): string {
		let css = this.#css.get(style.key);
		if (css === undefined) {
			css = to_fuz_terminal_style_css(style);
			if (this.#css.size >= this.#max) this.#css.clear();
			this.#css.set(style.key, css);
		}
		return css;
	}
}

/**
 * The root's inline custom properties for a frame's colors, against
 * `baseline` — the colors the reader reported before any output, the
 * library's own palette and placeholder defaults:
 *
 * - palette entries 16–255 are always the frame's
 * - a base-16 entry is the frame's only where it differs from the baseline
 *   (a program set it with OSC 4); otherwise the theme's, from the stylesheet,
 *   and an OSC 104 reset brings the theme back
 * - the default text color and background are the theme's while they're the
 *   baseline's placeholders, and the frame's once a program has set both
 *   (the library takes them only as a pair) — a program that sets exactly the
 *   placeholders reads as unset
 *
 * Reverse video (DECSCNM) isn't drawn while the defaults are the theme's:
 * the library swaps only colors a program set, so with the placeholders the
 * frame's colors don't change.
 *
 * The result is declarations of custom properties only, built from numbers.
 * The cursor color isn't here: the view sets it on its own property.
 */
// TODO: once the terminal is given the theme's colors, reverse video swaps them
export const to_fuz_terminal_theme_css = (
	colors: GhosttyRenderColors,
	baseline: GhosttyRenderColors
): string => {
	const declarations: Array<string> = [];
	const { foreground, background } = colors;
	if (foreground !== baseline.foreground || background !== baseline.background) {
		declarations.push(
			`--fuz_terminal_fg: ${format_fuz_terminal_rgb(foreground)}`,
			`--fuz_terminal_bg: ${format_fuz_terminal_rgb(background)}`
		);
	}
	const { palette } = colors;
	for (let i = 0; i < palette.length && i < 256; i++) {
		const color = palette[i]!;
		if (i < FUZ_TERMINAL_THEME_PALETTE_SIZE && color === baseline.palette[i]) continue;
		declarations.push(`--fuz_terminal_palette_${i}: ${format_fuz_terminal_rgb(color)}`);
	}
	return declarations.join('; ');
};
