// @vitest-environment jsdom

import {test, assert, describe, vi} from 'vitest';
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
	string_b: string;
	number: number;
	flag: boolean;
	array: Array<string>;
	nested: {
		option: 'x' | 'y';
		enabled: boolean;
	};
}

// Helper function to create test items with predictable values
const create_item = (
	string_a: string,
	string_b: string,
	number: number,
	flag: boolean = true,
	array: Array<string> = ['item1'],
	option: 'x' | 'y' = 'x',
): TestItem => ({
	id: create_uuid(),
	string_a,
	string_b,
	number,
	flag,
	array,
	nested: {
		option,
		enabled: true,
	},
});

// Define test schemas
const email_schema = z.email();
const range_schema = z.number().int().gte(10).lte(100);
const str_schema = z.string().min(1);

describe('IndexedCollection - Schema Validation', () => {
	test('single index validates schemas correctly', () => {
		// Create a collection with validation enabled
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_string_b',
					extractor: (item) => item.string_b,
					query_schema: email_schema,
				}),
				create_single_index({
					key: 'by_string_a',
					extractor: (item) => item.string_a,
					query_schema: z.string(),
				}),
			],
			validate: true, // Enable schema validation
		});

		// Add valid items
		const item1 = create_item('a1', 'a1@zzz.software', 25);
		const item2 = create_item('a2', 'a2@zzz.software', 30);

		collection.add(item1);
		collection.add(item2);

		// Test query with valid email
		const query_result = collection.query<TestItem, string>('by_string_b', 'a1@zzz.software');
		assert.strictEqual(query_result.string_a, 'a1');

		// Get single index and check schema validation passed
		const email_index = collection.single_index('by_string_b');
		assert.strictEqual(email_index.size, 2);
	});

	test('multi index properly validates input and output', () => {
		// Create spy to check console errors
		const console_error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_multi_index({
					key: 'by_array',
					extractor: (item) => item.array,
					query_schema: str_schema,
				}),
				create_multi_index({
					key: 'by_number_range',
					extractor: (item) => {
						if (item.number < 20) return 'low';
						if (item.number < 50) return 'mid';
						return 'high';
					},
					query_schema: z.enum(['low', 'mid', 'high']),
				}),
			],
			validate: true,
		});

		// Add items across different ranges
		collection.add(create_item('a1', 'b1@test.com', 15, true, ['item1', 'item2']));
		collection.add(create_item('a2', 'b2@test.com', 30, true, ['item1', 'item3']));
		collection.add(create_item('a3', 'b3@test.com', 60, true, ['item2', 'item4']));
		collection.add(create_item('a4', 'b4@test.com', 90, true, ['item3', 'item4']));

		// Test range query validation
		const mid_items = collection.query<Array<TestItem>, string>('by_number_range', 'mid');
		assert.strictEqual(mid_items.length, 1);
		assert.strictEqual(mid_items[0]!.string_a, 'a2');

		// Test array index
		const item2_matches = collection.query<Array<TestItem>, string>('by_array', 'item2');
		assert.strictEqual(item2_matches.length, 2);
		assert.ok(item2_matches.some((item) => item.string_a === 'a1'));
		assert.ok(item2_matches.some((item) => item.string_a === 'a3'));

		const item3_matches = collection.query<Array<TestItem>, string>('by_array', 'item3');
		assert.strictEqual(item3_matches.length, 2);
		assert.ok(item3_matches.some((item) => item.string_a === 'a2'));
		assert.ok(item3_matches.some((item) => item.string_a === 'a4'));

		// Restore console.error
		console_error_spy.mockRestore();
	});

	test('derived index supports schema validation', () => {
		// Create collection with derived index using schemas
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_derived_index({
					key: 'flagged_adults',
					compute: (collection) => {
						const result = [];
						for (const item of collection.by_id.values()) {
							if (item.flag && item.number >= 18) {
								result.push(item);
							}
						}
						return result;
					},
					matches: (item) => item.flag && item.number >= 18,
					query_schema: z.void(),
				}),
			],
			validate: true,
		});

		// Add mix of items with different flag/number values
		collection.add(create_item('a1', 'b1@test.com', 25, true)); // flag=true, number>=18
		collection.add(create_item('a2', 'b2@test.com', 30, false)); // flag=false, number>=18
		collection.add(create_item('a3', 'b3@test.com', 16, true)); // flag=true, number<18
		collection.add(create_item('a4', 'b4@test.com', 17, false)); // flag=false, number<18

		// Check derived index correctness
		const flagged_adults = collection.derived_index('flagged_adults');
		assert.strictEqual(flagged_adults.length, 1);
		assert.strictEqual(flagged_adults[0]!.string_a, 'a1');

		// Add another qualifying item and verify index updates
		collection.add(create_item('a5', 'b5@test.com', 40, true));
		assert.strictEqual(collection.derived_index('flagged_adults').length, 2);
	});

	test('dynamic index validates complex query parameters', () => {
		// Define schemas for dynamic function
		const query_schema = z.object({
			min_number: z.number().optional(),
			max_number: z.number().optional(),
			only_flagged: z.boolean().optional(),
			array_values: z.array(z.string()).optional(),
		});

		type ItemQuery = z.infer<typeof query_schema>;

		// Create a dynamic index with complex query parameters
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_dynamic_index<TestItem, (query: ItemQuery) => Array<TestItem>>({
					key: 'item_search',
					factory: (collection) => {
						return (query: ItemQuery) => {
							const result = [];
							for (const item of collection.by_id.values()) {
								// Filter by number range if specified
								if (query.min_number !== undefined && item.number < query.min_number) continue;
								if (query.max_number !== undefined && item.number > query.max_number) continue;

								// Filter by flag status if specified
								if (query.only_flagged !== undefined && query.only_flagged && !item.flag) continue;

								// Filter by array if specified
								if (query.array_values !== undefined && query.array_values.length > 0) {
									const has_match = query.array_values.some((v) => item.array.includes(v));
									if (!has_match) continue;
								}

								result.push(item);
							}
							return result;
						};
					},
					query_schema,
				}),
			],
			validate: true,
		});

		// Add various items
		collection.add(create_item('a1', 'b1@test.com', 25, true, ['item1', 'item2']));
		collection.add(create_item('a2', 'b2@test.com', 35, true, ['item3', 'item4']));
		collection.add(create_item('a3', 'b3@test.com', 18, false, ['item2']));
		collection.add(create_item('a4', 'b4@test.com', 45, true, ['item1', 'item3', 'item5']));
		collection.add(create_item('a5', 'b5@test.com', 16, true, ['item4']));

		// Get the dynamic search function
		const search_fn = collection.get_index<(query: ItemQuery) => Array<TestItem>>('item_search');

		// Test number range query
		const young_range = search_fn({min_number: 18, max_number: 30});
		assert.strictEqual(young_range.length, 2);
		assert.deepEqual(young_range.map((item) => item.string_a).sort(), ['a1', 'a3']);

		// Test flag with specific array values
		const flagged_with_item1 = search_fn({only_flagged: true, array_values: ['item1']});
		assert.strictEqual(flagged_with_item1.length, 2);
		assert.deepEqual(flagged_with_item1.map((item) => item.string_a).sort(), ['a1', 'a4']);

		// Test items over 30 that are flagged with specific array values
		const high_number_with_item3 = search_fn({
			min_number: 30,
			only_flagged: true,
			array_values: ['item3'],
		});
		assert.strictEqual(high_number_with_item3.length, 2);
		assert.deepEqual(high_number_with_item3.map((item) => item.string_a).sort(), ['a2', 'a4']);

		// Test using query method
		const with_item5 = collection.query<Array<TestItem>, ItemQuery>('item_search', {
			array_values: ['item5'],
		});
		assert.strictEqual(with_item5.length, 1);
		assert.strictEqual(with_item5[0]!.string_a, 'a4');
	});

	test('schema validation errors are properly handled', () => {
		// Mock console.error to catch validation errors
		const console_error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// Create collection with validation
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_string_b',
					extractor: (item) => item.string_b,
					query_schema: email_schema,
				}),
				create_single_index({
					key: 'by_number',
					extractor: (item) => item.number,
					query_schema: range_schema,
				}),
			],
			validate: true,
		});

		// Add items with valid data
		collection.add(create_item('a1', 'valid@zzz.software', 25));

		// Try querying with invalid email format
		collection.query('by_string_b', 'not-an-email');
		assert.ok(
			console_error_spy.mock.calls.some(
				([msg]) =>
					typeof msg === 'string' && msg.includes('Query validation failed for index by_string_b'),
			),
		);

		// Try querying with out-of-range number
		collection.query('by_number', 5);
		assert.ok(
			console_error_spy.mock.calls.some(
				([msg]) =>
					typeof msg === 'string' && msg.includes('Query validation failed for index by_number'),
			),
		);

		console_error_spy.mockRestore();
	});

	test('validation can be bypassed when disabled', () => {
		// Mock console.error to verify no validation errors
		const console_error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// Create collection without validation
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_string_b',
					extractor: (item) => item.string_b,
					query_schema: email_schema,
				}),
				create_single_index({
					key: 'by_number',
					extractor: (item) => item.number,
					query_schema: range_schema,
				}),
			],
			validate: false, // Explicitly disable validation
		});

		// Add items
		collection.add(create_item('a1', 'valid@zzz.software', 25));

		// These queries would fail validation, but should not trigger console errors
		collection.query('by_string_b', 'not-an-email');
		collection.query('by_number', 5);

		// Verify no validation errors were logged
		assert.strictEqual(console_error_spy.mock.calls.length, 0);

		console_error_spy.mockRestore();
	});

	test('nested properties are properly validated', () => {
		// Schema for nested property validation
		const option_schema = z.enum(['x', 'y']);

		// Create collection with complex validation
		const collection: IndexedCollection<TestItem> = new IndexedCollection({
			indexes: [
				create_single_index({
					key: 'by_nested_option',
					extractor: (item) => item.nested.option,
					query_schema: option_schema,
				}),
				create_multi_index({
					key: 'by_compound',
					extractor: (item) => {
						// Return a compound key made from multiple fields
						return `${item.string_a}-${item.nested.option}`;
					},
					query_schema: z.string().regex(/^[a-z0-9]+-[xy]$/),
				}),
			],
			validate: true,
		});

		// Add items with valid nested properties
		const item1 = create_item('a1', 'b1@test.com', 25, true, ['item1'], 'x');
		const item2 = create_item('a2', 'b2@test.com', 35, true, ['item2'], 'y');

		collection.add(item1);
		collection.add(item2);

		// Test lookup by nested property - use by_optional instead of where for single index
		assert.strictEqual(collection.by_optional('by_nested_option', 'x')?.string_a, 'a1');
		assert.strictEqual(collection.by_optional('by_nested_option', 'y')?.string_a, 'a2');

		// Test compound key lookup
		assert.strictEqual(collection.where('by_compound', 'a1-x').length, 1);
		assert.strictEqual(collection.where('by_compound', 'a2-y').length, 1);
	});
});
