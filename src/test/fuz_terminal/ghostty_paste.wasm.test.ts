import { test, describe, assert } from 'vitest';

import { GhosttyDisposedError, GhosttyReentrancyError } from '#lib/fuz_terminal/ghostty_errors.ts';
import {
	GHOSTTY_MODE_BRACKETED_PASTE,
	get_ghostty_paste_hazard,
	type GhosttyPasteEncoding,
	type GhosttyPasteRisk
} from '#lib/fuz_terminal/ghostty_paste.ts';
import { GhosttyTerminal } from '#lib/fuz_terminal/ghostty_terminal.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

import { load_test_ghostty_vt, load_wrapped_ghostty_vt } from './ghostty_vt_test_helpers.ts';

const ESC = '\x1b';
const BRACKET_ON = `${ESC}[?2004h`;
const BRACKET_OFF = `${ESC}[?2004l`;
const START = `${ESC}[200~`;
const END = `${ESC}[201~`;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const create = async (vt?: GhosttyVt): Promise<GhosttyTerminal> =>
	new GhosttyTerminal(vt ?? (await load_test_ghostty_vt()), { cols: 20, rows: 4 });

/** The encoded bytes as text, failing unless the paste was encoded. */
const encoded_text = (encoding: GhosttyPasteEncoding): string => {
	assert.strictEqual(encoding.kind, 'encoded', JSON.stringify(encoding));
	assert(encoding.kind === 'encoded');
	return decoder.decode(encoding.bytes);
};

/** The risks a host passes back once the person confirms (`GhosttyPasteOptions.allow_unsafe`). */
const LINE_BREAK: GhosttyPasteRisk = { hazard: 'line_break', bracketed: false };
const PASTE_END: GhosttyPasteRisk = { hazard: 'paste_end', bracketed: false };
const PASTE_END_BRACKETED: GhosttyPasteRisk = { hazard: 'paste_end', bracketed: true };

/**
 * Encode `text` as a confirmed paste: allowing the risk a first encode
 * reports, as a host does once the person says yes.
 */
const encode_confirmed = (terminal: GhosttyTerminal, text: string): GhosttyPasteEncoding => {
	const first = terminal.encode_paste(text);
	if (first.kind !== 'rejected') return first;
	return terminal.encode_paste(text, {
		allow_unsafe: { hazard: first.hazard, bracketed: first.bracketed }
	});
};

/** The raw exports the binding doesn't call, for checking it against the library. */
interface LibraryPasteExports {
	ghostty_paste_is_safe: (data: number, len: number) => number;
	ghostty_terminal_paste: (terminal: number, paste: number, out_pasted: number) => number;
	__indirect_function_table: WebAssembly.Table;
}

/** The text the reader callback hands the library: set per call, read inside it. */
let reader_data = new Uint8Array();
let reader_ptr = 0;
/** One reader callback per module instance, so repeated calls don't grow its function table. */
const readers: WeakMap<GhosttyVt, number> = new WeakMap();

/**
 * What the library's own `ghostty_terminal_paste` does with `text` on this
 * terminal: the bytes it streams through `write_pty`, or its refusal. Its
 * text is read through a `GhosttyMimeReader` callback, written to the
 * library's writer from inside the callback.
 */
