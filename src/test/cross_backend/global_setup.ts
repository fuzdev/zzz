/**
 * Vitest `globalSetup` for zzz cross-backend integration suites.
 *
 * fuz_app's `create_cross_backend_global_setup` derives the backend name from
 * the vitest project name (`cross_backend_rust` → `rust`,
 * `cross_backend_rust_proxy` → `rust_proxy`, `cross_backend_rust_projects`
 * → `rust_projects`), builds the test binary first
 * with its output shown (its `cargo_binaries` entry), opens a database of the
 * backend's own (a `pglet_server` built in zzz's Cargo workspace, or a
 * PostgreSQL database under `FUZ_TEST_POSTGRES_URL`), spawns + bootstraps
 * the backend over it, and
 * `provide`s the serializable handle the `*.cross.test.ts` files read with
 * `inject_backend_handle`. The teardown SIGTERMs the child's process group,
 * then closes the database.
 *
 * @module
 */

import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';

import {
	ZZZ_CARGO_BINARY,
	rust_backend_config,
	rust_projects_backend_config,
	rust_proxy_backend_config
} from './zzz_backend_config.ts';

export default create_cross_backend_global_setup({
	configs: {
		rust: rust_backend_config,
		rust_proxy: rust_proxy_backend_config,
		rust_projects: rust_projects_backend_config
	},
	cargo_binaries: {
		rust: ZZZ_CARGO_BINARY,
		rust_proxy: ZZZ_CARGO_BINARY,
		rust_projects: ZZZ_CARGO_BINARY
	}
});
