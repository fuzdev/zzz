/**
 * Vitest `globalSetup` for zzz cross-backend integration suites.
 *
 * fuz_app's `create_cross_backend_global_setup` derives the backend name from
 * the vitest project name (`cross_backend_rust` → `rust`,
 * `cross_backend_rust_proxy` → `rust_proxy`, `cross_backend_rust_projects`
 * → `rust_projects`), builds the test binary first
 * with its output shown (`prepare_cargo_binary`), opens a database of the
 * backend's own (a `pglet_server` built in zzz's Cargo workspace, or a
 * PostgreSQL database under `FUZ_TEST_POSTGRES_URL`), spawns + bootstraps
 * the backend over it, and
 * `provide`s the serializable handle the `*.cross.test.ts` files read with
 * `inject_backend_handle`. The teardown SIGTERMs the child's process group,
 * then closes the database.
 *
 * @module
 */

import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';

import {
	ZZZ_CARGO_BINARY,
	ZZZ_PGLET_SERVER,
	rust_backend_config,
	rust_projects_backend_config,
	rust_proxy_backend_config
} from './zzz_backend_config.ts';

const build = () => prepare_cargo_binary(ZZZ_CARGO_BINARY);

export default create_cross_backend_global_setup({
	configs: {
		rust: rust_backend_config,
		rust_proxy: rust_proxy_backend_config,
		rust_projects: rust_projects_backend_config
	},
	databases: {
		rust: ZZZ_PGLET_SERVER,
		rust_proxy: ZZZ_PGLET_SERVER,
		rust_projects: ZZZ_PGLET_SERVER
	},
	before_spawn: { rust: build, rust_proxy: build, rust_projects: build }
});
