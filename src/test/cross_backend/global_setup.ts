/**
 * Vitest `globalSetup` for zzz cross-backend integration suites.
 *
 * Reads the `ZZZ_CROSS_BACKEND_NAME` env var to pick which backend
 * config to spawn ({@link deno_backend_config} / {@link node_backend_config} /
 * {@link rust_backend_config}), invokes `bootstrap_backend(config)` to
 * spawn the binary + bootstrap the keeper, and `provide('backend_handle',
 * bootstrapped)` so `*.cross.test.ts` files can `inject('backend_handle')`.
 *
 * Each vitest project sets its own discriminator value
 * (`ZZZ_CROSS_BACKEND_NAME=deno|node|rust`); the project's globalSetup
 * entry points at this same module so the spawn/handoff is uniform across
 * all three cross-backend projects. Falls back to `'deno'` when unset so
 * the file is runnable standalone (matches the canonical reference
 * implementation).
 *
 * The teardown closure SIGTERMs the spawned child's process group +
 * awaits exit, leaving no stranded ports.
 *
 * @module
 */

import {bootstrap_backend} from '@fuzdev/fuz_app/testing/cross_backend/bootstrap_backend.js';
import type {BootstrappedBackendHandle} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import type {BackendConfig} from '@fuzdev/fuz_app/testing/cross_backend/backend_config.js';

// Vitest 4 dropped the named `GlobalSetupContext` export; the globalSetup
// callback receives a `TestProject`-shaped argument whose only field we
// touch is `provide`. Structural typing here avoids the missing-export
// noise while preserving the type-safe `provide('backend_handle', ...)`
// path via the module augmentation below.
interface VitestGlobalSetupContext {
	readonly provide: <K extends keyof import('vitest').ProvidedContext & string>(
		key: K,
		value: import('vitest').ProvidedContext[K],
	) => void;
}

import {
	deno_backend_config,
	node_backend_config,
	rust_backend_config,
	rust_proxy_backend_config,
} from './zzz_backend_config.js';

/**
 * Vitest `provide`/`inject` channel — augments the typed `ProvidedContext`
 * so `inject('backend_handle')` returns a `BootstrappedBackendHandle`
 * without a per-site cast.
 *
 * Mirrored in `auth.cross.test.ts` so both the producer (this module)
 * and the consumer (the test file) agree on the type. Vitest's module
 * augmentation merges across both declarations.
 */
declare module 'vitest' {
	export interface ProvidedContext {
		backend_handle: BootstrappedBackendHandle;
	}
}

/**
 * Env var consulted to pick the backend config. Each vitest project
 * setting that wires this globalSetup is responsible for exporting its
 * own value (`deno`, `node`, or `rust`) before vitest starts the
 * worker.
 */
const BACKEND_NAME_ENV = 'ZZZ_CROSS_BACKEND_NAME';

/**
 * Default backend when the env var is unset. The Deno binary is the TS
 * canonical reference — same wire shape as production zzz, fastest
 * spawn, no PostgreSQL prerequisite.
 */
const DEFAULT_BACKEND_NAME = 'deno';

/**
 * Resolve the configured backend name to its `BackendConfig` factory
 * output. Unknown values throw with the full list of supported names so
 * a typo in a vitest project's env block surfaces clearly.
 */
const pick_backend_config = (name: string): BackendConfig => {
	switch (name) {
		case 'deno':
			return deno_backend_config();
		case 'node':
			return node_backend_config();
		case 'rust':
			return rust_backend_config();
		case 'rust_proxy':
			return rust_proxy_backend_config();
		default:
			throw new Error(
				`${BACKEND_NAME_ENV}='${name}' is not a recognized cross-backend name — ` +
					`expected one of: deno, node, rust, rust_proxy`,
			);
	}
};

/**
 * Vitest globalSetup entry point. Spawns the chosen backend, bootstraps
 * the keeper, hands the handle to `inject('backend_handle')` consumers,
 * returns the teardown closure for vitest to fire after the suite.
 */
const setup = async ({provide}: VitestGlobalSetupContext): Promise<() => Promise<void>> => {
	const name = process.env[BACKEND_NAME_ENV] ?? DEFAULT_BACKEND_NAME;
	const config = pick_backend_config(name);
	const bootstrapped = await bootstrap_backend(config);
	provide('backend_handle', bootstrapped);
	return async () => {
		await bootstrapped.teardown();
	};
};

export default setup;
