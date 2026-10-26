/**
 * Vitest `globalSetup` for zzz cross-backend integration suites.
 *
 * fuz_app's `create_cross_backend_global_setup` derives the backend name from
 * the vitest project name (`cross_backend_rust` → `rust`,
 * `cross_backend_rust_proxy` → `rust_proxy`), builds the test binary first
 * with its output shown (`prepare_cargo_binary`), creates the backend's
 * Postgres database when it's missing, spawns + bootstraps the backend, and
 * `provide`s the serializable handle the `*.cross.test.ts` files read with
 * `inject_backend_handle`. The teardown SIGTERMs the child's process group.
 *
 * @module
 */

import { prepare_cargo_binary } from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import { create_cross_backend_global_setup } from '@fuzdev/fuz_app/testing/cross_backend/create_cross_backend_global_setup.ts';

import {
	ZZZ_CARGO_BINARY,
	rust_backend_config,
	rust_proxy_backend_config
} from './zzz_backend_config.ts';

const build = () => prepare_cargo_binary(ZZZ_CARGO_BINARY);

export default create_cross_backend_global_setup({
	configs: { rust: rust_backend_config, rust_proxy: rust_proxy_backend_config },
	// `createdb` for each project's own `zzz_test_<name>` database when it's missing
	ensure_databases: true,
	before_spawn: { rust: build, rust_proxy: build }
});
