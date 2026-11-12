/**
 * A libghostty-vt terminal: the emulator's screen, scrollback, and modes,
 * fed program output as bytes and read back as text, and telling its host
 * what the output asks for through the effects it registers.
 *
 * Nothing here draws or takes input (`GhosttyKeyEncoder` turns keys into
 * bytes for the PTY). A query in the output (cursor position,
 * device attributes) is answered only through a registered `write_pty`
 * effect — with none, it gets no reply. No clipboard effect exists.
 *
 * @module
 */

import {
	GHOSTTY_TERMINAL_EFFECTS,
	resolve_ghostty_effect_constants,
	type GhosttyTerminalEffectHandlers,
	type GhosttyTerminalEffectName
} from './ghostty_effects.ts';
import {
	GhosttyDisposedError,
	GhosttyEffectError,
	GhosttyManifestError,
	GhosttyReentrancyError
} from './ghostty_errors.ts';
import type { GhosttyManifest, GhosttyScalar } from './ghostty_manifest.ts';
import { GhosttyMemory, to_ghostty_integer } from './ghostty_memory.ts';
import type { GhosttyVt } from './ghostty_vt.ts';

/**
 * The largest width or height, in cells, a terminal may have. The C API takes
 * any `uint16_t`, but the screen is allocated up front and wasm memory never
 * shrinks: at 16000 × 16000 a terminal takes about 3 GB, and a failed create
 * or resize near the `uint16_t` limit leaves about 4 GB grown for good. At
 * this cap, a full screen of styled text — created, formatted, resized —
 * takes tens of MB, and it's still far wider and taller than any real
 * viewport, so a bad cell measurement is refused rather than obeyed.
 */
export const GHOSTTY_TERMINAL_MAX_SIZE = 2048;

/** How a new terminal is sized and how much history it keeps. */
export interface GhosttyTerminalOptions {
	/** Width in cells, from 1 to `GHOSTTY_TERMINAL_MAX_SIZE`. */
	cols: number;
	/** Height in cells, from 1 to `GHOSTTY_TERMINAL_MAX_SIZE`. */
	rows: number;
	/**
	 * The most scrollback memory to keep, in bytes; `Infinity` keeps all.
	 * Pruned in whole pages, so the history kept is somewhat more. Defaults
	 * to the library's small limit.
	 */
	scrollback_max_bytes?: number;
	/**
	 * The most scrollback lines to keep; `Infinity` keeps all. Approximate,
	 * pruned in whole pages like the byte limit, whichever is reached first.
	 * Defaults to no line limit.
	 */
	scrollback_max_lines?: number;
	/**
	 * Modes to start with, each set as its reset default too
	 * (`GHOSTTY_TERMINAL_OPT_MODE_DEFAULT`), so a full reset (RIS) restores
	 * it rather than the library's default. A program can still change one,
	 * as any mode.
	 */
	modes?: ReadonlyArray<GhosttyTerminalMode>;
}

/**
 * A terminal mode and the value it starts with: a DEC private mode
 * (`CSI ? n h`) unless `ansi`.
 */
export interface GhosttyTerminalMode {
	/** The mode's number, from 0 to 32767. */
	mode: number;
	/** Whether it's an ANSI mode (`CSI n h`) rather than a DEC private one. */
	ansi?: boolean;
	value: boolean;
}

/** DEC private mode 2027, grapheme clustering: a multi-code-point grapheme takes one cell. */
export const GHOSTTY_MODE_GRAPHEME_CLUSTER = 2027;

/** The manifest constants for setting a mode default, resolved once per module and only when used. */
export interface GhosttyModeConstants {
	/** `GHOSTTY_TERMINAL_OPT_MODE_DEFAULT`. */
	option_mode_default: number;
	/** `GhosttyTerminalModeConfig`'s size and its fields' offsets. */
	config_size: number;
	mode_offset: number;
	value_offset: number;
}

/**
 * Resolve the mode-default constants from a manifest: the option takes a
 * `GhosttyTerminalModeConfig`, a `GhosttyMode` (a `u16`) and a `bool`.
 *
 * @throws GhosttyManifestError when an entry is missing or reshaped
 */
