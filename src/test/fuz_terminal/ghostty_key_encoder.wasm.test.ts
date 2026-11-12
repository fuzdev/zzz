import { test, describe, assert } from 'vitest';

import {
	GhosttyDisposedError,
	GhosttyLoadError,
	GhosttyPoisonedError
} from '#lib/fuz_terminal/ghostty_errors.ts';
import {
	GHOSTTY_KEY_MODS as M,
	GHOSTTY_KITTY_KEY_FLAGS as K,
	GhosttyKeyEncoder,
	type GhosttyKeyAction,
	type GhosttyKeyInput
} from '#lib/fuz_terminal/ghostty_key_encoder.ts';
import {
	resolve_fuz_terminal_key_codes,
	to_fuz_terminal_key_input,
	type FuzTerminalKeyboardEvent,
	type FuzTerminalKeyPlatform
} from '#lib/fuz_terminal/fuz_terminal_keyboard.ts';
import { GhosttyTerminal } from '#lib/fuz_terminal/ghostty_terminal.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

import { GHOSTTY_MANIFEST_FIXTURE } from './ghostty_manifest_fixture.ts';
import { load_test_ghostty_vt, load_wrapped_ghostty_vt } from './ghostty_vt_test_helpers.ts';
import { ESC, CSI, SS3 } from './vt_sequences.ts';

/** A terminal and an encoder over it. */
const create = async (
	vt?: GhosttyVt
): Promise<{ vt: GhosttyVt; terminal: GhosttyTerminal; encoder: GhosttyKeyEncoder }> => {
	const instance = vt ?? (await load_test_ghostty_vt());
	const terminal = new GhosttyTerminal(instance, { cols: 80, rows: 24 });
	return { vt: instance, terminal, encoder: new GhosttyKeyEncoder(terminal) };
};

/** A keyboard event's fields, as a browser gives them; `locks` are what `getModifierState` reports on. */
const key_event = (
	code: string,
	key: string,
	options: {
		shift?: boolean;
		ctrl?: boolean;
		alt?: boolean;
		meta?: boolean;
		locks?: ReadonlyArray<string>;
	} = {}
): FuzTerminalKeyboardEvent => ({
	code,
	key,
	shiftKey: options.shift === true,
	ctrlKey: options.ctrl === true,
	altKey: options.alt === true,
	metaKey: options.meta === true,
	repeat: false,
	isComposing: false,
	getModifierState: (name) => options.locks?.includes(name) === true
});

