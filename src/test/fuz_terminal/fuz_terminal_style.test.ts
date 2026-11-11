import { test, describe, assert } from 'vitest';

import {
	FuzTerminalStyleCache,
	format_fuz_terminal_rgb,
	to_fuz_terminal_color_css,
	to_fuz_terminal_style_css,
	to_fuz_terminal_theme_css
} from '#lib/fuz_terminal/fuz_terminal_style.ts';
import {
	GHOSTTY_RENDER_DEFAULT_STYLE,
	type GhosttyRenderColor,
	type GhosttyRenderColors,
	type GhosttyRenderStyle,
	type GhosttyRenderUnderline
} from '#lib/fuz_terminal/ghostty_render_state.ts';

const palette = (index: number): GhosttyRenderColor => ({ kind: 'palette', index });
const rgb = (value: number): GhosttyRenderColor => ({ kind: 'rgb', rgb: value });

/** A style: the default with `overrides`, keyed by its fields as the reader's are by value. */
const style = (overrides: Partial<GhosttyRenderStyle> = {}): GhosttyRenderStyle => {
	const fields = { ...GHOSTTY_RENDER_DEFAULT_STYLE, ...overrides };
	return { ...fields, key: overrides.key ?? JSON.stringify({ ...fields, key: undefined }) };
};

/** The declarations of a style's CSS, in order. */
const declarations = (overrides: Partial<GhosttyRenderStyle>): Array<string> => {
	const css = to_fuz_terminal_style_css(style(overrides));
	return css === '' ? [] : css.split('; ');
};

describe('format_fuz_terminal_rgb', () => {
	test('six hex digits, zero-padded, masked to 24 bits', () => {
		assert.strictEqual(format_fuz_terminal_rgb(0), '#000000');
		assert.strictEqual(format_fuz_terminal_rgb(0xff_ffff), '#ffffff');
		assert.strictEqual(format_fuz_terminal_rgb(0x00_0a_0b), '#000a0b');
		assert.strictEqual(format_fuz_terminal_rgb(0x12_34_56), '#123456');
		assert.strictEqual(format_fuz_terminal_rgb(0x1ff_ffff), '#ffffff');
		assert.strictEqual(format_fuz_terminal_rgb(-1), '#ffffff');
	});
});

describe('to_fuz_terminal_color_css', () => {
	test('a palette color is its entry’s custom property, any index', () => {
		assert.strictEqual(to_fuz_terminal_color_css(palette(0)), 'var(--fuz_terminal_palette_0)');
		assert.strictEqual(to_fuz_terminal_color_css(palette(15)), 'var(--fuz_terminal_palette_15)');
		assert.strictEqual(to_fuz_terminal_color_css(palette(255)), 'var(--fuz_terminal_palette_255)');
	});

	test('an RGB color is its hex value', () => {
		assert.strictEqual(to_fuz_terminal_color_css(rgb(0xff_80_00)), '#ff8000');
	});
});

