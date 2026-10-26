/**
 * Cross-process `BackendConfig` factories for zzz's cross-backend
 * integration suites.
 *
 * Two Rust target backends:
 *
 * - {@link rust_backend_config} — Axum/JSON-RPC backend (spawns
 *   `testing_zzz_server`) on the `/api/*` wire shape, also serving a
 *   static fixture dir (`STATIC_FIXTURE_FILES`) as its frontend.
 * - {@link rust_proxy_backend_config} — Rust variant with
 *   `ZZZ_TRUSTED_PROXIES=127.0.0.1` for the proxy suite. Separate
 *   project because flipping that env mid-run isn't supported (Rust
 *   parses it once at boot).
 *
 * Each factory composes a small per-backend declaration against the
 * lifted upstream builder
 * (`make_default_rust_backend_config` in
 * `@fuzdev/fuz_app/testing/cross_backend/default_backend_configs.ts`).
 * The upstream builder owns the common shape — `/api/*` paths, the
 * bootstrap block keyed off `default_test_*` secrets, the
 * `FUZ_TESTING_RESET_DB_ON_STARTUP` gate. Per-backend factories only
 * declare what genuinely differs: zzz-specific env vars (`PUBLIC_ZZZ_*`,
 * `ZZZ_PORT`), the per-port session cookie name
 * (`zzz_session_cookie_name`), the Rust binary's preferred `RUST_LOG`
 * filter, and (proxy variant) `ZZZ_TRUSTED_PROXIES`.
 *
 * **Port assignments** — fixed-but-distinct, no collision with the
 * production daemon (zzz on `4460`, dev on `4461`):
 *
 * - Rust test binary → `4462` (matches `testing_zzz_server`'s
 *   `TESTING_DEFAULT_PORT`)
 * - Rust+proxy test binary → `4463`
 * - Rust dev-origins test binary → `4464`
 *   ({@link rust_dev_origins_backend_config}, spawned by its one suite
 *   inside the `cross_backend_rust` project)
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
 * **Databases** — the global setup creates each project's database when
 * it's missing (`ensure_databases`, an idempotent `createdb`; a role without
 * `CREATEDB` gets a warning, and a database provisioned another way works
 * the same).
 *
 * @module
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendConfig } from '@fuzdev/fuz_app/testing/cross_backend/backend_config.ts';
import type { BackendCapabilities } from '@fuzdev/fuz_app/testing/cross_backend/capabilities.ts';
import {
	resolve_cargo_binary_path,
	type CargoBinaryOptions
} from '@fuzdev/fuz_app/testing/cross_backend/cargo_binary.ts';
import {
	build_test_backend_paths,
	type TestBackendPaths
} from '@fuzdev/fuz_app/testing/cross_backend/build_test_backend_paths.ts';
import {
	make_default_rust_backend_config,
	rust_default_capabilities
} from '@fuzdev/fuz_app/testing/cross_backend/default_backend_configs.ts';

/**
 * The session cookie name `zzz_server` issues on `port` — twin of the Rust
 * `session_cookie_name_for_port` (`zzz_session_<port>`, so zzz daemons on
 * one host don't share a session cookie).
 */
export const zzz_session_cookie_name = (port: number): string => `zzz_session_${port}`;

/**
 * The `Origin` fuz_app's `rpc_call` test helper sends unless told otherwise —
 * fixed upstream, so the test backends allow it beside their own origins. It
 * isn't zzz's dev origin, which no test backend but
 * {@link rust_dev_origins_backend_config}'s allows.
 */
export const RPC_CALL_DEFAULT_ORIGIN = 'http://localhost:5173';

/** The dev env template `cargo xtask dev-setup` copies to `.env.development`. */
const DEV_ENV_TEMPLATE_PATH = '.env.development.example';

/**
 * The origin allowlist a dev checkout runs on: the `FUZ_ALLOWED_ORIGINS`
 * value of the dev env template, as written.
 */
export const read_dev_allowed_origins = (): string => {
	const lines = readFileSync(DEV_ENV_TEMPLATE_PATH, 'utf8').split('\n');
	const values = lines.flatMap((line) => /^FUZ_ALLOWED_ORIGINS=(.*)$/.exec(line)?.[1] ?? []);
	if (values.length !== 1 || !values[0]) {
		throw new Error(`${DEV_ENV_TEMPLATE_PATH} sets FUZ_ALLOWED_ORIGINS once`);
	}
	return values[0];
};

