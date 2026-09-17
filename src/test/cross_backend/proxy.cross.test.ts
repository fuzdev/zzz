/**
 * Trusted-proxy + client IP resolution cross-process tests (Rust-only).
 *
 * Exercises Rust's `proxy::client_ip_middleware` behind
 * `ZZZ_TRUSTED_PROXIES=127.0.0.1`.
 *
 * **Wiring constraint** — this suite must run against a Rust backend
 * spawned with `ZZZ_TRUSTED_PROXIES=127.0.0.1` in its environment. The
 * vitest config wires this as its own project
 * (`cross_backend_rust_proxy`) with a dedicated `globalSetup` that calls
 * `bootstrap_backend(rust_backend_config_with_trusted_proxy())`; other
 * cross-backend suites continue to use the trusted-proxy-less
 * `cross_backend_rust` project so their tests aren't influenced by the
 * middleware (which collapses every connection IP to the resolved
 * client IP). Without the trusted-proxy env var the Rust middleware
 * would always return the TCP peer IP and every test here would
 * collapse to the same assertion.
 *
 * These tests need the backend booted with a trusted-proxy list, so they
 * live in a dedicated project (`cross_backend_rust_proxy`) rather than gating
 * with `test_if(capabilities.trusted_proxy, ...)` — keeping the backend env
 * trusted-proxy-free for the rest of the suite.
 *
 * **Audit-read pattern** — each test fires a `/login` 401 under a unique
 * `proxy-test-<label>-<uuid>` username, with crafted `X-Forwarded-For`
 * headers, then queries the resulting `audit_log` row's `ip` column to
 * assert the resolved client IP. Uses a direct `pg` Client against the
 * per-project Rust test database (`zzz_test_rust_proxy` for this
 * suite) rather than the `audit_log_list` RPC because that RPC requires
 * the `admin` role, and the bootstrapped keeper only holds `keeper`.
 * The direct query is acceptable here because (a) these tests are
 * Rust-only, (b) the test DB is a real Postgres (no PGlite path to
 * confuse), and (c) the audit write is fire-and-forget so we poll
 * until the row appears.
 *
 * The DB URL is sourced from `handle.config.env.DATABASE_URL` rather
 * than a hardcoded constant — `zzz_backend_config.ts` builds it as
 * `${RUST_DATABASE_URL_PREFIX}${name}` so the per-project DB
 * isolation lifts cleanly into here without any harness↔test
 * coordination.
 *
 * @module
 */

import { describe, test, inject, assert, afterAll } from 'vitest';
import { Client } from 'pg';

import {
	type ReconstructedBootstrappedBackendHandle,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

import './cross_test_types.ts';

/**
 * Resolve the connection string for the spawned backend's database.
 *
 * Reads `handle.config.env.DATABASE_URL` (built by
 * `rust_proxy_backend_config()` in `zzz_backend_config.ts` as
 * `postgres://localhost/zzz_test_rust_proxy`). `TEST_DATABASE_URL`
 * remains as a CI override hook — useful when the runner needs a
 * custom host even though the binary's URL is set per-project.
 */
const resolve_database_url = (handle: ReconstructedBootstrappedBackendHandle): string => {
	const env_override = process.env.TEST_DATABASE_URL;
	if (env_override) return env_override;
	const backend_url = handle.config.env?.DATABASE_URL;
	if (!backend_url) {
		throw new Error(
			'proxy.cross.test: handle.config.env.DATABASE_URL missing — ' +
				'expected `rust_proxy_backend_config()` to set DATABASE_URL on the env block'
		);
	}
	return backend_url;
};

/**
 * Lazy-singleton `pg.Client` shared by every test in this file. Each
 * test does one short-lived query and the suite runs serially within a
 * single vitest project, so a single client suffices and one connection
 * roundtrip is amortized across ten tests.
 */
let pg_client: Client | null = null;

const get_pg_client = async (handle: ReconstructedBootstrappedBackendHandle): Promise<Client> => {
	if (pg_client) return pg_client;
	const client = new Client({ connectionString: resolve_database_url(handle) });
	await client.connect();
	pg_client = client;
	return client;
};

afterAll(async () => {
	if (pg_client) {
		await pg_client.end();
		pg_client = null;
	}
});

/**
 * Fire a deliberately-failed login attempt against the spawned backend.
 *
 * Uses an obviously-wrong password so the request always reaches the
 * failure-audit emit site regardless of whether the username matches
 * a real account (it never does — the usernames are
 * `proxy-test-<label>-<uuid>` randoms).
 *
 * Returns the response so callers can drain its body even on
 * unexpected-status paths to keep the connection from leaking.
 */
const fire_failed_login = async (
	handle: ReconstructedBootstrappedBackendHandle,
	username: string,
	xff: string | null
): Promise<Response> => {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Origin: handle.config.base_url
	};
	if (xff !== null) headers['X-Forwarded-For'] = xff;
	const response = await fetch(`${handle.config.base_url}/api/account/login`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ username, password: 'proxy-test-wrong-pw' })
	});
	// Drain the body so the socket releases cleanly. The 401 path returns
	// a small JSON envelope; we don't assert on shape here (audit-row IP is
	// the assertion, login outcome is incidental).
	await response.text().catch(() => undefined);
	return response;
};

