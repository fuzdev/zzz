/**
 * Trusted-proxy + client IP resolution cross-process tests (Rust-only).
 *
 * Exercises Rust's `proxy::client_ip_middleware` behind
 * `ZZZ_TRUSTED_PROXIES=127.0.0.1`.
 *
 * **Wiring constraint** — this suite must run against a Rust backend
 * spawned with `ZZZ_TRUSTED_PROXIES=127.0.0.1` in its environment. The
 * vitest config wires this as its own project (`cross_backend_rust_proxy`),
 * whose global setup boots `rust_proxy_backend_config`; other
 * cross-backend suites continue to use the trusted-proxy-less
 * `cross_backend_rust` project so their tests aren't influenced by the
 * middleware (which collapses every connection IP to the resolved
 * client IP). Without the trusted-proxy env var the Rust middleware
 * would always return the TCP peer IP and every test here would
 * collapse to the same assertion.
 *
 * These tests need the backend booted with a trusted-proxy list, so they
 * live in a dedicated project rather than gating with
 * `test_if(capabilities.trusted_proxy, ...)` — keeping the backend env
 * trusted-proxy-free for the rest of the suite.
 *
 * **Audit-read pattern** — each test fires a `/login` 401 under a unique
 * `proxy-test-<label>-<uuid>` username, with crafted `X-Forwarded-For`
 * headers, then reads the resulting `audit_log` row's `ip` through
 * `list_audit_events`: `_testing_drain_effects` awaits the backend's
 * fire-and-forget audit write, then `audit_log_list` runs as the fixture's
 * keeper, which holds the admin role it needs.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';

import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import {
	default_cross_process_setup,
	type ReconstructedBootstrappedBackendHandle,
	type TestFixture
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { list_audit_events } from '@fuzdev/fuz_app/testing/cross_backend/audit_cross_helpers.ts';

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
 * The resolved `ip` of the `login` / `failure` audit row whose
 * `metadata.username` is the test-scoped username (`null` if the column is
 * null). `list_audit_events` drains the backend's detached audit writes
 * first, so the row is there once the login has answered.
 */
const read_login_failure_ip = async (
	fixture: TestFixture,
	username: string
): Promise<string | null> => {
	const events = await list_audit_events(fixture, { event_type: 'login', outcome: 'failure' });
	const matching = events.filter((e) => e.metadata?.username === username);
	assert.strictEqual(matching.length, 1, `one login failure row for ${username}`);
	return matching[0]!.ip;
};

/**
 * Build a unique test-scoped username, so each test's username filter
 * matches exactly one row.
 */
const unique_username = (label: string): string =>
	`proxy-test-${label}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Run one trusted-proxy assertion: fire a failed login with the given
 * XFF header, read the audit row, assert the resolved IP. Wraps
 * the shared pattern so the per-test body is one call.
 */
const assert_resolved_ip = async (
	handle: ReconstructedBootstrappedBackendHandle,
	label: string,
	xff: string | null,
	expected_ip: string,
	message: string
): Promise<void> => {
	const fixture = await setup_test();
	const username = unique_username(label);
	await fire_failed_login(handle, username, xff);
	const resolved_ip = await read_login_failure_ip(fixture, username);
	assert.strictEqual(resolved_ip, expected_ip, message);
};

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

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

	// Malformed entry left of the client IP. The right-to-left walk returns
	// the first untrusted entry, `203.0.113.1`, before it reaches
	// `attacker-controlled`, so an entry past the stopping point never
	// affects the result, malformed or not.
	test('proxy_malformed_entry_left_of_untrusted_never_reached', async () => {
		await assert_resolved_ip(
			handle,
			'malformed-unreached',
			'attacker-controlled, 203.0.113.1',
			'203.0.113.1',
			'audit.ip = first untrusted from right; malformed entry left of it unread'
		);
	});

	// Every XFF entry is trusted (loopback). `resolve_client_ip` falls through
	// to the leftmost entry (every entry passed strict validation to get
	// there), which is itself the trusted proxy IP — likely a misconfiguration
	// in production, but defined behavior so the bucket has a stable key.
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

	// Malformed entry between a client-written entry and the trusted proxy:
	// the walk stops at the malformed entry, and the middleware keys the
	// request on the connection IP. 127.0.0.1 (trusted, skip) →
	// attacker-controlled (malformed, stop → none) → connection IP. The
	// malformed entry must not surface as the client IP (rate-limit-key
	// poisoning), and the walk must not continue into `198.51.100.7`, which
	// no trusted hop vouched for — a client could otherwise pick its own
	// bucket behind a proxy that appends a non-bare-IP token.
	test('proxy_multi_hop_stops_at_malformed_uses_connection_ip', async () => {
		await assert_resolved_ip(
			handle,
			'stops-at-malformed',
			'198.51.100.7, attacker-controlled, 127.0.0.1',
			'127.0.0.1',
			'audit.ip = connection IP; walk stops at malformed, never reaches the client-written entry'
		);
	});

	// End-to-end rate-limit-key poisoning defense: with every entry
	// malformed, the right-to-left walk stops at the rightmost entry,
	// `resolve_client_ip` returns `None`, and the middleware falls back to
	// the connection IP. Unlike `_stops_at_malformed_uses_connection_ip`, no
	// trusted hop is skipped first — the stop is the walk's first step.
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