/**
 * Per-project Rust backend database URL prefix — real Postgres (PGlite
 * isn't reachable from `tokio-postgres`). The full URL is built by
 * appending the backend `name` so each Rust project gets its own
 * database (`zzz_test_rust`, `zzz_test_rust_proxy`). See the module
 * doc for the operator setup step.
 */
const RUST_DATABASE_URL_PREFIX = 'postgres://localhost/zzz_test_';

/**
 * Every mount flag `zzz_server` has, stated: `/api/ws` (`ws`), the
 * admin-gated audit stream `GET /api/admin/audit/stream`
 * (`fuz_realtime::audit_stream_router`, `sse`), and one action registry
 * serving `/api/rpc` and `/api/ws` with `PROTOCOL_ACTION_SPECS` (`peer/ping`
 * on both, so an HTTP call refuses `peer_no_transport` — `peer_request`) and
 * `build_auth_spec_set` (the self-service account actions on the socket —
 * `ws_account_actions`). No cell, fact-serving or `/ready` mounts, no test
 * create policy, and the upgrade has no role gate. The proxy project runs
 * only `proxy.cross.test.ts`, so its flags are inert there but stay honest.
 */
const rust_capabilities: BackendCapabilities = {
	...rust_default_capabilities,
	ws: true,
	sse: true,
	peer_request: true,
	ws_account_actions: true,
	cell_crud: false,
	cell_relations: false,
	cell_gated_create: false,
	fact_serving: false,
	fact_serving_admin_hash: false,
	ready: false,
	ws_role_gated: false,
	// `testing_zzzd` mounts these two of the spine's backdoors; the suites needing
	// another skip themselves, naming it
	testing_backdoors: ['_testing_reset', '_testing_drain_effects']
};

/**
 * The Rust test binary — `testing_zzzd` in the `testing_zzz_server` crate,
 * `dev` profile (wire-shape conformance with the fast argon2 hasher, so a
 * release build buys nothing). The global setup builds it before the spawn
 * (`prepare_cargo_binary`); the configs spawn the path it builds to.
 */
export const ZZZ_CARGO_BINARY: CargoBinaryOptions = {
	workspace_dir: fileURLToPath(new URL('../../..', import.meta.url)),
	package: 'testing_zzz_server',
	bin: 'testing_zzzd'
};

interface ZzzBackendPaths extends TestBackendPaths {
	scoped_dir: string;
}

/**
 * Per-backend filesystem layout — generic paths via
 * {@link build_test_backend_paths}, plus the zzz-specific `scoped_dir` for
 * `PUBLIC_ZZZ_SCOPED_DIRS`. The Rust daemon-token writer expects
 * `{zzz_dir}/run/daemon_token`, so the daemon-token path is anchored to a
 * `zzz` dir under `paths.root` (the generic builder's tmpdir subtree), and
 * `daemon_token_dir_env` derives `PUBLIC_ZZZ_DIR` from it.
 */
const build_zzz_paths = (backend_name: string): ZzzBackendPaths => {
	const paths = build_test_backend_paths(`zzz_cross_${backend_name}`);
	return {
		...paths,
		daemon_token_path: join(paths.root, 'zzz', 'run', 'daemon_token'),
		scoped_dir: join(paths.root, 'scoped')
	};
};

interface MakeZzzRustBackendOptions {
	name: string;
	port: number;
	/** The database, when it isn't the backend's own `zzz_test_<name>`. */
	database_name?: string;
	extra_env?: Record<string, string>;
}

/**
 * Rust-family wrapper that threads the zzz-specific env vars + port
 * variable name through the upstream builder. It spawns the built
 * `ZZZ_CARGO_BINARY`, which the global setup has just built, so a stale
 * binary never serves silently and a cold build runs outside the spawn's
 * health window. `PUBLIC_ZZZ_DIR` is the binary's daemon-token directory
 * (`init_daemon_token` writes `{zzz_dir}/run/daemon_token`), so it is set
 * through `daemon_token_dir_env` from `paths.daemon_token_path`.
 */
