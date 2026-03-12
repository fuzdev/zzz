// @vitest-environment jsdom

import {test, describe, beforeEach, assert} from 'vitest';
import {z} from 'zod';

import {IndexedCollection} from '$lib/indexed_collection.svelte.js';
import {
	create_single_index,
	create_multi_index,
	create_derived_index,
	type IndexedItem,
} from '$lib/indexed_collection_helpers.svelte.js';
import {create_uuid, Uuid} from '$lib/zod_helpers.js';

// Test item representing a generic item
interface TestItem {
	id: Uuid;
	string_a: string;
	string_b: string;
	array_a: Array<string>;
	string_c: string;
	date_a: Date;
	number_a: number;
	boolean_a: boolean;
}

// Helper to create items with default values that can be overridden
const create_test_item = (overrides: Partial<TestItem> = {}): TestItem => ({
	id: create_uuid(),
	string_a: 'a1',
	string_b: 'b1',
	array_a: ['tag1'],
	string_c: 'c1',
	date_a: new Date(),
	number_a: 3,
	boolean_a: false,
	...overrides,
});

// Helper functions for id-based object equality checks
const has_item_with_id = (array: Array<IndexedItem>, item: IndexedItem): boolean =>
	array.some((i) => i.id === item.id);

describe('IndexedCollection - Query Capabilities', () => {
	let collection: IndexedCollection<TestItem>;
	let items: Array<TestItem>;

	beforeEach(() => {
		// Create a collection with various indexes
		collection = new IndexedCollection<TestItem>({
			indexes: [
				// Single value indexes
				create_single_index({
					key: 'by_string_a',
					extractor: (item) => item.string_a.toLowerCase(), // Case insensitive
					query_schema: z.string(),
				}),
				create_single_index({
					key: 'by_string_b',
					extractor: (item) => item.string_b, // Case sensitive
					query_schema: z.string(),
				}),

				// Multi value indexes
				create_multi_index({
					key: 'by_string_c',
					extractor: (item) => item.string_c,
					query_schema: z.string(),
				}),
				create_multi_index({
					key: 'by_array_a',
					extractor: (item) => item.array_a,
					query_schema: z.string(),
				}),
				create_multi_index({
					key: 'by_number_a',
					extractor: (item) => item.number_a,
					query_schema: z.number(),
				}),
				create_multi_index({
					key: 'by_boolean_a',
					extractor: (item) => (item.boolean_a ? 'y' : 'n'),
					query_schema: z.enum(['y', 'n']),
				}),
				create_multi_index({
					key: 'by_year',
					extractor: (item) => item.date_a.getFullYear(),
					query_schema: z.number(),
				}),

				// Derived indexes
				create_derived_index({
					key: 'recent_boolean_a_true',
					compute: (collection) => {
						const filtered_items = [];
						for (const item of collection.by_id.values()) {
							if (item.boolean_a) {
								filtered_items.push(item);
							}
						}
						return filtered_items
							.sort((a, b) => b.date_a.getTime() - a.date_a.getTime())
							.slice(0, 5); // Top 5 recent boolean_a=true items
					},
					matches: (item) => item.boolean_a,
					onadd: (items, item) => {
						if (!item.boolean_a) return items;

						// Find the right position based on date_a (newer items first)
						const index = items.findIndex(
							(existing) => item.date_a.getTime() > existing.date_a.getTime(),
						);

						if (index === -1) {
							items.push(item);
						} else {
							items.splice(index, 0, item);
						}

						// Maintain max size
						if (items.length > 5) {
							items.length = 5;
						}
						return items;
					},
					onremove: (items, item) => {
						const index = items.findIndex((i) => i.id === item.id);
						if (index !== -1) {
							items.splice(index, 1);
						}
						return items;
					},
				}),
				create_derived_index({
					key: 'high_number_a',
					compute: (collection) => {
						const result = [];
						for (const item of collection.by_id.values()) {
							if (item.number_a >= 4) {
								result.push(item);
							}
						}
						return result;
					},
					matches: (item) => item.number_a >= 4,
					onadd: (items, item) => {
						if (item.number_a >= 4) {
							items.push(item);
						}
						return items;
					},
					onremove: (items, item) => {
						const index = items.findIndex((i) => i.id === item.id);
						if (index !== -1) {
							items.splice(index, 1);
						}
						return items;
					},
				}),
			],
		});

		// Create test items with simple names
		const now = Date.now();
		items = [
			create_test_item({
				string_a: 'a1',
				string_b: 'b1',
				array_a: ['tag1', 'tag2', 'tag3'],
				string_c: 'c1',
				date_a: new Date(now - 1000 * 60 * 60 * 24 * 10), // 10 days ago
				number_a: 4,
				boolean_a: true,
			}),
			create_test_item({
				string_a: 'a2',
				string_b: 'b2',
				array_a: ['tag1', 'tag4'],
				string_c: 'c1',
				date_a: new Date(now - 1000 * 60 * 60 * 24 * 20), // 20 days ago
				number_a: 5,
				boolean_a: true,
			}),
			create_test_item({
				string_a: 'b1',
				string_b: 'b1',
				array_a: ['tag2', 'tag5'],
				string_c: 'c2',
				date_a: new Date(now - 1000 * 60 * 60 * 24 * 5), // 5 days ago
				number_a: 4,
				boolean_a: false,
			}),
			create_test_item({
				string_a: 'other',
				string_b: 'b3',
				array_a: ['tag3', 'tag6'],
				string_c: 'c3',
				date_a: new Date(now - 1000 * 60 * 60 * 24 * 30), // 30 days ago
				number_a: 3,
				boolean_a: false,
			}),
			create_test_item({
				string_a: 'b2',
				string_b: 'b3',
				array_a: ['tag1', 'tag5'],
				string_c: 'c2',
				date_a: new Date(now - 1000 * 60 * 60 * 24 * 3), // 3 days ago
				number_a: 5,
				boolean_a: true,
			}),
		];

		// Add all items to the collection
		collection.add_many(items);
	});

	test('basic query operations', () => {
		// Single index direct lookup
		assert.strictEqual(collection.by_optional('by_string_a', 'a1'.toLowerCase()), items[0]);
		assert.ok(collection.by_optional('by_string_b', 'b1') !== undefined);

		// Multi index direct lookup
		assert.strictEqual(collection.where('by_string_c', 'c1').length, 2);
		assert.strictEqual(collection.where('by_number_a', 5).length, 2);
		assert.strictEqual(collection.where('by_boolean_a', 'y').length, 3);

		// Non-existent values
		assert.ok(collection.by_optional('by_string_a', 'nonexistent') === undefined);
		assert.strictEqual(collection.where('by_string_c', 'nonexistent').length, 0);
	});

	test('case sensitivity in queries', () => {
		// Case insensitive string_a lookup (extractor converts to lowercase)
		assert.strictEqual(collection.by_optional('by_string_a', 'a1'.toLowerCase()), items[0]);
		assert.strictEqual(collection.by_optional('by_string_a', 'A1'.toLowerCase()), items[0]);

		// Case sensitive string_b lookup (no conversion in extractor)
		assert.ok(collection.by_optional('by_string_b', 'B1') === undefined);
		assert.ok(collection.by_optional('by_string_b', 'b1') !== undefined);
	});

	test('compound queries combining indexes', () => {
		// Find c1 items with string_b=b1
		const c1_items = collection.where('by_string_c', 'c1');
		const b1_c1_items = c1_items.filter((item) => item.string_b === 'b1');
		assert.strictEqual(b1_c1_items.length, 1);
		assert.strictEqual(b1_c1_items[0]!.string_a, 'a1');

		// Find boolean_a=true items with number_a=5
		const boolean_a_true_items = collection.where('by_boolean_a', 'y');
		const high_value_boolean_a_true = boolean_a_true_items.filter((item) => item.number_a === 5);
		assert.strictEqual(high_value_boolean_a_true.length, 2);
		assert.include(
			high_value_boolean_a_true.map((i) => i.string_a),
			'a2',
		);
		assert.include(
			high_value_boolean_a_true.map((i) => i.string_a),
			'b2',
		);
	});

	test('queries with array values', () => {
		// Query by array_a (checks if any tag matches)
		const tag1_items = collection.where('by_array_a', 'tag1');
		assert.strictEqual(tag1_items.length, 3);
		assert.include(
			tag1_items.map((i) => i.string_a),
			'a1',
		);
		assert.include(
			tag1_items.map((i) => i.string_a),
			'a2',
		);
		assert.include(
			tag1_items.map((i) => i.string_a),
			'b2',
		);

		// Multiple tags intersection (using multiple queries)
		const tag2_items = collection.where('by_array_a', 'tag2');
		const tag2_and_tag3_items = tag2_items.filter((item) => item.array_a.includes('tag3'));
		assert.strictEqual(tag2_and_tag3_items.length, 1);
		assert.strictEqual(tag2_and_tag3_items[0]!.string_a, 'a1');
	});

	test('derived index queries', () => {
		// Test the recent_boolean_a_true derived index
		const recent_boolean_a_true = collection.derived_index('recent_boolean_a_true');
		assert.strictEqual(recent_boolean_a_true.length, 3); // All boolean_a=true items

		// Verify order (most recent first)
		const rbt0 = recent_boolean_a_true[0];
		const rbt1 = recent_boolean_a_true[1];
		const rbt2 = recent_boolean_a_true[2];
		assert.isDefined(rbt0);
		assert.isDefined(rbt1);
		assert.isDefined(rbt2);
		assert.strictEqual(rbt0.string_a, 'b2'); // 3 days ago
		assert.strictEqual(rbt1.string_a, 'a1'); // 10 days ago
		assert.strictEqual(rbt2.string_a, 'a2'); // 20 days ago

		// Test the high_number_a derived index which should include all items with number_a >= 4
		const high_number_a = collection.derived_index('high_number_a');
		assert.strictEqual(high_number_a.length, 4);
		assert.deepEqual(high_number_a.map((i) => i.string_a).sort(), ['a1', 'a2', 'b1', 'b2'].sort());
	});

	test('first/latest with multi-index', () => {
		// Get first c1 item
		const first_c1 = collection.first('by_string_c', 'c1', 1);
		assert.strictEqual(first_c1.length, 1);
		const first_c1_item = first_c1[0];
		assert.isDefined(first_c1_item);

		// Get latest c2 item
		const latest_c2 = collection.latest('by_string_c', 'c2', 1);
		assert.strictEqual(latest_c2.length, 1);
		const latest_c2_item = latest_c2[0];
		assert.isDefined(latest_c2_item);
	});

	test('time-based queries', () => {
		// Query by year
		const current_year = new Date().getFullYear();
		const this_year_items = collection.where('by_year', current_year);

		const items_this_year_count = collection.values.filter(
			(item) => item.date_a.getFullYear() === current_year,
		).length;
		assert.strictEqual(this_year_items.length, items_this_year_count);

		// More complex date range query - last 7 days
		const now = Date.now();
		const recent_items = collection.values.filter(
			(item) => item.date_a.getTime() > now - 1000 * 60 * 60 * 24 * 7,
		);
		assert.include(
			recent_items.map((i) => i.string_a),
			'b1',
		); // 5 days ago
		assert.include(
			recent_items.map((i) => i.string_a),
			'b2',
		); // 3 days ago
	});

	test('adding items affects derived queries correctly', () => {
		// Add a new boolean_a=true item with high number_a
		const new_item = create_test_item({
			string_a: 'new',
			string_b: 'b4',
			array_a: ['tag7'],
			string_c: 'c4',
			date_a: new Date(), // Now (most recent)
			number_a: 5,
			boolean_a: true,
		});

		collection.add(new_item);

		// Check that it appears at the top of the recent_boolean_a_true list
		const recent_boolean_a_true = collection.derived_index('recent_boolean_a_true');
		assert.strictEqual(recent_boolean_a_true[0]!.id, new_item.id);

		// Check that it appears in high_number_a
		const high_number_a = collection.derived_index('high_number_a');
		assert.ok(has_item_with_id(high_number_a, new_item));
	});

	test('removing items updates derived queries', () => {
		// Remove the most recent boolean_a=true item
		const item_to_remove = items[4]; // b2 (most recent boolean_a=true)
		assert.isDefined(item_to_remove);

		collection.remove(item_to_remove.id);

		// Check that recent_boolean_a_true updates correctly
		const recent_boolean_a_true = collection.derived_index('recent_boolean_a_true');
		assert.strictEqual(recent_boolean_a_true.length, 2);
		const rbt0 = recent_boolean_a_true[0];
		const rbt1 = recent_boolean_a_true[1];
		assert.isDefined(rbt0);
		assert.isDefined(rbt1);
		assert.strictEqual(rbt0.string_a, 'a1');
		assert.strictEqual(rbt1.string_a, 'a2');

		// Check that high_number_a updates correctly
		const high_number_a = collection.derived_index('high_number_a');
		assert.notInclude(high_number_a, item_to_remove);
		assert.strictEqual(high_number_a.length, 3); // Started with 4, removed 1
	});

	test('dynamic ordering of query results', () => {
		// Get all items and sort by number_a (highest first)
		const sorted_by_number_a = collection.values.slice().sort((a, b) => b.number_a - a.number_a);
		assert.strictEqual(sorted_by_number_a[0]!.number_a, 5);

		// Sort by creation time (newest first)
		const sorted_by_time = collection.values
			.slice()
			.sort((a, b) => b.date_a.getTime() - a.date_a.getTime());
		assert.strictEqual(sorted_by_time[0]!.string_a, 'b2'); // 3 days ago
	});
});