export const resolve_ghostty_mode_constants = (manifest: GhosttyManifest): GhosttyModeConstants => {
	const key = manifest.enum_key('GhosttyTerminalOption', 'MODE_DEFAULT', 'in');
	if (key.type !== 'GhosttyTerminalModeConfig') {
		throw new GhosttyManifestError(
			`the MODE_DEFAULT option takes a ${key.type}, not a GhosttyTerminalModeConfig`
		);
	}
	const mode = manifest.struct_field('GhosttyTerminalModeConfig', 'mode');
	const value = manifest.struct_field('GhosttyTerminalModeConfig', 'value');
	const mode_scalar =
		mode.type === 'GhosttyMode' ? manifest.type_entry('GhosttyMode', 'alias').type : mode.type;
	if (mode_scalar !== 'u16' || mode.size !== 2) {
		throw new GhosttyManifestError('GhosttyTerminalModeConfig.mode is not a u16');
	}
	if (manifest.scalar(value.type) !== 'bool' || value.size !== 1) {
		throw new GhosttyManifestError('GhosttyTerminalModeConfig.value is not a bool');
	}
	return {
		option_mode_default: manifest.enum_value('GhosttyTerminalOption', 'MODE_DEFAULT'),
		config_size: manifest.struct_size('GhosttyTerminalModeConfig'),
		mode_offset: mode.offset,
		value_offset: value.offset
	};
};

/** A new size for a terminal. */
export interface GhosttyTerminalResizeOptions {
	/** Width in cells, from 1 to `GHOSTTY_TERMINAL_MAX_SIZE`. */
	cols: number;
	/** Height in cells, from 1 to `GHOSTTY_TERMINAL_MAX_SIZE`. */
	rows: number;
	/** A cell's width in pixels, for size reports and image protocols. Defaults to 0. */
	cell_width_px?: number;
	/** A cell's height in pixels, for size reports and image protocols. Defaults to 0. */
	cell_height_px?: number;
}

/** How `GhosttyTerminal.format_text` renders the screen. */
export interface GhosttyFormatTextOptions {
	/**
	 * Join rows the terminal soft-wrapped into the one line the program
	 * wrote, as a copy would. Defaults to `true`; `false` gives one line
	 * per row.
	 */
	unwrap?: boolean;
	/** Trim trailing spaces from each line. Defaults to `true`. */
	trim?: boolean;
}

/** The manifest constants a terminal uses, resolved once per module. */
export interface GhosttyTerminalConstants {
	/** `GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES`. */
	option_scrollback_max_bytes: number;
	/** `GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES`. */
	option_scrollback_max_lines: number;
	/** The value type of both scrollback options (`size_t`). */
	scrollback_scalar: GhosttyScalar;
	/** `GHOSTTY_FORMATTER_OPT_EMIT`. */
	formatter_option_emit: number;
	/** `GHOSTTY_FORMATTER_OPT_UNWRAP`. */
	formatter_option_unwrap: number;
	/** `GHOSTTY_FORMATTER_OPT_TRIM`. */
	formatter_option_trim: number;
	/** The value type of the `EMIT` option (`GhosttyFormatterFormat`). */
	formatter_emit_scalar: GhosttyScalar;
	/** The value type of the `UNWRAP` and `TRIM` options (`bool`). */
	formatter_bool_scalar: GhosttyScalar;
	/** `GHOSTTY_FORMATTER_FORMAT_PLAIN`. */
	formatter_format_plain: number;
}

/**
 * Resolve a terminal's constants from a manifest.
 *
 * @throws GhosttyManifestError when an entry is missing or reshaped
 */
export const resolve_ghostty_terminal_constants = (
	manifest: GhosttyManifest
): GhosttyTerminalConstants => {
	const scrollback_bytes_key = manifest.enum_key(
		'GhosttyTerminalOption',
		'SCROLLBACK_MAX_BYTES',
		'in'
	);
	const scrollback_lines_key = manifest.enum_key(
		'GhosttyTerminalOption',
		'SCROLLBACK_MAX_LINES',
		'in'
	);
	const scrollback_scalar = manifest.scalar(scrollback_bytes_key.type);
	if (manifest.scalar(scrollback_lines_key.type) !== scrollback_scalar) {
		throw new GhosttyManifestError('the scrollback options have different value types');
	}
	const unwrap_scalar = manifest.scalar(
		manifest.enum_key('GhosttyFormatterOption', 'UNWRAP', 'in').type
	);
	const trim_scalar = manifest.scalar(
		manifest.enum_key('GhosttyFormatterOption', 'TRIM', 'in').type
	);
	if (unwrap_scalar !== 'bool' || trim_scalar !== 'bool') {
		throw new GhosttyManifestError('the formatter UNWRAP and TRIM options are not bools');
	}
	return {
		option_scrollback_max_bytes: manifest.enum_value(
			'GhosttyTerminalOption',
			'SCROLLBACK_MAX_BYTES'
		),
		option_scrollback_max_lines: manifest.enum_value(
			'GhosttyTerminalOption',
			'SCROLLBACK_MAX_LINES'
		),
		scrollback_scalar,
		formatter_option_emit: manifest.enum_value('GhosttyFormatterOption', 'EMIT'),
		formatter_option_unwrap: manifest.enum_value('GhosttyFormatterOption', 'UNWRAP'),
		formatter_option_trim: manifest.enum_value('GhosttyFormatterOption', 'TRIM'),
		formatter_emit_scalar: manifest.scalar(
			manifest.enum_key('GhosttyFormatterOption', 'EMIT', 'in').type
		),
		formatter_bool_scalar: unwrap_scalar,
		formatter_format_plain: manifest.enum_value('GhosttyFormatterFormat', 'PLAIN')
	};
};