/**
 * Poll the `audit_log` table for the most recent `login` / `failure` row
 * whose `metadata.username` matches the test-scoped username. Returns
 * the resolved `ip` value (or `null` if the column is null) once the
 * row appears, or throws when the deadline elapses.
 *
 * The Rust backend's audit emit fires from `tokio::spawn`, so the row
 * may land a few ms after the HTTP response. Poll at 25ms intervals
 * up to 2s — generous enough to absorb scheduler jitter under cargo
 * workload, tight enough that failed assertions don't drag suite time.
 */
const wait_for_login_failure_ip = async (
	handle: ReconstructedBootstrappedBackendHandle,
	username: string,
	{ timeout_ms = 2_000, interval_ms = 25 }: { timeout_ms?: number; interval_ms?: number } = {}
): Promise<string | null> => {
	const client = await get_pg_client(handle);
	const deadline = performance.now() + timeout_ms;
	let last_error: unknown;
	while (performance.now() < deadline) {
		try {
			const result = await client.query<{ ip: string | null }>(
				`SELECT ip FROM audit_log
				 WHERE event_type = 'login'
				   AND outcome = 'failure'
				   AND metadata->>'username' = $1
				 ORDER BY seq DESC
				 LIMIT 1`,
				[username]
			);
			if (result.rows.length > 0) return result.rows[0]!.ip;
		} catch (e) {
			last_error = e;
		}
		await new Promise((resolve) => setTimeout(resolve, interval_ms));
	}
	throw new Error(
		`wait_for_login_failure_ip(${username}): no row matched within ${timeout_ms}ms` +
			(last_error
				? ` (last error: ${last_error instanceof Error ? last_error.message : JSON.stringify(last_error)})`
				: '')
	);
};

/**
 * Build a unique test-scoped username. The random suffix defends
 * against residual rows from prior runs of this suite within a single
 * test-database lifetime, so each test's `metadata->>'username'` filter
 * matches exactly one row.
 */
