/**
 * libghostty-vt's type manifest: the JSON `ghostty_type_json()` returns,
 * describing every public C type of the build it came from — enum values,
 * struct sizes and field offsets, packed bit positions, and the value type
 * behind each option key.
 *
 * The binding reads every constant and offset it uses from here rather than
 * hardcoding them, as upstream asks: the layouts are only promised for the
 * build that reports them. Each lookup validates the entry it returns and
 * throws a `GhosttyManifestError` naming it when it's missing or reshaped, so
 * a bad entry fails where it's resolved — never as an `undefined` passed to a
 * wasm call.
 *
 * @module
 */

import { GhosttyManifestError } from './ghostty_errors.ts';

/** The manifest schema version this binding reads; any other is refused. */
export const GHOSTTY_MANIFEST_SCHEMA = 1;

/** The target ABI a manifest describes. The binding reads only wasm32's. */
export interface GhosttyManifestAbi {
	target: string;
	pointer_size: number;
	usize_size: number;
	max_alignment: number;
	endian: string;
}

/** An option or data key of a key enum: which way its value goes, and its type. */
export interface GhosttyManifestKey {
	direction: 'in' | 'out';
	type: string;
}

/** A struct field's place in its struct. */
export interface GhosttyManifestField {
	offset: number;
	size: number;
	type: string;
}

/**
 * A bit field of a packed type, with its position counted from bit 0 of the
 * whole packed value — a field inside a union arm included.
 */
export interface GhosttyManifestBits {
	/** The lowest bit. */
	lsb: number;
	/** How many bits. */
	width: number;
	/** The field's type by name, such as `u21` or `GhosttyCellWide`. */
	type: string;
}

/**
 * How to read one bit field of a packed value split into two `u32` words:
 * the bits in the low word, then the bits in the high word above them.
 */
export interface GhosttyBitReader {
	lo_shift: number;
	lo_mask: number;
	hi_shift: number;
	hi_mask: number;
	/** How many of the field's bits are in the low word. */
	lo_bits: number;
}

/** A callback type: its parameters' types and its return type, by name. */
export interface GhosttyManifestCallback {
	params: ReadonlyArray<string>;
	/** The return type; `void` when there's none. */
	returns: string;
}

/**
 * How a value of a manifest type is read and written in linear memory: the
 * primitive types, and each enum as its underlying integer.
 */
export type GhosttyScalar = 'bool' | 'u8' | 'u16' | 'u32' | 'i32';

const PRIMITIVE_SCALARS: Record<string, GhosttyScalar> = {
	bool: 'bool',
	u8: 'u8',
	u16: 'u16',
	u32: 'u32',
	i32: 'i32'
};

/** The range of each integer type an enum can have underneath, as `[min, max]`. */
const INTEGER_RANGES: Record<string, readonly [number, number]> = {
	i8: [-0x80, 0x7f],
	u8: [0, 0xff],
	i16: [-0x8000, 0x7fff],
	u16: [0, 0xffff],
	i32: [-0x8000_0000, 0x7fff_ffff],
	u32: [0, 0xffff_ffff]
};

const is_record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const is_integer = (value: unknown): value is number => Number.isSafeInteger(value);

/**
 * A validated libghostty-vt type manifest. Construct it from the parsed JSON;
 * the top level (schema, ABI, version) is checked at once, and each type
 * entry when it's looked up.
 */
export class GhosttyManifest {
	/** The ABI the manifest describes: always little-endian wasm32 here. */
	readonly abi: GhosttyManifestAbi;
	/** The library version the manifest came from, such as `1.0.0`. */
	readonly library_version: string;
	/** The largest value of `size_t` on this target. */
	readonly size_max: number;
	/** How a `size_t` sits in memory on this target (`u32`: the constructor accepts only 4-byte `size_t`). */
	readonly usize_scalar: GhosttyScalar = 'u32';
	/** How a pointer sits in memory on this target (`u32`: the constructor accepts only 4-byte pointers). */
	readonly pointer_scalar: GhosttyScalar = 'u32';

	readonly #types: Record<string, unknown>;

