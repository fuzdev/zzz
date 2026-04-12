// @vitest-environment jsdom

import {test, vi, beforeEach, describe, assert} from 'vitest';
import {z} from 'zod';

import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {CellJson} from '$lib/cell_types.js';
import {create_uuid, get_datetime_now, UuidWithDefault} from '$lib/zod_helpers.js';
import {Frontend} from '$lib/frontend.svelte.js';

import {monkeypatch_zzz_for_tests} from './test_helpers.js';

// Constants for testing
const TEST_ID = create_uuid();
const TEST_DATETIME = get_datetime_now();

// Basic schema for testing that extends CellJson
const TestSchema = CellJson.extend({
	text: z.string().default(''),
	number: z.number().default(0),
	items: z.array(z.string()).default(() => []),
	flag: z.boolean().default(true),
});

// Basic test cell implementation
class BasicTestCell extends Cell<typeof TestSchema> {
	text: string = $state()!;
	number: number = $state()!;
	items: Array<string> = $state()!;
	flag: boolean = $state()!;

	constructor(options: CellOptions<typeof TestSchema>) {
		super(TestSchema, options);
		this.init();
	}
}

// Test suite variables
let app: Frontend;

beforeEach(() => {
	// Create a real Zzz instance for each test
	app = monkeypatch_zzz_for_tests(new Frontend());
	vi.clearAllMocks();
});

describe('Cell initialization', () => {
	test('initializes with provided json', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				created: TEST_DATETIME,
				text: 'Sample',
				number: 42,
				items: ['item1', 'item2'],
			},
		});

		// Verify basic properties
		assert.strictEqual(test_cell.id, TEST_ID);
		assert.strictEqual(test_cell.created, TEST_DATETIME);
		assert.strictEqual(test_cell.updated, test_cell.created);
		assert.strictEqual(test_cell.text, 'Sample');
		assert.strictEqual(test_cell.number, 42);
		assert.deepEqual(test_cell.items, ['item1', 'item2']);

		// Verify cell was registered
		assert.ok(app.cell_registry.all.has(TEST_ID));
		assert.ok(app.cell_registry.all.get(TEST_ID) === (test_cell as any));
	});

	test('uses default values when json is empty', () => {
		const test_cell = new BasicTestCell({
			app,
		});

		// Should use schema defaults
		assert.isDefined(test_cell.id);
		assert.isDefined(test_cell.created);
		assert.strictEqual(test_cell.updated, test_cell.created);
		assert.strictEqual(test_cell.text, '');
		assert.strictEqual(test_cell.number, 0);
		assert.deepEqual(test_cell.items, []);
		assert.ok(test_cell.flag);
	});

	test('derived schema properties are correctly calculated', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
			},
		});

		// Check if schema keys contain expected fields
		assert.include(test_cell.schema_keys, 'id');
		assert.include(test_cell.schema_keys, 'text');
		assert.include(test_cell.schema_keys, 'number');
		assert.include(test_cell.schema_keys, 'items');

		// Check if field schemas are correctly mapped
		assert.ok(test_cell.field_schemas.size > 0);
		assert.ok(test_cell.field_schemas.has('text'));
		assert.ok(test_cell.field_schemas.has('number'));

		// Test schema info for an array type
		const items_info = test_cell.field_schema_info.get('items');
		assert.ok(items_info?.is_array);
		assert.strictEqual(items_info.type, 'ZodArray');

		// Test schema info for a scalar type
		const text_info = test_cell.field_schema_info.get('text');
		assert.ok(!text_info?.is_array);
		assert.strictEqual(text_info?.type, 'ZodString');
	});
});

describe('Cell registry lifecycle', () => {
	test('cell is automatically registered on initialization', () => {
		const cell_id = create_uuid();

		const test_cell = new BasicTestCell({
			app,
			json: {
				id: cell_id,
				created: TEST_DATETIME,
			},
		});

		// Cell should be registered automatically in init()
		assert.ok(app.cell_registry.all.has(cell_id));
		assert.ok(app.cell_registry.all.get(cell_id) === (test_cell as any));
	});

	test('dispose removes from registry', () => {
		const cell_id = create_uuid();

		const test_cell = new BasicTestCell({
			app,
			json: {
				id: cell_id,
				created: TEST_DATETIME,
			},
		});

		// Verify initial registration
		assert.ok(app.cell_registry.all.has(cell_id));

		// Dispose cell
		test_cell.dispose();

		// Should be removed from registry
		assert.ok(!app.cell_registry.all.has(cell_id));
	});

	test('dispose is safe to call multiple times', () => {
		const cell_id = create_uuid();

		const test_cell = new BasicTestCell({
			app,
			json: {
				id: cell_id,
			},
		});

		// First dispose
		test_cell.dispose();
		assert.ok(!app.cell_registry.all.has(cell_id));

		// Second dispose should not throw
		assert.doesNotThrow(() => test_cell.dispose());
	});
});