/**
 * Output is copied into the terminal's write buffer and written in chunks of
 * at most this many bytes, so the buffer never needs to be larger. The parser
 * is a stream, so where a chunk ends — mid-sequence, mid-character — doesn't
 * matter.
 */
const WRITE_CHUNK_BYTES = 64 * 1024;
/** The write buffer's first size; it doubles as needed, up to `WRITE_CHUNK_BYTES`. */
const WRITE_BUFFER_MIN_BYTES = 4 * 1024;
/**
 * The most UTF-16 code units of a string encoded into one chunk: each takes
 * at most 3 bytes of UTF-8 (a surrogate pair, 2 units, takes 4).
 */
const WRITE_CHUNK_CODE_UNITS = Math.floor(WRITE_CHUNK_BYTES / 3);

const U32_MAX = 0xffff_ffff;

/** The first effect handler exception during one library call, and how many threw. */
interface EffectFailure {
	effect: GhosttyTerminalEffectName;
	error: unknown;
	count: number;
}

const utf8_encoder = new TextEncoder();

/**
 * A handle made over a terminal that must be freed before it — a
 * `GhosttyRenderState`, a `GhosttyKeyEncoder`. `GhosttyTerminal.dispose`
 * disposes each one still registered, first, so the order can't be got wrong.
 *
 * @internal
 */
export interface GhosttyTerminalDependent {
	/** Free the handle; total and idempotent, and it unregisters itself. */
	dispose(): void;
}

/**
 * A terminal emulator instance in a `GhosttyVt` module's memory.
 *
 * Its handle and the formatter it reads text through are freed by
 * `GhosttyTerminal.dispose`, which nothing does for you: call it when the
 * terminal is done with. Any use after that throws `GhosttyDisposedError`.
 *
 * Handles made over it — a `GhosttyRenderState`, a `GhosttyKeyEncoder` — are
 * disposed with it, first.
 *
 * Effect handlers (`GhosttyTerminal.set_effect`) run inside `write` and
 * `resize`, while the library is mid-parse. From a handler the terminal can
 * be read (`format_text`, `disposed`, a `GhosttyRenderState` of it updated),
 * but `write`, `resize`, `dispose`, and
 * `set_effect` throw `GhosttyReentrancyError`: the library isn't reentrant
 * and doesn't check. A handler's exception is caught inside the callback,
 * the call finishes, and the call then throws a `GhosttyEffectError` with the
 * first exception as its `cause`. An exception that escapes the library
 * anyway (a trap, the JS stack running out) poisons the instance
 * (`GhosttyVt.poisoned`): every method then throws `GhosttyPoisonedError`,
 * and `dispose` frees nothing.
 */
export class GhosttyTerminal {
	/** The module the terminal lives in. */
	readonly vt: GhosttyVt;

	readonly #constants: GhosttyTerminalConstants;
	/** The terminal handle; `0` once disposed. */
	#ptr: number;
	/** The plain-text formatter, made on first use; `0` when there's none. */
	#formatter = 0;
	/** The formatter's `UNWRAP` and `TRIM` as last set; `null` until then. */
	#formatter_unwrap: boolean | null = null;
	#formatter_trim: boolean | null = null;
	/**
	 * Scratch for `GhosttyTerminal.write`, kept between writes since output
	 * arrives as many small messages; `0` when there's none.
	 */
	#write_buffer = 0;
	/** The write buffer's allocated length. */
	#write_buffer_len = 0;
	/** Whether the effect router routes to this terminal: detached at dispose only if so. */
	#attached = false;
	/** The registered effect handlers; an effect is registered with the library exactly while it has one. */
	#handlers: Partial<GhosttyTerminalEffectHandlers> = {};
	/** Whether a library call that can fire effects is running: a call now comes from a handler. */
	#busy = false;
	/** The first handler exception of the running call, and how many threw. */
	#effect_failure: EffectFailure | null = null;
	/** The handles made over this terminal, disposed before it. */
	readonly #dependents: Set<GhosttyTerminalDependent> = new Set();

