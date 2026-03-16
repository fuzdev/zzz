import {Logger} from '@fuzdev/fuz_util/log.js';

import type {Uuid} from '../zod_helpers.js';
import type {BackendActionsApi} from './backend_actions_api.js';

export interface PtyProcess {
	process: Deno.ChildProcess;
	terminal_id: Uuid;
	command: string;
	args: Array<string>;
	stdin_writer: WritableStreamDefaultWriter<Uint8Array>;
}

export interface PtyManagerOptions {
	api: BackendActionsApi;
	log?: Logger | null;
}

/**
 * Manages spawned PTY processes keyed by terminal_id.
 */
export class PtyManager {
	readonly #processes: Map<Uuid, PtyProcess> = new Map();
	readonly #api: BackendActionsApi;
	readonly log: Logger | null;

	constructor(options: PtyManagerOptions) {
		this.#api = options.api;
		this.log = options.log === undefined ? new Logger('[pty_manager]') : options.log;
	}

	/**
	 * Spawn a new PTY process and begin streaming its output.
	 */
	spawn(terminal_id: Uuid, command: string, args: Array<string>, cwd?: string): void {
		if (this.#processes.has(terminal_id)) {
			throw new Error(`terminal ${terminal_id} already exists`);
		}

		this.log?.info(`spawning terminal ${terminal_id}: ${command} ${args.join(' ')}`);

		const cmd = new Deno.Command(command, {
			args,
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
			cwd,
			// @ts-ignore -- Deno PTY support
			pty: true,
		});

		const process = cmd.spawn();
		const stdin_writer = process.stdin.getWriter();

		const pty_process: PtyProcess = {
			process,
			terminal_id,
			command,
			args,
			stdin_writer,
		};

		this.#processes.set(terminal_id, pty_process);

		// stream stdout and stderr
		void this.#stream_output(terminal_id, process.stdout);
		void this.#stream_output(terminal_id, process.stderr);

		// watch for process exit
		void process.status.then((status) => {
			this.log?.info(`terminal ${terminal_id} exited with code ${status.code}`);
			this.#processes.delete(terminal_id);
		});
	}

	async #stream_output(terminal_id: Uuid, stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			for (;;) {
				const {done, value} = await reader.read();
				if (done) break;
				const data = decoder.decode(value, {stream: true});
				if (data.length > 0) {
					await this.#api.terminal_data({terminal_id, data});
				}
			}
		} catch (error) {
			// stream closed, expected on process exit
			this.log?.info(`terminal ${terminal_id} output stream ended`, error);
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Write data to a terminal's stdin.
	 */
	async write(terminal_id: Uuid, data: string): Promise<void> {
		const pty = this.#get_process(terminal_id);
		const encoder = new TextEncoder();
		await pty.stdin_writer.write(encoder.encode(data));
	}

	/**
	 * Kill a terminal process.
	 */
	async kill(terminal_id: Uuid, signal?: string): Promise<number | null> {
		const pty = this.#get_process(terminal_id);
		try {
			pty.process.kill(signal as Deno.Signal | undefined);
		} catch {
			// process may already be dead
		}
		try {
			pty.stdin_writer.releaseLock();
		} catch {
			// writer may already be released
		}
		const status = await pty.process.status;
		this.#processes.delete(terminal_id);
		return status.code;
	}

	/**
	 * Check if a terminal exists and is tracked.
	 */
	has(terminal_id: Uuid): boolean {
		return this.#processes.has(terminal_id);
	}

	/**
	 * Kill all terminal processes. Called on backend shutdown.
	 */
	async destroy(): Promise<void> {
		this.log?.info(`destroying ${this.#processes.size} terminal(s)`);
		const kill_promises: Array<Promise<number | null>> = [];
		for (const terminal_id of this.#processes.keys()) {
			kill_promises.push(this.kill(terminal_id));
		}
		await Promise.allSettled(kill_promises);
	}

	#get_process(terminal_id: Uuid): PtyProcess {
		const pty = this.#processes.get(terminal_id);
		if (!pty) {
			throw new Error(`terminal ${terminal_id} not found`);
		}
		return pty;
	}
}
