// @vitest-environment jsdom

import {
	boolean,
	nullable,
	number,
	object,
	string,
	strip_object,
	with_default
} from '@fuzdev/fuz_schema/schema.ts';
import { test, vi, beforeEach, assert } from 'vitest';
import { create_uuid, UuidWithDefault } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { DatetimeNow, get_datetime_now } from '#lib/datetime.ts';
import { Cell, type CellOptions } from '#lib/cell.svelte.ts';
import { CellJson } from '#lib/cell_types.ts';
import { HANDLED } from '#lib/cell_helpers.ts';
import { Frontend } from '#lib/frontend.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

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

test('Cell allows schema keys with no properties if a decoder is provided', () => {
	const VirtualPropertySchema = object({
		...CellJson.def,
		real_prop: with_default(string, ''),
		virtual_prop: with_default(number, 42) // Won't exist on class
	});

	class VirtualPropertyCell extends Cell<typeof VirtualPropertySchema> {
		real_prop: string = $state()!;
		// No 'virtual_prop', will be handled by decoder

		captured_value = 0; // For verification

		constructor(options: CellOptions<typeof VirtualPropertySchema>) {
			super(VirtualPropertySchema, options);

			this.decoders = {
				virtual_prop: (value) => {
					this.captured_value = typeof value === 'number' ? value : 0;
					return HANDLED;
				}
			};

			this.init();
		}
	}

	const cell = new VirtualPropertyCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			virtual_prop: 99
		}
	});

	assert.strictEqual(cell.captured_value, 99);
});

test('Cell supports virtual properties with custom handling', () => {
	const VirtualHandlerSchema = strip_object({
		id: UuidWithDefault,
		created: DatetimeNow,
		updated: with_default(nullable(string), null),
		visible_prop: string,
		hidden_prop: with_default(number, 0)
	});

	class VirtualHandlerCell extends Cell<typeof VirtualHandlerSchema> {
		visible_prop: string = $state()!;
		// No hidden_prop property

		processed_value = 0;

		constructor(options: CellOptions<typeof VirtualHandlerSchema>) {
			super(VirtualHandlerSchema, options);

			this.decoders = {
				hidden_prop: (value) => {
					if (typeof value === 'number') {
						this.processed_value = value * 2;
					}
					return HANDLED; // Must return HANDLED for virtual properties
				}
			};

			this.init();
		}
	}

	const cell = new VirtualHandlerCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			visible_prop: 'visible',
			hidden_prop: 42
		}
	});

	assert.strictEqual(cell.visible_prop, 'visible');
	assert.ok(!('hidden_prop' in cell));
	assert.strictEqual(cell.processed_value, 84); // 42 * 2
});

test('Cell handles sentinel values with proper precedence', () => {
	const SentinelSchema = object({
		...CellJson.def,
		handled_field: with_default(string, ''),
		default_field: with_default(number, 0),
		normal_field: with_default(boolean, false)
	});

	class SentinelTestCell extends Cell<typeof SentinelSchema> {
		handled_field: string = $state('initial_value');
		default_field: number = $state(-1);
		normal_field: boolean = $state()!;

		decoder_calls: Array<string> = [];

		constructor(options: CellOptions<typeof SentinelSchema>) {
			super(SentinelSchema, options);

			this.decoders = {
				handled_field: (_value) => {
					this.decoder_calls.push('handled_field_called');
					// Short-circuit with HANDLED
					return HANDLED;
				},
				default_field: (_value) => {
					this.decoder_calls.push('default_field_called');
					// Fall through to default decoding
					return undefined;
				},
				normal_field: (_value) => {
					this.decoder_calls.push('normal_field_called');
					// Override with custom value
					return true;
				}
			};

			this.init();
		}
	}

	const cell = new SentinelTestCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			handled_field: 'input_value',
			default_field: 42,
			normal_field: false
		}
	});

	assert.include(cell.decoder_calls, 'handled_field_called');
	assert.include(cell.decoder_calls, 'default_field_called');
	assert.include(cell.decoder_calls, 'normal_field_called');

	assert.strictEqual(cell.handled_field, 'initial_value');
	assert.strictEqual(cell.default_field, 42);
	assert.ok(cell.normal_field);
});

test('Cell parser defaults take precedence over schema defaults', () => {
	const DefaultPrecedenceSchema = strip_object({
		id: with_default(string, 'schema_default_id'),
		created: DatetimeNow,
		updated: with_default(nullable(string), null),
		text: with_default(string, 'schema_default_text')
	});

	class DefaultPrecedenceCell extends Cell<typeof DefaultPrecedenceSchema> {
		text: string = $state()!;

		constructor(options: CellOptions<typeof DefaultPrecedenceSchema>) {
			super(DefaultPrecedenceSchema, options);

			this.decoders = {
				id: (value) => {
					if (typeof value === 'string' && value !== 'schema_default_id') {
						return value;
					}
					return 'parser_default_id';
				}
				// No decoder for text - schema default should be used
			};

			this.init();
		}
	}

	const cell = new DefaultPrecedenceCell({
		app,
		json: {}
	});

	assert.strictEqual(cell.id, 'parser_default_id');
	assert.strictEqual(cell.text, 'schema_default_text');
});
