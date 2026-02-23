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

import {VERSION} from '../zzz/build_info.ts';
import {create_zzz_app} from './create_zzz_app.ts';
import {load_server_env} from './server_env.ts';
import {server_info_write, server_info_remove} from './server_info.ts';

/**
 * Start the zzz server using Deno runtime.
 *
 * Creates the full backend with providers, WebSocket, and HTTP RPC
 * endpoints via `create_zzz_app`, then serves with `Deno.serve`.
 */
export const start_server_deno = async (): Promise<void> => {
	const home = Deno.env.get('HOME');
	const zzz_dir = home ? `${home}/.zzz` : '.zzz';

	const env = load_server_env((key) => Deno.env.get(key), {
		port: 4460,
		host: 'localhost',
		zzz_dir,
		zzz_version: VERSION,
	});

	const {app, backend} = await create_zzz_app({env, upgradeWebSocket});

	// Health check (always available, even before full backend)
	app.get('/health', (c) => c.json({status: 'ok', version: VERSION}));

	// Write daemon info for CLI discovery
	await server_info_write({
		zzz_dir: env.zzz_dir,
		port: env.port,
		zzz_version: env.zzz_version,
	});

	console.log(`[server] Listening on http://${env.host}:${env.port} (Deno)`);
	const server = Deno.serve({port: env.port, hostname: env.host}, app.fetch);

	// Cleanup on shutdown
	const shutdown = async (): Promise<void> => {
		console.log('[server] shutting down...');
		await server_info_remove(env.zzz_dir);
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
