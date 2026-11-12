import { test, describe, assert } from 'vitest';

import { resolve_ghostty_effect_constants } from '#lib/fuz_terminal/ghostty_effects.ts';
import { GhosttyManifestError } from '#lib/fuz_terminal/ghostty_errors.ts';
import { resolve_ghostty_key_constants } from '#lib/fuz_terminal/ghostty_key_encoder.ts';
import {
	GhosttyManifest,
	parse_ghostty_manifest,
	read_ghostty_bits,
	to_ghostty_bit_reader
} from '#lib/fuz_terminal/ghostty_manifest.ts';
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

describe('GhosttyManifest packed bits', () => {
	const manifest = new GhosttyManifest(create_ghostty_manifest_fixture());

	test('a field, and a field inside a union arm, counted from bit 0', () => {
		assert.deepEqual(manifest.packed_bits('GhosttyCell', ['style_id']), {
			lsb: 26,
			width: 16,
			type: 'GhosttyStyleId'
		});
		assert.deepEqual(manifest.packed_bits('GhosttyCell', ['content', 'CODEPOINT', 'codepoint']), {
			lsb: 2,
			width: 21,
			type: 'u21'
		});
		assert.deepEqual(manifest.packed_bits('GhosttyCell', ['content', 'BG_COLOR_RGB', 'b']), {
			lsb: 18,
			width: 8,
			type: 'u8'
		});
	});

	test('a missing or misplaced field is refused', () => {
		const cases: Array<[(types: Record<string, any>) => void, ReadonlyArray<string>, string]> = [
			[() => {}, ['nope'], 'no usable bit field GhosttyCell.nope'],
			[() => {}, ['content', 'NOPE', 'codepoint'], 'no packed arm GhosttyCell.content.NOPE'],
			[() => {}, ['content', 'CODEPOINT'], 'no packed arm GhosttyCell.content.CODEPOINT'],
			[() => {}, ['style_id', 'x', 'y'], 'no packed arm GhosttyCell.style_id'],
			[(types) => (types.GhosttyCell.bits.wide.lsb = 63), ['wide'], 'no usable bit field'],
			[(types) => (types.GhosttyCell.bits.wide.width = 0), ['wide'], 'no usable bit field'],
			[(types) => (types.GhosttyCell.bits.wide.lsb = -1), ['wide'], 'no usable bit field'],
			[(types) => delete types.GhosttyCell.bits.wide.type, ['wide'], 'has no type'],
			[
				// an arm's field past the union's own width
				(types) => (types.GhosttyCell.bits.content.arms.CODEPOINT.bits.codepoint.lsb = 4),
				['content', 'CODEPOINT', 'codepoint'],
				'no usable bit field'
			],
			[(types) => (types.GhosttyCell.kind = 'struct'), ['wide'], 'is a "struct", not a packed'],
			[(types) => delete types.GhosttyCell.size, ['wide'], 'has no size']
		];
		for (const [doctor, path, message] of cases) {
			const json = create_ghostty_manifest_fixture();
			doctor(json.types);
			const doctored = new GhosttyManifest(json);
			const error = catch_manifest_error(() => doctored.packed_bits('GhosttyCell', path));
			assert.include(error.message, message, path.join('.'));
		}
	});

	test('a bit reader reads fields in either word, or across both', () => {
		// a u64 with a 16-bit field at 26..42, straddling the words, and fields either side
		const value = (0x1234n << 26n) | (0x2n << 42n) | (0x3n << 0n) | (0x1fffffn << 2n);
		const lo = Number(value & 0xffff_ffffn);
		const hi = Number(value >> 32n);
		const read = (lsb: number, width: number): number =>
			read_ghostty_bits(lo, hi, to_ghostty_bit_reader({ lsb, width, type: 'u' }, 'test'));
		assert.strictEqual(read(26, 16), 0x1234);
		assert.strictEqual(read(42, 2), 0x2);
		assert.strictEqual(read(0, 2), 0x3);
		assert.strictEqual(read(2, 21), 0x1f_ffff);
		assert.strictEqual(read(44, 20), 0);
		// whole words, unsigned
		const ones = to_ghostty_bit_reader({ lsb: 32, width: 32, type: 'u32' }, 'test');
		assert.strictEqual(read_ghostty_bits(0, 0xffff_ffff, ones), 0xffff_ffff);
		const low = to_ghostty_bit_reader({ lsb: 0, width: 32, type: 'u32' }, 'test');
		assert.strictEqual(read_ghostty_bits(0x8000_0001, 0, low), 0x8000_0001);
		const across = to_ghostty_bit_reader({ lsb: 16, width: 32, type: 'u32' }, 'test');
		assert.strictEqual(read_ghostty_bits(0xabcd_0000, 0x1234, across), 0x1234_abcd);
		assert.throws(
			() => to_ghostty_bit_reader({ lsb: 0, width: 33, type: 'u33' }, 'wide'),
			GhosttyManifestError,
			'at most 32 bits'
		);
	});
});

