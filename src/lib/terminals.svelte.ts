import { z } from 'zod';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { Terminal, TerminalJson, type TerminalJsonInput } from './terminal.svelte.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { CellJson } from './cell_types.ts';
import { TerminalOutputBuffer } from './terminal_helpers.ts';

export const TerminalsJson = CellJson.extend({
	items: z.array(TerminalJson).default(() => [])
}).meta({ cell_class_name: 'Terminals' });
export type TerminalsJson = z.infer<typeof TerminalsJson>;
export type TerminalsJsonInput = z.input<typeof TerminalsJson>;

export interface TerminalsOptions extends CellOptions<typeof TerminalsJson> {}

/** Max terminal ids whose early output is held while a spawn is in flight. */
const UNCLAIMED_MAX = 16;

/**
 * Max characters of early output held per unknown terminal id — enough for a
 * shell's first prompt, small enough that other clients' output stays cheap.
 */
const UNCLAIMED_OUTPUT_MAX_LENGTH = 64 * 1024;

/** Output and exit that arrived for a terminal id before its `terminal_create` resolved. */
interface UnclaimedTerminal {
	output: TerminalOutputBuffer;
	exited: boolean;
	exit_code: number | null;
}

/**
 * App-level collection of terminal runs — outlives the views that render them,
 * so navigating away and back reattaches to live terminals and their output.
 *
 * Every terminal spawns a shell (`sh`) and types its command line into it,
 * so the session stays alive for follow-up input.
 *
 * After a reconnect, `reconcile` marks the terminals the backend no longer has
 * as `lost` (from the `session_load` snapshot's `terminal_ids`).
 *
 * TODO the list is in-memory, so a page reload loses it while the backend PTYs
 * keep running — `session_load` lists their ids, but reattaching would also
 * need their commands and output.
 */
export class Terminals extends Cell<typeof TerminalsJson> {
	readonly items: IndexedCollection<Terminal> = new IndexedCollection({
		dispose_item: (terminal) => terminal.dispose()
	});

	/** Terminals by their current backend `terminal_id`, for routing notifications. */
	readonly #by_terminal_id: Map<Uuid, Terminal> = new Map();

	/** Count of `terminal_create` calls in flight. */
	#creating = 0;

	/**
	 * Output and exits for unknown terminal ids, held only while a spawn is in
	 * flight — the backend can send a new shell's first output before the
	 * `terminal_create` response arrives. Notifications reach every socket of
	 * the creating account, so another tab's terminals show up here too.
	 */
	readonly #unclaimed: Map<Uuid, UnclaimedTerminal> = new Map();

	constructor(options: TerminalsOptions) {
		super(TerminalsJson, options);

		this.decoders = {
			items: create_collection_decoder(
				() => this.clear(),
				(json) => this.add(json)
			)
		};

		this.init();
	}

	/**
	 * Looks up a terminal by its backend `terminal_id`.
	 */
	get_by_terminal_id(terminal_id: Uuid): Terminal | undefined {
		return this.#by_terminal_id.get(terminal_id);
	}

	/**
	 * Adds a terminal cell without spawning a process. See `create` to spawn one.
	 */
	add(json?: TerminalJsonInput): Terminal {
		const terminal = new Terminal({ app: this.app, json });
		this.items.add(terminal);
		if (terminal.terminal_id) this.#by_terminal_id.set(terminal.terminal_id, terminal);
		return terminal;
	}

	/**
	 * Adds a terminal and spawns its process. A spawn failure is recorded on the
	 * terminal (`status: 'failed'` + `error_message`), so this doesn't reject.
	 */
	async create(
		json: Pick<TerminalJsonInput, 'name' | 'command' | 'args' | 'cwd' | 'preset_id'>
	): Promise<Terminal> {
		const terminal = this.add({ ...json, status: 'starting' });
		this.#queue_command_line(terminal);
		await this.#spawn(terminal);
		return terminal;
	}

	/**
	 * Closes the terminal's process if it's running, then spawns a fresh one
	 * with a new `terminal_id` and cleared output. Does nothing if the close
	 * fails — the error is on the terminal — to avoid orphaning a live process.
	 */
	async restart(terminal: Terminal): Promise<void> {
		if (terminal.status === 'running') await terminal.close();
		if (terminal.status === 'running' || terminal.status === 'starting') return;
		if (!this.items.has(terminal.id)) return;
		this.#unindex(terminal);
		terminal.reset();
		this.#queue_command_line(terminal);
		await this.#spawn(terminal);
	}

	/**
	 * Closes the terminal's process if it's running, then removes and disposes
	 * the terminal. Keeps it if the close fails, so the process stays reachable.
	 * A terminal removed while starting has its process closed once spawned.
	 */
	async remove(terminal: Terminal): Promise<void> {
		if (terminal.status === 'running') {
			await terminal.close();
			if (terminal.status === 'running') return;
		}
		this.#unindex(terminal);
		this.items.remove(terminal.id);
	}

	/**
	 * Removes and disposes every terminal without closing their processes.
	 */
	clear(): void {
		this.items.clear();
		this.#by_terminal_id.clear();
	}

