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

import {backends, type BackendConfig, INTEGRATION_SCOPED_DIR, INTEGRATION_ZZZ_DIR, TEST_DATABASE_URL} from './config.ts';
import {run_tests, type TestResult} from './tests.ts';
import {run_bearer_tests, setup_bearer_tokens} from './bearer_tests.ts';
import {run_account_tests} from './account_tests.ts';
import {hmac_sign, sql_escape} from './test_helpers.ts';
// @ts-ignore — npm specifier, resolved at runtime by Deno
import {hash as blake3_hash} from 'npm:@fuzdev/blake3_wasm';
// @ts-ignore — npm specifier, resolved at runtime by Deno
import {to_hex} from 'npm:@fuzdev/fuz_util/hex.js';

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
	let backend = 'both';
	let filter: string | undefined;

	for (const arg of Deno.args) {
		if (arg.startsWith('--backend=')) {
			backend = arg.slice('--backend='.length);
		} else if (arg.startsWith('--filter=')) {
			filter = arg.slice('--filter='.length);
		}
	}

	return {backend, filter};
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
 * Inserts account + actor (no keeper permit) + session via psql,
 * then signs a session cookie using HMAC-SHA256.
 */
const setup_non_keeper_user = async (config: BackendConfig): Promise<string | undefined> => {
	if (!config.auth || !config.env) return undefined;

	const cookie_key = config.env.SECRET_COOKIE_KEYS;
	if (!cookie_key) return undefined;

	const session_token = 'test-non-keeper-session-token';
	const token_hash = to_hex(blake3_hash(new TextEncoder().encode(session_token)));

	// expires_at: 30 days from now (seconds since epoch)
	const expires_at = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

	// Insert account, actor (no keeper permit), and session via psql
	const sql = `
		INSERT INTO account (id, username, password_hash)
		VALUES ('00000000-0000-0000-0000-000000000002', 'testuser', '$argon2id$v=19$m=19456,t=2,p=1$dummy$dummyhash000000000000000000000000000')
		ON CONFLICT DO NOTHING;

		INSERT INTO actor (id, account_id, name)
		VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'testuser')
		ON CONFLICT DO NOTHING;

		INSERT INTO auth_session (id, account_id, expires_at)
		VALUES ('${sql_escape(token_hash)}', '00000000-0000-0000-0000-000000000002', NOW() + INTERVAL '30 days')
		ON CONFLICT DO NOTHING;
	`;

	const cmd = new Deno.Command('psql', {
		args: [TEST_DATABASE_URL, '-c', sql],
		stdout: 'null',
		stderr: 'piped',
	});
	const child = cmd.spawn();
	const status = await child.status;
	if (!status.success) {
		const stderr_text = (await new Response(child.stderr).text()).trim();
		console.warn(`  Non-keeper user setup warning: ${stderr_text}`);
		return undefined;
	}
	await child.stderr.cancel();

	// Sign the cookie: {session_token}:{expires_at}.{signature}
	const cookie_value = await hmac_sign(`${session_token}:${expires_at}`, cookie_key);
	// Set both cookie names: Rust uses fuz_session, Deno uses zzz_session
	const cookie = `fuz_session=${cookie_value}; zzz_session=${cookie_value}`;
	console.log('  Non-keeper user created');
	return cookie;
};

/**
 * Clean auth tables in the test database before a backend run.
 *
 * Uses TRUNCATE CASCADE to reset all auth state. Runs directly via
 * `psql` since we don't want a Postgres client library in the test runner.
 */
const clean_database = async (): Promise<void> => {
	const cmd = new Deno.Command('psql', {
		args: [
			TEST_DATABASE_URL,
			'-c',
			`TRUNCATE api_token, auth_session, permit, actor, account, bootstrap_lock, app_settings CASCADE;
			 INSERT INTO bootstrap_lock (id, bootstrapped) VALUES (1, false) ON CONFLICT (id) DO UPDATE SET bootstrapped = false;
			 INSERT INTO app_settings (id) VALUES (1) ON CONFLICT DO NOTHING;`,
		],
		stdout: 'null',
		stderr: 'piped',
	});
	const child = cmd.spawn();
	const status = await child.status;
	if (!status.success) {
		// On first run, tables may not exist yet — that's fine, migrations will create them
		const stderr_text = (await new Response(child.stderr).text()).trim();
		if (stderr_text.includes('does not exist')) {
			console.log('  DB cleanup skipped (tables not yet created)');
		} else {
			console.warn(`  DB cleanup warning: ${stderr_text}`);
		}
	} else {
		// Drain stderr
		try {
			await child.stderr.cancel();
		} catch {
			// Already consumed
		}
		console.log('  DB cleaned');
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
}

const run_for_backend = async (config: BackendConfig, filter?: string): Promise<BackendRun> => {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`  Backend: ${config.name}`);
	console.log('='.repeat(60));

	let child: Deno.ChildProcess | null = null;
	try {
		await clean_database();
		await setup_scoped_dir();
		await setup_zzz_dir();
		await write_bootstrap_token(config);
		child = await start_backend(config);
		const session_cookie = await setup_auth(config);
		const non_keeper_cookie = await setup_non_keeper_user(config);
		await setup_bearer_tokens();
		const results = await run_tests(config, filter, session_cookie, non_keeper_cookie);
		const bearer_results = await run_bearer_tests(config, session_cookie, filter);
		results.push(...bearer_results);
		const account_results = await run_account_tests(config, filter);
		results.push(...account_results);

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
		return {name: config.name, results, passed, failed, total_ms};
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
			totals[i] += t;
			if (!is_silence) totals_excl[i] += t;
		});

		const time_cols = times.map((t) => fmt_ms(t).padStart(col_w)).join('');

		let cmp_str = '';
		if (times.length >= 2 && times[0] > 0 && times[1] > 0) {
			cmp_str = is_silence ? '  (silence)' : `  ${fmt_comparison(times[0], times[1])}`;
		}

		const label = is_silence ? `${test_name} *` : test_name;
		console.log(`  ${label.padEnd(36)}${time_cols}${cmp_str}`);
	}

	// Totals
	console.log('  ' + '-'.repeat(header.length - 2));
	const total_cols = totals.map((t) => fmt_ms(t).padStart(col_w)).join('');
	console.log(`  ${'total'.padEnd(36)}${total_cols}`);

	const excl_cols = totals_excl.map((t) => fmt_ms(t).padStart(col_w)).join('');
	const excl_cmp =
		totals_excl[0] > 0 && totals_excl[1] > 0
			? `  ${fmt_comparison(totals_excl[0], totals_excl[1])}`
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
	} else if (backends[backend_arg]) {
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

	console.log(`\n${'='.repeat(60)}`);
	if (all_passed) {
		console.log('  All backends passed');
	} else {
		console.log('  Some tests failed');
		Deno.exit(1);
	}
};

await main();
