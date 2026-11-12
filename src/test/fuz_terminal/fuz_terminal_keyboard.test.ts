import { test, describe, assert } from 'vitest';

import {
	FUZ_TERMINAL_KEY_CODE_ALIASES,
	FUZ_TERMINAL_NUMPAD_NAVIGATION_KEYS,
	create_fuz_terminal_key_codes,
	get_fuz_terminal_consumed_mods,
	get_fuz_terminal_key_mods,
	get_fuz_terminal_key_text,
	get_fuz_terminal_unshifted_codepoint,
	is_fuz_terminal_key_composing,
	resolve_fuz_terminal_key_codes,
	should_fuz_terminal_pass_key,
	to_fuz_terminal_key_code,
	to_fuz_terminal_key_input,
	to_fuz_terminal_key_name,
	type FuzTerminalKeyboardEvent
} from '#lib/fuz_terminal/fuz_terminal_keyboard.ts';
import { to_fuz_terminal_key_platform } from '#lib/fuz_terminal/fuz_terminal_deps.ts';
import { GHOSTTY_KEY_MODS as M } from '#lib/fuz_terminal/ghostty_key_encoder.ts';
import { GhosttyManifest } from '#lib/fuz_terminal/ghostty_manifest.ts';

import { create_ghostty_manifest_fixture } from './ghostty_manifest_fixture.ts';

/** The fixture's `GhosttyKey` names, the module's whole key enum. */
const key_names = (): Array<string> =>
	Object.keys(create_ghostty_manifest_fixture().types.GhosttyKey.values).filter(
		(name) => name !== 'MAX_VALUE'
	);

const codes = resolve_fuz_terminal_key_codes(
	new GhosttyManifest(create_ghostty_manifest_fixture())
);

/** A keyboard event's fields; `locks` are what `getModifierState` reports on. */
const key_event = (
	code: string,
	key: string,
	options: Partial<Omit<FuzTerminalKeyboardEvent, 'code' | 'key' | 'getModifierState'>> & {
		locks?: ReadonlyArray<string>;
	} = {}
): FuzTerminalKeyboardEvent => {
	const { locks = [], ...rest } = options;
	return {
		code,
		key,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		repeat: false,
		isComposing: false,
		keyCode: 0,
		getModifierState: (name) => locks.includes(name),
		...rest
	};
};

describe('the code table', () => {
	test('every GhosttyKey is reached: by its code, or by a numpad code and key', () => {
		const names = key_names();
		const reached = new Set(codes.values());
		for (const name of names) assert.isTrue(reached.has(name), name);
		// and nothing else
		for (const name of reached) assert.include(names, name);
		// the explicit tables name only real keys
		for (const name of Object.values(FUZ_TERMINAL_KEY_CODE_ALIASES)) assert.include(names, name);
		for (const keys of Object.values(FUZ_TERMINAL_NUMPAD_NAVIGATION_KEYS)) {
			for (const name of Object.values(keys)) assert.include(names, name);
		}
	});

	test('the regular correspondence between names and codes', () => {
		const pairs: Array<[string, string]> = [
			['A', 'KeyA'],
			['Z', 'KeyZ'],
			['DIGIT_1', 'Digit1'],
			['BRACKET_LEFT', 'BracketLeft'],
			['F1', 'F1'],
			['F12', 'F12'],
			['F25', 'F25'],
			['NUMPAD_0', 'Numpad0'],
			['NUMPAD_ADD', 'NumpadAdd'],
			['NUMPAD_MEMORY_SUBTRACT', 'NumpadMemorySubtract'],
			['LAUNCH_APP_1', 'LaunchApp1'],
			['INTL_RO', 'IntlRo'],
			['META_LEFT', 'MetaLeft'],
			['CONTROL_RIGHT', 'ControlRight'],
			['AUDIO_VOLUME_UP', 'AudioVolumeUp'],
			['MEDIA_TRACK_PREVIOUS', 'MediaTrackPrevious'],
			['FN_LOCK', 'FnLock'],
			['UNIDENTIFIED', 'Unidentified']
		];
		for (const [name, code] of pairs) {
			assert.strictEqual(to_fuz_terminal_key_code(name), code, name);
			assert.strictEqual(codes.get(code), name, code);
		}
	});

	test('the numpad navigation keys have no code of their own', () => {
		for (const code of ['NumpadUp', 'NumpadEnd', 'NumpadBegin', 'NumpadPageUp', 'NumpadDelete']) {
			assert.isFalse(codes.has(code), code);
		}
	});

	test('only the names given are entered', () => {
		const some = create_fuz_terminal_key_codes(['A', 'NUMPAD_1', 'NUMPAD_END', 'META_LEFT']);
		assert.deepEqual(Object.fromEntries(some), {
			KeyA: 'A',
			MetaLeft: 'META_LEFT',
			OSLeft: 'META_LEFT',
			Numpad1: 'NUMPAD_1',
			'Numpad1 End': 'NUMPAD_END'
		});
	});
});

