/**
 * Trusted-proxy + client IP resolution integration tests.
 *
 * Rust-only — exercises `proxy::client_ip_middleware` behind
 * `ZZZ_TRUSTED_PROXIES=127.0.0.1`. The runner launches a dedicated
 * Rust backend with the env var set; without it the middleware would
 * collapse every connection IP to the TCP peer (Phase 4 direct-bind
 * behavior, which the rest of the test suite already covers).
 *
 * Each test triggers a failed login under a unique username so the
 * resulting `audit_log` row is uniquely addressable by
 * `metadata.username`. Asserts `audit_log.ip` matches the expected
 * resolved client IP for each XFF / connection-IP combination
 * documented on `proxy.rs`.
 *
 * Skipping on Deno mirrors the precedent set by `rate_limit_tests.ts`
 * — fuz_app has its own `http/proxy.test.ts` exercising the TS port
 * at the unit-test layer (87 cases), so cross-backend integration
 * coverage isn't where we'd catch a TS regression.
 */

import {type BackendConfig} from './config.ts';
import {assert_equal, wait_for_audit_row} from './test_helpers.ts';
import type {TestResult} from './tests.ts';

interface LoginAuditRow {
	event_type: string;
	outcome: string;
	ip: string | null;
	metadata: {username?: string} | null;
}

/**
 * Wait for the most recent login-failure audit row whose
 * `metadata.username` matches the given test-scoped name. Encoding
 * the username makes each row uniquely addressable so concurrent /
 * earlier login attempts in the suite don't pollute the assertion.
 */
