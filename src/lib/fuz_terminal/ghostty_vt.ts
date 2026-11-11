/**
 * The libghostty-vt wasm module, loaded: Ghostty's terminal emulator compiled
 * to WebAssembly, under a binding that runs in Node and browsers alike — no
 * DOM, no Svelte.
 *
 * `load_ghostty_vt` takes the module's bytes (or a fetch `Response`, or a
 * compiled module) from its caller; this library never fetches an app path
 * itself. The result, a `GhosttyVt`, holds the instance, its type manifest,
 * its memory, and its build info; handles such as `GhosttyTerminal` are made
 * from it.
 *
 * @module
 */

import { GhosttyCallbackTable } from './ghostty_callback_table.ts';
import { GhosttyEffectRouter, resolve_ghostty_effect_constants } from './ghostty_effects.ts';
import {
	GhosttyLoadError,
	GhosttyManifestError,
	GhosttyPoisonedError,
	GhosttyResultError
} from './ghostty_errors.ts';
import { GhosttyManifest, parse_ghostty_manifest } from './ghostty_manifest.ts';
import { GhosttyMemory, type GhosttyMemoryExports } from './ghostty_memory.ts';

/**
 * The exports the binding calls. Every C API function is exported whatever
 * features the module was built with — one compiled out returns
 * `GHOSTTY_UNSUPPORTED` — so a module lacking one of these isn't
 * libghostty-vt. Pointers and handles are `number`s; an `i32` result above
 * 2 GiB arrives negative and is read with `>>> 0`.
 */
export interface GhosttyVtExports extends GhosttyMemoryExports {
	/** The function table a C function pointer indexes; callbacks are slots added to it. */
	__indirect_function_table: WebAssembly.Table;
	ghostty_type_json: () => number;
	ghostty_version: () => number;
	ghostty_build_info: (data: number, out: number) => number;
	ghostty_free: (allocator: number, ptr: number, len: number) => void;
	ghostty_terminal_new: (allocator: number, out: number, cols: number, rows: number) => number;
	ghostty_terminal_free: (terminal: number) => void;
	ghostty_terminal_set: (terminal: number, option: number, value: number) => number;
	ghostty_terminal_get: (terminal: number, data: number, out: number) => number;
	ghostty_terminal_vt_write: (terminal: number, data: number, len: number) => void;
	ghostty_terminal_resize: (
		terminal: number,
		cols: number,
		rows: number,
		cell_width_px: number,
		cell_height_px: number
	) => number;
	ghostty_formatter_terminal_new: (allocator: number, out: number, terminal: number) => number;
	ghostty_formatter_set: (formatter: number, option: number, value: number) => number;
	ghostty_formatter_format_alloc: (
		formatter: number,
		allocator: number,
		out_ptr: number,
		out_len: number
	) => number;
	ghostty_formatter_free: (formatter: number) => void;
	ghostty_render_state_new: (allocator: number, out: number) => number;
	ghostty_render_state_free: (state: number) => void;
	ghostty_render_state_update: (state: number, terminal: number) => number;
	ghostty_render_state_clean: (state: number) => number;
	ghostty_render_state_get: (state: number, data: number, out: number) => number;
	ghostty_render_state_get_multi: (
		state: number,
		count: number,
		keys: number,
		values: number,
		out_written: number
	) => number;
	ghostty_render_state_row_iterator_new: (allocator: number, out: number) => number;
	ghostty_render_state_row_iterator_free: (iterator: number) => void;
	/** Returns a C `bool`: 1 when it moved to a row, 0 at the end. */
	ghostty_render_state_row_iterator_next: (iterator: number) => number;
	ghostty_render_state_row_get_multi: (
		iterator: number,
		count: number,
		keys: number,
		values: number,
		out_written: number
	) => number;
	ghostty_render_state_row_cells_new: (allocator: number, out: number) => number;
	ghostty_render_state_row_cells_free: (cells: number) => void;
	ghostty_render_state_row_cells_select: (cells: number, x: number) => number;
	ghostty_render_state_row_cells_get: (cells: number, data: number, out: number) => number;
	// TODO: the input encoder exports join this list with the module that calls them
}

