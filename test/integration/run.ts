#!/usr/bin/env -S deno run --allow-net --allow-run --allow-read --allow-write --allow-env

/**
 * Integration test runner for zzz backends.
 *
 * Usage:
 *   deno task test:integration --backend=rust
 *   deno task test:integration --backend=deno
 *   deno task test:integration --backend=both   (default)
 *   deno task test:integration --filter=ping     (substring match on test name)
 *
 * Starts a backend, runs the test suite against it, stops it, reports results.
 * When running both backends, prints a comparison table at the end.
 */

import process from 'node:process';

import {args_parse, argv_parse} from '@fuzdev/fuz_util/args.js';
import {create_db} from '@fuzdev/fuz_app/db/create_db.js';
import {
	query_schema_snapshot,
	type SchemaSnapshot,
} from '@fuzdev/fuz_app/testing/schema_introspect.js';
import {
	assert_schema_snapshots_equal,
	diff_schema_snapshots,
	format_schema_diffs,
} from '@fuzdev/fuz_app/testing/schema_parity.js';
import {z} from 'zod';

import {
	backends,
	type BackendConfig,
	INTEGRATION_SCOPED_DIR,
	INTEGRATION_ZZZ_DIR,
	TEST_DATABASE_URL,
} from './config.ts';
import {run_tests, type TestResult} from './tests.ts';
import {run_bearer_tests, setup_bearer_tokens} from './bearer_tests.ts';
import {run_account_tests} from './account_tests.ts';
import {run_admin_tests} from './admin_tests.ts';
import {run_audit_tests} from './audit_tests.ts';
import {run_proxy_tests} from './proxy_tests.ts';
import {run_rate_limit_tests} from './rate_limit_tests.ts';
import {hash_token, hmac_sign, run_psql, sql_escape} from './test_helpers.ts';

const RunArgs = z.object({
	backend: z.string().default('both'),
	filter: z.string().optional(),
});

// -- Child process tracking ---------------------------------------------------

/** Active backend processes — killed on SIGINT so Ctrl+C doesn't leak them. */
const active_children: Set<Deno.ChildProcess> = new Set();

Deno.addSignalListener('SIGINT', () => {
	console.log('\n  Interrupted — stopping backends...');
	for (const child of active_children) {
		try {
			child.kill('SIGTERM');
		} catch {
			// Already exited
		}
	}
	Deno.exit(130); // 128 + SIGINT(2)
});

// -- Formatting ---------------------------------------------------------------

