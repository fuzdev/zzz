/**
 * Node/bun-runnable test-binary adapter for the TS canonical zzz server.
 *
 * Thin adapter over `testing_server_core.ts`: binds `Deno.serve`'s
 * counterpart `@hono/node-server`'s `serve()` and `@hono/node-ws`'s
 * `createNodeWebSocket(app)` for the WS upgrade path. The shared core
 * owns env loading, `_testing_reset` registration, daemon-info
 * lifecycle, and shutdown coordination.
 *
 * **NEVER ship this in a release.** See `testing_server_core.ts` for
 * the production-safety contract.
 *
 * Run with:
 *   npx tsx src/lib/server/testing_server_node.ts
 *   bun src/lib/server/testing_server_node.ts
 *
 * Env vars: see `testing_server_core.ts`.
 *
 * @module
 */

import process from 'node:process';
import {serve, type ServerType} from '@hono/node-server';
import {getConnInfo} from '@hono/node-server/conninfo';
import {createNodeWebSocket} from '@hono/node-ws';
import {create_node_runtime} from '@fuzdev/fuz_app/runtime/node.js';

import {start_testing_server, type ServeHandle} from './testing_server_core.ts';

const node_serve_handle = (server: ServerType): ServeHandle => ({
	shutdown: () =>
		new Promise((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		}),
	native: server,
});

const start = (): Promise<void> =>
	start_testing_server({
		runtime_label: 'Node',
		runtime: create_node_runtime(),
		get_connection_ip: (c) => getConnInfo(c).remote.address,
		prepare_websocket: (app) => {
			const {upgradeWebSocket, injectWebSocket} = createNodeWebSocket({app});
			return {
				upgrade_websocket: upgradeWebSocket,
				attach_to_server: (handle) => {
					// `handle.native` is the `ServerType` from `serve()` below
					// — type-erased at the seam in {@link ServeHandle}, so a
					// downcast lands here. Belt-and-suspenders runtime check
					// only matters if the adapter is misused; release builds
					// strip the check.
					injectWebSocket(handle.native as ServerType);
				},
			};
		},
		serve: ({fetch, port, hostname}) => node_serve_handle(serve({fetch, port, hostname})),
		pid: process.pid,
		register_shutdown_signals: (handler) => {
			process.on('SIGINT', () => void handler());
			process.on('SIGTERM', () => void handler());
		},
		exit: (code) => process.exit(code),
	});

const is_main_module = import.meta.url === `file://${process.argv[1]}`;

if (is_main_module) {
	start().catch((error) => {
		console.error('[testing_server] Failed to start:', error);
		process.exit(1);
	});
}
