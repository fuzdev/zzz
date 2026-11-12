/**
 * A browser `KeyboardEvent` as a `GhosttyKeyInput`: the physical key from
 * `code`, the modifiers, the text the key produced, and the key's unshifted
 * code point — plus which keys the terminal leaves to the browser and the
 * OS. Pure functions over the event's own fields (`FuzTerminalKeyboardEvent`,
 * so tests pass plain objects); nothing here touches the DOM or the module.
 *
 * The unshifted code point is the key's text when the event shows it — an
 * unshifted key's own text, a shifted letter lowercased — and otherwise the
 * character the key makes on a US layout (`FUZ_TERMINAL_US_UNSHIFTED`): the
 * browser exposes no layout table every engine has. So on another layout a
 * shifted digit or punctuation key reports its US character, which the Kitty
 * keyboard protocol sends as the key's code.
 *
 * @module
 */

import {
	GHOSTTY_KEY_MODS,
	type GhosttyKeyAction,
	type GhosttyKeyInput
} from './ghostty_key_encoder.ts';
import type { GhosttyManifest } from './ghostty_manifest.ts';

/**
 * The fields of a DOM `KeyboardEvent` the mapping reads — a real event is
 * one. `getModifierState` gives the lock keys and AltGraph; without it they
 * read as off.
 */
export interface FuzTerminalKeyboardEvent {
	/** The physical key, as the UI Events `code` values name it (`KeyA`, `ArrowUp`). */
	readonly code: string;
	/** What the key means in the current layout: a character, or a key name (`Enter`, `Dead`). */
	readonly key: string;
	readonly shiftKey: boolean;
	readonly ctrlKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	/** Whether this keydown is an auto-repeat of a held key. */
	readonly repeat: boolean;
	/** Whether an IME composition is in progress. */
	readonly isComposing: boolean;
	/** The legacy key code: 229 while an IME holds the key. */
	readonly keyCode?: number;
	getModifierState?: (key: string) => boolean;
}

/**
 * The `GhosttyKey` names by the `code` values that press them — and, for the
 * numpad with NumLock off, by `code` and `key` joined with a space
 * (`Numpad1 End`), which no `code` contains.
 */
export type FuzTerminalKeyCodes = ReadonlyMap<string, string>;

/**
 * The numpad's keys with NumLock off, which libghostty-vt names apart from
 * the numpad's digits — `NUMPAD_END` for `Numpad1` — and no `code` names: a
 * browser gives the digit's `code` with the navigation key's `key`. Each is
 * mapped from that pair, never from a `code` of its own.
 */
export const FUZ_TERMINAL_NUMPAD_NAVIGATION_KEYS: Readonly<
	Record<string, Readonly<Record<string, string>>>
> = {
	Numpad0: { Insert: 'NUMPAD_INSERT' },
	Numpad1: { End: 'NUMPAD_END' },
	Numpad2: { ArrowDown: 'NUMPAD_DOWN' },
	Numpad3: { PageDown: 'NUMPAD_PAGE_DOWN' },
	Numpad4: { ArrowLeft: 'NUMPAD_LEFT' },
	Numpad5: { Clear: 'NUMPAD_BEGIN' },
	Numpad6: { ArrowRight: 'NUMPAD_RIGHT' },
	Numpad7: { Home: 'NUMPAD_HOME' },
	Numpad8: { ArrowUp: 'NUMPAD_UP' },
	Numpad9: { PageUp: 'NUMPAD_PAGE_UP' },
	NumpadDecimal: { Delete: 'NUMPAD_DELETE' }
};

/**
 * `code` values some browsers send that aren't the standard names: older
 * Firefox's `OS` keys and volume keys.
 */
export const FUZ_TERMINAL_KEY_CODE_ALIASES: Readonly<Record<string, string>> = {
	OSLeft: 'META_LEFT',
	OSRight: 'META_RIGHT',
	VolumeMute: 'AUDIO_VOLUME_MUTE',
	VolumeDown: 'AUDIO_VOLUME_DOWN',
	VolumeUp: 'AUDIO_VOLUME_UP'
};

/**
 * The `code` value for a `GhosttyKey` name, by the regular correspondence
 * between them (the library's key names follow the UI Events codes): `KeyA`
 * for `A`, `Digit1` for `DIGIT_1`, `BracketLeft` for `BRACKET_LEFT`, `F12`
 * for `F12`.
 */
export const to_fuz_terminal_key_code = (name: string): string => {
	if (/^[A-Z]$/.test(name)) return `Key${name}`;
	return name
		.split('_')
		.map((word) => word.charAt(0) + word.slice(1).toLowerCase())
		.join('');
};