const fmt_ms = (ms: number): string => (ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`);

// -- Backend lifecycle --------------------------------------------------------

const parse_args = (): {backend: string; filter: string | undefined} => {
	const parsed = args_parse(argv_parse(process.argv.slice(2)), RunArgs);
	if (!parsed.success) {
		console.error(z.prettifyError(parsed.error));
		Deno.exit(1);
	}
	return {backend: parsed.data.backend, filter: parsed.data.filter};
};

const wait_for_health = async (config: BackendConfig): Promise<boolean> => {
	const url = `${config.base_url}${config.health_path}`;
	const deadline = Date.now() + config.startup_timeout_ms;
	const poll_interval = 250;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) {
				await res.body?.cancel();
				return true;
			}
			await res.body?.cancel();
		} catch {
			// Server not ready yet
		}
		await new Promise((r) => setTimeout(r, poll_interval));
	}
	return false;
};

const start_backend = async (config: BackendConfig): Promise<Deno.ChildProcess> => {
	console.log(`\n  Starting ${config.name} backend: ${config.start_command.join(' ')}`);

	const [cmd, ...args] = config.start_command;
	if (!cmd) throw new Error(`${config.name}: start_command is empty`);
	const child = new Deno.Command(cmd, {
		args,
		stdout: 'null',
		stderr: 'piped',
		env: config.env ? {...Deno.env.toObject(), ...config.env} : undefined,
	}).spawn();

	const healthy = await wait_for_health(config);
	if (!healthy) {
		child.kill('SIGTERM');
		// Drain stderr for diagnostic output before throwing
		try {
			const err_text = (await new Response(child.stderr).text()).trim();
			if (err_text) {
				console.error(
					`\n  ${config.name} stderr:\n${err_text.split('\n').map((l) => '    ' + l).join('\n')}`,
				);
			}
		} catch {
			// Process already collected
		}
		throw new Error(`${config.name} backend failed to start within ${config.startup_timeout_ms}ms`);
	}

	console.log(`  ${config.name} backend ready at ${config.base_url}`);
	active_children.add(child);
	return child;
};

const stop_backend = async (name: string, child: Deno.ChildProcess): Promise<void> => {
	console.log(`  Stopping ${name} backend`);
	active_children.delete(child);
	try {
		child.kill('SIGTERM');
	} catch {
		// Already exited
	}
	// Drain stderr so the process isn't blocked on a full pipe
	try {
		await child.stderr.cancel();
	} catch {
		// Already consumed or closed
	}
	// Wait for the process to actually exit to avoid port conflicts
	try {
		await child.status;
	} catch {
		// Process already collected
	}
};

// -- Auth setup ---------------------------------------------------------------

/**
 * Write the bootstrap token file before the server starts.
 * The server reads this path at startup to determine bootstrap availability.
 */
const write_bootstrap_token = async (config: BackendConfig): Promise<void> => {
	if (!config.auth) return;
	await Deno.writeTextFile(config.auth.token_file, config.auth.token);
};

/**
 * Bootstrap an admin account and return the session cookie.
 * Must be called after the server is healthy. Token file must already exist.
 */
const setup_auth = async (config: BackendConfig): Promise<string | undefined> => {
	if (!config.auth) return undefined;

	const {auth} = config;

	// Bootstrap: create admin account + get session cookie
	const res = await fetch(`${config.base_url}${auth.bootstrap_path}`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			token: auth.token,
			username: auth.username,
			password: auth.password,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Bootstrap failed (${res.status}): ${body}`);
	}

	await res.json(); // consume body

	// Extract all Set-Cookie values (session + signature cookies)
	const set_cookies = res.headers.getSetCookie();
	if (set_cookies.length === 0) {
		throw new Error('Bootstrap succeeded but no session cookie in response');
	}

	// Build Cookie header: "name=value; name2=value2"
	const cookie = set_cookies.map((c) => c.split(';')[0]).join('; ');
	console.log(`  Auth bootstrapped (${set_cookies.length} cookie(s))`);
	return cookie;
};

/** Clean up the bootstrap token file if it still exists. */
const cleanup_auth = async (config: BackendConfig): Promise<void> => {
	if (!config.auth) return;
	try {
		await Deno.remove(config.auth.token_file);
	} catch {
		// Already deleted by bootstrap or doesn't exist
	}
};

// -- Non-keeper user setup ----------------------------------------------------

/**
 * Create a non-keeper authenticated user directly in the test database.
 *
 * Inserts account + actor (no keeper role grant) + session via psql,
 * then signs a session cookie using HMAC-SHA256.
 */