describe('to_fuz_terminal_key_name', () => {
	test('by code', () => {
		assert.strictEqual(to_fuz_terminal_key_name(key_event('KeyQ', 'a'), codes), 'Q');
		assert.strictEqual(to_fuz_terminal_key_name(key_event('Enter', 'Enter'), codes), 'ENTER');
		assert.strictEqual(
			to_fuz_terminal_key_name(key_event('NumpadEnter', 'Enter'), codes),
			'NUMPAD_ENTER'
		);
		assert.strictEqual(to_fuz_terminal_key_name(key_event('OSLeft', 'Meta'), codes), 'META_LEFT');
		assert.strictEqual(
			to_fuz_terminal_key_name(key_event('VolumeMute', 'AudioVolumeMute'), codes),
			'AUDIO_VOLUME_MUTE'
		);
	});

	test('the numpad by NumLock: the digit with it on, the navigation key with it off', () => {
		const cases: Array<[string, string, string]> = [
			['Numpad1', '1', 'NUMPAD_1'],
			['Numpad1', 'End', 'NUMPAD_END'],
			['Numpad5', '5', 'NUMPAD_5'],
			['Numpad5', 'Clear', 'NUMPAD_BEGIN'],
			['Numpad8', 'ArrowUp', 'NUMPAD_UP'],
			['Numpad0', 'Insert', 'NUMPAD_INSERT'],
			['NumpadDecimal', '.', 'NUMPAD_DECIMAL'],
			['NumpadDecimal', 'Delete', 'NUMPAD_DELETE'],
			['Numpad9', 'PageUp', 'NUMPAD_PAGE_UP']
		];
		for (const [code, key, name] of cases) {
			assert.strictEqual(to_fuz_terminal_key_name(key_event(code, key), codes), name, code + key);
		}
	});

	test('a code the library has no key for is UNIDENTIFIED', () => {
		for (const code of ['Lang1', 'NumpadUp', '', 'keya', 'Numpad']) {
			assert.strictEqual(
				to_fuz_terminal_key_name(key_event(code, 'x'), codes),
				'UNIDENTIFIED',
				code
			);
		}
	});
});

describe('get_fuz_terminal_key_text', () => {
	test('a named key, a dead key, or an IME-held key has no text', () => {
		for (const key of [
			'Enter',
			'Tab',
			'Backspace',
			'Escape',
			'Delete',
			'ArrowUp',
			'F1',
			'F12',
			'Shift',
			'Control',
			'Alt',
			'AltGraph',
			'Meta',
			'CapsLock',
			'Dead',
			'Process',
			'Unidentified',
			'Compose',
			'AudioVolumeUp',
			''
		]) {
			assert.strictEqual(get_fuz_terminal_key_text(key_event('KeyA', key)), '', key);
		}
	});

	test('control characters and macOS function-key code points are never text', () => {
		for (const key of ['\r', '\t', '\u0000', '\u001b', '\u007f', '\u0085', '', '']) {
			assert.strictEqual(
				get_fuz_terminal_key_text(key_event('KeyA', key)),
				'',
				JSON.stringify(key)
			);
		}
	});

	test('a character is its own text, however many code units', () => {
		for (const key of ['a', 'A', 'F', 'Z', '1', '!', ' ', 'é', 'é', '中', 'ß', '😀', '👍🏽']) {
			assert.strictEqual(get_fuz_terminal_key_text(key_event('KeyA', key)), key, key);
		}
	});
});