/**
 * The `code` table for a set of `GhosttyKey` names: each name by its regular
 * `code` (`to_fuz_terminal_key_code`), except the numpad navigation keys,
 * which are by their `code` and `key` pair; plus the aliases. Only names in
 * the set are entered.
 *
 * @param names - the `GhosttyKey` names, without the prefix
 */
export const create_fuz_terminal_key_codes = (names: Iterable<string>): FuzTerminalKeyCodes => {
	const known = new Set(names);
	const navigation = new Map<string, string>();
	for (const [code, keys] of Object.entries(FUZ_TERMINAL_NUMPAD_NAVIGATION_KEYS)) {
		for (const [key, name] of Object.entries(keys)) {
			if (known.has(name)) navigation.set(`${code} ${key}`, name);
		}
	}
	const navigation_names = new Set(navigation.values());
	const codes = new Map<string, string>();
	for (const name of known) {
		if (!navigation_names.has(name)) codes.set(to_fuz_terminal_key_code(name), name);
	}
	for (const [code, name] of Object.entries(FUZ_TERMINAL_KEY_CODE_ALIASES)) {
		if (known.has(name)) codes.set(code, name);
	}
	for (const [pair, name] of navigation) codes.set(pair, name);
	return codes;
};

/** The `code` table for a module's manifest, its `GhosttyKey` names. */
export const resolve_fuz_terminal_key_codes = (manifest: GhosttyManifest): FuzTerminalKeyCodes =>
	create_fuz_terminal_key_codes(
		[...manifest.enum_values('GhosttyKey').keys()].filter((name) => name !== 'MAX_VALUE')
	);

/**
 * The key name for an event: from its `code`, or for the numpad with NumLock
 * off from its `code` and `key`; `UNIDENTIFIED` for a code the library has
 * no key for.
 */
export const to_fuz_terminal_key_name = (
	event: Pick<FuzTerminalKeyboardEvent, 'code' | 'key'>,
	codes: FuzTerminalKeyCodes
): string => {
	return codes.get(`${event.code} ${event.key}`) ?? codes.get(event.code) ?? 'UNIDENTIFIED';
};

/** A `key` that names a key rather than giving its text: `Enter`, `F1`, `Dead`, `Process`, `Unidentified`. */
const NAMED_KEY = /^[A-Z][A-Za-z0-9]+$/;

/**
 * Whether text holds a control character (C0, DEL, C1) or a code unit of
 * the private-use range macOS reports function keys in: the encoder must
 * never be given these as text.
 */
const has_non_text = (text: string): boolean => {
	for (let i = 0; i < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || (unit >= 0xf700 && unit <= 0xf8ff)) {
			return true;
		}
	}
	return false;
};

/**
 * The text a key produced: its `key` when that's a character — `a`, `A`,
 * `é`, `中`, an emoji — and `''` when it names a key (`Enter`, `Tab`,
 * `Dead`, `Process`, `Unidentified`, …) or holds a control character.
 * Before any Ctrl transformation, as the encoder wants it: a browser gives
 * `c` for Ctrl+C.
 */
export const get_fuz_terminal_key_text = (event: Pick<FuzTerminalKeyboardEvent, 'key'>): string => {
	const { key } = event;
	if (key === '' || NAMED_KEY.test(key) || has_non_text(key)) return '';
	return key;
};

/**
 * The characters the writing-system keys make unshifted on a US layout, by
 * `code` — the fallback for a key's unshifted code point.
 */
// TODO: `navigator.keyboard.getLayoutMap()` (Chromium only) for the
// current layout's unshifted characters, where it's available
export const FUZ_TERMINAL_US_UNSHIFTED: Readonly<Record<string, string>> = {
	Backquote: '`',
	Minus: '-',
	Equal: '=',
	BracketLeft: '[',
	BracketRight: ']',
	Backslash: '\\',
	Semicolon: ';',
	Quote: "'",
	Comma: ',',
	Period: '.',
	Slash: '/',
	Space: ' ',
	Numpad0: '0',
	Numpad1: '1',
	Numpad2: '2',
	Numpad3: '3',
	Numpad4: '4',
	Numpad5: '5',
	Numpad6: '6',
	Numpad7: '7',
	Numpad8: '8',
	Numpad9: '9',
	NumpadDecimal: '.',
	NumpadDivide: '/',
	NumpadMultiply: '*',
	NumpadSubtract: '-',
	NumpadAdd: '+',
	NumpadEqual: '=',
	NumpadComma: ','
};

