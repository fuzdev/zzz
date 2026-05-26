/**
 * Node/Bun `PtyBackend` — piped-stdio child processes via `node:child_process`.
 *
 * No real PTY (no echo, no window sizing); the fallback semantics match the
 * Deno `Command` path. Used by the cross-process test binaries on the Node
 * and Bun runtimes, where Deno's FFI + `Deno.Command` aren't available. Bun
 * implements `node:child_process`, so it shares this backend.
 *
 * @module
 */

import {spawn, type ChildProcess} from 'node:child_process';

import type {PtyBackend, PtySession, PtySpawnHandlers, PtySpawnRequest} from './pty_backend.js';

/** Exit code reported when a process fails to spawn (matches shell `command not found`). */
const SPAWN_FAILURE_EXIT_CODE = 127;

/** Create the Node/Bun PTY backend backed by `node:child_process` pipes. */
export const create_node_pty_backend = (): PtyBackend => ({
	mode: 'fallback (node:child_process pipes)',
	spawn(request: PtySpawnRequest, handlers: PtySpawnHandlers): PtySession {
		const child: ChildProcess = spawn(request.command, request.args, {
			cwd: request.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let exited = false;
		let killed = false;
		const decoder = new TextDecoder();

		const emit = (chunk: Uint8Array): void => {
			const data = decoder.decode(chunk, {stream: true});
			if (data.length > 0) void handlers.on_data(data);
		};
		child.stdout?.on('data', emit);
		child.stderr?.on('data', emit);

		const finish = (exit_code: number | null): void => {
			if (exited) return;
			exited = true;
			if (!killed) handlers.on_exit(exit_code);
		};

		// `error` fires when the binary can't be spawned (ENOENT, EACCES);
		// node may not emit `exit` in that case, so report 127 here.
		child.on('error', () => finish(SPAWN_FAILURE_EXIT_CODE));
		child.on('exit', (code) => finish(code));

		return {
			write(data) {
				child.stdin?.write(data);
			},
			resize() {
				// node:child_process pipes have no window size
			},
			async kill(signal) {
				killed = true;
				try {
					child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
				} catch {
					// process may already be dead
				}
				// the killer doesn't observe the exit status (signal-killed
				// processes report `null` anyway); `terminal_close` is lenient.
				return null;
			},
		};
	},
});
