import { test, describe, assert } from 'vitest';

import { GhosttyCallbackTable } from '#lib/fuz_terminal/ghostty_callback_table.ts';
import type { WasmFunctionSignature } from '#lib/fuz_terminal/wasm_trampoline.ts';

const SIGNATURE: WasmFunctionSignature = { params: ['i32'], results: [] };

const call = (table: WebAssembly.Table, index: number, arg: number): void => {
	(table.get(index) as (arg: number) => void)(arg);
};

describe('GhosttyCallbackTable', () => {
	test('each add fills a new slot past the module’s own, and calls through', () => {
		// slot 0 null, slot 1 standing in for one of the module's own functions
		const table = new WebAssembly.Table({ element: 'anyfunc', initial: 2 });
		const callbacks = new GhosttyCallbackTable(table);
		const received: Array<string> = [];
		const a = callbacks.add((n: number) => received.push(`a${n}`), SIGNATURE);
		const b = callbacks.add((n: number) => received.push(`b${n}`), SIGNATURE);
		assert.strictEqual(a, 2);
		assert.strictEqual(b, 3);
		assert.strictEqual(callbacks.length, 4);
		assert.strictEqual(table.length, 4);
		assert.strictEqual(table.get(1), null, 'the module’s own slot is untouched');
		call(table, b, 1);
		call(table, a, 2);
		assert.deepEqual(received, ['b1', 'a2']);
	});

	test('an empty table is refused: it has no null slot 0', () => {
		assert.throws(
			() => new GhosttyCallbackTable(new WebAssembly.Table({ element: 'anyfunc', initial: 0 })),
			RangeError,
			'empty'
		);
	});
});
