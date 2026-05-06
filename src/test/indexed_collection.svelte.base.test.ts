// @vitest-environment jsdom

import {test, assert, describe} from 'vitest';
import {z} from 'zod';
import {create_uuid, Uuid} from '@fuzdev/fuz_util/id.js';

import {IndexedCollection} from '$lib/indexed_collection.svelte.js';
import {
	create_single_index,
	create_multi_index,
	create_derived_index,
	create_dynamic_index,
	type IndexedItem,
} from '$lib/indexed_collection_helpers.svelte.js';

// Mock item type that implements IndexedItem
interface TestItem {
	id: Uuid;
	text: string;
	category: string;
	list: Array<string>;
	date: Date;
	number: number;
}

// Helper function to create test items with predictable values
const create_item = (
	text: string,
	category: string,
	list: Array<string> = [],
	number: number = 0,
): TestItem => ({
	id: create_uuid(),
	text,
	category,
	list,
	date: new Date(),
	number,
});

// Helper functions for id-based equality checks
const has_item_with_id = (items: Iterable<TestItem>, item: TestItem): boolean => {
	for (const i of items) {
		if (i.id === item.id) return true;
	}
	return false;
};

describe('IndexedCollection - Base Functionality', () => {
	test('basic operations with no indexes', () => {
		// Create a collection with no indexes
		const collection: IndexedCollection<TestItem> = new IndexedCollection();

		// Add items
		const item1 = create_item('a1', 'c1');
		const item2 = create_item('a2', 'c2');

		collection.add(item1);
		collection.add(item2);

		// Check size and content
		assert.strictEqual(collection.size, 2);
		// Use id-based comparison with by_id.values()
		assert.ok(has_item_with_id(collection.by_id.values(), item1));
		assert.ok(has_item_with_id(collection.by_id.values(), item2));

		// Test retrieval by id
		assert.strictEqual(collection.get(item1.id)?.id, item1.id);

		// Test removal
		assert.ok(collection.remove(item1.id));
		assert.strictEqual(collection.size, 1);
		assert.isUndefined(collection.get(item1.id));
		assert.strictEqual(collection.get(item2.id)?.id, item2.id);
	});

	test('single index operations', () => {
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_text',
					extractor: (item) => item.text,
					query_schema: z.string(),
				}),
			],
		});

		// Add items with unique identifiers
		const item1 = create_item('a1', 'c1');
		const item2 = create_item('a2', 'c1');
		const item3 = create_item('a3', 'c2');

		collection.add(item1);
		collection.add(item2);
		collection.add(item3);

		// Test lookup by single index
		assert.strictEqual(collection.by_optional<string>('by_text', 'a1')?.id, item1.id);
		assert.strictEqual(collection.by_optional<string>('by_text', 'a2')?.id, item2.id);
		assert.strictEqual(collection.by_optional<string>('by_text', 'a3')?.id, item3.id);
		assert.isUndefined(collection.by_optional<string>('by_text', 'missing'));

		// Test the non-optional version that throws
		assert.throws(() => collection.by<string>('by_text', 'missing'));
		assert.strictEqual(collection.by<string>('by_text', 'a1').id, item1.id);

		// Test query method
		assert.strictEqual(collection.query<TestItem, string>('by_text', 'a1').id, item1.id);

		// Test index update on removal
		collection.remove(item2.id);
		assert.isUndefined(collection.by_optional<string>('by_text', 'a2'));
		assert.strictEqual(collection.size, 2);
	});
});

