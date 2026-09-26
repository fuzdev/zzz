// @vitest-environment jsdom

import { test, assert, describe } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

import { IndexedCollection } from '$lib/indexed_collection.svelte.ts';
import {
	create_single_index,
	create_multi_index,
	create_derived_index
} from '$lib/indexed_collection_helpers.svelte.ts';

/** An item with reactive fields, like a cell. */
class Item {
	readonly id: Uuid = create_uuid();
	name: string = $state.raw()!;
	group: string = $state.raw()!;
	tags: Array<string> = $state.raw()!;
	disposed = 0;

	constructor(name: string, group = 'g', tags: Array<string> = []) {
		this.name = name;
		this.group = group;
		this.tags = tags;
	}

	dispose(): void {
		this.disposed++;
	}
}

const create_collection = (): IndexedCollection<Item> =>
	new IndexedCollection({
		indexes: [
			create_single_index({ key: 'by_name', extractor: (item) => item.name }),
			create_multi_index({ key: 'by_group', extractor: (item) => item.group }),
			create_multi_index({
				key: 'by_tag',
				extractor: (item) => item.tags,
				matches: (item) => item.tags.length > 0
			})
		]
	});

describe('reactive single and multi indexes', () => {
	test('a single index follows a renamed item', () => {
		const collection = create_collection();
		const a = new Item('a');
		collection.add(a);
		assert.strictEqual(collection.by_optional('by_name', 'a'), a);

		a.name = 'renamed';

		assert.isUndefined(collection.by_optional('by_name', 'a'));
		assert.strictEqual(collection.by_optional('by_name', 'renamed'), a);
		assert.ok(collection.single_index('by_name').has('renamed'));
	});

	test('a renamed item that is then removed leaves no entry under either name', () => {
		const collection = create_collection();
		const a = new Item('a');
		collection.add(a);
		a.name = 'renamed';
		collection.remove(a.id);

		assert.strictEqual(collection.single_index('by_name').size, 0);
	});

	test('an item renamed onto an existing name takes it, and the old holder regains it when removed', () => {
		const collection = create_collection();
		const a = new Item('a');
		const b = new Item('b');
		collection.add_many([a, b]);

		b.name = 'a';
		assert.strictEqual(collection.by_optional('by_name', 'a'), b); // later items win
		assert.isUndefined(collection.by_optional('by_name', 'b'));

		collection.remove(b.id);
		assert.strictEqual(collection.by_optional('by_name', 'a'), a);
	});

	test('a multi index moves an item between buckets when its key changes', () => {
		const collection = create_collection();
		const a = new Item('a', 'g1');
		const b = new Item('b', 'g1');
		collection.add_many([a, b]);
		assert.deepEqual(collection.where('by_group', 'g1'), [a, b]);

		a.group = 'g2';

		assert.deepEqual(collection.where('by_group', 'g1'), [b]);
		assert.deepEqual(collection.where('by_group', 'g2'), [a]);
	});

	test('a multi index follows array keys and `matches`', () => {
		const collection = create_collection();
		const a = new Item('a', 'g', []);
		collection.add(a);
		assert.deepEqual(collection.where('by_tag', 'x'), []);

		a.tags = ['x', 'y'];
		assert.deepEqual(collection.where('by_tag', 'x'), [a]);
		assert.deepEqual(collection.where('by_tag', 'y'), [a]);

		a.tags = [];
		assert.strictEqual(collection.multi_index('by_tag').size, 0);
	});

	test('a multi index keeps its sort when a sorted field changes', () => {
		const collection: IndexedCollection<Item> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_group',
					extractor: (item) => item.group,
					sort: (x, y) => x.name.localeCompare(y.name)
				})
			]
		});
		const a = new Item('a');
		const b = new Item('b');
		collection.add_many([b, a]);
		assert.deepEqual(collection.where('by_group', 'g'), [a, b]);

		a.name = 'c';
		assert.deepEqual(collection.where('by_group', 'g'), [b, a]);
	});

	test('reads are memoized until the collection or an indexed field changes', () => {
		let extract_count = 0;
		const collection: IndexedCollection<Item> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_name',
					extractor: (item) => {
						extract_count++;
						return item.name;
					}
				})
			]
		});
		const a = new Item('a');
		const b = new Item('b');
		collection.add_many([a, b]);

		collection.by_optional('by_name', 'a');
		const count = extract_count;
		collection.by_optional('by_name', 'a');
		collection.by_optional('by_name', 'b');
		collection.single_index('by_name').has('a');
		assert.strictEqual(extract_count, count);

		b.group = 'unindexed field';
		collection.by_optional('by_name', 'a');
		assert.strictEqual(extract_count, count);

		b.name = 'c';
		collection.by_optional('by_name', 'a');
		assert.strictEqual(extract_count, count + 2);
	});

	test('a reactive index cannot be assigned', () => {
		const collection = create_collection();
		assert.throws(() => {
			collection.indexes.by_name = new Map();
		}, /reactive index/);
	});
});