describe('get_fuz_terminal_key_mods', () => {
	const mods = (event: FuzTerminalKeyboardEvent, platform: 'mac' | 'other' = 'other'): number =>
		get_fuz_terminal_key_mods(event, get_fuz_terminal_key_text(event), platform);

	test('each modifier, and the locks from getModifierState', () => {
		assert.strictEqual(mods(key_event('KeyA', 'a')), 0);
		assert.strictEqual(mods(key_event('KeyA', 'A', { shiftKey: true })), M.shift);
		assert.strictEqual(mods(key_event('KeyA', 'a', { ctrlKey: true })), M.ctrl);
		assert.strictEqual(mods(key_event('KeyA', 'a', { altKey: true })), M.alt);
		assert.strictEqual(mods(key_event('KeyA', 'a', { metaKey: true })), M.super);
		assert.strictEqual(
			mods(key_event('KeyA', 'A', { shiftKey: true, ctrlKey: true, altKey: true, metaKey: true })),
			M.shift | M.ctrl | M.alt | M.super
		);
		assert.strictEqual(mods(key_event('KeyA', 'A', { locks: ['CapsLock'] })), M.caps_lock);
		assert.strictEqual(mods(key_event('Numpad1', '1', { locks: ['NumLock'] })), M.num_lock);
		// no getModifierState: the locks read as off
		const { getModifierState: _, ...bare } = key_event('KeyA', 'A');
		assert.strictEqual(mods(bare), 0);
	});

	test('a side bit on a right-hand modifier’s own keydown only', () => {
		assert.strictEqual(
			mods(key_event('ShiftRight', 'Shift', { shiftKey: true })),
			M.shift | M.shift_right
		);
		assert.strictEqual(
			mods(key_event('ControlRight', 'Control', { ctrlKey: true })),
			M.ctrl | M.ctrl_right
		);
		assert.strictEqual(mods(key_event('AltRight', 'Alt', { altKey: true })), M.alt | M.alt_right);
		assert.strictEqual(
			mods(key_event('MetaRight', 'Meta', { metaKey: true })),
			M.super | M.super_right
		);
		assert.strictEqual(mods(key_event('ShiftLeft', 'Shift', { shiftKey: true })), M.shift);
		// its keyup: the modifier is already off, so no side either
		assert.strictEqual(mods(key_event('ShiftRight', 'Shift')), 0);
		// another key while right shift is held: the side isn't known
		assert.strictEqual(mods(key_event('KeyA', 'A', { shiftKey: true })), M.shift);
	});

	test('on macOS, Option that made text with neither Ctrl nor Meta isn’t Alt', () => {
		const option = { altKey: true };
		// German Mac: Option+5 is `[`, Option+L `@`; Option+Shift+7 `\\`
		assert.strictEqual(mods(key_event('Digit5', '[', option), 'mac'), 0);
		assert.strictEqual(mods(key_event('KeyL', '@', option), 'mac'), 0);
		assert.strictEqual(
			mods(key_event('Digit7', '\\', { ...option, shiftKey: true }), 'mac'),
			M.shift
		);
		assert.strictEqual(mods(key_event('KeyA', 'Å', { ...option, shiftKey: true }), 'mac'), M.shift);
		// Option alone makes no text: Alt, with its side
		assert.strictEqual(mods(key_event('AltRight', 'Alt', option), 'mac'), M.alt | M.alt_right);
		// no text: Option+Left stays Alt+Left
		assert.strictEqual(mods(key_event('ArrowLeft', 'ArrowLeft', option), 'mac'), M.alt);
		// with Ctrl or Meta, Option is a modifier
		assert.strictEqual(
			mods(key_event('KeyA', 'a', { ...option, ctrlKey: true }), 'mac'),
			M.alt | M.ctrl
		);
		assert.strictEqual(
			mods(key_event('KeyA', 'å', { ...option, metaKey: true }), 'mac'),
			M.alt | M.super
		);
		// elsewhere, Alt is Alt
		assert.strictEqual(mods(key_event('Digit5', '[', option), 'other'), M.alt);
		assert.strictEqual(mods(key_event('KeyA', 'å', option), 'other'), M.alt);
	});

	test('AltGraph making the text drops Ctrl and Alt (Windows reports them with it)', () => {
		const alt_gr = { ctrlKey: true, altKey: true, locks: ['AltGraph'] };
		assert.strictEqual(mods(key_event('KeyQ', '@', alt_gr)), 0);
		assert.strictEqual(
			mods(key_event('KeyE', '€', { ...alt_gr, shiftKey: true })),
			M.shift,
			'shift stays'
		);
		// without text, AltGraph changes nothing
		assert.strictEqual(mods(key_event('F1', 'F1', alt_gr)), M.ctrl | M.alt);
		// AltGr alone (on Linux: AltRight, no altKey)
		assert.strictEqual(mods(key_event('AltRight', 'AltGraph', { locks: ['AltGraph'] })), 0);
	});
});

