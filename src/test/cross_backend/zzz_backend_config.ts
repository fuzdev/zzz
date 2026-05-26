/**
 * Cross-process `BackendConfig` factories for zzz's cross-backend
 * integration suites.
 *
 * Five target backends spanning both the JS-runtime and TS-vs-Rust axes:
 *
 * - {@link deno_backend_config} — TS canonical backend on Deno V8 (spawns
 *   `testing_server_deno.ts`). Same wire shape as production zzz today.
 * - {@link node_backend_config} — TS canonical backend on Node V8 (spawns
 *   `testing_server_node.ts` via `gro run`). Isolates the JS-runtime axis
 *   (Deno vs Node V8) on identical TS canonical surfaces.
 * - {@link bun_backend_config} — TS canonical backend on Bun's JSC runtime
 *   (spawns `testing_server_bun.ts` via `bun run`). Third native path on the
 *   same TS surface; inherits fuz_app's bun exit-hang fix (the adapter
 *   fire-and-forgets bun's never-resolving `server.stop()` and the shared
 *   `spawn_backend` teardown SIGKILLs after a grace window).
 * - {@link rust_backend_config} — Axum/JSON-RPC backend (spawns
 *   `testing_zzz_server`). Isolates the cross-language axis (TS vs
 *   Rust) on the shared `/api/*` wire shape.
 * - {@link rust_proxy_backend_config} — Rust variant with
 *   `ZZZ_TRUSTED_PROXIES=127.0.0.1` for the proxy suite. Separate
 *   project because flipping that env mid-run isn't supported (Rust
 *   parses it once at boot).
 *
 * Each factory composes a small per-backend declaration against the
 * lifted upstream builders
 * (`make_default_ts_backend_config` / `make_default_rust_backend_config`
 * in `@fuzdev/fuz_app/testing/cross_backend/default_backend_configs.js`).
 * The upstream builders own the common shape — `/api/*` paths, cookie
 * name, bootstrap block keyed off `default_test_*` secrets, the
 * `FUZ_TESTING_RESET_DB_ON_STARTUP` gate. Per-backend factories only
 * declare what genuinely differs: zzz-specific env vars (`PUBLIC_ZZZ_*`,
 * `ZZZ_PORT`), the Rust binary's preferred `RUST_LOG` filter, and
 * (proxy variant) `ZZZ_TRUSTED_PROXIES`.
 *
 * **Port assignments** — fixed-but-distinct, no collision with the
 * production daemon (zzz Deno on `4040`, zzz Rust on `1174`):
 *
 * - Deno test binary → `11741`
 * - Node test binary → `11742`
 * - Bun test binary → `11743`
 * - Rust test binary → `1175` (matches `testing_zzz_server`'s
 *   `TESTING_DEFAULT_PORT`)
 * - Rust+proxy test binary → `1176`
 *
 * Vitest projects spawn one backend each, so ports only need to not
 * collide cross-project, not cross-test.
 *
 * **Per-project Postgres DBs** — each Rust project points at its own
 * database (`zzz_test_rust` for `cross_backend_rust`, `zzz_test_rust_proxy`
 * for `cross_backend_rust_proxy`). Decouples the two projects so vitest
 * can run them in parallel without trashing the other's `bootstrap_lock`
 * state, and removes the shared-DB race condition that forced a manual
 * `DROP TABLE` between project switches.
 *
 * **Startup-reset env gate** — `make_default_rust_backend_config` sets
 * `FUZ_TESTING_RESET_DB_ON_STARTUP=true` by default, which makes
 * `testing_zzz_server` wipe the auth-namespace schema (11 tables)
 * before migrations replay on every boot. No more manual `psql DROP
 * TABLE...` between vitest sessions — the binary self-cleans. The
 * `_testing_reset` RPC action (per-test reset) is orthogonal and stays
 * wired the same way it was; this is the per-process-startup wipe.
 *
 * **Operator setup** — the per-project DBs must exist before the test
 * harness runs. One-time bootstrap (idempotent):
 *
 * ```bash
 * createdb zzz_test_rust 2>/dev/null || true
 * createdb zzz_test_rust_proxy 2>/dev/null || true
 * ```
 *
 * Equivalent provisioning via your PG cluster is fine — the harness
 * does not call `CREATE DATABASE` (deliberately, to avoid forcing a
 * `CREATEDB` privilege on the test role).
 *
 * @module
 */

