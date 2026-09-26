import { test, describe, assert } from 'vitest';

import { get_unique_name } from '$lib/helpers.ts';

describe('get_unique_name', () => {
	test('returns a name not yet taken as is', () => {
		assert.strictEqual(get_unique_name('chat', new Set(['other'])), 'chat');
	});

	test('suffixes a taken name with the lowest free number from 2', () => {
		assert.strictEqual(get_unique_name('chat', new Set(['chat'])), 'chat 2');
		assert.strictEqual(get_unique_name('chat', new Set(['chat', 'chat 2', 'chat 3'])), 'chat 4');
	});

	test('accepts a `Map` keyed by name', () => {
		assert.strictEqual(get_unique_name('chat', new Map([['chat', 1]])), 'chat 2');
	});
});
