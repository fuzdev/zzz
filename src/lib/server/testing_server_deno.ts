/**
 * Deno test-binary adapter for the TS canonical zzz server.
 *
 * Thin adapter over `testing_server_core.ts`: binds `Deno.serve` and
 * `hono/deno`'s module-level `upgradeWebSocket` for the WS upgrade
 * path. The shared core owns env loading, `_testing_reset`
 * registration, daemon-info lifecycle, and shutdown coordination.
 *
 * Counterpart to `testing_server_node.ts` — both spawn the same
 * `create_zzz_app` factory and register `_testing_reset` against it.
 * The split exists so cross-process integration suites can compare
 * runtime-level behavior on identical TS canonical surfaces:
 *
 * - Deno vs Node JS-runtime perf (V8 in both, but distinct I/O loops,
 *   fetch impls, HTTP servers).
 * - Wire-shape parity between the two TS runtimes (a divergence here
 *   would mean fuz_app's runtime-agnosticism slipped).
 *
 * The Rust `testing_zzz_server` covers the cross-language axis (TS
 * vs Rust); these two cover the cross-runtime axis on the same TS
 * surface.
 *
 * **NEVER ship this in a release.** See `testing_server_core.ts` for
 * the production-safety contract.
 *
 * Run with:
 *   deno run --allow-net --allow-read --allow-env --allow-write --allow-sys src/lib/server/testing_server_deno.ts
 *
 * Or via the npm script (recommended — bundles the permissions flags):
 *   npm run test:server:deno
 *
 * Env vars: see `testing_server_core.ts`.
 *
 * @module
 */

import {upgradeWebSocket} from 'hono/deno';
import {create_deno_runtime} from '@fuzdev/fuz_app/runtime/deno.js';

import {start_testing_server} from './testing_server_core.ts';

const start = (): Promise<void> =>
	start_testing_server({
		runtime_label: 'Deno',
		runtime: create_deno_runtime([]),
		get_connection_ip: (c) => {
			// Deno surfaces the raw connection via the Hono context's `env`
			// — `remoteAddr.hostname` is the TCP peer IP. Mirror
			// `server.ts`'s production wiring.
			const addr = c.env?.remoteAddr;
			return addr?.hostname;
		},
		// Deno's WS upgrade is module-level and stateless; no
		// post-serve attach step (compare Node's `injectWebSocket`).
		prepare_websocket: () => ({upgrade_websocket: upgradeWebSocket}),
		serve: ({fetch, port, hostname}) => {
			const server = Deno.serve({port, hostname}, fetch);
			return {
				shutdown: () => server.shutdown(),
				native: server,
			};
		},
		pid: Deno.pid,
		register_shutdown_signals: (handler) => {
			Deno.addSignalListener('SIGINT', () => void handler());
			Deno.addSignalListener('SIGTERM', () => void handler());
		},
		exit: (code) => Deno.exit(code),
	});

if (import.meta.url === Deno.mainModule) {
	start().catch((error) => {
		console.error('[testing_server] Failed to start:', error);
		Deno.exit(1);
	});
}