import {join} from 'node:path';
import type {BackendConfig} from '@fuzdev/fuz_app/testing/cross_backend/backend_config.js';
import {
	build_test_backend_paths,
	type TestBackendPaths,
} from '@fuzdev/fuz_app/testing/cross_backend/build_test_backend_paths.js';
import {
	make_default_rust_backend_config,
	make_default_ts_backend_config,
} from '@fuzdev/fuz_app/testing/cross_backend/default_backend_configs.js';

/**
 * Per-project Rust backend database URL prefix — real Postgres (PGlite
 * isn't reachable from `tokio-postgres`). The full URL is built by
 * appending the backend `name` so each Rust project gets its own
 * database (`zzz_test_rust`, `zzz_test_rust_proxy`). See the module
 * doc for the operator setup step.
 */
const RUST_DATABASE_URL_PREFIX = 'postgres://localhost/zzz_test_';

interface ZzzBackendPaths extends TestBackendPaths {
	zzz_dir: string;
	scoped_dir: string;
}

/**
 * Per-backend filesystem layout — generic paths via
 * {@link build_test_backend_paths}, plus zzz-specific `zzz_dir` /
 * `scoped_dir` for `PUBLIC_ZZZ_DIR` / `PUBLIC_ZZZ_SCOPED_DIRS`. The
 * Rust daemon-token writer expects `{zzz_dir}/run/daemon_token`, so
 * `zzz_dir` is anchored to `paths.root` (the generic builder's tmpdir
 * subtree) — keeping the daemon-token convention consistent across
 * runtimes.
 */
const build_zzz_paths = (backend_name: string): ZzzBackendPaths => {
	const paths = build_test_backend_paths(`zzz_cross_${backend_name}`);
	const zzz_dir = join(paths.root, 'zzz');
	return {
		...paths,
		// Override the daemon-token path to live under `{zzz_dir}/run/`,
		// matching `init_daemon_token` (Rust) and the TS server's writer.
		daemon_token_path: join(zzz_dir, 'run', 'daemon_token'),
		zzz_dir,
		scoped_dir: join(paths.root, 'scoped'),
	};
};

/**
 * TS canonical backend on Deno V8. The `--allow-*` flag set mirrors
 * the `test:server:deno` package script (kept in sync — the script is
 * the source of truth for the permission set).
 */
export const deno_backend_config = (): BackendConfig => {
	const name = 'deno';
	const paths = build_zzz_paths(name);
	return make_default_ts_backend_config({
		name,
		port: 11741,
		start_command: [
			'deno',
			'run',
			'--allow-net',
			'--allow-read',
			'--allow-env',
			'--allow-write',
			'--allow-sys',
			'--allow-ffi',
			'--allow-run',
			'--unstable-detect-cjs',
			'src/lib/server/testing_server_deno.ts',
		],
		paths,
		extra_env: {
			PUBLIC_ZZZ_DIR: paths.zzz_dir,
			PUBLIC_ZZZ_SCOPED_DIRS: paths.scoped_dir,
		},
	});
};

/**
 * TS canonical backend on Node V8. Spawns `testing_server_node.ts`
 * via `gro run` (matches the `test:server:node` package script). Same
 * source modules as the Deno entry — the runtime adapter is the
 * only divergence.
 */