/** A string's code point when it's exactly one, else `null`. */
const single_code_point = (text: string): number | null => {
	const code_point = text.codePointAt(0);
	if (code_point === undefined) return null;
	return text.length === (code_point > 0xffff ? 2 : 1) ? code_point : null;
};

const is_alt_graph = (event: FuzTerminalKeyboardEvent): boolean =>
	event.getModifierState?.('AltGraph') === true;

/**
 * The code point the event's key makes without shift, or 0 when there's
 * none to tell (a function key):
 *
 * - a cased letter, lowercased: `a` for `A`, whatever the layout or the
 *   reason it's uppercase (Shift, CapsLock)
 * - otherwise, with no Shift, Alt, or AltGraph changing it, the key's own
 *   text: the current layout's character
 * - otherwise the US layout's character for the physical key — `1` for
 *   Shift+`!` — and for the letters, their letter
 * - for a key the US layout hasn't (`IntlBackslash`, `IntlRo`, an empty
 *   `code`), the text's own character, lowercased
 *
 * @param text - the key's text, as `get_fuz_terminal_key_text` gives it
 */
export const get_fuz_terminal_unshifted_codepoint = (
	event: FuzTerminalKeyboardEvent,
	text: string
): number => {
	const code_point = single_code_point(text);
	if (code_point !== null) {
		const lower = single_code_point(text.toLowerCase());
		if (lower !== null && lower !== code_point) return lower;
		if (!event.shiftKey && !event.altKey && !is_alt_graph(event)) return code_point;
	}
	const { code } = event;
	const letter = /^Key([A-Z])$/.exec(code);
	if (letter) return letter[1]!.toLowerCase().charCodeAt(0);
	const digit = /^Digit([0-9])$/.exec(code);
	if (digit) return digit[1]!.charCodeAt(0);
	const us = FUZ_TERMINAL_US_UNSHIFTED[code];
	if (us !== undefined) return us.charCodeAt(0);
	// a key the US table hasn't (IntlBackslash, IntlRo, IntlYen, an empty
	// `code`): the text's own character, lowercased
	if (code_point === null) return 0;
	return single_code_point(text.toLowerCase()) ?? code_point;
};

/** Each right-hand modifier key's modifier bit and side bit. */
const RIGHT_MODIFIERS: Readonly<Record<string, readonly [number, number]>> = {
	ShiftRight: [GHOSTTY_KEY_MODS.shift, GHOSTTY_KEY_MODS.shift_right],
	ControlRight: [GHOSTTY_KEY_MODS.ctrl, GHOSTTY_KEY_MODS.ctrl_right],
	AltRight: [GHOSTTY_KEY_MODS.alt, GHOSTTY_KEY_MODS.alt_right],
	MetaRight: [GHOSTTY_KEY_MODS.super, GHOSTTY_KEY_MODS.super_right],
	OSRight: [GHOSTTY_KEY_MODS.super, GHOSTTY_KEY_MODS.super_right]
};

/**
 * The platform whose keyboard conventions apply: on `mac`, Option (`altKey`)
 * is the layout's level for typing characters, not a modifier for the
 * program.
 */
export type FuzTerminalKeyPlatform = 'mac' | 'other';

/**
 * The modifiers held, as `GHOSTTY_KEY_MODS` bits: Shift, Ctrl, Alt, and
 * Meta as super, CapsLock and NumLock from `getModifierState`. A side bit is
 * set only on a right-hand modifier's own event — a browser says which side
 * of a modifier is held only when it's that key's event.
 *
 * AltGraph is a layout's third level, not a modifier: when it made the text
 * (Windows reports it as Ctrl+Alt as well), Ctrl and Alt are dropped, so
 * AltGr+Q's `@` is sent as `@`, not as Ctrl+Alt+@.
 *
 * On macOS Option is the same kind of level: when it made text with neither
 * Ctrl nor Meta held, Alt is dropped, so a German Mac's Option+5 is the `[`
 * it types — never Alt+`[` (which the alt escape prefix would send as
 * `ESC [`, the start of a sequence), and under the Kitty protocol's
 * report-all flag a `[` the program receives as text. A program can't tell
 * Option was held for it. Option without text (Option+Left), or with Ctrl,
 * stays Alt.
 *
 * @param text - the key's text, as `get_fuz_terminal_key_text` gives it
 * @param platform - whose keyboard conventions apply
 */