const REQUIRED_FUNCTIONS = [
	'ghostty_wasm_alloc',
	'ghostty_wasm_free',
	'ghostty_wasm_alloc_opaque',
	'ghostty_wasm_free_opaque',
	'ghostty_wasm_take_opaque',
	'ghostty_type_json',
	'ghostty_version',
	'ghostty_build_info',
	'ghostty_free',
	'ghostty_terminal_new',
	'ghostty_terminal_free',
	'ghostty_terminal_set',
	'ghostty_terminal_get',
	'ghostty_terminal_vt_write',
	'ghostty_terminal_resize',
	'ghostty_formatter_terminal_new',
	'ghostty_formatter_set',
	'ghostty_formatter_format_alloc',
	'ghostty_formatter_free',
	'ghostty_render_state_new',
	'ghostty_render_state_free',
	'ghostty_render_state_update',
	'ghostty_render_state_clean',
	'ghostty_render_state_get',
	'ghostty_render_state_get_multi',
	'ghostty_render_state_row_iterator_new',
	'ghostty_render_state_row_iterator_free',
	'ghostty_render_state_row_iterator_next',
	'ghostty_render_state_row_get_multi',
	'ghostty_render_state_row_cells_new',
	'ghostty_render_state_row_cells_free',
	'ghostty_render_state_row_cells_select',
	'ghostty_render_state_row_cells_get'
] as const satisfies ReadonlyArray<
	Exclude<keyof GhosttyVtExports, 'memory' | '__indirect_function_table'>
>;

/** What `load_ghostty_vt` accepts: the module's bytes, a response carrying them, or a compiled module. */
export type GhosttyVtSource = BufferSource | Response | WebAssembly.Module;

/** What a module reports about its own build (`ghostty_build_info`). */
export interface GhosttyBuildInfo {
	/** The library version, such as `1.0.0`. */
	version: string;
	/** The optimization mode by its manifest name, such as `RELEASE_SMALL`. */
	optimize: string;
	/**
	 * Whether the library's SIMD code paths — its native SIMD dependencies —
	 * are compiled in. Always `false` for wasm, whose module uses `simd128`
	 * instructions all the same.
	 */
	simd: boolean;
	/**
	 * Each optional feature the library reports, by its lowercased name
	 * (`formatter`, `render_state`, `input_encode`, `kitty_graphics`, …),
	 * and whether this build has it.
	 */
	features: ReadonlyMap<string, boolean>;
}

/**
 * The constants the core reads from the manifest, resolved and validated at load.
 */
export interface GhosttyVtConstants {
	/** `GHOSTTY_SUCCESS`. */
	success: number;
	/** `GHOSTTY_OUT_OF_MEMORY`. */
	out_of_memory: number;
	/** Every `GhosttyResult` name by code. */
	result_names: ReadonlyMap<number, string>;
}

/**
 * Resolve the core's constants from a manifest.
 *
 * @throws GhosttyManifestError when an entry is missing or reshaped
 */
export const resolve_ghostty_vt_constants = (manifest: GhosttyManifest): GhosttyVtConstants => {
	const result_names = new Map<number, string>();
	for (const [name, code] of manifest.enum_values('GhosttyResult')) {
		if (name.endsWith('MAX_VALUE')) continue;
		result_names.set(code, name);
	}
	return {
		success: manifest.enum_value('GhosttyResult', 'SUCCESS'),
		out_of_memory: manifest.enum_value('GhosttyResult', 'OUT_OF_MEMORY'),
		result_names
	};
};

/**
 * Compile and instantiate the libghostty-vt module, then read and validate
 * its manifest and build info.
 *
 * @param source - the module's bytes, a response carrying them (an
 *   unsuccessful status is refused), or a compiled module
 * @throws GhosttyLoadError when the bytes don't compile, the module imports
 *   anything, or it isn't libghostty-vt
 * @throws GhosttyManifestError when its manifest lacks what the binding reads
 */