describe('get_fuz_terminal_unshifted_codepoint', () => {
	const unshifted = (event: FuzTerminalKeyboardEvent): string =>
		String.fromCodePoint(
			get_fuz_terminal_unshifted_codepoint(event, get_fuz_terminal_key_text(event))
		);

	test('letters, lowercased whatever made them uppercase', () => {
		assert.strictEqual(unshifted(key_event('KeyA', 'a')), 'a');
		assert.strictEqual(unshifted(key_event('KeyA', 'A', { shiftKey: true })), 'a');
		assert.strictEqual(unshifted(key_event('KeyA', 'A', { locks: ['CapsLock'] })), 'a');
		assert.strictEqual(unshifted(key_event('KeyA', 'a', { ctrlKey: true })), 'a');
	});

	test('digits and punctuation: the key’s own text unshifted, the US character shifted', () => {
		const cases: Array<[string, string, string]> = [
			['Digit1', '1', '1'],
			['Digit1', '!', '1'],
			['Digit2', '@', '2'],
			['Minus', '_', '-'],
			['Equal', '+', '='],
			['BracketLeft', '{', '['],
			['BracketRight', '}', ']'],
			['Backslash', '|', '\\'],
			['Semicolon', ':', ';'],
			['Quote', '"', "'"],
			['Comma', '<', ','],
			['Period', '>', '.'],
			['Slash', '?', '/'],
			['Backquote', '~', '`']
		];
		for (const [code, shifted, expected] of cases) {
			assert.strictEqual(unshifted(key_event(code, shifted, { shiftKey: true })), expected, code);
			assert.strictEqual(unshifted(key_event(code, expected)), expected, `${code} unshifted`);
		}
		assert.strictEqual(unshifted(key_event('Space', ' ')), ' ');
		assert.strictEqual(unshifted(key_event('Space', ' ', { shiftKey: true })), ' ');
	});

	test('another layout: its own characters where the event shows them, else the US one', () => {
		// AZERTY: the key where US has Q makes `a`
		assert.strictEqual(unshifted(key_event('KeyQ', 'a', { ctrlKey: true })), 'a');
		assert.strictEqual(unshifted(key_event('KeyQ', 'A', { shiftKey: true })), 'a');
		// Russian: Cyrillic letters, shifted or not
		assert.strictEqual(unshifted(key_event('KeyC', 'с')), 'с');
		assert.strictEqual(unshifted(key_event('KeyC', 'С', { shiftKey: true })), 'с');
		// AZERTY's digit row: `&` unshifted is its own; shifted, `1` is the layout's too
		assert.strictEqual(unshifted(key_event('Digit1', '&')), '&');
		// German: Shift+7 is `/`, and the US character is right for it
		assert.strictEqual(unshifted(key_event('Digit7', '/', { shiftKey: true })), '7');
		// a German key a US layout has elsewhere: shifted, the US character is wrong
		assert.strictEqual(unshifted(key_event('Minus', '?', { shiftKey: true })), '-');
		// Alt may transform the text (macOS Option): the physical key's
		assert.strictEqual(unshifted(key_event('KeyA', 'å', { altKey: true })), 'a');
	});

	test('keys with no character: 0', () => {
		for (const [code, key] of [
			['F1', 'F1'],
			['Enter', 'Enter'],
			['ArrowUp', 'ArrowUp'],
			['ShiftLeft', 'Shift'],
			['Lang1', 'Unidentified']
		] as const) {
			const event = key_event(code, key);
			assert.strictEqual(get_fuz_terminal_unshifted_codepoint(event, ''), 0, code);
		}
	});

	test('a key the US table hasn’t: the text’s own character, lowercased', () => {
		assert.strictEqual(unshifted(key_event('IntlBackslash', '<')), '<');
		assert.strictEqual(unshifted(key_event('IntlBackslash', '>', { shiftKey: true })), '>');
		assert.strictEqual(unshifted(key_event('IntlRo', '_', { shiftKey: true })), '_');
		assert.strictEqual(unshifted(key_event('IntlYen', '¥')), '¥');
		assert.strictEqual(unshifted(key_event('', '>', { shiftKey: true })), '>');
		assert.strictEqual(unshifted(key_event('', 'Ä', { shiftKey: true })), 'ä');
		// still nothing for no text
		assert.strictEqual(get_fuz_terminal_unshifted_codepoint(key_event('IntlRo', 'Dead'), ''), 0);
	});

	test('the numpad’s characters', () => {
		assert.strictEqual(unshifted(key_event('Numpad7', '7')), '7');
		assert.strictEqual(unshifted(key_event('Numpad7', 'Home')), '7');
		assert.strictEqual(unshifted(key_event('NumpadAdd', '+')), '+');
	});
});