describe('immutable_key indexes', () => {
	const create_immutable_collection = (): IndexedCollection<Item> =>
		new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_name',
					extractor: (item) => item.name,
					matches: (item) => item.group !== 'excluded',
					immutable_key: true
				}),
				create_multi_index({
					key: 'by_group',
					extractor: (item) => item.group,
					immutable_key: true
				})
			]
		});

	test('are maintained on add and remove', () => {
		const collection = create_immutable_collection();
		const a = new Item('a', 'g1');
		const b = new Item('b', 'g1');
		collection.add_many([a, b]);

		assert.strictEqual(collection.by_optional('by_name', 'a'), a);
		assert.deepEqual(collection.where('by_group', 'g1'), [a, b]);

		collection.remove(a.id);
		assert.isUndefined(collection.by_optional('by_name', 'a'));
		assert.deepEqual(collection.where('by_group', 'g1'), [b]);

		collection.clear();
		assert.strictEqual(collection.single_index('by_name').size, 0);
		assert.strictEqual(collection.multi_index('by_group').size, 0);
	});

	test('removing the holder of a shared key falls back to the last remaining match, like a rebuild', () => {
		const collection = create_immutable_collection();
		const first = new Item('shared');
		const excluded = new Item('shared', 'excluded');
		const middle = new Item('shared');
		const last = new Item('shared');
		collection.add_many([first, excluded, middle, last]);
		assert.strictEqual(collection.by_optional('by_name', 'shared'), last);

		collection.remove(last.id);
		assert.strictEqual(collection.by_optional('by_name', 'shared'), middle);

		collection.remove(middle.id);
		assert.strictEqual(collection.by_optional('by_name', 'shared'), first); // not `excluded`
	});

	test('`remove_many` never falls back to another item being removed, in either order', () => {
		for (const order of [
			['c', 'b'],
			['b', 'c']
		] as const) {
			const collection = create_immutable_collection();
			const items = { a: new Item('k'), b: new Item('k'), c: new Item('k') };
			collection.add_many([items.a, items.b, items.c]);

			assert.strictEqual(collection.remove_many(order.map((key) => items[key].id)), 2);

			assert.strictEqual(collection.by_optional('by_name', 'k'), items.a, `order ${order}`);
		}
	});

	test('`remove_many` removes every item of a shared key, and dedupes ids', () => {
		const collection = create_immutable_collection();
		const a = new Item('k', 'g');
		const b = new Item('k', 'g');
		collection.add_many([a, b]);

		assert.strictEqual(collection.remove_many([b.id, a.id, b.id]), 2);

		assert.strictEqual(collection.single_index('by_name').size, 0);
		assert.strictEqual(collection.multi_index('by_group').size, 0);
	});
});