/** What a browser key event sends, through the mapping, decoded as UTF-8. */
const typer = (encoder: GhosttyKeyEncoder, platform: FuzTerminalKeyPlatform = 'other') => {
	const codes = encoder.terminal.vt.resolve(resolve_fuz_terminal_key_codes);
	return (
		code: string,
		key: string,
		options: Parameters<typeof key_event>[2] = {},
		action: GhosttyKeyAction = 'press'
	): string =>
		decode(
			encoder.encode(
				to_fuz_terminal_key_input(key_event(code, key, options), action, codes, platform)
			)
		);
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('legacy encoding', () => {
	test('letters, digits, and punctuation, shifted and not', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.strictEqual(type('KeyA', 'a'), 'a');
		assert.strictEqual(type('KeyA', 'A', { shift: true }), 'A');
		assert.strictEqual(type('KeyZ', 'z'), 'z');
		assert.strictEqual(type('KeyA', 'A', { locks: ['CapsLock'] }), 'A');
		assert.strictEqual(type('Space', ' '), ' ');
		assert.strictEqual(type('Space', ' ', { shift: true }), ' ');
		const pairs: Array<[string, string, string]> = [
			['Digit1', '1', '!'],
			['Digit2', '2', '@'],
			['Digit0', '0', ')'],
			['Minus', '-', '_'],
			['Equal', '=', '+'],
			['BracketLeft', '[', '{'],
			['Backslash', '\\', '|'],
			['Semicolon', ';', ':'],
			['Quote', "'", '"'],
			['Comma', ',', '<'],
			['Slash', '/', '?'],
			['Backquote', '`', '~']
		];
		for (const [code, plain, shifted] of pairs) {
			assert.strictEqual(type(code, plain), plain, code);
			assert.strictEqual(type(code, shifted, { shift: true }), shifted, `shift ${code}`);
		}
		terminal.dispose();
	});

	test('Ctrl: C0 controls, and CSI u for Ctrl+Shift+letter', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		const ctrl = { ctrl: true };
		assert.strictEqual(type('KeyC', 'c', ctrl), '\x03');
		assert.strictEqual(type('KeyA', 'a', ctrl), '\x01');
		assert.strictEqual(type('KeyZ', 'z', ctrl), '\x1a');
		assert.strictEqual(type('KeyH', 'h', ctrl), '\x08');
		assert.strictEqual(type('KeyA', 'A', { ctrl: true, locks: ['CapsLock'] }), '\x01');
		assert.strictEqual(type('Space', ' ', ctrl), '\x00');
		assert.strictEqual(type('Digit2', '2', ctrl), '\x00');
		assert.strictEqual(type('BracketRight', ']', ctrl), '\x1d');
		assert.strictEqual(type('Backslash', '\\', ctrl), '\x1c');
		assert.strictEqual(type('Slash', '/', ctrl), '\x1f');
		// Ctrl+? (Shift+/ on a US layout) is DEL; Ctrl+_ and Ctrl+^ their C0s
		assert.strictEqual(type('Slash', '?', { ctrl: true, shift: true }), '\x7f');
		assert.strictEqual(type('Minus', '_', { ctrl: true, shift: true }), '\x1f');
		assert.strictEqual(type('Digit6', '^', { ctrl: true, shift: true }), '\x1e');
		assert.strictEqual(type('Backspace', 'Backspace', ctrl), '\x08');
		// Ctrl+Shift+letter is distinct from Ctrl+letter (the classic chords
		// are their own test, below)
		assert.strictEqual(type('KeyA', 'A', { ctrl: true, shift: true }), `${CSI}97;6u`);
		terminal.dispose();
	});

	test('Ctrl on another layout: by the text, or the physical key for a non-Latin letter', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		// AZERTY: the key where US has Q makes `a`
		assert.strictEqual(type('KeyQ', 'a', { ctrl: true }), '\x01');
		// Russian: `с` on the C key
		assert.strictEqual(type('KeyC', 'с', { ctrl: true }), '\x03');
		assert.strictEqual(type('KeyC', 'с'), 'с');
		// AltGr+Q on a German layout under Windows (reported with Ctrl and Alt): the `@`
		assert.strictEqual(type('KeyQ', '@', { ctrl: true, alt: true, locks: ['AltGraph'] }), '@');
		terminal.dispose();
	});

	test('Alt: an escape prefix while mode 1036 is on (the default), the text alone with it off', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.strictEqual(type('KeyA', 'a', { alt: true }), `${ESC}a`);
		assert.strictEqual(type('KeyA', 'A', { alt: true, shift: true }), `${ESC}A`);
		assert.strictEqual(type('KeyA', 'a', { alt: true, ctrl: true }), `${ESC}\x01`);
		assert.strictEqual(type('Period', '.', { alt: true }), `${ESC}.`);
		assert.strictEqual(type('Enter', 'Enter', { alt: true }), `${ESC}\r`);
		assert.strictEqual(type('Backspace', 'Backspace', { alt: true }), `${ESC}\x7f`);
		terminal.write(`${CSI}?1036l`);
		assert.strictEqual(type('KeyA', 'a', { alt: true }), 'a');
		terminal.write(`${CSI}?1036h`);
		assert.strictEqual(type('KeyA', 'a', { alt: true }), `${ESC}a`);
		terminal.dispose();
	});

	test('Enter, Tab, Backspace, Escape, and the editing keys', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.strictEqual(type('Enter', 'Enter'), '\r');
		assert.strictEqual(type('NumpadEnter', 'Enter'), '\r');
		assert.strictEqual(type('Tab', 'Tab'), '\t');
		assert.strictEqual(type('Tab', 'Tab', { shift: true }), `${CSI}Z`);
		assert.strictEqual(type('Backspace', 'Backspace'), '\x7f');
		assert.strictEqual(type('Escape', 'Escape'), ESC);
		assert.strictEqual(type('Delete', 'Delete'), `${CSI}3~`);
		assert.strictEqual(type('Insert', 'Insert'), `${CSI}2~`);
		assert.strictEqual(type('Home', 'Home'), `${CSI}H`);
		assert.strictEqual(type('End', 'End'), `${CSI}F`);
		assert.strictEqual(type('PageUp', 'PageUp'), `${CSI}5~`);
		assert.strictEqual(type('PageDown', 'PageDown'), `${CSI}6~`);
		assert.strictEqual(type('Delete', 'Delete', { ctrl: true }), `${CSI}3;5~`);
		assert.strictEqual(type('PageUp', 'PageUp', { shift: true }), `${CSI}5;2~`);
		assert.strictEqual(type('Home', 'Home', { ctrl: true, shift: true }), `${CSI}1;6H`);
		// the library's modified Enter (xterm's modifyOtherKeys form)
		assert.strictEqual(type('Enter', 'Enter', { shift: true }), `${CSI}27;2;13~`);
		assert.strictEqual(type('Enter', 'Enter', { ctrl: true }), `${CSI}27;5;13~`);
		// DECBKM: Backspace sends BS
		terminal.write(`${CSI}?67h`);
		assert.strictEqual(type('Backspace', 'Backspace'), '\x08');
		terminal.write(`${CSI}?67l`);
		assert.strictEqual(type('Backspace', 'Backspace'), '\x7f');
		terminal.dispose();
	});

	test('arrows: plain, with modifiers, and in application cursor mode', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${CSI}A`);
		assert.strictEqual(type('ArrowDown', 'ArrowDown'), `${CSI}B`);
		assert.strictEqual(type('ArrowRight', 'ArrowRight'), `${CSI}C`);
		assert.strictEqual(type('ArrowLeft', 'ArrowLeft'), `${CSI}D`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp', { shift: true }), `${CSI}1;2A`);
		assert.strictEqual(type('ArrowRight', 'ArrowRight', { alt: true }), `${CSI}1;3C`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp', { alt: true, shift: true }), `${CSI}1;4A`);
		assert.strictEqual(type('ArrowLeft', 'ArrowLeft', { ctrl: true }), `${CSI}1;5D`);
		assert.strictEqual(
			type('ArrowDown', 'ArrowDown', { ctrl: true, alt: true, shift: true }),
			`${CSI}1;8B`
		);
		// DECCKM, written to the terminal as a program would
		terminal.write(`${CSI}?1h`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${SS3}A`);
		assert.strictEqual(type('ArrowLeft', 'ArrowLeft'), `${SS3}D`);
		assert.strictEqual(type('Home', 'Home'), `${SS3}H`);
		assert.strictEqual(type('End', 'End'), `${SS3}F`);
		// a modified arrow keeps its CSI form
		assert.strictEqual(type('ArrowUp', 'ArrowUp', { shift: true }), `${CSI}1;2A`);
		terminal.dispose();
	});

	test('a mode the output changes between two presses decides the second', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${CSI}A`);
		// split across writes, as output arrives
		terminal.write(`${CSI}?`);
		terminal.write('1h');
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${SS3}A`);
		terminal.write(`hello${CSI}?1l`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${CSI}A`);
		// a full reset puts the modes back
		terminal.write(`${CSI}?1h${ESC}c`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${CSI}A`);
		terminal.dispose();
	});

	test('the keypad: NumLock on and off, and application keypad mode', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		const num = { locks: ['NumLock'] };
		assert.strictEqual(type('Numpad1', '1', num), '1');
		assert.strictEqual(type('NumpadAdd', '+', num), '+');
		assert.strictEqual(type('NumpadDivide', '/', num), '/');
		assert.strictEqual(type('NumpadDecimal', '.', num), '.');
		// NumLock off: the navigation keys
		assert.strictEqual(type('Numpad1', 'End'), `${CSI}F`);
		assert.strictEqual(type('Numpad8', 'ArrowUp'), `${CSI}A`);
		assert.strictEqual(type('Numpad5', 'Clear'), `${CSI}E`);
		assert.strictEqual(type('Numpad0', 'Insert'), `${CSI}2~`);
		assert.strictEqual(type('NumpadDecimal', 'Delete'), `${CSI}3~`);
		assert.strictEqual(type('Numpad9', 'PageUp'), `${CSI}5~`);
		// DECKPAM alone changes nothing: mode 1035 (on by default) keeps the keypad numeric
		terminal.write(`${ESC}=`);
		assert.strictEqual(type('Numpad1', '1', num), '1');
		// with 1035 off, the application keypad
		terminal.write(`${CSI}?1035l`);
		assert.strictEqual(type('Numpad1', '1', num), `${SS3}q`);
		assert.strictEqual(type('NumpadAdd', '+', num), `${SS3}k`);
		assert.strictEqual(type('NumpadEnter', 'Enter', num), `${SS3}M`);
		// DECKPNM: numeric again
		terminal.write(`${ESC}>`);
		assert.strictEqual(type('Numpad1', '1', num), '1');
		// application cursor mode reaches the keypad's arrows and Home/End
		terminal.write(`${CSI}?1h`);
		assert.strictEqual(type('Numpad8', 'ArrowUp'), `${SS3}A`);
		assert.strictEqual(type('Numpad1', 'End'), `${SS3}F`);
		terminal.dispose();
	});

	test('function keys, plain and modified', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		const expected = [
			`${SS3}P`,
			`${SS3}Q`,
			`${SS3}R`,
			`${SS3}S`,
			`${CSI}15~`,
			`${CSI}17~`,
			`${CSI}18~`,
			`${CSI}19~`,
			`${CSI}20~`,
			`${CSI}21~`,
			`${CSI}23~`,
			`${CSI}24~`
		];
		for (let i = 0; i < 12; i++) {
			assert.strictEqual(type(`F${i + 1}`, `F${i + 1}`), expected[i], `F${i + 1}`);
		}
		assert.strictEqual(type('F1', 'F1', { shift: true }), `${CSI}1;2P`);
		assert.strictEqual(type('F3', 'F3', { ctrl: true, shift: true }), `${CSI}13;6~`);
		assert.strictEqual(type('F5', 'F5', { ctrl: true }), `${CSI}15;5~`);
		assert.strictEqual(type('F12', 'F12', { alt: true }), `${CSI}24;3~`);
		terminal.dispose();
	});

	test('non-ASCII text is sent as UTF-8', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		const bytes = (code: string, key: string): Array<number> =>
			Array.from(
				encoder.encode(
					to_fuz_terminal_key_input(
						key_event(code, key),
						'press',
						encoder.terminal.vt.resolve(resolve_fuz_terminal_key_codes),
						'other'
					)
				)
			);
		assert.deepEqual(bytes('KeyE', 'é'), [0xc3, 0xa9]);
		assert.deepEqual(bytes('KeyA', '中'), [0xe4, 0xb8, 0xad]);
		assert.deepEqual(bytes('Unidentified', '😀'), [0xf0, 0x9f, 0x98, 0x80]);
		assert.strictEqual(type('KeyE', 'é'), 'é');
		terminal.dispose();
	});

	test('modifiers alone and releases send nothing; a repeat is a press', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.strictEqual(type('ShiftLeft', 'Shift', { shift: true }), '');
		assert.strictEqual(type('ShiftRight', 'Shift', { shift: true }), '');
		assert.strictEqual(type('ControlLeft', 'Control', { ctrl: true }), '');
		assert.strictEqual(type('AltLeft', 'Alt', { alt: true }), '');
		assert.strictEqual(type('MetaLeft', 'Meta', { meta: true }), '');
		assert.strictEqual(type('CapsLock', 'CapsLock'), '');
		assert.strictEqual(type('KeyA', 'a', {}, 'release'), '');
		assert.strictEqual(type('Escape', 'Escape', {}, 'release'), '');
		assert.strictEqual(type('KeyA', 'a', {}, 'repeat'), 'a');
		assert.strictEqual(type('ArrowUp', 'ArrowUp', {}, 'repeat'), `${CSI}A`);
		terminal.dispose();
	});

	test('xterm’s modifyOtherKeys mode 2', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}>4;2m`);
		assert.strictEqual(type('KeyC', 'c', { ctrl: true }), `${CSI}27;5;99~`);
		assert.strictEqual(type('KeyA', 'a', { alt: true }), `${CSI}27;3;97~`);
		assert.strictEqual(type('KeyA', 'a'), 'a');
		terminal.write(`${CSI}>4;0m`);
		assert.strictEqual(type('KeyC', 'c', { ctrl: true }), '\x03');
		terminal.dispose();
	});
});

describe('classic Ctrl chords', () => {
	/** The four chords libghostty-vt sends as fixterms CSI u, with Alt or not. */
	const chords = (type: ReturnType<typeof typer>, alt = false): Array<string> => [
		type('BracketLeft', '[', { ctrl: true, alt }),
		type('KeyI', 'i', { ctrl: true, alt }),
		type('KeyM', 'm', { ctrl: true, alt }),
		type('Digit2', '@', { ctrl: true, shift: true, alt })
	];

	test('with no keyboard protocol on: ESC, Tab, CR, and NUL; with Alt, ESC-prefixed', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.deepEqual(chords(type), [ESC, '\t', '\r', '\x00']);
		assert.deepEqual(chords(type, true), [`${ESC}${ESC}`, `${ESC}\t`, `${ESC}\r`, `${ESC}\x00`]);
		// as the library prefixes its own Ctrl+Alt chords, whatever mode 1036 says
		assert.strictEqual(type('KeyC', 'c', { ctrl: true, alt: true }), `${ESC}\x03`);
		terminal.write(`${CSI}?1036l`);
		assert.strictEqual(type('KeyC', 'c', { ctrl: true, alt: true }), `${ESC}\x03`);
		assert.strictEqual(type('BracketLeft', '[', { ctrl: true, alt: true }), `${ESC}${ESC}`);
		// a repeat too; CapsLock's capitals are lowered as the library lowers Ctrl+C's
		assert.strictEqual(type('KeyI', 'i', { ctrl: true }, 'repeat'), '\t');
		assert.strictEqual(type('KeyM', 'M', { ctrl: true, locks: ['CapsLock'] }), '\r');
		terminal.dispose();
	});

	test('their Shift forms and the neighbouring chords keep the library’s bytes', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		assert.strictEqual(type('KeyI', 'I', { ctrl: true, shift: true }), `${CSI}105;6u`);
		assert.strictEqual(type('KeyM', 'M', { ctrl: true, shift: true }), `${CSI}109;6u`);
		assert.strictEqual(type('BracketLeft', '{', { ctrl: true, shift: true }), `${CSI}123;5u`);
		assert.strictEqual(type('KeyC', 'c', { ctrl: true }), '\x03');
		assert.strictEqual(type('BracketRight', ']', { ctrl: true }), '\x1d');
		assert.strictEqual(type('Digit2', '2', { ctrl: true }), '\x00');
		// modified Enter, Tab, and Escape are the library's in every mode
		assert.strictEqual(type('Enter', 'Enter', { ctrl: true }), `${CSI}27;5;13~`);
		assert.strictEqual(type('Tab', 'Tab', { ctrl: true }), `${CSI}27;5;9~`);
		terminal.dispose();
	});

	test('another layout: the character as the library takes it for its other Ctrl chords', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		// German: Ü is on the US `[` key; its text isn't one byte, so the key's character
		assert.strictEqual(type('BracketLeft', 'ü', { ctrl: true }), ESC);
		// German: `[` is AltGr+8, which isn't Ctrl: the `[` itself
		assert.strictEqual(type('Digit8', '[', { ctrl: true, alt: true, locks: ['AltGraph'] }), '[');
		// AZERTY: `m` is where US has `;`, by its one-byte text
		assert.strictEqual(type('Semicolon', 'm', { ctrl: true }), '\r');
		// Russian: the I key's `ш` isn't one byte, so the key's `i`
		assert.strictEqual(type('KeyI', 'ш', { ctrl: true }), '\t');
		terminal.dispose();
	});

	test('the library’s forms whenever a protocol is on, classic again once it’s off', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}>${K.disambiguate}u`);
		assert.deepEqual(chords(type), [`${CSI}91;5u`, `${CSI}105;5u`, `${CSI}109;5u`, `${CSI}50;6u`]);
		assert.deepEqual(chords(type, true), [
			`${CSI}91;7u`,
			`${CSI}105;7u`,
			`${CSI}109;7u`,
			`${CSI}50;8u`
		]);
		terminal.write(`${CSI}<u`);
		assert.deepEqual(chords(type), [ESC, '\t', '\r', '\x00']);
		// modifyOtherKeys 2
		terminal.write(`${CSI}>4;2m`);
		assert.deepEqual(chords(type), [
			`${CSI}27;5;91~`,
			`${CSI}27;5;105~`,
			`${CSI}27;5;109~`,
			`${CSI}27;6;64~`
		]);
		terminal.write(`${CSI}>4;0m`);
		assert.deepEqual(chords(type), [ESC, '\t', '\r', '\x00']);
		terminal.dispose();
	});

	test('the alternate screen’s own flags decide there', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}?1049h${CSI}>1u`);
		assert.strictEqual(type('BracketLeft', '[', { ctrl: true }), `${CSI}91;5u`);
		terminal.write(`${CSI}?1049l`);
		assert.strictEqual(type('BracketLeft', '[', { ctrl: true }), ESC);
		terminal.write(`${CSI}?1049h`);
		assert.strictEqual(type('BracketLeft', '[', { ctrl: true }), `${CSI}91;5u`);
		terminal.dispose();
	});
});

describe('macOS Option', () => {
	test('Option’s text is typed as itself, under legacy and the Kitty protocol; Option without text is Alt', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder, 'mac');
		for (const flags of ['0', String(K.disambiguate), String(K.disambiguate | K.report_events)]) {
			terminal.write(`${CSI}=${flags}u`);
			// German Mac: Option+5 `[`, Option+6 `]`, Option+L `@`, Option+Shift+7 `\`
			assert.strictEqual(type('Digit5', '[', { alt: true }), '[', flags);
			assert.strictEqual(type('Digit6', ']', { alt: true }), ']', flags);
			assert.strictEqual(type('Digit8', '{', { alt: true }), '{', flags);
			assert.strictEqual(type('Digit7', '|', { alt: true }), '|', flags);
			assert.strictEqual(type('KeyL', '@', { alt: true }), '@', flags);
			assert.strictEqual(type('Digit7', '\\', { alt: true, shift: true }), '\\', flags);
			// US: Option+A, Option+Shift+A
			assert.strictEqual(type('KeyA', 'å', { alt: true }), 'å', flags);
			assert.strictEqual(type('KeyA', 'Å', { alt: true, shift: true }), 'Å', flags);
		}
		// report-all: an escape code, but with the typed character as its text,
		// and no Alt — the program can't tell Option was held
		terminal.write(`${CSI}=31u`);
		assert.strictEqual(type('Digit5', '[', { alt: true }), `${CSI}53;;91u`);
		assert.strictEqual(type('KeyA', 'Å', { alt: true, shift: true }), `${CSI}229:197:97;2;197u`);
		assert.strictEqual(type('ArrowLeft', 'ArrowLeft', { alt: true }), `${CSI}1;3:1D`);
		assert.strictEqual(type('KeyA', 'a', { alt: true, ctrl: true }), `${CSI}97;7u`);
		terminal.write(`${CSI}=0u`);
		assert.strictEqual(type('ArrowLeft', 'ArrowLeft', { alt: true }), `${CSI}1;3D`);
		// Option with Ctrl is Alt: the escape prefix
		assert.strictEqual(type('KeyA', 'a', { alt: true, ctrl: true }), `${ESC}\x01`);
		terminal.write(`${CSI}=${K.disambiguate}u`);
		assert.strictEqual(type('ArrowLeft', 'ArrowLeft', { alt: true }), `${CSI}1;3D`);
		assert.strictEqual(type('KeyA', 'a', { alt: true, ctrl: true }), `${CSI}97;7u`);
		terminal.dispose();
	});

	test('elsewhere, Alt with text is Alt: the escape prefix, or a Kitty code', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder, 'other');
		assert.strictEqual(type('Digit5', '[', { alt: true }), `${ESC}[`);
		assert.strictEqual(type('KeyL', '@', { alt: true }), `${ESC}@`);
		assert.strictEqual(type('KeyA', 'å', { alt: true }), `${ESC}å`);
		terminal.write(`${CSI}=${K.disambiguate}u`);
		assert.strictEqual(type('Digit5', '[', { alt: true }), `${CSI}53;3u`);
		assert.strictEqual(type('KeyA', 'a', { alt: true }), `${CSI}97;3u`);
		terminal.write(`${CSI}=31u`);
		assert.strictEqual(type('Digit5', '[', { alt: true }), `${CSI}53;3u`);
		terminal.dispose();
	});
});

describe('the Kitty keyboard protocol', () => {
	test('shifted text is plain text however the layout made it; Shift+Space and Shift on the numpad stay shifted', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		const cases = (): Array<string> => [
			// CapsLock and Shift make a lowercase letter
			type('KeyA', 'a', { shift: true, locks: ['CapsLock'] }),
			// AZERTY: Shift+& is 1
			type('Digit1', '1', { shift: true }),
			type('Space', ' ', { shift: true }),
			type('Numpad1', '1', { shift: true, locks: ['NumLock'] })
		];
		// legacy is unchanged by it
		assert.deepEqual(cases(), ['a', '1', ' ', '1']);
		terminal.write(`${CSI}=${K.disambiguate}u`);
		assert.deepEqual(cases(), ['a', '1', `${CSI}32;2u`, `${CSI}57400;130u`]);
		terminal.dispose();
	});

	test('a key the US table hasn’t keeps its modifiers and reports its release', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}=${K.disambiguate | K.report_events}u`);
		assert.strictEqual(type('IntlBackslash', '<', { ctrl: true }), `${CSI}60;5u`);
		assert.strictEqual(type('IntlBackslash', '>', { shift: true }), '>');
		assert.strictEqual(type('IntlBackslash', '<', {}, 'release'), `${CSI}60;1:3u`);
		assert.strictEqual(type('IntlRo', '\\', {}, 'release'), `${CSI}92;1:3u`);
		// shifted, where only the text tells the key's character
		assert.strictEqual(type('IntlBackslash', '>', { ctrl: true, shift: true }), `${CSI}62;6u`);
		assert.strictEqual(type('IntlBackslash', '>', { shift: true }, 'release'), `${CSI}62;2:3u`);
		assert.strictEqual(type('IntlRo', '_', { shift: true }, 'release'), `${CSI}95;2:3u`);
		// a key the browser gives no code for
		assert.strictEqual(type('', 'x', { ctrl: true }), `${CSI}120;5u`);
		assert.strictEqual(type('', '>', { ctrl: true, shift: true }), `${CSI}62;6u`);
		terminal.dispose();
	});

	test('the terminal reports it, and a program can turn it on and back off', async () => {
		const { terminal, encoder } = await create();
		const replies: Array<string> = [];
		terminal.set_effect('write_pty', (data) => replies.push(decode(data)));
		const type = typer(encoder);
		terminal.write(`${CSI}?u`);
		assert.deepEqual(replies, [`${CSI}?0u`]);
		terminal.write(`${CSI}>1u${CSI}?u`);
		assert.deepEqual(replies, [`${CSI}?0u`, `${CSI}?1u`]);
		assert.strictEqual(type('Escape', 'Escape'), `${CSI}27u`);
		terminal.write(`${CSI}<u${CSI}?u`);
		assert.deepEqual(replies.at(-1), `${CSI}?0u`);
		assert.strictEqual(type('Escape', 'Escape'), ESC);
		terminal.dispose();
	});

	test('disambiguate: escape codes for what legacy encodes ambiguously, text stays text', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}>${K.disambiguate}u`);
		assert.strictEqual(type('Escape', 'Escape'), `${CSI}27u`);
		assert.strictEqual(type('KeyC', 'c', { ctrl: true }), `${CSI}99;5u`);
		assert.strictEqual(type('KeyA', 'a', { alt: true }), `${CSI}97;3u`);
		assert.strictEqual(type('BracketLeft', '[', { ctrl: true }), `${CSI}91;5u`, 'not rewritten');
		assert.strictEqual(type('Enter', 'Enter', { shift: true }), `${CSI}13;2u`);
		assert.strictEqual(type('Backspace', 'Backspace', { alt: true }), `${CSI}127;3u`);
		assert.strictEqual(type('Space', ' ', { shift: true }), `${CSI}32;2u`);
		// unmodified, and shifted text, are the text; Enter, Tab, Backspace their bytes
		assert.strictEqual(type('KeyA', 'a'), 'a');
		assert.strictEqual(type('KeyA', 'A', { shift: true }), 'A');
		assert.strictEqual(type('Digit1', '!', { shift: true }), '!');
		assert.strictEqual(type('KeyE', 'é'), 'é');
		assert.strictEqual(type('Enter', 'Enter'), '\r');
		assert.strictEqual(type('Tab', 'Tab'), '\t');
		assert.strictEqual(type('Backspace', 'Backspace'), '\x7f');
		// arrows and function keys
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${CSI}A`);
		assert.strictEqual(type('ArrowLeft', 'ArrowLeft', { ctrl: true, shift: true }), `${CSI}1;6D`);
		assert.strictEqual(type('F1', 'F1'), `${CSI}P`);
		assert.strictEqual(type('F3', 'F3'), `${CSI}13~`);
		// the key code is the layout's unshifted character (Russian `с`), from the text
		assert.strictEqual(type('KeyC', 'с', { ctrl: true }), `${CSI}1089;5u`);
		// AZERTY: the `a` key, wherever it is
		assert.strictEqual(type('KeyQ', 'a', { ctrl: true }), `${CSI}97;5u`);
		// the numpad's navigation keys have codes of their own
		assert.strictEqual(type('Numpad1', 'End'), `${CSI}57424u`);
		terminal.dispose();
	});

	test('report events: repeats and releases, but no release for Enter, Tab, or Backspace', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}>${K.disambiguate | K.report_events}u`);
		assert.strictEqual(type('KeyA', 'a'), 'a');
		assert.strictEqual(type('KeyA', 'a', {}, 'repeat'), 'a');
		assert.strictEqual(type('KeyA', 'a', {}, 'release'), `${CSI}97;1:3u`);
		assert.strictEqual(type('Escape', 'Escape'), `${CSI}27u`);
		assert.strictEqual(type('Escape', 'Escape', {}, 'repeat'), `${CSI}27;1:2u`);
		assert.strictEqual(type('Escape', 'Escape', {}, 'release'), `${CSI}27;1:3u`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp'), `${CSI}1;1:1A`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp', {}, 'release'), `${CSI}1;1:3A`);
		assert.strictEqual(type('ArrowUp', 'ArrowUp', { ctrl: true }, 'repeat'), `${CSI}1;5:2A`);
		assert.strictEqual(type('Enter', 'Enter', {}, 'release'), '');
		assert.strictEqual(type('Tab', 'Tab', {}, 'release'), '');
		assert.strictEqual(type('Backspace', 'Backspace', {}, 'release'), '');
		// a modifier alone still reports nothing without report-all
		assert.strictEqual(type('ShiftLeft', 'Shift', { shift: true }), '');
		terminal.dispose();
	});

	test('report all and associated text: every key an escape code, modifiers too', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(
			`${CSI}>${K.disambiguate | K.report_events | K.report_all | K.report_associated}u`
		);
		assert.strictEqual(type('KeyA', 'a'), `${CSI}97;;97u`);
		assert.strictEqual(type('KeyA', 'A', { shift: true }), `${CSI}97;2;65u`);
		assert.strictEqual(type('Digit1', '!', { shift: true }), `${CSI}49;2;33u`);
		assert.strictEqual(type('Enter', 'Enter'), `${CSI}13u`);
		assert.strictEqual(type('Tab', 'Tab'), `${CSI}9u`);
		assert.strictEqual(type('ShiftLeft', 'Shift', { shift: true }), `${CSI}57441;2u`);
		assert.strictEqual(type('ShiftRight', 'Shift', { shift: true }), `${CSI}57447;2u`);
		assert.strictEqual(type('ShiftLeft', 'Shift', {}, 'release'), `${CSI}57441;1:3u`);
		assert.strictEqual(type('KeyA', 'a', {}, 'release'), `${CSI}97;1:3u`);
		terminal.dispose();
	});

	test('report alternates: the shifted key and the base-layout key', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}>${K.disambiguate | K.report_alternates | K.report_all}u`);
		assert.strictEqual(type('KeyA', 'A', { shift: true }), `${CSI}97:65;2u`);
		assert.strictEqual(type('Digit1', '!', { shift: true }), `${CSI}49:33;2u`);
		// Russian: the layout's key, then the US key in its place
		assert.strictEqual(type('KeyC', 'с'), `${CSI}1089::99u`);
		terminal.dispose();
	});

	test('each screen has its own flags: leaving the alternate screen leaves them', async () => {
		const { terminal, encoder } = await create();
		const type = typer(encoder);
		terminal.write(`${CSI}?1049h${CSI}>1u`);
		assert.strictEqual(type('Escape', 'Escape'), `${CSI}27u`);
		terminal.write(`${CSI}?1049l`);
		assert.strictEqual(type('Escape', 'Escape'), ESC);
		// the alternate screen's are kept for its return
		terminal.write(`${CSI}?1049h`);
		assert.strictEqual(type('Escape', 'Escape'), `${CSI}27u`);
		terminal.dispose();
	});
});