describe('get_fuz_terminal_consumed_mods', () => {
	const consumed = (event: FuzTerminalKeyboardEvent): number => {
		const text = get_fuz_terminal_key_text(event);
		return get_fuz_terminal_consumed_mods(
			event,
			get_fuz_terminal_key_mods(event, text, 'other'),
			text
		);
	};

	test('Shift whenever it’s held and the key made text', () => {
		assert.strictEqual(consumed(key_event('KeyA', 'A', { shiftKey: true })), M.shift);
		// CapsLock and Shift: lowercase text, Shift still used up
		assert.strictEqual(
			consumed(key_event('KeyA', 'a', { shiftKey: true, locks: ['CapsLock'] })),
			M.shift
		);
		// AZERTY: Shift+& is 1, the same character as the US fallback
		assert.strictEqual(consumed(key_event('Digit1', '1', { shiftKey: true })), M.shift);
		assert.strictEqual(consumed(key_event('Digit1', '!', { shiftKey: true })), M.shift);
		assert.strictEqual(
			consumed(key_event('KeyA', 'A', { shiftKey: true, ctrlKey: true })),
			M.shift
		);
	});

	test('not on Space or the numpad, not without text, and not without Shift', () => {
		assert.strictEqual(consumed(key_event('Space', ' ', { shiftKey: true })), 0);
		assert.strictEqual(
			consumed(key_event('Numpad1', '1', { shiftKey: true, locks: ['NumLock'] })),
			0
		);
		assert.strictEqual(consumed(key_event('NumpadAdd', '+', { shiftKey: true })), 0);
		assert.strictEqual(consumed(key_event('Tab', 'Tab', { shiftKey: true })), 0);
		assert.strictEqual(consumed(key_event('KeyA', 'a')), 0);
		assert.strictEqual(consumed(key_event('KeyA', 'A', { locks: ['CapsLock'] })), 0);
	});

	test('Alt is never used up', () => {
		assert.strictEqual(consumed(key_event('Digit5', '[', { altKey: true })), 0);
		assert.strictEqual(consumed(key_event('KeyA', 'a', { altKey: true })), 0);
		assert.strictEqual(consumed(key_event('KeyA', 'A', { altKey: true, shiftKey: true })), M.shift);
	});
});