const wait_for_login_failure_audit = async (
	username: string,
): Promise<LoginAuditRow> => {
	const escaped = username.replace(/'/g, "''");
	const sql = `
		SELECT row_to_json(t) FROM (
			SELECT event_type, outcome, ip, metadata
			FROM audit_log
			WHERE event_type = 'login'
			  AND outcome = 'failure'
			  AND metadata->>'username' = '${escaped}'
			ORDER BY seq DESC
			LIMIT 1
		) t;
	`;
	return wait_for_audit_row<LoginAuditRow>(sql);
};

/**
 * Make a failed login attempt at `${base_url}/api/account/login`
 * with optional `X-Forwarded-For`. Always uses a deliberately wrong
 * password so the request reaches the failure-audit emit site
 * unconditionally (independent of whether the username matches a
 * real account — the audit row writes either way).
 */
const failed_login = async (
	config: BackendConfig,
	username: string,
	forwarded_for: string | null,
): Promise<void> => {
	const paths = config.account_paths;
	if (!paths) throw new Error('account_paths not configured');
	const headers: Record<string, string> = {'Content-Type': 'application/json'};
	if (forwarded_for !== null) {
		headers['X-Forwarded-For'] = forwarded_for;
	}
	const res = await fetch(`${config.base_url}${paths.login}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({username, password: 'proxy-test-wrong-pw'}),
	});
	if (res.status !== 401) {
		// Drain body so the connection releases cleanly even on the
		// unexpected-status path (otherwise leaked socket trips the
		// next test).
		await res.text();
		throw new Error(`expected 401 on failed login, got ${res.status}`);
	}
	await res.text();
};

type TestFn = (config: BackendConfig) => Promise<void>;

/**
 * Each test uses a unique username (kebab-case + random suffix) so
 * audit rows are uniquely addressable. The randomness defends against
 * residual rows from prior runs of the same suite within a single test
 * database lifetime.
 */
const unique_username = (label: string): string =>
	`proxy-test-${label}-${crypto.randomUUID().slice(0, 8)}`;

const proxy_test_list: ReadonlyArray<{
	name: string;
	fn: TestFn;
	skip?: readonly string[];
}> = [
	{
		// No XFF header — middleware uses the TCP peer (loopback). The
		// integration runner always binds the backend to 127.0.0.1.
		name: 'proxy_no_xff_uses_connection_ip',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('no-xff');
			await failed_login(config, username, null);
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '127.0.0.1', 'audit.ip = connection IP');
		},
	},
	{
		// XFF present + connection from trusted proxy (loopback is
		// configured in ZZZ_TRUSTED_PROXIES for this phase) → resolved
		// to the rightmost-first untrusted entry.
		name: 'proxy_trusted_xff_resolves_to_originator',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('trusted');
			await failed_login(config, username, '203.0.113.1');
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '203.0.113.1', 'audit.ip = XFF originator');
		},
	},
	{
		// Multi-hop chain: client → some-other-proxy (untrusted) →
		// 127.0.0.1 (trusted). Walking right-to-left: skip the trusted
		// loopback, stop at the first untrusted entry.
		name: 'proxy_multi_hop_stops_at_first_untrusted',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('multi-hop');
			await failed_login(config, username, '203.0.113.1, 198.51.100.7, 127.0.0.1');
			const row = await wait_for_login_failure_audit(username);
			// 127.0.0.1 (trusted, skip) → 198.51.100.7 (untrusted) → stop
			assert_equal(row.ip, '198.51.100.7', 'audit.ip = first untrusted from right');
		},
	},
	{
		// Malformed XFF entry between client and trusted proxy.
		// `attacker-controlled` fails strict validation and gets
		// skipped during the right-to-left walk so an attacker can't
		// rotate garbage as a fresh rate-limit-key.
		name: 'proxy_malformed_xff_entry_skipped',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('malformed');
			await failed_login(config, username, 'attacker-controlled, 203.0.113.1');
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '203.0.113.1', 'audit.ip skips malformed entry');
		},
	},
	{
		// Every XFF entry is trusted (loopback in this phase's config).
		// `resolve_client_ip` falls through to the leftmost
		// strictly-valid entry, which is itself the trusted proxy IP —
		// likely a misconfiguration in production, but defined behavior
		// so the bucket has a stable key.
		name: 'proxy_all_trusted_xff_falls_back_to_leftmost',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('all-trusted');
			await failed_login(config, username, '127.0.0.1');
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '127.0.0.1', 'audit.ip = leftmost trusted entry');
		},
	},
	{
		// Empty XFF header — TS treats it as falsy ("no header" branch).
		// Rust's match used to fall into the trusted-XFF arm with
		// `resolve_client_ip("")` returning `None` and spuriously
		// emitting the "all XFF entries trusted" warn. The empty-string
		// guard short-circuits to the connection IP without the warn.
		// Resolved value matches `proxy_no_xff_uses_connection_ip`; the
		// test exists to lock the empty-string code path.
		name: 'proxy_empty_xff_uses_connection_ip',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('empty-xff');
			await failed_login(config, username, '');
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '127.0.0.1', 'audit.ip = connection IP on empty XFF');
		},
	},
	{
		// IPv6 originator — Rust's `IpAddr::from_str` is stricter than
		// the JS helpers fuz_app guards against, so this exercises the
		// "Rust handles real IPv6 in XFF the same way TS does" parity
		// claim end-to-end.
		name: 'proxy_ipv6_originator_in_xff',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('v6-origin');
			await failed_login(config, username, '2001:db8::1, 127.0.0.1');
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '2001:db8::1', 'audit.ip = IPv6 originator');
		},
	},
	{
		// IPv4-mapped IPv6 in XFF must normalize to plain IPv4 before
		// landing in the audit row. Otherwise downstream consumers
		// (rate-limit keys, audit-row joins) see `::ffff:203.0.113.1`
		// and `203.0.113.1` as distinct identities for the same client.
		name: 'proxy_ipv4_mapped_xff_normalizes',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('v4-mapped');
			await failed_login(config, username, '::ffff:203.0.113.1, 127.0.0.1');
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '203.0.113.1', 'audit.ip = normalized IPv4-mapped form');
		},
	},
	{
		// Tighter multi-hop: malformed entry between client and trusted
		// proxy must not short-circuit the walk to the trusted entry,
		// and the malformed entry must not surface as the client IP
		// (rate-limit-key poisoning defense). The fuz_app unit tests
		// cover this; locking it at the integration layer too is cheap
		// insurance against a future ConnectInfo / middleware-ordering
		// regression that would skip the right-to-left walk entirely.
		name: 'proxy_multi_hop_with_malformed_then_untrusted',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('mixed');
			await failed_login(
				config,
				username,
				'198.51.100.7, attacker-controlled, 127.0.0.1',
			);
			const row = await wait_for_login_failure_audit(username);
			// 127.0.0.1 (trusted, skip) → attacker-controlled (malformed, skip)
			// → 198.51.100.7 (valid, untrusted) → stop.
			assert_equal(row.ip, '198.51.100.7', 'audit.ip skips malformed and stops at first valid untrusted');
		},
	},
	{
		// End-to-end rate-limit-key poisoning defense: an attacker who
		// can write XFF must NOT be able to rotate arbitrary strings as
		// the audit / rate-limit key. With every entry malformed,
		// `resolve_client_ip` returns `None` (right-to-left walk skips
		// all; leftmost-strictly-valid fallback finds nothing), and the
		// middleware silently falls back to the connection IP. The
		// surface this locks is the all-malformed shape — the
		// `proxy_malformed_xff_entry_skipped` test only covers
		// malformed-between-valid (which still has a valid entry to
		// return); this test exercises the case where the resolver
		// returns `None` and the middleware path matters.
		name: 'proxy_all_malformed_xff_falls_back_to_connection_ip',
		skip: ['deno'],
		fn: async (config) => {
			const username = unique_username('all-malformed');
			await failed_login(config, username, 'attacker-rotation-a, attacker-rotation-b');
			const row = await wait_for_login_failure_audit(username);
			assert_equal(row.ip, '127.0.0.1', 'audit.ip = connection IP on all-malformed XFF');
		},
	},
];

export const run_proxy_tests = async (
	config: BackendConfig,
	filter?: string,
): Promise<TestResult[]> => {
	const results: TestResult[] = [];

	if (!config.account_paths) {
		return results;
	}

	for (const test of proxy_test_list) {
		if (filter && !test.name.includes(filter)) continue;
		if (test.skip?.includes(config.name)) continue;
		const start = performance.now();
		try {
			await test.fn(config);
			results.push({name: test.name, passed: true, duration_ms: performance.now() - start});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			results.push({
				name: test.name,
				passed: false,
				duration_ms: performance.now() - start,
				error: message,
			});
		}
	}

	return results;
};