describe('the hand-written constants', () => {
	// `GHOSTTY_KEY_MODS` and `GHOSTTY_KITTY_KEY_FLAGS` mirror `#define`s of
	// libghostty-vt's `key/event.h` (`GHOSTTY_MODS_*`) and `key/encoder.h`
	// (`GHOSTTY_KITTY_KEY_*`), which the type manifest doesn't carry: each is
	// held to what the library does with it

	test('each modifier bit is the one the library reads', async () => {
		const { terminal, encoder } = await create();
		const up = (mods: number): string =>
			decode(encoder.encode({ action: 'press', key: 'ARROW_UP', mods }));
		// xterm's modifier parameter: 1 + shift 1, alt 2, ctrl 4, super 8
		assert.strictEqual(up(M.shift), `${CSI}1;2A`);
		assert.strictEqual(up(M.alt), `${CSI}1;3A`);
		assert.strictEqual(up(M.ctrl), `${CSI}1;5A`);
		assert.strictEqual(up(M.super), `${CSI}1;9A`);
		assert.strictEqual(up(M.shift | M.alt | M.ctrl | M.super), `${CSI}1;16A`);
		// the locks show only under the Kitty protocol: caps 64, num 128
		assert.strictEqual(up(M.caps_lock | M.num_lock), `${CSI}A`);
		terminal.write(`${CSI}=${K.disambiguate}u`);
		assert.strictEqual(up(M.caps_lock), `${CSI}1;65A`);
		assert.strictEqual(up(M.num_lock), `${CSI}1;129A`);
		// every bit at once, side bits included: an output, not just no error
		const all = Object.values(M).reduce((a, b) => a | b, 0);
		assert.strictEqual(up(all), `${CSI}1;208A`);
		// the side bits change nothing here: the library reads only Alt's side,
		// and only when built for macOS (Option as Alt per side)
		for (const side of [M.shift_right, M.ctrl_right, M.alt_right, M.super_right]) {
			assert.strictEqual(up(side), `${CSI}A`);
		}
		terminal.dispose();
	});

	test('each Kitty flag is the one the terminal reports and the encoder follows', async () => {
		const { terminal, encoder } = await create();
		const replies: Array<string> = [];
		terminal.set_effect('write_pty', (data) => replies.push(decode(data)));
		const a = { key: 'A', text: 'a', unshifted_codepoint: 97 };
		const press = (input: Omit<GhosttyKeyInput, 'action'>): string =>
			decode(encoder.encode({ action: 'press', ...input }));
		const set = (flags: number): void => {
			terminal.write(`${CSI}=${flags}u${CSI}?u`);
			assert.strictEqual(replies.at(-1), `${CSI}?${flags}u`);
		};
		set(K.disambiguate);
		assert.strictEqual(press({ key: 'ESCAPE' }), `${CSI}27u`);
		assert.strictEqual(decode(encoder.encode({ action: 'release', ...a })), '');
		set(K.report_events);
		assert.strictEqual(decode(encoder.encode({ action: 'release', ...a })), `${CSI}97;1:3u`);
		set(K.report_alternates);
		assert.strictEqual(
			press({ ...a, text: 'A', mods: M.ctrl | M.shift, consumed_mods: M.shift }),
			`${CSI}97:65;6u`
		);
		set(K.report_all);
		assert.strictEqual(press(a), `${CSI}97u`);
		assert.strictEqual(press({ key: 'SHIFT_LEFT', mods: M.shift }), `${CSI}57441;2u`);
		set(K.report_all | K.report_associated);
		assert.strictEqual(press(a), `${CSI}97;;97u`);
		terminal.dispose();
	});
});

