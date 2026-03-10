// @vitest-environment jsdom

import {test, describe, vi, assert} from 'vitest';
import {z} from 'zod';

import {IndexedCollection} from '$lib/indexed_collection.svelte.js';
import {
	create_single_index,
	create_multi_index,
	create_derived_index,
	create_dynamic_index,
} from '$lib/indexed_collection_helpers.svelte.js';
import {create_uuid, Uuid} from '$lib/zod_helpers.js';

// Mock item type that implements IndexedItem
interface TestItem {
	id: Uuid;
	string_a: string;
	number_a: number | null;
	array_a: Array<string>;
	boolean_a: boolean;
}

// Helper function to create test items with predictable values
const create_test_item = (
	string_a: string,
	number_a: number | null = 0,
	array_a: Array<string> = [],
	boolean_a = true,
): TestItem => ({
	id: create_uuid(),
	string_a,
	number_a,
	array_a,
	boolean_a,
});

describe('IndexedCollection - Edge Cases', () => {
	test('handling null/undefined values in index extractors', () => {
		// Create indexes that handle null/undefined values explicitly
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				// Single index that filters out null values
				create_single_index({
					key: 'by_number_a',
					extractor: (item) => item.number_a, // May return null
					query_schema: z.number().nullable(),
				}),

				// Multi-index that handles undefined values safely
				create_multi_index({
					key: 'by_array_a',
					extractor: (item) => (item.array_a.length > 0 ? item.array_a : undefined),
					query_schema: z.string(),
				}),
			],
		});

		// Add items with edge case values
		const item1 = create_test_item('a1', 5, ['tag1']);
		const item2 = create_test_item('a2', null, ['tag2']);
		const item3 = create_test_item('a3', 10, []); // Empty array
		const item4 = create_test_item('a4', 15, ['tag1', 'tag3']);

		collection.add_many([item1, item2, item3, item4]);

		// Test retrieving with null values
		const null_item = collection.by_optional('by_number_a', null);
		assert.isDefined(null_item);
		assert.strictEqual(null_item.string_a, 'a2');

		// Test filtering with non-existing value
		assert.ok(collection.by_optional('by_number_a', 999) === undefined);

		// Test multi-index with shared array values
		const tag1_items = collection.where('by_array_a', 'tag1');
		assert.strictEqual(tag1_items.length, 2);
		assert.deepEqual(tag1_items.map((i) => i.string_a).sort(), ['a1', 'a4']);

		// Item with empty array should be excluded from by_array_a index
		assert.strictEqual(collection.where('by_array_a', undefined).length, 0);

		// Test removing an item with null value
		collection.remove(item2.id);
		assert.ok(collection.by_optional('by_number_a', null) === undefined);

		// Add another item with null value
		const item5 = create_test_item('a5', null, ['tag5']);
		collection.add(item5);
		const null_item_after = collection.by_optional('by_number_a', null);
		assert.isDefined(null_item_after);
		assert.strictEqual(null_item_after.string_a, 'a5');
	});

	test('handling duplicates in single indexes', () => {
		// Create a single index where multiple items might share the same key
		const console_warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_prefix',
					extractor: (item) => item.string_a.substring(0, 1), // First char
					query_schema: z.string(),
				}),
				// Add explicit text index for easier item retrieval
				create_single_index({
					key: 'by_string_a',
					extractor: (item) => item.string_a,
					query_schema: z.string(),
				}),
			],
		});

		// Add items with duplicate prefixes
		const item1 = create_test_item('a123', 1);
		const item2 = create_test_item('a456', 2);
		const item3 = create_test_item('b789', 3);

		// Add them in a specific order
		collection.add(item1); // First 'a' item
		collection.add(item3); // Different prefix
		collection.add(item2); // Second 'a' item - should overwrite item1 in the index

		// Check that the latest addition wins for duplicate keys
		assert.strictEqual(collection.by_optional('by_prefix', 'a')?.string_a, 'a456');
		assert.strictEqual(collection.by_optional('by_prefix', 'b')?.string_a, 'b789');

		// Test what happens when removing an item that was overwritten in the index
		collection.remove(item2.id); // Remove the winning item

		// The index should now revert to the first item with the same key
		assert.strictEqual(collection.by_optional('by_prefix', 'a')?.string_a, 'a123');

		// Check that removing all items with the same key clears the index entry
		collection.remove(item1.id);
		assert.ok(collection.by_optional('by_prefix', 'a') === undefined);

		console_warn_spy.mockRestore();
	});

	test('batch operations performance', {timeout: 10000}, () => {
		// Create a collection with multiple indexes to stress test performance
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_string_a',
					extractor: (item) => item.string_a,
					query_schema: z.string(),
				}),

				create_multi_index({
					key: 'by_array_a',
					extractor: (item) => item.array_a,
					query_schema: z.string(),
				}),

				create_derived_index({
					key: 'filtered_items',
					compute: (collection) => {
						const result = [];
						for (const item of collection.by_id.values()) {
							if (item.boolean_a && item.number_a !== null) {
								result.push(item);
							}
						}
						return result.sort((a, b) => (b.number_a || 0) - (a.number_a || 0));
					},
					matches: (item) => item.boolean_a && item.number_a !== null,
					sort: (a, b) => (b.number_a || 0) - (a.number_a || 0),
				}),
			],
		});

		// Create a smaller batch with varied properties
		const test_batch = Array.from({length: 100}, (_, i) => {
			const boolean_a = i % 3 === 0;
			const number_a = i % 5 === 0 ? null : i;
			const array_a = [`tag${i % 10}`, `category${i % 5}`];
			return create_test_item(`item${i}`, number_a, array_a, boolean_a);
		});

		// Measure time to add all items
		const start_time = performance.now();
		collection.add_many(test_batch);
		const end_time = performance.now();

		// Just log the time, don't make strict assertions as performance varies by environment
		console.log(`Time to add 100 items with 3 indexes: ${end_time - start_time}ms`);

		// Verify all indexes were created correctly
		assert.strictEqual(collection.size, 100);
		assert.strictEqual(Object.keys(collection.indexes).length, 3);

		// Test various queries against the indexes
		assert.strictEqual(collection.by_optional('by_string_a', 'item23')?.number_a, 23);
		assert.strictEqual(collection.where('by_array_a', 'tag5').length, 10); // 10% of items have tag5
		assert.strictEqual(
			collection.derived_index('filtered_items').length,
			test_batch.filter((i) => i.boolean_a && i.number_a !== null).length,
		);

		// Test removing half of the items
		const to_remove = test_batch.slice(0, 50).map((item) => item.id);
		const remove_start = performance.now();
		collection.remove_many(to_remove);
		const remove_end = performance.now();

		console.log(`Time to remove 50 items: ${remove_end - remove_start}ms`);
		assert.strictEqual(collection.size, 50);
	});

	test('error handling for invalid index type access', () => {
		// Create a collection with mix of index types
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_string_a',
					extractor: (item) => item.string_a,
					query_schema: z.string(),
				}),
				create_multi_index({
					key: 'by_array_a',
					extractor: (item) => item.array_a,
					query_schema: z.string(),
				}),
			],
		});

		// Add a test item
		collection.add(create_test_item('a1', 1, ['tag1']));

		// Test accessing indexes with wrong methods
		assert.throws(() => {
			collection.where('by_string_a', 'a1'); // Using multi-index method on single index
		}); // Should throw error about index type mismatch

		assert.throws(() => {
			collection.by<string>('by_array_a', 'tag1'); // Using single-index method on multi-index
		}); // Should throw error about index type mismatch
	});

	test('handling invalid queries with schema validation', () => {
		// Create a collection with strict schema validation
		const console_error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_number_a',
					extractor: (item) => item.number_a,
					query_schema: z.number().positive(), // Must be positive number
				}),
			],
			validate: true, // Enable validation
		});

		// Add test items
		collection.add(create_test_item('a1', 5));
		collection.add(create_test_item('a2', -1)); // Negative value
		collection.add(create_test_item('a3', null)); // Null value

		// Test valid query
		assert.strictEqual(collection.by_optional('by_number_a', 5)?.string_a, 'a1');

		// Test queries that violate schema
		collection.query('by_number_a', -10); // Negative number, should log validation error
		assert.ok(console_error_spy.mock.calls.length > 0);

		console_error_spy.mockClear();
		collection.query('by_number_a', null); // Null, should log validation error
		assert.ok(console_error_spy.mock.calls.length > 0);

		console_error_spy.mockRestore();
	});

	test('dynamic indexes with custom handlers', () => {
		// Test a dynamic index with custom add/remove handlers
		const compute_fn = vi.fn();
		const onadd_fn = vi.fn((_fn, item, collection) => {
			// Return a new function that references the added item
			return (query: string) => {
				compute_fn(query);
				if (query === item.string_a) {
					return [item];
				}

				const result = [];
				for (const i of collection.by_id.values()) {
					if (i.string_a.includes(query)) {
						result.push(i);
					}
				}
				return result;
			};
		});

		const onremove_fn = vi.fn((_fn, _item, collection) => {
			// Return a new function that excludes the removed item
			return (query: string) => {
				compute_fn(query);

				const result = [];
				for (const i of collection.by_id.values()) {
					if (i.string_a.includes(query)) {
						result.push(i);
					}
				}
				return result;
			};
		});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_dynamic_index<TestItem, (query: string) => Array<TestItem>>({
					key: 'search',
					factory: (collection) => {
						return (query: string) => {
							compute_fn(query);

							const result = [];
							for (const i of collection.by_id.values()) {
								if (i.string_a.includes(query)) {
									result.push(i);
								}
							}
							return result;
						};
					},
					query_schema: z.string(),
					onadd: onadd_fn,
					onremove: onremove_fn,
				}),
			],
		});

		// Add test items and verify custom handlers
		const item1 = create_test_item('x1');
		collection.add(item1);
		assert.ok(onadd_fn.mock.calls.length > 0);

		const item2 = create_test_item('y2');
		collection.add(item2);

		// Test the search index
		const search_fn = collection.get_index<(q: string) => Array<TestItem>>('search');

		// Search functions should work
		const x_results = search_fn('x');
		assert.strictEqual(x_results.length, 1);
		const x_result_0 = x_results[0];
		assert.isDefined(x_result_0);
		assert.strictEqual(x_result_0!.string_a, 'x1');
		assert.deepEqual(compute_fn.mock.calls[compute_fn.mock.calls.length - 1], ['x']);

		// Test removing an item triggers onremove
		collection.remove(item1.id);
		assert.ok(onremove_fn.mock.calls.length > 0);

		// Search function should be updated
		const no_results = search_fn('x');
		assert.strictEqual(no_results.length, 0);
	});

	test('custom complex index behaviors', () => {
		// Create a collection with a custom index that has advanced logic
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				// Add explicit string_a index for lookup
				create_single_index({
					key: 'by_string_a',
					extractor: (item) => item.string_a,
					query_schema: z.string(),
				}),
				// Custom index that maintains an aggregated stats object
				{
					key: 'stats',
					compute: (collection) => {
						const items = collection.values;
						return {
							count: items.length,
							boolean_a_true_count: items.filter((i) => i.boolean_a).length,
							boolean_a_false_count: items.filter((i) => !i.boolean_a).length,
							sum_number_a: items.reduce((sum, i) => sum + (i.number_a || 0), 0),
							array_a_frequency: items.reduce<Record<string, number>>((freq, item) => {
								for (const value of item.array_a) {
									freq[value] = (freq[value] || 0) + 1;
								}
								return freq;
							}, {}),
						};
					},
					onadd: (stats: any, item: TestItem) => {
						stats.count++;
						if (item.boolean_a) stats.boolean_a_true_count++;
						else stats.boolean_a_false_count++;
						stats.sum_number_a += item.number_a || 0;

						// Update array_a frequencies
						for (const value of item.array_a) {
							stats.array_a_frequency[value] = (stats.array_a_frequency[value] || 0) + 1;
						}

						return stats;
					},
					onremove: (stats: any, item: TestItem) => {
						stats.count--;
						if (item.boolean_a) stats.boolean_a_true_count--;
						else stats.boolean_a_false_count--;
						stats.sum_number_a -= item.number_a || 0;

						// Update array_a frequencies
						for (const value of item.array_a) {
							stats.array_a_frequency[value]--;
							if (stats.array_a_frequency[value] === 0) {
								delete stats.array_a_frequency[value];
							}
						}
						return stats;
					},
				},
			],
		});

		// Add items to test stats tracking
		const item1 = create_test_item('a1', 10, ['tag1', 'tag2'], true);
		const item2 = create_test_item('a2', 20, ['tag2', 'tag3'], false);
		const item3 = create_test_item('a3', 30, ['tag1', 'tag3'], true);

		collection.add(item1);
		collection.add(item2);
		collection.add(item3);

		// Check that stats were computed correctly
		const stats = collection.get_index<{
			count: number;
			boolean_a_true_count: number;
			boolean_a_false_count: number;
			sum_number_a: number;
			array_a_frequency: Record<string, number>;
		}>('stats');

		assert.strictEqual(stats.count, 3);
		assert.strictEqual(stats.boolean_a_true_count, 2);
		assert.strictEqual(stats.boolean_a_false_count, 1);
		assert.strictEqual(stats.sum_number_a, 60);
		assert.deepEqual(stats.array_a_frequency, {
			tag1: 2,
			tag2: 2,
			tag3: 2,
		});

		// Test incremental update - add an item
		collection.add(create_test_item('a4', 40, ['tag1', 'tag4'], false));

		assert.strictEqual(stats.count, 4);
		assert.strictEqual(stats.boolean_a_true_count, 2);
		assert.strictEqual(stats.boolean_a_false_count, 2);
		assert.strictEqual(stats.sum_number_a, 100);
		assert.strictEqual(stats.array_a_frequency.tag1, 3);
		assert.strictEqual(stats.array_a_frequency.tag4, 1);

		// Test incremental update - remove an item
		// Store the item reference first to ensure it exists
		const item1_ref = collection.by_optional('by_string_a', 'a1');
		assert.isDefined(item1_ref); // Make sure we found it
		collection.remove(item1_ref!.id);

		assert.strictEqual(stats.count, 3);
		assert.strictEqual(stats.boolean_a_true_count, 1);
		assert.strictEqual(stats.boolean_a_false_count, 2);
		assert.strictEqual(stats.sum_number_a, 90);
		assert.strictEqual(stats.array_a_frequency.tag1, 2);
		assert.strictEqual(stats.array_a_frequency.tag2, 1);
	});

	test('multi-index array instance consistency', () => {
		// Test that multi-indexes return the same array instance for the same key
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_boolean_a',
					extractor: (item) => item.boolean_a,
					query_schema: z.boolean(),
				}),
			],
		});

		// Get array before adding items
		const true_items_before = $derived(collection.where('by_boolean_a', true));
		const false_items_before = $derived(collection.where('by_boolean_a', false));

		// Add items
		const item1 = create_test_item('a1', 1, [], true);
		const item2 = create_test_item('a2', 2, [], false);
		collection.add_many([item1, item2]);

		// Get arrays after adding items
		const true_items_after = collection.where('by_boolean_a', true);
		const false_items_after = collection.where('by_boolean_a', false);

		// Should be the same array instances
		assert.strictEqual(true_items_before, true_items_after);
		assert.strictEqual(false_items_before, false_items_after);

		// Arrays should have the correct content
		assert.strictEqual(true_items_after.length, 1);
		assert.strictEqual(false_items_after.length, 1);
	});

	test('multi-index reactivity behavior outside reactive context', () => {
		// Test that arrays are updated but we can't observe reactively outside Svelte components
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_number_group',
					extractor: (item) => {
						if (item.number_a === null) return 'null';
						if (item.number_a < 10) return 'small';
						if (item.number_a < 50) return 'medium';
						return 'large';
					},
					query_schema: z.string(),
				}),
			],
		});

		// Get initial references
		const small_items = $derived(collection.where('by_number_group', 'small'));
		const medium_items = $derived(collection.where('by_number_group', 'medium'));
		const large_items = $derived(collection.where('by_number_group', 'large'));

		// Initial state
		assert.strictEqual(small_items.length, 0);
		assert.strictEqual(medium_items.length, 0);
		assert.strictEqual(large_items.length, 0);

		// Add items
		collection.add(create_test_item('a1', 5));
		assert.strictEqual(small_items.length, 1);

		collection.add(create_test_item('a2', 25));
		assert.strictEqual(medium_items.length, 1);

		collection.add(create_test_item('a3', 75));
		assert.strictEqual(large_items.length, 1);

		// Add multiple items
		collection.add_many([
			create_test_item('a4', 8),
			create_test_item('a5', 35),
			create_test_item('a6', 100),
		]);
		assert.strictEqual(small_items.length, 2);
		assert.strictEqual(medium_items.length, 2);
		assert.strictEqual(large_items.length, 2);
	});

	test('multi-index maintains same array with complex extractors', () => {
		// Test reactivity with extractors that return arrays or undefined
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_tags',
					extractor: (item) => item.array_a,
					query_schema: z.string(),
				}),
				create_multi_index({
					key: 'by_conditional_tags',
					extractor: (item) => {
						// only index if boolean_a is true
						return item.boolean_a ? item.array_a : undefined;
					},
					query_schema: z.string(),
				}),
			],
		});

		// Get initial references
		const tag1_items = $derived(collection.where('by_tags', 'tag1'));
		const tag2_items = $derived(collection.where('by_tags', 'tag2'));
		const conditional_tag1_items = $derived(collection.where('by_conditional_tags', 'tag1'));

		// Add items with various tag configurations
		const item1 = create_test_item('a1', 1, ['tag1', 'tag2'], true);
		const item2 = create_test_item('a2', 2, ['tag2', 'tag3'], false);
		const item3 = create_test_item('a3', 3, ['tag1', 'tag3'], true);

		collection.add_many([item1, item2, item3]);

		// Verify state
		assert.strictEqual(tag1_items.length, 2); // item1, item3
		assert.strictEqual(tag2_items.length, 2); // item1, item2
		assert.strictEqual(conditional_tag1_items.length, 2); // item1, item3 (both have boolean_a true)

		// Get references again - should be same instances
		const tag1_items_2 = $derived(collection.where('by_tags', 'tag1'));
		const tag2_items_2 = $derived(collection.where('by_tags', 'tag2'));
		const conditional_tag1_items_2 = $derived(collection.where('by_conditional_tags', 'tag1'));

		assert.strictEqual(tag1_items, tag1_items_2);
		assert.strictEqual(tag2_items, tag2_items_2);
		assert.strictEqual(conditional_tag1_items, conditional_tag1_items_2);
	});

	test('multi-index sort functionality', () => {
		// Test that sorted multi-indexes maintain order
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_boolean_sorted',
					extractor: (item) => item.boolean_a,
					sort: (a, b) => (a.number_a || 0) - (b.number_a || 0), // ascending by number
					query_schema: z.boolean(),
				}),
			],
		});

		// Add items out of order
		const item1 = create_test_item('a1', 30, [], true);
		const item2 = create_test_item('a2', 10, [], true);
		const item3 = create_test_item('a3', 20, [], true);

		collection.add_many([item1, item2, item3]);

		const true_items = collection.where('by_boolean_sorted', true);

		// Verify initial sort order
		assert.deepEqual(
			true_items.map((i) => i.string_a),
			['a2', 'a3', 'a1'],
		);

		// Add new item that should be inserted in middle
		const item4 = create_test_item('a4', 25, [], true);
		collection.add(item4);

		// Verify array maintains sort order
		assert.deepEqual(
			true_items.map((i) => i.string_a),
			['a2', 'a3', 'a4', 'a1'],
		);

		// Add item at beginning
		const item5 = create_test_item('a5', 5, [], true);
		collection.add(item5);

		assert.deepEqual(
			true_items.map((i) => i.string_a),
			['a5', 'a2', 'a3', 'a4', 'a1'],
		);

		// Remove middle item
		collection.remove(item3.id);
		assert.deepEqual(
			true_items.map((i) => i.string_a),
			['a5', 'a2', 'a4', 'a1'],
		);
	});

	test('multi-index empty bucket behavior', () => {
		// Test creation and deletion of empty buckets
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_category',
					extractor: (item) => item.string_a.split('_')[0], // extract prefix before underscore
					query_schema: z.string(),
				}),
			],
		});

		// Get initial reference
		const category_x = $derived(collection.where('by_category', 'x'));
		assert.strictEqual(category_x.length, 0);

		// Add item to create bucket
		const item1 = create_test_item('x_1', 1);
		collection.add(item1);
		assert.strictEqual(category_x.length, 1);

		// Get new reference - should be same instance
		const category_x_after = $derived(collection.where('by_category', 'x'));
		assert.strictEqual(category_x, category_x_after);

		// Add more items
		collection.add_many([
			create_test_item('x_2', 2),
			create_test_item('x_3', 3),
			create_test_item('y_1', 4),
		]);

		assert.strictEqual(category_x.length, 3);

		// Remove all x items
		const x_ids = category_x.map((item) => item.id);
		collection.remove_many(x_ids);

		// After removal, the same array is empty
		assert.strictEqual(category_x_after.length, 0);
	});

	test('multi-index behavior with bucket deletion and recreation', () => {
		// Test that buckets are deleted when empty and recreated as needed
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_prefix',
					extractor: (item) => item.string_a.charAt(0),
					query_schema: z.string(),
				}),
			],
		});

		// Get reference before adding any items
		const a_items_1 = $derived(collection.where('by_prefix', 'a'));
		assert.strictEqual(a_items_1.length, 0);

		// Add and remove items
		const item1 = create_test_item('a1', 1);
		collection.add(item1);
		assert.strictEqual(a_items_1.length, 1);

		collection.remove(item1.id);
		// The array is now empty
		assert.strictEqual(a_items_1.length, 0);

		// Add items again - updates the same array
		const item2 = create_test_item('a2', 2);
		collection.add(item2);
		assert.strictEqual(a_items_1.length, 1); // both references see the update
	});

	test('multi-index with undefined extractor results', () => {
		// Test indexes that conditionally return undefined
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_even_numbers',
					extractor: (item) => {
						if (item.number_a === null) return undefined;
						if (item.number_a % 2 === 0) return 'even';
						return undefined; // odd numbers not indexed
					},
					query_schema: z.string(),
				}),
			],
		});

		// Add items
		collection.add_many([
			create_test_item('a1', 2), // even
			create_test_item('a2', 3), // odd - not indexed
			create_test_item('a3', 4), // even
			create_test_item('a4', null), // null - not indexed
		]);

		const even_items = collection.where('by_even_numbers', 'even');
		assert.strictEqual(even_items.length, 2);
		assert.deepEqual(even_items.map((i) => i.string_a).sort(), ['a1', 'a3']);

		// Undefined key should return empty array
		const undefined_items = collection.where('by_even_numbers', undefined);
		assert.strictEqual(undefined_items.length, 0);
	});

	test('multi-index preserves array reference consistency', () => {
		// Comprehensive test of array reference preservation
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_category',
					extractor: (item) => item.string_a.split('_')[0],
					query_schema: z.string(),
				}),
			],
		});

		// Step 1: Get initial empty array references
		const cat_a = $derived(collection.where('by_category', 'a'));
		const cat_b = $derived(collection.where('by_category', 'b'));
		assert.strictEqual(cat_a.length, 0);
		assert.strictEqual(cat_b.length, 0);

		// Step 2: Add items
		collection.add_many([
			create_test_item('a_1', 1),
			create_test_item('a_2', 2),
			create_test_item('b_1', 3),
		]);

		// Step 3: Verify same array instances are updated
		assert.strictEqual(cat_a.length, 2);
		assert.strictEqual(cat_b.length, 1);
		assert.strictEqual(collection.where('by_category', 'a'), cat_a);
		assert.strictEqual(collection.where('by_category', 'b'), cat_b);

		// Step 4: Remove some items
		const a_1 = cat_a.find((i) => i.string_a === 'a_1');
		collection.remove(a_1!.id);
		assert.strictEqual(cat_a.length, 1);

		// Step 5: Remove all items from a category
		const a_2 = cat_a.find((i) => i.string_a === 'a_2');
		collection.remove(a_2!.id);
		// Array is now empty but still exists
		assert.strictEqual(cat_a.length, 0);

		// Step 6: Verify we still get the same instance
		const cat_a_new = collection.where('by_category', 'a');
		assert.strictEqual(cat_a_new.length, 0);
	});

	test('reactive context tracking with $derived', () => {
		// Test that reactivity works properly in reactive contexts
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_boolean_a',
					extractor: (item) => item.boolean_a,
					query_schema: z.boolean(),
				}),
			],
		});

		// Create derived values that track array lengths
		const true_count = $derived(collection.where('by_boolean_a', true).length);
		const false_count = $derived(collection.where('by_boolean_a', false).length);

		// Initial state
		assert.strictEqual(true_count, 0);
		assert.strictEqual(false_count, 0);

		// Add items
		collection.add_many([
			create_test_item('a1', 1, [], true),
			create_test_item('a2', 2, [], false),
			create_test_item('a3', 3, [], true),
		]);

		// Derived values should update
		assert.strictEqual(true_count, 2);
		assert.strictEqual(false_count, 1);

		// Remove an item
		const items = collection.where('by_boolean_a', true);
		collection.remove(items[0]!.id);

		assert.strictEqual(true_count, 1);
		assert.strictEqual(false_count, 1);
	});

	test('multi-index with $state creates reactive arrays', () => {
		// Test that the $state([]) in add_to_multi_map creates reactive arrays
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_tags',
					extractor: (item) => item.array_a,
					query_schema: z.string(),
				}),
			],
		});

		// Create reactive context to observe changes
		const tag1_derived_length = $derived(collection.where('by_tags', 'tag1').length);

		// Initial state
		assert.strictEqual(tag1_derived_length, 0);

		// Add items
		collection.add_many([
			create_test_item('a1', 1, ['tag1', 'tag2']),
			create_test_item('a2', 2, ['tag1', 'tag3']),
		]);

		// Derived value should update
		assert.strictEqual(tag1_derived_length, 2);

		// Remove an item
		const tag1_items = collection.where('by_tags', 'tag1');
		collection.remove(tag1_items[0]!.id);

		// Derived value should update again
		assert.strictEqual(tag1_derived_length, 1);
	});
});
