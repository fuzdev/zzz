/**
 * A libghostty-vt terminal: the emulator's screen, scrollback, and modes,
 * fed program output as bytes and read back as text.
 *
 * Nothing here draws or takes input. Queries in the output (cursor position,
 * device attributes) get no reply, since no `write_pty` effect is registered,
 * and the terminal sets no title or clipboard.
 *
 * @module
 */

import { GhosttyDisposedError, GhosttyManifestError } from './ghostty_errors.ts';
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
}

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

const utf8_encoder = new TextEncoder();

/**
 * A terminal emulator instance in a `GhosttyVt` module's memory.
 *
 * Its handle and the formatter it reads text through are freed by
 * `GhosttyTerminal.dispose`, which nothing does for you: call it when the
 * terminal is done with. Any use after that throws `GhosttyDisposedError`.
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

	/**
	 * Create a terminal.
	 *
	 * @throws RangeError when a size is over `GHOSTTY_TERMINAL_MAX_SIZE` or a
	 *   limit doesn't fit its C type
	 * @throws GhosttyResultError when the library refuses the options (a zero
	 *   size is `INVALID_VALUE`)
	 */
	constructor(vt: GhosttyVt, options: GhosttyTerminalOptions) {
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

		const { exports, memory } = vt;
		this.#ptr = memory.with_opaque((slot) => {
			vt.check(exports.ghostty_terminal_new(0, slot, cols, rows), 'ghostty_terminal_new');
			return memory.take_opaque(slot);
		});
		try {
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
	 * @throws GhosttyDisposedError after `dispose`
	 */
	write(data: Uint8Array | string): void {
		const terminal = this.#live('write');
		if (data.length === 0) return;
		const { exports, memory } = this.vt;
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
				// TODO: once effects are registered, they run inside this call and
				// must not write to or dispose this terminal
				exports.ghostty_terminal_vt_write(terminal, buffer, written);
				start = end;
			}
			return;
		}
		const buffer = this.#ensure_write_buffer(Math.min(data.length, WRITE_CHUNK_BYTES));
		for (let offset = 0; offset < data.length; offset += WRITE_CHUNK_BYTES) {
			const chunk = data.subarray(offset, offset + WRITE_CHUNK_BYTES);
			memory.write_bytes(buffer, chunk);
			exports.ghostty_terminal_vt_write(terminal, buffer, chunk.length);
		}
	}

	/**
	 * Resize the terminal. The primary screen reflows soft-wrapped lines to
	 * the new width; the alternate screen doesn't.
	 *
	 * @throws RangeError when a size is over `GHOSTTY_TERMINAL_MAX_SIZE` or a
	 *   pixel size doesn't fit its C type
	 * @throws GhosttyResultError when the library refuses it (a zero size is `INVALID_VALUE`)
	 * @throws GhosttyDisposedError after `dispose`
	 */
	resize(options: GhosttyTerminalResizeOptions): void {
		const terminal = this.#live('resize');
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
		this.vt.check(
			this.vt.exports.ghostty_terminal_resize(terminal, cols, rows, cell_width_px, cell_height_px),
			'ghostty_terminal_resize'
		);
	}

	/**
	 * The active screen as plain text, scrollback included: each line ends in
	 * `\n` except the last, and blank lines at the end are dropped.
	 *
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
					exports.ghostty_free(0, ptr, len);
				}
			})
		);
	}

	/**
	 * Free the terminal, the formatter it reads through, and its write buffer
	 * — its dependents first. Idempotent; any other use afterward throws
	 * `GhosttyDisposedError`.
	 */
	dispose(): void {
		const terminal = this.#ptr;
		if (terminal === 0) return;
		const formatter = this.#formatter;
		const write_buffer = this.#write_buffer;
		const write_buffer_len = this.#write_buffer_len;
		// cleared before the frees, so nothing can free a handle twice
		this.#ptr = 0;
		this.#formatter = 0;
		this.#write_buffer = 0;
		this.#write_buffer_len = 0;
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

	/** The terminal handle, or a throw after `dispose`. */
	#live(method: string): number {
		if (this.#ptr === 0) {
			throw new GhosttyDisposedError(`GhosttyTerminal.${method} called after dispose`);
		}
		return this.#ptr;
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
			exports.ghostty_formatter_free(formatter);
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
