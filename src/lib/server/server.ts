/**
 * Deno server entry point for zzz.
 *
 * Single entry point for both dev mode (`gro dev` via `gro_plugin_deno_server`)
 * and production (`zzz daemon start`). Uses the shared `create_zzz_app` factory
 * for the Hono app, then binds with `Deno.serve` and handles daemon lifecycle.
 *
 * @module
 */

import {
	write_daemon_info,
	read_daemon_info,
	is_daemon_running,
	get_daemon_info_path,
} from '@fuzdev/fuz_app/cli/daemon.js';
import {create_deno_runtime} from '@fuzdev/fuz_app/runtime/deno.js';
import {load_env_file} from '@fuzdev/fuz_app/env/dotenv.js';

import {VERSION} from '../zzz/build_info.ts';
import {create_zzz_app} from './create_zzz_app.ts';
import {load_server_env} from './server_env.ts';
import {is_open_host} from './security.ts';

/** Shared runtime for daemon lifecycle and server operations. */
const daemon_runtime = create_deno_runtime([]);

/**
 * Start the zzz server using Deno runtime.
 *
 * Creates the full backend with providers, WebSocket, and HTTP RPC
 * endpoints via `create_zzz_app`, then serves with `Deno.serve`.
 */
export const start_server = async (): Promise<void> => {
	// Load .env file if present — values don't override existing env vars.
	// When running under `gro dev`, Vite already loads .env files into the
	// spawned Deno process. For `zzz daemon start`, this is the only loader.
	const dotenv = await load_env_file(daemon_runtime, '.env');
	if (dotenv) {
		for (const [key, value] of Object.entries(dotenv)) {
			if (Deno.env.get(key) === undefined) {
				Deno.env.set(key, value);
			}
		}
	}

	// Set runtime defaults for env vars that need dynamic values.
	// These only apply when the var isn't already set (by .env, CLI flags, or gro dev).
	if (Deno.env.get('PUBLIC_ZZZ_DIR') === undefined) {
		Deno.env.set('PUBLIC_ZZZ_DIR', `${Deno.env.get('HOME') ?? '.'}/.zzz`);
	}

	const env = load_server_env((key) => Deno.env.get(key), {
		app_version: VERSION,
	});

	// Validate binding address — refuse to expose to network without authentication
	// TODO allow 0.0.0.0 binding once bearer token auth is implemented —
	// generate token on start, write to daemon.json, require on all requests.
	// See tx's bearer_auth.ts in fuz_app for the pattern. Consider requiring
	// a keeper account (like tx) instead of or in addition to a bearer token.
	if (is_open_host(env.host)) {
		console.error(
			`[server] FATAL: binding to '${env.host}' exposes zzz to your entire network.\n` +
				`  zzz has no authentication — anyone on your network could read/write files and run commands.\n` +
				`  Use --host localhost (default) or --host 127.0.0.1 instead.`,
		);
		Deno.exit(1);
	}

	// Check for stale daemon info from a previous crash
	const stale = await read_daemon_info(daemon_runtime, 'zzz');
	if (stale) {
		if (await is_daemon_running(daemon_runtime, stale.pid)) {
			console.warn('[server] found running server', stale);
		} else {
			console.warn(`[server] stale daemon.json (pid ${stale.pid} not running), replacing`);
		}
	}

	const {app, backend} = create_zzz_app({env});

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
	let shutting_down = false;
	const shutdown = async (): Promise<void> => {
		if (shutting_down) {
			// Second signal — force exit
			Deno.exit(1);
		}
		shutting_down = true;
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
		await server.shutdown();
		Deno.exit(0);
	};

	Deno.addSignalListener('SIGINT', () => void shutdown());
	Deno.addSignalListener('SIGTERM', () => void shutdown());

	// Wait for server to close
	await server.finished;
};

// Auto-start when run directly
if (import.meta.url === Deno.mainModule) {
	start_server().catch((error) => {
		console.error('[server] Failed to start:', error);
		Deno.exit(1);
	});
}