const setup_non_keeper_user = async (config: BackendConfig): Promise<string | undefined> => {
	if (!config.auth || !config.env) return undefined;

	const cookie_key = config.env.SECRET_COOKIE_KEYS;
	if (!cookie_key) return undefined;

	const session_token = 'test-non-keeper-session-token';
	const token_hash = hash_token(session_token);

	// expires_at: 30 days from now (seconds since epoch)
	const expires_at = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

	// Insert account, actor (no keeper role grant), and session via psql
	const result = await run_psql(`
		INSERT INTO account (id, username, password_hash)
		VALUES ('00000000-0000-0000-0000-000000000002', 'testuser', '$argon2id$v=19$m=19456,t=2,p=1$dummy$dummyhash000000000000000000000000000')
		ON CONFLICT DO NOTHING;

		INSERT INTO actor (id, account_id, name)
		VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'testuser')
		ON CONFLICT DO NOTHING;

		INSERT INTO auth_session (id, account_id, expires_at)
		VALUES ('${sql_escape(token_hash)}', '00000000-0000-0000-0000-000000000002', NOW() + INTERVAL '30 days')
		ON CONFLICT DO NOTHING;
	`);
	if (!result.ok) {
		console.warn(`  Non-keeper user setup warning: ${result.stderr}`);
		return undefined;
	}

	// Sign the cookie: {session_token}:{expires_at}.{signature}
	const cookie_value = await hmac_sign(`${session_token}:${expires_at}`, cookie_key);
	// Set both cookie names: Rust uses fuz_session, Deno uses zzz_session
	const cookie = `fuz_session=${cookie_value}; zzz_session=${cookie_value}`;
	console.log('  Non-keeper user created');
	return cookie;
};

/** Database name parsed from `TEST_DATABASE_URL` (e.g. `zzz_test`). */
const test_db_name = (() => {
	try {
		return new URL(TEST_DATABASE_URL).pathname.slice(1) || 'zzz_test';
	} catch {
		return 'zzz_test';
	}
})();

/** Connection URL for the maintenance `postgres` DB, used for DROP / CREATE. */
const maintenance_db_url = (() => {
	try {
		const u = new URL(TEST_DATABASE_URL);
		u.pathname = '/postgres';
		return u.toString();
	} catch {
		return 'postgres:///postgres';
	}
})();

/**
 * Drop and recreate the test database between backend runs.
 *
 * The cross-impl schema parity check (in `main`) needs each backend to
 * bootstrap against an empty DB so the resulting snapshot reflects only
 * what that impl produced. Tearing the DB down completely is stricter
 * than TRUNCATE — schema_version, indexes, constraints, sequences all
 * regenerate freshly on each backend start. `WITH (FORCE)` (Postgres 13+)
 * terminates any leftover connections from a still-shutting-down backend.
 */
const reset_database = async (): Promise<void> => {
	const cmd = new Deno.Command('psql', {
		args: [
			maintenance_db_url,
			'-v',
			'ON_ERROR_STOP=1',
			'-c',
			`DROP DATABASE IF EXISTS ${test_db_name} WITH (FORCE);`,
			'-c',
			`CREATE DATABASE ${test_db_name};`,
		],
		stdout: 'null',
		stderr: 'piped',
	});
	const child = cmd.spawn();
	const status = await child.status;
	if (!status.success) {
		const stderr = (await new Response(child.stderr).text()).trim();
		throw new Error(`DB reset failed:\n${stderr}`);
	}
	await child.stderr.cancel();
	console.log(`  DB reset (${test_db_name} dropped + recreated)`);
};

/**
 * Capture a schema snapshot via fuz_app's `query_schema_snapshot`.
 *
 * Opens a short-lived pg connection, introspects, closes. Called after
 * `setup_auth` so the snapshot reflects post-migration + post-bootstrap
 * state. Bootstrap rows (account, actor, role_grant) don't affect the
 * snapshot — it captures structure only.
 */
const capture_schema_snapshot = async (): Promise<SchemaSnapshot> => {
	const {db, close} = await create_db(TEST_DATABASE_URL);
	try {
		return await query_schema_snapshot(db);
	} finally {
		await close();
	}
};

// -- Scoped filesystem setup --------------------------------------------------

/** Create (or recreate) the scoped directory for filesystem tests. */
const setup_scoped_dir = async (): Promise<void> => {
	try {
		await Deno.remove(INTEGRATION_SCOPED_DIR, {recursive: true});
	} catch {
		// Didn't exist
	}
	await Deno.mkdir(INTEGRATION_SCOPED_DIR, {recursive: true});
	console.log(`  Scoped dir ready: ${INTEGRATION_SCOPED_DIR}`);
};

