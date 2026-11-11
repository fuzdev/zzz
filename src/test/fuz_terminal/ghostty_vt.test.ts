import { test, describe, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import { GhosttyLoadError, GhosttyResultError } from '#lib/fuz_terminal/ghostty_errors.ts';
import { to_ghostty_integer } from '#lib/fuz_terminal/ghostty_memory.ts';
import { load_ghostty_vt } from '#lib/fuz_terminal/ghostty_vt.ts';

/** The WebAssembly magic number and version: the smallest valid module, empty. */
const EMPTY_MODULE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
/** A module importing one function, `e.f`, of type `() -> ()`. */
const IMPORTING_MODULE = [
	...EMPTY_MODULE,
	...[0x01, 0x04, 0x01, 0x60, 0x00, 0x00], // type section: one `() -> ()`
	...[0x02, 0x07, 0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00] // import section: `e.f`
];

describe('load_ghostty_vt refuses what isn’t libghostty-vt', () => {
	test('bytes that aren’t WebAssembly', async () => {
		for (const bytes of [new Uint8Array(), new TextEncoder().encode('<!doctype html>')]) {
			const error = await assert_rejects(() => load_ghostty_vt(bytes));
			assert(error instanceof GhosttyLoadError, String(error));
			assert.include(error.message, 'not a WebAssembly module');
			assert.ok(error.cause instanceof WebAssembly.CompileError);
		}
	});

	test('a module that imports something', async () => {
		const error = await assert_rejects(() => load_ghostty_vt(new Uint8Array(IMPORTING_MODULE)));
		assert(error instanceof GhosttyLoadError, String(error));
		assert.include(error.message, 'imports e.f');
	});

	test('a module without its exports', async () => {
		const error = await assert_rejects(() => load_ghostty_vt(new Uint8Array(EMPTY_MODULE)));
		assert(error instanceof GhosttyLoadError, String(error));
		assert.include(error.message, "doesn't export memory, ghostty_wasm_alloc,");
		assert.include(error.message, 'ghostty_formatter_free');
	});

	test('an unsuccessful response, and a successful one with the wrong bytes', async () => {
		const missing = await assert_rejects(() =>
			load_ghostty_vt(new Response('not found', { status: 404, statusText: 'Not Found' }))
		);
		assert(missing instanceof GhosttyLoadError, String(missing));
		assert.include(missing.message, '404 Not Found');
		const html = await assert_rejects(() => load_ghostty_vt(new Response('<!doctype html>')));
		assert(html instanceof GhosttyLoadError, String(html));
		assert.include(html.message, 'not a WebAssembly module');
	});
});

describe('errors', () => {
	test('a result error names the call and the result', () => {
		const error = new GhosttyResultError('ghostty_terminal_new', -2, 'INVALID_VALUE');
		assert.strictEqual(error.message, 'ghostty_terminal_new failed: INVALID_VALUE (-2)');
		assert.strictEqual(error.name, 'GhosttyResultError');
		assert.strictEqual(error.call, 'ghostty_terminal_new');
		assert.strictEqual(error.result_code, -2);
		assert.strictEqual(error.result_name, 'INVALID_VALUE');
	});

	test('an integer the C type can’t hold is a RangeError', () => {
		assert.strictEqual(to_ghostty_integer(65535, 0, 0xffff, 'cols'), 65535);
		for (const value of [65536, -1, 1.5, NaN, Infinity]) {
			assert.throws(
				() => to_ghostty_integer(value, 0, 0xffff, 'cols'),
				RangeError,
				`cols must be an integer from 0 to 65535, got ${value}`
			);
		}
	});
});
