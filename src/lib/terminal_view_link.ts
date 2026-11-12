/**
 * The wiring between a `Terminal` cell and one terminal view (`FuzTerminal`):
 * the cell's output into the view, the view's bytes back as input, the view's
 * size to the PTY. `TerminalView` makes one per view instance.
 *
 * @module
 */

import type { FuzTerminalSize } from './fuz_terminal/fuz_terminal_layout.ts';
import type {
	FuzTerminalStatus,
	FuzTerminalWriteOptions
} from './fuz_terminal/fuz_terminal_state.svelte.ts';
import type { Terminal } from './terminal.svelte.ts';

/** The line written ahead of a replayed history whose oldest output was dropped. */
export const TERMINAL_TRUNCATED_NOTICE = '\x1b[0;2m[earlier output truncated]\x1b[0m\r\n';

/** What a link needs of a view: `FuzTerminal`'s `write` and `get_status`. */
export interface TerminalViewLinkView {
	write: (data: string, options?: FuzTerminalWriteOptions) => void;
	get_status: () => FuzTerminalStatus;
}

/** What a link needs of a terminal cell. */
export type TerminalViewLinkTerminal = Pick<Terminal, 'attach_output' | 'send_input' | 'resize'>;

/**
 * Links one view to a terminal cell, from `connect` until `disconnect`.
 *
 * **Output**: connecting attaches to the cell's output. What the cell
 * buffered is written first as a replay (`{replay: true}`, after a dim
 * notice when older output was dropped), so the queries in it — answered
 * when the output first arrived — get no second answer; each chunk after it
 * is a plain write, whose queries the view answers through `ondata`.
 *
 * **Acks**: a chunk is consumed — and acked to the backend, which paces the
 * PTY by it — once the view has parsed it. A ready view's `write` parses
 * synchronously, so that's as soon as `write` returns. A view still loading
 * its module queues the chunk unparsed, so its `consumed` waits until the
 * view leaves `loading` (`view_status_changed`): at `ready` the queued
 * writes have been parsed, and every waiting chunk is consumed in order;
 * at `failed` or `poisoned` nothing will parse them, and they're consumed
 * too, so a view that can't draw never holds the process blocked. So the
 * backend's window bounds the output that can queue while a view loads:
 * the cell announces its position to the backend when the process starts
 * and with the first chunk after each socket connect, so it doesn't wait on this view's first
 * consumed chunk to be paced (see `Terminal.receive_socket_connect`). A
 * load that never finishes is ended by the loader's timeout
 * (`FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS`): the view fails, and what it held
 * is released.
 * Disconnecting detaches from the cell, which then waits on this view for
 * nothing — the chunks still waiting are dropped, not consumed, since the
 * cell no longer counts this listener. A `write` that throws is logged and
 * its chunk still consumed: an exception must not reach the cell's
 * delivery to its other listeners.
 *
 * **Input**: the view's bytes (`ondata` — keys typed, replies to queries)
 * are decoded as UTF-8, streaming, since input goes over the wire as text.
 *
 * **Size**: the view's size in cells (`onresize`) resizes the PTY.
 */
export class TerminalViewLink {
	readonly #terminal: TerminalViewLinkTerminal;
	// TODO: mouse reporting can send bytes that aren't UTF-8 (X10 coordinates
	// past 95), which this decoder turns into U+FFFD — those need a byte-safe
	// input path
	readonly #decoder = new TextDecoder();
	#view: TerminalViewLinkView | null = null;
	#detach: (() => void) | null = null;
	/** The `consumed` of each chunk written while the view loads, in order. */
	#waiting: Array<() => void> = [];
	#connected = false;
	#disconnected = false;

	constructor(terminal: TerminalViewLinkTerminal) {
		this.#terminal = terminal;
	}

	/** Replay the cell's buffered output into `view` and stream what follows. Once only. */
	connect(view: TerminalViewLinkView): void {
		if (this.#connected || this.#disconnected) return;
		this.#connected = true;
		this.#view = view;
		const attachment = this.#terminal.attach_output((data, consumed) => {
			if (this.#disconnected) {
				consumed();
				return;
			}
			this.#write(data);
			if (this.#loading) this.#waiting.push(consumed);
			else consumed();
		});
		this.#detach = attachment.detach;
		if (attachment.truncated) this.#write(TERMINAL_TRUNCATED_NOTICE, { replay: true });
		if (attachment.buffered) this.#write(attachment.buffered, { replay: true });
	}

	/**
	 * The view's status changed (its `onstatus`): once it has left `loading`,
	 * the chunks written while it loaded are consumed, in order.
	 */
	view_status_changed(): void {
		if (this.#disconnected || this.#loading) return;
		const waiting = this.#waiting;
		this.#waiting = [];
		// each on its own, so one that throws can't drop the rest
		for (const consumed of waiting) {
			try {
				consumed();
			} catch (error) {
				console.error('[TerminalViewLink] consuming terminal output failed:', error);
			}
		}
	}

	/** The view's bytes for the PTY. */
	send(data: Uint8Array): void {
		if (this.#disconnected) return;
		const text = this.#decoder.decode(data, { stream: true });
		if (text) this.#terminal.send_input(text);
	}

	/** The view's size changed. */
	resize(size: FuzTerminalSize): void {
		if (this.#disconnected) return;
		this.#terminal.resize(size.cols, size.rows);
	}

	/** Stop: detach from the cell's output, and send nothing more. Idempotent. */
	disconnect(): void {
		if (this.#disconnected) return;
		this.#disconnected = true;
		// the cell stops counting this listener, so what waits on it is released there
		this.#waiting = [];
		this.#view = null;
		this.#detach?.();
		this.#detach = null;
	}

	/** Whether the view is still loading its module, so a write is queued unparsed. */
	get #loading(): boolean {
		return this.#view?.get_status().kind === 'loading';
	}

	#write(data: string, options?: FuzTerminalWriteOptions): void {
		try {
			this.#view?.write(data, options);
		} catch (error) {
			console.error('[TerminalViewLink] writing terminal output failed:', error);
		}
	}
}
