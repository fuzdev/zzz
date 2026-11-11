/**
 * Access to libghostty-vt's wasm linear memory.
 *
 * Any export that allocates can grow the memory, which detaches every
 * `ArrayBuffer` view made before it. `GhosttyMemory.bytes` and
 * `GhosttyMemory.view` are the one place that knows about growth: they return
 * views of the live memory, cached until its buffer is replaced or resized,
 * so they're cheap to call per access. Callers use a view before their next
 * export call and never hold one across it. Pointers stay
 * valid across growth; they are `number`s normalized to unsigned, since a
 * wasm `i32` result above 2 GiB arrives negative.
 *
 * Scratch allocations go through `GhosttyMemory.with_scratch` and
 * `GhosttyMemory.with_opaque`, which free what they allocated, with the
 * length it was allocated with, on every path. Buffers the library allocates
 * itself (a formatter's output) are freed with `ghostty_free` by their
 * callers instead, per upstream's rule never to mix the families.
 *
 * @module
 */

import type { GhosttyScalar } from './ghostty_manifest.ts';

/** The wasm helper exports `GhosttyMemory` uses (wasm.h). */
export interface GhosttyMemoryExports {
	memory: WebAssembly.Memory;
	ghostty_wasm_alloc: (len: number) => number;
	ghostty_wasm_free: (ptr: number, len: number) => void;
	ghostty_wasm_alloc_opaque: () => number;
	ghostty_wasm_free_opaque: (slot: number) => void;
	ghostty_wasm_take_opaque: (slot: number) => number;
}

const utf8_decoder = new TextDecoder();

/**
 * Whether typed arrays on this host are little-endian, like wasm memory —
 * so `GhosttyMemory.words` reads wasm's `u32` values as they are.
 */
export const GHOSTTY_HOST_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Linear memory and the module's scratch allocator.
 */
export class GhosttyMemory {
	readonly #exports: GhosttyMemoryExports;
	readonly #out_of_memory: (call: string) => Error;
	readonly #is_poisoned: () => boolean;
	#cached_buffer: ArrayBuffer | null = null;
	#cached_length = 0;
	#cached_bytes: Uint8Array = new Uint8Array();
	#cached_words: Uint32Array = new Uint32Array();
	#cached_view: DataView = new DataView(new ArrayBuffer(0));

	/**
	 * @param exports - the module's memory and wasm helper exports
	 * @param out_of_memory - the error to throw when an allocation fails, given the export's name
	 * @param is_poisoned - whether the instance is poisoned (`GhosttyVt.poisoned`):
	 *   then the scratch helpers skip their frees, which would be refused and
	 *   replace the exception that poisoned it
	 */
	constructor(
		exports: GhosttyMemoryExports,
		out_of_memory: (call: string) => Error,
		is_poisoned: () => boolean
	) {
		this.#exports = exports;
		this.#out_of_memory = out_of_memory;
		this.#is_poisoned = is_poisoned;
	}

	/** The current size of linear memory in bytes. */
	get size(): number {
		return this.#exports.memory.buffer.byteLength;
	}

	/**
	 * A view of all of linear memory, valid until the next export call. Use it
	 * at once; never keep it.
	 */
	bytes(): Uint8Array {
		this.#refresh_views();
		return this.#cached_bytes;
	}

	/**
	 * A view of all of linear memory as `u32` words — the word at a 4-aligned
	 * `ptr` is at index `ptr >>> 2` — valid until the next export call. Use it
	 * at once; never keep it. Typed arrays have the host's byte order, so the
	 * words read as wasm's little-endian ones only on a little-endian host
	 * (`GHOSTTY_HOST_LITTLE_ENDIAN`); a reader of them checks that first.
	 */
	words(): Uint32Array {
		this.#refresh_views();
		return this.#cached_words;
	}

	/**
	 * A `DataView` of all of linear memory, valid until the next export call.
	 * Use it at once; never keep it.
	 */
	view(): DataView {
		this.#refresh_views();
		return this.#cached_view;
	}

	/**
	 * Remake the cached views when the memory has grown: its buffer is
	 * replaced, or (for a buffer that can grow in place) its length changes.
	 */
	#refresh_views(): void {
		const buffer = this.#exports.memory.buffer;
		if (buffer === this.#cached_buffer && buffer.byteLength === this.#cached_length) return;
		this.#cached_buffer = buffer;
		this.#cached_length = buffer.byteLength;
		this.#cached_bytes = new Uint8Array(buffer);
		// wasm memory is a whole number of 64 KiB pages, so it divides into words
		this.#cached_words = new Uint32Array(buffer);
		this.#cached_view = new DataView(buffer);
	}

	/**
	 * Allocate `len` uninitialized bytes, aligned for any ABI value. Free it
	 * with `GhosttyMemory.free` and the same `len`; prefer
	 * `GhosttyMemory.with_scratch`, which does.
	 *
	 * @param len - a positive byte count
	 * @returns the pointer
	 * @throws RangeError when `len` isn't a positive integer
	 * @throws Error the out-of-memory error given to the constructor (a
	 *   `GhosttyResultError` named `OUT_OF_MEMORY`, from `GhosttyVt`) when the
	 *   allocation fails
	 */
	alloc(len: number): number {
		if (!Number.isSafeInteger(len) || len <= 0 || len > 0xffff_ffff) {
			throw new RangeError(`can't allocate ${len} bytes`);
		}
		const ptr = this.#exports.ghostty_wasm_alloc(len) >>> 0;
		if (ptr === 0) throw this.#out_of_memory('ghostty_wasm_alloc');
		return ptr;
	}