const library_paste = (
	terminal: GhosttyTerminal,
	text: string,
	allow_unsafe: boolean
): { result: string; pasted: boolean; bytes: Uint8Array } => {
	const { vt } = terminal;
	const { memory, manifest } = vt;
	const exports = vt.exports as unknown as LibraryPasteExports;
	const chunks: Array<Uint8Array> = [];
	terminal.set_effect('write_pty', (data) => chunks.push(data));
	const data = encoder.encode(text);
	const mime = encoder.encode('text/plain');
	const data_ptr = memory.alloc(Math.max(1, data.length));
	const mime_ptr = memory.alloc(mime.length);
	const string_size = manifest.struct_size('GhosttyString');
	const strings = memory.alloc(string_size);
	const paste_size = manifest.struct_size('GhosttyPaste');
	const paste = memory.alloc(paste_size);
	const out_pasted = memory.alloc(1);
	memory.write_bytes(data_ptr, data);
	memory.write_bytes(mime_ptr, mime);
	const field = (struct: string, name: string): number =>
		manifest.struct_field(struct, name).offset;
	memory.write_scalar(strings + field('GhosttyString', 'ptr'), 'u32', mime_ptr);
	memory.write_scalar(strings + field('GhosttyString', 'len'), 'u32', mime.length);
	reader_data = data;
	reader_ptr = data_ptr;
	// the reader: GhosttyString and GhosttyWriter by value arrive as pointers
	let reader = readers.get(vt);
	if (reader === undefined) {
		reader = vt.callbacks.add(
			(_userdata: number, _mime: number, writer: number): number => {
				const write_fn = memory.read_scalar(writer + field('GhosttyWriter', 'write'), 'u32');
				const write_userdata = memory.read_scalar(
					writer + field('GhosttyWriter', 'userdata'),
					'u32'
				);
				if (reader_data.length === 0) return 1;
				const write = exports.__indirect_function_table.get(write_fn) as (
					userdata: number,
					ptr: number,
					len: number
				) => number;
				return write(write_userdata, reader_ptr, reader_data.length);
			},
			{ params: ['i32', 'i32', 'i32'], results: ['i32'] }
		);
		readers.set(vt, reader);
	}
	memory.bytes().fill(0, paste, paste + paste_size);
	memory.write_scalar(paste + field('GhosttyPaste', 'size'), 'u32', paste_size);
	memory.write_scalar(
		paste + field('GhosttyPaste', 'location'),
		'i32',
		manifest.enum_value('GhosttyClipboardLocation', 'STANDARD')
	);
	memory.write_scalar(
		paste + field('GhosttyPaste', 'source'),
		'i32',
		manifest.enum_value('GhosttyPasteSource', 'CLIPBOARD')
	);
	memory.write_scalar(paste + field('GhosttyPaste', 'mimes'), 'u32', strings);
	memory.write_scalar(paste + field('GhosttyPaste', 'mimes_len'), 'u32', 1);
	const reader_offset = field('GhosttyPaste', 'reader');
	memory.write_scalar(paste + reader_offset + field('GhosttyMimeReader', 'read'), 'u32', reader);
	memory.write_scalar(paste + field('GhosttyPaste', 'allow_unsafe'), 'bool', allow_unsafe ? 1 : 0);
	memory.write_scalar(out_pasted, 'bool', 0);
	const code = exports.ghostty_terminal_paste(terminal.handle('test'), paste, out_pasted);
	const pasted = memory.read_scalar(out_pasted, 'bool') !== 0;
	for (const [ptr, len] of [
		[data_ptr, Math.max(1, data.length)],
		[mime_ptr, mime.length],
		[strings, string_size],
		[paste, paste_size],
		[out_pasted, 1]
	] as const) {
		memory.free(ptr, len);
	}
	terminal.set_effect('write_pty', null);
	const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { result: vt.result_name(code), pasted, bytes };
};

/** The library's state-free check, `ghostty_paste_is_safe`. */
const library_is_safe = (vt: GhosttyVt, text: string): boolean => {
	const data = encoder.encode(text);
	const exports = vt.exports as unknown as LibraryPasteExports;
	return vt.memory.with_scratch(Math.max(1, data.length), (ptr) => {
		vt.memory.write_bytes(ptr, data);
		return exports.ghostty_paste_is_safe(ptr, data.length) !== 0;
	});
};

/**
 * Assert the binding does with `text` what `ghostty_terminal_paste` does on
 * this terminal: it refuses what the library refuses, encodes the same bytes,
 * and its `length` — a rejection's too — is the encoded bytes' as text.
 * `allow_unsafe` is the library's flag, met by the binding the way a host
 * meets it: allowing the risk its first encode reports.
 */
const assert_matches_library = (
	terminal: GhosttyTerminal,
	text: string,
	allow_unsafe: boolean,
	label: string
): void => {
	const ours = allow_unsafe ? encode_confirmed(terminal, text) : terminal.encode_paste(text);
	const theirs = library_paste(terminal, text, allow_unsafe);
	if (ours.kind === 'rejected') {
		assert.isFalse(allow_unsafe, label);
		assert.strictEqual(theirs.result, 'REJECTED', label);
		assert.strictEqual(theirs.bytes.length, 0, label);
		// what the paste would send, were it allowed
		const allowed = library_paste(terminal, text, true);
		assert.strictEqual(ours.length, decoder.decode(allowed.bytes).length, label);
	} else if (ours.kind === 'empty') {
		assert.strictEqual(theirs.result, 'SUCCESS', label);
		assert.isFalse(theirs.pasted, label);
	} else {
		assert.strictEqual(theirs.result, 'SUCCESS', label);
		assert.isTrue(theirs.pasted, label);
		assert.deepEqual(ours.bytes, theirs.bytes, label);
		assert.strictEqual(ours.length, decoder.decode(ours.bytes).length, label);
	}
	if (!allow_unsafe) {
		const bracketed = terminal.get_mode(GHOSTTY_MODE_BRACKETED_PASTE);
		assert.strictEqual(
			get_ghostty_paste_hazard(text, bracketed) !== null,
			ours.kind === 'rejected',
			label
		);
	}
};