/** Clean up the scoped directory after a backend run. */
const cleanup_scoped_dir = async (): Promise<void> => {
	try {
		await Deno.remove(INTEGRATION_SCOPED_DIR, {recursive: true});
	} catch {
		// Already gone
	}
};

// -- Zzz dir setup ------------------------------------------------------------

/** Create (or recreate) the zzz directory for session_load tests. */
const setup_zzz_dir = async (): Promise<void> => {
	try {
		await Deno.remove(INTEGRATION_ZZZ_DIR, {recursive: true});
	} catch {
		// Didn't exist
	}
	await Deno.mkdir(INTEGRATION_ZZZ_DIR, {recursive: true});
	console.log(`  Zzz dir ready: ${INTEGRATION_ZZZ_DIR}`);
};

/** Clean up the zzz directory after a backend run. */
const cleanup_zzz_dir = async (): Promise<void> => {
	try {
		await Deno.remove(INTEGRATION_ZZZ_DIR, {recursive: true});
	} catch {
		// Already gone
	}
};

// -- Per-backend run ----------------------------------------------------------

interface BackendRun {
	name: string;
	results: TestResult[];
	passed: number;
	failed: number;
	total_ms: number;
	/**
	 * Schema introspection captured after `setup_auth` succeeded. Used by
	 * the cross-impl parity gate in `main`. Undefined when bootstrap
	 * didn't run or snapshot capture failed.
	 */
	schema_snapshot?: SchemaSnapshot;
}

const run_for_backend = async (config: BackendConfig, filter?: string): Promise<BackendRun> => {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`  Backend: ${config.name}`);
	console.log('='.repeat(60));

	let child: Deno.ChildProcess | null = null;
	let schema_snapshot: SchemaSnapshot | undefined;
	try {
		await reset_database();
		await setup_scoped_dir();
		await setup_zzz_dir();
		await write_bootstrap_token(config);
		child = await start_backend(config);
		const session_cookie = await setup_auth(config);
		// Snapshot immediately after bootstrap so the captured shape reflects
		// only what this impl produced (migrations + bootstrap), before any
		// test mutates rows. Schema-only — bootstrap account UUIDs don't
		// affect the snapshot.
		schema_snapshot = await capture_schema_snapshot();
		const non_keeper_cookie = await setup_non_keeper_user(config);
		await setup_bearer_tokens();
		const results = await run_tests(config, filter, session_cookie, non_keeper_cookie);
		if (session_cookie) {
			const bearer_results = await run_bearer_tests(config, session_cookie, filter);
			results.push(...bearer_results);
		}
		const account_results = await run_account_tests(config, filter);
		results.push(...account_results);
		const audit_results = await run_audit_tests(config, filter);
		results.push(...audit_results);
		// Admin tests come after audit/account because the
		// session_revoke_all-with-WS test destroys the non-keeper
		// user's session in the DB. Keeping this last avoids
		// reseeding non_keeper_cookie state between earlier suites.
		const admin_results = await run_admin_tests(
			config,
			session_cookie,
			non_keeper_cookie,
			filter,
		);
		results.push(...admin_results);

		// Rust-only proxy phase. Trusted-proxy resolution is a
		// startup-time config (the parsed list lives on `App`), so
		// flipping it requires a backend restart. Isolated to its
		// own process so the rest of the suite — which assumes the
		// connection IP IS the client IP — stays unaffected.
		if (config.name === 'rust') {
			await stop_backend(config.name, child);
			child = null;
			const proxy_config: BackendConfig = {
				...config,
				env: {...config.env, ZZZ_TRUSTED_PROXIES: '127.0.0.1'},
			};
			child = await start_backend(proxy_config);
			const proxy_results = await run_proxy_tests(proxy_config, filter);
			results.push(...proxy_results);
			await stop_backend(config.name, child);
			child = null;
		}

		// Rust-only rate-limit phase. The limiter is shared between
		// `/login` and `/password`, so leaving it on for the whole suite
		// would burn the bucket on the existing failed-login /
		// password tests. Restart the Rust backend with
		// `ZZZ_LOGIN_RATE_LIMIT_ENABLED=1` for this slice and stop it
		// after, isolating the env var to a dedicated process.
		if (config.name === 'rust') {
			const rl_config: BackendConfig = {
				...config,
				env: {...config.env, ZZZ_LOGIN_RATE_LIMIT_ENABLED: '1'},
			};
			child = await start_backend(rl_config);
			const rate_results = await run_rate_limit_tests(rl_config, filter);
			results.push(...rate_results);
		}

		let passed = 0;
		let failed = 0;

		for (const r of results) {
			const time = fmt_ms(r.duration_ms).padStart(8);
			if (r.passed) {
				console.log(`  PASS ${time}  ${r.name}`);
				passed++;
			} else {
				console.log(`  FAIL ${time}  ${r.name}`);
				console.log(`               ${r.error}`);
				failed++;
			}
		}

		const total_ms = results.reduce((sum, r) => sum + r.duration_ms, 0);
		console.log(`\n  ${passed} passed, ${failed} failed in ${fmt_ms(total_ms)}`);
		return {name: config.name, results, passed, failed, total_ms, schema_snapshot};
	} finally {
		await cleanup_auth(config);
		await cleanup_scoped_dir();
		await cleanup_zzz_dir();
		if (child) await stop_backend(config.name, child);
	}
};

