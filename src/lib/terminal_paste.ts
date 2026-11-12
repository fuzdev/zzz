/**
 * Pasting the clipboard into a terminal view: the text read, refused whole
 * when the terminal's input can't take it, confirmed by the person when it
 * could inject commands, then pasted (`FuzTerminal.paste`) — bracketed when
 * the program asked for bracketed paste. `TerminalView` runs it for the
 * terminal context menu's "paste".
 *
 * @module
 */

import type {
	FuzTerminalPasteOptions,
	FuzTerminalPasteResult
} from './fuz_terminal/fuz_terminal_state.svelte.ts';
import type { GhosttyPasteHazard } from './fuz_terminal/ghostty_paste.ts';
import { TERMINAL_INPUT_PENDING_MAX_LENGTH } from './terminal_helpers.ts';

/** What `paste_terminal_text` needs of the view, the terminal, and the person. */
export interface TerminalPasteDeps {
	/** The view's paste (`FuzTerminal.paste`). */
	paste: (text: string, options?: FuzTerminalPasteOptions) => FuzTerminalPasteResult;
	/** How many characters the terminal's input takes now (`Terminal.input_room`). */
	input_room: () => number;
	/** Ask the person whether to paste text that could inject commands; `true` pastes it. */
	confirm: (message: string) => boolean;
}

/**
 * How a paste ended:
 *
 * - `pasted` - the text went to the terminal
 * - `declined` - the person chose not to paste text that could inject commands
 * - `failed` - nothing was sent, and `message` says why, for the person
 *   (a confirmed paste the program's toggle of bracketed paste left unsafe
 *   in another way — its hazard or its mode — included)
 */
export type TerminalPasteOutcome =
	| { readonly kind: 'pasted' }
	| { readonly kind: 'declined' }
	| { readonly kind: 'failed'; readonly message: string };

/**
 * Read the clipboard's text (`navigator.clipboard.readText`). Call it from
 * the click or key press that asked for the paste, before anything awaits:
 * browsers allow the read only with that user activation (Chrome asks for
 * permission once, Firefox shows its own paste button). Never throws — a
 * page without clipboard access (an insecure context) gets a rejection.
 */
export const read_clipboard_text = (): Promise<string> => {
	try {
		const clipboard = globalThis.navigator?.clipboard;
		if (typeof clipboard?.readText !== 'function') {
			return Promise.reject(
				new Error(
					'this page has no clipboard access (it needs a secure context: https or localhost)'
				)
			);
		}
		return clipboard.readText();
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
};

/**
 * Paste the text a clipboard read gives into a terminal view. Nothing is
 * sent until the whole paste fits what the terminal's input takes now
 * (`Terminal.input_room`, which `Terminal.send_input` would otherwise drop it
 * past) — measured as the input is, in characters of the text sent, its
 * bracketed framing included — so a paste is never sent partway, and one
 * that doesn't fit is refused before anything is asked. Text that could
 * inject commands (`GhosttyPasteHazard`) is pasted only once
 * `TerminalPasteDeps.confirm` says so, and the confirmation covers only the
 * hazard asked about: the second paste allows that hazard in that mode, so
 * if the program toggled bracketed paste while the person was asked and the
 * text is unsafe in the new mode (its hazard, or only the mode, differs
 * from what was asked), nothing is sent and the outcome says to paste
 * again — a fresh paste asks about the hazard as it is then. (Asking again
 * instead could repeat for as long as a program keeps toggling the mode;
 * a refusal is bounded, and the next paste is one click.)
 *
 * Never throws: a failed read or a refusal is a `failed` outcome, whose
 * message the caller shows.
 *
 * @param text - the clipboard read, started from the user's gesture (`read_clipboard_text`)
 */
export const paste_terminal_text = async (
	text: Promise<string>,
	deps: TerminalPasteDeps
): Promise<TerminalPasteOutcome> => {
	let pasted: string;
	try {
		pasted = await text;
	} catch (error) {
		return { kind: 'failed', message: `paste failed: ${to_clipboard_error_message(error)}` };
	}
	if (typeof pasted !== 'string' || pasted === '') return NO_TEXT;
	// a lower bound on the encoded length, which spares encoding a text that
	// can't fit; the view measures the exact length before it looks at safety
	const room = deps.input_room();
	if (pasted.length > room) return too_large(pasted.length, room);
	const result = deps.paste(pasted, { max_length: room });
	if (result.kind !== 'rejected') return to_outcome(result, room);
	if (!deps.confirm(to_paste_hazard_question(result.hazard))) return { kind: 'declined' };
	const room_now = deps.input_room();
	const confirmed = deps.paste(pasted, {
		allow_unsafe: { hazard: result.hazard, bracketed: result.bracketed },
		max_length: room_now
	});
	if (confirmed.kind === 'rejected') return HAZARD_CHANGED;
	return to_outcome(confirmed, room_now);
};

/**
 * The question asked before pasting text that could inject commands.
 */
export const to_paste_hazard_question = (hazard: GhosttyPasteHazard): string =>
	hazard === 'paste_end'
		? 'The text to paste contains the sequence that ends a bracketed paste (ESC [201~). Text like this is made to break out of a paste and run what follows as commands.\n\nPaste it anyway?'
		: "The text to paste has a line break, and the program in this terminal hasn't turned on bracketed paste, so each line break is sent as Enter — a shell runs each line as a command as it arrives.\n\nPaste it anyway?";

const HAZARD_CHANGED: TerminalPasteOutcome = {
	kind: 'failed',
	message:
		"paste refused: the program changed the terminal's paste mode while you were asked, so what you confirmed no longer applies — nothing was sent; paste again to be asked about the text as it is now"
};

const NO_TEXT: TerminalPasteOutcome = {
	kind: 'failed',
	message: 'paste failed: the clipboard has no text'
};

const to_outcome = (
	result: Exclude<FuzTerminalPasteResult, { kind: 'rejected' }>,
	room: number
): TerminalPasteOutcome => {
	switch (result.kind) {
		case 'pasted':
			return { kind: 'pasted' };
		case 'empty':
			return NO_TEXT;
		case 'too_large':
			return too_large(result.length, room);
		case 'unavailable':
			return {
				kind: 'failed',
				message:
					result.reason === 'input_off'
						? 'paste failed: the terminal takes no input now'
						: "paste failed: the terminal view isn't ready"
			};
	}
};

const too_large = (length: number, room: number): TerminalPasteOutcome => ({
	kind: 'failed',
	message:
		room >= TERMINAL_INPUT_PENDING_MAX_LENGTH
			? `paste refused: it's ${length} characters, and a terminal takes at most ${TERMINAL_INPUT_PENDING_MAX_LENGTH} characters of input at a time — nothing was sent`
			: `paste refused: it's ${length} characters, and the terminal has room for ${room} more characters of input now (at most ${TERMINAL_INPUT_PENDING_MAX_LENGTH} wait to be sent at a time) — nothing was sent`
});

const to_clipboard_error_message = (error: unknown): string => {
	const name = error instanceof Error || error instanceof DOMException ? error.name : null;
	const message =
		error instanceof Error || error instanceof DOMException ? error.message : String(error);
	if (name === 'NotAllowedError') {
		return `the browser didn't allow reading the clipboard${message ? ` (${message})` : ''}`;
	}
	return `couldn't read the clipboard: ${message}`;
};