/**
 * Texts that probe the rule and the encoder: line terminators, the end
 * sequence whole and in pieces, each stripped control byte, other C0 bytes
 * the encoder keeps, and multi-byte text.
 */
const CORPUS: ReadonlyArray<string> = [
	'hello',
	'hello world\t!',
	'a\nb',
	'a\rb',
	'a\r\nb',
	'trailing\n',
	'\n',
	'\r',
	`he${END}llo`,
	END,
	`a\n${END}rm -rf ~\n`,
	`${ESC}[201`,
	`${ESC}[200~inner`,
	`${ESC}x`,
	'[201~',
	'\x00\x08\x05\x04\x1b\x7f',
	'\x03\x1c\x15\x1a\x11\x13\x17\x16\x12\x0f',
	'\x01\x02\x06\x07\x0b\x0c\x0e\x10\x14\x18\x19\x1d\x1e\x1f',
	'\x09\x0a\x0d',
	'\u0085  ',
	'你好 é 🙂 नमस्ते',
	'lone \ud800 surrogate',
	'x'.repeat(70_000)
];

/** How many random texts each mode gets: kept small enough to run in every `gro test`. */
const FUZZ_CASES = 1000;

/**
 * The pieces random texts are made of: the end sequence whole and in pieces,
 * line terminators, stripped and kept control bytes, C1 controls (whose UTF-8
 * holds bytes the strip list must not match), and multi-byte text.
 */
const FUZZ_ALPHABET: ReadonlyArray<string> = [
	'\r',
	'\n',
	'\r\n',
	ESC,
	'[',
	'2',
	'0',
	'1',
	'~',
	END,
	START,
	'\x9b',
	'\x9b201~',
	'\x00',
	'\x7f',
	'\x03',
	'\x1a',
	'\t',
	'a',
	' ',
	'é',
	'你',
	'🙂',
	'\ud800',
	'\udfff',
	'\u0085',
	'\u00a0',
	`${ESC}${ESC}`,
	// U+00C2, whose code unit is the byte that leads a C1 control in UTF-8 (it
	// encodes as C3 82)
	'\xc2',
	'ě'
];