// -- Comparison table ---------------------------------------------------------

/** Tests with a fixed wait floor that skews timing comparison. */
const SILENCE_TESTS = new Set(['notification_ws']);

/** Format speedup ratio: >= 10 → 1 decimal, < 10 → 2 decimals. */
const fmt_ratio = (r: number): string => (r >= 10 ? `${r.toFixed(1)}x` : `${r.toFixed(2)}x`);

/** Format speedup/slowdown comparison (baseline / current). */
const fmt_comparison = (baseline: number, current: number): string => {
	const ratio = baseline / current;
	if (ratio >= 1) return `${fmt_ratio(ratio)} faster`;
	return `${fmt_ratio(1 / ratio)} slower`;
};

const print_comparison = (runs: BackendRun[]): void => {
	if (runs.length < 2) return;

	// Build lookup: test name → duration per backend
	const by_test = new Map<string, Map<string, number>>();
	for (const run of runs) {
		for (const r of run.results) {
			if (!by_test.has(r.name)) by_test.set(r.name, new Map());
			by_test.get(r.name)!.set(run.name, r.duration_ms);
		}
	}

	const names = runs.map((r) => r.name);
	const col_w = 10;

	console.log(`\n${'='.repeat(60)}`);
	console.log(`  Comparison (${names[1]} vs ${names[0]})`);
	console.log(`${'='.repeat(60)}\n`);

	const header = '  ' + 'test'.padEnd(36) + names.map((n) => n.padStart(col_w)).join('');
	console.log(header);
	console.log('  ' + '-'.repeat(header.length - 2));

	const totals = names.map(() => 0);
	const totals_excl = names.map(() => 0);

	for (const [test_name, timings] of by_test) {
		const is_silence = SILENCE_TESTS.has(test_name);
		const times = names.map((n) => timings.get(n) ?? 0);

		times.forEach((t, i) => {
			totals[i] = (totals[i] ?? 0) + t;
			if (!is_silence) totals_excl[i] = (totals_excl[i] ?? 0) + t;
		});

		const time_cols = times.map((t) => fmt_ms(t).padStart(col_w)).join('');

		let cmp_str = '';
		const [t0, t1] = times;
		if (t0 !== undefined && t1 !== undefined && t0 > 0 && t1 > 0) {
			cmp_str = is_silence ? '  (silence)' : `  ${fmt_comparison(t0, t1)}`;
		}

		const label = is_silence ? `${test_name} *` : test_name;
		console.log(`  ${label.padEnd(36)}${time_cols}${cmp_str}`);
	}

	// Totals
	console.log('  ' + '-'.repeat(header.length - 2));
	const total_cols = totals.map((t) => fmt_ms(t).padStart(col_w)).join('');
	console.log(`  ${'total'.padEnd(36)}${total_cols}`);

	const excl_cols = totals_excl.map((t) => fmt_ms(t).padStart(col_w)).join('');
	const [ex0, ex1] = totals_excl;
	const excl_cmp =
		ex0 !== undefined && ex1 !== undefined && ex0 > 0 && ex1 > 0
			? `  ${fmt_comparison(ex0, ex1)}`
			: '';
	console.log(`  ${'total (excl silence)'.padEnd(36)}${excl_cols}${excl_cmp}`);

	console.log('\n  * silence tests have a fixed wait floor — excluded from comparison');
};

