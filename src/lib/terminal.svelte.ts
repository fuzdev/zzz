import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import {
	format_terminal_command,
	TERMINAL_INPUT_PENDING_MAX_LENGTH,
	TerminalOutputBuffer
} from './terminal_helpers.ts';

/**
 * Lifecycle of a terminal's backend process:
 *
 * - `starting` — `terminal_create` is in flight
 * - `running` — the PTY process is live
 * - `exited` — the process exited on its own (`terminal_exited`), `exit_code` is its real code
 * - `closed` — the user closed it (`terminal_close`), `exit_code` is the code the close
 *   observed, or `null` if the process outlived the close grace (the backend reaps it and
 *   broadcasts no `terminal_exited`)
 * - `failed` — `terminal_create` failed, see `error_message`
 */
export const TerminalStatus = z.enum(['starting', 'running', 'exited', 'closed', 'failed']);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const TerminalJson = CellJson.extend({
	name: z.string().default(''),
	command: z.string().default(''),
	args: z.array(z.string()).default(() => []),
	cwd: z.string().optional(),
	/** The backend PTY's id — changes on restart, `null` until `terminal_create` resolves. */
	terminal_id: Uuid.nullable().default(null),
	status: TerminalStatus.default('starting'),
	exit_code: z.number().nullable().default(null),
	/** The last failure to spawn, close, or send to the terminal. */
	error_message: z.string().nullable().default(null),
	preset_id: Uuid.nullable().default(null)
}).meta({ cell_class_name: 'Terminal' });
export type TerminalJson = z.infer<typeof TerminalJson>;
export type TerminalJsonInput = z.input<typeof TerminalJson>;

export interface TerminalOptions extends CellOptions<typeof TerminalJson> {}

/** Receives terminal output — see `Terminal.attach_output`. */
export type TerminalOutputListener = (data: string) => void;

/** Returned by `Terminal.attach_output`. */
export interface TerminalOutputAttachment {
	/** Output buffered before attaching, to replay before any streamed output. */
	buffered: string;
	/** Whether older output was dropped from `buffered` to stay under the cap. */
	truncated: boolean;
	detach: () => void;
}

const INPUT_RETRY_DELAY_MIN = 100;
const INPUT_RETRY_DELAY_MAX = 2000;

/**
 * A PTY terminal run: the command it runs, its backend process status,
 * a bounded output buffer that outlives any mounted view, and ordered input.
 *
 * Input goes through a per-terminal queue with at most one `terminal_data_send`
 * in flight — the backend dispatches one socket's requests concurrently, so
 * independent sends could reorder keystrokes. Data queued while a send is in
 * flight is coalesced into the next send. Resizes coalesce to the latest size.
 */
export class Terminal extends Cell<typeof TerminalJson> {
	name: string = $state.raw()!;
	command: string = $state.raw()!;
	args: Array<string> = $state.raw()!;
	cwd: string | undefined = $state.raw();
	terminal_id: Uuid | null = $state.raw()!;
	status: TerminalStatus = $state.raw()!;
	exit_code: number | null = $state.raw()!;
	error_message: string | null = $state.raw()!;
	preset_id: Uuid | null = $state.raw()!;

	/** Whether a `terminal_close` is in flight. */
	closing: boolean = $state.raw(false);

	/**
	 * Increments on each `reset` — one per spawned process, so views can key on
	 * it to get a fresh xterm per process.
	 */
	run: number = $state.raw(0);

	readonly display_command: string = $derived(format_terminal_command(this.command, this.args));

	readonly running: boolean = $derived(this.status === 'running');

	/** Output kept for replay into views mounted after it arrived. */
	readonly output: TerminalOutputBuffer = new TerminalOutputBuffer();

	#output_listeners: Set<TerminalOutputListener> = new Set();

	#input_pending = '';
	#input_sending = false;
	#input_retry_timer: ReturnType<typeof setTimeout> | null = null;
	#input_retry_delay = 0;

	#resize_pending: { cols: number; rows: number } | null = null;
	#resize_sending = false;

	constructor(options: TerminalOptions) {
		super(TerminalJson, options);
		this.init();
	}

	/**
	 * Forwards new output to `listener` until detached, and returns the output
	 * buffered so far for the caller to replay first. Replay is left to the
	 * caller so it can tell replayed output from live output — a replay can
	 * contain terminal queries (cursor position, device attributes) that
	 * xterm would answer again, and those answers must not reach the process.
	 */
	attach_output(listener: TerminalOutputListener): TerminalOutputAttachment {
		this.#output_listeners.add(listener);
		return {
			buffered: this.output.text,
			truncated: this.output.dropped,
			detach: () => {
				this.#output_listeners.delete(listener);
			}
		};
	}

	/**
	 * Buffers output from the backend and forwards it to attached views.
	 */
	receive_output(data: string): void {
		if (!data) return;
		this.output.push(data);
		for (const listener of this.#output_listeners) {
			listener(data);
		}
	}

	/**
	 * Marks the process started as the backend PTY `terminal_id`,
	 * flushing any input or resize queued while starting.
	 *
	 * @param terminal_id - the backend PTY's id
	 * @param exited - an exit that arrived before the `terminal_create` reply —
	 *   recorded instead of starting, discarding the queued input
	 */
	start(terminal_id: Uuid, exited: { exit_code: number | null } | null = null): void {
		this.terminal_id = terminal_id;
		if (exited) {
			this.receive_exited(exited.exit_code);
			return;
		}
		this.status = 'running';
		void this.#pump_input();
		void this.#pump_resize();
	}