	/**
	 * Create a terminal.
	 *
	 * @throws RangeError when a size is over `GHOSTTY_TERMINAL_MAX_SIZE`, a
	 *   limit doesn't fit its C type, or a mode number is out of range
	 * @throws GhosttyManifestError when `modes` is given and the manifest
	 *   lacks the mode option or reshapes its struct
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyResultError when the library refuses the options (a zero
	 *   size is `INVALID_VALUE`)
	 */
	constructor(vt: GhosttyVt, options: GhosttyTerminalOptions) {
		vt.assert_not_poisoned('new GhosttyTerminal');
		this.vt = vt;
		this.#constants = vt.resolve(resolve_ghostty_terminal_constants);
		const cols = to_terminal_size(options.cols, 'cols');
		const rows = to_terminal_size(options.rows, 'rows');
		const size_max = vt.manifest.size_max;
		const scrollback_max_bytes = to_size_limit(
			options.scrollback_max_bytes,
			size_max,
			'scrollback_max_bytes'
		);
		const scrollback_max_lines = to_size_limit(
			options.scrollback_max_lines,
			size_max,
			'scrollback_max_lines'
		);
		const modes = options.modes ?? [];
		const mode_constants = modes.length > 0 ? vt.resolve(resolve_ghostty_mode_constants) : null;
		const packed_modes = modes.map((m) => ({ packed: to_packed_mode(m), value: m.value }));

		const { exports, memory } = vt;
		this.#ptr = memory.with_opaque((slot) => {
			vt.check(exports.ghostty_terminal_new(0, slot, cols, rows), 'ghostty_terminal_new');
			return memory.take_opaque(slot);
		});
		try {
			vt.effect_router.attach(this.#ptr, this.#receive_effect);
			this.#attached = true;
			if (scrollback_max_bytes !== undefined) {
				this.#set_scalar(
					this.#constants.option_scrollback_max_bytes,
					scrollback_max_bytes,
					'SCROLLBACK_MAX_BYTES'
				);
			}
			if (scrollback_max_lines !== undefined) {
				this.#set_scalar(
					this.#constants.option_scrollback_max_lines,
					scrollback_max_lines,
					'SCROLLBACK_MAX_LINES'
				);
			}
			if (mode_constants) {
				for (const { packed, value } of packed_modes) {
					this.#set_mode_default(mode_constants, packed, value);
				}
			}
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	/** Whether `GhosttyTerminal.dispose` has freed the terminal. */
	get disposed(): boolean {
		return this.#ptr === 0;
	}

	/**
	 * Feed program output to the terminal. A string is encoded as UTF-8 (a
	 * lone surrogate as U+FFFD). Bytes needn't end on a sequence or character
	 * boundary: the parser carries a partial one into the next write.
	 *
	 * @param data - the output; never a view of this module's own memory,
	 *   which a write can grow, detaching the view (it reads as empty); a
	 *   string is encoded on its own, so a surrogate pair split across two
	 *   writes is written as two U+FFFD — pass bytes to split mid-character
	 * @throws GhosttyEffectError when an effect handler threw — after the
	 *   whole write, every byte of which was written
	 * @throws GhosttyPoisonedError once the instance is poisoned
	 *   (`GhosttyVt.poisoned`), or when a call made during the write — a
	 *   handler's, say — poisoned it: that wins over a handler's exception,
	 *   which is dropped. An exception escaping this write's own call into the
	 *   module propagates as itself, having poisoned the instance.
	 * @throws GhosttyReentrancyError from an effect handler
	 * @throws GhosttyDisposedError after `dispose`
	 */
	write(data: Uint8Array | string): void {
		const terminal = this.#idle('write');
		if (data.length === 0) return;
		this.#with_effects('write', () => this.#write(terminal, data));
	}

	#write(terminal: number, data: Uint8Array | string): void {
		const { exports, memory } = this.vt;
		// effect handlers run inside `ghostty_terminal_vt_write` and can grow
		// memory (by reading the title, or writing to another terminal), so
		// each chunk's view is taken after the previous call and dropped
		// before this one
		if (typeof data === 'string') {
			const buffer = this.#ensure_write_buffer(Math.min(data.length * 3, WRITE_CHUNK_BYTES));
			for (let start = 0; start < data.length;) {
				let end = Math.min(start + WRITE_CHUNK_CODE_UNITS, data.length);
				// never end a chunk between the halves of a surrogate pair
				if (end < data.length && is_high_surrogate(data.charCodeAt(end - 1))) end--;
				// the view is taken after the last call that can grow memory
				const destination = memory.bytes().subarray(buffer, buffer + this.#write_buffer_len);
				const piece = start === 0 && end === data.length ? data : data.slice(start, end);
				const { read, written } = utf8_encoder.encodeInto(piece, destination);
				// the buffer holds 3 bytes per code unit, so a piece always fits whole
				if (read !== piece.length) throw new Error('a write chunk did not fit its buffer');
				exports.ghostty_terminal_vt_write(terminal, buffer, written);
				// a handler's nested call poisoned the instance: the rest is abandoned
				if (this.vt.poisoned) return;
				start = end;
			}
			return;
		}
		const buffer = this.#ensure_write_buffer(Math.min(data.length, WRITE_CHUNK_BYTES));
		for (let offset = 0; offset < data.length; offset += WRITE_CHUNK_BYTES) {
			const chunk = data.subarray(offset, offset + WRITE_CHUNK_BYTES);
			memory.write_bytes(buffer, chunk);
			exports.ghostty_terminal_vt_write(terminal, buffer, chunk.length);
			if (this.vt.poisoned) return;
		}
	}

	/**
	 * Resize the terminal. The primary screen reflows soft-wrapped lines to
	 * the new width; the alternate screen doesn't.
	 *
	 * @throws RangeError when a size is over `GHOSTTY_TERMINAL_MAX_SIZE` or a
	 *   pixel size doesn't fit its C type
	 * @throws GhosttyResultError when the library refuses it (a zero size is `INVALID_VALUE`)
	 * @throws GhosttyEffectError when an effect handler threw (a resize can
	 *   send a size report through `write_pty`) — after the resize
	 * @throws GhosttyPoisonedError once the instance is poisoned
	 *   (`GhosttyVt.poisoned`), or when a call made during the resize poisoned
	 *   it, as for `write`
	 * @throws GhosttyReentrancyError from an effect handler
	 * @throws GhosttyDisposedError after `dispose`
	 */
	resize(options: GhosttyTerminalResizeOptions): void {
		const terminal = this.#idle('resize');
		const cols = to_terminal_size(options.cols, 'cols');
		const rows = to_terminal_size(options.rows, 'rows');
		const cell_width_px = to_ghostty_integer(
			options.cell_width_px ?? 0,
			0,
			U32_MAX,
			'cell_width_px'
		);
		const cell_height_px = to_ghostty_integer(
			options.cell_height_px ?? 0,
			0,
			U32_MAX,
			'cell_height_px'
		);
		// a u32 above 2^31 reaches the i32 parameter with the same bits (ToInt32)
		const result = this.#with_effects('resize', () =>
			this.vt.exports.ghostty_terminal_resize(terminal, cols, rows, cell_width_px, cell_height_px)
		);
		this.vt.check(result, 'ghostty_terminal_resize');
	}

	/**
	 * Register a handler for an effect, replacing any it has, or clear it with
	 * `null` — after which the library ignores what fires it (a query goes
	 * unanswered). See `GhosttyTerminalEffectHandlers` for each effect and
	 * the rules a handler runs under.
	 *
	 * @throws TypeError when `handler` is neither a function nor `null`
	 * @throws GhosttyResultError when the library refuses the registration
	 * @throws GhosttyManifestError when the manifest lacks the effects' entries
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyReentrancyError from an effect handler
	 * @throws GhosttyDisposedError after `dispose`
	 */
	set_effect<TName extends GhosttyTerminalEffectName>(
		effect: TName,
		handler: GhosttyTerminalEffectHandlers[TName] | null
	): void {
		const terminal = this.#idle('set_effect');
		if (handler !== null && typeof handler !== 'function') {
			throw new TypeError(`the ${effect} handler must be a function or null`);
		}
		const { option } = this.vt.resolve(resolve_ghostty_effect_constants).effects[effect];
		const registered = this.#handlers[effect] !== undefined;
		const call = `ghostty_terminal_set(${GHOSTTY_TERMINAL_EFFECTS[effect].option})`;
		if (handler === null) {
			if (!registered) return;
			// a callback is passed by value, so NULL — 0 — clears it
			this.vt.check(this.vt.exports.ghostty_terminal_set(terminal, option, 0), call);
			this.#handlers[effect] = undefined;
			return;
		}
		if (!registered) {
			// the function pointer is the effect's shared trampoline slot, passed by value
			const index = this.vt.effect_router.callback_index(effect);
			this.vt.check(this.vt.exports.ghostty_terminal_set(terminal, option, index), call);
		}
		this.#handlers[effect] = handler;
	}

	/**
	 * The active screen as plain text, scrollback included: each line ends in
	 * `\n` except the last, and blank lines at the end are dropped.
	 *
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyResultError when the module lacks the formatter feature (`UNSUPPORTED`)
	 * @throws GhosttyDisposedError after `dispose`
	 */
	format_text(options?: GhosttyFormatTextOptions): string {
		this.#live('format_text');
		const formatter = this.#plain_formatter();
		const unwrap = options?.unwrap ?? true;
		const trim = options?.trim ?? true;
		const constants = this.#constants;
		if (unwrap !== this.#formatter_unwrap) {
			this.#set_formatter_option(
				formatter,
				constants.formatter_option_unwrap,
				unwrap ? 1 : 0,
				'UNWRAP'
			);
			this.#formatter_unwrap = unwrap;
		}
		if (trim !== this.#formatter_trim) {
			this.#set_formatter_option(formatter, constants.formatter_option_trim, trim ? 1 : 0, 'TRIM');
			this.#formatter_trim = trim;
		}
		const { exports, memory } = this.vt;
		const usize = this.vt.manifest.usize_scalar;
		return memory.with_opaque((out_ptr) =>
			memory.with_scratch(GhosttyMemory.scalar_size(usize), (out_len) => {
				this.vt.check(
					exports.ghostty_formatter_format_alloc(formatter, 0, out_ptr, out_len),
					'ghostty_formatter_format_alloc'
				);
				// the library's own allocation (NULL when empty): freed with
				// `ghostty_free`, never `ghostty_wasm_free`
				const ptr = memory.take_opaque(out_ptr);
				const len = memory.read_scalar(out_len, usize);
				try {
					return memory.read_utf8(ptr, len);
				} finally {
					// skipped once poisoned, so the exception that did it propagates
					if (!this.vt.poisoned) exports.ghostty_free(0, ptr, len);
				}
			})
		);
	}

	/**
	 * The terminal handle, for a handle of the binding's own made over this
	 * terminal (`GhosttyRenderState`, `GhosttyKeyEncoder`) to pass to the library. Never keep it:
	 * it's freed with the terminal.
	 *
	 * @param caller - the method asking, for the errors
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyDisposedError after `dispose`
	 * @internal
	 */
	handle(caller: string): number {
		if (this.#ptr === 0) {
			throw new GhosttyDisposedError(`${caller} called after its terminal was disposed`);
		}
		this.vt.assert_not_poisoned(caller);
		return this.#ptr;
	}

	/**
	 * Register a handle that must be freed before this terminal;
	 * `GhosttyTerminal.dispose` disposes it first.
	 *
	 * @throws GhosttyDisposedError after `dispose`
	 * @internal
	 */
	add_dependent(dependent: GhosttyTerminalDependent): void {
		if (this.#ptr === 0) {
			throw new GhosttyDisposedError('GhosttyTerminal.add_dependent called after dispose');
		}
		this.#dependents.add(dependent);
	}

	/**
	 * Unregister a handle `GhosttyTerminal.add_dependent` registered, once it
	 * has freed itself. Unknown ones are ignored.
	 *
	 * @internal
	 */
	remove_dependent(dependent: GhosttyTerminalDependent): void {
		this.#dependents.delete(dependent);
	}

	/**
	 * Free the terminal, the formatter it reads through, and its write buffer
	 * — its dependents first: each `GhosttyRenderState` and `GhosttyKeyEncoder`
	 * made over it is disposed before anything of the terminal's is freed. Idempotent; any
	 * other use afterward throws `GhosttyDisposedError`.
	 *
	 * The terminal is detached from effect dispatch before anything is freed.
	 * Its library-side effect registrations aren't cleared one by one: they
	 * live in the terminal, which `ghostty_terminal_free` releases whole, and
	 * nothing can fire them once the handle is gone.
	 *
	 * On a poisoned instance (`GhosttyVt.poisoned`) nothing is freed — no
	 * call goes into the module — and the handles are just dropped: the
	 * memory goes with the instance. That never throws.
	 *
	 * @throws GhosttyReentrancyError from an effect handler: the terminal is
	 *   mid-write, and freeing it would pull it out from under the parser
	 */
	dispose(): void {
		if (this.#busy) throw this.#reentrancy_error('dispose');
		if (this.#ptr === 0) return;
		// dependents first, while the terminal they were made over is whole;
		// each one's dispose unregisters it, and none throws
		for (const dependent of [...this.#dependents]) dependent.dispose();
		this.#dependents.clear();
		const terminal = this.#ptr;
		const formatter = this.#formatter;
		const write_buffer = this.#write_buffer;
		const write_buffer_len = this.#write_buffer_len;
		// cleared before the frees, so nothing can free a handle twice
		this.#ptr = 0;
		this.#formatter = 0;
		this.#write_buffer = 0;
		this.#write_buffer_len = 0;
		this.#handlers = {};
		if (this.#attached) {
			this.#attached = false;
			this.vt.effect_router.detach(terminal);
		}
		if (this.vt.poisoned) return;
		const { exports, memory } = this.vt;
		if (formatter !== 0) exports.ghostty_formatter_free(formatter);
		if (write_buffer !== 0) memory.free(write_buffer, write_buffer_len);
		exports.ghostty_terminal_free(terminal);
	}

	/**
	 * The write buffer, grown to at least `len` bytes (doubling, up to
	 * `WRITE_CHUNK_BYTES`). Growing frees the old buffer first and can grow
	 * linear memory, so take views after this.
	 */
	#ensure_write_buffer(len: number): number {
		if (this.#write_buffer_len >= len) return this.#write_buffer;
		const new_len = Math.min(
			WRITE_CHUNK_BYTES,
			Math.max(len, WRITE_BUFFER_MIN_BYTES, this.#write_buffer_len * 2)
		);
		const { memory } = this.vt;
		if (this.#write_buffer !== 0) {
			const old = this.#write_buffer;
			const old_len = this.#write_buffer_len;
			this.#write_buffer = 0;
			this.#write_buffer_len = 0;
			memory.free(old, old_len);
		}
		this.#write_buffer = memory.alloc(new_len);
		this.#write_buffer_len = new_len;
		return this.#write_buffer;
	}

	/** The terminal handle, or a throw after `dispose` or once the instance is poisoned. */
	#live(method: string): number {
		if (this.#ptr === 0) {
			throw new GhosttyDisposedError(`GhosttyTerminal.${method} called after dispose`);
		}
		this.vt.assert_not_poisoned(`GhosttyTerminal.${method}`);
		return this.#ptr;
	}

	/**
	 * The terminal handle for a method that mutates the terminal: a throw
	 * after `dispose`, or from an effect handler.
	 */
	#idle(method: string): number {
		const terminal = this.#live(method);
		if (this.#busy) throw this.#reentrancy_error(method);
		return terminal;
	}

	#reentrancy_error(method: string): GhosttyReentrancyError {
		return new GhosttyReentrancyError(
			`GhosttyTerminal.${method} called from an effect handler, in the middle of the library call that fired it: the terminal isn't reentrant`
		);
	}

	/**
	 * Run a library call that can fire effects, marked busy. Then, if a call
	 * made during it poisoned the instance (a handler's own call, say), throw
	 * `GhosttyPoisonedError`, dropping any kept handler exception; otherwise
	 * throw the first exception a handler threw, if any. An exception out of
	 * `call` itself propagates unchanged.
	 */
	#with_effects<T>(method: string, call: () => T): T {
		// TODO: every library call that can fire effects goes through here: the
		// library's reset fires the render-hold effect, and paste encoding fires
		// `write_pty`, so binding either means guarding it the same way
		this.#effect_failure = null;
		this.#busy = true;
		let value: T;
		try {
			value = call();
		} finally {
			this.#busy = false;
		}
		// set by `#receive_effect` during the call, which narrowing can't see
		const failure = this.#effect_failure as EffectFailure | null;
		this.#effect_failure = null;
		this.vt.assert_not_poisoned(`GhosttyTerminal.${method}`);
		if (failure) {
			throw new GhosttyEffectError(failure.effect, failure.error, failure.count);
		}
		return value;
	}

	/**
	 * The router's entry: an effect fired for this terminal, inside a library
	 * call. Never throws — a handler's exception is kept for `#with_effects`.
	 * Memory views are taken here, inside the callback, and dropped before it
	 * returns. Once the instance is poisoned (by an earlier callback's call,
	 * in the same parse), no handler runs.
	 */
	readonly #receive_effect = (
		effect: GhosttyTerminalEffectName,
		args: ReadonlyArray<number>
	): void => {
		if (this.vt.poisoned) return;
		try {
			switch (effect) {
				case 'write_pty': {
					const handler = this.#handlers.write_pty;
					if (!handler) return;
					const ptr = args[0]! >>> 0;
					const len = args[1]! >>> 0;
					// borrowed until the callback returns: copied
					handler(this.vt.memory.bytes().slice(ptr, ptr + len));
					return;
				}
				case 'bell':
					this.#handlers.bell?.();
					return;
				case 'title_changed': {
					const handler = this.#handlers.title_changed;
					if (!handler) return;
					const { data_title } = this.vt.resolve(resolve_ghostty_effect_constants);
					handler(this.#read_string_data(data_title, 'TITLE'));
					return;
				}
				case 'pwd_changed': {
					const handler = this.#handlers.pwd_changed;
					if (!handler) return;
					const { data_pwd } = this.vt.resolve(resolve_ghostty_effect_constants);
					handler(this.#read_string_data(data_pwd, 'PWD'));
					return;
				}
				case 'render_hold':
					// a C `bool` arrives as an i32, 0 or 1
					this.#handlers.render_hold?.(args[0] !== 0);
					return;
			}
		} catch (error) {
			if (this.#effect_failure) this.#effect_failure.count++;
			else this.#effect_failure = { effect, error, count: 1 };
		}
	};

	/**
	 * A `GhosttyString` terminal data value, decoded as UTF-8. The library
	 * lends the bytes until its next mutating call, so they're decoded at
	 * once; the out struct is scratch, freed here.
	 */
	#read_string_data(data: number, name: string): string {
		const { exports, memory } = this.vt;
		const constants = this.vt.resolve(resolve_ghostty_effect_constants);
		const usize = this.vt.manifest.usize_scalar;
		return memory.with_scratch(constants.string_size, (out) => {
			this.vt.check(
				exports.ghostty_terminal_get(this.#ptr, data, out),
				`ghostty_terminal_get(${name})`
			);
			const ptr = memory.read_scalar(
				out + constants.string_ptr_offset,
				this.vt.manifest.pointer_scalar
			);
			const len = memory.read_scalar(out + constants.string_len_offset, usize);
			return memory.read_utf8(ptr, len);
		});
	}

	/** The plain-text formatter, created on first use. */
	#plain_formatter(): number {
		if (this.#formatter !== 0) return this.#formatter;
		const { exports, memory } = this.vt;
		const formatter = memory.with_opaque((slot) => {
			this.vt.check(
				exports.ghostty_formatter_terminal_new(0, slot, this.#ptr),
				'ghostty_formatter_terminal_new'
			);
			return memory.take_opaque(slot);
		});
		const constants = this.#constants;
		try {
			// plain is the default, set anyway so the output never depends on it;
			// `UNWRAP` and `TRIM` are set by the first `format_text`, as it asks
			memory.with_scratch(GhosttyMemory.scalar_size(constants.formatter_emit_scalar), (value) => {
				memory.write_scalar(
					value,
					constants.formatter_emit_scalar,
					constants.formatter_format_plain
				);
				this.vt.check(
					exports.ghostty_formatter_set(formatter, constants.formatter_option_emit, value),
					'ghostty_formatter_set(EMIT)'
				);
			});
		} catch (error) {
			// skipped once poisoned, so the exception that did it propagates
			if (!this.vt.poisoned) exports.ghostty_formatter_free(formatter);
			throw error;
		}
		this.#formatter = formatter;
		this.#formatter_unwrap = null;
		this.#formatter_trim = null;
		return formatter;
	}

	#set_formatter_option(formatter: number, option: number, value: number, name: string): void {
		const { exports, memory } = this.vt;
		const scalar = this.#constants.formatter_bool_scalar;
		memory.with_scratch(GhosttyMemory.scalar_size(scalar), (ptr) => {
			memory.write_scalar(ptr, scalar, value);
			this.vt.check(
				exports.ghostty_formatter_set(formatter, option, ptr),
				`ghostty_formatter_set(${name})`
			);
		});
	}

	#set_mode_default(constants: GhosttyModeConstants, packed: number, value: boolean): void {
		const { exports, memory } = this.vt;
		memory.with_scratch(constants.config_size, (ptr) => {
			memory.write_scalar(ptr + constants.mode_offset, 'u16', packed);
			memory.write_scalar(ptr + constants.value_offset, 'bool', value ? 1 : 0);
			this.vt.check(
				exports.ghostty_terminal_set(this.#ptr, constants.option_mode_default, ptr),
				'ghostty_terminal_set(MODE_DEFAULT)'
			);
		});
	}

	#set_scalar(option: number, value: number, name: string): void {
		const { exports, memory } = this.vt;
		const scalar = this.#constants.scrollback_scalar;
		memory.with_scratch(GhosttyMemory.scalar_size(scalar), (ptr) => {
			memory.write_scalar(ptr, scalar, value);
			this.vt.check(
				exports.ghostty_terminal_set(this.#ptr, option, ptr),
				`ghostty_terminal_set(${name})`
			);
		});
	}
}

/**
 * A width or height checked against `GHOSTTY_TERMINAL_MAX_SIZE`. Zero passes,
 * for the library to refuse.
 */
const to_terminal_size = (value: number, what: string): number =>
	to_ghostty_integer(value, 0, GHOSTTY_TERMINAL_MAX_SIZE, what);

/** A mode packed as `GhosttyMode`: the number in bits 0–14, the ANSI flag in bit 15 (`ghostty_mode_new`). */
const to_packed_mode = (mode: GhosttyTerminalMode): number =>
	to_ghostty_integer(mode.mode, 0, 0x7fff, 'a mode number') | (mode.ansi ? 0x8000 : 0);

const is_high_surrogate = (code_unit: number): boolean =>
	code_unit >= 0xd800 && code_unit <= 0xdbff;

/** A `size_t` limit option: `undefined` stays unset, `Infinity` is `SIZE_MAX`. */
const to_size_limit = (
	value: number | undefined,
	size_max: number,
	what: string
): number | undefined => {
	if (value === undefined) return undefined;
	if (value === Infinity) return size_max;
	return to_ghostty_integer(value, 0, size_max, what);
};
