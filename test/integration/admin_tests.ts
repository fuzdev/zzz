/**
 * Admin RPC integration tests.
 *
 * Covers `admin_session_revoke_all` and `admin_token_revoke_all`. The Deno
 * reference backend doesn't currently expose admin actions — every test
 * here is Rust-only via `skip: ['deno']`.
 *
 * Mirrors the shape of `audit_tests.ts` (psql for audit-row reads,
 * cross-process race absorbed by `wait_for_audit_row`).
 *
 * Pre-conditions provided by the test runner:
 * - bootstrapped `testadmin` account with `admin` + `keeper` role grants,
 *   surfaced via `session_cookie`.
 * - non-keeper user at account id `00000000-0000-0000-0000-000000000002`
 *   with one active session, surfaced via `non_keeper_cookie`.
 */

import {type BackendConfig} from './config.ts';
import {
	assert_equal,
	hash_token,
	open_ws,
	post_rpc,
	run_psql,
	sql_escape,
	wait_for_audit_row,
} from './test_helpers.ts';
import type {TestResult} from './tests.ts';

/** Hardcoded by `setup_non_keeper_user` in `run.ts`. */
const NON_KEEPER_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';

/** Stable nonexistent UUID for negative-path tests. */
const NONEXISTENT_ACCOUNT_ID = '00000000-0000-0000-0000-0000ffffffff';

interface AuditRow {
	event_type: string;
	outcome: string;
	account_id: string | null;
	target_account_id: string | null;
	metadata: Record<string, unknown> | null;
}