describe('incremental derived indexes', () => {
	test('can still be replaced by assignment', () => {
		const collection: IndexedCollection<Item> = new IndexedCollection({
			indexes: [create_derived_index({ key: 'order', compute: (c) => c.values })]
		});
		const a = new Item('a');
		const b = new Item('b');
		collection.add_many([a, b]);
		assert.deepEqual(collection.derived_index('order'), [a, b]);

		collection.indexes.order = [b, a];
		assert.deepEqual(collection.derived_index('order'), [b, a]);

		const c = new Item('c');
		collection.add(c);
		assert.deepEqual(collection.derived_index('order'), [b, a, c]);
	});

	test('`sort` never reorders the array `compute` returns', () => {
		const c = new Item('c');
		const a = new Item('a');
		const b = new Item('b');
		const source = [c, a, b];
		const collection: IndexedCollection<Item> = new IndexedCollection({
			indexes: [
				create_derived_index({
					key: 'sorted',
					compute: () => source,
					sort: (x, y) => x.name.localeCompare(y.name)
				})
			]
		});
		assert.deepEqual(collection.derived_index('sorted'), [a, b, c]);
		assert.deepEqual(source, [c, a, b]);
	});

	test('a sorted index over `collection.values` leaves `values` in insertion order', () => {
		const collection: IndexedCollection<Item> = new IndexedCollection({
			indexes: [
				create_derived_index({
					key: 'ordered_by_name',
					compute: (c) => c.values,
					sort: (x, y) => x.name.localeCompare(y.name)
				})
			]
		});
		const c = new Item('c');
		const a = new Item('a');
		const b = new Item('b');
		collection.add_many([c, a, b]);
		assert.deepEqual(collection.derived_index('ordered_by_name'), [a, b, c]);
		assert.deepEqual(collection.values, [c, a, b]);

		collection.clear();
		collection.add_many([b, c, a]);
		assert.deepEqual(collection.derived_index('ordered_by_name'), [a, b, c]);
		assert.deepEqual(collection.values, [b, c, a]);
	});
});

describe('dispose_item', () => {
	const create_owning_collection = (): IndexedCollection<Item> =>
		new IndexedCollection({
			dispose_item: (item) => item.dispose(),
			indexes: [create_single_index({ key: 'by_name', extractor: (item) => item.name })]
		});

	test('disposes items removed by `remove`', () => {
		const collection = create_owning_collection();
		const a = new Item('a');
		const b = new Item('b');
		collection.add_many([a, b]);
		assert.strictEqual(a.disposed, 0);

		assert.ok(collection.remove(a.id));
		assert.strictEqual(a.disposed, 1);
		assert.strictEqual(b.disposed, 0);

		assert.ok(!collection.remove(a.id));
		assert.strictEqual(a.disposed, 1);
	});

	test('disposes items removed by `remove_many`', () => {
		const collection = create_owning_collection();
		const a = new Item('a');
		const b = new Item('b');
		const c = new Item('c');
		collection.add_many([a, b, c]);

		assert.strictEqual(collection.remove_many([a.id, c.id, a.id, create_uuid()]), 2);
		assert.deepEqual(
			[a, b, c].map((item) => item.disposed),
			[1, 0, 1]
		);
	});

	test('disposes items removed by `clear`, after they leave the collection', () => {
		const collection = create_owning_collection();
		const a = new Item('a');
		const b = new Item('b');
		collection.add_many([a, b]);
		let size_at_dispose: number | null = null;
		a.dispose = () => {
			size_at_dispose = collection.size;
		};

		collection.clear();

		assert.strictEqual(size_at_dispose, 0);
		assert.strictEqual(b.disposed, 1);
		assert.strictEqual(collection.single_index('by_name').size, 0);
	});

	test('does not dispose without the option', () => {
		const collection = create_collection();
		const a = new Item('a');
		collection.add(a);
		collection.remove(a.id);
		collection.add(a);
		collection.clear();
		assert.strictEqual(a.disposed, 0);
	});
});