	/**
	 * Records a failed spawn.
	 */
	fail(error_message: string): void {
		this.status = 'failed';
		this.error_message = error_message;
		this.#stop_io();
	}

	/**
	 * Records a natural process exit (`terminal_exited`).
	 * Ignored once the terminal has already exited or been closed.
	 */
	receive_exited(exit_code: number | null): void {
		if (this.status !== 'running' && this.status !== 'starting') return;
		this.status = 'exited';
		this.exit_code = exit_code;
		this.#stop_io();
	}

	/**
	 * Resets to `starting` for a fresh spawn — clears the backend id, exit state,
	 * errors, queued I/O, and buffered output.
	 */
	reset(): void {
		this.terminal_id = null;
		this.status = 'starting';
		this.exit_code = null;
		this.error_message = null;
		this.closing = false;
		this.output.clear();
		this.#stop_io();
		this.run++;
	}

	/**
	 * Queues `data` as input, sent in order with at most one `terminal_data_send`
	 * in flight. Input queued while starting is sent once the process starts.
	 *
	 * On `queue_overflow` (the child isn't reading its input) the data is retried
	 * with backoff — the backend enqueued none of it, so a resend can't duplicate —
	 * and the error is surfaced until a send succeeds. Any other failure is
	 * surfaced without a retry, because the data may have been delivered.
	 */
	send_input(data: string): void {
		if (!data) return;
		if (this.status !== 'running' && this.status !== 'starting') return;
		if (this.#input_pending.length + data.length > TERMINAL_INPUT_PENDING_MAX_LENGTH) {
			this.error_message = `input dropped: ${this.#input_pending.length} characters are already waiting to be sent`;
			return;
		}
		this.#input_pending += data;
		void this.#pump_input();
	}

	/**
	 * Requests a PTY resize, coalesced to the latest size while one is in flight.
	 */
	resize(cols: number, rows: number): void {
		this.#resize_pending = { cols, rows };
		void this.#pump_resize();
	}

	/**
	 * Closes the running process with `terminal_close`. The backend broadcasts
	 * no `terminal_exited` for a closed terminal, so the response settles the
	 * status — unless a natural exit was recorded first.
	 */
	async close(): Promise<void> {
		const { terminal_id } = this;
		if (this.status !== 'running' || this.closing || !terminal_id) return;
		this.closing = true;
		const result = await this.app.api.terminal_close({ terminal_id });
		if (terminal_id !== this.terminal_id) return; // restarted meanwhile
		this.closing = false;
		if (!result.ok) {
			this.error_message = `failed to close: ${result.error.message}`;
			return;
		}
		if (this.status === 'running') {
			this.status = 'closed';
			this.exit_code = result.value.exit_code;
			this.#stop_io();
		}
	}

	override dispose(): void {
		this.#stop_io();
		this.#output_listeners.clear();
		this.output.clear();
		super.dispose();
	}

	#stop_io(): void {
		this.#input_pending = '';
		this.#input_retry_delay = 0;
		if (this.#input_retry_timer !== null) {
			clearTimeout(this.#input_retry_timer);
			this.#input_retry_timer = null;
		}
		this.#resize_pending = null;
	}

	async #pump_input(): Promise<void> {
		if (this.#input_sending || this.#input_retry_timer !== null) return;
		this.#input_sending = true;
		try {
			while (this.#input_pending && this.status === 'running' && this.terminal_id) {
				const { terminal_id } = this;
				const data = this.#input_pending;
				this.#input_pending = '';
				const result = await this.app.api.terminal_data_send({ terminal_id, data });
				// restarted or ended meanwhile — the loop condition re-checks against the current process
				if (terminal_id !== this.terminal_id || this.status !== 'running') continue;
				if (result.ok) {
					this.#input_retry_delay = 0;
					this.error_message = null;
				} else if (result.error.code === JSONRPC_ERROR_CODES.queue_overflow) {
					this.#input_pending = data + this.#input_pending;
					this.#input_retry_delay = Math.min(
						INPUT_RETRY_DELAY_MAX,
						this.#input_retry_delay ? this.#input_retry_delay * 2 : INPUT_RETRY_DELAY_MIN
					);
					this.error_message = `input waiting: the terminal isn't reading its input (${this.#input_pending.length} characters queued)`;
					this.#input_retry_timer = setTimeout(() => {
						this.#input_retry_timer = null;
						void this.#pump_input();
					}, this.#input_retry_delay);
					return;
				} else {
					this.error_message = `failed to send input: ${result.error.message}`;
				}
			}
		} finally {
			this.#input_sending = false;
		}
	}

	async #pump_resize(): Promise<void> {
		if (this.#resize_sending) return;
		this.#resize_sending = true;
		try {
			while (this.#resize_pending && this.status === 'running' && this.terminal_id) {
				const { terminal_id } = this;
				const { cols, rows } = this.#resize_pending;
				this.#resize_pending = null;
				const result = await this.app.api.terminal_resize({ terminal_id, cols, rows });
				if (!result.ok && terminal_id === this.terminal_id) {
					this.error_message = `failed to resize: ${result.error.message}`;
				}
			}
		} finally {
			this.#resize_sending = false;
		}
	}
}