describe('to_fuz_terminal_style_css', () => {
	test('the default style is empty: the row’s text color and background show', () => {
		assert.strictEqual(to_fuz_terminal_style_css(GHOSTTY_RENDER_DEFAULT_STYLE), '');
	});

	test('foreground and background', () => {
		assert.deepEqual(declarations({ fg: palette(1) }), ['color: var(--fuz_terminal_palette_1)']);
		assert.deepEqual(declarations({ bg: rgb(0x10_20_30) }), ['background-color: #102030']);
		assert.deepEqual(declarations({ fg: rgb(0xff_ff_ff), bg: palette(200) }), [
			'color: #ffffff',
			'background-color: var(--fuz_terminal_palette_200)'
		]);
	});

	test('inverse swaps the resolved colors, defaults included', () => {
		assert.deepEqual(declarations({ inverse: true }), [
			'color: var(--fuz_terminal_bg)',
			'background-color: var(--fuz_terminal_fg)'
		]);
		assert.deepEqual(declarations({ inverse: true, fg: palette(2) }), [
			'color: var(--fuz_terminal_bg)',
			'background-color: var(--fuz_terminal_palette_2)'
		]);
		assert.deepEqual(declarations({ inverse: true, bg: palette(4) }), [
			'color: var(--fuz_terminal_palette_4)',
			'background-color: var(--fuz_terminal_fg)'
		]);
		assert.deepEqual(declarations({ inverse: true, fg: rgb(0x11), bg: rgb(0x22) }), [
			'color: #000022',
			'background-color: #000011'
		]);
	});

	test('faint mixes the text color toward transparent, inverse or not', () => {
		assert.deepEqual(declarations({ faint: true }), [
			'color: color-mix(in srgb, var(--fuz_terminal_fg) 50%, transparent)'
		]);
		assert.deepEqual(declarations({ faint: true, fg: palette(3), bg: palette(5) }), [
			'color: color-mix(in srgb, var(--fuz_terminal_palette_3) 50%, transparent)',
			'background-color: var(--fuz_terminal_palette_5)'
		]);
		assert.deepEqual(declarations({ faint: true, inverse: true }), [
			'color: color-mix(in srgb, var(--fuz_terminal_bg) 50%, transparent)',
			'background-color: var(--fuz_terminal_fg)'
		]);
	});

	test('invisible keeps the background and hides the text and its lines', () => {
		assert.deepEqual(declarations({ invisible: true }), ['color: transparent']);
		assert.deepEqual(declarations({ invisible: true, fg: palette(1), bg: palette(2) }), [
			'color: transparent',
			'background-color: var(--fuz_terminal_palette_2)'
		]);
		assert.deepEqual(
			declarations({
				invisible: true,
				faint: true,
				underline: 'single',
				underline_color: palette(9),
				strikethrough: true
			}),
			[
				'color: transparent',
				'text-decoration-line: underline line-through',
				'text-decoration-style: solid',
				'text-decoration-color: transparent'
			]
		);
		// inverse invisible: the swapped background, still no text
		assert.deepEqual(declarations({ invisible: true, inverse: true }), [
			'color: transparent',
			'background-color: var(--fuz_terminal_fg)'
		]);
	});

	test('bold and italic', () => {
		assert.deepEqual(declarations({ bold: true }), ['font-weight: bold']);
		assert.deepEqual(declarations({ italic: true }), ['font-style: italic']);
		assert.deepEqual(declarations({ bold: true, italic: true, fg: palette(1) }), [
			'color: var(--fuz_terminal_palette_1)',
			'font-weight: bold',
			'font-style: italic'
		]);
	});

	test('each underline kind is its line style', () => {
		const kinds: Array<[GhosttyRenderUnderline, string]> = [
			['single', 'solid'],
			['double', 'double'],
			['curly', 'wavy'],
			['dotted', 'dotted'],
			['dashed', 'dashed']
		];
		for (const [underline, line_style] of kinds) {
			assert.deepEqual(
				declarations({ underline }),
				['text-decoration-line: underline', `text-decoration-style: ${line_style}`],
				underline
			);
		}
	});

	test('an underline color colors the lines, and only with an underline', () => {
		assert.deepEqual(declarations({ underline: 'curly', underline_color: rgb(0xff_00_00) }), [
			'text-decoration-line: underline',
			'text-decoration-style: wavy',
			'text-decoration-color: #ff0000'
		]);
		assert.deepEqual(declarations({ underline_color: palette(1) }), []);
		assert.deepEqual(declarations({ strikethrough: true, underline_color: palette(1) }), [
			'text-decoration-line: line-through'
		]);
	});

	test('strikethrough and overline, alone and with an underline', () => {
		assert.deepEqual(declarations({ strikethrough: true }), ['text-decoration-line: line-through']);
		assert.deepEqual(declarations({ overline: true }), ['text-decoration-line: overline']);
		assert.deepEqual(declarations({ underline: 'double', overline: true, strikethrough: true }), [
			'text-decoration-line: underline overline line-through',
			'text-decoration-style: double'
		]);
	});

	test('blink adds nothing here: it’s a class', () => {
		assert.deepEqual(declarations({ blink: true }), []);
	});

	test('everything at once, in a fixed order', () => {
		assert.deepEqual(
			declarations({
				fg: palette(1),
				bg: rgb(0x20_20_20),
				underline_color: palette(3),
				bold: true,
				italic: true,
				faint: true,
				blink: true,
				inverse: true,
				strikethrough: true,
				overline: true,
				underline: 'dashed'
			}),
			[
				'color: color-mix(in srgb, #202020 50%, transparent)',
				'background-color: var(--fuz_terminal_palette_1)',
				'font-weight: bold',
				'font-style: italic',
				'text-decoration-line: underline overline line-through',
				'text-decoration-style: dashed',
				'text-decoration-color: var(--fuz_terminal_palette_3)'
			]
		);
	});

	test('a program-chosen color never reaches the CSS as anything but a formatted number', () => {
		// an RGB value from the reader is a number; anything above 24 bits is masked off
		const css = to_fuz_terminal_style_css(style({ fg: rgb(0x7fff_ffff), bg: palette(300) }));
		assert.strictEqual(css, 'color: #ffffff; background-color: var(--fuz_terminal_palette_44)');
	});
});

