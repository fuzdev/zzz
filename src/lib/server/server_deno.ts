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
import {create_deno_runtime} from '@fuzdev/fuz_app/cli/runtime_deno.js';

import {VERSION} from '../zzz/build_info.ts';
import {create_zzz_app} from './create_zzz_app.ts';
import {load_server_env} from './server_env.ts';

/** Shared runtime for daemon lifecycle and server operations. */
const daemon_runtime = create_deno_runtime([]);

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
