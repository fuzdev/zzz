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

import {type BackendConfig} from './config.ts';
import {assert_equal, post_rpc, wait_for_audit_row} from './test_helpers.ts';
import type {TestResult} from './tests.ts';

/** POST JSON to an account route. */
const post_account = async (
	config: BackendConfig,
	path: string,
	body: unknown,
	options?: {cookie?: string; origin?: string},
): Promise<{status: number; body: unknown; set_cookies: string[]}> => {
	const headers: Record<string, string> = {'Content-Type': 'application/json'};
	if (options?.cookie) headers.Cookie = options.cookie;
	if (options?.origin !== undefined) headers.Origin = options.origin;
	const res = await fetch(`${config.base_url}${path}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	const json = await res.json();
	const set_cookies = res.headers.getSetCookie();
	return {status: res.status, body: json, set_cookies};
};

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
		// Origin-allowlist enforcement on the REST account routes. Both
		// backends configure an origin allowlist of `http://localhost:*`
		// in the integration runner (Deno via `FUZ_ALLOWED_ORIGINS`, Rust via
		// `ZZZ_ALLOWED_ORIGINS`); a request with an Origin header outside
		// that allowlist must 403 before any auth / argon2 work. No
		// Origin header (the default for Deno's `fetch` on server-side
		// calls) stays accepted — that's the curl / CLI path.
		name: 'login_forbidden_origin',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');
			const {status, body} = await post_account(
				config,
				paths.login,
				{
					username: config.auth!.username,
					password: config.auth!.password,
				},
				{origin: 'https://evil.example.com'},
			);
			assert_equal(status, 403, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.error, 'forbidden_origin', 'error');
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
		// Verify-write race: two concurrent password changes against the same
		// starting hash. fuz_app's `query_update_account_password` and (now)
		// Rust's `query_update_password` key the UPDATE on the verified hash,
		// so the loser's UPDATE matches zero rows. Loser returns 401 + emits
		// a `password_change` failure audit row with
		// `metadata.reason === 'concurrent_change'`.
		name: 'password_change_concurrent_change',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			// Two distinct sessions on the same account — concurrent requests
			// from a single cookie would serialize on the connection's request
			// queue, hiding the race we want to test.
			const login_a = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_a.status, 200, 'login A status');
			const cookie_a = login_a.set_cookies.map((c) => c.split(';')[0]).join('; ');

			const login_b = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_b.status, 200, 'login B status');
			const cookie_b = login_b.set_cookies.map((c) => c.split(';')[0]).join('; ');

			// Fire both password changes in parallel against the same
			// `current_password`. Argon2id verify is ~100ms — easily wide
			// enough for both to verify before either commits the UPDATE.
			const new_a = 'concurrent-change-A-new-pw-123';
			const new_b = 'concurrent-change-B-new-pw-456';
			const [res_a, res_b] = await Promise.all([
				post_account(
					config,
					paths.password,
					{current_password: config.auth!.password, new_password: new_a},
					{cookie: cookie_a},
				),
				post_account(
					config,
					paths.password,
					{current_password: config.auth!.password, new_password: new_b},
					{cookie: cookie_b},
				),
			]);

			// Exactly one 200, exactly one 401.
			const statuses = [res_a.status, res_b.status].sort();
			assert_equal(statuses[0], 200, 'one request succeeds');
			assert_equal(statuses[1], 401, 'other request fails with 401');

			// Failure row carries metadata.reason === 'concurrent_change'.
			const sql = `
				SELECT row_to_json(t) FROM (
					SELECT metadata
					FROM audit_log
					WHERE event_type = 'password_change'
					  AND outcome = 'failure'
					  AND metadata->>'reason' = 'concurrent_change'
					ORDER BY seq DESC
					LIMIT 1
				) t;
			`;
			const row = await wait_for_audit_row<{
				metadata: {reason: string; credential_type: string};
			}>(sql);
			assert_equal(row.metadata.reason, 'concurrent_change', 'metadata.reason');
			assert_equal(row.metadata.credential_type, 'session', 'metadata.credential_type');

			// Restore the canonical password. Whichever password won, log
			// in with it and rotate back to the bootstrap value.
			const winning_password = res_a.status === 200 ? new_a : new_b;
			const restore_login = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: winning_password,
			});
			assert_equal(restore_login.status, 200, 'restore login status');
			const restore_cookie = restore_login.set_cookies
				.map((c) => c.split(';')[0])
				.join('; ');
			const restore_res = await post_account(
				config,
				paths.password,
				{
					current_password: winning_password,
					new_password: config.auth!.password,
				},
				{cookie: restore_cookie},
			);
			assert_equal(restore_res.status, 200, 'password restore status');
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

			// List sessions via fuz_app's account_session_list RPC action
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sl-1', method: 'account_session_list'}),
				{cookie},
			);
			assert_equal(status, 200, 'status');
			const rpc = body as Record<string, unknown>;
			const result = rpc.result as Record<string, unknown>;
			const sessions = result.sessions as Array<Record<string, unknown>>;
			assert_equal(Array.isArray(sessions), true, 'sessions is array');
			assert_equal(sessions.length > 0, true, 'at least one session');
			// Check session shape (matches fuz_app AuthSessionJson)
			const s = sessions[0]!;
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

			// List sessions from cookie1 via RPC
			const list_res = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sr-list', method: 'account_session_list'}),
				{cookie: cookie1},
			);
			const list_result = (list_res.body as Record<string, unknown>).result as Record<
				string,
				unknown
			>;
			const sessions = list_result.sessions as Array<Record<string, unknown>>;
			assert_equal(sessions.length >= 2, true, 'at least 2 sessions');

			// Revoke the first session in the list and verify the other still works
			const session_to_revoke = sessions[0]!;
			const revoke_res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'sr-revoke',
					method: 'account_session_revoke',
					params: {session_id: session_to_revoke.id as string},
				}),
				{cookie: cookie1},
			);
			assert_equal(revoke_res.status, 200, 'revoke status');
			const rr = (revoke_res.body as Record<string, unknown>).result as Record<string, unknown>;
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
	{
		name: 'account_verify',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const login_res = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_res.status, 200, 'login status');
			const cookie = login_res.set_cookies.map((c) => c.split(';')[0]).join('; ');

			const {status, body} = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'av-1', method: 'account_verify'}),
				{cookie},
			);
			assert_equal(status, 200, 'status');
			const rpc = body as Record<string, unknown>;
			const result = rpc.result as Record<string, unknown>;
			assert_equal(typeof result.id, 'string', 'id is string');
			assert_equal(result.username, config.auth!.username, 'username matches');
			assert_equal('email' in result, true, 'email field present');
			assert_equal(typeof result.email_verified, 'boolean', 'email_verified is boolean');
			assert_equal(typeof result.created_at, 'string', 'created_at is string');
			// Sensitive fields must NOT be in the response
			assert_equal(
				'password_hash' in result,
				false,
				'password_hash MUST NOT be in verify response',
			);
		},
	},
	{
		name: 'session_revoke_all',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			// Login twice — two distinct sessions
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

			// Both cookies should ping successfully before revoke_all
			const pre1 = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sra-pre1', method: 'ping'}),
				{cookie: cookie1},
			);
			assert_equal(pre1.status, 200, 'cookie1 works pre-revoke');
			const pre2 = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sra-pre2', method: 'ping'}),
				{cookie: cookie2},
			);
			assert_equal(pre2.status, 200, 'cookie2 works pre-revoke');

			// revoke_all from cookie1
			const revoke_res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'sra-revoke',
					method: 'account_session_revoke_all',
				}),
				{cookie: cookie1},
			);
			assert_equal(revoke_res.status, 200, 'revoke_all status');
			const rr = (revoke_res.body as Record<string, unknown>).result as Record<
				string,
				unknown
			>;
			assert_equal(rr.ok, true, 'revoke_all ok');
			assert_equal(typeof rr.count, 'number', 'count is number');
			assert_equal((rr.count as number) >= 2, true, 'count >= 2');

			// Both cookies should now fail authenticated requests
			const post1 = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sra-post1', method: 'workspace_list'}),
				{cookie: cookie1},
			);
			assert_equal(post1.status, 401, 'cookie1 fails after revoke_all');
			const post2 = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'sra-post2', method: 'workspace_list'}),
				{cookie: cookie2},
			);
			assert_equal(post2.status, 401, 'cookie2 fails after revoke_all');
		},
	},
	{
		name: 'token_create',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const login_res = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_res.status, 200, 'login status');
			const cookie = login_res.set_cookies.map((c) => c.split(';')[0]).join('; ');

			const create_res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'tc-1',
					method: 'account_token_create',
					params: {name: 'integration-test-token'},
				}),
				{cookie},
			);
			assert_equal(create_res.status, 200, 'create status');
			const cr = (create_res.body as Record<string, unknown>).result as Record<
				string,
				unknown
			>;
			assert_equal(cr.ok, true, 'create ok');
			const raw_token = cr.token as string;
			const id = cr.id as string;
			assert_equal(typeof raw_token, 'string', 'token is string');
			assert_equal(raw_token.startsWith('secret_fuz_token_'), true, 'token prefix');
			assert_equal(typeof id, 'string', 'id is string');
			assert_equal(/^tok_[A-Za-z0-9_-]{12}$/.test(id), true, `id format: ${id}`);
			assert_equal(cr.name, 'integration-test-token', 'name echoed');

			// Round-trip: the raw token must validate as a bearer credential
			const ping = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'tc-bearer', method: 'ping'}),
				{bearer: raw_token},
			);
			assert_equal(ping.status, 200, 'bearer round-trip ping');
			const pr = ping.body as Record<string, unknown>;
			assert_equal(pr.jsonrpc, '2.0', 'bearer ping jsonrpc');
			const ping_result = pr.result as Record<string, unknown>;
			assert_equal(ping_result.ping_id, 'tc-bearer', 'bearer ping_id');

			// Cleanup — revoke the token so list_tokens doesn't accumulate across runs
			await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'tc-cleanup',
					method: 'account_token_revoke',
					params: {token_id: id},
				}),
				{cookie},
			);
		},
	},
	{
		name: 'token_list',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const login_res = await post_account(config, paths.login, {
				username: config.auth!.username,
				password: config.auth!.password,
			});
			assert_equal(login_res.status, 200, 'login status');
			const cookie = login_res.set_cookies.map((c) => c.split(';')[0]).join('; ');

			// Create a token to ensure the list is non-empty
			const create_res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'tl-create',
					method: 'account_token_create',
					params: {name: 'integration-test-list-token'},
				}),
				{cookie},
			);
			assert_equal(create_res.status, 200, 'pre-create status');
			const created_id = (
				(create_res.body as Record<string, unknown>).result as Record<string, unknown>
			).id as string;

			const list_res = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'tl-1', method: 'account_token_list'}),
				{cookie},
			);
			assert_equal(list_res.status, 200, 'list status');
			const lr = (list_res.body as Record<string, unknown>).result as Record<
				string,
				unknown
			>;
			const tokens = lr.tokens as Array<Record<string, unknown>>;
			assert_equal(Array.isArray(tokens), true, 'tokens is array');
			assert_equal(tokens.length > 0, true, 'at least one token');

			const created = tokens.find((t) => t.id === created_id);
			assert_equal(created !== undefined, true, 'created token in list');
			assert_equal(typeof created!.id, 'string', 'token id is string');
			assert_equal(typeof created!.account_id, 'string', 'account_id is string');
			assert_equal(created!.name, 'integration-test-list-token', 'name matches');
			assert_equal('expires_at' in created!, true, 'expires_at present');
			assert_equal('last_used_at' in created!, true, 'last_used_at present');
			assert_equal('last_used_ip' in created!, true, 'last_used_ip present');
			assert_equal(typeof created!.created_at, 'string', 'created_at is string');

			// CRITICAL: no token_hash field anywhere in the list
			for (const t of tokens) {
				assert_equal(
					'token_hash' in t,
					false,
					`token_hash MUST NOT be in list response (token ${t.id})`,
				);
			}

			// Cleanup
			await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'tl-cleanup',
					method: 'account_token_revoke',
					params: {token_id: created_id},
				}),
				{cookie},
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