describe('GhosttyManifest callbacks', () => {
	const manifest = new GhosttyManifest(create_ghostty_manifest_fixture());

	test('a callback’s parameter and return types', () => {
		assert.deepEqual(manifest.callback('GhosttyTerminalWritePtyFn'), {
			params: ['GhosttyTerminal', 'pointer', 'pointer', 'u32'],
			returns: 'void'
		});
		assert.deepEqual(manifest.callback('GhosttyTerminalBellFn'), {
			params: ['GhosttyTerminal', 'pointer'],
			returns: 'void'
		});
	});

	test('a callback that’s missing, another kind, or malformed is refused', () => {
		const cases: Array<[(types: Record<string, any>) => void, string, string]> = [
			[() => {}, 'GhosttyTerminalNopeFn', 'no type GhosttyTerminalNopeFn'],
			[() => {}, 'GhosttyString', 'is a "struct", not a callback'],
			[(types) => delete types.GhosttyTerminalBellFn.params, 'GhosttyTerminalBellFn', 'no params'],
			[
				(types) => delete types.GhosttyTerminalBellFn.return,
				'GhosttyTerminalBellFn',
				'no params or return'
			],
			[
				(types) => (types.GhosttyTerminalBellFn.params[1] = { elem: 'opaque' }),
				'GhosttyTerminalBellFn',
				'a parameter without a type'
			]
		];
		for (const [doctor, type_name, message] of cases) {
			const json = create_ghostty_manifest_fixture();
			doctor(json.types);
			const doctored = new GhosttyManifest(json);
			assert.include(catch_manifest_error(() => doctored.callback(type_name)).message, message);
		}
	});

	test('the wasm type each kind of value passes as', () => {
		const json = create_ghostty_manifest_fixture();
		json.types.TestAlias = { kind: 'alias', size: 2, align: 2, type: 'u16' };
		json.types.TestWideAlias = { kind: 'alias', size: 8, align: 8, type: 'u64' };
		json.types.TestLoopA = { kind: 'alias', size: 4, align: 4, type: 'TestLoopB' };
		json.types.TestLoopB = { kind: 'alias', size: 4, align: 4, type: 'TestLoopA' };
		const doctored = new GhosttyManifest(json);
		const cases: Array<[string, string]> = [
			['pointer', 'i32'],
			['bool', 'i32'],
			['u8', 'i32'],
			['i16', 'i32'],
			['u32', 'i32'],
			['u64', 'i64'],
			['GhosttyTerminal', 'i32'], // an opaque handle
			['GhosttyResult', 'i32'], // an enum
			['TestAlias', 'i32'],
			['TestWideAlias', 'i64']
		];
		for (const [type_name, wasm] of cases) {
			assert.strictEqual(doctored.wasm_value_type(type_name), wasm, type_name);
		}
		for (const [type_name, message] of [
			['GhosttyString', "GhosttyString doesn't pass as a wasm number"], // a struct by value
			['TestLoopA', "TestLoopA doesn't pass as a wasm number"],
			['void', 'no type void'],
			['GhosttyNope', 'no type GhosttyNope']
		]) {
			assert.include(
				catch_manifest_error(() => doctored.wasm_value_type(type_name!)).message,
				message!
			);
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
		const effects = resolve_ghostty_effect_constants(manifest);
		assert.deepEqual(effects.effects.write_pty, {
			option: 2,
			signature: { params: ['i32', 'i32', 'i32', 'i32'], results: [] }
		});
		for (const [name, option] of [
			['bell', 3],
			['title_changed', 6],
			['pwd_changed', 26]
		] as const) {
			assert.deepEqual(effects.effects[name], {
				option,
				signature: { params: ['i32', 'i32'], results: [] }
			});
		}
		assert.deepEqual(effects.effects.render_hold, {
			option: 42,
			signature: { params: ['i32', 'i32', 'i32'], results: [] }
		});
		assert.strictEqual(effects.data_title, 12);
		assert.strictEqual(effects.data_pwd, 13);
		assert.strictEqual(effects.string_size, 8);
		assert.strictEqual(effects.string_ptr_offset, 0);
		assert.strictEqual(effects.string_len_offset, 4);
		const keys = resolve_ghostty_key_constants(manifest);
		assert.strictEqual(keys.keys.get('UNIDENTIFIED'), 0);
		assert.strictEqual(keys.keys.get('A'), 20);
		assert.strictEqual(keys.keys.get('NUMPAD_END'), 115);
		assert.isFalse(keys.keys.has('MAX_VALUE'));
		assert.deepEqual(keys.actions, { press: 1, repeat: 2, release: 0 });
		assert.strictEqual(keys.out_of_space, -3);
		assert.strictEqual(keys.string_size, 8);
		assert.strictEqual(keys.string_ptr_offset, 0);
		assert.strictEqual(keys.string_len_offset, 4);
		assert.strictEqual(keys.data_kitty_keyboard_flags, 8);
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
			],
			[
				(types) => delete types.GhosttyTerminalOption.values.PWD_CHANGED,
				resolve_ghostty_effect_constants,
				'no value GhosttyTerminalOption.PWD_CHANGED'
			],
			[
				(types) => (types.GhosttyTerminalOption.keys.BELL.type = 'GhosttyTerminalResetFn'),
				resolve_ghostty_effect_constants,
				'GhosttyTerminalOption.BELL takes GhosttyTerminalResetFn, not GhosttyTerminalBellFn'
			],
			[
				(types) => delete types.GhosttyTerminalTitleChangedFn,
				resolve_ghostty_effect_constants,
				'no type GhosttyTerminalTitleChangedFn'
			],
			[
				// a 64-bit length would be misread as the 32-bit one the receiver takes
				(types) => (types.GhosttyTerminalWritePtyFn.params[3] = { type: 'u64' }),
				resolve_ghostty_effect_constants,
				'GhosttyTerminalWritePtyFn is (GhosttyTerminal, pointer, pointer, u64) -> void, but the binding reads (GhosttyTerminal, pointer, pointer, u32) -> void'
			],
			[
				// the same wasm types, so only the names tell the length from the pointer
				(types) => {
					const params = types.GhosttyTerminalWritePtyFn.params;
					[params[2], params[3]] = [params[3], params[2]];
				},
				resolve_ghostty_effect_constants,
				'GhosttyTerminalWritePtyFn is (GhosttyTerminal, pointer, u32, pointer) -> void'
			],
			[
				(types) => types.GhosttyTerminalBellFn.params.shift(),
				resolve_ghostty_effect_constants,
				'GhosttyTerminalBellFn is (pointer) -> void'
			],
			[
				(types) => (types.GhosttyTerminalPwdChangedFn.return = { type: 'bool' }),
				resolve_ghostty_effect_constants,
				'GhosttyTerminalPwdChangedFn is (GhosttyTerminal, pointer) -> bool'
			],
			[
				(types) => (types.GhosttyTerminalData.keys.TITLE.type = 'GhosttyColorRgb'),
				resolve_ghostty_effect_constants,
				'GhosttyTerminalData.TITLE gives GhosttyColorRgb, not GhosttyString'
			],
			[
				(types) => (types.GhosttyString.fields.len.type = 'u16'),
				resolve_ghostty_effect_constants,
				'GhosttyString.len is not a size_t'
			],
			[
				(types) => delete types.GhosttyKey.values.UNIDENTIFIED,
				resolve_ghostty_key_constants,
				'no value GhosttyKey.UNIDENTIFIED'
			],
			[
				(types) => delete types.GhosttyKeyAction.values.REPEAT,
				resolve_ghostty_key_constants,
				'no value GhosttyKeyAction.REPEAT'
			],
			[
				// a wider mask would pass the side bits where the library reads others
				(types) => (types.GhosttyMods.type = 'u32'),
				resolve_ghostty_key_constants,
				'GhosttyMods is "u32", not a u16'
			],
			[
				(types) => (types.GhosttyKey.underlying = 'u64'),
				resolve_ghostty_key_constants,
				'GhosttyKey has underlying type "u64"'
			],
			[
				(types) => (types.GhosttyString.fields.ptr.type = 'u32'),
				resolve_ghostty_key_constants,
				'GhosttyString.ptr is not a pointer'
			],
			[
				(types) => (types.GhosttyKittyKeyFlags.type = 'u16'),
				resolve_ghostty_key_constants,
				'KITTY_KEYBOARD_FLAGS gives GhosttyKittyKeyFlags, "u16", not a u8'
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
