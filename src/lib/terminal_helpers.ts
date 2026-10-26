/**
 * Error reason: `terminal_create`'s `command` doesn't exist. Answered as
 * `invalid_params` before any terminal is registered; declared in the action
 * spec's `error_reasons`.
 */
export const ERROR_TERMINAL_COMMAND_NOT_FOUND = 'terminal_command_not_found';

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

/**
 * Consumed output a terminal acks at once rather than after
 * `TERMINAL_ACK_DELAY` — see `TerminalOutputAcker`.
 *
 * It must not exceed the backend's low-water mark (256 KiB, the unacked
 * output at or under which a paused terminal reads again). While the backend
 * holds a terminal paused, more than that mark is unacked; so a client that
 * has consumed everything it was sent has at least this much waiting, and
 * acks at once instead of leaving the process blocked for the delay. The
 * cross-backend terminal suite pins the relation against the backend.
 */
export const TERMINAL_ACK_THRESHOLD_BYTES = 256 * 1024;

/** How long (ms) consumed output under the threshold waits to be acked. */
export const TERMINAL_ACK_DELAY = 100;

/** How long (ms) before a failed ack is sent again. */
export const TERMINAL_ACK_RETRY_DELAY = 1000;

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

/**
 * How a `terminal_ack` ended: `ok`, `retry` (it failed and is worth sending
 * again), or `stop` (the backend no longer has the terminal).
 */
export type TerminalAckOutcome = 'ok' | 'retry' | 'stop';

export interface TerminalOutputAckerOptions {
	/** Sends a `terminal_ack` for output consumed through `bytes`. Must not throw. */
	send: (bytes: number) => Promise<TerminalAckOutcome>;
	threshold_bytes?: number;
	delay?: number;
	retry_delay?: number;
}

/**
 * Batches one terminal's output acks. The backend stops reading a terminal
 * whose output runs too far ahead of what this client has acked, so acks
 * must keep up with consumption without doubling the message rate.
 *
 * Counts are the backend's: each `terminal_data` carries `sent_bytes`, the
 * terminal's running output total, and an ack echoes the `sent_bytes` of the
 * last chunk consumed. Acks are cumulative, so a lost one is covered by the
 * next.
 *
 * An ack is sent at once when `threshold_bytes` of consumed output are
 * waiting, and after `delay` when fewer are — so the last of a burst is
 * always acked. At most one ack is in flight: output consumed meanwhile
 * waits for it to return and is then acked by the same rule, so under a
 * flood acks go out per `threshold_bytes` consumed, not per round trip
 * (each ack is a request the backend runs in a transaction).
 *
 * Acks can't stall a terminal the backend has paused, as long as
 * `threshold_bytes` is at most the backend's low-water mark (see
 * `TERMINAL_ACK_THRESHOLD_BYTES`): once everything sent is consumed, at
 * least the threshold is waiting, and the ack goes out at once or as soon as
 * the one in flight returns. `delay` bounds every other case. Not reactive.
 */
export class TerminalOutputAcker {
	readonly #send: (bytes: number) => Promise<TerminalAckOutcome>;
	readonly #threshold_bytes: number;
	readonly #delay: number;
	readonly #retry_delay: number;

	#consumed = 0;
	#acked = 0;
	#sending = false;
	#stopped = false;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: TerminalOutputAckerOptions) {
		this.#send = options.send;
		this.#threshold_bytes = options.threshold_bytes ?? TERMINAL_ACK_THRESHOLD_BYTES;
		this.#delay = options.delay ?? TERMINAL_ACK_DELAY;
		this.#retry_delay = options.retry_delay ?? TERMINAL_ACK_RETRY_DELAY;
	}

	/** The highest `sent_bytes` an ack has succeeded for. */
	get acked(): number {
		return this.#acked;
	}

	/**
	 * Records that output through `sent_bytes` has been consumed. Counts only
	 * move forward — a lower value is ignored.
	 */
	consumed(sent_bytes: number): void {
		if (this.#stopped || sent_bytes <= this.#consumed) return;
		this.#consumed = sent_bytes;
		this.#ack_waiting();
	}

	/**
	 * Acks what's waiting by the batching rule: at once when it's the
	 * threshold or more, after the delay when it's less.
	 */
	#ack_waiting(): void {
		const waiting = this.#consumed - this.#acked;
		if (waiting >= this.#threshold_bytes) {
			this.flush();
		} else if (waiting > 0) {
			this.#schedule(this.#delay);
		}
	}

	/**
	 * Acks what's been consumed now, unless an ack is in flight (what it
	 * leaves is acked when it returns) or nothing is waiting.
	 */
	flush(): void {
		this.#clear_timer();
		if (this.#stopped || this.#sending || this.#consumed <= this.#acked) return;
		void this.#run(this.#consumed);
	}

	/** Stops acking for good — pending and later output is never acked. */
	stop(): void {
		this.#stopped = true;
		this.#clear_timer();
	}

	async #run(bytes: number): Promise<void> {
		this.#sending = true;
		const outcome = await this.#send(bytes);
		this.#sending = false;
		if (this.#stopped) return;
		if (outcome === 'stop') {
			this.stop();
		} else if (outcome === 'retry') {
			this.#schedule(this.#retry_delay);
		} else {
			this.#acked = bytes;
			this.#ack_waiting();
		}
	}

	/** Flushes after `delay` ms, unless a flush is already scheduled. */
	#schedule(delay: number): void {
		if (this.#timer !== null) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.flush();
		}, delay);
	}

	#clear_timer(): void {
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}
}
