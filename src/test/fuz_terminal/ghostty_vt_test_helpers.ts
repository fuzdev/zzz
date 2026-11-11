import { readFile } from 'node:fs/promises';

import { GhosttyVt, load_ghostty_vt } from '#lib/fuz_terminal/ghostty_vt.ts';

/**
 * The module `cargo xtask ghostty-vt` installs. Only `*.wasm.test.ts` files
 * load it, and their vitest project exists only when it's there.
 */
export const GHOSTTY_VT_MODULE_URL = new URL(
	'../../../static/fuz_terminal/ghostty-vt.wasm',
	import.meta.url
);

let compiled: Promise<WebAssembly.Module> | undefined;

/**
 * A fresh instance of the built module — its own linear memory, nothing
 * shared with other tests. The module is compiled once per test file.
 */
export const load_test_ghostty_vt = async (): Promise<GhosttyVt> => {
	compiled ??= readFile(GHOSTTY_VT_MODULE_URL).then((bytes) => WebAssembly.compile(bytes));
	return load_ghostty_vt(await compiled);
};

/**
 * An instance of the built module whose manifest, as the binding reads it,
 * is the real one changed by `edit` — for making a step fail on purpose. The
 * doctored JSON is written into the instance's own memory, where
 * `ghostty_type_json` then points.
 */
export const load_doctored_ghostty_vt = async (
	edit: (manifest: Record<string, any>) => void
): Promise<GhosttyVt> => {
	compiled ??= readFile(GHOSTTY_VT_MODULE_URL).then((bytes) => WebAssembly.compile(bytes));
	const instance = await WebAssembly.instantiate(await compiled, {});
	const exports = instance.exports as Record<string, any>;
	const real = new GhosttyVt(instance);
	const manifest = JSON.parse(real.memory.read_c_string(exports.ghostty_type_json() >>> 0));
	edit(manifest);
	const text = new TextEncoder().encode(JSON.stringify(manifest) + '\0');
	const ptr = real.memory.alloc(text.length);
	real.memory.write_bytes(ptr, text);
	return new GhosttyVt({ exports: { ...exports, ghostty_type_json: () => ptr } });
};

/**
 * An instance of the built module with the exports `wrap` returns in place
 * of the real ones — for observing a call or making one fail.
 */
export const load_wrapped_ghostty_vt = async (
	wrap: (exports: Record<string, any>) => Record<string, any>
): Promise<GhosttyVt> => {
	compiled ??= readFile(GHOSTTY_VT_MODULE_URL).then((bytes) => WebAssembly.compile(bytes));
	const instance = await WebAssembly.instantiate(await compiled, {});
	const exports = instance.exports as Record<string, any>;
	return new GhosttyVt({ exports: { ...exports, ...wrap(exports) } });
};
