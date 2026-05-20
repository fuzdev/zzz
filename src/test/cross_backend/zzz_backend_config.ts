/**
 * Cross-process `BackendConfig` factories for zzz's cross-backend
 * integration suites.
 *
 * Four target backends spanning both the JS-runtime and TS-vs-Rust axes:
 *
 * - {@link deno_backend_config} — TS canonical backend on Deno V8 (spawns
 *   `testing_server_deno.ts`). Same wire shape as production zzz today.
 * - {@link node_backend_config} — TS canonical backend on Node V8 (spawns
 *   `testing_server_node.ts` under `tsx`). Isolates the JS-runtime axis
 *   (Deno vs Node V8) on identical TS canonical surfaces.
 * - {@link rust_backend_config} — Axum/JSON-RPC backend (spawns
 *   `testing_zzz_server`). Isolates the cross-language axis (TS vs
 *   Rust) on the shared `/api/*` wire shape.
 * - {@link rust_proxy_backend_config} — Rust variant with
 *   `ZZZ_TRUSTED_PROXIES=127.0.0.1` for the proxy suite. Separate
 *   project because flipping that env mid-run isn't supported (Rust
 *   parses it once at boot).
 *
 * Each public factory composes a small per-backend declaration against
 * a family-shared builder ({@link make_ts_backend_config} /
 * {@link make_rust_backend_config}) that owns the common shape — env
 * baseline, bootstrap fields, capabilities, timeouts, the shared
 * `/api/*` paths. fuz_app's `spawn_backend` consumes the result.
 *
 * **Port assignments** — fixed-but-distinct, no collision with the
 * production daemon (zzz Deno on `4040`, zzz Rust on `1174`):
 *
 * - Deno test binary → `11741`
 * - Node test binary → `11742`
 * - Rust test binary → `1175` (matches `testing_zzz_server`'s
 *   `TESTING_DEFAULT_PORT`)
 * - Rust+proxy test binary → `1176`
 *
 * Vitest projects spawn one backend each, so ports only need to not
 * collide cross-project, not cross-test.
 *
 * @module
 */

import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {BackendConfig} from '@fuzdev/fuz_app/testing/cross_backend/backend_config.js';
import type {BackendCapabilities} from '@fuzdev/fuz_app/testing/cross_backend/capabilities.js';

/**
 * Fixed bootstrap token written to each backend's `token_path` before
 * spawn. The test binary reads + consumes this via
 * `FUZ_BOOTSTRAP_TOKEN_PATH`; the harness POSTs the same token to
 * `/api/account/bootstrap` to mint the keeper account. Any 32+ char
 * string works — the binary just compares bytes, no entropy required
 * for tests.
 */
const BOOTSTRAP_TOKEN = 'test_bootstrap_token_for_cross_be';

/** Keeper username used by every cross-process test fixture. */
const KEEPER_USERNAME = 'keeper';

/** Keeper password used by every cross-process test fixture. */
const KEEPER_PASSWORD = 'password_test_keeper';

/**
 * Dev-only cookie keys (64+ chars). The test binary needs
 * `SECRET_FUZ_COOKIE_KEYS` to construct its `Keyring`. Never used
 * in production — the test binaries themselves throw on production
 * load via `assert_dev_env`.
 */
const COOKIE_KEYS = 'dev_only_cookie_keys_for_cross_backend_tests_not_for_prod_use_xx';

/** TS backend database URL — in-memory PGlite, matches `create_test_app`'s default. */
const TS_DATABASE_URL = 'memory://';

/** Rust backend database URL — real Postgres (PGlite isn't reachable from `tokio-postgres`). */
const RUST_DATABASE_URL = 'postgres://localhost/zzz_test';

/**
 * Capabilities shared by the two TS backends — same canonical
 * implementation, same feature set. No trusted-proxy phase (the test
 * binary doesn't enable `ZZZ_TRUSTED_PROXIES`) and no per-account
 * login rate limit (Rust-only env-gate; the TS canonical path leaves
 * the limiter null in test mode).
 */
const TS_CAPABILITIES: BackendCapabilities = {
	bearer_auth: true,
	trusted_proxy: false,
	login_rate_limit: false,
	ws: true,
	sse: false,
	in_process_only: false,
};

