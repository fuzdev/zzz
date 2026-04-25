/**
 * Deno server entry point for zzz.
 *
 * Single entry point for both dev mode (`gro dev` via `gro_plugin_deno_server`)
 * and production (`zzz daemon start`). Uses the shared `create_zzz_app` factory
 * for the Hono app with fuz_app auth stack, then binds with `Deno.serve`
 * and handles daemon lifecycle.
 *
 * @module
 */

import {upgradeWebSocket} from 'hono/deno';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {
	write_daemon_info,
	read_daemon_info,
	is_daemon_running,
	get_daemon_info_path,
} from '@fuzdev/fuz_app/cli/daemon.js';
import {create_deno_runtime} from '@fuzdev/fuz_app/runtime/deno.js';
import {load_env_file} from '@fuzdev/fuz_app/env/dotenv.js';
import {argon2_password_deps} from '@fuzdev/fuz_app/auth/password_argon2.js';
import {verify_request_source} from '@fuzdev/fuz_app/http/origin.js';
import {require_auth} from '@fuzdev/fuz_app/auth/request_context.js';

import {VERSION} from '../zzz/build_info.ts';
import {create_zzz_app} from './create_zzz_app.ts';
import {load_server_env} from './server_env.ts';
import {is_open_host} from './security.ts';
import {register_websocket_actions} from './register_websocket_actions.ts';
import {ENV_FILE} from './constants.ts';
import {BackendWebsocketTransport} from '@fuzdev/fuz_app/actions/transports_ws_backend.js';
import {create_ws_auth_guard} from '@fuzdev/fuz_app/actions/transports_ws_auth_guard.js';

const log = new Logger('[server]');

/** Shared runtime for daemon lifecycle and server operations. */
const daemon_runtime = create_deno_runtime([]);

/**
 * Start the zzz server using Deno runtime.
 *
 * Creates the full backend with auth, database, providers, WebSocket, and HTTP RPC
 * endpoints via `create_zzz_app`, then serves with `Deno.serve`.
 */
export const start_server = async (): Promise<void> => {
	// Load env file if present — values don't override existing env vars.
	// When running under `gro dev`, Vite already loads .env files into the
	// spawned Deno process. For `zzz daemon start`, this is the only loader.
	const dotenv = await load_env_file(daemon_runtime, ENV_FILE);
	if (dotenv) {
		for (const [key, value] of Object.entries(dotenv)) {
			if (Deno.env.get(key) === undefined) {
				Deno.env.set(key, value);
			}
		}
	}

	// Set runtime defaults for env vars that need dynamic values.
	if (Deno.env.get('PUBLIC_ZZZ_DIR') === undefined) {
		Deno.env.set('PUBLIC_ZZZ_DIR', `${Deno.env.get('HOME') ?? '.'}/.zzz`);
	}

	const config = load_server_env((key) => Deno.env.get(key), {
		app_version: VERSION,
	});

	// Validate binding address — refuse to expose to network without authentication
	// TODO allow 0.0.0.0 binding once daemon token auth is wired
	if (is_open_host(config.host)) {
		console.error(
			`[server] FATAL: binding to '${config.host}' exposes zzz to your entire network.\n` +
				`  Use --host localhost (default) or --host 127.0.0.1 instead.\n` +
				`  Network binding will be supported once daemon token auth is wired.`,
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

	const {app, backend, app_backend, close, allowed_origins} = await create_zzz_app({
		config,
		password: argon2_password_deps,
		runtime: daemon_runtime,
		get_connection_ip: (c) => {
			// Deno provides connection info via c.env.remoteAddr
			const addr = c.env?.remoteAddr;
			return addr?.hostname;
		},
	});

	// Register WebSocket endpoint on the assembled app.
	// WS dispatches directly to unified handlers (zzz_action_handlers),
	// bypassing ActionPeer for request handling. ActionPeer is still used
	// for backend-initiated notifications (streaming, file changes).
	// The WS path is under /api/* so fuz_app's session + request_context
	// middleware runs automatically. We add origin verification and require_auth
	// to reject unauthenticated upgrades.
	if (config.websocket_path) {
		// Origin check for WebSocket connections (browsers always send Origin on WS upgrades)
		app.use(config.websocket_path, verify_request_source(allowed_origins));

		// Reject unauthenticated WebSocket upgrades — session middleware has
		// already resolved the cookie by this point (path is under /api/*).
		app.use(config.websocket_path, require_auth);

		const transport = new BackendWebsocketTransport();

		register_websocket_actions({
			path: config.websocket_path,
			app,
			backend,
			upgradeWebSocket,
			artificial_delay: config.artificial_delay,
			transport,
		});

		// Close WebSockets when sessions/tokens are revoked via audit events.
		// `create_ws_auth_guard` dispatches session_revoke → close_sockets_for_session,
		// token_revoke → close_sockets_for_token, and session_revoke_all /
		// token_revoke_all / password_change → close_sockets_for_account.
		//
		// fuz_app emits `logout` (not `session_revoke`) when a user logs out, and
		// the guard intentionally ignores it. Compose a logout handler here so
		// the logged-out account's WS connections are torn down along with the
		// session row. The session_id isn't in the logout event metadata, so we
		// fall back to account-scoped close — aligned with the pre-guard behavior.
		const original_on_audit_event = app_backend.deps.on_audit_event;
		const ws_guard = create_ws_auth_guard(transport, log);
		app_backend.deps.on_audit_event = (event) => {
			original_on_audit_event(event);
			ws_guard(event);
			if (event.event_type === 'logout' && event.outcome !== 'failure' && event.account_id) {
				const count = transport.close_sockets_for_account(event.account_id);
				if (count) log.info(`Closed ${count} socket(s) for ${event.event_type}`);
			}
		};
	}

	// Write daemon info for CLI discovery
	await write_daemon_info(daemon_runtime, 'zzz', {
		version: 1,
		pid: Deno.pid,
		port: config.port,
		started: new Date().toISOString(),
		app_version: config.app_version,
	});

	console.log(`[server] Listening on http://${config.host}:${config.port} (Deno)`);
	const server = Deno.serve({port: config.port, hostname: config.host}, app.fetch);

	// Cleanup on shutdown
	let shutting_down = false;
	const shutdown = async (): Promise<void> => {
		if (shutting_down) {
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
		await close();
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
