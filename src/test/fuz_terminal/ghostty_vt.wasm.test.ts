import { readFile } from 'node:fs/promises';
import { test, describe, assert } from 'vitest';

import {
	GhosttyLoadError,
	GhosttyManifestError,
	GhosttyResultError
} from '#lib/fuz_terminal/ghostty_errors.ts';
import { GhosttyVt, load_ghostty_vt } from '#lib/fuz_terminal/ghostty_vt.ts';

import { GHOSTTY_MANIFEST_FIXTURE } from './ghostty_manifest_fixture.ts';
import { GHOSTTY_VT_MODULE_URL, load_test_ghostty_vt } from './ghostty_vt_test_helpers.ts';

describe('load_ghostty_vt', () => {
	test('loads the built module from bytes, a response, or a compiled module', async () => {
		const bytes = await readFile(GHOSTTY_VT_MODULE_URL);
		for (const source of [bytes, new Response(bytes), await WebAssembly.compile(bytes)]) {
			const vt = await load_ghostty_vt(source);
			assert.strictEqual(vt.version, '1.0.0');
		}
	});

	test('reports the version and build it was made with', async () => {
		const vt = await load_test_ghostty_vt();
		assert.strictEqual(vt.version, '1.0.0');
		assert.strictEqual(vt.manifest.library_version, '1.0.0');
		assert.strictEqual(vt.build_info.optimize, 'RELEASE_SMALL');
		// the native SIMD dependencies, never built for wasm (the module still uses simd128)
		assert.isFalse(vt.build_info.simd);
	});

	test('has exactly the features `cargo xtask ghostty-vt` builds in', async () => {
		const vt = await load_test_ghostty_vt();
		const built_in = ['render_state', 'input_encode', 'selection', 'color', 'formatter'];
		const left_out = [
			'snapshot',
			'search',
			'grid_introspection',
			'glyph_protocol',
			'kitty_graphics',
			'tmux_control_mode'
		];
		for (const name of built_in) assert.isTrue(vt.has_feature(name), name);
		for (const name of left_out) assert.isFalse(vt.has_feature(name), name);
		assert.sameMembers([...vt.build_info.features.keys()], [...built_in, ...left_out]);
		assert.throws(
			() => vt.has_feature('render-state'),
			GhosttyManifestError,
			'no feature "render-state"'
		);
	});

	test('the unit tests’ manifest fixture matches the module’s manifest', async () => {
		const vt = await load_test_ghostty_vt();
		const memory = vt.memory;
		const real = JSON.parse(memory.read_c_string(vt.exports.ghostty_type_json() >>> 0));
		for (const key of ['schema', 'abi', 'library_version']) {
			assert.deepEqual(GHOSTTY_MANIFEST_FIXTURE[key], real[key], key);
		}
		for (const [name, fixture] of Object.entries<Record<string, any>>(
			GHOSTTY_MANIFEST_FIXTURE.types
		)) {
			const type = real.types[name];
			assert.ok(type, name);
			// the fixture trims enum values and keys, keeping the rest of the entry
			const { values, keys, ...rest } = fixture;
			const { values: real_values, keys: real_keys, ...real_rest } = type;
			assert.deepEqual(rest, real_rest, name);
			for (const [value_name, value] of Object.entries(values ?? {})) {
				assert.strictEqual(real_values[value_name], value, `${name}.${value_name}`);
			}
			for (const [key_name, key] of Object.entries(keys ?? {})) {
				assert.deepEqual(real_keys[key_name], key, `${name} key ${key_name}`);
			}
		}
	});

	test('an empty function table is a load error', async () => {
		const bytes = await readFile(GHOSTTY_VT_MODULE_URL);
		const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {});
		const empty = new WebAssembly.Table({ element: 'anyfunc', initial: 0 });
		assert.throws(
			() => new GhosttyVt({ exports: { ...instance.exports, __indirect_function_table: empty } }),
			GhosttyLoadError,
			'function table is empty'
		);
	});

	test('instances share no memory', async () => {
		const a = await load_test_ghostty_vt();
		const b = await load_test_ghostty_vt();
		assert.notStrictEqual(a.exports.memory, b.exports.memory);
	});

	test('a failing result is a named error', async () => {
		const vt = await load_test_ghostty_vt();
		const build_info_invalid = vt.manifest.enum_value('GhosttyBuildInfo', 'INVALID');
		let error: unknown;
		try {
			vt.memory.with_scratch(4, (out) =>
				vt.check(vt.exports.ghostty_build_info(build_info_invalid, out), 'ghostty_build_info')
			);
		} catch (caught) {
			error = caught;
		}
		assert(error instanceof GhosttyResultError, String(error));
		assert.strictEqual(error.result_name, 'INVALID_VALUE');
		assert.strictEqual(error.result_code, vt.manifest.enum_value('GhosttyResult', 'INVALID_VALUE'));
		assert.strictEqual(error.message, 'ghostty_build_info failed: INVALID_VALUE (-2)');
		assert.strictEqual(vt.result_name(12345), 'UNKNOWN');
	});
});
