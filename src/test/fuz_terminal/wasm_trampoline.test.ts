import { test, describe, assert } from 'vitest';

import {
	create_wasm_trampoline,
	encode_unsigned_leb128,
	encode_wasm_trampoline,
	type WasmFunctionSignature
} from '#lib/fuz_terminal/wasm_trampoline.ts';

describe('encode_unsigned_leb128', () => {
	test('encodes seven bits per byte, low first, with a continuation bit', () => {
		const cases: Array<[number, Array<number>]> = [
			[0, [0x00]],
			[1, [0x01]],
			[127, [0x7f]],
			[128, [0x80, 0x01]],
			[300, [0xac, 0x02]],
			[624_485, [0xe5, 0x8e, 0x26]],
			[2 ** 31, [0x80, 0x80, 0x80, 0x80, 0x08]],
			[2 ** 32 - 1, [0xff, 0xff, 0xff, 0xff, 0x0f]]
		];
		for (const [value, bytes] of cases) {
			assert.deepEqual(encode_unsigned_leb128(value), bytes, String(value));
		}
	});

	test('refuses what isn’t a u32', () => {
		for (const value of [-1, 2 ** 32, 1.5, NaN, Infinity]) {
			assert.throws(() => encode_unsigned_leb128(value), RangeError, 'LEB128');
		}
	});
});

describe('encode_wasm_trampoline', () => {
	test('the bytes for a `(i32, i32, i32, i32) -> ()` trampoline', () => {
		const bytes = encode_wasm_trampoline({ params: ['i32', 'i32', 'i32', 'i32'], results: [] });
		assert.deepEqual(
			[...bytes],
			[
				...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00], // magic, version 1
				...[0x01, 0x08, 0x01, 0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x00], // type: one functype
				...[0x02, 0x07, 0x01, 0x01, 0x66, 0x01, 0x66, 0x00, 0x00], // import: f.f, func type 0
				...[0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00] // export: f, func 0
			]
		);
	});

	test('the module imports one function and exports it, nothing else', () => {
		const signature: WasmFunctionSignature = { params: ['i32', 'i64'], results: ['f64'] };
		const bytes = encode_wasm_trampoline(signature);
		assert.isTrue(WebAssembly.validate(bytes));
		const module = new WebAssembly.Module(bytes);
		assert.deepEqual(
			WebAssembly.Module.imports(module).map(({ module, name, kind }) => ({ module, name, kind })),
			[{ module: 'f', name: 'f', kind: 'function' }]
		);
		assert.deepEqual(WebAssembly.Module.exports(module), [{ name: 'f', kind: 'function' }]);
	});

	test('a section longer than 127 bytes gets a multi-byte length', () => {
		// 200 params: the type section body is 205 bytes, its length two LEB128 bytes
		const bytes = encode_wasm_trampoline({ params: Array(200).fill('i32'), results: [] });
		assert.deepEqual([...bytes.subarray(8, 11)], [0x01, 0xcd, 0x01]);
		assert.isTrue(WebAssembly.validate(bytes));
	});

	test('an unknown value type is refused, not encoded', () => {
		for (const type of ['v128', 'externref', 'toString', undefined]) {
			assert.throws(
				() => encode_wasm_trampoline({ params: [type as any], results: [] }),
				TypeError,
				'is not a wasm value type'
			);
		}
	});

	test('more than one result is refused', () => {
		assert.throws(
			() => encode_wasm_trampoline({ params: [], results: ['i32', 'i32'] }),
			RangeError,
			'at most one result'
		);
	});
});

describe('create_wasm_trampoline', () => {
	test('calls through for each signature, converting arguments and results', () => {
		const calls: Array<Array<unknown>> = [];
		const record =
			(result?: unknown) =>
			(...args: Array<unknown>): unknown => {
				calls.push(args);
				return result;
			};
		const cases: Array<{
			signature: WasmFunctionSignature;
			result?: unknown;
			args: Array<unknown>;
			received: Array<unknown>;
			returned: unknown;
		}> = [
			{ signature: { params: [], results: [] }, args: [], received: [], returned: undefined },
			{
				signature: { params: ['i32', 'i32'], results: [] },
				args: [7, -1],
				received: [7, -1],
				returned: undefined
			},
			{
				// the effect shape: a terminal, a userdata pointer, a pointer, a length
				signature: { params: ['i32', 'i32', 'i32', 'i32'], results: [] },
				// out-of-range numbers wrap to i32 on the way in (ToInt32)
				args: [1024, 0, 2 ** 32 + 5, 2 ** 31],
				received: [1024, 0, 5, -(2 ** 31)],
				returned: undefined
			},
			{
				signature: { params: ['i32'], results: ['i32'] },
				result: 2 ** 32 + 9,
				args: [3],
				received: [3],
				returned: 9
			},
			{
				signature: { params: ['i64'], results: ['i64'] },
				result: 2n ** 63n,
				args: [2n ** 40n],
				received: [2n ** 40n],
				returned: -(2n ** 63n)
			},
			{
				signature: { params: ['f64', 'f32'], results: ['f64'] },
				result: 0.25,
				args: [1.5, 0.1],
				received: [1.5, Math.fround(0.1)],
				returned: 0.25
			}
		];
		for (const { signature, result, args, received, returned } of cases) {
			calls.length = 0;
			const trampoline = create_wasm_trampoline(record(result), signature);
			assert.strictEqual(typeof trampoline, 'function');
			assert.strictEqual((trampoline as (...args: Array<unknown>) => unknown)(...args), returned);
			assert.deepEqual(calls, [received], JSON.stringify(signature));
		}
	});

	test('a trampoline goes in a function table and calls through from there', () => {
		const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
		let received: Array<number> = [];
		const trampoline = create_wasm_trampoline(
			(...args: Array<number>) => {
				received = args;
			},
			{ params: ['i32', 'i32'], results: [] }
		);
		table.set(0, trampoline);
		(table.get(0) as (a: number, b: number) => void)(4, 2);
		assert.deepEqual(received, [4, 2]);
	});

	test('a plain JS function can’t go in a function table', () => {
		const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
		assert.throws(() => table.set(0, (() => {}) as any), TypeError);
	});

	test('an exception unwinds out through the trampoline', () => {
		// which is why a callback registered with a library must never throw
		const trampoline = create_wasm_trampoline(
			() => {
				throw new Error('out');
			},
			{ params: [], results: [] }
		) as () => void;
		assert.throws(trampoline, 'out');
	});
});
