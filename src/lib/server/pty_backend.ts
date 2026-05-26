/**
 * Runtime-neutral PTY backend contract.
 *
 * `PtyManager` orchestrates terminals (tracks them by `terminal_id`, fans
 * output/exit out to `BackendActionsApi`) but knows nothing about how a
 * process is actually spawned. Each runtime supplies a `PtyBackend`: the
 * Deno entry injects `create_deno_pty_backend` (`pty_backend_deno.ts`, real
 * PTY via `fuz_pty` FFI with a `Deno.Command` pipe fallback); the Node/Bun
 * entries inject `create_node_pty_backend` (`pty_backend_node.ts`,
 * `node:child_process` pipes). The runtime is decided at the server entry
 * point, not sniffed inside the manager — no `typeof Deno` branching.
 *
 * @module
 */

import type {Uuid} from '@fuzdev/fuz_util/id.js';

/** A request to spawn one PTY/process. */
export interface PtySpawnRequest {
	terminal_id: Uuid;
	command: string;
	args: Array<string>;
	cwd?: string;
	cols: number;
	rows: number;
}

/** Callbacks a `PtyBackend` invokes over the life of a spawned process. */
export interface PtySpawnHandlers {
	/** Invoked with each decoded chunk of terminal output. */
	on_data: (data: string) => void | Promise<void>;
	/**
	 * Invoked once when the process exits on its own (EOF / natural exit /
	 * spawn failure). NOT invoked for a caller-initiated `PtySession.kill` —
	 * the killer receives the exit status from `kill`'s return value instead,
	 * so terminals closed via `terminal_close` don't also emit a redundant
	 * `terminal_exited` notification.
	 */
	on_exit: (exit_code: number | null) => void;
}

/** A live PTY session — the runtime-specific process handle. */
export interface PtySession {
	/** Write bytes to the process's stdin. */
	write(data: Uint8Array): void | Promise<void>;
	/** Resize the PTY window. No-op for backends without real PTY sizing. */
	resize(cols: number, rows: number): void;
	/** Kill the process. Resolves with the exit status when known, else `null`. */
	kill(signal?: string): Promise<number | null>;
}

/** Runtime-specific PTY implementation, injected at the server entry point. */
export interface PtyBackend {
	/** Human-readable mode label for logging (e.g. `ffi (real PTY)`). */
	readonly mode: string;
	/**
	 * Spawn a process and begin streaming its output through `handlers`.
	 *
	 * @throws when the runtime can detect a spawn failure synchronously
	 *   (e.g. Deno's `Command.spawn` on a missing binary). Backends that
	 *   only learn of failure asynchronously (`node:child_process`) report
	 *   it through `handlers.on_exit` instead.
	 */
	spawn(request: PtySpawnRequest, handlers: PtySpawnHandlers): PtySession;
}