// TODO: the side of a modifier held while another key is pressed, by
// tracking the modifiers' own keydowns
// TODO: a host option for Option as Meta on macOS (Alt, with its escape
// prefix, instead of the layout's characters), per side as Ghostty has it
export const get_fuz_terminal_key_mods = (
	event: FuzTerminalKeyboardEvent,
	text: string,
	platform: FuzTerminalKeyPlatform
): number => {
	const { shift, ctrl, alt, caps_lock, num_lock } = GHOSTTY_KEY_MODS;
	let mods = 0;
	if (event.shiftKey) mods |= shift;
	if (event.ctrlKey) mods |= ctrl;
	if (event.altKey) mods |= alt;
	if (event.metaKey) mods |= GHOSTTY_KEY_MODS.super;
	if (event.getModifierState?.('CapsLock') === true) mods |= caps_lock;
	if (event.getModifierState?.('NumLock') === true) mods |= num_lock;
	if (text !== '' && is_alt_graph(event)) mods &= ~(ctrl | alt);
	if (
		platform === 'mac' &&
		text !== '' &&
		(mods & alt) !== 0 &&
		(mods & (ctrl | GHOSTTY_KEY_MODS.super)) === 0
	) {
		mods &= ~alt;
	}
	const right = RIGHT_MODIFIERS[event.code];
	// only with its modifier held: on its keyup the modifier is already off
	if (right !== undefined && (mods & right[0]) !== 0) mods |= right[1];
	return mods;
};

/**
 * Whether the key is part of a composition — an IME holding it (`Process`,
 * key code 229, `isComposing`) or a dead key waiting for the next — and so
 * isn't the terminal's to encode: its text comes later.
 */
// TODO: a hidden textarea for IME composition, whose committed text is
// sent as the program's input
export const is_fuz_terminal_key_composing = (event: FuzTerminalKeyboardEvent): boolean =>
	event.isComposing || event.key === 'Process' || event.keyCode === 229 || event.key === 'Dead';

/**
 * The characters whose Ctrl combinations are the browser's page zoom:
 * Ctrl+= and Ctrl++ zoom in, Ctrl+- and Ctrl+_ zoom out, Ctrl+0 resets.
 */
const FUZ_TERMINAL_ZOOM_KEYS: ReadonlySet<string> = new Set(['=', '+', '-', '_', '0']);

/**
 * Whether the browser and the OS keep a key rather than the terminal: any
 * combination with Meta (the OS's and the browser's shortcuts — on macOS,
 * copy and paste among them), Ctrl+Shift+C and Ctrl+Shift+V, reserved for
 * copy and paste, and, except on macOS, the browser's page zoom: Ctrl with
 * `=`, `+`, `-`, `_`, or `0`, Shift or not, the numpad's `+`, `-`, and `0`
 * included. The program never sees these; every other key the encoder has
 * bytes for is the program's, Tab, Escape, Ctrl+C, Ctrl+W, and Ctrl+digit
 * included — except a copy chord while there's a selection to copy
 * (`is_fuz_terminal_copy_key`).
 *
 * C and V are matched by the layout's character, or, when the layout's isn't
 * a Latin letter (Cyrillic, say), by the physical key. The zoom keys are
 * matched by the layout's character alone, so they follow it to whichever
 * physical key types it; a layout that types one only with AltGr (Ctrl and
 * Alt held, as Windows reports it) leaves it the program's. On macOS the
 * browser zooms with Cmd, a Meta combination, so Ctrl with these stays the
 * program's.
 *
 * @param platform - whose keyboard conventions apply
 */
// TODO: paste on Ctrl+Shift+V once the view takes the browser's paste events
// (a hidden textarea); Shift+Insert joins the pass-through then (other
// browser terminals leave it to the browser as paste); a host override of
// which keys pass through
export const should_fuz_terminal_pass_key = (
	event: FuzTerminalKeyboardEvent,
	platform: FuzTerminalKeyPlatform
): boolean => {
	if (event.metaKey) return true;
	if (!event.ctrlKey || event.altKey) return false;
	if (platform !== 'mac' && FUZ_TERMINAL_ZOOM_KEYS.has(event.key)) return true;
	if (!event.shiftKey) return false;
	const letter = event.key.toLowerCase();
	if (/^[a-z]$/.test(letter)) return letter === 'c' || letter === 'v';
	return event.code === 'KeyC' || event.code === 'KeyV';
};

/** A letter of any script; with `LATIN_SCRIPT`, a non-Latin layout's letter. */
const LETTER = /^\p{L}$/u;
const LATIN_SCRIPT = /^\p{Script=Latin}$/u;