	/**
	 * @param json - the parsed manifest
	 * @throws GhosttyManifestError when the top level isn't a schema-1
	 *   manifest for little-endian wasm32
	 */
	constructor(json: unknown) {
		if (!is_record(json)) throw new GhosttyManifestError('the manifest is not a JSON object');
		if (json.schema !== GHOSTTY_MANIFEST_SCHEMA) {
			throw new GhosttyManifestError(
				`the manifest's schema is ${JSON.stringify(json.schema)}, but this binding reads schema ${GHOSTTY_MANIFEST_SCHEMA}`
			);
		}
		const { abi } = json;
		if (
			!is_record(abi) ||
			abi.target !== 'wasm32' ||
			abi.pointer_size !== 4 ||
			abi.usize_size !== 4 ||
			abi.endian !== 'little' ||
			!is_integer(abi.max_alignment)
		) {
			throw new GhosttyManifestError(
				`the manifest's ABI is ${JSON.stringify(abi)}, but this binding reads only little-endian wasm32 (4-byte pointers and size_t)`
			);
		}
		if (typeof json.library_version !== 'string') {
			throw new GhosttyManifestError('the manifest has no library_version');
		}
		if (!is_record(json.types)) throw new GhosttyManifestError('the manifest has no types');
		this.abi = {
			target: abi.target,
			pointer_size: abi.pointer_size,
			usize_size: abi.usize_size,
			max_alignment: abi.max_alignment,
			endian: abi.endian
		};
		this.library_version = json.library_version;
		this.size_max = 2 ** (8 * abi.usize_size) - 1;
		this.#types = json.types;
	}

	/**
	 * The entry for a type, checked to be of `kind`.
	 *
	 * @throws GhosttyManifestError when the type is missing or of another kind
	 */
	type_entry(type_name: string, kind: string): Record<string, unknown> {
		const entry = this.#types[type_name];
		if (!is_record(entry)) throw new GhosttyManifestError(`the manifest has no type ${type_name}`);
		if (entry.kind !== kind) {
			throw new GhosttyManifestError(
				`the manifest's ${type_name} is a ${JSON.stringify(entry.kind)}, not a ${kind}`
			);
		}
		return entry;
	}

