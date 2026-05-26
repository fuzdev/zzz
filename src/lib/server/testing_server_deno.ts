/**
 * Deno spawn entry for the TS canonical zzz test server. Thin wiring of
 * fuz_app's Deno adapter + core onto zzz's `build_zzz_testing_app`.
 *
 * Run: `deno run -A --unstable-detect-cjs src/lib/server/testing_server_deno.ts`
 * (see the `test:server:deno` package script for the full flag set).
 * **NEVER ship in a release.** @module
 */

import {start_testing_server} from '@fuzdev/fuz_app/testing/cross_backend/testing_server_core.js';
import {create_deno_testing_adapter} from '@fuzdev/fuz_app/testing/cross_backend/testing_server_deno.js';

import {build_zzz_testing_app, resolve_zzz_testing_config} from './testing_server_build.ts';

const start = async (): Promise<void> => {
	const adapter = create_deno_testing_adapter();
	const resolved = await resolve_zzz_testing_config(adapter.runtime);
	await start_testing_server({
		adapter,
		daemon_name: 'zzz',
		host: resolved.config.host,
		port: resolved.config.port,
		app_version: resolved.config.app_version,
		build_app: () =>
			build_zzz_testing_app({
				config: resolved.config,
				runtime: adapter.runtime,
				get_connection_ip: adapter.get_connection_ip,
				daemon_token_path: resolved.daemon_token_path,
				scratch_dir: resolved.scratch_dir,
			}),
	});
};

if (import.meta.url === Deno.mainModule) {
	start().catch((error) => {
		console.error('[testing_server] Failed to start:', error);
		Deno.exit(1);
	});
}
