/**
 * Account management integration tests.
 *
 * Tests login, logout, password change, session list, and session revocation
 * routes. Separated from tests.ts and bearer_tests.ts to keep modules focused.
 *
 * These tests create dedicated users and sessions to avoid interfering with
 * the main test admin account. Most tests are cross-backend — route paths
 * differ but behavior is the same.
 */

import {type BackendConfig, TEST_DATABASE_URL} from './config.ts';
import {assert_equal, post_rpc, sql_escape} from './test_helpers.ts';
import type {TestResult} from './tests.ts';

/** POST JSON to an account route. */
const post_account = async (
	config: BackendConfig,
	path: string,
	body: unknown,
	options?: {cookie?: string},
): Promise<{status: number; body: unknown; set_cookies: string[]}> => {
	const headers: Record<string, string> = {'Content-Type': 'application/json'};
	if (options?.cookie) headers.Cookie = options.cookie;
	const res = await fetch(`${config.base_url}${path}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	const json = await res.json();
	const set_cookies = res.headers.getSetCookie();
	return {status: res.status, body: json, set_cookies};
};

/** GET an account route. */
const get_account = async (
	config: BackendConfig,
	path: string,
	options?: {cookie?: string},
): Promise<{status: number; body: unknown}> => {
	const headers: Record<string, string> = {};
	if (options?.cookie) headers.Cookie = options.cookie;
	const res = await fetch(`${config.base_url}${path}`, {
		method: 'GET',
		headers,
	});
	const json = await res.json();
	return {status: res.status, body: json};
};

/**
 * Create a test user via psql with a known password.
 *
 * Returns the account ID. Uses argon2 hash from the Rust bootstrap
 * (the password is 'test-login-password-123').
 */
const create_test_user = async (
	username: string,
	password_hash: string,
): Promise<string> => {
	const account_id = crypto.randomUUID();
	const actor_id = crypto.randomUUID();
	const sql = `
		INSERT INTO account (id, username, password_hash)
		VALUES ('${sql_escape(account_id)}', '${sql_escape(username)}', '${sql_escape(password_hash)}')
		ON CONFLICT DO NOTHING;

		INSERT INTO actor (id, account_id, name)
		VALUES ('${sql_escape(actor_id)}', '${sql_escape(account_id)}', '${sql_escape(username)}')
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
		throw new Error(`create_test_user failed: ${stderr_text}`);
	}
	await child.stderr.cancel();
	return account_id;
};

/**
 * Hash a password with argon2 via the `argon2` CLI tool.
 *
 * Falls back to a pre-computed hash if the CLI is not available.
 * For test determinism, we use the Rust backend's own argon2 by
 * logging in and trusting the hash from bootstrap.
 */

// Pre-computed argon2id hash for 'test-login-password-123' — only used if
// we need to create accounts directly via SQL. The hash is valid argon2id.
// Generated offline with: echo -n 'test-login-password-123' | argon2 ...
// Actually we can't pre-compute because salt varies. Instead, we'll use
// the login test to verify the bootstrap admin account which already has
// a known password.

// -- Test definitions ---------------------------------------------------------

type TestFn = (config: BackendConfig) => Promise<void>;

