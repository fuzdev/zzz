/**
 * Key events to the bytes a program expects: libghostty-vt's key encoder,
 * following its terminal's modes.
 *
 * A `GhosttyKeyEncoder` belongs to one terminal. It takes a plain
 * description of a key event (`GhosttyKeyInput`) — no DOM — copies the
 * terminal's input modes into the library's encoder before every encode
 * (cursor and keypad application modes, backarrow mode, the alt escape
 * prefix, modifyOtherKeys, and the Kitty keyboard protocol's flags), and
 * returns the bytes for the PTY, which may be none. So a mode a program
 * changed in output written just before a key press decides what the key
 * sends.
 *
 * @module
 */

import { GhosttyDisposedError, GhosttyLoadError, GhosttyManifestError } from './ghostty_errors.ts';
import type { GhosttyManifest } from './ghostty_manifest.ts';
import type { GhosttyTerminal, GhosttyTerminalDependent } from './ghostty_terminal.ts';
import type { GhosttyVt } from './ghostty_vt.ts';

/**
 * The bits of a `GhosttyMods` mask, `GHOSTTY_MODS_*` in the C header. They're
 * `#define`s, part of the ABI, so the type manifest doesn't carry them.
 *
 * Each `_right` bit says the modifier held is the right-hand one, and means
 * something only with its modifier's bit set.
 */
export const GHOSTTY_KEY_MODS = {
	shift: 1 << 0,
	ctrl: 1 << 1,
	alt: 1 << 2,
	super: 1 << 3,
	caps_lock: 1 << 4,
	num_lock: 1 << 5,
	shift_right: 1 << 6,
	ctrl_right: 1 << 7,
	alt_right: 1 << 8,
	super_right: 1 << 9
} as const;

/** Every bit `GHOSTTY_KEY_MODS` defines. */
const MODS_MASK = (1 << 10) - 1;

/**
 * The flags of the Kitty keyboard protocol, `GHOSTTY_KITTY_KEY_*` in the C
 * header (`#define`s, so not in the type manifest) — what a program turns on
 * with `CSI > flags u` and reads back with `CSI ? u`.
 */
export const GHOSTTY_KITTY_KEY_FLAGS = {
	disambiguate: 1 << 0,
	report_events: 1 << 1,
	report_alternates: 1 << 2,
	report_all: 1 << 3,
	report_associated: 1 << 4
} as const;

/** A key going down, auto-repeating while held, or coming up. */
export type GhosttyKeyAction = 'press' | 'repeat' | 'release';

/** One key event, as `GhosttyKeyEncoder.encode` takes it. */
export interface GhosttyKeyInput {
	action: GhosttyKeyAction;
	/**
	 * The physical key, by its `GhosttyKey` name without the prefix (`A`,
	 * `DIGIT_1`, `ARROW_UP`, `NUMPAD_END`), layout-independent: the key where
	 * `A` is on a US keyboard is `A` on any layout.
	 */
	key: string;
	/** The modifiers held, as `GHOSTTY_KEY_MODS` bits. Defaults to none. */
	mods?: number;
	/**
	 * The modifiers the layout used up to make `text` (shift, for a shifted
	 * letter), as `GHOSTTY_KEY_MODS` bits; the encoder then treats the key as
	 * unmodified by them. Meaningless without `text`. Defaults to none.
	 */
	consumed_mods?: number;
	/**
	 * The text the key produced in the current layout, before any Ctrl or Alt
	 * transformation (`a` for Ctrl+A), or `''` for none — never a control
	 * character (a function key, Enter, Tab, and Backspace have none): the
	 * encoder derives control sequences from `key` and `mods`. Defaults to `''`.
	 */
	text?: string;
	/**
	 * The code point the key makes without shift (`a` for the `A` key), or 0
	 * when unknown. Defaults to 0.
	 */
	unshifted_codepoint?: number;
	/** Whether the key is part of a composition (a dead key or an IME) in progress. Defaults to `false`. */
	composing?: boolean;
}