describe('IndexedCollection - Index Types', () => {
	test('multi index operations', () => {
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_category',
					extractor: (item) => item.category,
					query_schema: z.string(),
				}),
			],
		});

		// Add items with shared category keys
		const item1 = create_item('a1', 'c1');
		const item2 = create_item('a2', 'c1');
		const item3 = create_item('a3', 'c2');
		const item4 = create_item('a4', 'c2');

		collection.add(item1);
		collection.add(item2);
		collection.add(item3);
		collection.add(item4);

		// Test multi-index lookup
		assert.strictEqual(collection.where<string>('by_category', 'c1').length, 2);
		const c1_items = collection.where<string>('by_category', 'c1');
		assert.ok(c1_items.some((item) => item.id === item1.id));
		assert.ok(c1_items.some((item) => item.id === item2.id));

		assert.strictEqual(collection.where<string>('by_category', 'c2').length, 2);
		const c2_items = collection.where<string>('by_category', 'c2');
		assert.ok(c2_items.some((item) => item.id === item3.id));
		assert.ok(c2_items.some((item) => item.id === item4.id));

		// Test first/latest with limit
		assert.strictEqual(collection.first<string>('by_category', 'c1', 1).length, 1);
		assert.strictEqual(collection.latest<string>('by_category', 'c2', 1).length, 1);

		// Test index update on removal
		collection.remove(item1.id);
		assert.strictEqual(collection.where<string>('by_category', 'c1').length, 1);
		assert.strictEqual(collection.where<string>('by_category', 'c1')[0]!.id, item2.id);
	});

	test('derived index operations', () => {
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_derived_index({
					key: 'high_numbers',
					compute: (collection) => {
						const result = [];
						for (const item of collection.by_id.values()) {
							if (item.number > 5) {
								result.push(item);
							}
						}
						return result;
					},
					matches: (item) => item.number > 5,
					sort: (a, b) => b.number - a.number,
					query_schema: z.void(),
				}),
			],
		});

		// Add items with various numbers
		const medium_item = create_item('a1', 'c1', [], 8);
		const low_item = create_item('a2', 'c2', [], 3);
		const high_item = create_item('a3', 'c1', [], 10);
		const threshold_item = create_item('a4', 'c2', [], 6);

		collection.add(medium_item);
		collection.add(low_item);
		collection.add(high_item);
		collection.add(threshold_item);

		// Check derived index
		const high_numbers = collection.derived_index('high_numbers');
		assert.strictEqual(high_numbers.length, 3);
		// Compare by id instead of reference
		assert.strictEqual(high_numbers[0]!.id, high_item.id); // Highest number first (10)
		assert.strictEqual(high_numbers[1]!.id, medium_item.id); // Second number (8)
		assert.strictEqual(high_numbers[2]!.id, threshold_item.id); // Third number (6)
		assert.ok(!high_numbers.some((item) => item.id === low_item.id)); // Low number excluded (3)

		// Test direct access via get_index
		const high_numbers_via_index = collection.get_index('high_numbers');
		assert.deepEqual(high_numbers_via_index, high_numbers);

		// Test incremental update
		const new_high_item = create_item('a5', 'c1', [], 9);
		collection.add(new_high_item);

		const updated_high_numbers = collection.derived_index('high_numbers');
		assert.strictEqual(updated_high_numbers.length, 4);
		assert.strictEqual(updated_high_numbers[0]!.id, high_item.id); // 10
		assert.strictEqual(updated_high_numbers[1]!.id, new_high_item.id); // 9
		assert.strictEqual(updated_high_numbers[2]!.id, medium_item.id); // 8
		assert.strictEqual(updated_high_numbers[3]!.id, threshold_item.id); // 6

		// Test removal from derived index
		collection.remove(high_item.id);
		const numbers_after_removal = collection.derived_index('high_numbers');
		assert.strictEqual(numbers_after_removal.length, 3);
		assert.strictEqual(numbers_after_removal[0]!.id, new_high_item.id); // Now highest number
	});

	test('function indexes', () => {
		// Test a function-based index using the new helper function
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_dynamic_index<TestItem, (range: string) => Array<TestItem>>({
					key: 'by_range',
					factory: (collection) => {
						return (range: string) => {
							const result = [];
							for (const item of collection.by_id.values()) {
								if (range === 'high' && item.number >= 8) {
									result.push(item);
								} else if (range === 'medium' && item.number >= 4 && item.number < 8) {
									result.push(item);
								} else if (range === 'low' && item.number < 4) {
									result.push(item);
								}
							}
							return result;
						};
					},
					query_schema: z.string(),
				}),
			],
		});

		// Add items with different number values
		collection.add(create_item('a1', 'c1', [], 10)); // High number
		collection.add(create_item('a2', 'c1', [], 8)); // High number
		collection.add(create_item('a3', 'c1', [], 7)); // Medium number
		collection.add(create_item('a4', 'c1', [], 5)); // Medium number
		collection.add(create_item('a5', 'c1', [], 3)); // Low number
		collection.add(create_item('a6', 'c1', [], 1)); // Low number

		// The index is a function that can be queried
		const range_function = collection.get_index<(range: string) => Array<TestItem>>('by_range');

		// Test function index queries
		assert.strictEqual(range_function('high').length, 2);
		assert.strictEqual(range_function('medium').length, 2);
		assert.strictEqual(range_function('low').length, 2);

		// Test using the query method
		assert.strictEqual(collection.query<Array<TestItem>, string>('by_range', 'high').length, 2);
		assert.strictEqual(collection.query<Array<TestItem>, string>('by_range', 'medium').length, 2);
		assert.strictEqual(collection.query<Array<TestItem>, string>('by_range', 'low').length, 2);
	});
});