describe('Cell id handling', () => {
	// Define a test schema with required type field for these tests
	const IdTestSchema = z.object({
		id: UuidWithDefault,
		type: z.literal('test').default('test'),
		content: z.string().default(''),
		version: z.number().default(0),
	});

	// Test implementation of the Cell class with id-specific tests
	class IdTestCell extends Cell<typeof IdTestSchema> {
		type: string = $state()!;
		content: string = $state()!;
		version: number = $state()!;

		constructor(options: {app: Frontend; json?: any}) {
			super(IdTestSchema, options);
			this.init();
		}
	}

	test('set_json overwrites id when provided in input', () => {
		// Create initial cell
		const cell = new IdTestCell({app});
		const initial_id = cell.id;

		// Verify initial state
		assert.strictEqual(cell.id, initial_id);

		// Create a new id to set
		const new_id = create_uuid();
		assert.notStrictEqual(new_id, initial_id);

		// Set new id through set_json
		cell.set_json({
			id: new_id,
			type: 'test',
			content: 'New content',
			version: 2,
		});

		// Verify id was changed to the new value
		assert.strictEqual(cell.id, new_id);
		assert.notStrictEqual(cell.id, initial_id);
	});

	test('set_json_partial updates id when included in partial update', () => {
		// Create initial cell
		const cell = new IdTestCell({app});
		const initial_id = cell.id;

		// Create a new id to set
		const new_id = create_uuid();

		// Update only the id
		cell.set_json_partial({
			id: new_id,
			version: 3,
		});

		// Verify id was updated and other properties preserved
		assert.strictEqual(cell.id, new_id);
		assert.notStrictEqual(cell.id, initial_id);
		assert.strictEqual(cell.type, 'test');
		assert.strictEqual(cell.content, '');
		assert.strictEqual(cell.version, 3);
	});

	test('set_json_partial preserves id when not included in partial update', () => {
		// Create initial cell
		const cell = new IdTestCell({app});
		const initial_id = cell.id;
		const initial_content = '';

		// Update content but not id
		cell.set_json_partial({
			content: 'Partial update content',
		});

		// Verify id preserved and content updated
		assert.strictEqual(cell.id, initial_id);
		assert.strictEqual(cell.content, 'Partial update content');
		assert.notStrictEqual(cell.content, initial_content);
	});

	test('schema validation rejects invalid id formats', () => {
		// Create initial cell
		const cell = new IdTestCell({app});

		// Attempt to set invalid id
		assert.throws(() => {
			cell.set_json_partial({
				id: 'not-a-valid-uuid' as any,
			});
		});
	});

	test('clone creates a new id instead of copying the original', () => {
		// Create cell with initial values
		const cell = new IdTestCell({
			app,
			json: {
				type: 'test',
				content: 'Original content',
				version: 1,
			},
		});
		const original_id = cell.id;

		// Clone the cell
		const cloned_cell = cell.clone();

		// Verify clone has new id but same content
		assert.notStrictEqual(cloned_cell.id, original_id);
		assert.strictEqual(cloned_cell.content, 'Original content');
		assert.strictEqual(cloned_cell.version, 1);

		// Verify changing clone doesn't affect original
		cloned_cell.content = 'Changed in clone';
		assert.strictEqual(cell.content, 'Original content');
	});
});

describe('Cell serialization', () => {
	test('to_json creates correct representation', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				created: TEST_DATETIME,
				text: 'JSON Test',
				number: 100,
				items: ['value1', 'value2'],
			},
		});

		const json = test_cell.to_json();

		assert.strictEqual(json.id, TEST_ID);
		assert.strictEqual(json.created, TEST_DATETIME);
		assert.strictEqual(json.text, 'JSON Test');
		assert.strictEqual(json.number, 100);
		assert.deepEqual(json.items, ['value1', 'value2']);
	});

	test('toJSON method works with JSON.stringify', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Stringify Test',
			},
		});

		const stringified = JSON.stringify(test_cell);
		const parsed = JSON.parse(stringified);

		assert.strictEqual(parsed.id, TEST_ID);
		assert.strictEqual(parsed.text, 'Stringify Test');
	});

	test('derived json properties update when cell changes', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Initial',
				number: 10,
			},
		});

		// Check initial values
		assert.strictEqual(test_cell.json.text, 'Initial');
		assert.strictEqual(test_cell.json.number, 10);

		// Update values
		test_cell.text = 'Updated';
		test_cell.number = 20;

		// Check derived properties updated
		assert.strictEqual(test_cell.json.text, 'Updated');
		assert.strictEqual(test_cell.json.number, 20);

		// Check derived serialized JSON
		const parsed = JSON.parse(test_cell.json_serialized);
		assert.strictEqual(parsed.text, 'Updated');
		assert.strictEqual(parsed.number, 20);
	});
});