/** The manifest constants a key encoder uses, resolved once per module. */
export interface GhosttyKeyConstants {
	/** Each `GhosttyKey` value by name, without the prefix. */
	keys: ReadonlyMap<string, number>;
	/** Each `GhosttyKeyAction` value by action. */
	actions: Readonly<Record<GhosttyKeyAction, number>>;
	/** `GHOSTTY_OUT_OF_SPACE`. */
	out_of_space: number;
	/** `sizeof(GhosttyString)`. */
	string_size: number;
	/** The offset of `GhosttyString.ptr`. */
	string_ptr_offset: number;
	/** The offset of `GhosttyString.len` (a `size_t`). */
	string_len_offset: number;
	/** `GHOSTTY_TERMINAL_DATA_KITTY_KEYBOARD_FLAGS`, read as a `u8`. */
	data_kitty_keyboard_flags: number;
}

/**
 * Resolve a key encoder's constants from a manifest.
 *
 * @throws GhosttyManifestError when an entry is missing or reshaped
 */
export const resolve_ghostty_key_constants = (manifest: GhosttyManifest): GhosttyKeyConstants => {
	const keys = new Map<string, number>();
	for (const [name, value] of manifest.enum_values('GhosttyKey')) {
		if (name === 'MAX_VALUE') continue;
		keys.set(name, value);
	}
	if (!keys.has('UNIDENTIFIED')) {
		throw new GhosttyManifestError('the manifest has no value GhosttyKey.UNIDENTIFIED');
	}
	// the setters take these by value, as wasm `i32`s
	for (const type_name of ['GhosttyMods', 'GhosttyKey', 'GhosttyKeyAction']) {
		manifest.wasm_value_type(type_name);
	}
	const mods = manifest.type_entry('GhosttyMods', 'alias');
	if (mods.type !== 'u16') {
		throw new GhosttyManifestError(
			`the manifest's GhosttyMods is ${JSON.stringify(mods.type)}, not a u16`
		);
	}
	const ptr = manifest.struct_field('GhosttyString', 'ptr');
	const len = manifest.struct_field('GhosttyString', 'len');
	if (ptr.type !== 'pointer' || ptr.size !== manifest.abi.pointer_size) {
		throw new GhosttyManifestError("the manifest's GhosttyString.ptr is not a pointer");
	}
	if (len.type !== manifest.usize_scalar || len.size !== manifest.abi.usize_size) {
		throw new GhosttyManifestError("the manifest's GhosttyString.len is not a size_t");
	}
	const flags_key = manifest.enum_key('GhosttyTerminalData', 'KITTY_KEYBOARD_FLAGS', 'out');
	const flags_type = manifest.type_entry(flags_key.type, 'alias');
	if (flags_type.type !== 'u8') {
		throw new GhosttyManifestError(
			`the manifest's GhosttyTerminalData.KITTY_KEYBOARD_FLAGS gives ${flags_key.type}, ${JSON.stringify(flags_type.type)}, not a u8`
		);
	}
	return {
		keys,
		actions: {
			press: manifest.enum_value('GhosttyKeyAction', 'PRESS'),
			repeat: manifest.enum_value('GhosttyKeyAction', 'REPEAT'),
			release: manifest.enum_value('GhosttyKeyAction', 'RELEASE')
		},
		out_of_space: manifest.enum_value('GhosttyResult', 'OUT_OF_SPACE'),
		string_size: manifest.struct_size('GhosttyString'),
		string_ptr_offset: ptr.offset,
		string_len_offset: len.offset,
		data_kitty_keyboard_flags: manifest.enum_value('GhosttyTerminalData', 'KITTY_KEYBOARD_FLAGS')
	};
};

/**
 * The output buffer's first size. Upstream: most sequences are short, and
 * 128 bytes usually does; a longer one (a long text) grows it, once.
 */
const OUTPUT_MIN_BYTES = 128;
/** The text buffer's first size; a longer text grows it. */
const TEXT_MIN_BYTES = 64;
/** The scratch block: the `GhosttyString` the text is passed through, then the written count. */
const SCRATCH_STRING = 0;

const EMPTY_BYTES = new Uint8Array(0);

const utf8_encoder = new TextEncoder();