export const load_ghostty_vt = async (source: GhosttyVtSource): Promise<GhosttyVt> => {
	// TODO: `WebAssembly.compileStreaming` for a `Response` served as `application/wasm`
	let module: WebAssembly.Module;
	if (source instanceof WebAssembly.Module) {
		module = source;
	} else {
		let bytes: BufferSource;
		if (source instanceof Response) {
			if (!source.ok) {
				throw new GhosttyLoadError(
					`can't load libghostty-vt from ${source.url || 'a response'}: ${source.status} ${source.statusText}`
				);
			}
			bytes = await source.arrayBuffer();
		} else {
			bytes = source;
		}
		try {
			module = await WebAssembly.compile(bytes);
		} catch (error) {
			throw new GhosttyLoadError('the libghostty-vt bytes are not a WebAssembly module', {
				cause: error
			});
		}
	}
	const imports = WebAssembly.Module.imports(module);
	if (imports.length > 0) {
		throw new GhosttyLoadError(
			`the module imports ${imports.map((i) => `${i.module}.${i.name}`).join(', ')}, but libghostty-vt imports nothing`
		);
	}
	return new GhosttyVt(await WebAssembly.instantiate(module, {}));
};

/**
 * Each module instance's poison, keyed by its linear memory: poison belongs
 * to the instance, so every `GhosttyVt` wrapping the same one sees it.
 */
const instance_poisons: WeakMap<WebAssembly.Memory, GhosttyVtPoison> = new WeakMap();

/** The first exception that escaped a call into an instance, which poisoned it. */
export interface GhosttyVtPoison {
	/** The export it escaped from. */
	call: string;
	/** The exception. */
	cause: unknown;
}

/**
 * A loaded libghostty-vt instance. Every handle made from it lives in its
 * linear memory; instances share nothing.
 *
 * An exception that escapes a call into the module — a trap, or the JS stack
 * running out inside its frames or at a callback boundary — unwinds past the
 * frames' epilogues, leaving the stack pointer kept in linear memory moved, a
 * write abandoned mid-parse, and possibly the shared heap mid-allocation. So
 * every function export is guarded once, here: the first escape **poisons**
 * the module instance (`GhosttyVt.poisoned`) — every `GhosttyVt` wrapping
 * it sees the same poison. The exception reaches the caller of the call it
 * escaped from unchanged (cleanup on its way out skips its calls in), and
 * every later call throws `GhosttyPoisonedError` before entering wasm. A
 * `GhosttyTerminal.write` or `resize` during which a nested call poisoned
 * the instance throws `GhosttyPoisonedError` too, and no effect handler runs
 * once it's poisoned. A stack overflow at a call's very entry poisons as
 * well, though it disturbed nothing: the guard can't tell it from one that
 * did. An effect handler's own exception doesn't escape — the terminal
 * catches it inside the callback — so it never poisons.
 */
export class GhosttyVt {
	/**
	 * The exports, for the binding's own modules: each function guarded as
	 * above, the memory, table, and globals as they are. A function that
	 * replaces an export before the instance is wrapped (a test's stand-in) is
	 * guarded the same way, so a throw from it poisons too.
	 */
	readonly exports: GhosttyVtExports;
	/** The validated type manifest. */
	readonly manifest: GhosttyManifest;
	/** Linear memory and the scratch allocator. */
	readonly memory: GhosttyMemory;
	/** The constants the core reads from the manifest. */
	readonly constants: GhosttyVtConstants;
	/** What the module reports about its build. */
	readonly build_info: GhosttyBuildInfo;
	/** The callback slots added to the module's function table. */
	readonly callbacks: GhosttyCallbackTable;
	/** The effect trampolines, and the terminals they dispatch to. */
	readonly effect_router: GhosttyEffectRouter;

