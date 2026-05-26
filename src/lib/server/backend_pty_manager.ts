import {Logger} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {BackendActionsApi} from './backend_action_types.js';
import type {PtyBackend, PtySession} from './pty_backend.js';

export interface PtyManagerOptions {
	api: BackendActionsApi;
	/**
	 * Runtime-specific spawn implementation. Injected at the server entry
	 * point — `create_deno_pty_backend` for the Deno daemon, the same for the
	 * Deno test binary, `create_node_pty_backend` for the Node/Bun test
	 * binaries. The manager never sniffs the runtime itself.
	 */
	backend: PtyBackend;
	log?: Logger | null;
}

/**
 * Manages spawned PTY processes keyed by `terminal_id`, fanning their output
 * and exit events out through `BackendActionsApi`. Process spawning + I/O is
 * delegated to the injected `PtyBackend`; this class owns only the
 * terminal-id bookkeeping and the notification wiring.
 */
export class PtyManager {
	readonly #sessions: Map<Uuid, PtySession> = new Map();
	readonly #api: BackendActionsApi;
	readonly #backend: PtyBackend;
	readonly log: Logger | null;

	constructor(options: PtyManagerOptions) {
		this.#api = options.api;
		this.#backend = options.backend;
		this.log = options.log === undefined ? new Logger('[pty_manager]') : options.log;
		this.log?.info(`PTY mode: ${this.#backend.mode}`);
	}

	/**
	 * Spawn a new PTY process and begin streaming its output.
	 *
	 * @throws when the backend detects a spawn failure synchronously (e.g.
	 *   the Deno `Command` path on a missing binary). Asynchronous spawn
	 *   failures surface as a `terminal_exited` notification instead.
	 */
	spawn(
		terminal_id: Uuid,
		command: string,
		args: Array<string>,
		cwd?: string,
		cols = 80,
		rows = 24,
	): void {
		if (this.#sessions.has(terminal_id)) {
			throw new Error(`terminal ${terminal_id} already exists`);
		}

		this.log?.info(`spawning terminal ${terminal_id}: ${command} ${args.join(' ')}`);

		const session = this.#backend.spawn(
			{terminal_id, command, args, cwd, cols, rows},
			{
				on_data: (data) => this.#api.terminal_data({terminal_id, data}),
				on_exit: (exit_code) => {
					this.log?.info(`terminal ${terminal_id} exited with code ${exit_code}`);
					this.#sessions.delete(terminal_id);
					void this.#api.terminal_exited({terminal_id, exit_code});
				},
			},
		);

		this.#sessions.set(terminal_id, session);
	}

	/**
	 * Write data to a terminal's stdin.
	 */
	async write(terminal_id: Uuid, data: string): Promise<void> {
		const session = this.#get_session(terminal_id);
		await session.write(new TextEncoder().encode(data));
	}

	/**
	 * Resize the PTY window. No-op for backends without real PTY sizing.
	 */
	resize(terminal_id: Uuid, cols: number, rows: number): void {
		this.#get_session(terminal_id).resize(cols, rows);
	}

	/**
	 * Kill a terminal process. Returns the exit status when known, else `null`.
	 * Tolerant of an already-exited terminal (returns `null`) so concurrent
	 * natural exits during `kill_all` / `destroy` don't throw.
	 */
	async kill(terminal_id: Uuid, signal?: string): Promise<number | null> {
		const session = this.#sessions.get(terminal_id);
		if (!session) return null;
		const exit_code = await session.kill(signal);
		this.#sessions.delete(terminal_id);
		return exit_code;
	}

	/**
	 * Check if a terminal exists and is tracked.
	 */
	has(terminal_id: Uuid): boolean {
		return this.#sessions.has(terminal_id);
	}

	/**
	 * Kill every active terminal process without destroying the manager.
	 *
	 * Non-destructive variant of {@link destroy} — the manager stays
	 * reusable, so subsequent `spawn` calls work normally. Used by the
	 * test binary's `_testing_reset` `reset_state` callback to clear
	 * cross-test terminal pollution without tearing the binary down
	 * between tests.
	 */
	async kill_all(): Promise<void> {
		if (this.#sessions.size === 0) return;
		this.log?.info(`killing ${this.#sessions.size} terminal(s)`);
		const kill_promises: Array<Promise<number | null>> = [];
		for (const terminal_id of this.#sessions.keys()) {
			kill_promises.push(this.kill(terminal_id));
		}
		await Promise.allSettled(kill_promises);
	}

	/**
	 * Kill all terminal processes. Called on backend shutdown.
	 */
	async destroy(): Promise<void> {
		this.log?.info(`destroying ${this.#sessions.size} terminal(s)`);
		const kill_promises: Array<Promise<number | null>> = [];
		for (const terminal_id of this.#sessions.keys()) {
			kill_promises.push(this.kill(terminal_id));
		}
		await Promise.allSettled(kill_promises);
	}

	#get_session(terminal_id: Uuid): PtySession {
		const session = this.#sessions.get(terminal_id);
		if (!session) {
			throw new Error(`terminal ${terminal_id} not found`);
		}
		return session;
	}
}
