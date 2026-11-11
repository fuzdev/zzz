import { test, describe, assert } from 'vitest';

import { GhosttyManifestError } from '#lib/fuz_terminal/ghostty_errors.ts';
import { GhosttyManifest, parse_ghostty_manifest } from '#lib/fuz_terminal/ghostty_manifest.ts';
import { resolve_ghostty_terminal_constants } from '#lib/fuz_terminal/ghostty_terminal.ts';
import { resolve_ghostty_vt_constants } from '#lib/fuz_terminal/ghostty_vt.ts';

import { create_ghostty_manifest_fixture } from './ghostty_manifest_fixture.ts';

/** The `GhosttyManifestError` `fn` throws, failing when it throws nothing or something else. */
const catch_manifest_error = (fn: () => unknown): GhosttyManifestError => {
	try {
		fn();
	} catch (error) {
		assert(error instanceof GhosttyManifestError, String(error));
		return error;
	}
	assert.fail('expected a GhosttyManifestError');
};

describe('GhosttyManifest top level', () => {
	test('reads a wasm32 schema-1 manifest', () => {
		const manifest = new GhosttyManifest(create_ghostty_manifest_fixture());
		assert.strictEqual(manifest.library_version, '1.0.0');
		assert.strictEqual(manifest.abi.usize_size, 4);
		assert.strictEqual(manifest.size_max, 0xffff_ffff);
	});

	test('parses the JSON text', () => {
		const manifest = parse_ghostty_manifest(JSON.stringify(create_ghostty_manifest_fixture()));
		assert.strictEqual(manifest.enum_value('GhosttyResult', 'INVALID_VALUE'), -2);
		const error = catch_manifest_error(() => parse_ghostty_manifest('{"schema": 1,'));
		assert.include(error.message, 'not valid JSON');
		assert.ok(error.cause);
	});

	test('refuses another schema, ABI, or shape', () => {
		const cases: Array<[string, (json: Record<string, any>) => unknown, string]> = [
			[
				'schema 2',
				(json) => ((json.schema = 2), json),
				'schema is 2, but this binding reads schema 1'
			],
			['no schema', (json) => (delete json.schema, json), 'schema is undefined'],
			['wasm64', (json) => ((json.abi.target = 'wasm64'), json), "the manifest's ABI is"],
			['8-byte pointers', (json) => ((json.abi.pointer_size = 8), json), 'little-endian wasm32'],
			['8-byte size_t', (json) => ((json.abi.usize_size = 8), json), 'little-endian wasm32'],
			['big-endian', (json) => ((json.abi.endian = 'big'), json), 'little-endian wasm32'],
			['no abi', (json) => (delete json.abi, json), "the manifest's ABI is undefined"],
			['no version', (json) => (delete json.library_version, json), 'no library_version'],
			['no types', (json) => (delete json.types, json), 'no types'],
			['an array', () => [], 'not a JSON object'],
			['null', () => null, 'not a JSON object']
		];
		for (const [name, doctor, message] of cases) {
			const json = doctor(create_ghostty_manifest_fixture());
			const error = catch_manifest_error(() => new GhosttyManifest(json));
			assert.include(error.message, message, name);
		}
	});
});