export const node_backend_config = (): BackendConfig => {
	const name = 'node';
	const paths = build_zzz_paths(name);
	return make_default_ts_backend_config({
		name,
		port: 11742,
		start_command: ['npx', 'gro', 'run', 'src/lib/server/testing_server_node.ts'],
		paths,
		extra_env: {
			PUBLIC_ZZZ_DIR: paths.zzz_dir,
			PUBLIC_ZZZ_SCOPED_DIRS: paths.scoped_dir,
		},
	});
};

/**
 * TS canonical backend on Bun's JSC runtime. Spawns `testing_server_bun.ts`
 * via `bun run` — Bun resolves `.ts` + npm packages natively, and the
 * entry's import graph is `$lib`-free (same modules the Deno entry runs
 * directly, with no `$lib` map). Same source modules as the Node + Deno
 * entries — the runtime adapter is the only divergence. Requires `bun` on
 * PATH.
 */
export const bun_backend_config = (): BackendConfig => {
	const name = 'bun';
	const paths = build_zzz_paths(name);
	return make_default_ts_backend_config({
		name,
		port: 11743,
		start_command: ['bun', 'run', 'src/lib/server/testing_server_bun.ts'],
		paths,
		extra_env: {
			PUBLIC_ZZZ_DIR: paths.zzz_dir,
			PUBLIC_ZZZ_SCOPED_DIRS: paths.scoped_dir,
		},
	});
};

interface MakeZzzRustBackendOptions {
	name: string;
	port: number;
	extra_env?: Record<string, string>;
}

/**
 * Rust-family wrapper that threads the zzz-specific env vars + port
 * variable name through the upstream builder. `cargo run --release`
 * keeps the source-of-truth invocation in cargo's hands so a stale
 * `target/release/testing_zzz_server` from a prior checkout never
 * serves silently. Consumers iterating locally can swap to
 * `['target/release/testing_zzz_server']` for faster spawns once
 * they've built the binary at least once.
 */
const make_zzz_rust_backend_config = ({
	name,
	port,
	extra_env,
}: MakeZzzRustBackendOptions): BackendConfig => {
	const paths = build_zzz_paths(name);
	return make_default_rust_backend_config({
		name,
		port,
		start_command: ['cargo', 'run', '--release', '--bin', 'testing_zzz_server'],
		database_url: `${RUST_DATABASE_URL_PREFIX}${name}`,
		port_env_var: 'ZZZ_PORT',
		rust_log: 'info,zzz_server=info,testing_zzz_server=info',
		paths,
		extra_env: {
			PUBLIC_ZZZ_DIR: paths.zzz_dir,
			PUBLIC_ZZZ_SCOPED_DIRS: paths.scoped_dir,
			...extra_env,
		},
	});
};

/**
 * Rust backend. Requires PostgreSQL — `DATABASE_URL` resolves to
 * `zzz_test_rust` (one of the per-project DBs the operator creates
 * once; see the module doc). The test binary self-wipes the
 * auth-namespace schema on every startup, so no manual `DROP TABLE`
 * between vitest sessions is needed.
 */
export const rust_backend_config = (): BackendConfig =>
	make_zzz_rust_backend_config({
		name: 'rust',
		port: 1175,
	});

/**
 * Rust backend variant with trusted-proxy enabled. Used by the proxy
 * cross-backend suite, which can't share a backend instance with the
 * regular Rust project — flipping `ZZZ_TRUSTED_PROXIES` mid-run isn't
 * supported (Rust parses it once at boot). Port `1176` so the proxy
 * binary doesn't collide with the regular Rust project on `1175`.
 *
 * Points at its own `zzz_test_rust_proxy` database so the two Rust
 * projects don't fight over `bootstrap_lock` state and can run in
 * parallel.
 */
export const rust_proxy_backend_config = (): BackendConfig =>
	make_zzz_rust_backend_config({
		name: 'rust_proxy',
		port: 1176,
		extra_env: {ZZZ_TRUSTED_PROXIES: '127.0.0.1'},
	});