const latest_admin_audit_row = async (
	event_type: string,
	outcome: string,
): Promise<AuditRow> => {
	const sql = `
		SELECT row_to_json(t) FROM (
			SELECT event_type, outcome,
			       account_id::text AS account_id,
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

/**
 * Insert a known api_token for the non-keeper user so `admin_token_revoke_all`
 * has something to delete. Uses the same `id` / hash format as the Rust
 * `generate_api_token`. The raw token is irrelevant — we never authenticate
 * with it, we just need a row with the right account_id.
 */
const seed_non_keeper_token = async (): Promise<void> => {
	const token_hash = hash_token('admin-test-target-token');
	const result = await run_psql(`
		INSERT INTO api_token (id, account_id, name, token_hash)
		VALUES (
			'tok_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}',
			'${NON_KEEPER_ACCOUNT_ID}',
			'admin-test-seed',
			'${sql_escape(token_hash)}'
		)
		ON CONFLICT DO NOTHING;
	`);
	if (!result.ok) throw new Error(`seed_non_keeper_token: ${result.stderr}`);
};

/** Count rows for the target account on a given auth table. */
const count_rows = async (
	table: 'auth_session' | 'api_token',
	account_id: string,
): Promise<number> => {
	const cmd = new Deno.Command('psql', {
		args: [
			Deno.env.get('TEST_DATABASE_URL') ?? 'postgres://localhost/zzz_test',
			'-A',
			'-t',
			'-c',
			`SELECT COUNT(*) FROM ${table} WHERE account_id = '${account_id}';`,
		],
		stdout: 'piped',
		stderr: 'null',
	});
	const out = await cmd.output();
	return parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
};

type TestFn = (
	config: BackendConfig,
	session_cookie: string,
	non_keeper_cookie: string,
) => Promise<void>;

// Test ordering matters here: the *_succeeds_for_target tests destroy the
// non-keeper user's session/tokens, so anything that needs an authenticated
// non-keeper cookie or an existing target session must run first. Order:
//   1. forbidden    (non_keeper_cookie used as caller — must still authenticate)
//   2. unauthenticated (no cookie — touches nothing)
//   3. unknown_404  (touches a nonexistent UUID — doesn't mutate target)
//   4. token_revoke_all_succeeds (touches api_token only — sessions intact)
//   5. session_revoke_all_succeeds_with_ws (final — destroys non-keeper session)
const admin_test_list: ReadonlyArray<{
	name: string;
	fn: TestFn;
	skip?: readonly string[];
}> = [
	{
		name: 'admin_session_revoke_all_forbidden_for_non_admin',
		skip: ['deno'],
		fn: async (config, _session_cookie, non_keeper_cookie) => {
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'asra-forbidden',
					method: 'admin_session_revoke_all',
					params: {account_id: NON_KEEPER_ACCOUNT_ID},
				}),
				{cookie: non_keeper_cookie},
			);
			const error = (res.body as Record<string, unknown>).error as
				| Record<string, unknown>
				| undefined;
			assert_equal(error?.code, -32002, 'error.code = forbidden');
			const data = error?.data as Record<string, unknown> | undefined;
			assert_equal(
				data?.reason,
				'insufficient_permissions',
				'error.data.reason',
			);
			const required = data?.required_roles as string[] | undefined;
			assert_equal(
				JSON.stringify(required),
				JSON.stringify(['admin']),
				'required_roles',
			);
		},
	},
	{
		name: 'admin_session_revoke_all_unauthenticated',
		skip: ['deno'],
		fn: async (config) => {
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'asra-401',
					method: 'admin_session_revoke_all',
					params: {account_id: NON_KEEPER_ACCOUNT_ID},
				}),
			);
			const error = (res.body as Record<string, unknown>).error as
				| Record<string, unknown>
				| undefined;
			assert_equal(error?.code, -32001, 'error.code = unauthenticated');
		},
	},
	{
		name: 'admin_session_revoke_all_unknown_account_404',
		skip: ['deno'],
		fn: async (config, session_cookie) => {
			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'asra-404',
					method: 'admin_session_revoke_all',
					params: {account_id: NONEXISTENT_ACCOUNT_ID},
				}),
				{cookie: session_cookie},
			);
			const error = (res.body as Record<string, unknown>).error as
				| Record<string, unknown>
				| undefined;
			assert_equal(error?.code, -32003, 'error.code = not_found');
			const data = error?.data as Record<string, unknown> | undefined;
			assert_equal(data?.reason, 'account_not_found', 'error.data.reason');

			const row = await latest_admin_audit_row('session_revoke_all', 'failure');
			assert_equal(
				row.target_account_id,
				null,
				'failure target_account_id is null (FK shape)',
			);
			assert_equal(
				row.metadata?.reason,
				'account_not_found',
				'audit metadata.reason',
			);
			assert_equal(
				row.metadata?.attempted_account_id,
				NONEXISTENT_ACCOUNT_ID,
				'audit metadata.attempted_account_id',
			);
		},
	},
	{
		name: 'admin_token_revoke_all_succeeds_for_target',
		skip: ['deno'],
		fn: async (config, session_cookie) => {
			await seed_non_keeper_token();
			const before = await count_rows('api_token', NON_KEEPER_ACCOUNT_ID);
			if (before < 1) throw new Error('expected ≥1 seeded token on target');

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'atra-1',
					method: 'admin_token_revoke_all',
					params: {account_id: NON_KEEPER_ACCOUNT_ID},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const result = (res.body as Record<string, unknown>).result as
				| Record<string, unknown>
				| undefined;
			assert_equal(result?.ok, true, 'result.ok');
			if ((result?.count as number) < before) {
				throw new Error(`count=${result?.count} < pre-existing=${before}`);
			}

			const after = await count_rows('api_token', NON_KEEPER_ACCOUNT_ID);
			assert_equal(after, 0, 'all target tokens deleted');

			const row = await latest_admin_audit_row('token_revoke_all', 'success');
			assert_equal(
				row.target_account_id,
				NON_KEEPER_ACCOUNT_ID,
				'audit target_account_id = target',
			);
			assert_equal(
				typeof row.metadata?.count,
				'number',
				'audit metadata.count is number',
			);
			// Admin emits MUST NOT carry credential_type — reserved for the
			// four credential-gated self-service methods.
			assert_equal(
				row.metadata?.credential_type,
				undefined,
				'admin audit row omits credential_type',
			);
		},
	},
	{
		// Combines the success-revoke and WS-close assertions. Splitting
		// them would require reseeding the non-keeper session between
		// tests; doing it in one pass keeps the runner ordering trivial.
		name: 'admin_session_revoke_all_succeeds_and_closes_ws',
		skip: ['deno'],
		fn: async (config, session_cookie, non_keeper_cookie) => {
			// Open a WS as the target account BEFORE revoking — the
			// handler-side eager `close_sockets_for_account` is the actual
			// revocation guarantee we're verifying.
			const ws = await open_ws(config, {cookie: non_keeper_cookie});
			ws.send(JSON.stringify({jsonrpc: '2.0', id: '_warmup', method: 'ping'}));
			await ws.receive();

			const before = await count_rows('auth_session', NON_KEEPER_ACCOUNT_ID);
			if (before < 1) throw new Error('expected ≥1 seeded session on target');

			const res = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'asra-final',
					method: 'admin_session_revoke_all',
					params: {account_id: NON_KEEPER_ACCOUNT_ID},
				}),
				{cookie: session_cookie},
			);
			assert_equal(res.status, 200, 'status');
			const result = (res.body as Record<string, unknown>).result as
				| Record<string, unknown>
				| undefined;
			assert_equal(result?.ok, true, 'result.ok');
			if ((result?.count as number) < before) {
				throw new Error(`count=${result?.count} < pre-existing=${before}`);
			}

			const after = await count_rows('auth_session', NON_KEEPER_ACCOUNT_ID);
			assert_equal(after, 0, 'all target sessions deleted');

			const closed = await ws.wait_closed();
			assert_equal(closed.code, 4001, 'WS close code = session revoked (4001)');

			const row = await latest_admin_audit_row('session_revoke_all', 'success');
			assert_equal(typeof row.account_id, 'string', 'audit account_id is string');
			assert_equal(
				row.target_account_id,
				NON_KEEPER_ACCOUNT_ID,
				'audit target_account_id = target',
			);
			if (row.account_id === row.target_account_id) {
				throw new Error('audit account_id should be admin, not target');
			}
			assert_equal(
				typeof row.metadata?.count,
				'number',
				'audit metadata.count is number',
			);
			assert_equal(
				row.metadata?.credential_type,
				undefined,
				'admin audit row omits credential_type',
			);
		},
	},
];

/**
 * Login fresh as the bootstrapped admin and return the session cookie.
 *
 * The runner-level `session_cookie` from `setup_auth` is invalidated by
 * earlier `audit_password_change_*` tests that revoke all admin sessions
 * via password change. Each admin-tests invocation does its own login so
 * suite ordering doesn't break us.
 */
const login_admin = async (config: BackendConfig): Promise<string | undefined> => {
	const paths = config.account_paths;
	if (!paths || !config.auth) return undefined;
	const res = await fetch(`${config.base_url}${paths.login}`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			username: config.auth.username,
			password: config.auth.password,
		}),
	});
	if (res.status !== 200) {
		await res.body?.cancel();
		return undefined;
	}
	return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
};

/**
 * Re-seed the non-keeper user's session row. The runner-level
 * `non_keeper_cookie` from `setup_non_keeper_user` may have been revoked
 * by the time admin tests run (the last admin test revokes it on purpose).
 * Idempotent — re-inserts the same `id` with `ON CONFLICT DO NOTHING`.
 */
const reseed_non_keeper_session = async (): Promise<void> => {
	const token_hash = hash_token('test-non-keeper-session-token');
	const result = await run_psql(`
		INSERT INTO auth_session (id, account_id, expires_at)
		VALUES ('${sql_escape(token_hash)}', '${NON_KEEPER_ACCOUNT_ID}', NOW() + INTERVAL '30 days')
		ON CONFLICT DO NOTHING;
	`);
	if (!result.ok) throw new Error(`reseed_non_keeper_session: ${result.stderr}`);
};

export const run_admin_tests = async (
	config: BackendConfig,
	_session_cookie: string | undefined,
	non_keeper_cookie: string | undefined,
	filter?: string,
): Promise<TestResult[]> => {
	const results: TestResult[] = [];

	if (!non_keeper_cookie) return results;
	if (!config.account_paths) return results;

	// Skip the admin suite entirely on backends that don't expose admin
	// methods — saves us from emitting N "FAIL: method_not_found" rows on
	// the Deno backend. Tests still carry `skip: ['deno']` individually
	// as defense in depth.
	if (config.name === 'deno') return results;

	// Fresh login per admin-suite run — the runner-level cookie is dead
	// after the audit-tests password-change cycle.
	const session_cookie = await login_admin(config);
	if (!session_cookie) return results;

	// Re-seed the non-keeper session in case earlier suites revoked it.
	await reseed_non_keeper_session();

	for (const test of admin_test_list) {
		if (filter && !test.name.includes(filter)) continue;
		if (test.skip?.includes(config.name)) continue;
		const start = performance.now();
		try {
			await test.fn(config, session_cookie, non_keeper_cookie);
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