// -- Main ---------------------------------------------------------------------

const main = async (): Promise<void> => {
	const {backend: backend_arg, filter} = parse_args();
	const targets: BackendConfig[] = [];

	if (backend_arg === 'both') {
		targets.push(backends.deno, backends.rust);
	} else if (backend_arg === 'deno' || backend_arg === 'rust') {
		targets.push(backends[backend_arg]);
	} else {
		console.error(`Unknown backend: ${backend_arg}. Use: deno, rust, or both`);
		Deno.exit(1);
	}

	const runs: BackendRun[] = [];
	let all_passed = true;
	for (const config of targets) {
		const run = await run_for_backend(config, filter);
		runs.push(run);
		if (run.failed > 0) all_passed = false;
	}

	print_comparison(runs);

	// Cross-impl schema parity gate. Only meaningful when two or more
	// backends bootstrapped against the (drop+recreate'd) test DB —
	// single-backend runs degrade silently. Fails the suite on any
	// structural drift between impls (column type, missing migration,
	// index/constraint divergence).
	let parity_failed = false;
	if (runs.length >= 2) {
		const labelled = runs.filter(
			(r): r is BackendRun & {schema_snapshot: SchemaSnapshot} => !!r.schema_snapshot,
		);
		if (labelled.length >= 2) {
			console.log(`\n${'='.repeat(60)}`);
			console.log(`  Schema parity`);
			console.log(`${'='.repeat(60)}\n`);
			const base = labelled[0]!;
			let any_diff = false;
			for (let i = 1; i < labelled.length; i++) {
				const peer = labelled[i]!;
				const diffs = diff_schema_snapshots(
					base.schema_snapshot,
					peer.schema_snapshot,
				);
				if (diffs.length === 0) {
					console.log(`  ${peer.name} matches ${base.name} (${diffs.length} diff(s))`);
				} else {
					any_diff = true;
					console.log(
						`  PARITY FAILED: ${peer.name} vs ${base.name} — ${diffs.length} diff(s):`,
					);
					console.log(format_schema_diffs(diffs, {a: base.name, b: peer.name}));
				}
			}
			if (any_diff) {
				parity_failed = true;
			} else {
				try {
					// Re-run via the assertion for the canonical error message
					// shape; should be a no-op here.
					for (let i = 1; i < labelled.length; i++) {
						assert_schema_snapshots_equal(
							base.schema_snapshot,
							labelled[i]!.schema_snapshot,
							{a: base.name, b: labelled[i]!.name},
						);
					}
				} catch (err) {
					// Defensive — diff_schema_snapshots returned no diffs but
					// assert disagreed. Surface as a parity failure.
					console.error(`  Unexpected parity assertion failure: ${err}`);
					parity_failed = true;
				}
			}
		}
	}

	console.log(`\n${'='.repeat(60)}`);
	if (all_passed && !parity_failed) {
		console.log('  All backends passed');
	} else {
		if (!all_passed) console.log('  Some tests failed');
		if (parity_failed) console.log('  Schema parity failed');
		Deno.exit(1);
	}
};

await main();
