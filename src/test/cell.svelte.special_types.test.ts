// @vitest-environment jsdom

import {
	array,
	number,
	object,
	one_of,
	optional,
	string,
	strip_object,
	unknown,
	with_default,
	with_default_fn
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { test, vi, beforeEach, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { get_datetime_now } from '#lib/datetime.ts';
import { Cell, type CellOptions } from '#lib/cell.svelte.ts';
import { CellJson } from '#lib/cell_types.ts';
import { HANDLED } from '#lib/cell_helpers.ts';
import { Frontend } from '#lib/frontend.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

// Constants for testing
const TEST_ID = create_uuid();
const TEST_DATETIME = get_datetime_now();
const TEST_YEAR = 2022;

// Test suite variables
let app: Frontend;

beforeEach(() => {
	// Create a real Zzz instance for each test
	app = monkeypatch_zzz_for_tests(new Frontend());
	vi.clearAllMocks();
});

test('Cell uses registry for instantiating class relationships', () => {
	const RegistrySchema = object({ ...CellJson.def, text: with_default(string, '') });

	class RegistryTestCell extends Cell<typeof RegistrySchema> {
		text: string = $state()!;

		constructor(options: CellOptions<typeof RegistrySchema>) {
			super(RegistrySchema, options);
			this.init();
		}

		test_instantiate(json: any, class_name: string): unknown {
			return this.app.cell_registry.instantiate(class_name as any, json);
		}
	}

	const cell = new RegistryTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME
		}
	});

	// Mock the registry instantiate method for this specific test
	const mock_instantiate = vi
		.spyOn(app.cell_registry, 'instantiate')
		.mockImplementation((name: any, json) => {
			if (name === 'TestType') {
				return { type: 'TestType', ...((json as any) || {}) };
			}
			return null;
		});

	const test_object = { key: 'value' };
	const result = cell.test_instantiate(test_object, 'TestType');

	assert.ok(mock_instantiate.mock.calls.length > 0);
	assert.deepEqual(mock_instantiate.mock.calls[0], ['TestType', test_object] as any);
	assert.deepEqual(result, { type: 'TestType', key: 'value' });

	// Clean up
	mock_instantiate.mockRestore();
});

test('Cell.encode_property uses $state.snapshot for values', () => {
	const TestSchema = object({ ...CellJson.def, text: with_default(string, '') });

	class EncodingTestCell extends Cell<typeof TestSchema> {
		text: string = $state()!;

		constructor(options: CellOptions<typeof TestSchema>) {
			super(TestSchema, options);
			this.init();
		}

		test_encode(value: unknown, key: string): unknown {
			return this.encode_property(value, key);
		}
	}

	const cell = new EncodingTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME
		}
	});

	// Test with Date object
	const test_date = new Date(`${TEST_YEAR}-01-15`);
	const encoded_date = cell.test_encode(test_date, 'date_field');
	assert.ok(encoded_date instanceof Date);
	assert.strictEqual(encoded_date.getFullYear(), TEST_YEAR);

	// Test with nested object
	const test_object = { outer: { inner: 42 } };
	const encoded_object = cell.test_encode(test_object, 'object_field');
	assert.deepEqual(encoded_object, test_object);
});

test('Cell decodes JSON arrays into a Map and a Set with decoders', () => {
	const CollectionsSchema = object({
		...CellJson.def,
		// a Map's entries as JSON
		map_field: with_default_fn(array(array(unknown)), () => []),
		// a Set's items as JSON
		set_field: with_default_fn(array(string), () => [])
	});

	class CollectionsTestCell extends Cell<typeof CollectionsSchema> {
		map_field: Map<string, number> = $state(new Map());
		set_field: Set<string> = $state(new Set());

		constructor(options: CellOptions<typeof CollectionsSchema>) {
			super(CollectionsSchema, options);
			this.decoders = {
				map_field: (value) => {
					this.map_field = new Map(value as Array<[string, number]>);
					return HANDLED;
				},
				set_field: (value) => {
					this.set_field = new Set(value as Array<string>);
					return HANDLED;
				}
			};
			this.init();
		}
	}

	const cell = new CollectionsTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			map_field: [
				['key1', 1],
				['key2', 2]
			],
			set_field: ['item1', 'item2', 'item3']
		}
	});

	assert.instanceOf(cell.map_field, Map);
	assert.strictEqual(cell.map_field.get('key1'), 1);
	assert.strictEqual(cell.map_field.get('key2'), 2);

	assert.instanceOf(cell.set_field, Set);
	assert.ok(cell.set_field.has('item1'));
	assert.ok(cell.set_field.has('item2'));
	assert.ok(cell.set_field.has('item3'));

	// a partial update decodes through the same decoders
	cell.set_json_partial({ map_field: [['key3', 3]], set_field: ['item4', 'item5'] });
	assert.deepEqual([...cell.map_field], [['key3', 3]]);
	assert.deepEqual([...cell.set_field], ['item4', 'item5']);
});

