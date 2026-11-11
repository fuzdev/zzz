import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GhosttyVt, load_ghostty_vt } from '#lib/fuz_terminal/ghostty_vt.ts';

/**
 * The module `cargo xtask ghostty-vt` installs, on disk. Only
 * `*.wasm.test.ts` files load it, and their vitest project exists only when
 * it's there. A path, not `new URL(…, import.meta.url)`, which Vite rewrites
 * to a served asset URL under the jsdom environment.
 */
const GHOSTTY_VT_MODULE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../static/fuz_terminal/ghostty-vt.wasm'
);

/** The module's file URL (Node's `URL`, whichever environment the test runs in). */
export const GHOSTTY_VT_MODULE_URL = pathToFileURL(GHOSTTY_VT_MODULE_PATH);

let compiled: Promise<WebAssembly.Module> | undefined;

/** The built module, compiled once per test file. */
export const compile_test_ghostty_vt = (): Promise<WebAssembly.Module> =>
	(compiled ??= readFile(GHOSTTY_VT_MODULE_PATH).then((bytes) => WebAssembly.compile(bytes)));

/**
 * A fresh instance of the built module — its own linear memory, nothing
 * shared with other tests. The module is compiled once per test file.
 */
export const load_test_ghostty_vt = async (): Promise<GhosttyVt> =>
	load_ghostty_vt(await compile_test_ghostty_vt());

/**
 * An instance of the built module whose manifest, as the binding reads it,
 * is the real one changed by `edit` — for making a step fail on purpose. The
 * doctored JSON is written into the instance's own memory, where
 * `ghostty_type_json` then points.
 */
export const load_doctored_ghostty_vt = async (
	edit: (manifest: Record<string, any>) => void
): Promise<GhosttyVt> => {
	const instance = await WebAssembly.instantiate(await compile_test_ghostty_vt(), {});
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
 * of the real ones — for observing a call or making one fail. `GhosttyVt`
 * guards the replacements like the real exports, so one that throws poisons
 * the instance (`GhosttyVt.poisoned`) as an escape from the module would.
 */
export const load_wrapped_ghostty_vt = async (
	wrap: (exports: Record<string, any>) => Record<string, any>
): Promise<GhosttyVt> => {
	const instance = await WebAssembly.instantiate(await compile_test_ghostty_vt(), {});
	const exports = instance.exports as Record<string, any>;
	return new GhosttyVt({ exports: { ...exports, ...wrap(exports) } });
};
