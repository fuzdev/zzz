// @vitest-environment jsdom

import { number, string, strip_object } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, beforeEach, assert } from 'vitest';
import { type Uuid, UuidWithDefault } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { DatetimeNow } from '#lib/datetime.ts';
import { Sortable, type Sorter, sort_by_text, sort_by_numeric } from '#lib/sortable.svelte.ts';
import { Cell } from '#lib/cell.svelte.ts';
import { Frontend } from '#lib/frontend.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

// Create a schema for our test cell
const TestCellSchema = strip_object({
	id: UuidWithDefault,
	created: DatetimeNow,
	updated: DatetimeNow,
	name: string,
	value: number
});

// Real cell class for testing - extends the Cell base class
class TestCell extends Cell<typeof TestCellSchema> {
	name: string = $state('');
	value: number = $state(0);

	constructor(app: Frontend, id: Uuid, name: string, value: number) {
		super(TestCellSchema, {
			app,
			json: {
				id,
				name,
				value
			}
		});

		this.init();
	}
}

/** A Uuid that sorts by `n`, for checking the tiebreak by `id`. */
const ordered_uuid = (n: number): Uuid =>
	`00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Uuid;

describe('Sortable', () => {
	let items: Array<TestCell>;
	let sorters: Array<Sorter<TestCell>>;
	let app: Frontend;

	const id1 = ordered_uuid(1);
	const id2 = ordered_uuid(2);
	const id3 = ordered_uuid(3);
	const id4 = ordered_uuid(4);

	beforeEach(() => {
		// Setup a real Zzz instance for testing
		app = monkeypatch_zzz_for_tests(new Frontend());

		// Create test items with intentional name collisions to test stable sorting
		items = [
			new TestCell(app, id3, 'Banana', 10),
			new TestCell(app, id4, 'Apple', 20), // Same name as item with id1
			new TestCell(app, id2, 'Cherry', 15),
			new TestCell(app, id1, 'Apple', 5)
		];

		sorters = [
			sort_by_text('name', 'Name', 'name'),
			sort_by_text('name_desc', 'Name (desc)', 'name', 'desc'),
			sort_by_numeric('value', 'Value', 'value'),
			sort_by_numeric('value_desc', 'Value (desc)', 'value', 'desc')
		];
	});

	describe('constructor', () => {
		test('initializes with default values', () => {
			const sortable = new Sortable(() => sorters);

			const first_sorter = sorters[0];
			assert.isDefined(first_sorter);
			assert.strictEqual(sortable.sorters, sorters);
			assert.strictEqual(sortable.active_key, first_sorter.key);
			assert.strictEqual(sortable.active_sorter, first_sorter);
			assert.strictEqual(sortable.active_sort_fn, first_sorter.fn);
		});

		test('uses default key when provided', () => {
			const sortable = new Sortable(
				() => sorters,
				() => 'value'
			);

			const sorter_at_2 = sorters[2];
			assert.isDefined(sorter_at_2);
			assert.strictEqual(sortable.default_key, 'value');
			assert.strictEqual(sortable.active_key, 'value');
			assert.strictEqual(sortable.active_sorter, sorter_at_2);
		});

		test('falls back to first sorter when default key is invalid', () => {
			const sortable = new Sortable(
				() => sorters,
				() => 'invalid_key'
			);

			const first_sorter = sorters[0];
			assert.isDefined(first_sorter);
			assert.strictEqual(sortable.default_key, 'invalid_key');
			assert.strictEqual(sortable.active_key, first_sorter.key);
		});

		test('handles empty sorters array', () => {
			const sortable = new Sortable(() => []);

			assert.strictEqual(sortable.active_key, '');
			assert.ok(sortable.active_sorter === undefined);
			assert.ok(sortable.active_sort_fn === undefined);
		});
	});

	describe('update_active_key', () => {
		test('updates key when sorters change', () => {
			let current_sorters = $state([...sorters]);
			const sortable = new Sortable(() => current_sorters);

			const first_sorter = sorters[0];
			assert.isDefined(first_sorter);
			assert.strictEqual(sortable.active_key, first_sorter.key);

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
			const sortable = new Sortable(() => current_sorters);

			const sorter_at_1 = sorters[1];
			const sorter_at_2 = sorters[2];
			assert.isDefined(sorter_at_1);
			assert.isDefined(sorter_at_2);

			// Set active key to the second sorter
			sortable.active_key = sorter_at_1.key;

			// Change sorters but keep the active key
			current_sorters = [sorter_at_1, sorter_at_2];
			sortable.update_active_key();

			assert.strictEqual(sortable.active_key, sorter_at_1.key);
		});
	});

	describe('sort_by_text', () => {
		test('sorts text values in ascending order', () => {
			const sorter_0 = sorters[0];
			assert.isDefined(sorter_0);
			const sorted = [...items].sort(sorter_0.fn);

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0.name, 'Apple');
			assert.strictEqual(item1.name, 'Apple');
			assert.strictEqual(item2.name, 'Banana');
			assert.strictEqual(item3.name, 'Cherry');

			// items with the same name tie by id
			assert.strictEqual(item0.id, id1);
			assert.strictEqual(item1.id, id4);
		});

		test('sorts text values in descending order', () => {
			const sorter_1 = sorters[1];
			assert.isDefined(sorter_1);
			const sorted = [...items].sort(sorter_1.fn);

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0.name, 'Cherry');
			assert.strictEqual(item1.name, 'Banana');
			assert.strictEqual(item2.name, 'Apple');
			assert.strictEqual(item3.name, 'Apple');

			// items with the same name tie by id, not reversed by the direction
			assert.strictEqual(item2.id, id1);
			assert.strictEqual(item3.id, id4);
		});
	});

	describe('sort_by_numeric', () => {
		test('sorts numeric values in ascending order', () => {
			const sorter_2 = sorters[2];
			assert.isDefined(sorter_2);
			const sorted = [...items].sort(sorter_2.fn);

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0.value, 5);
			assert.strictEqual(item1.value, 10);
			assert.strictEqual(item2.value, 15);
			assert.strictEqual(item3.value, 20);
		});

		test('sorts numeric values in descending order', () => {
			const sorter_3 = sorters[3];
			assert.isDefined(sorter_3);
			const sorted = [...items].sort(sorter_3.fn);

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			const item3 = sorted[3];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);
			assert.isDefined(item3);

			assert.strictEqual(item0.value, 20);
			assert.strictEqual(item1.value, 15);
			assert.strictEqual(item2.value, 10);
			assert.strictEqual(item3.value, 5);
		});

		test('sorts null and undefined values last in both directions, ties by id', () => {
			const a = new TestCell(app, ordered_uuid(4), 'a', 0);
			const b = new TestCell(app, ordered_uuid(1), 'b', 10);
			const c = new TestCell(app, ordered_uuid(3), 'c', 0);
			const d = new TestCell(app, ordered_uuid(2), 'd', 5);
			// the schema refuses a missing value, so set them past it, as an unknown size arrives
			a.value = null as unknown as number;
			c.value = undefined as unknown as number;
			const mixed = [a, b, c, d];

			const asc = [...mixed].sort(sort_by_numeric<TestCell>('v', 'V', 'value').fn);
			assert.deepEqual(
				asc.map((cell) => cell.name),
				['d', 'b', 'c', 'a']
			);
			const desc = [...mixed].sort(sort_by_numeric<TestCell>('v', 'V', 'value', 'desc').fn);
			assert.deepEqual(
				desc.map((cell) => cell.name),
				['b', 'd', 'c', 'a']
			);
		});

		test('orders equal values by id, whatever the input order', () => {
			const equal_items = [
				new TestCell(app, ordered_uuid(3), 'Item3', 10),
				new TestCell(app, ordered_uuid(1), 'Item1', 10),
				new TestCell(app, ordered_uuid(2), 'Item2', 10)
			];

			const equal_sorter = sort_by_numeric<TestCell>('value', 'Value', 'value');
			const sorted = [...equal_items].sort(equal_sorter.fn);

			const item0 = sorted[0];
			const item1 = sorted[1];
			const item2 = sorted[2];
			assert.isDefined(item0);
			assert.isDefined(item1);
			assert.isDefined(item2);

			assert.strictEqual(item0.name, 'Item1');
			assert.strictEqual(item1.name, 'Item2');
			assert.strictEqual(item2.name, 'Item3');
			for (const order of [
				[2, 0, 1],
				[1, 2, 0]
			]) {
				const shuffled = order.map((i) => equal_items[i]!);
				assert.deepEqual(
					shuffled.sort(equal_sorter.fn).map((cell) => cell.name),
					['Item1', 'Item2', 'Item3']
				);
			}
		});
	});

	describe('reactivity', () => {
		test('the active sorter follows active_key', () => {
			const sortable = new Sortable(() => sorters);
			assert.strictEqual(sortable.active_sort_fn, sorters[0]?.fn);

			sortable.active_key = 'value';

			assert.strictEqual(sortable.active_sorter, sorters[2]);
			assert.strictEqual(sortable.active_sort_fn, sorters[2]?.fn);
		});
	});
});