const unique_username = (label: string): string =>
	`proxy-test-${label}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Run one trusted-proxy assertion: fire a failed login with the given
 * XFF header, wait for the audit row, assert the resolved IP. Wraps
 * the shared three-step pattern so the per-test body is one call.
 */
const assert_resolved_ip = async (
	handle: ReconstructedBootstrappedBackendHandle,
	label: string,
	xff: string | null,
	expected_ip: string,
	message: string
): Promise<void> => {
	const username = unique_username(label);
	await fire_failed_login(handle, username, xff);
	const resolved_ip = await wait_for_login_failure_ip(handle, username);
	assert.strictEqual(resolved_ip, expected_ip, message);
};

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));

describe('proxy.cross', () => {
	// No XFF header — middleware uses the TCP peer (loopback). The harness
	// always binds the backend to 127.0.0.1.
	test('proxy_no_xff_uses_connection_ip', async () => {
		await assert_resolved_ip(handle, 'no-xff', null, '127.0.0.1', 'audit.ip = connection IP');
	});

	// XFF present + connection from trusted proxy (loopback in
	// ZZZ_TRUSTED_PROXIES for this project) → resolved to the rightmost-first
	// untrusted entry.
	test('proxy_trusted_xff_resolves_to_originator', async () => {
		await assert_resolved_ip(
			handle,
			'trusted',
			'203.0.113.1',
			'203.0.113.1',
			'audit.ip = XFF originator'
		);
	});

	// Multi-hop chain: client → some-other-proxy (untrusted) → 127.0.0.1
	// (trusted). Right-to-left walk: skip the trusted loopback, stop at the
	// first untrusted entry.
	test('proxy_multi_hop_stops_at_first_untrusted', async () => {
		await assert_resolved_ip(
			handle,
			'multi-hop',
			'203.0.113.1, 198.51.100.7, 127.0.0.1',
			'198.51.100.7',
			'audit.ip = first untrusted from right'
		);
	});

	// Malformed entry between client and trusted proxy. `attacker-controlled`
	// fails strict validation and gets skipped during the right-to-left walk
	// so an attacker can't rotate garbage as a fresh rate-limit-key.
	test('proxy_malformed_xff_entry_skipped', async () => {
		await assert_resolved_ip(
			handle,
			'malformed',
			'attacker-controlled, 203.0.113.1',
			'203.0.113.1',
			'audit.ip skips malformed entry'
		);
	});

	// Every XFF entry is trusted (loopback). `resolve_client_ip` falls through
	// to the leftmost strictly-valid entry, which is itself the trusted proxy
	// IP — likely a misconfiguration in production, but defined behavior so
	// the bucket has a stable key.
	test('proxy_all_trusted_xff_falls_back_to_leftmost', async () => {
		await assert_resolved_ip(
			handle,
			'all-trusted',
			'127.0.0.1',
			'127.0.0.1',
			'audit.ip = leftmost trusted entry'
		);
	});

	// Empty XFF header — short-circuits to the connection IP without the
	// spurious "all XFF entries trusted" warn the bare `resolve_client_ip("")`
	// path used to emit. Resolved value matches `_no_xff_uses_connection_ip`;
	// this test exists to lock the empty-string code path.
	test('proxy_empty_xff_uses_connection_ip', async () => {
		await assert_resolved_ip(
			handle,
			'empty-xff',
			'',
			'127.0.0.1',
			'audit.ip = connection IP on empty XFF'
		);
	});

	// IPv6 originator — Rust's `IpAddr::from_str` is stricter than the JS
	// helpers fuz_app guards against, so this exercises the "Rust handles
	// real IPv6 in XFF the same way TS does" parity claim end-to-end.
	test('proxy_ipv6_originator_in_xff', async () => {
		await assert_resolved_ip(
			handle,
			'v6-origin',
			'2001:db8::1, 127.0.0.1',
			'2001:db8::1',
			'audit.ip = IPv6 originator'
		);
	});

	// IPv4-mapped IPv6 in XFF must normalize to plain IPv4 before landing in
	// the audit row. Otherwise downstream consumers (rate-limit keys, audit
	// joins) see `::ffff:203.0.113.1` and `203.0.113.1` as distinct
	// identities for the same client.
	test('proxy_ipv4_mapped_xff_normalizes', async () => {
		await assert_resolved_ip(
			handle,
			'v4-mapped',
			'::ffff:203.0.113.1, 127.0.0.1',
			'203.0.113.1',
			'audit.ip = normalized IPv4-mapped form'
		);
	});

	// Tighter multi-hop: malformed entry between client and trusted proxy
	// must not short-circuit the walk to the trusted entry, and the malformed
	// entry must not surface as the client IP (rate-limit-key poisoning
	// defense). 127.0.0.1 (trusted, skip) → attacker-controlled (malformed,
	// skip) → 198.51.100.7 (valid, untrusted) → stop.
	test('proxy_multi_hop_with_malformed_then_untrusted', async () => {
		await assert_resolved_ip(
			handle,
			'mixed',
			'198.51.100.7, attacker-controlled, 127.0.0.1',
			'198.51.100.7',
			'audit.ip skips malformed and stops at first valid untrusted'
		);
	});

	// End-to-end rate-limit-key poisoning defense: with every entry
	// malformed, `resolve_client_ip` returns `None` (right-to-left walk skips
	// all; leftmost-strictly-valid fallback finds nothing), and the
	// middleware silently falls back to the connection IP. The surface this
	// locks is the all-malformed shape — `_malformed_xff_entry_skipped` only
	// covers malformed-between-valid (which still has a valid entry to
	// return); this test exercises the case where the resolver returns
	// `None` and the middleware path matters.
	test('proxy_all_malformed_xff_falls_back_to_connection_ip', async () => {
		await assert_resolved_ip(
			handle,
			'all-malformed',
			'attacker-rotation-a, attacker-rotation-b',
			'127.0.0.1',
			'audit.ip = connection IP on all-malformed XFF'
		);
	});
});
