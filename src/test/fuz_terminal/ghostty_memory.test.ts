import { test, describe, assert } from 'vitest';

import { GhosttyMemory, type GhosttyMemoryExports } from '#lib/fuz_terminal/ghostty_memory.ts';

/** Memory exports over a plain `WebAssembly.Memory`; the allocator isn't used. */
const create_memory_exports = (memory: WebAssembly.Memory): GhosttyMemoryExports => {
	const unused = (): never => {
		throw new Error('not used by these tests');
	};
	return {
		memory,
		ghostty_wasm_alloc: unused,
		ghostty_wasm_free: unused,
		ghostty_wasm_alloc_opaque: unused,
		ghostty_wasm_free_opaque: unused,
		ghostty_wasm_take_opaque: unused
	};
};

describe('GhosttyMemory views', () => {
	test('are cached until memory grows, then the live ones', () => {
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
		const ghostty_memory = new GhosttyMemory(
			create_memory_exports(memory),
			() => new Error('oom'),
			() => false
		);
		const bytes = ghostty_memory.bytes();
		const view = ghostty_memory.view();
		assert.strictEqual(ghostty_memory.bytes(), bytes);
		assert.strictEqual(ghostty_memory.view(), view);
		assert.strictEqual(bytes.byteLength, 65536);

		memory.grow(1);
		assert.strictEqual(bytes.byteLength, 0, 'the old view detached');
		const grown = ghostty_memory.bytes();
		assert.notStrictEqual(grown, bytes);
		assert.strictEqual(grown.byteLength, 2 * 65536);
		assert.strictEqual(ghostty_memory.view().byteLength, 2 * 65536);
		assert.strictEqual(ghostty_memory.size, 2 * 65536);

		// writes through the new views reach the memory
		ghostty_memory.write_scalar(70_000, 'u32', 0xdead_beef);
		assert.strictEqual(new DataView(memory.buffer).getUint32(70_000, true), 0xdead_beef);
		assert.strictEqual(ghostty_memory.read_scalar(70_000, 'u32'), 0xdead_beef);
	});

	test('a scalar that doesn’t fit its type is refused', () => {
		const ghostty_memory = new GhosttyMemory(
			create_memory_exports(new WebAssembly.Memory({ initial: 1 })),
			() => new Error('oom'),
			() => false
		);
		assert.throws(() => ghostty_memory.write_scalar(0, 'u16', 70_000), RangeError, 'a u16');
		assert.throws(() => ghostty_memory.write_scalar(0, 'bool', 2), RangeError, 'a bool');
		assert.throws(() => ghostty_memory.write_scalar(0, 'i32', 2 ** 31), RangeError, 'an i32');
	});
});

describe('GhosttyMemory strings', () => {
	const BOM_A = [0xef, 0xbb, 0xbf, 0x61];

	test('read_utf8 keeps a leading U+FEFF', () => {
		const memory = new WebAssembly.Memory({ initial: 1 });
		const ghostty_memory = new GhosttyMemory(
			create_memory_exports(memory),
			() => new Error('oom'),
			() => false
		);
		ghostty_memory.write_bytes(16, new Uint8Array(BOM_A));
		assert.strictEqual(ghostty_memory.read_utf8(16, BOM_A.length), '\ufeffa');
		// and again: a non-streaming decode would strip it at the start of every call
		assert.strictEqual(ghostty_memory.read_utf8(16, BOM_A.length), '\ufeffa');
	});

	test('read_c_string keeps a leading U+FEFF', () => {
		const memory = new WebAssembly.Memory({ initial: 1 });
		const ghostty_memory = new GhosttyMemory(
			create_memory_exports(memory),
			() => new Error('oom'),
			() => false
		);
		ghostty_memory.write_bytes(16, new Uint8Array([...BOM_A, 0]));
		assert.strictEqual(ghostty_memory.read_c_string(16), '\ufeffa');
	});
});
