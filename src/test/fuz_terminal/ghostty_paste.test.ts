import { test, describe, assert } from 'vitest';

import {
	GHOSTTY_PASTE_END,
	GHOSTTY_PASTE_FRAME_LENGTH,
	get_ghostty_paste_hazard,
	to_ghostty_paste_length
} from '#lib/fuz_terminal/ghostty_paste.ts';

describe('get_ghostty_paste_hazard', () => {
	test('bracketed, only the end sequence is unsafe', () => {
		for (const text of [
			'hello',
			'a\nb',
			'a\rb',
			'a\r\nb',
			'\n',
			'\x1b[200~',
			'\x1b[201',
			'[201~'
		]) {
			assert.isNull(get_ghostty_paste_hazard(text, true), JSON.stringify(text));
		}
		assert.strictEqual(get_ghostty_paste_hazard(`a${GHOSTTY_PASTE_END}b`, true), 'paste_end');
		assert.strictEqual(get_ghostty_paste_hazard(`a\n${GHOSTTY_PASTE_END}`, true), 'paste_end');
	});

	test('unbracketed, a newline or carriage return is unsafe too, and wins over the end sequence', () => {
		for (const text of ['hello', 'tab\there', '\x1b[200~', ' \u0085', '\x03\x1b']) {
			assert.isNull(get_ghostty_paste_hazard(text, false), JSON.stringify(text));
		}
		for (const text of ['a\nb', 'a\rb', 'trailing\n', '\r']) {
			assert.strictEqual(get_ghostty_paste_hazard(text, false), 'line_break', JSON.stringify(text));
		}
		assert.strictEqual(get_ghostty_paste_hazard(GHOSTTY_PASTE_END, false), 'paste_end');
		// the line break is what runs commands; the end sequence's ESC is replaced anyway
		assert.strictEqual(get_ghostty_paste_hazard(`a\n${GHOSTTY_PASTE_END}`, false), 'line_break');
		assert.strictEqual(get_ghostty_paste_hazard(`${GHOSTTY_PASTE_END}\r`, false), 'line_break');
	});

	test('empty text is safe', () => {
		assert.isNull(get_ghostty_paste_hazard('', false));
		assert.isNull(get_ghostty_paste_hazard('', true));
	});
});

describe('to_ghostty_paste_length', () => {
	test('the text’s length, plus the frame when bracketed', () => {
		assert.strictEqual(GHOSTTY_PASTE_FRAME_LENGTH, '\x1b[200~'.length + GHOSTTY_PASTE_END.length);
		assert.strictEqual(to_ghostty_paste_length('a\r\nb\x1b', false), 5);
		assert.strictEqual(to_ghostty_paste_length('a\r\nb\x1b', true), 17);
		// UTF-16 code units: an astral character is two, a lone surrogate one
		assert.strictEqual(to_ghostty_paste_length('你🙂\ud800', false), 4);
		assert.strictEqual(to_ghostty_paste_length('', true), GHOSTTY_PASTE_FRAME_LENGTH);
	});
});
