/**
 * The errors the libghostty-vt binding throws: a module that can't be used, a
 * type manifest missing what the binding needs, a call that returned a failing
 * `GhosttyResult`, and a handle used after it was disposed.
 *
 * Argument errors the C ABI can't represent — a column count that doesn't fit
 * its `uint16_t`, a fractional size — are `RangeError`s thrown before any call.
 *
 * @module
 */

/**
 * The wasm module can't be used: its bytes don't compile, it imports
 * something, it lacks an export the binding calls, or its manifest disagrees
 * with the library it came with.
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