/**
 * Capabilities for the Rust backend. Adds `trusted_proxy: true`
 * (Rust's `proxy::client_ip_middleware` is always wired; the
 * env-gate just controls whether XFF is consulted vs the TCP peer
 * IP) and `login_rate_limit: true` (Rust-only env-gated bucket on
 * `/login` + `/password`).
 */
const RUST_CAPABILITIES: BackendCapabilities = {
	bearer_auth: true,
	trusted_proxy: true,
	login_rate_limit: true,
	ws: true,
	sse: false,
	in_process_only: false,
};

interface PerBackendPaths {
	zzz_dir: string;
	bootstrap_token_path: string;
	daemon_token_path: string;
	scoped_dir: string;
}

/**
 * Per-backend filesystem layout under `os.tmpdir()`. Isolation matters
 * because vitest projects can run in parallel — a shared `zzz_dir`
 * would mix daemon tokens across concurrently-running backends.
 *
 * - `zzz_dir` — `PUBLIC_ZZZ_DIR`; the daemon-token rotator writes
 *   `{zzz_dir}/run/daemon_token` here and the harness reads from the
 *   same path.
 * - `bootstrap_token_path` — `FUZ_BOOTSTRAP_TOKEN_PATH`; harness writes
 *   the bootstrap token here before spawn.
 * - `scoped_dir` — `PUBLIC_ZZZ_SCOPED_DIRS` entry so filesystem
 *   actions have a writable scratch root.
 */
const build_paths = (backend_name: string): PerBackendPaths => {
	const root = join(tmpdir(), `zzz_cross_${backend_name}`);
	const zzz_dir = join(root, 'zzz');
	return {
		zzz_dir,
		bootstrap_token_path: join(root, 'bootstrap_token'),
		// `init_daemon_token` (Rust) and the TS server's daemon-token
		// writer both land the token at `{zzz_dir}/run/daemon_token`.
		daemon_token_path: join(zzz_dir, 'run', 'daemon_token'),
		scoped_dir: join(root, 'scoped'),
	};
};

interface MakeTsBackendConfigOptions {
	name: string;
	port: number;
	start_command: ReadonlyArray<string>;
}

/**
 * Shared builder for the TS-family backends (Deno + Node). Owns the
 * common env baseline (PORT, NODE_ENV, in-memory PGlite, TS
 * capabilities, 30s timeout) so per-backend factories only declare
 * what genuinely differs.
 */
const make_ts_backend_config = ({
	name,
	port,
	start_command,
}: MakeTsBackendConfigOptions): BackendConfig => {
	const paths = build_paths(name);
	return {
		name,
		start_command,
		base_url: `http://localhost:${port}`,
		rpc_path: '/api/rpc',
		ws_path: '/api/ws',
		health_path: '/health',
		bootstrap_path: '/api/account/bootstrap',
		cookie_name: 'fuz_session',
		startup_timeout_ms: 30_000,
		env: {
			NODE_ENV: 'development',
			HOST: 'localhost',
			PORT: String(port),
			DATABASE_URL: TS_DATABASE_URL,
			SECRET_FUZ_COOKIE_KEYS: COOKIE_KEYS,
			FUZ_ALLOWED_ORIGINS: 'http://localhost:*',
			FUZ_BOOTSTRAP_TOKEN_PATH: paths.bootstrap_token_path,
			PUBLIC_ZZZ_DIR: paths.zzz_dir,
			PUBLIC_ZZZ_SCOPED_DIRS: paths.scoped_dir,
		},
		bootstrap: {
			token_path: paths.bootstrap_token_path,
			token: BOOTSTRAP_TOKEN,
			username: KEEPER_USERNAME,
			password: KEEPER_PASSWORD,
			daemon_token_path: paths.daemon_token_path,
		},
		capabilities: TS_CAPABILITIES,
	};
};

interface MakeRustBackendConfigOptions {
	name: string;
	port: number;
	extra_env?: Record<string, string>;
}