describe('IndexedCollection - Search Patterns', () => {
	let collection: IndexedCollection<TestItem>;

	beforeEach(() => {
		collection = new IndexedCollection<TestItem>({
			indexes: [
				// Word-based index that splits string_a into words for searching
				create_multi_index({
					key: 'by_word',
					extractor: (item) => item.string_a.toLowerCase().split(/\s+/),
					query_schema: z.string(),
				}),

				// Range-based categorization
				create_multi_index({
					key: 'by_number_a_range',
					extractor: (item) => {
						if (item.number_a <= 2) return 'low';
						if (item.number_a <= 4) return 'mid';
						return 'high';
					},
					query_schema: z.enum(['low', 'mid', 'high']),
				}),
			],
		});

		const test_items = [
			create_test_item({
				string_a: 'alpha beta gamma',
				number_a: 5,
			}),
			create_test_item({
				string_a: 'alpha delta',
				number_a: 4,
			}),
			create_test_item({
				string_a: 'beta epsilon',
				number_a: 3,
			}),
			create_test_item({
				string_a: 'gamma delta',
				number_a: 2,
			}),
		];

		collection.add_many(test_items);
	});

	test('word-based search', () => {
		// Find items with "alpha" in string_a
		const alpha_items = collection.where('by_word', 'alpha');
		assert.strictEqual(alpha_items.length, 2);

		// Find items with "beta" in string_a
		const beta_items = collection.where('by_word', 'beta');
		assert.strictEqual(beta_items.length, 2);

		// Find items with both "alpha" and "beta" (intersection)
		const alpha_beta_items = alpha_items.filter((item) =>
			item.string_a.toLowerCase().includes('beta'),
		);
		assert.strictEqual(alpha_beta_items.length, 1);
		assert.strictEqual(alpha_beta_items[0]!.string_a, 'alpha beta gamma');
	});

	test('range-based categorization', () => {
		// Find high-number_a items
		const high_number_a = collection.where('by_number_a_range', 'high');
		assert.strictEqual(high_number_a.length, 1);
		assert.strictEqual(high_number_a[0]!.number_a, 5);

		// Find mid-number_a items
		const mid_number_a = collection.where('by_number_a_range', 'mid');
		assert.strictEqual(mid_number_a.length, 2);

		// Find low-number_a items
		const low_number_a = collection.where('by_number_a_range', 'low');
		assert.strictEqual(low_number_a.length, 1);
		assert.strictEqual(low_number_a[0]!.number_a, 2);
	});
});
