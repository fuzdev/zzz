/**
 * Pasting text into a terminal: libghostty-vt's paste encoder and its safety
 * rule, under the terminal's bracketed paste mode (2004).
 *
 * `GhosttyTerminal.encode_paste` is the entry: it reads the mode, applies
 * `get_ghostty_paste_hazard`, and encodes with `ghostty_paste_encode`, which
 * replaces the control bytes xterm strips from a paste (NUL, BS, ENQ, EOT,
 * ESC, DEL, and the tty's special characters: Ctrl+C, Ctrl+\, Ctrl+U,
 * Ctrl+Z, Ctrl+Q, Ctrl+S, Ctrl+W, Ctrl+V, Ctrl+R, Ctrl+O) with spaces, then
 * frames the text in `ESC [200~` … `ESC [201~` when the mode is on, or turns
 * each newline into a carriage return when it's off. Every change is an
 * ASCII byte for an ASCII byte, so the encoded length is known before
 * encoding (`to_ghostty_paste_length`). Nothing is sent: the caller sends
 * the bytes, as it does a key's.
 *
 * The library's own `ghostty_terminal_paste` makes the same bytes — with no
 * clipboard read effect registered (the binding registers none), a Kitty
 * paste event (mode 5522) never happens — but it reads its text through a
 * callback and streams the result through `write_pty`; encoding here hands
 * the caller the whole result, to measure before anything is sent.
 *
 * @module
 */

import type { GhosttyManifest } from './ghostty_manifest.ts';
import { GhosttyMemory } from './ghostty_memory.ts';
import type { GhosttyVt } from './ghostty_vt.ts';

/** DEC private mode 2004, bracketed paste: a paste is framed so the program can tell it from typing. */
export const GHOSTTY_MODE_BRACKETED_PASTE = 2004;

/** The sequence that ends a bracketed paste. */
export const GHOSTTY_PASTE_END = '\x1b[201~';

/** The characters a bracketed paste's frame adds: `ESC [200~` before the text, `ESC [201~` after. */
export const GHOSTTY_PASTE_FRAME_LENGTH = 12;

/**
 * Why a paste is refused unless allowed:
 *
 * - `line_break` - the text holds a newline or a carriage return and the
 *   paste isn't bracketed, so each one reaches the program as Enter — a shell
 *   runs the line before it
 * - `paste_end` - the text holds `GHOSTTY_PASTE_END`, which would let what
 *   follows it escape a bracketed paste and run as typed (refused in either
 *   mode: text carrying it is suspect whatever the mode, though the encoder
 *   replaces its ESC either way)
 */
export type GhosttyPasteHazard = 'line_break' | 'paste_end';

/**
 * What a person confirmed when asked about unsafe text: its hazard, under
 * the bracketed paste mode it was found in — the fields of a `rejected`
 * encoding.
 */
export interface GhosttyPasteRisk {
	readonly hazard: GhosttyPasteHazard;
	readonly bracketed: boolean;
}

/** How `GhosttyTerminal.encode_paste` treats the text. */
export interface GhosttyPasteOptions {
	/**
	 * The risk the person pasting confirmed (a `rejected` encoding's hazard
	 * and mode): text with that hazard, in that mode, is encoded rather than
	 * refused. A confirmation covers only what the person was asked, so unsafe
	 * text whose hazard or mode differs now — the program toggled bracketed
	 * paste since —
	 * is rejected again, with the hazard as it is now. Safe text is encoded
	 * whatever this says. Defaults to `null`: unsafe text is rejected.
	 */
	allow_unsafe?: GhosttyPasteRisk | null;
}

/**
 * What `GhosttyTerminal.encode_paste` made of the text:
 *
 * - `encoded` - the bytes for the PTY, whether they're bracketed, and their
 *   `length` (`to_ghostty_paste_length`)
 * - `empty` - there was no text, so there's nothing to send
 * - `rejected` - the text could inject commands and that risk wasn't
 *   allowed (`GhosttyPasteOptions.allow_unsafe`); nothing was encoded, and
 *   `length` is what the encoded text's would be
 */
export type GhosttyPasteEncoding =
	| {
			readonly kind: 'encoded';
			readonly bytes: Uint8Array;
			readonly bracketed: boolean;
			readonly length: number;
	  }
	| { readonly kind: 'empty' }
	| {
			readonly kind: 'rejected';
			readonly hazard: GhosttyPasteHazard;
			readonly bracketed: boolean;
			readonly length: number;
	  };

