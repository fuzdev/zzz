import { test, describe, assert } from 'vitest';

import { sort_with_hint } from '$lib/sortable.svelte.ts';

interface Item {
	key: number;
}

const compare = (a: Item, b: Item): number => a.key - b.key;

const create_items = (keys: Array<number>): Array<Item> => keys.map((key) => ({ key }));

const keys_of = (items: Array<Item>): Array<number> => items.map((item) => item.key);

describe('sort_with_hint', () => {
	test('without a hint, sorts a copy', () => {
		const items = create_items([3, 1, 2]);
		const sorted = sort_with_hint(items, compare, null);
		assert.deepEqual(keys_of(sorted), [1, 2, 3]);
		assert.notStrictEqual(sorted, items);
		assert.deepEqual(keys_of(items), [3, 1, 2], 'the input is not mutated');
	});

	test('an empty hint sorts like no hint', () => {
		const items = create_items([2, 1]);
		assert.deepEqual(keys_of(sort_with_hint(items, compare, [])), [1, 2]);
	});

	test('adds new items and drops removed ones', () => {
		const items = create_items([5, 3, 1, 4]);
		const [i5, i3, i1, i4] = items;
		assert.ok(i5 && i3 && i1 && i4);
		const hint = sort_with_hint(items, compare, null);
		const i2: Item = { key: 2 };
		const next = [i5, i1, i4, i2]; // removed 3, added 2
		const sorted = sort_with_hint(next, compare, hint);
		assert.deepEqual(keys_of(sorted), [1, 2, 4, 5]);
		assert.deepEqual(sorted, [i1, i2, i4, i5]);
	});

	test('re-sorts items whose keys changed since the hint', () => {
		const items = create_items([1, 2, 3]);
		const hint = sort_with_hint(items, compare, null);
		items[0]!.key = 10;
		assert.deepEqual(keys_of(sort_with_hint(items, compare, hint)), [2, 3, 10]);
	});

	test('a reversed hint still sorts correctly', () => {
		const items = create_items([1, 2, 3, 4]);
		const hint = [...items].reverse();
		assert.deepEqual(keys_of(sort_with_hint(items, compare, hint)), [1, 2, 3, 4]);
	});

	test('hint items not in the list are ignored', () => {
		const items = create_items([2, 1]);
		const stranger: Item = { key: 0 };
		const sorted = sort_with_hint(items, compare, [stranger, ...items]);
		assert.deepEqual(keys_of(sorted), [1, 2]);
		assert.ok(!sorted.includes(stranger));
	});

	test('keeps duplicate items', () => {
		const item: Item = { key: 1 };
		const other: Item = { key: 0 };
		const sorted = sort_with_hint([item, other, item], compare, [item, other]);
		assert.deepEqual(sorted, [other, item, item]);
	});

	test('matches a plain sort item by item for random changes', () => {
		// keys repeat, so ties are broken by a unique id to make the order total
		interface IdItem {
			key: number;
			id: number;
		}
		const compare_total = (a: IdItem, b: IdItem): number => a.key - b.key || a.id - b.id;
		let next_id = 0;
		const create = (key: number): IdItem => ({ key, id: next_id++ });
		let items = Array.from({ length: 200 }, (_, i) => create((i * 7919) % 23));
		let hint: Array<IdItem> | null = null;
		for (let round = 0; round < 20; round++) {
			// remove a few, add a few, and change a key
			items = items.filter((_, i) => (i + round) % 17 !== 0);
			items.push(create(round % 23), create((round * 5 + 1) % 23));
			items[round]!.key = (round * 11) % 23;
			const sorted: Array<IdItem> = sort_with_hint(items, compare_total, hint);
			const expected = [...items].sort(compare_total);
			assert.strictEqual(sorted.length, expected.length);
			for (let i = 0; i < expected.length; i++) {
				assert.strictEqual(sorted[i], expected[i], `round ${round}, index ${i}`);
			}
			hint = sorted;
		}
	});
});
