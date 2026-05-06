// @vitest-environment jsdom

import {test, vi, beforeEach, assert} from 'vitest';
import {z} from 'zod';
import {create_uuid} from '@fuzdev/fuz_util/id.js';
import {get_datetime_now} from '@fuzdev/fuz_util/datetime.js';

import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {CellJson, type SchemaKeys} from '$lib/cell_types.js';
import {HANDLED} from '$lib/cell_helpers.js';
import {Frontend} from '$lib/frontend.svelte.js';

import {monkeypatch_zzz_for_tests} from './test_helpers.js';

// Constants for testing
const TEST_ID = create_uuid();
const TEST_DATETIME = get_datetime_now();

// Test suite variables
let app: Frontend;

beforeEach(() => {
	// Create a real Zzz instance for each test
	app = monkeypatch_zzz_for_tests(new Frontend());
	vi.clearAllMocks();
});

// Base test schema that extends CellJson
const TestSchema = CellJson.extend({
	text: z.string().default(''),
	number: z.number().optional(),
	list: z
		.array(z.string())
		.optional()
		.default(() => []),
	flag: z.boolean().default(true),
});

test('Cell supports overriding assign_property', () => {
	class CustomAssignmentCell extends Cell<typeof TestSchema> {
		text: string = $state()!;
		number: number | undefined = $state();
		list: Array<string> = $state()!;
		flag: boolean = $state()!;

		assignment_log: Array<string> = [];

		constructor(options: CellOptions<typeof TestSchema>) {
			super(TestSchema, options);
			this.init();
		}

		protected override assign_property<K extends SchemaKeys<typeof TestSchema>>(
			key: K,
			value: this[K],
		): void {
			this.assignment_log.push(`Assigned ${key}: ${String(value)}`);

			if (key === 'text' && typeof value === 'string') {
				super.assign_property(key, `modified_${value}` as any);
				return;
			}

			super.assign_property(key, value);
		}
	}

	const cell = new CustomAssignmentCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			text: 'original',
			list: ['item'],
		},
	});

	assert.strictEqual(cell.text, 'modified_original');
	assert.include(cell.assignment_log, `Assigned id: ${TEST_ID}`);
	assert.include(cell.assignment_log, 'Assigned text: original');
	assert.include(cell.assignment_log, 'Assigned list: item');
});

test('Cell assign_property returns after handling property correctly', () => {
	class ReturnBehaviorCell extends Cell<typeof TestSchema> {
		text: string = $state()!;
		number: number | undefined = $state();
		list: Array<string> = $state()!;
		flag: boolean = $state()!;

		execution_path: Array<string> = [];

		constructor(options: CellOptions<typeof TestSchema>) {
			super(TestSchema, options);
			this.init();
		}

		protected override assign_property<K extends SchemaKeys<typeof TestSchema>>(
			key: K,
			value: this[K],
		): void {
			this.execution_path.push(`begin-${key}`);

			if (key === 'text') {
				super.assign_property(key, value);
				this.execution_path.push(`complete-${key}`);
				return;
			}

			this.execution_path.push(`continue-${key}`);
			super.assign_property(key, value);
		}
	}

	const cell = new ReturnBehaviorCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			text: 'sample',
			number: 42,
		},
	});

	assert.strictEqual(cell.text, 'sample');
	assert.strictEqual(cell.number, 42);

	assert.include(cell.execution_path, 'begin-text');
	assert.include(cell.execution_path, 'complete-text');
	assert.notInclude(cell.execution_path, 'continue-text');

	assert.include(cell.execution_path, 'begin-number');
	assert.include(cell.execution_path, 'continue-number');
});

test('Cell handles inherited properties correctly', () => {
	class BaseTestCell extends Cell<typeof TestSchema> {
		text: string = $state()!;

		base_method() {
			return 'base_result';
		}

		constructor(options: CellOptions<typeof TestSchema>) {
			super(TestSchema, options);
			// Let derived class handle initialization
		}
	}

	class DerivedTestCell extends BaseTestCell {
		number: number | undefined = $state();
		list: Array<string> = $state()!;
		flag: boolean = $state()!;

		derived_method() {
			return 'derived_result';
		}

		override base_method() {
			return 'overridden_result';
		}

		constructor(options: CellOptions<typeof TestSchema>) {
			super(options);
			this.init();
		}
	}

	const cell = new DerivedTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			text: 'base_property',
			number: 30,
			list: ['derived_item'],
			flag: true,
		},
	});

	assert.strictEqual(cell.id, TEST_ID);
	assert.strictEqual(cell.text, 'base_property');
	assert.strictEqual(cell.number, 30);

	assert.strictEqual(cell.derived_method(), 'derived_result');
	assert.strictEqual(cell.base_method(), 'overridden_result');

	assert.ok('id' in cell);

	const json = cell.json;
	assert.strictEqual(json.id, TEST_ID);
	assert.strictEqual(json.text, 'base_property');
	assert.strictEqual(json.number, 30);
});

test('Cell properly handles collections with HANDLED sentinel', () => {
	const VirtualCollectionSchema = CellJson.extend({
		collection: z.array(z.string()).default(() => []),
		text: z.string().default(''),
	});

	class VirtualCollectionCell extends Cell<typeof VirtualCollectionSchema> {
		text: string = $state()!;
		// No direct collection property

		// Separately managed collection
		stored_items: Array<string> = [];

		constructor(options: CellOptions<typeof VirtualCollectionSchema>) {
			super(VirtualCollectionSchema, options);

			this.decoders = {
				collection: (value) => {
					if (Array.isArray(value)) {
						this.stored_items = value.map((item) =>
							typeof item === 'string' ? item.toUpperCase() : String(item),
						);
					}
					return HANDLED;
				},
			};

			this.init();
		}

		override to_json(): z.output<typeof VirtualCollectionSchema> {
			const base = super.to_json();
			return {
				...base,
				collection: this.stored_items,
			};
		}
	}

	const cell = new VirtualCollectionCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			collection: ['one', 'two', 'three'],
			text: 'sample',
		},
	});

	assert.deepEqual(cell.stored_items, ['ONE', 'TWO', 'THREE']);
	assert.deepEqual(cell.json.collection, ['ONE', 'TWO', 'THREE']);
});

test('Cell registration and unregistration works correctly', () => {
	const cell_id = create_uuid();

	class RegistrationTestCell extends Cell<typeof TestSchema> {
		text: string = $state()!;
		number: number | undefined = $state();
		list: Array<string> = $state()!;
		flag: boolean = $state()!;

		constructor(options: CellOptions<typeof TestSchema>) {
			super(TestSchema, options);
			this.init();
		}
	}

	const cell = new RegistrationTestCell({
		app,
		json: {
			id: cell_id,
			created: TEST_DATETIME,
		},
	});

	// Cell should be automatically registered
	assert.ok(app.cell_registry.all.has(cell_id));
	assert.ok(app.cell_registry.all.get(cell_id) === (cell as any));

	// Test disposal
	cell.dispose();
	assert.ok(!app.cell_registry.all.has(cell_id));

	// Test that disposing again is safe
	assert.doesNotThrow(() => cell.dispose());
});