	/** The entry of a type with fields at offsets: a struct, or a union (every field at its own offset). */
	#layout_entry(type_name: string): Record<string, unknown> {
		const entry = this.#types[type_name];
		if (is_record(entry) && entry.kind === 'union') return entry;
		return this.type_entry(type_name, 'struct');
	}

	/**
	 * An enum's values by name (without the prefix), every one an integer in
	 * the range of the enum's underlying type — so none is truncated on its way
	 * into a wasm call.
	 *
	 * @throws GhosttyManifestError when the enum is missing, its underlying type
	 *   isn't an integer type, or a value isn't an integer in its range
	 */
	enum_values(type_name: string): ReadonlyMap<string, number> {
		const entry = this.type_entry(type_name, 'enum');
		if (!is_record(entry.values)) {
			throw new GhosttyManifestError(`the manifest's ${type_name} has no values`);
		}
		const range =
			typeof entry.underlying === 'string' ? INTEGER_RANGES[entry.underlying] : undefined;
		if (!range) {
			throw new GhosttyManifestError(
				`the manifest's ${type_name} has underlying type ${JSON.stringify(entry.underlying)}, not an integer type`
			);
		}
		const [min, max] = range;
		const values = new Map<string, number>();
		for (const [name, value] of Object.entries(entry.values)) {
			if (!is_integer(value) || value < min || value > max) {
				throw new GhosttyManifestError(
					`the manifest's ${type_name}.${name} is ${JSON.stringify(value)}, not an integer from ${min} to ${max} (${entry.underlying})`
				);
			}
			values.set(name, value);
		}
		return values;
	}

	/**
	 * One enum value, by its name without the prefix (`WRITE_PTY` for
	 * `GHOSTTY_TERMINAL_OPT_WRITE_PTY`).
	 *
	 * @throws GhosttyManifestError when the enum or the value is missing
	 */
	enum_value(type_name: string, value_name: string): number {
		const value = this.enum_values(type_name).get(value_name);
		if (value === undefined) {
			throw new GhosttyManifestError(`the manifest has no value ${type_name}.${value_name}`);
		}
		return value;
	}

	/**
	 * The keys of a key enum — the enum a `_get` / `_set` function takes —
	 * with each key's direction and value type.
	 *
	 * @throws GhosttyManifestError when the enum has no keys or a key is malformed
	 */
	enum_keys(type_name: string): ReadonlyMap<string, GhosttyManifestKey> {
		const entry = this.type_entry(type_name, 'enum');
		if (!is_record(entry.keys))
			throw new GhosttyManifestError(`the manifest's ${type_name} has no keys`);
		const keys = new Map<string, GhosttyManifestKey>();
		for (const [name, key] of Object.entries(entry.keys)) {
			if (
				!is_record(key) ||
				(key.direction !== 'in' && key.direction !== 'out') ||
				typeof key.type !== 'string'
			) {
				throw new GhosttyManifestError(
					`the manifest's key ${type_name}.${name} is ${JSON.stringify(key)}`
				);
			}
			keys.set(name, { direction: key.direction, type: key.type });
		}
		return keys;
	}

	/**
	 * One key of a key enum, checked to go in `direction`.
	 *
	 * @throws GhosttyManifestError when the key is missing or goes the other way
	 */
	enum_key(type_name: string, key_name: string, direction: 'in' | 'out'): GhosttyManifestKey {
		const key = this.enum_keys(type_name).get(key_name);
		if (!key) throw new GhosttyManifestError(`the manifest has no key ${type_name}.${key_name}`);
		if (key.direction !== direction) {
			throw new GhosttyManifestError(
				`the manifest's key ${type_name}.${key_name} is "${key.direction}", not "${direction}"`
			);
		}
		return key;
	}

	/**
	 * A struct's (or union's) size in bytes.
	 *
	 * @throws GhosttyManifestError when the struct is missing or has no integer size
	 */
	struct_size(type_name: string): number {
		const { size } = this.#layout_entry(type_name);
		if (!is_integer(size) || size <= 0) {
			throw new GhosttyManifestError(`the manifest's ${type_name} has no size`);
		}
		return size;
	}

	/**
	 * A struct field's (or union field's) offset, size, and type.
	 *
	 * @throws GhosttyManifestError when the struct or field is missing, or the
	 *   field doesn't fit in the struct
	 */
	struct_field(type_name: string, field_name: string): GhosttyManifestField {
		const size = this.struct_size(type_name);
		const { fields } = this.#layout_entry(type_name);
		const field = is_record(fields) ? fields[field_name] : undefined;
		if (
			!is_record(field) ||
			!is_integer(field.offset) ||
			!is_integer(field.size) ||
			typeof field.type !== 'string' ||
			field.offset < 0 ||
			field.size <= 0 ||
			field.offset + field.size > size
		) {
			throw new GhosttyManifestError(
				`the manifest has no usable field ${type_name}.${field_name}: ${JSON.stringify(field)}`
			);
		}
		return { offset: field.offset, size: field.size, type: field.type };
	}

	/**
	 * A bit field of a packed type (`GhosttyCell`, `GhosttyStyleFlags`), found
	 * by its path: a field name, or for a field inside a union of packed arms,
	 * the union's name, the arm's, and the field's
	 * (`['content', 'CODEPOINT', 'codepoint']`). Bit positions of packed types
	 * aren't ABI, so they're read here rather than assumed.
	 *
	 * @param path - the field's names, outermost first
	 * @throws GhosttyManifestError when the type or a step of the path is
	 *   missing, or a field isn't a positive width that fits inside what holds it
	 */
	packed_bits(type_name: string, path: ReadonlyArray<string>): GhosttyManifestBits {
		const entry = this.type_entry(type_name, 'packed');
		const size = entry.size;
		if (!is_integer(size) || size <= 0) {
			throw new GhosttyManifestError(`the manifest's packed ${type_name} has no size`);
		}
		const where = `${type_name}.${path.join('.')}`;
		// the field's container: its bits, and the range of the whole value it spans
		let bits = entry.bits;
		let base = 0;
		let limit = size * 8;
		for (let i = 0; i < path.length; i++) {
			const field = is_record(bits) ? bits[path[i]!] : undefined;
			if (
				!is_record(field) ||
				!is_integer(field.lsb) ||
				!is_integer(field.width) ||
				field.lsb < 0 ||
				field.width <= 0 ||
				base + field.lsb + field.width > limit
			) {
				throw new GhosttyManifestError(
					`the manifest has no usable bit field ${where}: ${JSON.stringify(field)}`
				);
			}
			const lsb = base + field.lsb;
			if (i === path.length - 1) {
				if (typeof field.type !== 'string') {
					throw new GhosttyManifestError(`the manifest's bit field ${where} has no type`);
				}
				return { lsb, width: field.width, type: field.type };
			}
			// a union of packed arms: the next two steps are the arm and its field
			const arm_name = path[++i];
			const arm = is_record(field.arms) && arm_name ? field.arms[arm_name] : undefined;
			if (
				field.kind !== 'union' ||
				!is_record(arm) ||
				arm.kind !== 'packed' ||
				i === path.length - 1
			) {
				throw new GhosttyManifestError(
					`the manifest has no packed arm ${type_name}.${path.slice(0, i + 1).join('.')}`
				);
			}
			bits = arm.bits;
			base = lsb;
			limit = lsb + field.width;
		}
		throw new GhosttyManifestError(`no bit field path given for ${type_name}`);
	}

	/**
	 * A callback type's parameter types and return type, by name — a pointer
	 * parameter is `pointer`, whatever it points to.
	 *
	 * @throws GhosttyManifestError when the type is missing, isn't a callback,
	 *   or a parameter or the return has no type
	 */
	callback(type_name: string): GhosttyManifestCallback {
		const entry = this.type_entry(type_name, 'callback');
		const returns = is_record(entry.return) ? entry.return.type : undefined;
		if (!Array.isArray(entry.params) || typeof returns !== 'string') {
			throw new GhosttyManifestError(
				`the manifest's callback ${type_name} has no params or return: ${JSON.stringify(entry)}`
			);
		}
		const params: Array<string> = [];
		for (const param of entry.params) {
			if (!is_record(param) || typeof param.type !== 'string') {
				throw new GhosttyManifestError(
					`the manifest's callback ${type_name} has a parameter without a type: ${JSON.stringify(param)}`
				);
			}
			params.push(param.type);
		}
		return { params, returns };
	}

	/**
	 * How a value of `type_name` passes through a wasm call: every integer
	 * type up to 32 bits, enum, opaque handle, and pointer is an `i32` (this
	 * is wasm32), and a 64-bit integer an `i64`; an alias is its target's.
	 *
	 * @throws GhosttyManifestError for any other type — a struct or union
	 *   passed by value, which the C ABI lowers to a pointer the binding
	 *   doesn't build
	 */
	wasm_value_type(type_name: string): 'i32' | 'i64' {
		const seen = new Set<string>();
		for (let name = type_name; !seen.has(name);) {
			seen.add(name);
			if (name === 'pointer' || name === 'bool' || name in INTEGER_RANGES) return 'i32';
			if (name === 'u64' || name === 'i64') return 'i64';
			const entry = this.#types[name];
			if (!is_record(entry)) throw new GhosttyManifestError(`the manifest has no type ${name}`);
			if (entry.kind === 'alias' && typeof entry.type === 'string') {
				name = entry.type;
				continue;
			}
			const passes =
				(entry.kind === 'opaque' && entry.size === this.abi.pointer_size) ||
				(entry.kind === 'enum' &&
					typeof entry.underlying === 'string' &&
					entry.underlying in INTEGER_RANGES);
			if (passes) return 'i32';
			break;
		}
		throw new GhosttyManifestError(`the manifest's ${type_name} doesn't pass as a wasm number`);
	}

	/**
	 * How a value of `type_name` sits in memory: a primitive's own scalar, or
	 * an enum's underlying integer.
	 *
	 * @throws GhosttyManifestError when the type is neither, or an enum's
	 *   underlying type isn't a 4-byte integer
	 */
	scalar(type_name: string): GhosttyScalar {
		const primitive = PRIMITIVE_SCALARS[type_name];
		if (primitive) return primitive;
		const entry = this.#types[type_name];
		if (!is_record(entry)) throw new GhosttyManifestError(`the manifest has no type ${type_name}`);
		if (entry.kind === 'enum') {
			if (entry.size === 4 && (entry.underlying === 'i32' || entry.underlying === 'u32')) {
				return entry.underlying;
			}
			throw new GhosttyManifestError(
				`the manifest's enum ${type_name} is ${JSON.stringify(entry.underlying)} of size ${JSON.stringify(entry.size)}, not a 4-byte integer`
			);
		}
		throw new GhosttyManifestError(`the manifest's ${type_name} is not a scalar type`);
	}
}