describe('IndexedCollection - Advanced Features', () => {
	test('combined indexing strategies', () => {
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_text',
					extractor: (item) => item.text,
					query_schema: z.string(),
				}),
				create_multi_index({
					key: 'by_category',
					extractor: (item) => item.category,
					query_schema: z.string(),
				}),
				create_multi_index({
					key: 'by_listitem',
					extractor: (item) => item.list[0],
					query_schema: z.string(),
				}),
				create_derived_index({
					key: 'recent_high_numbers',
					compute: (collection) => {
						const result = [];
						for (const item of collection.by_id.values()) {
							if (item.number >= 8) {
								result.push(item);
							}
						}
						return result.sort((a, b) => b.date.getTime() - a.date.getTime());
					},
					matches: (item) => item.number >= 8,
					sort: (a, b) => b.date.getTime() - a.date.getTime(),
					query_schema: z.void(),
				}),
			],
		});

		// Create items with a mix of properties
		const high_number_item = create_item('a1', 'c1', ['l1', 'l2'], 9);
		const mid_number_item = create_item('a2', 'c1', ['l3', 'l4'], 7);
		const low_number_item = create_item('a3', 'c2', ['l5', 'l6'], 3);
		const top_number_item = create_item('a4', 'c1', ['l7', 'l8'], 10);

		collection.add_many([high_number_item, mid_number_item, low_number_item, top_number_item]);

		// Test single index lookup
		assert.strictEqual(collection.by_optional<string>('by_text', 'a1')?.id, high_number_item.id);

		// Test multi index lookup
		assert.strictEqual(collection.where<string>('by_category', 'c1').length, 3);
		assert.ok(
			collection.where<string>('by_listitem', 'l1').some((item) => item.id === high_number_item.id),
		);

		// Test derived index
		const high_numbers = collection.derived_index('recent_high_numbers');
		assert.strictEqual(high_numbers.length, 2);
		assert.ok(high_numbers.some((item) => item.id === high_number_item.id));
		assert.ok(high_numbers.some((item) => item.id === top_number_item.id));
		assert.ok(!high_numbers.some((item) => item.id === mid_number_item.id)); // score 7 is too low
	});

	test('complex data structures', () => {
		// Create a custom helper function for this specialized case
		const create_stats_index = <T extends IndexedItem>(key: string) => ({
			key,
			compute: (collection: IndexedCollection<T>) => {
				const items = [...collection.by_id.values()];
				return {
					count: items.length,
					average: items.reduce((sum, item: any) => sum + item.number, 0) / (items.length || 1),
					unique_values: new Set(items.map((item: any) => item.category)),
				};
			},
			query_schema: z.void(),
			onadd: (stats: any, item: any) => {
				stats.count++;
				stats.average = (stats.average * (stats.count - 1) + item.number) / stats.count;
				stats.unique_values.add(item.category);
				return stats;
			},
			onremove: (stats: any, item: any, collection: IndexedCollection<T>) => {
				stats.count--;
				if (stats.count === 0) {
					stats.average = 0;
				} else {
					stats.average = (stats.average * (stats.count + 1) - item.number) / stats.count;
				}

				// Rebuild unique_values set if needed (we don't know if other items use this category)
				const all_unique_values: Set<string> = new Set();
				for (const i of collection.by_id.values()) {
					if (i.id !== item.id) {
						all_unique_values.add((i as any).category);
					}
				}
				stats.unique_values = all_unique_values;

				return stats;
			},
		});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [create_stats_index<TestItem>('stats')],
		});

		// Add items
		collection.add(create_item('a1', 'c1', [], 10));
		collection.add(create_item('a2', 'c2', [], 20));

		// Test complex index structure
		const stats = collection.get_index<{
			count: number;
			average: number;
			unique_values: Set<string>;
		}>('stats');

		assert.strictEqual(stats.count, 2);
		assert.strictEqual(stats.average, 15);
		assert.strictEqual(stats.unique_values.size, 2);
		assert.ok(stats.unique_values.has('c1'));

		// Test updating the complex structure
		collection.add(create_item('a3', 'c1', [], 30));

		assert.strictEqual(stats.count, 3);
		assert.strictEqual(stats.average, 20);
		assert.strictEqual(stats.unique_values.size, 2);
	});

	test('batch operations', () => {
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_category',
					extractor: (item) => item.category,
					query_schema: z.string(),
				}),
			],
		});

		// Create test items
		const items = [
			create_item('a1', 'c1', [], 1),
			create_item('a2', 'c1', [], 2),
			create_item('a3', 'c1', [], 3),
			create_item('a4', 'c2', [], 4),
			create_item('a5', 'c2', [], 5),
		];

		// Add multiple items at once
		collection.add_many(items);

		// Verify all items were added
		assert.strictEqual(collection.size, 5);
		assert.strictEqual(collection.where('by_category', 'c1').length, 3);
		assert.strictEqual(collection.where('by_category', 'c2').length, 2);

		// Test removing multiple items at once
		const ids_to_remove = [items[0]!.id, items[2]!.id, items[4]!.id];
		const removed_count = collection.remove_many(ids_to_remove);

		assert.strictEqual(removed_count, 3);
		assert.strictEqual(collection.size, 2);

		// Verify specific items were removed
		assert.ok(!collection.has(items[0]!.id));
		assert.ok(collection.has(items[1]!.id));
		assert.ok(!collection.has(items[2]!.id));
		assert.ok(collection.has(items[3]!.id));
		assert.ok(!collection.has(items[4]!.id));

		// Verify indexes were properly updated
		assert.strictEqual(collection.where('by_category', 'c1').length, 1);
		assert.strictEqual(collection.where('by_category', 'c2').length, 1);
	});
});
