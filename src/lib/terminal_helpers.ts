/**
 * Max characters of output kept per terminal for replay into a (re)mounted
 * view. Counted in UTF-16 code units — about 1-2 MB of memory. The oldest
 * output is dropped first.
 */
export const TERMINAL_OUTPUT_MAX_LENGTH = 1_000_000;

/**
 * Max characters of input queued per terminal while a send is in flight or
 * waiting to retry. Input past this is refused and surfaced, not queued.
 */
export const TERMINAL_INPUT_PENDING_MAX_LENGTH = 64 * 1024;

/** Why a terminal is `lost` when the backend answers `not_found` for it. */
export const TERMINAL_NOT_FOUND_MESSAGE =
	'lost: the backend no longer has this terminal — zzzd may have restarted';

/** Why a terminal is `lost` when a session snapshot from a restarted backend lacks it. */
export const TERMINAL_LOST_TO_RESTART_MESSAGE = 'lost: zzzd restarted, ending this terminal';

/**
 * Why a terminal is `lost` when a session snapshot from the same backend lacks
 * it — it exited, or was closed from another tab, while the connection was down.
 */
export const TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE =
	'lost: the terminal ended while the connection was down';

/**
 * Formats a command and its args as the line typed into the terminal's shell.
 * Each arg follows a space, except one that starts with whitespace, which
 * carries its own separator — how `parse_terminal_command` keeps a typed line
 * verbatim.
 */
export const format_terminal_command = (command: string, args: ReadonlyArray<string>): string => {
	let line = command;
	for (const arg of args) line += /^\s/.test(arg) ? arg : ' ' + arg;
	return line;
};

/**
 * Splits a typed command line, trimmed, into its first whitespace-delimited
 * word — the `command`, used for display and a preset's default name — and
 * the rest of the line verbatim, whitespace separator included, as the one
 * arg. The terminal types the line into `sh` (see `format_terminal_command`),
 * so nothing is parsed here: quotes, comments, and unterminated lines are
 * the shell's to interpret, and the line it gets is exactly the trimmed line
 * that was typed.
 *
 * @returns the command and args, or `null` for a blank line
 */
export const parse_terminal_command = (
	text: string
): { command: string; args: Array<string> } | null => {
	const line = text.trim();
	if (!line) return null;
	const end = line.search(/\s/);
	if (end === -1) return { command: line, args: [] };
	return { command: line.slice(0, end), args: [line.slice(end)] };
};

/**
 * Bounded buffer of terminal output chunks — keeps about the most recent
 * `max_length` characters, dropping the oldest first. Not reactive.
 *
 * Trimming cuts after a newline where the oldest chunk has one past the trim
 * point, and otherwise drops that whole chunk, so a replay starts at a line or
 * chunk boundary rather than at an arbitrary character. Backend chunk
 * boundaries are arbitrary too, so a replay can still start inside an escape
 * sequence — xterm's parser starts in its ground state and prints the tail of
 * the sequence as text.
 */
export class TerminalOutputBuffer {
	readonly max_length: number;

	#chunks: Array<string> = [];
	#length = 0;
	#dropped = false;

	constructor(max_length: number = TERMINAL_OUTPUT_MAX_LENGTH) {
		this.max_length = max_length;
	}

	/** Buffered length in UTF-16 code units. */
	get length(): number {
		return this.#length;
	}

	/** Whether any output has been dropped to stay under `max_length`. */
	get dropped(): boolean {
		return this.#dropped;
	}

	/**
	 * The buffered output as one string. Doesn't merge the stored chunks —
	 * trimming drops whole chunks when there's no newline to cut at, so one
	 * merged chunk would be dropped all at once.
	 */
	get text(): string {
		return this.#chunks.join('');
	}

	/**
	 * Appends `data`, then drops the oldest output past `max_length`.
	 */
	push(data: string): void {
		if (!data) return;
		this.#chunks.push(data);
		this.#length += data.length;
		this.#trim();
	}

	/**
	 * Records that output was dropped before reaching this buffer,
	 * e.g. from a buffer whose content was handed over.
	 */
	mark_dropped(): void {
		this.#dropped = true;
	}

	clear(): void {
		this.#chunks = [];
		this.#length = 0;
		this.#dropped = false;
	}

	#trim(): void {
		while (this.#length > this.max_length) {
			const first = this.#chunks[0]!;
			const excess = this.#length - this.max_length;
			this.#dropped = true;
			// the first newline whose cut drops at least `excess`
			const newline_index = excess <= first.length ? first.indexOf('\n', excess - 1) : -1;
			if (newline_index === -1) {
				this.#chunks.shift();
				this.#length -= first.length;
			} else {
				const cut = newline_index + 1;
				this.#chunks[0] = first.slice(cut);
				this.#length -= cut;
			}
		}
	}
}