describe('the encoder', () => {
	test('encodes from inside an effect handler, in the middle of a write that grows memory', async () => {
		const { vt, terminal, encoder } = await create();
		const type = typer(encoder);
		const got: Array<string> = [];
		const big = 'x'.repeat(4 << 20);
		const memory_before = vt.memory.size;
		terminal.set_effect('write_pty', () => {
			// a 4 MiB text grows the encoder's buffers, and so the memory, mid-write
			got.push(String(encoder.encode({ action: 'press', key: 'UNIDENTIFIED', text: big }).length));
			got.push(type('ArrowUp', 'ArrowUp'));
		});
		terminal.write(`${CSI}6nAFTER${CSI}?1h${CSI}6n`);
		assert.isAbove(vt.memory.size, memory_before);
		// the second query comes after the mode change: the sync saw it
		assert.deepEqual(got, [String(big.length), `${CSI}A`, String(big.length), `${SS3}A`]);
		assert.strictEqual(terminal.format_text(), 'AFTER');
		terminal.dispose();
	});

	test('an output longer than its buffer is encoded whole, the buffer grown once', async () => {
		let allocs = 0;
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_wasm_alloc: (len: number): number => {
				allocs++;
				return exports.ghostty_wasm_alloc(len);
			}
		}));
		const { terminal, encoder } = await create(vt);
		const text = 'é'.repeat(200);
		const input: GhosttyKeyInput = { action: 'press', key: 'UNIDENTIFIED', text };
		const before = allocs;
		assert.strictEqual(decode(encoder.encode(input)), text);
		// the text buffer and the output buffer, once each
		assert.strictEqual(allocs - before, 2);
		assert.strictEqual(decode(encoder.encode(input)), text);
		assert.strictEqual(allocs - before, 2);
		terminal.dispose();
	});

	test('keys allocate nothing in the module once warm', async () => {
		let allocs = 0;
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_wasm_alloc: (len: number): number => {
				allocs++;
				return exports.ghostty_wasm_alloc(len);
			},
			ghostty_wasm_alloc_opaque: (): number => {
				allocs++;
				return exports.ghostty_wasm_alloc_opaque();
			}
		}));
		const { terminal, encoder } = await create(vt);
		const type = typer(encoder);
		const run = (): void => {
			type('KeyA', 'a');
			type('KeyA', 'A', { shift: true });
			type('KeyC', 'c', { ctrl: true });
			type('ArrowUp', 'ArrowUp', { alt: true });
			type('F5', 'F5');
			type('KeyE', 'é');
			type('Unidentified', '😀');
			type('ShiftLeft', 'Shift', { shift: true });
			type('KeyA', 'a', {}, 'release');
		};
		// warm: the encoder's buffers, and the terminal's write buffer
		run();
		terminal.write(`${CSI}>31u`);
		run();
		terminal.write(`${CSI}<u`);
		const warm = allocs;
		for (let i = 0; i < 100; i++) run();
		terminal.write(`${CSI}>31u`);
		for (let i = 0; i < 100; i++) run();
		terminal.write(`${CSI}<u`);
		assert.strictEqual(allocs, warm);
		terminal.dispose();
	});

	test('an event the library can’t take is refused before any call', async () => {
		const calls: Array<string> = [];
		const vt = await load_wrapped_ghostty_vt((exports) => {
			const wrapped: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(exports)) {
				if (typeof value !== 'function' || !name.startsWith('ghostty_key_')) continue;
				wrapped[name] = (...args: Array<unknown>): unknown => {
					calls.push(name);
					return (value as (...a: Array<unknown>) => unknown)(...args);
				};
			}
			return wrapped;
		});
		const { terminal, encoder } = await create(vt);
		calls.length = 0;
		const bad: Array<[GhosttyKeyInput, string]> = [
			[{ action: 'press', key: 'KeyA' }, 'unknown key "KeyA"'],
			[{ action: 'press', key: 'MAX_VALUE' }, 'unknown key'],
			[{ action: 'hold' as GhosttyKeyAction, key: 'A' }, 'unknown key action hold'],
			[{ action: 'toString' as GhosttyKeyAction, key: 'A' }, 'unknown key action toString'],
			[{ action: 'press', key: 'A', mods: 1 << 10 }, 'mods must be'],
			[{ action: 'press', key: 'A', mods: -1 }, 'mods must be'],
			[{ action: 'press', key: 'A', consumed_mods: 0.5 }, 'consumed_mods must be'],
			[{ action: 'press', key: 'A', unshifted_codepoint: 0x110000 }, 'unshifted_codepoint'],
			[{ action: 'press', key: 'A', unshifted_codepoint: -1 }, 'unshifted_codepoint'],
			[{ action: 'press', key: 'ENTER', text: '\r' }, 'no control characters'],
			[{ action: 'press', key: 'A', text: 'a\u0000' }, 'no control characters'],
			[{ action: 'press', key: 'A', text: '\u001f' }, 'no control characters'],
			[{ action: 'press', key: 'BACKSPACE', text: '\u007f' }, 'no control characters'],
			// a sequence as text, which would otherwise be sent as it is — and
			// reach the classic-chord rewrite as if it were the library's own
			[
				{ action: 'press', key: 'I', mods: M.ctrl, text: '\x1b[91;5u' },
				'no control characters (U+0000–U+001F, U+007F)'
			]
		];
		for (const [input, message] of bad) {
			assert.throws(() => encoder.encode(input), RangeError, message);
		}
		assert.deepEqual(calls, []);
		// the nearest characters that aren't controls are text
		assert.strictEqual(
			decode(encoder.encode({ action: 'press', key: 'UNIDENTIFIED', text: ' ~\u0080' })),
			' ~\u0080'
		);
		terminal.dispose();
	});

	test('disposed with its terminal, first; idempotent; then every use throws', async () => {
		const order: Array<string> = [];
		const vt = await load_wrapped_ghostty_vt((exports) => {
			const record =
				(name: string) =>
				(...args: Array<unknown>): unknown => {
					order.push(name);
					return (exports[name] as (...a: Array<unknown>) => unknown)(...args);
				};
			return {
				ghostty_key_event_free: record('ghostty_key_event_free'),
				ghostty_key_encoder_free: record('ghostty_key_encoder_free'),
				ghostty_terminal_free: record('ghostty_terminal_free')
			};
		});
		const { terminal, encoder } = await create(vt);
		const other = new GhosttyKeyEncoder(terminal);
		other.dispose();
		other.dispose();
		assert.isTrue(other.disposed);
		assert.deepEqual(order, ['ghostty_key_event_free', 'ghostty_key_encoder_free']);
		order.length = 0;
		terminal.dispose();
		assert.deepEqual(order, [
			'ghostty_key_event_free',
			'ghostty_key_encoder_free',
			'ghostty_terminal_free'
		]);
		assert.isTrue(encoder.disposed);
		encoder.dispose();
		assert.strictEqual(order.length, 3);
		assert.throws(() => encoder.encode({ action: 'press', key: 'A' }), GhosttyDisposedError);
		assert.throws(() => other.encode({ action: 'press', key: 'A' }), GhosttyDisposedError);
		assert.throws(() => new GhosttyKeyEncoder(terminal), GhosttyDisposedError);
	});

	test('dispose frees everything it allocated', async () => {
		const live: Map<number, number> = new Map();
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_wasm_alloc: (len: number): number => {
				const ptr = exports.ghostty_wasm_alloc(len) >>> 0;
				live.set(ptr, len);
				return ptr;
			},
			ghostty_wasm_free: (ptr: number, len: number): void => {
				assert.strictEqual(live.get(ptr >>> 0), len, 'freed with its length');
				live.delete(ptr >>> 0);
				exports.ghostty_wasm_free(ptr, len);
			}
		}));
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		terminal.write('x');
		const before = new Set(live.keys());
		const encoder = new GhosttyKeyEncoder(terminal);
		encoder.encode({ action: 'press', key: 'UNIDENTIFIED', text: 'x'.repeat(500) });
		encoder.dispose();
		assert.deepEqual(new Set(live.keys()), before);
		terminal.dispose();
	});

	test('a constructor that fails partway frees what it made', async () => {
		const freed: Array<string> = [];
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_key_event_new: (): number => -1, // GHOSTTY_OUT_OF_MEMORY
			ghostty_key_encoder_free: (encoder: number): void => {
				freed.push('encoder');
				exports.ghostty_key_encoder_free(encoder);
			}
		}));
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		assert.throws(() => new GhosttyKeyEncoder(terminal), 'OUT_OF_MEMORY');
		assert.deepEqual(freed, ['encoder']);
		terminal.dispose();
	});

	test('once poisoned, nothing calls in: encodes refuse and dispose drops', async () => {
		const calls: Array<string> = [];
		let fail = false;
		const vt = await load_wrapped_ghostty_vt((exports) => {
			const wrapped: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(exports)) {
				if (typeof value !== 'function') continue;
				wrapped[name] = (...args: Array<unknown>): unknown => {
					calls.push(name);
					if (fail && name === 'ghostty_key_encoder_encode') throw new Error('a trap');
					return (value as (...a: Array<unknown>) => unknown)(...args);
				};
			}
			return wrapped;
		});
		const { terminal, encoder } = await create(vt);
		assert.strictEqual(decode(encoder.encode({ action: 'press', key: 'A', text: 'a' })), 'a');
		fail = true;
		assert.throws(() => encoder.encode({ action: 'press', key: 'A', text: 'a' }), 'a trap');
		assert.ok(vt.poisoned);
		calls.length = 0;
		assert.throws(
			() => encoder.encode({ action: 'press', key: 'A', text: 'a' }),
			GhosttyPoisonedError
		);
		assert.throws(() => new GhosttyKeyEncoder(terminal), GhosttyPoisonedError);
		encoder.dispose();
		terminal.dispose();
		assert.deepEqual(calls, []);
		assert.isTrue(encoder.disposed);
	});

	test('a module without the input_encode feature is refused at construction', async () => {
		const real = await load_test_ghostty_vt();
		const feature = real.manifest.enum_value('GhosttyBuildInfo', 'FEATURE_INPUT_ENCODE');
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_build_info: (data: number, out: number): number => {
				const result = exports.ghostty_build_info(data, out);
				if (data === feature) new Uint8Array(exports.memory.buffer)[out] = 0;
				return result;
			}
		}));
		assert.isFalse(vt.has_feature('input_encode'));
		const terminal = new GhosttyTerminal(vt, { cols: 20, rows: 2 });
		assert.throws(() => new GhosttyKeyEncoder(terminal), GhosttyLoadError, 'input_encode');
		terminal.dispose();
	});

	test('the module’s key enum is exactly the fixture’s, so an upgrade that changes it fails here', async () => {
		const vt = await load_test_ghostty_vt();
		const real = JSON.parse(vt.memory.read_c_string(vt.exports.ghostty_type_json() >>> 0));
		assert.deepEqual(real.types.GhosttyKey, GHOSTTY_MANIFEST_FIXTURE.types.GhosttyKey);
	});
});