/**
 * libghostty-vt's key encoder for one terminal, with one reusable key event
 * and its own buffers: after the first few keys, encoding allocates nothing
 * in the module.
 *
 * Made over a terminal, it's freed by `GhosttyKeyEncoder.dispose` or with
 * its terminal, which disposes it first. Any use afterward throws
 * `GhosttyDisposedError`; on a poisoned instance (`GhosttyVt.poisoned`)
 * `encode` throws `GhosttyPoisonedError` before calling in, and `dispose`
 * frees nothing.
 *
 * A terminal may have any number of encoders — encoding reads the
 * terminal's modes and changes nothing in it — and `encode` may be called
 * from the terminal's effect handlers.
 */
// TODO: `GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT`, which the library
// reads only when built for macOS — never this module's freestanding target
export class GhosttyKeyEncoder implements GhosttyTerminalDependent {
	/** The terminal whose modes it follows. */
	readonly terminal: GhosttyTerminal;

	readonly #vt: GhosttyVt;
	readonly #constants: GhosttyKeyConstants;
	/** The encoder handle; `0` once disposed. */
	#encoder = 0;
	/** The key event handle, set again for each encode. */
	#event = 0;
	/** The scratch block: the text's `GhosttyString`, the written count, then the Kitty flags byte. */
	#scratch = 0;
	readonly #scratch_len: number;
	readonly #written_offset: number;
	/** The buffer the event's text points into, and its length. */
	#text = 0;
	#text_len = 0;
	/** The buffer the encoder writes into, and its length. */
	#output = 0;
	#output_len = 0;

