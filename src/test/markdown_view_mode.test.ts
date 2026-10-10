import { describe, test, assert } from 'vitest';

import {
	MARKDOWN_VIEW_MODES,
	MARKDOWN_VIEW_MODE_SHORTCUTS,
	to_markdown_view_mode_for_shortcut
} from '$lib/markdown_view_mode.ts';

const key = (code: string, init: Partial<KeyboardEventInit> = {}) => ({
	ctrlKey: true,
	shiftKey: true,
	altKey: false,
	metaKey: false,
	code,
	...init
});

describe('to_markdown_view_mode_for_shortcut', () => {
	test('Ctrl+Shift+1/2/3 pick the modes in order, by physical key', () => {
		assert.strictEqual(to_markdown_view_mode_for_shortcut(key('Digit1')), 'split');
		assert.strictEqual(to_markdown_view_mode_for_shortcut(key('Digit2')), 'preview');
		assert.strictEqual(to_markdown_view_mode_for_shortcut(key('Digit3')), 'source');
		assert.strictEqual(to_markdown_view_mode_for_shortcut(key('Numpad2')), 'preview');
	});

	test('the shortcuts shown match the order', () => {
		MARKDOWN_VIEW_MODES.forEach((mode, i) => {
			assert.strictEqual(MARKDOWN_VIEW_MODE_SHORTCUTS[mode], `Ctrl+Shift+${i + 1}`);
		});
	});

	test('any other combination is not a shortcut', () => {
		for (const init of [
			{ ctrlKey: false },
			{ shiftKey: false },
			{ altKey: true },
			{ metaKey: true }
		]) {
			assert.isNull(to_markdown_view_mode_for_shortcut(key('Digit1', init)), JSON.stringify(init));
		}
		assert.isNull(to_markdown_view_mode_for_shortcut(key('Digit4')));
		assert.isNull(to_markdown_view_mode_for_shortcut(key('KeyS')));
	});
});