/**
 * Whether a key is one of the terminal's copy chords, Ctrl+Alt+C and
 * Ctrl+Insert — with no Shift or Meta, and except on macOS. A view copies
 * its selection on one only while the selection takes some of its text; with none
 * the key is the program's, as any other (`FuzTerminalState.handle_key`).
 * Ctrl+C is always the program's.
 *
 * C is matched by the layout's character, or, when that's a letter of
 * another script (Cyrillic `с`, say), by the physical key — never when
 * AltGraph is held, or when Ctrl+Alt made a Latin letter or a symbol, which
 * is a layout's third level typing it (Windows reports AltGr as Ctrl+Alt:
 * Polish AltGr+C types `ć`). Insert is matched by `key`, so the numpad's
 * Insert with NumLock off is one too.
 *
 * On macOS Cmd+C is the platform's copy and passes to the browser
 * (`should_fuz_terminal_pass_key`), so Ctrl+Option+C and Ctrl+Insert stay
 * the program's.
 *
 * @param platform - whose keyboard conventions apply
 */
// TODO: a host option for other copy modes (Ctrl+C copying while there's a
// selection, copy on select)
export const is_fuz_terminal_copy_key = (
	event: FuzTerminalKeyboardEvent,
	platform: FuzTerminalKeyPlatform
): boolean => {
	if (platform === 'mac' || !event.ctrlKey || event.shiftKey || event.metaKey) return false;
	if (event.key === 'Insert') return !event.altKey;
	if (!event.altKey || is_alt_graph(event)) return false;
	const { key } = event;
	if (key === 'c' || key === 'C') return true;
	return LETTER.test(key) && !LATIN_SCRIPT.test(key) && event.code === 'KeyC';
};

/**
 * The modifiers used up making a key's text (`consumed_mods`), so the
 * encoder sends the text as typed rather than as a modified key: Shift,
 * whenever it's held and the key made text — the layout decided the
 * character with it (Shift+A's `A`; on AZERTY, Shift+`&`'s `1`; with
 * CapsLock, Shift+A's `a`) — except on Space and the numpad, whose character
 * Shift doesn't change: Shift+Space stays a shifted space.
 */
export const get_fuz_terminal_consumed_mods = (
	event: Pick<FuzTerminalKeyboardEvent, 'code'>,
	mods: number,
	text: string
): number => {
	const { shift } = GHOSTTY_KEY_MODS;
	if (text === '' || (mods & shift) === 0) return 0;
	return event.code === 'Space' || event.code.startsWith('Numpad') ? 0 : shift;
};

/**
 * A key event as the encoder takes it: its modifiers
 * (`get_fuz_terminal_key_mods`) and the ones its text used up
 * (`get_fuz_terminal_consumed_mods`).
 *
 * @param action - `press` or `repeat` for a keydown (by `repeat`), `release` for a keyup
 * @param codes - the module's `code` table (`resolve_fuz_terminal_key_codes`)
 * @param platform - whose keyboard conventions apply; `other` unless the view runs on macOS
 */
export const to_fuz_terminal_key_input = (
	event: FuzTerminalKeyboardEvent,
	action: GhosttyKeyAction,
	codes: FuzTerminalKeyCodes,
	platform: FuzTerminalKeyPlatform
): GhosttyKeyInput => {
	const text = get_fuz_terminal_key_text(event);
	const mods = get_fuz_terminal_key_mods(event, text, platform);
	return {
		action,
		key: to_fuz_terminal_key_name(event, codes),
		mods,
		consumed_mods: get_fuz_terminal_consumed_mods(event, mods, text),
		text,
		unshifted_codepoint: get_fuz_terminal_unshifted_codepoint(event, text),
		composing: false
	};
};

/**
 * The attribute `FuzTerminal` sets on its root while it takes keys: ready,
 * and with input on. Keyed on this, not on a styling class, so a page's own
 * shortcuts can tell (`is_fuz_terminal_key_target`).
 */
export const FUZ_TERMINAL_KEYS_ATTRIBUTE = 'data-fuz-terminal-keys';

/**
 * Whether a key event's target is inside a terminal view that takes keys —
 * for a page's global shortcuts, which must leave such a key to the terminal
 * as they leave one typed into a text field. Every key typed into the view
 * may be the program's, printable ones included.
 *
 * @param target - the event's `target`; anything that isn't an element is `false`
 */
export const is_fuz_terminal_key_target = (target: EventTarget | null): boolean => {
	const element = target as Partial<Pick<Element, 'closest'>> | null;
	return (
		typeof element?.closest === 'function' &&
		element.closest(`[${FUZ_TERMINAL_KEYS_ATTRIBUTE}]`) !== null
	);
};
