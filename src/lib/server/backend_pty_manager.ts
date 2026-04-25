import {Logger} from '@fuzdev/fuz_util/log.js';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import type {BackendActionsApi} from './backend_actions_api.js';
import {
	is_ffi_available,
	pty_spawn,
	pty_read_status,
	pty_write,
	pty_resize,
	pty_close,
	pty_kill,
	pty_waitpid,
	SIGTERM,
} from './pty_ffi.js';

/**
 * FFI-backed PTY process — real terminal via forkpty.
 */
export interface FfiPtyProcess {
	kind: 'ffi';
	pid: number;
	master_fd: number;
	terminal_id: Uuid;
	command: string;
	args: Array<string>;
	reading: boolean;
}

/**
 * Fallback PTY process — Deno.Command with piped stdin/stdout/stderr.
 */
export interface FallbackPtyProcess {
	kind: 'fallback';
	process: Deno.ChildProcess;
	terminal_id: Uuid;
	command: string;
	args: Array<string>;
	stdin_writer: WritableStreamDefaultWriter<Uint8Array>;
}

export type PtyProcess = FfiPtyProcess | FallbackPtyProcess;

export interface PtyManagerOptions {
	api: BackendActionsApi;
	log?: Logger | null;
}

/**
 * Manages spawned PTY processes keyed by terminal_id.
 * Uses real PTY via FFI when available, falls back to Deno.Command pipes.
 */
export class PtyManager {
	readonly #processes: Map<Uuid, PtyProcess> = new Map();
	readonly #api: BackendActionsApi;
	readonly log: Logger | null;
	readonly use_ffi: boolean;

	constructor(options: PtyManagerOptions) {
		this.#api = options.api;
		this.log = options.log === undefined ? new Logger('[pty_manager]') : options.log;
		this.use_ffi = is_ffi_available();
		this.log?.info(
			`PTY mode: ${this.use_ffi ? 'FFI (real PTY)' : 'fallback (Deno.Command pipes)'}`,
		);
	}

	/**
	 * Spawn a new PTY process and begin streaming its output.
	 */
	spawn(
		terminal_id: Uuid,
		command: string,
		args: Array<string>,
		cwd?: string,
		cols = 80,
		rows = 24,
	): void {
		if (this.#processes.has(terminal_id)) {
			throw new Error(`terminal ${terminal_id} already exists`);
		}

		this.log?.info(`spawning terminal ${terminal_id}: ${command} ${args.join(' ')}`);

		if (this.use_ffi) {
			this.#spawn_ffi(terminal_id, command, args, cwd, cols, rows);
		} else {
			this.#spawn_fallback(terminal_id, command, args, cwd);
		}
	}

	#spawn_ffi(
		terminal_id: Uuid,
		command: string,
		args: Array<string>,
		cwd?: string,
		cols = 80,
		rows = 24,
	): void {
		const {pid, master_fd} = pty_spawn(command, args, cwd, cols, rows);

		const pty_process: FfiPtyProcess = {
			kind: 'ffi',
			pid,
			master_fd,
			terminal_id,
			command,
			args,
			reading: true,
		};

		this.#processes.set(terminal_id, pty_process);

		// start async read loop
		void this.#ffi_read_loop(terminal_id, pty_process);
	}

	async #ffi_read_loop(terminal_id: Uuid, pty: FfiPtyProcess): Promise<void> {
		const decoder = new TextDecoder();

		while (pty.reading) {
			const result = pty_read_status(pty.master_fd);

			if (result === 'eof') {
				// process exited — collect exit status
				this.log?.info(`terminal ${terminal_id} EOF`);
				const wait = pty_waitpid(pty.pid);
				const exit_code = wait.exited ? wait.status : null;
				if (wait.exited) {
					this.log?.info(`terminal ${terminal_id} exited with status ${wait.status}`);
				}
				pty_close(pty.master_fd);
				this.#processes.delete(terminal_id);
				void this.#api.terminal_exited({terminal_id, exit_code});
				return;
			}

			if (result === 'eagain') {
				// no data available — yield and retry
				await new Promise((resolve) => setTimeout(resolve, 10));
				continue;
			}

			// got data
			const data = decoder.decode(result, {stream: true});
			if (data.length > 0) {
				await this.#api.terminal_data({terminal_id, data});
			}
		}

		// reading was stopped (kill was called)
		pty_close(pty.master_fd);
		this.#processes.delete(terminal_id);
	}

	#spawn_fallback(terminal_id: Uuid, command: string, args: Array<string>, cwd?: string): void {
		const cmd = new Deno.Command(command, {
			args,
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
			cwd,
		});

		const process = cmd.spawn();
		const stdin_writer = process.stdin.getWriter();

		const pty_process: FallbackPtyProcess = {
			kind: 'fallback',
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
			void this.#api.terminal_exited({terminal_id, exit_code: status.code});
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
		const encoded = encoder.encode(data);

		if (pty.kind === 'ffi') {
			pty_write(pty.master_fd, encoded);
		} else {
			await pty.stdin_writer.write(encoded);
		}
	}

	/**
	 * Resize the PTY window. Only works in FFI mode.
	 */
	resize(terminal_id: Uuid, cols: number, rows: number): void {
		const pty = this.#get_process(terminal_id);
		if (pty.kind === 'ffi') {
			pty_resize(pty.master_fd, cols, rows);
		}
		// fallback mode: no-op (Deno.Command doesn't support resize)
	}

	/**
	 * Kill a terminal process.
	 */
	async kill(terminal_id: Uuid, signal?: string): Promise<number | null> {
		const pty = this.#get_process(terminal_id);

		if (pty.kind === 'ffi') {
			pty.reading = false;
			try {
				pty_kill(pty.pid, SIGTERM);
			} catch {
				// process may already be dead
			}
			// give process time to exit
			await new Promise((resolve) => setTimeout(resolve, 50));
			const wait = pty_waitpid(pty.pid);
			pty_close(pty.master_fd);
			this.#processes.delete(terminal_id);
			return wait.exited ? wait.status : null;
		}

		// fallback
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