describe('to_fuz_terminal_key_platform', () => {
	test('macOS and iOS are mac, by the client hints first, then navigator.platform', () => {
		assert.strictEqual(to_fuz_terminal_key_platform({ platform: 'MacIntel' }), 'mac');
		assert.strictEqual(to_fuz_terminal_key_platform({ platform: 'iPhone' }), 'mac');
		assert.strictEqual(to_fuz_terminal_key_platform({ platform: 'iPad' }), 'mac');
		assert.strictEqual(
			to_fuz_terminal_key_platform({ platform: 'Win32', userAgentData: { platform: 'macOS' } }),
			'mac'
		);
		assert.strictEqual(
			to_fuz_terminal_key_platform({ platform: 'MacIntel', userAgentData: { platform: '' } }),
			'mac'
		);
		assert.strictEqual(
			to_fuz_terminal_key_platform({ platform: 'MacIntel', userAgentData: { platform: 'Linux' } }),
			'other'
		);
	});

	test('anything else, or nothing to read, is other', () => {
		for (const platform of ['Linux x86_64', 'Win32', 'Linux armv81', '']) {
			assert.strictEqual(to_fuz_terminal_key_platform({ platform }), 'other', platform);
		}
		assert.strictEqual(to_fuz_terminal_key_platform({}), 'other');
		assert.strictEqual(to_fuz_terminal_key_platform(undefined), 'other');
	});
});

describe('is_fuz_terminal_key_composing', () => {
	test('an IME composition, an IME-held key, and a dead key compose', () => {
		assert.isTrue(is_fuz_terminal_key_composing(key_event('KeyA', 'a', { isComposing: true })));
		assert.isTrue(is_fuz_terminal_key_composing(key_event('KeyA', 'Process')));
		assert.isTrue(is_fuz_terminal_key_composing(key_event('KeyA', 'a', { keyCode: 229 })));
		assert.isTrue(is_fuz_terminal_key_composing(key_event('Quote', 'Dead')));
	});

	test('anything else doesn’t, the composed character included', () => {
		assert.isFalse(is_fuz_terminal_key_composing(key_event('KeyE', 'é', { keyCode: 69 })));
		assert.isFalse(is_fuz_terminal_key_composing(key_event('Enter', 'Enter', { keyCode: 13 })));
		const { keyCode: _, ...no_key_code } = key_event('KeyA', 'a');
		assert.isFalse(is_fuz_terminal_key_composing(no_key_code));
	});
});

