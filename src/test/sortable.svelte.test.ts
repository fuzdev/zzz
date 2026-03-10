// @vitest-environment jsdom

import {test, describe, beforeEach, assert} from 'vitest';
import {z} from 'zod';

import {Sortable, type Sorter, sort_by_text, sort_by_numeric} from '$lib/sortable.svelte.js';
import {Cell} from '$lib/cell.svelte.js';
import {UuidWithDefault, type Uuid, DatetimeNow, create_uuid} from '$lib/zod_helpers.js';
import {Frontend} from '$lib/frontend.svelte.js';
import {monkeypatch_zzz_for_tests} from './test_helpers.ts';

// Create a schema for our test cell
const TestCellSchema = z.object({
	id: UuidWithDefault,
	created: DatetimeNow,
	updated: DatetimeNow,
	name: z.string(),
	value: z.number(),
});

// Real cell class for testing - extends the Cell base class
class TestCell extends Cell<typeof TestCellSchema> {
	name: string = $state('');
	value: number = $state(0);

	constructor(app: Frontend, id: Uuid, name: string, value: number, override_cid?: number) {
		super(TestCellSchema, {
			app,
			json: {
				id,
				name,
				value,
			},
		});

		// Allow test to override the monotonic cid for testing sorting behavior
		if (override_cid !== undefined) {
			(this as any).cid = override_cid;
		}

		this.init();
	}
}