describe('GhosttyManifest lookups', () => {
	const manifest = new GhosttyManifest(create_ghostty_manifest_fixture());

	test('enum values, keys, struct fields, and scalars', () => {
		assert.strictEqual(manifest.enum_value('GhosttyTerminalOption', 'SCROLLBACK_MAX_BYTES'), 28);
		assert.deepEqual(manifest.enum_key('GhosttyFormatterOption', 'UNWRAP', 'in'), {
			direction: 'in',
			type: 'bool'
		});
		assert.deepEqual(manifest.struct_field('GhosttyString', 'len'), {
			offset: 4,
			size: 4,
			type: 'u32'
		});
		assert.strictEqual(manifest.struct_size('GhosttyString'), 8);
		assert.strictEqual(manifest.scalar('bool'), 'bool');
		assert.strictEqual(manifest.scalar('u32'), 'u32');
		assert.strictEqual(manifest.scalar('GhosttyOptimizeMode'), 'i32');
	});

	test('a missing entry is named', () => {
		for (const [fn, message] of [
			[() => manifest.enum_value('GhosttyNope', 'X'), 'no type GhosttyNope'],
			[
				() => manifest.enum_value('GhosttyTerminalOption', 'NOPE'),
				'no value GhosttyTerminalOption.NOPE'
			],
			[
				() => manifest.enum_key('GhosttyTerminalOption', 'NOPE', 'in'),
				'no key GhosttyTerminalOption.NOPE'
			],
			[
				() => manifest.enum_key('GhosttyBuildInfo', 'SIMD', 'in'),
				'GhosttyBuildInfo.SIMD is "out", not "in"'
			],
			[() => manifest.struct_field('GhosttyString', 'nope'), 'no usable field GhosttyString.nope'],
			[
				() => manifest.enum_value('GhosttyString', 'ptr'),
				'GhosttyString is a "struct", not a enum'
			],
			[() => manifest.struct_size('GhosttyResult'), 'GhosttyResult is a "enum", not a struct'],
			[() => manifest.scalar('GhosttyString'), 'GhosttyString is not a scalar type'],
			[() => manifest.scalar('u64'), 'no type u64']
		] as const) {
			assert.include(catch_manifest_error(fn).message, message);
		}
	});

	test('a reshaped entry is refused, never read as undefined', () => {
		const cases: Array<
			[(types: Record<string, any>) => void, (m: GhosttyManifest) => unknown, string]
		> = [
			[
				(types) => (types.GhosttyResult.values.SUCCESS = '0'),
				(m) => m.enum_value('GhosttyResult', 'SUCCESS'),
				'GhosttyResult.SUCCESS is "0", not an integer from'
			],
			[
				(types) => (types.GhosttyResult.values.SUCCESS = 0.5),
				(m) => m.enum_values('GhosttyResult'),
				'GhosttyResult.SUCCESS is 0.5, not an integer from'
			],
			[
				// would reach wasm as 28 if it were passed on
				(types) => (types.GhosttyTerminalOption.values.SCROLLBACK_MAX_LINES = 2 ** 32 + 28),
				(m) => m.enum_value('GhosttyTerminalOption', 'SCROLLBACK_MAX_LINES'),
				'SCROLLBACK_MAX_LINES is 4294967324, not an integer from -2147483648 to 2147483647 (i32)'
			],
			[
				(types) => (types.GhosttyResult.values.SUCCESS = 2 ** 31),
				(m) => m.enum_values('GhosttyResult'),
				'GhosttyResult.SUCCESS is 2147483648, not an integer from -2147483648 to 2147483647'
			],
			[
				(types) => (
					(types.GhosttyFormatterFormat.underlying = 'u8'),
					(types.GhosttyFormatterFormat.values.HTML = 256)
				),
				(m) => m.enum_values('GhosttyFormatterFormat'),
				'GhosttyFormatterFormat.HTML is 256, not an integer from 0 to 255 (u8)'
			],
			[
				(types) => (types.GhosttyResult.underlying = 'f32'),
				(m) => m.enum_values('GhosttyResult'),
				'GhosttyResult has underlying type "f32", not an integer type'
			],
			[
				(types) => delete types.GhosttyResult.underlying,
				(m) => m.enum_value('GhosttyResult', 'SUCCESS'),
				'GhosttyResult has underlying type undefined, not an integer type'
			],
			[
				(types) => (types.GhosttyResult.kind = 'struct'),
				(m) => m.enum_values('GhosttyResult'),
				'GhosttyResult is a "struct", not a enum'
			],
			[
				(types) => delete types.GhosttyFormatterOption.keys,
				(m) => m.enum_key('GhosttyFormatterOption', 'TRIM', 'in'),
				'GhosttyFormatterOption has no keys'
			],
			[
				(types) =>
					(types.GhosttyFormatterOption.keys.TRIM = { direction: 'sideways', type: 'bool' }),
				(m) => m.enum_key('GhosttyFormatterOption', 'TRIM', 'in'),
				'key GhosttyFormatterOption.TRIM is'
			],
			[
				(types) => (types.GhosttyString.fields.len.offset = 6),
				(m) => m.struct_field('GhosttyString', 'len'),
				'no usable field GhosttyString.len'
			],
			[
				(types) => delete types.GhosttyString.size,
				(m) => m.struct_field('GhosttyString', 'len'),
				'GhosttyString has no size'
			],
			[
				(types) => (types.GhosttyOptimizeMode.size = 8),
				(m) => m.scalar('GhosttyOptimizeMode'),
				'not a 4-byte integer'
			]
		];
		for (const [doctor, lookup, message] of cases) {
			const json = create_ghostty_manifest_fixture();
			doctor(json.types);
			const manifest = new GhosttyManifest(json);
			assert.include(catch_manifest_error(() => lookup(manifest)).message, message);
		}
	});
});