describe('FuzTerminalStyleCache', () => {
	test('caches by key: an equal style that is a new object hits', () => {
		const cache = new FuzTerminalStyleCache();
		const a = style({ fg: palette(1), key: 'k1' });
		assert.strictEqual(cache.get(a), 'color: var(--fuz_terminal_palette_1)');
		// the same key returns what was computed for it, whatever the object
		const b = { ...a };
		assert.strictEqual(cache.get(b), 'color: var(--fuz_terminal_palette_1)');
		assert.strictEqual(cache.size, 1);
		cache.get(style({ bold: true, key: 'k2' }));
		assert.strictEqual(cache.size, 2);
	});

	test('bounded: it starts over once full', () => {
		const cache = new FuzTerminalStyleCache(3);
		for (let i = 0; i < 3; i++) cache.get(style({ fg: rgb(i), key: `k${i}` }));
		assert.strictEqual(cache.size, 3);
		assert.strictEqual(cache.get(style({ fg: rgb(9), key: 'k9' })), 'color: #000009');
		assert.strictEqual(cache.size, 1);
		// a style dropped by the clear is computed again, correctly
		assert.strictEqual(cache.get(style({ fg: rgb(1), key: 'k1' })), 'color: #000001');
		assert.strictEqual(cache.size, 2);
	});
});

describe('to_fuz_terminal_theme_css', () => {
	const PLACEHOLDER_FG = 0xff_ff_ff;
	const PLACEHOLDER_BG = 0x00_00_00;
	const default_palette = Array.from({ length: 256 }, (_, i) => (i * 0x01_01_01) & 0xff_ffff);
	const baseline: GhosttyRenderColors = {
		foreground: PLACEHOLDER_FG,
		background: PLACEHOLDER_BG,
		cursor: null,
		palette: default_palette
	};
	const colors = (overrides: Partial<GhosttyRenderColors>): GhosttyRenderColors => ({
		...baseline,
		...overrides
	});
	/** The declarations, without the always-present entries 16–255. */
	const own = (css: string): Array<string> =>
		css
			.split('; ')
			.filter(
				(d) => !/^--fuz_terminal_palette_(\d+):/.test(d) || Number(/_(\d+):/.exec(d)![1]) < 16
			);

	test('the baseline: only palette entries 16–255, each the frame’s', () => {
		const css = to_fuz_terminal_theme_css(baseline, baseline);
		const parts = css.split('; ');
		assert.strictEqual(parts.length, 240);
		assert.strictEqual(parts[0], '--fuz_terminal_palette_16: #101010');
		assert.strictEqual(parts[239], '--fuz_terminal_palette_255: #ffffff');
		assert.deepEqual(own(css), []);
	});

	test('a base-16 entry a program changed wins over the theme, and a reset gives it back', () => {
		const changed = [...default_palette];
		changed[1] = 0xab_cd_ef;
		changed[15] = 0x01_02_03;
		changed[100] = 0x11_11_11;
		const css = to_fuz_terminal_theme_css(colors({ palette: changed }), baseline);
		assert.deepEqual(own(css), [
			'--fuz_terminal_palette_1: #abcdef',
			'--fuz_terminal_palette_15: #010203'
		]);
		assert.include(css, '--fuz_terminal_palette_100: #111111');
		assert.deepEqual(
			own(to_fuz_terminal_theme_css(colors({ palette: [...default_palette] }), baseline)),
			[]
		);
	});

	test('default colors: the placeholders are the theme’s; both set are the program’s', () => {
		assert.deepEqual(
			own(
				to_fuz_terminal_theme_css(
					colors({ foreground: 0x11_22_33, background: 0x44_55_66 }),
					baseline
				)
			),
			['--fuz_terminal_fg: #112233', '--fuz_terminal_bg: #445566']
		);
	});

	test('the defaults swapped are the program’s own: black on white stays black on white', () => {
		// the library swaps only colors a program set, so this is a program that
		// set exactly black on white — drawn as asked, never as the theme swapped
		assert.deepEqual(
			own(
				to_fuz_terminal_theme_css(
					colors({ foreground: PLACEHOLDER_BG, background: PLACEHOLDER_FG }),
					baseline
				)
			),
			['--fuz_terminal_fg: #000000', '--fuz_terminal_bg: #ffffff']
		);
	});

	test('the cursor color isn’t here: the view sets it on its own property', () => {
		assert.deepEqual(own(to_fuz_terminal_theme_css(colors({ cursor: 0x00_ff_00 }), baseline)), []);
	});
});