/**
 * Shared builder for the Rust-family backends (regular + proxy
 * variant). Owns the common env baseline (ZZZ_PORT, RUST_LOG, real
 * Postgres, Rust capabilities, 120s startup window for cargo's
 * first-run build cost) so per-backend factories only declare the
 * port and any extra env (e.g. `ZZZ_TRUSTED_PROXIES`).
 *
 * `cargo run --release` keeps the source-of-truth invocation in
 * cargo's hands so a stale `target/release/testing_zzz_server` from
 * a prior checkout never serves silently. Consumers iterating
 * locally can swap to `['target/release/testing_zzz_server']` for
 * faster spawns once they've built the binary at least once.
 */
const make_rust_backend_config = ({
	name,
	port,
	extra_env,
}: MakeRustBackendConfigOptions): BackendConfig => {
	const paths = build_paths(name);
	return {
		name,
		start_command: ['cargo', 'run', '--release', '--bin', 'testing_zzz_server'],
		base_url: `http://localhost:${port}`,
		rpc_path: '/api/rpc',
		ws_path: '/api/ws',
		health_path: '/health',
		bootstrap_path: '/api/account/bootstrap',
		cookie_name: 'fuz_session',
		startup_timeout_ms: 120_000,
		env: {
			RUST_LOG: 'info,zzz_server=info,testing_zzz_server=info',
			HOST: 'localhost',
			ZZZ_PORT: String(port),
			DATABASE_URL: RUST_DATABASE_URL,
			SECRET_FUZ_COOKIE_KEYS: COOKIE_KEYS,
			FUZ_ALLOWED_ORIGINS: 'http://localhost:*',
			FUZ_BOOTSTRAP_TOKEN_PATH: paths.bootstrap_token_path,
			PUBLIC_ZZZ_DIR: paths.zzz_dir,
			PUBLIC_ZZZ_SCOPED_DIRS: paths.scoped_dir,
			...extra_env,
		},
		bootstrap: {
			token_path: paths.bootstrap_token_path,
			token: BOOTSTRAP_TOKEN,
			username: KEEPER_USERNAME,
			password: KEEPER_PASSWORD,
			daemon_token_path: paths.daemon_token_path,
		},
		capabilities: RUST_CAPABILITIES,
	};
};

/**
 * TS canonical backend on Deno V8. The `--allow-*` flag set mirrors
 * the `test:server:deno` package script (kept in sync — the script is
 * the source of truth for the permission set).
 */
export const deno_backend_config = (): BackendConfig =>
	make_ts_backend_config({
		name: 'deno',
		port: 11741,
		start_command: [
			'deno',
			'run',
			'--allow-net',
			'--allow-read',
			'--allow-env',
			'--allow-write',
			'--allow-sys',
			'--unstable-detect-cjs',
			'src/lib/server/testing_server_deno.ts',
		],
	});

/**
 * TS canonical backend on Node V8. Spawns `testing_server_node.ts`
 * via `tsx` (matches the `test:server:node` package script). Same
 * source modules as the Deno entry — the runtime adapter is the
 * only divergence.
 */
export const node_backend_config = (): BackendConfig =>
	make_ts_backend_config({
		name: 'node',
		port: 11742,
		start_command: ['npx', 'tsx', 'src/lib/server/testing_server_node.ts'],
	});

/**
 * Rust backend. Requires PostgreSQL — `DATABASE_URL` points at the
 * cross-backend test database, cleaned per backend run by the
 * harness.
 */
export const rust_backend_config = (): BackendConfig =>
	make_rust_backend_config({
		name: 'rust',
		port: 1175,
	});

/**
 * Rust backend variant with trusted-proxy enabled. Used by the proxy
 * cross-backend suite, which can't share a backend instance with the
 * regular Rust project — flipping `ZZZ_TRUSTED_PROXIES` mid-run isn't
 * supported (Rust parses it once at boot). Port `1176` so the proxy
 * binary doesn't collide with the regular Rust project on `1175`.
 */
export const rust_proxy_backend_config = (): BackendConfig =>
	make_rust_backend_config({
		name: 'rust_proxy',
		port: 1176,
		extra_env: {ZZZ_TRUSTED_PROXIES: '127.0.0.1'},
	});
