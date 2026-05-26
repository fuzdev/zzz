/**
 * Deno `PtyBackend` — real PTY via the `fuz_pty` FFI when available, with a
 * `Deno.Command` piped-stdio fallback. This is the only PTY module that
 * touches Deno globals; `PtyManager` stays runtime-neutral and the Node/Bun
 * entries inject `create_node_pty_backend` instead.
 *
 * @module
 */

import {Logger} from '@fuzdev/fuz_util/log.js';

import type {PtyBackend, PtySession, PtySpawnHandlers, PtySpawnRequest} from './pty_backend.js';
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

/** Poll interval (ms) for the FFI read loop when no data is available. */
const FFI_READ_POLL_MS = 10;
/** Grace period (ms) after SIGTERM before reaping a killed FFI process. */
const FFI_KILL_GRACE_MS = 50;

/**
 * Create the Deno PTY backend. Probes FFI availability once; falls back to
 * `Deno.Command` pipes (no echo, no resize) when `libfuz_pty` isn't found.
 */
export const create_deno_pty_backend = (
	log: Logger | null = new Logger('[pty_deno]'),
): PtyBackend => {
	const use_ffi = is_ffi_available();
	const mode = use_ffi ? 'ffi (real PTY)' : 'fallback (Deno.Command pipes)';

	const spawn_ffi = (request: PtySpawnRequest, handlers: PtySpawnHandlers): PtySession => {
		const {pid, master_fd} = pty_spawn(
			request.command,
			request.args,
			request.cwd,
			request.cols,
			request.rows,
		);

		let reading = true;
		let killed = false;
		const decoder = new TextDecoder();

		const read_loop = async (): Promise<void> => {
			while (reading) {
				const result = pty_read_status(master_fd);

				if (result === 'eof') {
					const wait = pty_waitpid(pid);
					const exit_code = wait.exited ? wait.status : null;
					pty_close(master_fd);
					if (!killed) handlers.on_exit(exit_code);
					return;
				}

				if (result === 'eagain') {
					await new Promise((resolve) => setTimeout(resolve, FFI_READ_POLL_MS));
					continue;
				}

				const data = decoder.decode(result, {stream: true});
				if (data.length > 0) await handlers.on_data(data);
			}

			// reading was stopped by kill — the killer owns the exit status
			pty_close(master_fd);
		};
		void read_loop();

		return {
			write(data) {
				pty_write(master_fd, data);
			},
			resize(cols, rows) {
				pty_resize(master_fd, cols, rows);
			},
			async kill() {
				killed = true;
				reading = false;
				try {
					pty_kill(pid, SIGTERM);
				} catch {
					// process may already be dead
				}
				// give the process time to exit before reaping
				await new Promise((resolve) => setTimeout(resolve, FFI_KILL_GRACE_MS));
				const wait = pty_waitpid(pid);
				return wait.exited ? wait.status : null;
			},
		};
	};

	const spawn_fallback = (request: PtySpawnRequest, handlers: PtySpawnHandlers): PtySession => {
		const cmd = new Deno.Command(request.command, {
			args: request.args,
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
			cwd: request.cwd,
		});

		const process = cmd.spawn();
		const stdin_writer = process.stdin.getWriter();
		let killed = false;

		const stream_output = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
			const decoder = new TextDecoder();
			const reader = stream.getReader();
			try {
				for (;;) {
					const {done, value} = await reader.read();
					if (done) break;
					const data = decoder.decode(value, {stream: true});
					if (data.length > 0) await handlers.on_data(data);
				}
			} catch (error) {
				// stream closed, expected on process exit
				log?.info(`terminal ${request.terminal_id} output stream ended`, error);
			} finally {
				reader.releaseLock();
			}
		};

		void stream_output(process.stdout);
		void stream_output(process.stderr);

		void process.status.then((status) => {
			if (!killed) handlers.on_exit(status.code);
		});

		return {
			async write(data) {
				await stdin_writer.write(data);
			},
			resize() {
				// fallback mode: no-op (Deno.Command doesn't support resize)
			},
			async kill(signal) {
				killed = true;
				try {
					process.kill(signal as Deno.Signal | undefined);
				} catch {
					// process may already be dead
				}
				try {
					stdin_writer.releaseLock();
				} catch {
					// writer may already be released
				}
				const status = await process.status;
				return status.code;
			},
		};
	};

	return {
		mode,
		spawn: use_ffi ? spawn_ffi : spawn_fallback,
	};
};