	/**
	 * Routes a `terminal_data` notification to its terminal, buffering it
	 * whether or not a view is mounted.
	 */
	receive_output(terminal_id: Uuid, data: string): void {
		const terminal = this.#by_terminal_id.get(terminal_id);
		if (terminal) {
			terminal.receive_output(data);
			return;
		}
		// otherwise another client's terminal, one closed or restarted here, or
		// (only while spawning) the output of a spawn whose response hasn't arrived
		this.#get_unclaimed(terminal_id)?.output.push(data);
	}

	/**
	 * Routes a `terminal_exited` notification to its terminal, recording the exit
	 * whether or not a view is mounted.
	 */
	receive_exited(terminal_id: Uuid, exit_code: number | null): void {
		const terminal = this.#by_terminal_id.get(terminal_id);
		if (terminal) {
			terminal.receive_exited(exit_code);
			return;
		}
		const unclaimed = this.#get_unclaimed(terminal_id);
		if (unclaimed) {
			unclaimed.exited = true;
			unclaimed.exit_code = exit_code;
		}
	}

	/**
	 * The backend ids of the running terminals.
	 */
	running_terminal_ids(): Set<Uuid> {
		const ids: Set<Uuid> = new Set();
		for (const terminal of this.items.values) {
			if (terminal.status === 'running' && terminal.terminal_id) ids.add(terminal.terminal_id);
		}
		return ids;
	}

	/**
	 * Marks every running terminal as possibly missing output (see
	 * `Terminal.output_gap`) — called when the socket reconnects.
	 */
	mark_output_gap(): void {
		for (const terminal of this.items.values) terminal.mark_output_gap();
	}

	/**
	 * Reconciles with the backend's live terminals from a session snapshot: a
	 * running terminal it doesn't list is marked `lost`, since its
	 * `terminal_exited` (if any) was missed.
	 *
	 * @param live_terminal_ids - the snapshot's `terminal_ids`
	 * @param known_terminal_ids - the ids running when the snapshot was
	 *   requested; only these are judged, since a terminal started after the
	 *   request may postdate the snapshot
	 * @param reason - the lost terminals' `error_message`
	 */
	reconcile(
		live_terminal_ids: ReadonlySet<Uuid>,
		known_terminal_ids: ReadonlySet<Uuid>,
		reason: string
	): void {
		for (const terminal of this.items.values) {
			const { terminal_id } = terminal;
			if (
				terminal.status === 'running' &&
				terminal_id &&
				known_terminal_ids.has(terminal_id) &&
				!live_terminal_ids.has(terminal_id)
			) {
				terminal.mark_lost(reason);
			}
		}
	}

	override dispose(): void {
		this.clear();
		this.#unclaimed.clear();
		super.dispose();
	}

	async #spawn(terminal: Terminal): Promise<void> {
		this.#creating++;
		try {
			const result = await this.app.api.terminal_create({
				command: 'sh',
				args: [],
				...(terminal.cwd === undefined ? {} : { cwd: terminal.cwd })
			});
			if (!result.ok) {
				terminal.fail(`failed to run "${terminal.display_command}": ${result.error.message}`);
				return;
			}
			const { terminal_id } = result.value;
			const unclaimed = this.#unclaimed.get(terminal_id);
			this.#unclaimed.delete(terminal_id);

			// removed while starting — don't leave the process running unreachable
			if (!this.items.has(terminal.id)) {
				if (!unclaimed?.exited) void this.app.api.terminal_close({ terminal_id });
				return;
			}

			this.#by_terminal_id.set(terminal_id, terminal);
			if (unclaimed) {
				terminal.receive_output(unclaimed.output.text);
				if (unclaimed.output.dropped) terminal.output.mark_dropped();
			}
			// an exit that beat the reply means the queued input has nowhere to go
			terminal.start(terminal_id, unclaimed?.exited ? { exit_code: unclaimed.exit_code } : null);
		} finally {
			this.#creating--;
			if (this.#creating === 0) this.#unclaimed.clear();
		}
	}

	/**
	 * Queues the terminal's command line while it's starting, so it's typed into
	 * the shell ahead of any input sent before the process starts.
	 */
	#queue_command_line(terminal: Terminal): void {
		const line = terminal.display_command;
		if (line) terminal.send_input(line + '\n');
	}

	#get_unclaimed(terminal_id: Uuid): UnclaimedTerminal | undefined {
		if (this.#creating === 0) return undefined;
		let unclaimed = this.#unclaimed.get(terminal_id);
		if (!unclaimed) {
			if (this.#unclaimed.size >= UNCLAIMED_MAX) {
				const oldest = this.#unclaimed.keys().next().value;
				if (oldest !== undefined) this.#unclaimed.delete(oldest);
			}
			unclaimed = {
				output: new TerminalOutputBuffer(UNCLAIMED_OUTPUT_MAX_LENGTH),
				exited: false,
				exit_code: null
			};
			this.#unclaimed.set(terminal_id, unclaimed);
		}
		return unclaimed;
	}

	#unindex(terminal: Terminal): void {
		if (terminal.terminal_id && this.#by_terminal_id.get(terminal.terminal_id) === terminal) {
			this.#by_terminal_id.delete(terminal.terminal_id);
		}
	}
}
