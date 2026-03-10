// @vitest-environment jsdom

import {test, assert, describe, vi} from 'vitest';
import {z} from 'zod';

import {IndexedCollection} from '$lib/indexed_collection.svelte.js';
import {
	create_derived_index,
	create_dynamic_index,
	create_multi_index,
} from '$lib/indexed_collection_helpers.svelte.js';
import {create_uuid, Uuid} from '$lib/zod_helpers.js';

// Mock item type that implements IndexedItem
interface TestItem {
	id: Uuid;
	string_a: string;
	string_b: string;
	array: Array<string>;
	number: number;
}

// Helper function to create test items with predictable values
const create_item = (
	string_a: string,
	string_b: string,
	array: Array<string> = [],
	number: number = 0,
): TestItem => ({
	id: create_uuid(),
	string_a,
	string_b,
	array,
	number,
});

describe('IndexedCollection - Optimization Tests', () => {
	test('indexes are computed only once during initialization', () => {
		// Create spy functions to count compute calls
		const compute_spy = vi.fn((collection) => {
			const map = new Map();
			for (const item of collection.by_id.values()) {
				map.set(item.string_a, item);
			}
			return map;
		});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				{
					key: 'test_index',
					compute: compute_spy,
				},
			],
			initial_items: [create_item('string_a1', 'string_b1'), create_item('string_a2', 'string_b2')],
		});

		// Verify compute was called exactly once during initialization
		assert.strictEqual(compute_spy.mock.calls.length, 1);
		assert.strictEqual(collection.size, 2);
	});

	test('incremental updates avoid recomputing entire index', () => {
		// Create spies for the compute and onadd functions
		const compute_spy = vi.fn((collection) => {
			const result = [];
			for (const item of collection.by_id.values()) {
				if (item.number > 10) {
					result.push(item);
				}
			}
			return result;
		});

		const onadd_spy = vi.fn((items, item) => {
			if (item.number > 10) {
				items.push(item);
			}
			return items;
		});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_derived_index({
					key: 'high_number',
					compute: compute_spy,
					matches: (item) => item.number > 10,
					onadd: onadd_spy,
				}),
			],
			initial_items: [
				create_item('string_a1', 'string_b1', [], 15),
				create_item('string_a2', 'string_b2', [], 5),
			],
		});

		// Verify compute was called exactly once during initialization
		assert.strictEqual(compute_spy.mock.calls.length, 1);

		// Add more items and check that compute isn't called again
		collection.add(create_item('string_a3', 'string_b3', [], 20));
		collection.add(create_item('string_a4', 'string_b4', [], 8));

		// Compute should still have been called only once
		assert.strictEqual(compute_spy.mock.calls.length, 1);

		// onadd should have been called twice - once for each new item
		assert.strictEqual(onadd_spy.mock.calls.length, 2);

		// Check that the index was correctly updated
		const high_number = collection.derived_index('high_number');
		assert.strictEqual(high_number.length, 2);
		assert.ok(high_number.some((item) => item.string_a === 'string_a1'));
		assert.ok(high_number.some((item) => item.string_a === 'string_a3'));
	});

	test('batch operations are more efficient', () => {
		// Create a collection with a multi-index
		const onadd_spy = vi.fn((map, item) => {
			const collection = map.get(item.string_b) || [];
			collection.push(item);
			map.set(item.string_b, collection);
			return map;
		});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				{
					key: 'by_string_b',
					type: 'multi',
					extractor: (item) => item.string_b,
					compute: (collection) => {
						const map = new Map();
						for (const item of collection.by_id.values()) {
							const collection = map.get(item.string_b) || [];
							collection.push(item);
							map.set(item.string_b, collection);
						}
						return map;
					},
					query_schema: z.string(),
					onadd: onadd_spy,
				},
			],
		});

		// Test batch add performance
		const start_time = performance.now();

		const items = Array.from({length: 100}, (_, i) =>
			create_item(`string_a${i}`, i % 5 === 0 ? 'string_b1' : 'string_b2', [], i),
		);

		collection.add_many(items);

		const end_time = performance.now();
		const batch_time = end_time - start_time;

		// Verify onadd was called for each item
		assert.strictEqual(onadd_spy.mock.calls.length, 100);

		// Reset the spy for individual adds
		onadd_spy.mockClear();

		// Test individual adds
		const individual_start = performance.now();

		const more_items = Array.from({length: 100}, (_, i) =>
			create_item(`string_a${i + 100}`, i % 5 === 0 ? 'string_b1' : 'string_b2', [], i + 100),
		);

		for (const item of more_items) {
			collection.add(item);
		}

		const individual_end = performance.now();
		const individual_time = individual_end - individual_start;

		// Verify onadd was called for each item
		assert.strictEqual(onadd_spy.mock.calls.length, 100);

		// This test is somewhat approximative but helps validate the efficiency
		// We're not making a strict assertion on performance as it can vary between environments
		console.log(`Batch add: ${batch_time}ms, Individual adds: ${individual_time}ms`);
	});

	test('dynamic indexes avoid redundant storage', () => {
		// Create a collection with a dynamic index that computes on-demand
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_dynamic_index<TestItem, (min_n: string) => Array<TestItem>>({
					key: 'by_min_number',
					factory: (collection) => {
						return (min_n: string) => {
							const threshold = parseInt(min_n, 10);
							const result = [];
							for (const item of collection.by_id.values()) {
								if (item.number >= threshold) {
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

		// Add test data
		for (let i = 0; i < 20; i++) {
			collection.add(
				create_item(`string_a${i}`, `string_b${i % 3}`, [`array_item${i % 5}`], i * 5),
			);
		}

		// Verify function index produces different results based on input
		const number_fn = collection.get_index<(threshold: string) => Array<TestItem>>('by_min_number');

		// These should return different filtered subsets without storing separate copies
		assert.ok(number_fn('10').length !== number_fn('50').length);
		assert.strictEqual(number_fn('0').length, 20); // All items
		assert.strictEqual(number_fn('50').length, 10); // Half the items
		assert.strictEqual(number_fn('90').length, 2); // Just the highest values
	});

	test('memory usage with large datasets', () => {
		// This test creates a large dataset and verifies indexes work efficiently
		// Create index using the helper function
		const by_string_b_index = create_multi_index<TestItem, string>({
			key: 'by_string_b',
			extractor: (item) => item.string_b,
			query_schema: z.string(),
		});

		// Create a collection with the proper index
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [by_string_b_index],
		});

		// Create a large dataset (~1000 items)
		const large_dataset = Array.from({length: 1000}, (_, i) =>
			create_item(`string_a${i}`, `string_b${i % 10}`, [`array_item${i % 20}`], i),
		);

		// Add them in one batch
		collection.add_many(large_dataset);
		// console.log(`collection.indexes`, $state.snapshot(collection.indexes));

		// Verify the index contains the expected number of categories
		const b_index = collection.get_index<Map<string, Array<TestItem>>>('by_string_b');
		// console.log(`b_index`, $state.snapshot(b_index));
		assert.strictEqual(b_index.size, 10); // 10 unique categories

		// Verify each category has the right number of items
		for (let i = 0; i < 10; i++) {
			assert.strictEqual(collection.where('by_string_b', `string_b${i}`).length, 100); // 1000 items / 10 categories = 100 per category
		}
	});
});