	readonly #resolved: Map<(manifest: GhosttyManifest) => unknown, unknown> = new Map();
	/** The raw instance's memory, which keys its poison. */
	readonly #instance_memory: WebAssembly.Memory;

	/**
	 * Wrap an instance of the module. `load_ghostty_vt` compiles and
	 * instantiates one; use this directly for an instance made elsewhere.
	 *
	 * @throws GhosttyLoadError when the instance isn't libghostty-vt
	 * @throws GhosttyManifestError when its manifest lacks what the binding reads
	 */
	constructor(instance: WebAssembly.Instance) {
		const exports = to_ghostty_vt_exports(instance.exports);
		this.#instance_memory = exports.memory;
		this.exports = this.#guard_exports(exports);
		// the out-of-memory code is read from the manifest, which reading the
		// manifest doesn't need: nothing allocates until the constants are set
		this.memory = new GhosttyMemory(
			this.exports,
			(call) => new GhosttyResultError(call, this.constants.out_of_memory, 'OUT_OF_MEMORY'),
			() => this.poisoned !== null
		);
		this.manifest = parse_ghostty_manifest(
			this.memory.read_c_string(this.exports.ghostty_type_json() >>> 0)
		);
		this.constants = resolve_ghostty_vt_constants(this.manifest);
		const version = this.memory.read_c_string(this.exports.ghostty_version() >>> 0);
		if (version !== this.manifest.library_version) {
			throw new GhosttyLoadError(
				`the module reports version ${version}, but its manifest says ${this.manifest.library_version}`
			);
		}
		this.build_info = this.#read_build_info(version);
		this.callbacks = new GhosttyCallbackTable(this.exports.__indirect_function_table);
		this.effect_router = new GhosttyEffectRouter(this.callbacks, () =>
			this.resolve(resolve_ghostty_effect_constants)
		);
	}

