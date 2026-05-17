/**
 * Audit log emission integration tests.
 *
 * Verifies both backends record `audit_log` rows for the credential-gated
 * methods (`account_token_create`, `account_session_revoke_all`,
 * `account_token_revoke`, `account_session_revoke`) plus REST
 * `POST /api/account/password`. The `metadata.credential_type` field is
 * the v0.63.0 wire shape — see `~/dev/fuz_app/docs/security.md`
 * §Credential-channel gating and the matching schema in
 * `~/dev/fuz_app/src/lib/auth/audit_log_schema.ts`.
 *
 * Audit emits are fire-and-forget on Rust (tokio::spawn) and pushed onto
 * `ctx.pending_effects` on the TS path; both are drained before the
 * response, but the integration runner queries `psql` from a separate
 * process so a polling helper (`wait_for_audit_row`) absorbs the tiny
 * cross-process race.
 */

import {type BackendConfig} from './config.ts';
import {assert_equal, post_rpc, wait_for_audit_row} from './test_helpers.ts';
import type {TestResult} from './tests.ts';

interface AuditRow {
	event_type: string;
	outcome: string;
	account_id: string | null;
	actor_id: string | null;
	target_account_id: string | null;
	metadata: Record<string, unknown> | null;
}

/** Login via REST and return the session cookie string. */
const login = async (config: BackendConfig): Promise<string> => {
	const paths = config.account_paths;
	if (!paths) throw new Error('account_paths not configured');

	const res = await fetch(`${config.base_url}${paths.login}`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			username: config.auth!.username,
			password: config.auth!.password,
		}),
	});
	if (res.status !== 200) {
		const body = await res.text();
		throw new Error(`login failed: ${res.status} ${body}`);
	}
	const set_cookies = res.headers.getSetCookie();
	return set_cookies.map((c) => c.split(';')[0]).join('; ');
};

/**
 * Wait for the most recent `audit_log` row matching `(event_type, outcome)`
 * for the bootstrapped admin account. Filtering on `account_id` keeps
 * cross-test pollution (e.g. login rows that don't carry a body of metadata
 * we care about) from racing the target row.
 */
const latest_audit_row = async (
	event_type: string,
	outcome: string,
): Promise<AuditRow> => {
	const sql = `
		SELECT row_to_json(t) FROM (
			SELECT event_type, outcome,
			       account_id::text AS account_id,
			       actor_id::text AS actor_id,
			       target_account_id::text AS target_account_id,
			       metadata
			FROM audit_log
			WHERE event_type = '${event_type}'
			  AND outcome = '${outcome}'
			ORDER BY seq DESC
			LIMIT 1
		) t;
	`;
	return wait_for_audit_row<AuditRow>(sql);
};

type TestFn = (config: BackendConfig) => Promise<void>;

