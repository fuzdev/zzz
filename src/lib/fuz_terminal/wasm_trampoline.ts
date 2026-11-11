/**
 * Wasm functions made from JS functions, for a wasm module's function table.
 *
 * A C function pointer in a wasm module is an index into its
 * `__indirect_function_table`, and a table slot holds only a wasm function —
 * a plain JS function can't go in. `create_wasm_trampoline` makes one that
 * can: it assembles a tiny module that imports the JS function under a given
 * signature and exports it again, and the export is a wasm function wrapping
 * the import. This works in every engine, with no reliance on the
 * `WebAssembly.Function` constructor.
 *
 * The module is compiled synchronously. That's fine on a browser's main
 * thread: engines refuse a synchronous compile there only for a module over a
 * size limit of kilobytes, and a trampoline is tens of bytes. A page whose
 * Content-Security-Policy doesn't allow wasm compilation (`'wasm-unsafe-eval'`)
 * can't compile it — nor, under the same policy, the module it serves.
 *
 * @module
 */

/** A wasm number type, as a function signature names it. */
export type WasmValueType = 'i32' | 'i64' | 'f32' | 'f64';

/** A wasm function type: its parameter types, and its result types (none or one). */
export interface WasmFunctionSignature {
	params: ReadonlyArray<WasmValueType>;
	results: ReadonlyArray<WasmValueType>;
}

const VALUE_TYPE_CODES: Record<WasmValueType, number> = {
	i32: 0x7f,
	i64: 0x7e,
	f32: 0x7d,
	f64: 0x7c
};

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const SECTION_TYPE = 0x01;
const SECTION_IMPORT = 0x02;
const SECTION_EXPORT = 0x07;
const FUNCTYPE = 0x60;
const EXTERNAL_KIND_FUNCTION = 0x00;
/** The import's module and field name, and the export's name. */
const TRAMPOLINE_NAME = 'f';

const utf8_encoder = new TextEncoder();

/**
 * `value` as unsigned LEB128, the variable-length integer wasm uses for
 * counts and lengths.
 *
 * @throws RangeError when `value` isn't an integer from 0 to 2^32 - 1
 */
export const encode_unsigned_leb128 = (value: number): Array<number> => {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new RangeError(`can't encode ${value} as an unsigned 32-bit LEB128`);
	}
	const bytes: Array<number> = [];
	let rest = value;
	do {
		let byte = rest % 0x80;
		rest = Math.floor(rest / 0x80);
		if (rest !== 0) byte |= 0x80;
		bytes.push(byte);
	} while (rest !== 0);
	return bytes;
};

const encode_vector = (items: ReadonlyArray<Array<number>>): Array<number> => [
	...encode_unsigned_leb128(items.length),
	...items.flat()
];

const encode_name = (name: string): Array<number> => {
	const bytes = [...utf8_encoder.encode(name)];
	return [...encode_unsigned_leb128(bytes.length), ...bytes];
};

const encode_section = (id: number, body: Array<number>): Array<number> => [
	id,
	...encode_unsigned_leb128(body.length),
	...body
];

const encode_value_types = (types: ReadonlyArray<WasmValueType>): Array<number> =>
	encode_vector(
		types.map((type) => {
			const code = Object.hasOwn(VALUE_TYPE_CODES, type) ? VALUE_TYPE_CODES[type] : undefined;
			if (code === undefined)
				throw new TypeError(`${JSON.stringify(type)} is not a wasm value type`);
			return [code];
		})
	);

/**
 * The bytes of a module that imports one function of `signature` as `f.f`
 * and exports it as `f`: a type section, an import section, and an export
 * section, and nothing else.
 *
 * @throws RangeError when the signature has more than one result
 * @throws TypeError when a type isn't a `WasmValueType`
 */
export const encode_wasm_trampoline = (
	signature: WasmFunctionSignature
): Uint8Array<ArrayBuffer> => {
	if (signature.results.length > 1) {
		throw new RangeError('a trampoline has at most one result');
	}
	const function_type = [
		FUNCTYPE,
		...encode_value_types(signature.params),
		...encode_value_types(signature.results)
	];
	const name = encode_name(TRAMPOLINE_NAME);
	return new Uint8Array([
		...WASM_HEADER,
		...encode_section(SECTION_TYPE, encode_vector([function_type])),
		// import `f.f`: a function of type 0
		...encode_section(
			SECTION_IMPORT,
			encode_vector([[...name, ...name, EXTERNAL_KIND_FUNCTION, 0]])
		),
		// export function 0 (the import) as `f`
		...encode_section(SECTION_EXPORT, encode_vector([[...name, EXTERNAL_KIND_FUNCTION, 0]]))
	]);
};

/** Compiled trampoline modules by signature: the bytes depend on nothing else. */
const compiled_trampolines: Map<string, WebAssembly.Module> = new Map();

const to_signature_key = (signature: WasmFunctionSignature): string =>
	`${signature.params.join(',')}->${signature.results.join(',')}`;

/**
 * A wasm function that calls `fn`, for a function table slot. Arguments
 * arrive as the signature's types convert to JS (an `i64` as a `bigint`), and
 * the result converts back the same way.
 *
 * `fn` runs inside whatever wasm call invoked the slot, so an exception it
 * throws unwinds through that call's wasm frames — a caller registering it
 * with a library must make sure it never throws.
 *
 * @throws RangeError when the signature has more than one result
 */
export const create_wasm_trampoline = (
	fn: (...args: Array<any>) => unknown,
	signature: WasmFunctionSignature
): WebAssembly.ExportValue => {
	const key = to_signature_key(signature);
	let module = compiled_trampolines.get(key);
	if (!module) {
		// synchronous on purpose: the module is tens of bytes (see the module comment)
		module = new WebAssembly.Module(encode_wasm_trampoline(signature));
		compiled_trampolines.set(key, module);
	}
	const instance = new WebAssembly.Instance(module, {
		[TRAMPOLINE_NAME]: { [TRAMPOLINE_NAME]: fn }
	});
	return instance.exports[TRAMPOLINE_NAME]!;
};