	/**
	 * Create an encoder for a terminal.
	 *
	 * @throws GhosttyLoadError when the module was built without its `input_encode` feature
	 * @throws GhosttyManifestError when the manifest lacks what it reads
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyDisposedError when the terminal is disposed
	 */
	constructor(terminal: GhosttyTerminal) {
		terminal.handle('new GhosttyKeyEncoder');
		const vt = terminal.vt;
		if (!vt.has_feature('input_encode')) {
			throw new GhosttyLoadError(
				'this libghostty-vt module was built without the input_encode feature, so it has no key encoder'
			);
		}
		this.terminal = terminal;
		this.#vt = vt;
		const c = vt.resolve(resolve_ghostty_key_constants);
		this.#constants = c;
		// the string is pointer-aligned; the size_t after it is too
		this.#written_offset = Math.ceil(c.string_size / 4) * 4;
		// the written count, then the Kitty flags byte, padded to a word
		this.#scratch_len = this.#written_offset + 8;
		const { exports, memory } = vt;
		const take = (create: (slot: number) => number, name: string): number =>
			memory.with_opaque((slot) => {
				vt.check(create(slot), name);
				return memory.take_opaque(slot);
			});
		this.#encoder = take(
			(slot) => exports.ghostty_key_encoder_new(0, slot),
			'ghostty_key_encoder_new'
		);
		try {
			this.#event = take((slot) => exports.ghostty_key_event_new(0, slot), 'ghostty_key_event_new');
			this.#scratch = memory.alloc(this.#scratch_len);
			this.#text = memory.alloc(TEXT_MIN_BYTES);
			this.#text_len = TEXT_MIN_BYTES;
			this.#output = memory.alloc(OUTPUT_MIN_BYTES);
			this.#output_len = OUTPUT_MIN_BYTES;
			terminal.add_dependent(this);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	/** Whether `GhosttyKeyEncoder.dispose` has freed it (itself, or with its terminal). */
	get disposed(): boolean {
		return this.#encoder === 0;
	}

	/**
	 * The bytes a key event sends to the program, under the terminal's modes
	 * as they are now — read from the terminal first, every time. Many events
	 * send nothing: a modifier alone, a release outside the Kitty keyboard
	 * protocol's event reporting, a key in a composition.
	 *
	 * @returns the bytes, a new array the caller owns; empty for none
	 * @throws RangeError when the event isn't one the library takes: an
	 *   unknown key or action, mods outside `GHOSTTY_KEY_MODS`, a code point
	 *   out of range, text holding a C0 control or DEL (U+0000–U+001F,
	 *   U+007F), which the library would send as it is
	 * @throws GhosttyResultError when the library fails
	 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
	 * @throws GhosttyDisposedError after `dispose`, its terminal's included
	 */
	encode(input: GhosttyKeyInput): Uint8Array {
		const encoder = this.#live('encode');
		const terminal = this.terminal.handle('GhosttyKeyEncoder.encode');
		const c = this.#constants;
		if (!Object.hasOwn(c.actions, input.action)) {
			throw new RangeError(`unknown key action ${input.action}`);
		}
		const action = c.actions[input.action];
		const key = c.keys.get(input.key);
		if (key === undefined) throw new RangeError(`unknown key ${JSON.stringify(input.key)}`);
		const mods = to_mods(input.mods ?? 0, 'mods');
		const consumed_mods = to_mods(input.consumed_mods ?? 0, 'consumed_mods');
		const unshifted = input.unshifted_codepoint ?? 0;
		if (!Number.isSafeInteger(unshifted) || unshifted < 0 || unshifted > 0x10ffff) {
			throw new RangeError(`unshifted_codepoint must be a code point, got ${unshifted}`);
		}
		const text = input.text ?? '';
		if (has_control_character(text)) {
			throw new RangeError(
				`text must hold no control characters (U+0000–U+001F, U+007F), got ${JSON.stringify(text)}`
			);
		}
		const vt = this.#vt;
		const { exports } = vt;
		const event = this.#event;
		vt.check(
			exports.ghostty_key_encoder_set_from_terminal(encoder, terminal),
			'ghostty_key_encoder_set_from_terminal'
		);
		vt.check(exports.ghostty_key_event_set_action(event, action), 'ghostty_key_event_set_action');
		vt.check(exports.ghostty_key_event_set_key(event, key), 'ghostty_key_event_set_key');
		vt.check(exports.ghostty_key_event_set_mods(event, mods), 'ghostty_key_event_set_mods');
		vt.check(
			exports.ghostty_key_event_set_consumed_mods(event, consumed_mods),
			'ghostty_key_event_set_consumed_mods'
		);
		vt.check(
			exports.ghostty_key_event_set_composing(event, input.composing === true ? 1 : 0),
			'ghostty_key_event_set_composing'
		);
		vt.check(
			exports.ghostty_key_event_set_unshifted_codepoint(event, unshifted),
			'ghostty_key_event_set_unshifted_codepoint'
		);
		this.#set_text(event, text);
		const bytes = this.#encode(encoder, event);
		// the flags are read only for a chord that could be rewritten
		const classic = to_classic_ctrl_chord_bytes(input, bytes);
		if (classic !== null && this.#read_kitty_flags(terminal) === 0) return classic;
		return bytes;
	}

	/** The active screen's Kitty keyboard flags, read from the terminal. */
	#read_kitty_flags(terminal: number): number {
		const vt = this.#vt;
		const ptr = this.#scratch + this.#written_offset + 4;
		vt.check(
			vt.exports.ghostty_terminal_get(terminal, this.#constants.data_kitty_keyboard_flags, ptr),
			'ghostty_terminal_get(KITTY_KEYBOARD_FLAGS)'
		);
		return vt.memory.read_scalar(ptr, 'u8');
	}

	/**
	 * Point the event's text at the text buffer, holding `text` as UTF-8. The
	 * event doesn't copy it, so the buffer is the encoder's, reused; it's set
	 * again on every encode, so a grown buffer is never left pointed at. The
	 * C function takes the `GhosttyString` by value, which the wasm C ABI
	 * passes as a pointer to it.
	 */
	#set_text(event: number, text: string): void {
		const c = this.#constants;
		const { exports, memory } = this.#vt;
		// at most 3 bytes per UTF-16 code unit (a surrogate pair, 2 units, takes 4)
		const capacity = text.length * 3;
		if (capacity > this.#text_len) {
			const old = this.#text;
			const old_len = this.#text_len;
			// cleared first, so a failed allocation leaves nothing to free twice
			this.#text = 0;
			this.#text_len = 0;
			memory.free(old, old_len);
			const len = Math.max(capacity, old_len * 2);
			this.#text = memory.alloc(len);
			this.#text_len = len;
		}
		// views taken after the last call that could grow memory
		const bytes = memory.bytes();
		const { written } =
			text.length === 0
				? { written: 0 }
				: utf8_encoder.encodeInto(text, bytes.subarray(this.#text, this.#text + this.#text_len));
		const view = memory.view();
		const string = this.#scratch + SCRATCH_STRING;
		view.setUint32(string + c.string_ptr_offset, this.#text, true);
		view.setUint32(string + c.string_len_offset, written, true);
		this.#vt.check(exports.ghostty_key_event_set_utf8(event, string), 'ghostty_key_event_set_utf8');
	}

	/** Encode the event into the output buffer, growing it once if the library asks, and copy the bytes out. */
	#encode(encoder: number, event: number): Uint8Array {
		const c = this.#constants;
		const vt = this.#vt;
		const { exports, memory } = vt;
		const written_ptr = this.#scratch + this.#written_offset;
		let result = exports.ghostty_key_encoder_encode(
			encoder,
			event,
			this.#output,
			this.#output_len,
			written_ptr
		);
		if (result === c.out_of_space) {
			// the written count is the size needed; what's in the buffer is discarded
			const needed = memory.view().getUint32(written_ptr, true);
			const old = this.#output;
			const old_len = this.#output_len;
			this.#output = 0;
			this.#output_len = 0;
			memory.free(old, old_len);
			const len = Math.max(needed, old_len * 2);
			this.#output = memory.alloc(len);
			this.#output_len = len;
			result = exports.ghostty_key_encoder_encode(
				encoder,
				event,
				this.#output,
				this.#output_len,
				written_ptr
			);
		}
		vt.check(result, 'ghostty_key_encoder_encode');
		const written = memory.view().getUint32(written_ptr, true);
		if (written === 0) return EMPTY_BYTES;
		return memory.bytes().slice(this.#output, this.#output + written);
	}

	/**
	 * Free the encoder, its event, and its buffers. Idempotent and total; its
	 * terminal calls it first when it's disposed. On a poisoned instance
	 * nothing is freed — no call goes into the module.
	 */
	dispose(): void {
		const encoder = this.#encoder;
		if (encoder === 0) return;
		const event = this.#event;
		const scratch = this.#scratch;
		const text = this.#text;
		const text_len = this.#text_len;
		const output = this.#output;
		const output_len = this.#output_len;
		// cleared before the frees, so nothing can free a handle twice
		this.#encoder = 0;
		this.#event = 0;
		this.#scratch = 0;
		this.#text = 0;
		this.#text_len = 0;
		this.#output = 0;
		this.#output_len = 0;
		this.terminal.remove_dependent(this);
		const vt = this.#vt;
		if (vt.poisoned) return;
		const { exports, memory } = vt;
		if (event !== 0) exports.ghostty_key_event_free(event);
		if (scratch !== 0) memory.free(scratch, this.#scratch_len);
		if (text !== 0) memory.free(text, text_len);
		if (output !== 0) memory.free(output, output_len);
		exports.ghostty_key_encoder_free(encoder);
	}

	#live(method: string): number {
		if (this.#encoder === 0) {
			throw new GhosttyDisposedError(`GhosttyKeyEncoder.${method} called after dispose`);
		}
		this.#vt.assert_not_poisoned(`GhosttyKeyEncoder.${method}`);
		return this.#encoder;
	}
}

/** The characters of the chords `to_classic_ctrl_chord_bytes` rewrites, and their C0 bytes. */
const CLASSIC_CTRL_CHORDS: Readonly<Record<string, number>> = {
	'[': 0x1b,
	i: 0x09,
	m: 0x0d,
	'@': 0x00
};

/** The character the library takes for a key whose text isn't one byte, Ctrl alone held. */
const CLASSIC_CTRL_CHORD_KEYS: Readonly<Record<string, string>> = {
	BRACKET_LEFT: '[',
	I: 'i',
	M: 'm'
};

/** The library's fixterms form after its `ESC`: `[ <code point> ; <mods> u`. */
const FIXTERMS_CSI_U_TAIL = /^\[\d+;\d+u$/;

/**
 * The classic C0 bytes for Ctrl+[, Ctrl+I, Ctrl+M, and Ctrl+@ — ESC, Tab,
 * CR, and NUL — in place of the fixterms `CSI … u` form libghostty-vt
 * encodes them as in legacy mode, or `null` to keep the library's bytes.
 *
 * This departs from the library on purpose. It keeps those four distinct
 * from Escape, Tab, Enter, and Ctrl+2 even when no keyboard protocol is on,
 * but a program that has asked for nothing — bash's readline (whose vi mode
 * takes Ctrl+[ for Escape), less, nano, a plain REPL — doesn't parse CSI u,
 * and sees junk. So the rewrite applies only to the library's legacy
 * fixterms output: the caller checks the Kitty keyboard flags are off, and
 * under xterm's modifyOtherKeys mode 2, which the C API doesn't expose, the
 * library's output is `CSI 27 ; … ~`, never this form, so it's kept as the
 * program asked. Modified Enter, Tab, and Escape keep the library's
 * sequences in every mode.
 *
 * The chord is found as the library finds the character for its other C0
 * chords: the text when it's one byte, otherwise — with Ctrl alone — the
 * physical key's US character (so German Ctrl+Ü, on the US `[` key, is
 * ESC, as Ctrl+C is ^C on a Russian layout); a capital from CapsLock is
 * lowered by the unshifted code point. The chord is Ctrl alone or with Alt
 * (Shift too for `@`, which needs it on a US layout); Ctrl+Shift+I and
 * Ctrl+Shift+M stay distinct. With Alt (not used up making the text) it's
 * ESC-prefixed, as the library prefixes its other Ctrl+Alt chords.
 *
 * @param input - the event as encoded
 * @param encoded - the library's bytes for it
 */
export const to_classic_ctrl_chord_bytes = (
	input: GhosttyKeyInput,
	encoded: Uint8Array
): Uint8Array | null => {
	if (input.action === 'release' || encoded.length > 32) return null;
	if (
		encoded[0] !== 0x1b ||
		!FIXTERMS_CSI_U_TAIL.test(String.fromCharCode(...encoded.subarray(1)))
	) {
		return null;
	}
	const { shift, ctrl, alt } = GHOSTTY_KEY_MODS;
	const mods = input.mods ?? 0;
	const text = input.text ?? '';
	const consumed = text === '' ? 0 : (input.consumed_mods ?? 0);
	// the modifiers that bind: no locks or sides, and not what made the text
	const binding = mods & (shift | ctrl | alt | GHOSTTY_KEY_MODS.super) & ~consumed;
	if ((binding & ctrl) === 0) return null;
	let unset = mods & (shift | ctrl | GHOSTTY_KEY_MODS.super);
	let char: string;
	if (utf8_encoder.encode(text).length === 1) {
		char = text;
	} else {
		const key_char = CLASSIC_CTRL_CHORD_KEYS[input.key];
		if (key_char === undefined || unset !== ctrl) return null;
		char = key_char;
	}
	if (char >= 'A' && char <= 'Z') {
		// Shift stays: Ctrl+Shift+I is its own chord
		const unshifted = input.unshifted_codepoint ?? 0;
		if (unshifted > 0 && unshifted < 0x80) char = String.fromCharCode(unshifted);
	} else {
		// Shift only made the character (`@` is Shift+2 on a US layout)
		unset &= ~shift;
	}
	const byte = CLASSIC_CTRL_CHORDS[char];
	if (byte === undefined || unset !== ctrl) return null;
	return (binding & alt) !== 0 ? new Uint8Array([0x1b, byte]) : new Uint8Array([byte]);
};

/** Whether text holds a C0 control or DEL, which `GhosttyKeyInput.text` must not. */
const has_control_character = (text: string): boolean => {
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x20 || unit === 0x7f) return true;
	}
	return false;
};

const to_mods = (value: number, what: string): number => {
	if (!Number.isSafeInteger(value) || value < 0 || (value & ~MODS_MASK) !== 0) {
		throw new RangeError(`${what} must be GHOSTTY_KEY_MODS bits, got ${value}`);
	}
	return value;
};