test('Cell - JSON serialization excludes undefined values correctly', () => {
	const SerializationSchema = object({
		...CellJson.def,
		type: one_of(['type1', 'type2']),
		name: optional(string),
		data: optional(
			strip_object({
				code: optional(string),
				value: optional(number)
			})
		),
		items: optional(array(string)),
		state: optional(one_of(['on', 'off']))
	});

	class SerializationTestCell extends Cell<typeof SerializationSchema> {
		type: 'type1' | 'type2' = $state()!;
		name?: string = $state();
		data?: { code?: string; value?: number } = $state();
		items?: Array<string> = $state();
		state?: 'on' | 'off' = $state();

		constructor(options: CellOptions<typeof SerializationSchema>) {
			super(SerializationSchema, options);
			this.init();
		}
	}

	// Cell with minimal required fields
	const minimal_cell = new SerializationTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			type: 'type1'
		}
	});

	// Cell with optional fields
	const complete_cell = new SerializationTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			type: 'type2',
			name: 'test_name',
			data: { code: 'test_code' },
			items: ['item1', 'item2']
		}
	});

	// Test minimal cell serialization
	const minimal_json = minimal_cell.to_json();
	assert.strictEqual(minimal_json.type, 'type1');
	assert.ok(minimal_json.name === undefined);
	assert.ok(minimal_json.data === undefined);
	assert.ok(minimal_json.items === undefined);
	assert.ok(minimal_json.state === undefined);

	// Test complete cell serialization
	const complete_json = complete_cell.to_json();
	assert.strictEqual(complete_json.type, 'type2');
	assert.strictEqual(complete_json.name, 'test_name');
	assert.deepEqual(complete_json.data, { code: 'test_code' });
	assert.ok(complete_json.data?.value === undefined);
	assert.deepEqual(complete_json.items, ['item1', 'item2']);
	assert.ok(complete_json.state === undefined);

	// Test JSON stringification
	const minimal_string = JSON.stringify(minimal_cell);
	const parsed_minimal = JSON.parse(minimal_string);
	assert.ok(parsed_minimal.name === undefined);
	assert.ok(parsed_minimal.data === undefined);
	assert.ok(parsed_minimal.items === undefined);
	assert.ok(parsed_minimal.state === undefined);

	// Test nested property handling
	const complete_string = JSON.stringify(complete_cell);
	const parsed_complete = JSON.parse(complete_string);
	assert.strictEqual(parsed_complete.data.code, 'test_code');
	assert.ok(!('value' in parsed_complete.data));
});

test('Cell instantiates a field whose schema names a class', () => {
	const ChildSchema = meta(strip_object({ text: string }), { cell_class_name: 'ChildCell' });
	const ParentSchema = object({ ...CellJson.def, child: optional(ChildSchema) });

	class ParentCell extends Cell<typeof ParentSchema> {
		child: unknown = $state.raw();

		constructor(options: CellOptions<typeof ParentSchema>) {
			super(ParentSchema, options);
			this.init();
		}
	}

	const instance = { instantiated: true };
	const maybe_instantiate = vi
		.spyOn(app.cell_registry, 'maybe_instantiate')
		.mockImplementation(() => instance as any);

	const cell = new ParentCell({ app, json: { child: { text: 'a' } } });

	assert.deepEqual<unknown>(maybe_instantiate.mock.calls[0]?.slice(0, 2), [
		'ChildCell',
		{ text: 'a' }
	]);
	assert.strictEqual(cell.child, instance);

	maybe_instantiate.mockRestore();
});