describe('Sortable', () => {
	let items: Array<TestCell>;
	let sorters: Array<Sorter<TestCell>>;
	let app: Frontend;

	const id1 = create_uuid();
	const id2 = create_uuid();
	const id3 = create_uuid();
	const id4 = create_uuid();

	beforeEach(() => {
		// Setup a real Zzz instance for testing
		app = monkeypatch_zzz_for_tests(new Frontend());

		// Create test items with intentional name collisions to test stable sorting
		items = [
			new TestCell(app, id3, 'Banana', 10, 30),
			new TestCell(app, id1, 'Apple', 5, 10),
			new TestCell(app, id2, 'Cherry', 15, 20),
			new TestCell(app, id4, 'Apple', 20, 40), // Same name as item with id1
		];

		sorters = [
			sort_by_text('name', 'Name', 'name'),
			sort_by_text('name_desc', 'Name (desc)', 'name', 'desc'),
			sort_by_numeric('value', 'Value', 'value'),
			sort_by_numeric('value_desc', 'Value (desc)', 'value', 'desc'),
		];
	});

	describe('constructor', () => {
		test('initializes with default values', () => {
			const sortable = new Sortable(
				() => items,
				() => sorters,
			);

			const first_sorter = sorters[0];
			assert.isDefined(first_sorter);
			assert.strictEqual(sortable.items, items);
			assert.strictEqual(sortable.sorters, sorters);
			assert.strictEqual(sortable.active_key, first_sorter!.key);
			assert.strictEqual(sortable.active_sorter, first_sorter);
			assert.strictEqual(sortable.active_sort_fn, first_sorter!.fn);
		});

		test('uses default key when provided', () => {
			const sortable = new Sortable(
				() => items,
				() => sorters,
				() => 'value',
			);

			const sorter_at_2 = sorters[2];
			assert.isDefined(sorter_at_2);
			assert.strictEqual(sortable.default_key, 'value');
			assert.strictEqual(sortable.active_key, 'value');
			assert.strictEqual(sortable.active_sorter, sorter_at_2);
		});

		test('falls back to first sorter when default key is invalid', () => {
			const sortable = new Sortable(
				() => items,
				() => sorters,
				() => 'invalid_key',
			);

			const first_sorter = sorters[0];
			assert.isDefined(first_sorter);
			assert.strictEqual(sortable.default_key, 'invalid_key');
			assert.strictEqual(sortable.active_key, first_sorter!.key);
		});

		test('handles empty sorters array', () => {
			const sortable = new Sortable(
				() => items,
				() => [],
			);

			assert.strictEqual(sortable.active_key, '');
			assert.ok(sortable.active_sorter === undefined);
			assert.ok(sortable.active_sort_fn === undefined);
		});
	});

	describe('update_active_key', () => {
		test('updates key when sorters change', () => {
			let current_sorters = $state([...sorters]);
			const sortable = new Sortable(
				() => items,
				() => current_sorters,
			);

			const first_sorter = sorters[0];
			assert.isDefined(first_sorter);
			assert.strictEqual(sortable.active_key, first_sorter!.key);

			// Change sorters to new array without the current active key
			current_sorters = [sorters[2]!, sorters[3]!];

			// Since the effect has been removed, manually call update_active_key
			// Expect active key to change to value (the key of the first sorter in the new array)
			sortable.update_active_key();

			// Now the active key should match the first sorter in the new array
			assert.strictEqual(sortable.active_key, 'value');
		});

		test('preserves active key if still valid after sorters change', () => {
			let current_sorters = [...sorters];
			const sortable = new Sortable(
				() => items,
				() => current_sorters,
			);

			const sorter_at_1 = sorters[1];
			const sorter_at_2 = sorters[2];
			assert.isDefined(sorter_at_1);
			assert.isDefined(sorter_at_2);

			// Set active key to the second sorter
			sortable.active_key = sorter_at_1!.key;

			// Change sorters but keep the active key
			current_sorters = [sorter_at_1!, sorter_at_2!];
			sortable.update_active_key();

			assert.strictEqual(sortable.active_key, sorter_at_1!.key);
		});
	});

	describe('sort_by_text', () => {
		test('sorts text values in ascending order', () => {
			const sorter_0 = sorters[0];
			assert.isDefined(sorter_0);
			const sortable = new Sortable(
				() => items,
				() => [sorter_0!],
			);
			const sorted = sortable.sorted_items;

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0!.name, 'Apple');
			assert.strictEqual(item1!.name, 'Apple');
			assert.strictEqual(item2!.name, 'Banana');
			assert.strictEqual(item3!.name, 'Cherry');

			// Verify that items with the same name are sorted by cid as fallback
			assert.strictEqual(item0!.cid, 40); // First "Apple" has higher cid
			assert.strictEqual(item1!.cid, 10); // Second "Apple" has lower cid
		});

		test('sorts text values in descending order', () => {
			const sorter_1 = sorters[1];
			assert.isDefined(sorter_1);
			const sortable = new Sortable(
				() => items,
				() => [sorter_1!],
			);
			const sorted = sortable.sorted_items;

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0!.name, 'Cherry');
			assert.strictEqual(item1!.name, 'Banana');
			assert.strictEqual(item2!.name, 'Apple');
			assert.strictEqual(item3!.name, 'Apple');

			// Verify that items with the same name are sorted by cid as fallback
			assert.strictEqual(item2!.cid, 40); // First "Apple" has higher cid
			assert.strictEqual(item3!.cid, 10); // Second "Apple" has lower cid
		});
	});

	describe('sort_by_numeric', () => {
		test('sorts numeric values in ascending order', () => {
			const sorter_2 = sorters[2];
			assert.isDefined(sorter_2);
			const sortable = new Sortable(
				() => items,
				() => [sorter_2!],
			);
			const sorted = sortable.sorted_items;

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0!.value, 5);
			assert.strictEqual(item1!.value, 10);
			assert.strictEqual(item2!.value, 15);
			assert.strictEqual(item3!.value, 20);
		});

		test('sorts numeric values in descending order', () => {
			const sorter_3 = sorters[3];
			assert.isDefined(sorter_3);
			const sortable = new Sortable(
				() => items,
				() => [sorter_3!],
			);
			const sorted = sortable.sorted_items;

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0!.value, 20);
			assert.strictEqual(item1!.value, 15);
			assert.strictEqual(item2!.value, 10);
			assert.strictEqual(item3!.value, 5);
		});

		test('maintains stable sort order with equal values using cid', () => {
			// Create items with equal values but different cids
			const equal_items = [
				new TestCell(app, create_uuid(), 'Item3', 10, 300),
				new TestCell(app, create_uuid(), 'Item1', 10, 100),
				new TestCell(app, create_uuid(), 'Item2', 10, 200),
			];

			const equal_sorter = sort_by_numeric<TestCell>('value', 'Value', 'value');
			const sortable = new Sortable(
				() => equal_items,
				() => [equal_sorter],
			);
			const sorted = sortable.sorted_items;

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);

			// Items with equal values should be sorted by cid
			assert.strictEqual(item0!.cid, 300);
			assert.strictEqual(item1!.cid, 200);
			assert.strictEqual(item2!.cid, 100);
		});
	});

	describe('reactivity', () => {
		test('updates sorted_items when source items change', () => {
			// Need a reactive reference to items that we can update
			let current_items = $state([...items]);
			const sortable = new Sortable(
				() => current_items,
				() => sorters,
			);

			// Start with 4 items
			assert.strictEqual(sortable.sorted_items.length, 4);

			// Add a new item
			const new_item = new TestCell(app, create_uuid(), 'Dragonfruit', 25, 50);

			// Update the items array reference so the derived getter gets the new value
			current_items = [...current_items, new_item];

			// Now we should see 5 items
			assert.strictEqual(sortable.sorted_items.length, 5);
			assert.ok(sortable.sorted_items.some((item) => item.cid === 50));
		});

		test('updates when active_key changes', () => {
			const sortable = new Sortable(
				() => items,
				() => sorters,
			);

			const first_item = sortable.sorted_items[0];
			assert.isDefined(first_item);

			// Initially sorted by name (first sorter)
			assert.strictEqual(first_item!.name, 'Apple');

			// Change to sort by value
			sortable.active_key = 'value';

			const first_item_after = sortable.sorted_items[0];
			assert.isDefined(first_item_after);

			// Should now be sorted by value
			assert.strictEqual(first_item_after!.value, 5);
		});
	});
});