describe('constants resolvers', () => {
	test('resolve from the fixture', () => {
		const manifest = new GhosttyManifest(create_ghostty_manifest_fixture());
		const core = resolve_ghostty_vt_constants(manifest);
		assert.strictEqual(core.success, 0);
		assert.strictEqual(core.out_of_memory, -1);
		assert.strictEqual(core.result_names.get(-2), 'INVALID_VALUE');
		assert.strictEqual(core.result_names.get(-8), 'UNSUPPORTED');
		assert.notInclude([...core.result_names.values()], 'RESULT_MAX_VALUE');
		const terminal = resolve_ghostty_terminal_constants(manifest);
		assert.strictEqual(terminal.option_scrollback_max_bytes, 28);
		assert.strictEqual(terminal.option_scrollback_max_lines, 29);
		assert.strictEqual(terminal.scrollback_scalar, 'u32');
		assert.strictEqual(terminal.formatter_bool_scalar, 'bool');
		assert.strictEqual(terminal.formatter_emit_scalar, 'i32');
		assert.strictEqual(terminal.formatter_format_plain, 0);
	});

	test('fail naming what a doctored manifest lacks', () => {
		const cases: Array<
			[(types: Record<string, any>) => void, (m: GhosttyManifest) => unknown, string]
		> = [
			[
				(types) => delete types.GhosttyResult.values.SUCCESS,
				resolve_ghostty_vt_constants,
				'no value GhosttyResult.SUCCESS'
			],
			[
				(types) => delete types.GhosttyResult,
				resolve_ghostty_vt_constants,
				'no type GhosttyResult'
			],
			[
				(types) => delete types.GhosttyTerminalOption.values.SCROLLBACK_MAX_LINES,
				resolve_ghostty_terminal_constants,
				'no value GhosttyTerminalOption.SCROLLBACK_MAX_LINES'
			],
			[
				(types) => delete types.GhosttyTerminalOption.keys.SCROLLBACK_MAX_BYTES,
				resolve_ghostty_terminal_constants,
				'no key GhosttyTerminalOption.SCROLLBACK_MAX_BYTES'
			],
			[
				(types) => (types.GhosttyTerminalOption.keys.SCROLLBACK_MAX_LINES.type = 'u16'),
				resolve_ghostty_terminal_constants,
				'different value types'
			],
			[
				(types) => (types.GhosttyFormatterOption.keys.UNWRAP.type = 'u32'),
				resolve_ghostty_terminal_constants,
				'are not bools'
			],
			[
				(types) => delete types.GhosttyFormatterFormat,
				resolve_ghostty_terminal_constants,
				'no type GhosttyFormatterFormat'
			]
		];
		for (const [doctor, resolve, message] of cases) {
			const json = create_ghostty_manifest_fixture();
			doctor(json.types);
			const manifest = new GhosttyManifest(json);
			assert.include(catch_manifest_error(() => resolve(manifest)).message, message);
		}
	});
});