/** A seeded PRNG (mulberry32), so a failure reproduces. */
const create_random = (seed: number): (() => number) => {
	let state = seed | 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

describe('GhosttyTerminal.encode_paste', () => {
	test('plain text is sent as itself, unframed', async () => {
		const terminal = await create();
		const encoding = terminal.encode_paste('echo hi');
		assert.strictEqual(encoded_text(encoding), 'echo hi');
		assert.isFalse(encoding.kind === 'encoded' && encoding.bracketed);
		terminal.dispose();
	});

	test('bracketed paste frames the text once the program turns it on', async () => {
		const terminal = await create();
		assert.isFalse(terminal.get_mode(GHOSTTY_MODE_BRACKETED_PASTE));
		terminal.write(BRACKET_ON);
		assert.isTrue(terminal.get_mode(GHOSTTY_MODE_BRACKETED_PASTE));
		const encoding = terminal.encode_paste('line one\nline two\r\nthree');
		assert.strictEqual(encoded_text(encoding), `${START}line one\nline two\r\nthree${END}`);
		assert.isTrue(encoding.kind === 'encoded' && encoding.bracketed);
		terminal.write(BRACKET_OFF);
		assert.strictEqual(encoded_text(terminal.encode_paste('x')), 'x');
		terminal.dispose();
	});

	test('a line break unbracketed is refused, and when allowed each newline is a carriage return', async () => {
		const terminal = await create();
		for (const text of ['a\nb', 'a\rb', 'one line\n']) {
			assert.deepEqual(terminal.encode_paste(text), {
				kind: 'rejected',
				hazard: 'line_break',
				bracketed: false,
				length: text.length
			});
		}
		assert.strictEqual(
			encoded_text(terminal.encode_paste('a\nb', { allow_unsafe: LINE_BREAK })),
			'a\rb'
		);
		// `\r\n` becomes `\r\r`, as in xterm
		assert.strictEqual(
			encoded_text(terminal.encode_paste('a\r\nb\n', { allow_unsafe: LINE_BREAK })),
			'a\r\rb\r'
		);
		terminal.dispose();
	});

	test('the end sequence is refused in both modes, and defused when allowed', async () => {
		const terminal = await create();
		const text = `ok${END}rm -rf ~`;
		assert.deepEqual(terminal.encode_paste(text), {
			kind: 'rejected',
			hazard: 'paste_end',
			bracketed: false,
			length: text.length
		});
		terminal.write(BRACKET_ON);
		assert.deepEqual(terminal.encode_paste(text), {
			kind: 'rejected',
			hazard: 'paste_end',
			bracketed: true,
			length: text.length + 12
		});
		// the encoder replaces its ESC, so it can't end the frame
		assert.strictEqual(
			encoded_text(terminal.encode_paste(text, { allow_unsafe: PASTE_END_BRACKETED })),
			`${START}ok [201~rm -rf ~${END}`
		);
		// unbracketed with a line break too, the line break is what's reported:
		// it's what runs commands; bracketed, only the end sequence is unsafe
		const both = `a\n${END}`;
		const bracketed = terminal.encode_paste(both);
		assert.strictEqual(bracketed.kind === 'rejected' && bracketed.hazard, 'paste_end');
		terminal.write(BRACKET_OFF);
		const unbracketed = terminal.encode_paste(both);
		assert.strictEqual(unbracketed.kind === 'rejected' && unbracketed.hazard, 'line_break');
		assert.strictEqual(
			encoded_text(terminal.encode_paste(both, { allow_unsafe: LINE_BREAK })),
			'a\r [201~'
		);
		terminal.dispose();
	});

	test('control bytes are replaced with spaces in both modes', async () => {
		const terminal = await create();
		assert.strictEqual(encoded_text(terminal.encode_paste(`a${ESC}b\x03c\x7f`)), 'a b c ');
		terminal.write(BRACKET_ON);
		assert.strictEqual(encoded_text(terminal.encode_paste(`a${ESC}b\x00`)), `${START}a b ${END}`);
		terminal.dispose();
	});

	test('empty text is nothing to paste', async () => {
		const terminal = await create();
		assert.deepEqual(terminal.encode_paste(''), { kind: 'empty' });
		terminal.write(BRACKET_ON);
		assert.deepEqual(terminal.encode_paste('', { allow_unsafe: PASTE_END_BRACKETED }), {
			kind: 'empty'
		});
		terminal.dispose();
	});

	test('a confirmation covers only the hazard and mode it names', async () => {
		const terminal = await create();
		// asked about a line break, then the program turned bracketed paste on:
		// the text is safe now, and goes framed
		assert.strictEqual(
			encoded_text(terminal.encode_paste('a\nb', { allow_unsafe: LINE_BREAK })),
			'a\rb'
		);
		terminal.write(BRACKET_ON);
		assert.strictEqual(
			encoded_text(terminal.encode_paste('a\nb', { allow_unsafe: LINE_BREAK })),
			`${START}a\nb${END}`
		);
		// asked about the end sequence bracketed; the line break it also holds
		// becomes the hazard once the program turns the mode off
		const text = `a\n${END}`;
		assert.strictEqual(
			encoded_text(terminal.encode_paste(text, { allow_unsafe: PASTE_END_BRACKETED })),
			`${START}a\n [201~${END}`
		);
		terminal.write(BRACKET_OFF);
		assert.deepEqual(terminal.encode_paste(text, { allow_unsafe: PASTE_END_BRACKETED }), {
			kind: 'rejected',
			hazard: 'line_break',
			bracketed: false,
			length: text.length
		});
		// the same hazard in the other mode isn't what was asked either
		assert.deepEqual(terminal.encode_paste(END, { allow_unsafe: PASTE_END_BRACKETED }), {
			kind: 'rejected',
			hazard: 'paste_end',
			bracketed: false,
			length: END.length
		});
		assert.deepEqual(terminal.encode_paste(text, { allow_unsafe: PASTE_END }), {
			kind: 'rejected',
			hazard: 'line_break',
			bracketed: false,
			length: text.length
		});
		assert.strictEqual(
			encoded_text(terminal.encode_paste(END, { allow_unsafe: PASTE_END })),
			' [201~'
		);
		terminal.dispose();
	});

	test('multi-byte text is UTF-8, a lone surrogate U+FFFD', async () => {
		const terminal = await create();
		const encoding = terminal.encode_paste('你好 🙂 é');
		assert(encoding.kind === 'encoded');
		assert.deepEqual(encoding.bytes, encoder.encode('你好 🙂 é'));
		assert.strictEqual(encoded_text(terminal.encode_paste('a\ud800b')), 'a�b');
		terminal.dispose();
	});

	test('nothing in the terminal changes, and nothing is sent', async () => {
		const terminal = await create();
		const sent: Array<Uint8Array> = [];
		terminal.set_effect('write_pty', (data) => sent.push(data));
		terminal.write('screen');
		terminal.encode_paste('pasted');
		encode_confirmed(terminal, 'a\nb');
		assert.strictEqual(terminal.format_text(), 'screen');
		assert.deepEqual(sent, []);
		terminal.dispose();
	});

	test('refused from an effect handler, and after dispose', async () => {
		const terminal = await create();
		let error: unknown;
		terminal.set_effect('bell', () => {
			try {
				terminal.encode_paste('x');
			} catch (e) {
				error = e;
			}
		});
		terminal.write('\x07');
		assert.instanceOf(error, GhosttyReentrancyError);
		terminal.dispose();
		assert.throws(() => terminal.encode_paste('x'), GhosttyDisposedError);
		assert.throws(() => terminal.get_mode(2004), GhosttyDisposedError);
	});

	test('scratch is freed: repeated pastes allocate no more', async () => {
		let allocated = 0;
		const vt = await load_wrapped_ghostty_vt((exports) => ({
			ghostty_wasm_alloc: (len: number) => {
				allocated += len;
				return exports.ghostty_wasm_alloc(len);
			},
			ghostty_wasm_free: (ptr: number, len: number) => {
				allocated -= len;
				return exports.ghostty_wasm_free(ptr, len);
			}
		}));
		const terminal = await create(vt);
		terminal.write(BRACKET_ON);
		const before = allocated;
		for (const text of ['abc', `x${END}`, '你好\n'.repeat(1000)]) {
			encode_confirmed(terminal, text);
		}
		assert.strictEqual(allocated, before);
		terminal.dispose();
	});

	test('a mode number out of range is refused before any call', async () => {
		const terminal = await create();
		assert.throws(() => terminal.get_mode(0x8000), RangeError);
		// ANSI mode 4 (insert) is told apart from DEC private mode 4 (smooth scroll)
		terminal.write(`${ESC}[4h`);
		assert.isTrue(terminal.get_mode(4, true));
		assert.isFalse(terminal.get_mode(4));
		terminal.dispose();
	});
});

describe('the binding against the library', () => {
	test('the hazard check matches ghostty_paste_is_safe, its unbracketed rule', async () => {
		const vt = await load_test_ghostty_vt();
		for (const text of CORPUS) {
			assert.strictEqual(
				get_ghostty_paste_hazard(text, false) === null,
				library_is_safe(vt, text),
				JSON.stringify(text.slice(0, 40))
			);
		}
	});

	test('encode_paste makes what ghostty_terminal_paste writes, refusing what it refuses', async () => {
		const terminal = await create();
		for (const modes of ['', BRACKET_ON, `${BRACKET_ON}${ESC}[?5522h`]) {
			terminal.write(`${ESC}c${modes}`);
			for (const text of [...CORPUS, '']) {
				for (const allow_unsafe of [false, true]) {
					const label = `${JSON.stringify(modes)} ${JSON.stringify(text.slice(0, 40))} ${allow_unsafe}`;
					assert_matches_library(terminal, text, allow_unsafe, label);
				}
			}
		}
		terminal.dispose();
	});

	test('random texts over the probing alphabet match it too', async () => {
		const terminal = await create();
		const random = create_random(1);
		let rejected = 0;
		for (const modes of ['', BRACKET_ON, `${BRACKET_ON}${ESC}[?5522h`]) {
			terminal.write(`${ESC}c${modes}`);
			for (let i = 0; i < FUZZ_CASES; i++) {
				let text = '';
				const n = 1 + Math.floor(random() * 11);
				for (let j = 0; j < n; j++)
					text += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)];
				for (const allow_unsafe of [false, true]) {
					const label = `${JSON.stringify(modes)} ${JSON.stringify(text)} ${allow_unsafe}`;
					assert_matches_library(terminal, text, allow_unsafe, label);
				}
				if (terminal.encode_paste(text).kind === 'rejected') rejected++;
			}
		}
		assert.isAbove(rejected, 0, 'some texts are unsafe');
		terminal.dispose();
	});
});