describe('Cell modification methods', () => {
	test('set_json updates properties', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Initial',
			},
		});

		// Update using set_json
		test_cell.set_json({
			text: 'Updated via set_json',
			number: 50,
			items: ['new1', 'new2'],
		});

		assert.strictEqual(test_cell.text, 'Updated via set_json');
		assert.strictEqual(test_cell.number, 50);
		assert.deepEqual(test_cell.items, ['new1', 'new2']);
		assert.notStrictEqual(test_cell.id, TEST_ID); // id should be new
	});

	test('set_json rejects invalid data', () => {
		const test_cell = new BasicTestCell({app});

		// Should reject invalid data with a schema error
		assert.throws(() => test_cell.set_json({number: 'not a number' as any}));
	});

	test('set_json_partial updates only specified properties', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Initial text',
				number: 10,
				items: ['item1', 'item2'],
				flag: true,
			},
		});

		// Update only text and number
		test_cell.set_json_partial({
			text: 'Updated text',
			number: 20,
		});

		// Verify updated properties
		assert.strictEqual(test_cell.text, 'Updated text');
		assert.strictEqual(test_cell.number, 20);

		// Verify untouched properties
		assert.deepEqual(test_cell.items, ['item1', 'item2']);
		assert.ok(test_cell.flag);
		assert.strictEqual(test_cell.id, TEST_ID);
	});

	test('set_json_partial handles null or undefined input', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Initial',
			},
		});

		// These should not throw errors
		assert.doesNotThrow(() => test_cell.set_json_partial(null!));
		assert.doesNotThrow(() => test_cell.set_json_partial(undefined!));

		// Properties should remain unchanged
		assert.strictEqual(test_cell.id, TEST_ID);
		assert.strictEqual(test_cell.text, 'Initial');
	});

	test('set_json_partial validates merged data against schema', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Initial',
			},
		});

		// Should reject invalid data with a schema error
		assert.throws(() => test_cell.set_json_partial({number: 'not a number' as any}));

		// Original values should remain unchanged after failed update
		assert.strictEqual(test_cell.text, 'Initial');
	});
});

describe('Cell date formatting', () => {
	test('formats dates correctly', () => {
		const now = new Date();
		const created = now.toISOString();
		const updated = new Date(now.getTime() + 10000).toISOString();

		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				created,
				updated,
			},
		});

		// Verify date objects
		assert.instanceOf(test_cell.created_date, Date);
		assert.instanceOf(test_cell.updated_date, Date);

		// Verify formatted strings exist
		assert.ok(test_cell.created_formatted_short_date);
		assert.ok(test_cell.created_formatted_datetime);
		assert.ok(test_cell.created_formatted_time);

		assert.ok(test_cell.updated_formatted_short_date);
		assert.ok(test_cell.updated_formatted_datetime);
		assert.ok(test_cell.updated_formatted_time);
	});

	test('handles null updated date', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				created: TEST_DATETIME,
				updated: TEST_DATETIME,
			},
		});

		assert.ok(test_cell.updated_date);
		assert.ok(test_cell.updated_formatted_short_date);
		assert.ok(test_cell.updated_formatted_datetime);
		assert.ok(test_cell.updated_formatted_time);
	});
});

describe('Cell cloning', () => {
	test('clone creates independent copy', () => {
		const original = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Original',
				number: 42,
				items: ['value1'],
			},
		});

		const clone = original.clone();

		// Should have same values
		assert.strictEqual(clone.text, 'Original');
		assert.strictEqual(clone.number, 42);
		assert.deepEqual(clone.items, ['value1']);

		// But be a different instance
		assert.notStrictEqual(clone, original);
		assert.notStrictEqual(clone.id, original.id); // Should have new id

		// Changes to one shouldn't affect the other
		clone.text = 'Changed';
		clone.number = 100;
		clone.items.push('value2');

		assert.strictEqual(original.text, 'Original');
		assert.strictEqual(original.number, 42);
		assert.deepEqual(original.items, ['value1']);
	});

	test('clone registers new instance in registry', () => {
		const original = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
			},
		});

		const clone = original.clone();

		// Both instances should be registered
		assert.ok(app.cell_registry.all.has(original.id));
		assert.ok(app.cell_registry.all.has(clone.id));
		assert.ok(app.cell_registry.all.get(clone.id) === (clone as any));
	});
});

describe('Schema validation', () => {
	test('json_parsed validates cell state', () => {
		const test_cell = new BasicTestCell({
			app,
			json: {
				id: TEST_ID,
				text: 'Valid',
			},
		});

		// Initial state should be valid
		assert.ok(test_cell.json_parsed.success);

		// Invalid initialization should throw
		assert.throws(
			() =>
				new BasicTestCell({
					app,
					json: {
						id: TEST_ID,
						text: 123 as any,
					},
				}),
		);
	});
});
