// @vitest-environment jsdom

import {test, vi, beforeEach, assert} from 'vitest';
import {z} from 'zod';
import {create_uuid, UuidWithDefault} from '@fuzdev/fuz_util/id.js';
import {DatetimeNow, get_datetime_now} from '@fuzdev/fuz_util/datetime.js';

import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {CellJson, type SchemaKeys} from '$lib/cell_types.js';
import {Frontend} from '$lib/frontend.svelte.js';

import {monkeypatch_zzz_for_tests} from './test_helpers.js';

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
	const RegistrySchema = CellJson.extend({
		text: z.string().default(''),
	});

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
			created: TEST_DATETIME,
		},
	});

	// Mock the registry instantiate method for this specific test
	const mock_instantiate = vi
		.spyOn(app.cell_registry, 'instantiate')
		.mockImplementation((name: any, json) => {
			if (name === 'TestType') {
				return {type: 'TestType', ...((json as any) || {})};
			}
			return null;
		});

	const test_object = {key: 'value'};
	const result = cell.test_instantiate(test_object, 'TestType');

	assert.ok(mock_instantiate.mock.calls.length > 0);
	assert.deepEqual(mock_instantiate.mock.calls[0], ['TestType', test_object] as any);
	assert.deepEqual(result, {type: 'TestType', key: 'value'});

	// Clean up
	mock_instantiate.mockRestore();
});

test('Cell.encode_property uses $state.snapshot for values', () => {
	const TestSchema = CellJson.extend({
		text: z.string().default(''),
	});

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
			created: TEST_DATETIME,
		},
	});

	// Test with Date object
	const test_date = new Date(`${TEST_YEAR}-01-15`);
	const encoded_date = cell.test_encode(test_date, 'date_field');
	assert.ok(encoded_date instanceof Date);
	assert.strictEqual(encoded_date.getFullYear(), TEST_YEAR);

	// Test with nested object
	const test_object = {outer: {inner: 42}};
	const encoded_object = cell.test_encode(test_object, 'object_field');
	assert.deepEqual(encoded_object, test_object);
});

test('Cell handles special types like Map and Set', () => {
	const CollectionsSchema = z.object({
		id: UuidWithDefault,
		created: DatetimeNow,
		updated: z.string().nullable().default(null),
		// Test map collection
		map_field: z.preprocess(
			(val) => (Array.isArray(val) ? new Map(val as Array<[string, number]>) : val),
			z.map(z.string(), z.number()),
		),
		// Test set collection
		set_field: z.preprocess(
			(val) => (Array.isArray(val) ? new Set(val as Array<string>) : val),
			z.set(z.string()),
		),
	});

	class CollectionsTestCell extends Cell<typeof CollectionsSchema> {
		map_field: Map<string, number> = $state(new Map());
		set_field: Set<string> = $state(new Set());

		constructor(options: CellOptions<typeof CollectionsSchema>) {
			super(CollectionsSchema, options);
			this.init();
		}

		test_decode<K extends SchemaKeys<typeof CollectionsSchema>>(value: unknown, key: K): this[K] {
			// For Map/Set fields, we need to parse through the schema to trigger preprocess
			const field_schema = this.field_schemas.get(key);
			if (field_schema) {
				const parsed = field_schema.parse(value);
				return parsed as this[K];
			}
			return this.decode_property(value, key);
		}
	}

	const cell = new CollectionsTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			map_field: [
				['key1', 1],
				['key2', 2],
			],
			set_field: ['item1', 'item2', 'item3'],
		},
	});

	// Verify Map handling
	assert.instanceOf(cell.map_field, Map);
	assert.strictEqual(cell.map_field.get('key1'), 1);
	assert.strictEqual(cell.map_field.get('key2'), 2);

	// Verify Set handling
	assert.instanceOf(cell.set_field, Set);
	assert.ok(cell.set_field.has('item1'));
	assert.ok(cell.set_field.has('item2'));
	assert.ok(cell.set_field.has('item3'));

	// Test manual decoding
	const map_result = cell.test_decode([['key3', 3]], 'map_field');
	assert.instanceOf(map_result, Map);
	assert.strictEqual(map_result.get('key3'), 3);

	const set_result = cell.test_decode(['item4', 'item5'], 'set_field');
	assert.instanceOf(set_result, Set);
	assert.ok(set_result.has('item4'));
	assert.ok(set_result.has('item5'));
});

test('Cell - JSON serialization excludes undefined values correctly', () => {
	const SerializationSchema = CellJson.extend({
		type: z.enum(['type1', 'type2']),
		name: z.string().optional(),
		data: z
			.object({
				code: z.string().optional(),
				value: z.number().optional(),
			})
			.optional(),
		items: z.array(z.string()).optional(),
		state: z.enum(['on', 'off']).optional(),
	});

	class SerializationTestCell extends Cell<typeof SerializationSchema> {
		type: 'type1' | 'type2' = $state()!;
		name?: string = $state();
		data?: {code?: string; value?: number} = $state();
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
			type: 'type1',
		},
	});

	// Cell with optional fields
	const complete_cell = new SerializationTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			type: 'type2',
			name: 'test_name',
			data: {code: 'test_code'},
			items: ['item1', 'item2'],
		},
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
	assert.deepEqual(complete_json.data, {code: 'test_code'});
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