/**
 * Parse the manifest text `ghostty_type_json()` returns.
 *
 * @throws GhosttyManifestError when the text isn't JSON or isn't a manifest
 *   this binding reads
 */
export const parse_ghostty_manifest = (text: string): GhosttyManifest => {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new GhosttyManifestError('the manifest is not valid JSON', { cause: error });
	}
	return new GhosttyManifest(json);
};

/** Read a bit field of a packed `u64` held as two `u32` words. */
export const read_ghostty_bits = (lo: number, hi: number, field: GhosttyBitReader): number =>
	(((lo >>> field.lo_shift) & field.lo_mask) |
		(((hi >>> field.hi_shift) & field.hi_mask) << field.lo_bits)) >>>
	0;

/**
 * How to read a bit field of a packed `u64` from its two words.
 *
 * @throws GhosttyManifestError when it's wider than 32 bits or not inside 64
 */
export const to_ghostty_bit_reader = (
	bits: GhosttyManifestBits,
	what: string
): GhosttyBitReader => {
	if (bits.width > 32 || bits.lsb + bits.width > 64) {
		throw new GhosttyManifestError(
			`the manifest's ${what} spans bits ${bits.lsb}..${bits.lsb + bits.width}, not a field of at most 32 bits in a u64`
		);
	}
	const lo_bits = bits.lsb >= 32 ? 0 : Math.min(bits.width, 32 - bits.lsb);
	const hi_bits = bits.width - lo_bits;
	return {
		lo_shift: lo_bits === 0 ? 0 : bits.lsb,
		lo_mask: lo_bits === 32 ? 0xffff_ffff : (1 << lo_bits) - 1,
		hi_shift: lo_bits === 0 ? bits.lsb - 32 : 0,
		hi_mask: hi_bits === 0 ? 0 : hi_bits === 32 ? 0xffff_ffff : (1 << hi_bits) - 1,
		lo_bits
	};
};

