/**
 * Runtime-agnostic test-binary core for the TS canonical zzz server.
 *
 * Shared by the Deno (`testing_server_deno.ts`) and Node
 * (`testing_server_node.ts`) test-binary adapters: same `create_zzz_app`
 * factory, same `_testing_reset` registration, same `reset_state`
 * closure, same daemon-info + shutdown discipline. The two runtime
 * adapters only supply the boundary primitives that diverge between
 * Deno and Node (HTTP serve, WS upgrade construction, signal
 * registration, pid, exit).
 *
 * Production stays on Deno (`server.ts`). Both test entries register
 * `_testing_reset` from fuz_app's `create_testing_reset_actions` factory
 * with a zzz `reset_state` closure that closes all workspaces, kills
 * terminals via `PtyManager.kill_all`, and wipes the optional
 * `ZZZ_TESTING_SCRATCH_DIR` tree.
 *
 * **NEVER ship in a release.** The module reaches into fuz_app's
 * `testing/cross_backend/` modules which throw at production-bundle
 * load via `assert_dev_env`. The `testing_` filename prefix mirrors the
 * Rust `testing_zzz_server` convention and is enforced for the Rust
 * side by `cargo xtask check-release`'s dep-graph audit.
 *
 * @module
 */

import type {Context, Hono} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {existsSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {
	write_daemon_info,
	read_daemon_info,
	is_daemon_running,
} from '@fuzdev/fuz_app/cli/daemon.js';
import {load_env_file} from '@fuzdev/fuz_app/env/dotenv.js';
import {stub_password_deps} from '@fuzdev/fuz_app/testing/app_server.js';
import {create_testing_reset_actions} from '@fuzdev/fuz_app/testing/cross_backend/testing_reset_actions.js';
import {BackendWebsocketTransport} from '@fuzdev/fuz_app/actions/transports_ws_backend.js';
import {
	create_ws_auth_guard,
	create_ws_logout_closer,
} from '@fuzdev/fuz_app/actions/transports_ws_auth_guard.js';
import type {RuntimeDeps} from '@fuzdev/fuz_app/runtime/deps.js';

import {VERSION} from '../zzz/build_info.ts';
import {create_zzz_app} from './create_zzz_app.ts';
import {load_server_env} from './server_env.ts';
import {is_open_host} from './security.ts';
import {register_websocket_actions} from './register_websocket_actions.ts';
import {ENV_FILE} from './constants.ts';

const log = new Logger('[testing_server]');

/**
 * Adapter-built handle to a bound HTTP server.
 *
 * `shutdown` stops accepting new connections and waits for in-flight
 * ones to drain. `native` is an adapter-specific server reference —
 * used by Node's `@hono/node-ws` `injectWebSocket(server)` post-serve
 * hook; Deno leaves it unset (Deno.serve doesn't need post-serve WS
 * wiring).
 */
export interface ServeHandle {
	shutdown: () => Promise<void>;
	/** Adapter-specific server ref for post-serve hooks. Type-erased at the seam. */
	native?: unknown;
}

/**
 * Result of an adapter's WS preparation step.
 *
 * `upgrade_websocket` is the Hono `UpgradeWebSocket` closure the
 * dispatcher uses to register the WS endpoint. `attach_to_server` is
 * called after `serve()` returns a `ServeHandle` — Node uses it for
 * `injectWebSocket(server)`; Deno leaves it undefined.
 */
export interface PreparedWebsocket {
	upgrade_websocket: UpgradeWebSocket;
	attach_to_server?: (handle: ServeHandle) => void;
}

/**
 * Runtime adapter contract for the test-binary entry.
 *
 * Each adapter (`testing_server_deno.ts`, `testing_server_node.ts`)
 * implements this and hands the shape to {@link start_testing_server}.
 * The core owns env load, bind validation, `create_zzz_app`
 * construction, WS endpoint wiring, daemon-info write, and shutdown
 * coordination; the adapter owns the runtime-boundary primitives.
 */
export interface TestingServerAdapter {
	/** Human-readable runtime label for log output (e.g. `"Deno"`, `"Node"`). */
	runtime_label: string;
	/** RuntimeDeps capability bundle from `create_deno_runtime` / `create_node_runtime`. */
	runtime: RuntimeDeps;
	/** Extract the raw TCP connection IP from a Hono context. */
	get_connection_ip: (c: Context) => string | undefined;
	/** Build the WS upgrade closure after `create_zzz_app` returns the app. */
	prepare_websocket: (app: Hono) => PreparedWebsocket;
	/** Bind `app.fetch` to `port` on `hostname`; return a {@link ServeHandle}. */
	serve: (options: {fetch: Hono['fetch']; port: number; hostname: string}) => ServeHandle;
	/** Current process pid (for `daemon.json`). */
	pid: number;
	/** Register SIGINT/SIGTERM listeners that invoke `handler` once each. */
	register_shutdown_signals: (handler: () => Promise<void>) => void;
	/** Forceful exit on graceful-shutdown completion or fatal error. */
	exit: (code: number) => never;
}

/**
 * Read an env var via either the adapter's runtime or `process.env`.
 *
 * `load_env_file` writes through `runtime.env_set`, so consulting
 * `runtime.env_get` first picks up dotenv values on Node (where the
 * `node:process` global isn't the only env source). Falls back to
 * `process.env` for Node-style consumers (e.g. `ZZZ_TESTING_SCRATCH_DIR`
 * isn't a fuz_app-managed var so it doesn't always round-trip through
 * the runtime).
 */
const get_env = (runtime: RuntimeDeps, key: string): string | undefined => runtime.env_get(key);

/**
 * Boot the test-mode zzz server using the supplied runtime adapter.
 *
 * Mirrors `server.ts`'s `start_server` (Deno production) at the
 * surface level — same env loading, bind validation, daemon-info
 * lifecycle, and shutdown drain — but forces `enable_test_actions:
 * true`, swaps `stub_password_deps` in place of argon2, and registers
 * the `_testing_reset` RPC action with a zzz domain `reset_state`
 * closure.
 */
export const start_testing_server = async (adapter: TestingServerAdapter): Promise<void> => {
	const {runtime, runtime_label, get_connection_ip} = adapter;

	// Load env file if present — values don't override existing env vars.
	const dotenv = await load_env_file(runtime, ENV_FILE);
	if (dotenv) {
		for (const [key, value] of Object.entries(dotenv)) {
			if (get_env(runtime, key) === undefined) {
				runtime.env_set(key, value);
			}
		}
	}

	// Default PUBLIC_ZZZ_DIR to `${HOME}/.zzz` so the daemon-token writer
	// has a stable target the cross-process harness can read. Tests that
	// need per-process isolation override this to a temp dir.
	if (get_env(runtime, 'PUBLIC_ZZZ_DIR') === undefined) {
		runtime.env_set('PUBLIC_ZZZ_DIR', `${get_env(runtime, 'HOME') ?? '.'}/.zzz`);
	}

	// Force unconditional test-action registration — the binary's whole
	// purpose is test-only (Open Q5 resolution in
	// grimoire/lore/fuz_app/TODO_CROSS_PROCESS_LIFT.md).
	const config = load_server_env((key) => get_env(runtime, key), {
		app_version: VERSION,
		enable_test_actions: true,
	});

	if (is_open_host(config.host)) {
		console.error(
			`[testing_server] FATAL: binding to '${config.host}' exposes the test binary to your entire network.\n` +
				`  Use --host localhost (default) or --host 127.0.0.1 instead.`,
		);
		adapter.exit(1);
	}

	const stale = await read_daemon_info(runtime, 'zzz');
	if (stale) {
		if (await is_daemon_running(runtime, stale.pid)) {
			console.warn('[testing_server] found running server', stale);
		} else {
			console.warn(`[testing_server] stale daemon.json (pid ${stale.pid} not running), replacing`);
		}
	}

	const scratch_dir = get_env(runtime, 'ZZZ_TESTING_SCRATCH_DIR');

	const {app, backend, app_backend, close, allowed_origins, extra_ws_actions} =
		await create_zzz_app({
			config,
			password: stub_password_deps,
			runtime,
			get_connection_ip,
			extra_rpc_actions_factory: (deps, zzz_backend) =>
				create_testing_reset_actions(deps, {
					reset_state: async () => {
						// Close every open workspace via the production RPC path so
						// persistence + post-commit fan-out (workspace_changed
						// broadcast, scoped FS teardown) all run.
						const workspace_paths = [...zzz_backend.workspaces.keys()];
						for (const path of workspace_paths) {
							await zzz_backend.workspace_close(path);
						}
						// Kill every active terminal without destroying the
						// manager (next test re-uses it for fresh spawns).
						await zzz_backend.pty_manager.kill_all();
						// Optional scoped-FS scratch root: tests that allocate
						// per-case scratch dirs under ZZZ_TESTING_SCRATCH_DIR
						// get a clean slate. Unset → no-op.
						if (scratch_dir && existsSync(scratch_dir)) {
							await rm(scratch_dir, {recursive: true, force: true});
						}
					},
				}),
		});

	const ws = adapter.prepare_websocket(app);

	if (config.websocket_path) {
		const transport = new BackendWebsocketTransport();

		register_websocket_actions({
			path: config.websocket_path,
			app,
			backend,
			db: app_backend.deps.db,
			upgradeWebSocket: ws.upgrade_websocket,
			allowed_origins,
			artificial_delay: config.artificial_delay,
			transport,
			extra_actions: extra_ws_actions,
		});

		// Same audit-event-driven socket revocation chain the Deno
		// production entry installs (logout / session_revoke /
		// token_revoke / password_change).
		app_backend.deps.audit.on_event_chain.push(
			create_ws_auth_guard(transport, log),
			create_ws_logout_closer(transport, log),
		);
	}

	await write_daemon_info(runtime, 'zzz', {
		version: 1,
		pid: adapter.pid,
		port: config.port,
		started: new Date().toISOString(),
		app_version: config.app_version,
	});

	console.log(
		`[testing_server] Listening on http://${config.host}:${config.port} (${runtime_label}, test mode)`,
	);
	const server = adapter.serve({
		fetch: app.fetch,
		port: config.port,
		hostname: config.host,
	});

	ws.attach_to_server?.(server);

	let shutting_down = false;
	const shutdown = async (): Promise<void> => {
		if (shutting_down) {
			adapter.exit(1);
		}
		shutting_down = true;
		console.log('[testing_server] shutting down...');
		try {
			await backend.destroy();
			await close();
			await server.shutdown();
		} catch (error) {
			console.error('[testing_server] shutdown error:', error);
		}
		adapter.exit(0);
	};

	adapter.register_shutdown_signals(shutdown);
};