describe('should_fuz_terminal_pass_key', () => {
	test('every Meta combination, Meta alone included', () => {
		for (const event of [
			key_event('MetaLeft', 'Meta', { metaKey: true }),
			key_event('KeyC', 'c', { metaKey: true }),
			key_event('KeyV', 'v', { metaKey: true }),
			key_event('KeyZ', 'Z', { metaKey: true, shiftKey: true }),
			key_event('Tab', 'Tab', { metaKey: true }),
			key_event('ArrowLeft', 'ArrowLeft', { metaKey: true, ctrlKey: true }),
			key_event('KeyQ', 'q', { metaKey: true, altKey: true })
		]) {
			assert.isTrue(should_fuz_terminal_pass_key(event, 'other'), `${event.code} ${event.key}`);
		}
	});

	test('Ctrl+Shift+C and Ctrl+Shift+V, by the layout’s letter or the physical key', () => {
		const ctrl_shift = { ctrlKey: true, shiftKey: true };
		for (const event of [
			key_event('KeyC', 'C', ctrl_shift),
			key_event('KeyV', 'V', ctrl_shift),
			// their keyups, with the modifiers still held
			key_event('KeyC', 'C', ctrl_shift),
			// Dvorak: C is where US has I
			key_event('KeyI', 'C', ctrl_shift),
			// Russian: no Latin letter, so the physical key
			key_event('KeyC', 'С', ctrl_shift),
			key_event('KeyV', 'М', ctrl_shift),
			// CapsLock or not
			key_event('KeyC', 'c', ctrl_shift)
		]) {
			assert.isTrue(should_fuz_terminal_pass_key(event, 'other'), `${event.code} ${event.key}`);
		}
	});

	test('the browser’s page zoom, by the layout’s character, Shift or not', () => {
		const ctrl = { ctrlKey: true };
		const ctrl_shift = { ctrlKey: true, shiftKey: true };
		for (const event of [
			key_event('Equal', '=', ctrl),
			key_event('Minus', '-', ctrl),
			key_event('Digit0', '0', ctrl),
			// Ctrl++ and Ctrl+_ on a US layout
			key_event('Equal', '+', ctrl_shift),
			key_event('Minus', '_', ctrl_shift),
			// the numpad, NumLock on
			key_event('NumpadAdd', '+', ctrl),
			key_event('NumpadSubtract', '-', ctrl),
			key_event('Numpad0', '0', ctrl),
			// German: + and - on other physical keys, = on Shift+0
			key_event('BracketRight', '+', ctrl),
			key_event('Slash', '-', ctrl),
			key_event('Digit0', '=', ctrl_shift)
		]) {
			assert.isTrue(should_fuz_terminal_pass_key(event, 'other'), `${event.code} ${event.key}`);
		}
	});

	test('on macOS the zoom keys with Ctrl are the program’s; Cmd’s zoom passes as Meta', () => {
		for (const event of [
			key_event('Equal', '=', { ctrlKey: true }),
			key_event('Minus', '-', { ctrlKey: true }),
			key_event('Digit0', '0', { ctrlKey: true }),
			key_event('Minus', '_', { ctrlKey: true, shiftKey: true })
		]) {
			assert.isFalse(should_fuz_terminal_pass_key(event, 'mac'), `${event.code} ${event.key}`);
		}
		assert.isTrue(should_fuz_terminal_pass_key(key_event('Equal', '=', { metaKey: true }), 'mac'));
		// Ctrl+Shift+C and V pass on every platform
		assert.isTrue(
			should_fuz_terminal_pass_key(key_event('KeyC', 'C', { ctrlKey: true, shiftKey: true }), 'mac')
		);
	});

	test('everything else is the program’s', () => {
		for (const event of [
			key_event('KeyC', 'c', { ctrlKey: true }),
			key_event('KeyV', 'v', { ctrlKey: true }),
			key_event('KeyW', 'w', { ctrlKey: true }),
			key_event('KeyT', 't', { ctrlKey: true }),
			key_event('KeyA', 'A', { ctrlKey: true, shiftKey: true }),
			key_event('KeyC', 'C', { ctrlKey: true, shiftKey: true, altKey: true }),
			key_event('KeyC', 'C', { shiftKey: true }),
			// Dvorak: the physical C key makes J
			key_event('KeyC', 'J', { ctrlKey: true, shiftKey: true }),
			key_event('Tab', 'Tab'),
			key_event('Tab', 'Tab', { shiftKey: true }),
			key_event('Escape', 'Escape'),
			key_event('F5', 'F5'),
			key_event('F4', 'F4', { altKey: true }),
			key_event('KeyL', 'l', { ctrlKey: true }),
			key_event('ControlLeft', 'Control', { ctrlKey: true }),
			// the zoom characters without Ctrl, or with Alt (AltGr on Windows)
			key_event('Equal', '=', {}),
			key_event('Minus', '-', { altKey: true }),
			key_event('Equal', '=', { ctrlKey: true, altKey: true }),
			key_event('Digit0', '0', { ctrlKey: true, altKey: true }),
			// Ctrl+digit, Ctrl+Shift+0 on a US layout, the numpad's 0 with NumLock off
			key_event('Digit1', '1', { ctrlKey: true }),
			key_event('Digit9', '9', { ctrlKey: true }),
			key_event('Digit0', ')', { ctrlKey: true, shiftKey: true }),
			key_event('Numpad0', 'Insert', { ctrlKey: true }),
			// German: the US minus key types ß, which isn't a zoom key
			key_event('Minus', 'ß', { ctrlKey: true }),
			key_event('Slash', '/', { ctrlKey: true })
		]) {
			assert.isFalse(should_fuz_terminal_pass_key(event, 'other'), `${event.code} ${event.key}`);
		}
	});
});

