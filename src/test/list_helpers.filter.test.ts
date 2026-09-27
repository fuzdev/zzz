import { test, describe, assert } from 'vitest';

import { create_text_filter } from '$lib/list_helpers.ts';

interface Item {
	path: string;
}

const get_path = (item: Item): string => item.path;

const items: Array<Item> = [
	{ path: '/home/a/src/Foo.ts' },
	{ path: '/home/a/src/bar.ts' },
	{ path: '/home/a/README.md' }
];

describe('create_text_filter', () => {
	test('returns null for a blank query', () => {
		assert.strictEqual(create_text_filter('', get_path), null);
		assert.strictEqual(create_text_filter('   ', get_path), null);
	});

	test('matches substrings ignoring case', () => {
		const filter = create_text_filter('FOO', get_path);
		assert.ok(filter);
		assert.deepEqual(items.filter(filter), [items[0]]);
	});

	test('matches across path segments', () => {
		const filter = create_text_filter('src/b', get_path);
		assert.ok(filter);
		assert.deepEqual(items.filter(filter), [items[1]]);
	});

	test('trims the query', () => {
		const filter = create_text_filter('  readme ', get_path);
		assert.ok(filter);
		assert.deepEqual(items.filter(filter), [items[2]]);
	});

	test('matches nothing when no text contains the query', () => {
		const filter = create_text_filter('nope', get_path);
		assert.ok(filter);
		assert.deepEqual(items.filter(filter), []);
	});
});