	/**
	 * The first exception that escaped a call into the module instance —
	 * through this wrapper or any other of the same instance — or `null`.
	 * Once set, every call is refused (`GhosttyPoisonedError`) and the
	 * instance's handles are dropped without freeing on dispose; build a
	 * fresh instance to go on.
	 */
	get poisoned(): GhosttyVtPoison | null {
		return instance_poisons.get(this.#instance_memory) ?? null;
	}

	/**
	 * Throw unless the instance is usable — for a method about to call in,
	 * so it refuses before doing any work of its own.
	 *
	 * @param call - what is refused, for the error
	 * @throws GhosttyPoisonedError once an exception has escaped a call
	 */
	assert_not_poisoned(call: string): void {
		const poison = instance_poisons.get(this.#instance_memory);
		if (poison) throw new GhosttyPoisonedError(call, poison.call, poison.cause);
	}

	/** The library version, such as `1.0.0`. */
	get version(): string {
		return this.build_info.version;
	}

	/**
	 * Whether the module was built with an optional feature.
	 *
	 * @param name - a feature's lowercased name, as in `GhosttyBuildInfo.features`
	 * @throws GhosttyManifestError when the library knows no such feature
	 */
	has_feature(name: string): boolean {
		const has = this.build_info.features.get(name);
		if (has === undefined) {
			throw new GhosttyManifestError(
				`libghostty-vt ${this.version} has no feature "${name}" (it has ${[...this.build_info.features.keys()].join(', ')})`
			);
		}
		return has;
	}

	/**
	 * Throw unless `result` is `GHOSTTY_SUCCESS`.
	 *
	 * @param result - the `GhosttyResult` an export returned
	 * @param call - the export's name, for the error
	 * @throws GhosttyResultError naming the result
	 */
	check(result: number, call: string): void {
		if (result !== this.constants.success) {
			throw new GhosttyResultError(call, result, this.result_name(result));
		}
	}

	/** A `GhosttyResult`'s name without its prefix, or `UNKNOWN`. */
	result_name(result: number): string {
		return this.constants.result_names.get(result) ?? 'UNKNOWN';
	}

	/**
	 * The value of a constants resolver for this module's manifest, computed
	 * on first use and kept. Each module of the binding resolves its own
	 * constants this way, so a manifest missing an entry fails at that
	 * module's first use, naming it. Pass a module-level function: the cache
	 * is keyed by its identity.
	 */
	resolve<T>(resolver: (manifest: GhosttyManifest) => T): T {
		if (this.#resolved.has(resolver)) return this.#resolved.get(resolver) as T;
		const value = resolver(this.manifest);
		this.#resolved.set(resolver, value);
		return value;
	}

	/**
	 * A copy of `exports` with each function wrapped: refused once poisoned,
	 * and poisoning the instance when an exception escapes it. Every call the
	 * binding makes goes through one of these, so modules added later are
	 * covered without opting in.
	 */
	#guard_exports(exports: GhosttyVtExports): GhosttyVtExports {
		const guarded: Record<string, unknown> = {};
		const key = this.#instance_memory;
		for (const [name, value] of Object.entries(exports)) {
			if (typeof value !== 'function') {
				guarded[name] = value;
				continue;
			}
			const fn = value as (...args: Array<unknown>) => unknown;
			guarded[name] = (...args: Array<unknown>): unknown => {
				const poison = instance_poisons.get(key);
				if (poison) throw new GhosttyPoisonedError(name, poison.call, poison.cause);
				try {
					return fn(...args);
				} catch (error) {
					// a nested call's escape (from a callback) poisons first; keep that one
					if (!instance_poisons.has(key)) instance_poisons.set(key, { call: name, cause: error });
					throw error;
				}
			};
		}
		return guarded as unknown as GhosttyVtExports;
	}

	#read_build_info(version: string): GhosttyBuildInfo {
		const { manifest, memory, exports } = this;
		const keys = manifest.enum_keys('GhosttyBuildInfo');
		const read = (key_name: string): number => {
			const key = manifest.enum_key('GhosttyBuildInfo', key_name, 'out');
			const scalar = manifest.scalar(key.type);
			const data = manifest.enum_value('GhosttyBuildInfo', key_name);
			return memory.with_scratch(GhosttyMemory.scalar_size(scalar), (out) => {
				this.check(exports.ghostty_build_info(data, out), `ghostty_build_info(${key_name})`);
				return memory.read_scalar(out, scalar);
			});
		};
		const optimize_code = read('OPTIMIZE');
		const optimize_type = manifest.enum_key('GhosttyBuildInfo', 'OPTIMIZE', 'out').type;
		let optimize = 'UNKNOWN';
		for (const [name, code] of manifest.enum_values(optimize_type)) {
			if (code === optimize_code) optimize = name;
		}
		const features = new Map<string, boolean>();
		for (const [key_name, key] of keys) {
			if (key.type !== 'bool' || key_name === 'SIMD') continue;
			features.set(key_name.replace(/^FEATURE_/, '').toLowerCase(), read(key_name) !== 0);
		}
		return { version, optimize, simd: read('SIMD') !== 0, features };
	}
}

const to_ghostty_vt_exports = (exports: WebAssembly.Exports): GhosttyVtExports => {
	const missing: Array<string> = [];
	if (!(exports.memory instanceof WebAssembly.Memory)) missing.push('memory');
	for (const name of REQUIRED_FUNCTIONS) {
		if (typeof exports[name] !== 'function') missing.push(name);
	}
	if (!(exports.__indirect_function_table instanceof WebAssembly.Table)) {
		missing.push('__indirect_function_table');
	} else if (exports.__indirect_function_table.length === 0) {
		// a C module's table reserves slot 0 as the null function pointer
		throw new GhosttyLoadError("the module's function table is empty, so it isn't libghostty-vt");
	}
	if (missing.length > 0) {
		throw new GhosttyLoadError(
			`the module isn't libghostty-vt: it doesn't export ${missing.join(', ')}`
		);
	}
	return exports as unknown as GhosttyVtExports;
};
