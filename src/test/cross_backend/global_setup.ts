/**
 * Vitest `globalSetup` for zzz cross-backend integration suites.
 *
 * Reads the project's `name` to pick which backend config to spawn
 * ({@link deno_backend_config} / {@link node_backend_config} /
 * {@link bun_backend_config} / {@link rust_backend_config} /
 * {@link rust_proxy_backend_config}),
 * invokes `bootstrap_backend(config)` to spawn the binary + bootstrap
 * the keeper, and `provide('backend_handle', bootstrapped)` so
 * `*.cross.test.ts` files can `inject('backend_handle')`.
 *
 * Each vitest project sets its own discriminator via `test.name`
 * (`cross_backend_ts_deno`, `cross_backend_ts_node`,
 * `cross_backend_ts_bun`, `cross_backend_rust`,
 * `cross_backend_rust_proxy`). vitest 4 passes
 * the `TestProject` instance to globalSetup as the first argument so
 * the project name is the source of truth — no `process.env`-based
 * hand-off is required (an earlier draft used `test.env` for this,
 * which silently doesn't work: vitest applies `test.env` to spawned
 * workers, not to the parent process where globalSetup runs).
 *
 * The teardown closure SIGTERMs the spawned child's process group +
 * awaits exit, leaving no stranded ports.
 *
 * @module
 */

import type {TestProject} from 'vitest/node';

import {bootstrap_backend} from '@fuzdev/fuz_app/testing/cross_backend/bootstrap_backend.js';
import type {BackendConfig} from '@fuzdev/fuz_app/testing/cross_backend/backend_config.js';
import {serialize_bootstrapped_handle} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';

import './cross_test_types.js';
import {
	bun_backend_config,
	deno_backend_config,
	node_backend_config,
	rust_backend_config,
	rust_proxy_backend_config,
} from './zzz_backend_config.js';

/**
 * Strips the `cross_backend_` prefix (plus an optional `ts_`
 * discriminator the TS canonical backends carry) to derive the backend
 * name from the project name. Project names that don't reduce to a
 * known backend fall through to {@link pick_backend_config}'s
 * `default: throw` so typos surface clearly.
 */
const PROJECT_NAME_PREFIX = /^cross_backend_(?:ts_)?/;

/**
 * Resolve a derived backend name to its `BackendConfig` factory
 * output. Unknown values throw with the full list of supported names
 * so a misnamed project surfaces clearly.
 */
const pick_backend_config = (name: string): BackendConfig => {
	switch (name) {
		case 'deno':
			return deno_backend_config();
		case 'node':
			return node_backend_config();
		case 'bun':
			return bun_backend_config();
		case 'rust':
			return rust_backend_config();
		case 'rust_proxy':
			return rust_proxy_backend_config();
		default:
			throw new Error(
				`Could not derive backend name from vitest project '${name}' — ` +
					`expected one of: deno, node, bun, rust, rust_proxy`,
			);
	}
};

/**
 * Vitest globalSetup entry point. vitest 4 passes the `TestProject`
 * as the first arg; the project's `name` picks which backend to
 * spawn. Spawns the chosen backend, bootstraps the keeper, hands the
 * handle to `inject('backend_handle')` consumers, returns the
 * teardown closure for vitest to fire after the suite.
 */
const setup = async (project: TestProject): Promise<() => Promise<void>> => {
	const name = project.name.replace(PROJECT_NAME_PREFIX, '');
	const config = pick_backend_config(name);
	const bootstrapped = await bootstrap_backend(config);
	// vitest 4's `provide` hard-rejects non-serializable values, so strip
	// the live `child` / `teardown` / `keeper_transport` and let test
	// files rebuild a usable handle via `reconstruct_bootstrapped_handle`.
	project.provide('backend_handle', serialize_bootstrapped_handle(bootstrapped));
	return async () => {
		await bootstrapped.teardown();
	};
};

export default setup;