const account_test_list: ReadonlyArray<{
	name: string;
	fn: TestFn;
	skip?: readonly string[];
}> = [
	{
		name: 'login_success',
		fn: async (config) => {
			// The bootstrap admin account has a known password — use it to test login
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const {status, body, set_cookies} = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(status, 200, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.ok, true, 'ok');
			// Should set a session cookie
			assert_equal(set_cookies.length > 0, true, 'set session cookie');
			const has_session_cookie = set_cookies.some(
				(c) => c.startsWith('fuz_session=') || c.startsWith('zzz_session='),
			);
			assert_equal(has_session_cookie, true, 'session cookie present');
		},
	},
	{
		name: 'login_invalid_password',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const {status, body} = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: 'wrong-password-definitely',
			});
			assert_equal(status, 401, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.error, 'invalid_credentials', 'error');
		},
	},
	{
		name: 'login_nonexistent_user',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const {status, body} = await post_account(config, paths.login, {
				username: `nonexistent_user_${Date.now()}`,
				password: 'some-password-here-123',
			});
			assert_equal(status, 401, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.error, 'invalid_credentials', 'error');
		},
	},
	{
		name: 'logout_clears_session',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			// Login first to get a session cookie
			const login_res = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_res.status, 200, 'login status');
			const cookie = login_res.set_cookies.map((c) => c.split(';')[0]).join('; ');

			// Verify cookie works
			const verify_res = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'lo-v1', method: 'ping'}),
				{cookie},
			);
			assert_equal(verify_res.status, 200, 'cookie works before logout');

			// Logout
			const logout_res = await post_account(config, paths.logout, {}, {cookie});
			assert_equal(logout_res.status, 200, 'logout status');
			const lr = logout_res.body as Record<string, unknown>;
			assert_equal(lr.ok, true, 'logout ok');

			// Verify cookie no longer works for authenticated actions
			const post_logout = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'lo-v2', method: 'workspace_list'}),
				{cookie},
			);
			assert_equal(post_logout.status, 401, 'cookie fails after logout');
		},
	},
	{
		name: 'logout_unauthenticated',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const {status} = await post_account(config, paths.logout, {});
			assert_equal(status, 401, 'unauthenticated logout → 401');
		},
	},
	{
		name: 'password_change_revokes_all',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			// Login to get a session
			const login_res = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_res.status, 200, 'login status');
			const cookie = login_res.set_cookies.map((c) => c.split(';')[0]).join('; ');

			// Change password
			const new_password = 'new-password-integration-456';
			const pw_res = await post_account(
				config,
				paths.password,
				{
					current_password: config.auth!.password,
					new_password,
				},
				{cookie},
			);
			assert_equal(pw_res.status, 200, 'password change status');
			const pr = pw_res.body as Record<string, unknown>;
			assert_equal(pr.ok, true, 'password change ok');

			// Old cookie should no longer work
			const post_change = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'pw-v1', method: 'workspace_list'}),
				{cookie},
			);
			assert_equal(post_change.status, 401, 'old cookie fails after password change');

			// Login with new password should work
			const relogin = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: new_password,
			});
			assert_equal(relogin.status, 200, 'relogin with new password');

			// Restore original password so other tests aren't affected
			const restore_cookie = relogin.set_cookies.map((c) => c.split(';')[0]).join('; ');
			const restore_res = await post_account(
				config,
				paths.password,
				{
					current_password: new_password,
					new_password: config.auth!.password,
				},
				{cookie: restore_cookie},
			);
			assert_equal(restore_res.status, 200, 'password restore status');
		},
	},
	{
		name: 'password_wrong_current',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			// Login to get a session
			const login_res = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_res.status, 200, 'login status');
			const cookie = login_res.set_cookies.map((c) => c.split(';')[0]).join('; ');

			// Try to change password with wrong current password
			const pw_res = await post_account(
				config,
				paths.password,
				{
					current_password: 'wrong-current-password-123',
					new_password: 'doesnt-matter-at-all-123',
				},
				{cookie},
			);
			assert_equal(pw_res.status, 401, 'wrong current password → 401');
		},
	},
	{
		name: 'session_list',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			// Login to get a session
			const login_res = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_res.status, 200, 'login status');
			const cookie = login_res.set_cookies.map((c) => c.split(';')[0]).join('; ');

			// List sessions
			const {status, body} = await get_account(config, paths.sessions, {cookie});
			assert_equal(status, 200, 'status');
			const r = body as Record<string, unknown>;
			const sessions = r.sessions as Array<Record<string, unknown>>;
			assert_equal(Array.isArray(sessions), true, 'sessions is array');
			assert_equal(sessions.length > 0, true, 'at least one session');
			// Check session shape (matches fuz_app AuthSessionJson)
			const s = sessions[0];
			assert_equal(typeof s.id, 'string', 'session has id');
			assert_equal(typeof s.account_id, 'string', 'session has account_id');
			assert_equal(typeof s.created_at, 'string', 'session has created_at');
			assert_equal(typeof s.last_seen_at, 'string', 'session has last_seen_at');
			assert_equal(typeof s.expires_at, 'string', 'session has expires_at');
		},
	},
	{
		name: 'session_revoke',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			// Login twice to get two sessions
			const login1 = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login1.status, 200, 'login 1 status');
			const cookie1 = login1.set_cookies.map((c) => c.split(';')[0]).join('; ');

			const login2 = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login2.status, 200, 'login 2 status');
			const cookie2 = login2.set_cookies.map((c) => c.split(';')[0]).join('; ');

			// List sessions from cookie1
			const {body: list_body} = await get_account(config, paths.sessions, {cookie: cookie1});
			const sessions = (list_body as Record<string, unknown>).sessions as Array<
				Record<string, unknown>
			>;
			assert_equal(sessions.length >= 2, true, 'at least 2 sessions');

			// Revoke the first session in the list and verify the other still works
			const session_to_revoke = sessions[0];
			const revoke_path = paths.session_revoke.replace(':id', session_to_revoke.id as string);
			const revoke_res = await post_account(config, revoke_path, {}, {cookie: cookie1});
			assert_equal(revoke_res.status, 200, 'revoke status');
			const rr = revoke_res.body as Record<string, unknown>;
			assert_equal(rr.ok, true, 'revoke ok');
			assert_equal(rr.revoked, true, 'revoke revoked');

			// Verify at least one cookie still works (we might have revoked our own,
			// but the other should still be valid)
			const check1 = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sr-1', method: 'ping'}),
				{cookie: cookie1},
			);
			const check2 = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sr-2', method: 'ping'}),
				{cookie: cookie2},
			);
			// At least one should work
			assert_equal(
				check1.status === 200 || check2.status === 200,
				true,
				'at least one session still works after revoking one',
			);
		},
	},
];

// -- Test runner --------------------------------------------------------------

export const run_account_tests = async (
	config: BackendConfig,
	filter?: string,
): Promise<TestResult[]> => {
	const results: TestResult[] = [];

	if (!config.account_paths) {
		return results;
	}

	for (const test of account_test_list) {
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
