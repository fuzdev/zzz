// @vitest-environment jsdom

import {test, vi, beforeEach, assert} from 'vitest';
import {z} from 'zod';

import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {CellJson} from '$lib/cell_types.js';
import {DatetimeNow, get_datetime_now, create_uuid, UuidWithDefault} from '$lib/zod_helpers.js';
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

test('Cell allows schema keys with no properties if a decoder is provided', () => {
	const VirtualPropertySchema = CellJson.extend({
		real_prop: z.string().default(''),
		virtual_prop: z.number().default(42), // Won't exist on class
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
				},
			};

			this.init();
		}
	}

	const cell = new VirtualPropertyCell({
		app,
		json: {
			id: TEST_ID,
			created: TEST_DATETIME,
			virtual_prop: 99,
		},
	});

	assert.strictEqual(cell.captured_value, 99);
});

test('Cell supports virtual properties with custom handling', () => {
	const VirtualHandlerSchema = z.object({
		id: UuidWithDefault,
		created: DatetimeNow,
		updated: z.string().nullable().default(null),
		visible_prop: z.string(),
		hidden_prop: z.number().default(0),
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
				},
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
			hidden_prop: 42,
		},
	});

	assert.strictEqual(cell.visible_prop, 'visible');
	assert.ok(!('hidden_prop' in cell));
	assert.strictEqual(cell.processed_value, 84); // 42 * 2
});

test('Cell handles sentinel values with proper precedence', () => {
	const SentinelSchema = CellJson.extend({
		handled_field: z.string().default(''),
		default_field: z.number().default(0),
		normal_field: z.boolean().default(false),
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
				},
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
			normal_field: false,
		},
	});

	assert.include(cell.decoder_calls, 'handled_field_called');
	assert.include(cell.decoder_calls, 'default_field_called');
	assert.include(cell.decoder_calls, 'normal_field_called');

	assert.strictEqual(cell.handled_field, 'initial_value');
	assert.strictEqual(cell.default_field, 42);
	assert.ok(cell.normal_field);
});

test('Cell parser defaults take precedence over schema defaults', () => {
	const DefaultPrecedenceSchema = z.object({
		id: z.string().default('schema_default_id'),
		created: DatetimeNow,
		updated: z.string().nullable().default(null),
		text: z.string().default('schema_default_text'),
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
				},
				// No decoder for text - schema default should be used
			};

			this.init();
		}
	}

	const cell = new DefaultPrecedenceCell({
		app,
		json: {},
	});

	assert.strictEqual(cell.id, 'parser_default_id');
	assert.strictEqual(cell.text, 'schema_default_text');
});
