import { test, describe, assert } from 'vitest';

import {
	GHOSTTY_KEY_MODS as M,
	to_classic_ctrl_chord_bytes,
	type GhosttyKeyInput
} from '#lib/fuz_terminal/ghostty_key_encoder.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const ctrl_bracket: GhosttyKeyInput = {
	action: 'press',
	key: 'BRACKET_LEFT',
	mods: M.ctrl,
	text: '[',
	unshifted_codepoint: 91
};

describe('to_classic_ctrl_chord_bytes', () => {
	test('rewrites the library’s fixterms form for the chord', () => {
		assert.deepEqual(to_classic_ctrl_chord_bytes(ctrl_bracket, bytes('\x1b[91;5u')), bytes('\x1b'));
		assert.deepEqual(
			to_classic_ctrl_chord_bytes(
				{ ...ctrl_bracket, mods: M.ctrl | M.alt | M.caps_lock | M.ctrl_right },
				bytes('\x1b[91;7u')
			),
			bytes('\x1b\x1b')
		);
	});

	test('keeps any other form: modifyOtherKeys’, the Kitty protocol’s with event types, a C0 byte', () => {
		for (const out of ['\x1b[27;5;91~', '\x1b[91;5:1u', '\x1b', '\x1b[91u', '']) {
			assert.isNull(to_classic_ctrl_chord_bytes(ctrl_bracket, bytes(out)), JSON.stringify(out));
		}
	});

	test('keeps a release, Super, Alt used up making the text, and no Ctrl', () => {
		const out = bytes('\x1b[91;5u');
		assert.isNull(to_classic_ctrl_chord_bytes({ ...ctrl_bracket, action: 'release' }, out));
		assert.isNull(to_classic_ctrl_chord_bytes({ ...ctrl_bracket, mods: M.ctrl | M.super }, out));
		assert.isNull(to_classic_ctrl_chord_bytes({ ...ctrl_bracket, mods: M.alt }, out));
		// Alt a caller says made the text: Ctrl+[ without the prefix
		assert.deepEqual(
			to_classic_ctrl_chord_bytes(
				{ ...ctrl_bracket, mods: M.ctrl | M.alt, consumed_mods: M.alt },
				out
			),
			bytes('\x1b')
		);
	});

	test('the character: one-byte text, else the physical key with Ctrl alone', () => {
		const out = bytes('\x1b[252;5u');
		assert.deepEqual(
			to_classic_ctrl_chord_bytes({ ...ctrl_bracket, text: 'ü', unshifted_codepoint: 252 }, out),
			bytes('\x1b')
		);
		// with Shift as well, the key's character isn't taken
		assert.isNull(
			to_classic_ctrl_chord_bytes(
				{ ...ctrl_bracket, mods: M.ctrl | M.shift, text: 'Ü', unshifted_codepoint: 252 },
				out
			)
		);
		// text that is one byte wins over the key
		assert.isNull(
			to_classic_ctrl_chord_bytes({ ...ctrl_bracket, text: 'x' }, bytes('\x1b[120;5u'))
		);
	});
});