describe('to_fuz_terminal_key_input', () => {
	test('a letter, shifted: shift used up making its text', () => {
		assert.deepEqual(
			to_fuz_terminal_key_input(
				key_event('KeyA', 'A', { shiftKey: true }),
				'press',
				codes,
				'other'
			),
			{
				action: 'press',
				key: 'A',
				mods: M.shift,
				consumed_mods: M.shift,
				text: 'A',
				unshifted_codepoint: 97,
				composing: false
			}
		);
	});

	test('Shift+Space and Shift+Tab keep their shift', () => {
		const space = to_fuz_terminal_key_input(
			key_event('Space', ' ', { shiftKey: true }),
			'press',
			codes,
			'other'
		);
		assert.strictEqual(space.consumed_mods, 0);
		assert.strictEqual(space.mods, M.shift);
		const tab = to_fuz_terminal_key_input(
			key_event('Tab', 'Tab', { shiftKey: true }),
			'press',
			codes,
			'other'
		);
		assert.deepEqual(tab, {
			action: 'press',
			key: 'TAB',
			mods: M.shift,
			consumed_mods: 0,
			text: '',
			unshifted_codepoint: 0,
			composing: false
		});
	});

	test('Ctrl+C: the letter as text, for the encoder to control', () => {
		assert.deepEqual(
			to_fuz_terminal_key_input(
				key_event('KeyC', 'c', { ctrlKey: true }),
				'repeat',
				codes,
				'other'
			),
			{
				action: 'repeat',
				key: 'C',
				mods: M.ctrl,
				consumed_mods: 0,
				text: 'c',
				unshifted_codepoint: 99,
				composing: false
			}
		);
	});

	test('the platform: on macOS, Option that typed a character isn’t Alt', () => {
		const event = key_event('Digit5', '[', { altKey: true });
		const mac = to_fuz_terminal_key_input(event, 'press', codes, 'mac');
		assert.strictEqual(mac.mods, 0);
		assert.strictEqual(mac.consumed_mods, 0);
		assert.strictEqual(mac.unshifted_codepoint, 53);
		assert.strictEqual(to_fuz_terminal_key_input(event, 'press', codes, 'other').mods, M.alt);
	});

	test('a shifted digit, a release, and a dead key’s composed character', () => {
		const bang = to_fuz_terminal_key_input(
			key_event('Digit1', '!', { shiftKey: true }),
			'release',
			codes,
			'other'
		);
		assert.strictEqual(bang.action, 'release');
		assert.strictEqual(bang.key, 'DIGIT_1');
		assert.strictEqual(bang.consumed_mods, M.shift);
		assert.strictEqual(bang.unshifted_codepoint, 49);
		const composed = to_fuz_terminal_key_input(key_event('KeyE', 'é'), 'press', codes, 'other');
		assert.strictEqual(composed.key, 'E');
		assert.strictEqual(composed.text, 'é');
		assert.strictEqual(composed.mods, 0);
	});
});
