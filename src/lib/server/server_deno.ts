/**
 * Deno entry point for zzz server.
 *
 * Production entry point when running the compiled binary (`zzz daemon start`).
 * Uses the shared `create_zzz_app` factory for the Hono app, then binds
 * with `Deno.serve` and handles daemon lifecycle (PID file, signals).
 *
 * @module
 */

import {upgradeWebSocket} from 'hono/deno';
import {
	write_daemon_info,
	read_daemon_info,
	is_daemon_running,
	get_daemon_info_path,
} from '@fuzdev/fuz_app/cli/daemon.js';
import type {
	EnvDeps,
	FsReadDeps,
	FsWriteDeps,
	FsRemoveDeps,
	CommandDeps,
	CommandResult,
	StatResult,
} from '@fuzdev/fuz_app/cli/runtime.js';

import {VERSION} from '../zzz/build_info.ts';
import {create_zzz_app} from './create_zzz_app.ts';
import {load_server_env} from './server_env.ts';

/** Deno adapter satisfying fuz_app's `*Deps` interfaces. */
const daemon_runtime: EnvDeps & FsReadDeps & FsWriteDeps & FsRemoveDeps & CommandDeps = {
	env_get: (name: string) => Deno.env.get(name),
	env_set: (name: string, value: string) => Deno.env.set(name, value),
	stat: async (path: string): Promise<StatResult | null> => {
		try {
			const s = await Deno.stat(path);
			return {is_file: s.isFile, is_directory: s.isDirectory};
		} catch {
			return null;
		}
	},
	read_file: (path: string) => Deno.readTextFile(path),
	mkdir: (path: string, opts?: {recursive?: boolean}) => Deno.mkdir(path, opts),
	write_file: (path: string, content: string) => Deno.writeTextFile(path, content),
	rename: (old_path: string, new_path: string) => Deno.rename(old_path, new_path),
	remove: (path: string) => Deno.remove(path),
	run_command: async (cmd: string, args: Array<string>): Promise<CommandResult> => {
		try {
			const proc = new Deno.Command(cmd, {args, stdout: 'piped', stderr: 'piped'});
			const result = await proc.output();
			return {
				success: result.code === 0,
				code: result.code,
				stdout: new TextDecoder().decode(result.stdout),
				stderr: new TextDecoder().decode(result.stderr),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {success: false, code: 1, stdout: '', stderr: message};
		}
	},
};

/**
 * Start the zzz server using Deno runtime.
 *
 * Creates the full backend with providers, WebSocket, and HTTP RPC
 * endpoints via `create_zzz_app`, then serves with `Deno.serve`.
 */
export const start_server_deno = async (): Promise<void> => {
	const env = load_server_env((key) => Deno.env.get(key), {
		port: 4460,
		host: 'localhost',
		zzz_dir: `${Deno.env.get('HOME') ?? '.'}/.zzz`,
		app_version: VERSION,
	});

	// Check for stale daemon info from a previous crash
	const stale = await read_daemon_info(daemon_runtime, 'zzz');
	if (stale) {
		if (await is_daemon_running(daemon_runtime, stale.pid)) {
			console.warn('[server] found running server', stale);
		} else {
			console.warn(`[server] stale daemon.json (pid ${stale.pid} not running), replacing`);
		}
	}

	const {app, backend} = await create_zzz_app({env, upgradeWebSocket});

	// Health check (always available, even before full backend)
	app.get('/health', (c) => c.json({status: 'ok', version: VERSION}));

	// Write daemon info for CLI discovery
	await write_daemon_info(daemon_runtime, 'zzz', {
		version: 1,
		pid: Deno.pid,
		port: env.port,
		started: new Date().toISOString(),
		app_version: env.app_version,
	});

	console.log(`[server] Listening on http://${env.host}:${env.port} (Deno)`);
	const server = Deno.serve({port: env.port, hostname: env.host}, app.fetch);

	// Cleanup on shutdown
	const shutdown = async (): Promise<void> => {
		console.log('[server] shutting down...');
		const daemon_path = get_daemon_info_path(daemon_runtime, 'zzz');
		if (daemon_path) {
			try {
				await daemon_runtime.remove(daemon_path);
			} catch {
				// already removed
			}
		}
		await backend.destroy();
		server.shutdown();
	};

	Deno.addSignalListener('SIGINT', () => void shutdown());
	Deno.addSignalListener('SIGTERM', () => void shutdown());

	// Wait for server to close
	await server.finished;
};

// Auto-start when run directly
if (import.meta.url === Deno.mainModule) {
	start_server_deno().catch((error) => {
		console.error('[server] Failed to start:', error);
		Deno.exit(1);
	});
}