const make_zzz_rust_backend_config = ({
	name,
	port,
	database_name = name,
	extra_env
}: MakeZzzRustBackendOptions): BackendConfig => {
	const paths = build_zzz_paths(name);
	// the daemon starts its scoped-dir watcher once at boot and never retries,
	// so a missing dir leaves the scoped root unregistered for the whole run
	mkdirSync(paths.scoped_dir, { recursive: true });
	return make_default_rust_backend_config({
		name,
		port,
		start_command: [resolve_cargo_binary_path(ZZZ_CARGO_BINARY)],
		database_url: `${RUST_DATABASE_URL_PREFIX}${database_name}`,
		port_env_var: 'ZZZ_PORT',
		cookie_name: zzz_session_cookie_name(port),
		rust_log: 'info,zzz_server=info,testing_zzzd=info',
		capabilities: rust_capabilities,
		paths,
		daemon_token_dir_env: 'PUBLIC_ZZZ_DIR',
		extra_env: {
			PUBLIC_ZZZ_SCOPED_DIRS: paths.scoped_dir,
			// exact origins, the shape the production template and the CLI
			// ship — the backend's own two, the page it serves — never the
			// upstream harness's `http://localhost:*`, so the browser-gate
			// suite can show a page on another local port refused. Plus the
			// one the upstream suites send.
			FUZ_ALLOWED_ORIGINS: [
				`http://localhost:${port}`,
				`http://127.0.0.1:${port}`,
				RPC_CALL_DEFAULT_ORIGIN
			].join(','),
			...extra_env
		}
	});
};

/**
 * A miniature adapter-static build — keyed by path relative to the static
 * dir — served by the `cross_backend_rust` backend (`ZZZ_STATIC_DIR`) so
 * `static.cross.test.ts` can check the SPA routing through the real router.
 * `docs.html` sits beside a `docs/` directory with no `index.html`, the shape
 * adapter-static emits for nested prerendered pages.
 */
export const STATIC_FIXTURE_FILES = {
	'index.html': '<!doctype html>index',
	'200.html': '<!doctype html>fallback',
	'chats.html': '<!doctype html>chats',
	'docs.html': '<!doctype html>docs',
	'docs/api.html': '<!doctype html>docs api',
	'_app/immutable/x.js': 'export const x = 1;'
} as const;

/**
 * Write `STATIC_FIXTURE_FILES` into a fresh `dir` — a previous run's contents
 * are removed first, so stale files can't mask a routing miss. Synchronous
 * because it runs in the backend-config factory, before the harness spawns the
 * binary (which requires the static dir to exist at boot).
 */
const write_static_fixture = (dir: string): void => {
	rmSync(dir, { recursive: true, force: true });
	for (const [path, content] of Object.entries(STATIC_FIXTURE_FILES)) {
		const file = join(dir, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
};

/**
 * Rust backend. Requires PostgreSQL — `DATABASE_URL` resolves to
 * `zzz_test_rust` (one of the per-project DBs the operator creates
 * once; see the module doc). The test binary self-wipes the
 * auth-namespace schema on every startup, so no manual `DROP TABLE`
 * between vitest sessions is needed. Serves `STATIC_FIXTURE_FILES` as its
 * frontend (`ZZZ_STATIC_DIR`).
 */
export const rust_backend_config = (): BackendConfig => {
	const static_dir = join(build_zzz_paths('rust').root, 'static');
	write_static_fixture(static_dir);
	return make_zzz_rust_backend_config({
		name: 'rust',
		port: 4462,
		extra_env: { ZZZ_STATIC_DIR: static_dir }
	});
};

/**
 * Rust backend variant with trusted-proxy enabled. Used by the proxy
 * cross-backend suite, which can't share a backend instance with the
 * regular Rust project — flipping `ZZZ_TRUSTED_PROXIES` mid-run isn't
 * supported (Rust parses it once at boot). Port `4463` so the proxy
 * binary doesn't collide with the regular Rust project on `4462`.
 *
 * Points at its own `zzz_test_rust_proxy` database so the two Rust
 * projects don't fight over `bootstrap_lock` state and can run in
 * parallel.
 */
export const rust_proxy_backend_config = (): BackendConfig =>
	make_zzz_rust_backend_config({
		name: 'rust_proxy',
		port: 4463,
		extra_env: { ZZZ_TRUSTED_PROXIES: '127.0.0.1' }
	});

/**
 * A second Rust backend for `dev_origins.cross.test.ts`, started with the dev
 * env template's origin allowlist and no frontend of its own — what
 * `cargo xtask dev` runs. The suite spawns it itself, beside the
 * `cross_backend_rust` project's backend, and makes only requests that need
 * no account, so it shares that project's database instead of taking one of
 * its own: it never wipes the schema on startup, and its migrations find
 * them already run.
 */
export const rust_dev_origins_backend_config = (): BackendConfig =>
	make_zzz_rust_backend_config({
		name: 'rust_dev_origins',
		port: 4464,
		database_name: 'rust',
		extra_env: {
			FUZ_ALLOWED_ORIGINS: read_dev_allowed_origins(),
			FUZ_TESTING_RESET_DB_ON_STARTUP: 'false'
		}
	});