	/** Free storage from `GhosttyMemory.alloc`, with the length it was allocated with. */
	free(ptr: number, len: number): void {
		this.#exports.ghostty_wasm_free(ptr, len);
	}

	/**
	 * Run `fn` with `len` bytes of scratch storage, freed when it returns or
	 * throws — unless the instance was poisoned meanwhile, when the free is
	 * skipped so `fn`'s exception propagates unchanged.
	 */
	with_scratch<T>(len: number, fn: (ptr: number) => T): T {
		const ptr = this.alloc(len);
		try {
			return fn(ptr);
		} finally {
			if (!this.#is_poisoned()) this.free(ptr, len);
		}
	}

	/**
	 * Run `fn` with an opaque out-parameter slot — the `GhosttyX*` a
	 * constructor writes its handle to — freed when it returns or throws.
	 * Read the handle with `GhosttyMemory.take_opaque` once the call that
	 * filled the slot has succeeded. Like `GhosttyMemory.with_scratch`, the
	 * free is skipped once the instance is poisoned.
	 */
	with_opaque<T>(fn: (slot: number) => T): T {
		const slot = this.#exports.ghostty_wasm_alloc_opaque() >>> 0;
		if (slot === 0) throw this.#out_of_memory('ghostty_wasm_alloc_opaque');
		try {
			return fn(slot);
		} finally {
			if (!this.#is_poisoned()) this.#exports.ghostty_wasm_free_opaque(slot);
		}
	}

	/**
	 * The handle in an opaque slot, leaving the slot empty.
	 *
	 * @returns the handle, `0` when the slot holds none
	 */
	take_opaque(slot: number): number {
		return this.#exports.ghostty_wasm_take_opaque(slot) >>> 0;
	}

	/** Copy `data` into memory at `ptr`. */
	write_bytes(ptr: number, data: Uint8Array): void {
		this.bytes().set(data, ptr);
	}

	/**
	 * Decode `len` bytes at `ptr` as UTF-8, replacing invalid sequences with
	 * U+FFFD.
	 */
	read_utf8(ptr: number, len: number): string {
		if (len === 0) return '';
		return utf8_decoder.decode(this.bytes().subarray(ptr, ptr + len));
	}

	/**
	 * Decode the NUL-terminated UTF-8 string at `ptr`.
	 *
	 * @throws RangeError when `ptr` is null or no NUL ends the string in memory
	 */
	read_c_string(ptr: number): string {
		if (ptr === 0) throw new RangeError('null string pointer');
		const bytes = this.bytes();
		const end = bytes.indexOf(0, ptr);
		if (end === -1) throw new RangeError(`no NUL ends the string at ${ptr}`);
		return utf8_decoder.decode(bytes.subarray(ptr, end));
	}

	/** Read a scalar at `ptr`, as the manifest describes its type. */
	read_scalar(ptr: number, scalar: GhosttyScalar): number {
		const view = this.view();
		switch (scalar) {
			case 'bool':
			case 'u8':
				return view.getUint8(ptr);
			case 'u16':
				return view.getUint16(ptr, true);
			case 'u32':
				return view.getUint32(ptr, true);
			case 'i32':
				return view.getInt32(ptr, true);
		}
	}

	/**
	 * Write a scalar at `ptr`, as the manifest describes its type.
	 *
	 * @throws RangeError when `value` doesn't fit the type
	 */
	write_scalar(ptr: number, scalar: GhosttyScalar, value: number): void {
		const view = this.view();
		switch (scalar) {
			case 'bool':
				view.setUint8(ptr, to_ghostty_integer(value, 0, 1, 'a bool'));
				return;
			case 'u8':
				view.setUint8(ptr, to_ghostty_integer(value, 0, 0xff, 'a u8'));
				return;
			case 'u16':
				view.setUint16(ptr, to_ghostty_integer(value, 0, 0xffff, 'a u16'), true);
				return;
			case 'u32':
				view.setUint32(ptr, to_ghostty_integer(value, 0, 0xffff_ffff, 'a u32'), true);
				return;
			case 'i32':
				view.setInt32(ptr, to_ghostty_integer(value, -0x8000_0000, 0x7fff_ffff, 'an i32'), true);
				return;
		}
	}

	/** The byte size of a scalar. */
	static scalar_size(scalar: GhosttyScalar): number {
		switch (scalar) {
			case 'bool':
			case 'u8':
				return 1;
			case 'u16':
				return 2;
			case 'u32':
			case 'i32':
				return 4;
		}
	}
}

/**
 * `value` checked to be an integer in `min..=max`, for an argument the C ABI
 * would otherwise truncate (a wasm `i32` parameter read as `uint16_t` keeps
 * only its low bits).
 *
 * @param what - what the value is, for the error
 * @throws RangeError when it isn't
 */
export const to_ghostty_integer = (
	value: number,
	min: number,
	max: number,
	what: string
): number => {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new RangeError(`${what} must be an integer from ${min} to ${max}, got ${value}`);
	}
	return value;
};