/** Where a `GhosttyString` keeps its fields: a pointer to UTF-8 bytes and their length. */
export interface GhosttyStringLayout {
	/** `sizeof(GhosttyString)`. */
	string_size: number;
	/** The offset of `GhosttyString.ptr`. */
	string_ptr_offset: number;
	/** The offset of `GhosttyString.len` (a `size_t`). */
	string_len_offset: number;
}

/**
 * Resolve the `GhosttyString` layout from a manifest, checking `ptr` is a
 * pointer and `len` a `size_t`.
 *
 * @throws GhosttyManifestError when either field is missing or reshaped
 */
export const resolve_ghostty_string_layout = (manifest: GhosttyManifest): GhosttyStringLayout => {
	const ptr = manifest.struct_field('GhosttyString', 'ptr');
	const len = manifest.struct_field('GhosttyString', 'len');
	if (ptr.type !== 'pointer' || ptr.size !== manifest.abi.pointer_size) {
		throw new GhosttyManifestError("the manifest's GhosttyString.ptr is not a pointer");
	}
	if (len.type !== manifest.usize_scalar || len.size !== manifest.abi.usize_size) {
		throw new GhosttyManifestError("the manifest's GhosttyString.len is not a size_t");
	}
	return {
		string_size: manifest.struct_size('GhosttyString'),
		string_ptr_offset: ptr.offset,
		string_len_offset: len.offset
	};
};
