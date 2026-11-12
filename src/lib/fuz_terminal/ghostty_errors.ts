/**
 * The errors the libghostty-vt binding throws: a module that can't be used, a
 * type manifest missing what the binding needs, a call that returned a failing
 * `GhosttyResult`, a handle used after it was disposed, a terminal called
 * back into from its own effect handler, an effect handler that threw, and a
 * module instance an exception escaped from.
 *
 * Argument errors the C ABI can't represent — a column count that doesn't fit
 * its `uint16_t`, a fractional size — are `RangeError`s thrown before any call.
 *
 * @module
 */

/**
 * The wasm module can't be used: its bytes don't compile, it imports
 * something, it lacks an export the binding calls, its manifest disagrees
 * with the library it came with, it was built without a feature a handle
 * needs (a `GhosttyRenderState` needs `render_state`, a `GhosttyKeyEncoder`
 * `input_encode`), or it breaks a promise
 * of the library's API (a render state's rows ending before its row count).
 */
export class GhosttyLoadError extends Error {
	override name = 'GhosttyLoadError';
}

/**
 * The module's type manifest (`ghostty_type_json()`) is missing an entry the
 * binding reads, or has it in another shape — an unknown schema version, an
 * ABI other than little-endian wasm32, an enum value that isn't a number, a
 * struct field without an offset. The message names the entry.
 */
export class GhosttyManifestError extends Error {
	override name = 'GhosttyManifestError';
}

/**
 * A libghostty-vt call returned a `GhosttyResult` other than success.
 */
export class GhosttyResultError extends Error {
	override name = 'GhosttyResultError';

	/** The export that failed, such as `ghostty_terminal_new`. */
	readonly call: string;
	/** The `GhosttyResult` it returned. */
	readonly result_code: number;
	/**
	 * The result's name from the manifest without its prefix, such as
	 * `INVALID_VALUE`, or `UNKNOWN` for a code the manifest doesn't list.
	 */
	readonly result_name: string;

	constructor(call: string, result_code: number, result_name: string) {
		super(`${call} failed: ${result_name} (${result_code})`);
		this.call = call;
		this.result_code = result_code;
		this.result_name = result_name;
	}
}

/**
 * A handle was used after `dispose()` freed it. Thrown instead of passing the
 * freed pointer to the library.
 */
export class GhosttyDisposedError extends Error {
	override name = 'GhosttyDisposedError';
}

/**
 * A terminal method that mutates it was called while the terminal was busy in
 * a library call — from an effect handler, which runs in the middle of
 * `GhosttyTerminal.write` (or `resize`). The library isn't reentrant and
 * doesn't check, so the binding refuses instead of corrupting the parse.
 */
export class GhosttyReentrancyError extends Error {
	override name = 'GhosttyReentrancyError';
}

/**
 * An effect handler threw while the library was calling it. The binding
 * catches the exception inside the callback — it must never unwind through
 * the library's frames — lets the call finish, and then throws this from the
 * method that made the call (`GhosttyTerminal.write` or `resize`), which did
 * complete: all the output was written.
 */
export class GhosttyEffectError extends Error {
	override name = 'GhosttyEffectError';

	/** The effect whose handler threw first, such as `write_pty`. */
	readonly effect: string;
	/**
	 * How many handler calls threw during the one method call, the first
	 * included; only the first exception is kept, as `cause`.
	 */
	readonly thrown_count: number;

	constructor(effect: string, cause: unknown, thrown_count: number) {
		const more = thrown_count > 1 ? ` (and ${thrown_count - 1} more handler calls threw)` : '';
		super(`the ${effect} effect handler threw${more}: ${to_message(cause)}`, { cause });
		this.effect = effect;
		this.thrown_count = thrown_count;
	}
}

/**
 * A thrown value's message, for an error built from it. Total: a value with
 * no usable message (`Object.create(null)`, a throwing `toString` or
 * `message` getter, a revoked proxy) can't make building the error throw
 * and lose the value.
 */
const to_message = (value: unknown): string => {
	try {
		// `message` is typed a string, but a subclass or a getter can make it anything
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
		return value instanceof Error ? String(value.message) : String(value);
	} catch {
		return 'a value that has no message';
	}
};

/**
 * A call into a libghostty-vt instance that an exception escaped from
 * earlier — a trap, or the JS stack running out inside its frames or at a
 * callback boundary. The unwind skipped the frames' epilogues: the stack
 * pointer kept in linear memory stays moved, the write it abandoned left a
 * terminal mid-parse, and it may have landed mid-allocation in the heap every
 * handle shares. Nothing on the instance can be trusted, so every later call
 * is refused before it enters wasm. Load a fresh instance (from the same
 * compiled module, if it's kept).
 */
export class GhosttyPoisonedError extends Error {
	override name = 'GhosttyPoisonedError';

	/** The refused call, such as `ghostty_terminal_vt_write`. */
	readonly call: string;
	/** The export the first exception escaped from. */
	readonly escaped_call: string;

	/**
	 * @param call - the refused call
	 * @param escaped_call - the export the first exception escaped from
	 * @param cause - that exception
	 */
	constructor(call: string, escaped_call: string, cause: unknown) {
		super(
			`${call} refused: an exception escaped ${escaped_call} earlier (${to_message(cause)}), so the libghostty-vt instance is in an undefined state — load a fresh one`,
			{ cause }
		);
		this.call = call;
		this.escaped_call = escaped_call;
	}
}
