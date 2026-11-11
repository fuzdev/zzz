/**
 * The function pointers a libghostty-vt instance's callbacks are passed as:
 * slots added to its `__indirect_function_table`, each holding a trampoline
 * that calls a JS function. A wasm table can grow but never shrink, so its
 * callers add a slot once per callback they keep for the instance's life.
 *
 * @module
 */

import { create_wasm_trampoline, type WasmFunctionSignature } from './wasm_trampoline.ts';

/**
 * The slots one module instance's callbacks hold in its function table. The
 * module's own slots are never written.
 */
export class GhosttyCallbackTable {
	readonly #table: WebAssembly.Table;

	/**
	 * @param table - the module's exported function table (`__indirect_function_table`)
	 * @throws RangeError when the table is empty: a C module's reserves slot 0
	 *   as the null function pointer, so an index this table adds is never `0`
	 */
	constructor(table: WebAssembly.Table) {
		if (table.length === 0) {
			throw new RangeError('the function table is empty, so it has no null slot 0');
		}
		this.#table = table;
	}

	/** The function table's length: the module's own slots, and every one added here. */
	get length(): number {
		return this.#table.length;
	}

	/**
	 * Put a JS function in a new slot, as a wasm function of `signature`, and
	 * return the slot's index — the function pointer to pass to the library.
	 * The slot is held for the instance's life.
	 *
	 * `fn` must never throw: it runs inside the wasm call that invokes it, and
	 * an exception would unwind through that call's frames.
	 *
	 * @returns the index, never `0` (C's null pointer)
	 * @throws RangeError when the table can't grow
	 */
	add(fn: (...args: Array<any>) => unknown, signature: WasmFunctionSignature): number {
		const trampoline = create_wasm_trampoline(fn, signature);
		const index = this.#table.grow(1);
		this.#table.set(index, trampoline);
		return index;
	}
}