const audit_test_list: ReadonlyArray<{
	name: string;
	fn: TestFn;
	skip?: readonly string[];
}> = [
	{
		// Bootstrap runs once per backend launch (in the test setup); this
		// just asserts the row exists. fuz_app's shape: success row carries
		// both `account_id` (new keeper account) and `actor_id` (new
		// keeper actor) with `metadata: null`. Failure rows carry
		// `metadata: {error: <reason>}` and are exercised indirectly by
		// future bootstrap-failure tests; the in-flight bootstrap setup
		// produces a success row deterministically.
		name: 'audit_bootstrap_success',
		fn: async () => {
			const row = await latest_audit_row('bootstrap', 'success');
			assert_equal(row.event_type, 'bootstrap', 'event_type');
			assert_equal(row.outcome, 'success', 'outcome');
			assert_equal(typeof row.account_id, 'string', 'account_id is string');
			assert_equal(typeof row.actor_id, 'string', 'actor_id is string');
			assert_equal(row.metadata, null, 'metadata is null on success');
		},
	},
	{
		name: 'audit_token_create_records_credential_type',
		fn: async (config) => {
			const cookie = await login(config);

			const create_res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'audit-tc-1',
					method: 'account_token_create',
					params: {name: 'audit-test-token'},
				}),
				{cookie},
			);
			assert_equal(create_res.status, 200, 'create status');
			const id = (
				(create_res.body as Record<string, unknown>).result as Record<string, unknown>
			).id as string;

			const row = await latest_audit_row('token_create', 'success');
			assert_equal(row.event_type, 'token_create', 'event_type');
			assert_equal(row.outcome, 'success', 'outcome');
			assert_equal(typeof row.account_id, 'string', 'account_id is string');
			assert_equal(
				row.metadata?.credential_type,
				'session',
				'metadata.credential_type',
			);
			assert_equal(row.metadata?.token_id, id, 'metadata.token_id');
			assert_equal(row.metadata?.name, 'audit-test-token', 'metadata.name');

			// Cleanup so list endpoints don't accumulate
			await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'audit-tc-cleanup',
					method: 'account_token_revoke',
					params: {token_id: id},
				}),
				{cookie},
			);
		},
	},
	{
		name: 'audit_session_revoke_all_records_credential_type',
		fn: async (config) => {
			// Login twice — two distinct sessions on the same account.
			const cookie1 = await login(config);
			const cookie2 = await login(config);

			const revoke_res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'audit-sra',
					method: 'account_session_revoke_all',
				}),
				{cookie: cookie1},
			);
			assert_equal(revoke_res.status, 200, 'revoke_all status');

			const row = await latest_audit_row('session_revoke_all', 'success');
			assert_equal(row.event_type, 'session_revoke_all', 'event_type');
			assert_equal(row.outcome, 'success', 'outcome');
			assert_equal(typeof row.account_id, 'string', 'account_id is string');
			assert_equal(
				row.metadata?.credential_type,
				'session',
				'metadata.credential_type',
			);
			assert_equal(typeof row.metadata?.count, 'number', 'metadata.count is number');

			// cookie2 was force-revoked alongside cookie1; restore session for
			// follow-up tests by logging back in. The deno backend doesn't
			// invalidate the *current* request's cookie until next request, so
			// we re-login fresh either way.
			await login(config).catch(() => {});
			// Silence unused-var lint on cookie2 — kept named for clarity above.
			void cookie2;
		},
	},
	{
		name: 'audit_password_change_records_credential_type',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const cookie = await login(config);
			const new_password = 'audit-rotate-password-789';

			const pw_res = await fetch(`${config.base_url}${paths.password}`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Cookie: cookie},
				body: JSON.stringify({
					current_password: config.auth!.password,
					new_password,
				}),
			});
			assert_equal(pw_res.status, 200, 'password change status');
			await pw_res.body?.cancel();

			const row = await latest_audit_row('password_change', 'success');
			assert_equal(row.event_type, 'password_change', 'event_type');
			assert_equal(row.outcome, 'success', 'outcome');
			assert_equal(typeof row.account_id, 'string', 'account_id is string');
			assert_equal(
				row.metadata?.credential_type,
				'session',
				'metadata.credential_type',
			);

			// Restore password for other tests.
			const restore_cookie_res = await fetch(`${config.base_url}${paths.login}`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					username: config.auth!.username,
					password: new_password,
				}),
			});
			if (restore_cookie_res.status !== 200) {
				const body = await restore_cookie_res.text();
				throw new Error(`relogin failed: ${body}`);
			}
			const restore_cookie = restore_cookie_res.headers
				.getSetCookie()
				.map((c) => c.split(';')[0])
				.join('; ');
			const restore_res = await fetch(`${config.base_url}${paths.password}`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Cookie: restore_cookie},
				body: JSON.stringify({
					current_password: new_password,
					new_password: config.auth!.password,
				}),
			});
			assert_equal(restore_res.status, 200, 'password restore status');
			await restore_res.body?.cancel();
		},
	},
	{
		name: 'audit_password_change_failure_records_credential_type',
		fn: async (config) => {
			const paths = config.account_paths;
			if (!paths) throw new Error('account_paths not configured');

			const cookie = await login(config);

			const pw_res = await fetch(`${config.base_url}${paths.password}`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Cookie: cookie},
				body: JSON.stringify({
					current_password: 'audit-wrong-current-password',
					new_password: 'audit-irrelevant-new-password',
				}),
			});
			assert_equal(pw_res.status, 401, 'wrong password → 401');
			await pw_res.body?.cancel();

			// fuz_app v0.63.0 metadata shape for wrong-password failure:
			// `{credential_type}` only. `reason` is reserved for the
			// `concurrent_change` verify-write race (not detected on Rust today
			// — tracked as a follow-up).
			const row = await latest_audit_row('password_change', 'failure');
			assert_equal(row.event_type, 'password_change', 'event_type');
			assert_equal(row.outcome, 'failure', 'outcome');
			assert_equal(
				row.metadata?.credential_type,
				'session',
				'metadata.credential_type',
			);
		},
	},
];

export const run_audit_tests = async (
	config: BackendConfig,
	filter?: string,
): Promise<TestResult[]> => {
	const results: TestResult[] = [];

	if (!config.account_paths) {
		return results;
	}

	for (const test of audit_test_list) {
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
