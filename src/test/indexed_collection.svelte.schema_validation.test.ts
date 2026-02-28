// @slop Claude Sonnet 3.7

// @vitest-environment jsdom

import {test, expect, describe, vi} from 'vitest';
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
		expect(query_result.string_a).toBe('a1');

		// Get single index and check schema validation passed
		const email_index = collection.single_index('by_string_b');
		expect(email_index.size).toBe(2);
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
		expect(mid_items.length).toBe(1);
		expect(mid_items[0]!.string_a).toBe('a2');

		// Test array index
		const item2_matches = collection.query<Array<TestItem>, string>('by_array', 'item2');
		expect(item2_matches.length).toBe(2);
		expect(item2_matches.some((item) => item.string_a === 'a1')).toBe(true);
		expect(item2_matches.some((item) => item.string_a === 'a3')).toBe(true);

		const item3_matches = collection.query<Array<TestItem>, string>('by_array', 'item3');
		expect(item3_matches.length).toBe(2);
		expect(item3_matches.some((item) => item.string_a === 'a2')).toBe(true);
		expect(item3_matches.some((item) => item.string_a === 'a4')).toBe(true);

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
		expect(flagged_adults.length).toBe(1);
		expect(flagged_adults[0]!.string_a).toBe('a1');

		// Add another qualifying item and verify index updates
		collection.add(create_item('a5', 'b5@test.com', 40, true));
		expect(collection.derived_index('flagged_adults').length).toBe(2);
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
		expect(young_range.length).toBe(2);
		expect(young_range.map((item) => item.string_a).sort()).toEqual(['a1', 'a3']);

		// Test flag with specific array values
		const flagged_with_item1 = search_fn({only_flagged: true, array_values: ['item1']});
		expect(flagged_with_item1.length).toBe(2);
		expect(flagged_with_item1.map((item) => item.string_a).sort()).toEqual(['a1', 'a4']);

		// Test items over 30 that are flagged with specific array values
		const high_number_with_item3 = search_fn({
			min_number: 30,
			only_flagged: true,
			array_values: ['item3'],
		});
		expect(high_number_with_item3.length).toBe(2);
		expect(high_number_with_item3.map((item) => item.string_a).sort()).toEqual(['a2', 'a4']);

		// Test using query method
		const with_item5 = collection.query<Array<TestItem>, ItemQuery>('item_search', {
			array_values: ['item5'],
		});
		expect(with_item5.length).toBe(1);
		expect(with_item5[0]!.string_a).toBe('a4');
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
		expect(console_error_spy).toHaveBeenCalledWith(
			expect.stringContaining('Query validation failed for index by_string_b'),
			expect.anything(),
		);

		// Try querying with out-of-range number
		collection.query('by_number', 5);
		expect(console_error_spy).toHaveBeenCalledWith(
			expect.stringContaining('Query validation failed for index by_number'),
			expect.anything(),
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
		expect(console_error_spy).not.toHaveBeenCalled();

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
		expect(collection.by_optional('by_nested_option', 'x')?.string_a).toBe('a1');
		expect(collection.by_optional('by_nested_option', 'y')?.string_a).toBe('a2');

		// Test compound key lookup
		expect(collection.where('by_compound', 'a1-x').length).toBe(1);
		expect(collection.where('by_compound', 'a2-y').length).toBe(1);
	});
});