/**
 * Whether pasting `text` could inject commands, and why: the library's
 * terminal-aware rule (`isSafeWith` in its `input/paste.zig`, which
 * `ghostty_terminal_paste` applies before it encodes). Bracketed, only the
 * end sequence is unsafe; unbracketed, a newline or carriage return is too.
 * The rule is checked on the text as given, before the encoder replaces its
 * control bytes. Unbracketed text holding both is reported as `line_break`:
 * that's what runs commands as the text arrives, while the end sequence's
 * ESC is replaced by the encoder. Only whether the text is safe is the
 * library's; which hazard is named is the binding's.
 *
 * `ghostty_paste_is_safe` is the library's state-free form, the unbracketed
 * rule in every mode.
 *
 * @param text - the text to paste; a lone surrogate, encoded as U+FFFD, can't
 *   form any of these ASCII sequences, so the string answers for its bytes
 * @param bracketed - whether bracketed paste (mode 2004) is on
 * @returns the hazard, or `null` when the text is safe
 */
export const get_ghostty_paste_hazard = (
	text: string,
	bracketed: boolean
): GhosttyPasteHazard | null => {
	if (!bracketed && (text.includes('\n') || text.includes('\r'))) return 'line_break';
	if (text.includes(GHOSTTY_PASTE_END)) return 'paste_end';
	return null;
};

/**
 * The length of `text` encoded for a paste, in UTF-16 code units of the
 * encoded bytes decoded as UTF-8 (a JS string's length), known without
 * encoding. The text's UTF-8 is its length in
 * those units (a lone surrogate becomes U+FFFD, one unit either way); the
 * encoder changes only ASCII bytes, each to another (a control byte to a
 * space, unbracketed a newline to a carriage return), never a byte of a
 * multi-byte sequence; and bracketed, the frame adds
 * `GHOSTTY_PASTE_FRAME_LENGTH`.
 *
 * @param text - the text to paste
 * @param bracketed - whether bracketed paste (mode 2004) is on
 */
export const to_ghostty_paste_length = (text: string, bracketed: boolean): number =>
	text.length + (bracketed ? GHOSTTY_PASTE_FRAME_LENGTH : 0);

/** The manifest constants the paste encoder uses, resolved once per module. */
export interface GhosttyPasteConstants {
	/** `GHOSTTY_OUT_OF_SPACE`, the size query's answer for a result that needs space. */
	out_of_space: number;
}

/**
 * Resolve the paste encoder's constants from a manifest.
 *
 * @throws GhosttyManifestError when an entry is missing
 */
export const resolve_ghostty_paste_constants = (
	manifest: GhosttyManifest
): GhosttyPasteConstants => ({
	out_of_space: manifest.enum_value('GhosttyResult', 'OUT_OF_SPACE')
});

/**
 * Encode `data` with `ghostty_paste_encode`: its size asked first (a
 * `NULL` buffer), then encoded into a buffer of that size. The data and the
 * result are scratch in linear memory, freed on every path.
 *
 * @param data - the text's UTF-8 bytes, at least one
 * @param bracketed - whether to frame it as a bracketed paste
 * @returns the encoded bytes, copied out of linear memory
 * @throws GhosttyResultError when the library refuses the call (`UNSUPPORTED`
 *   for a module without the `input_encode` feature)
 * @throws GhosttyPoisonedError once the instance is poisoned (`GhosttyVt.poisoned`)
 * @internal
 */
export const encode_ghostty_paste_bytes = (
	vt: GhosttyVt,
	data: Uint8Array,
	bracketed: boolean
): Uint8Array => {
	vt.assert_not_poisoned('ghostty_paste_encode');
	const { exports, memory } = vt;
	const { out_of_space } = vt.resolve(resolve_ghostty_paste_constants);
	const usize = vt.manifest.usize_scalar;
	const flag = bracketed ? 1 : 0;
	return memory.with_scratch(data.length, (data_ptr) => {
		memory.write_bytes(data_ptr, data);
		return memory.with_scratch(GhosttyMemory.scalar_size(usize), (out_written) => {
			// the size query: it changes the data in place, and encoding the
			// changed data again gives the same result
			const query = exports.ghostty_paste_encode(data_ptr, data.length, flag, 0, 0, out_written);
			if (query !== out_of_space) vt.check(query, 'ghostty_paste_encode');
			const needed = memory.read_scalar(out_written, usize);
			if (needed === 0) return new Uint8Array();
			return memory.with_scratch(needed, (buf) => {
				vt.check(
					exports.ghostty_paste_encode(data_ptr, data.length, flag, buf, needed, out_written),
					'ghostty_paste_encode'
				);
				const written = memory.read_scalar(out_written, usize);
				// the view is taken after the last call
				return memory.bytes().slice(buf, buf + written);
			});
		});
	});
};
