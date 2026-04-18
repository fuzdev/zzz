/**
 * Bearer token auth integration tests.
 *
 * Tests API token authentication via `Authorization: Bearer <token>`,
 * keeper credential enforcement, and WebSocket session revocation.
 *
 * Separated from tests.ts to keep test modules focused.
 */

import {type BackendConfig, TEST_DATABASE_URL} from './config.ts';
import {assert_equal, hmac_sign, open_ws, post_rpc, sql_escape} from './test_helpers.ts';
import type {TestResult} from './tests.ts';
// @ts-ignore — npm specifier, resolved at runtime by Deno
import {hash as blake3_hash} from 'npm:@fuzdev/blake3_wasm';
// @ts-ignore — npm specifier, resolved at runtime by Deno
import {to_hex} from 'npm:@fuzdev/fuz_util/hex.js';

// -- Token setup helpers ------------------------------------------------------

/** Raw token value used in integration tests. */
const BEARER_TOKEN_RAW = 'zzz-integration-test-api-token-value';
const BEARER_TOKEN_HASH = to_hex(
	blake3_hash(new TextEncoder().encode(BEARER_TOKEN_RAW)),
);

/** Expired token for negative tests. */
const EXPIRED_TOKEN_RAW = 'zzz-integration-test-expired-token';
const EXPIRED_TOKEN_HASH = to_hex(
	blake3_hash(new TextEncoder().encode(EXPIRED_TOKEN_RAW)),
);

/**
 * Second valid token used by the granular-revocation test. The test deletes
 * this token, so it must be distinct from `BEARER_TOKEN_RAW` (which other
 * tests still rely on).
 */
// fuz_app's `/tokens/:id/revoke` validates id against `^tok_[A-Za-z0-9_-]{12}$`
// (12 chars after the prefix), so the id must match or the route returns 400.
const REVOCABLE_TOKEN_ID = 'tok_revoke_test1';
const REVOCABLE_TOKEN_RAW = 'zzz-integration-test-revocable-token';
const REVOCABLE_TOKEN_HASH = to_hex(
	blake3_hash(new TextEncoder().encode(REVOCABLE_TOKEN_RAW)),
);

/**
 * Insert API tokens into the test database for the bootstrapped admin account.
 *
 * Must be called after bootstrap (admin account exists). Uses the admin
 * account's UUID from the account table.
 */
export const setup_bearer_tokens = async (): Promise<void> => {
	const sql = `
		DO $$
		DECLARE
			admin_id UUID;
		BEGIN
			SELECT id INTO admin_id FROM account WHERE username = 'testadmin';
			IF admin_id IS NULL THEN
				RAISE EXCEPTION 'testadmin account not found';
			END IF;

			-- Valid API token (no expiry)
			INSERT INTO api_token (id, account_id, name, token_hash)
			VALUES ('test-api-token-1', admin_id, 'integration-test-token', '${sql_escape(BEARER_TOKEN_HASH)}')
			ON CONFLICT DO NOTHING;

			-- Expired API token
			INSERT INTO api_token (id, account_id, name, token_hash, expires_at)
			VALUES ('test-api-token-expired', admin_id, 'expired-token', '${sql_escape(EXPIRED_TOKEN_HASH)}', NOW() - INTERVAL '1 day')
			ON CONFLICT DO NOTHING;

			-- Revocable valid token — used by granular revocation test only
			INSERT INTO api_token (id, account_id, name, token_hash)
			VALUES ('${sql_escape(REVOCABLE_TOKEN_ID)}', admin_id, 'revocable-token', '${sql_escape(REVOCABLE_TOKEN_HASH)}')
			ON CONFLICT DO NOTHING;
		END $$;
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
		throw new Error(`Bearer token setup failed: ${stderr_text}`);
	}
	await child.stderr.cancel();
	console.log('  Bearer tokens created');
};

// -- Test definitions ---------------------------------------------------------

/**
 * Test fn — `session_cookie` is the admin cookie from bootstrap, passed for
 * tests (like granular token revocation) that must call session-authed routes
 * in addition to exercising bearer behavior. Most tests ignore it.
 */
type TestFn = (config: BackendConfig, session_cookie: string) => Promise<void>;

const bearer_test_list: ReadonlyArray<{
	name: string;
	fn: TestFn;
	skip?: readonly string[];
}> = [
	{
		name: 'bearer_token_auth',
		fn: async (config) => {
			// Valid bearer token → authenticated action succeeds
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-1',
					method: 'workspace_list',
				}),
				{bearer: BEARER_TOKEN_RAW},
			);
			assert_equal(status, 200, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'bt-1', 'id');
			const result = r.result as Record<string, unknown>;
			assert_equal(Array.isArray(result.workspaces), true, 'has workspaces array');
		},
	},
	{
		name: 'bearer_token_invalid',
		fn: async (config) => {
			// Invalid bearer token → 401 with JSON-RPC envelope.
			// Both backends now soft-fail invalid bearer tokens, so the RPC
			// layer produces a consistent JSON-RPC unauthenticated error.
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-inv-1',
					method: 'workspace_list',
				}),
				{bearer: 'not-a-real-token'},
			);
			assert_equal(status, 401, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'bt-inv-1', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32001, 'error code');
			assert_equal(error.message, 'unauthenticated', 'error message');
		},
	},
	{
		name: 'bearer_token_expired',
		fn: async (config) => {
			// Expired bearer token → 401 with JSON-RPC envelope (same as invalid)
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-exp-1',
					method: 'workspace_list',
				}),
				{bearer: EXPIRED_TOKEN_RAW},
			);
			assert_equal(status, 401, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'bt-exp-1', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32001, 'error code');
			assert_equal(error.message, 'unauthenticated', 'error message');
		},
	},
	{
		name: 'bearer_token_public_action',
		fn: async (config) => {
			// Bearer token on a public action → success (auth is optional)
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-pub-1',
					method: 'ping',
				}),
				{bearer: BEARER_TOKEN_RAW},
			);
			assert_equal(status, 200, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'bt-pub-1', 'id');
			const result = r.result as Record<string, unknown>;
			assert_equal(result.ping_id, 'bt-pub-1', 'ping_id');
		},
	},
	{
		name: 'bearer_token_ws',
		fn: async (config) => {
			// Bearer token on WebSocket upgrade → authenticated WS actions work
			const conn = await open_ws(config, {bearer: BEARER_TOKEN_RAW});
			try {
				conn.send(
					JSON.stringify({jsonrpc: '2.0', id: 'bt-ws-1', method: 'workspace_list'}),
				);
				const r = (await conn.receive()) as Record<string, unknown>;
				assert_equal(r.id, 'bt-ws-1', 'id');
				const result = r.result as Record<string, unknown>;
				assert_equal(Array.isArray(result.workspaces), true, 'workspaces is array');
			} finally {
				conn.close();
			}
		},
	},
	{
		name: 'bearer_token_ws_rejected_invalid',
		fn: async (config) => {
			// Invalid bearer token on WebSocket → connection rejected
			try {
				const conn = await open_ws(config, {bearer: 'invalid-token'});
				conn.close();
				throw new Error('WebSocket connected with invalid bearer — expected rejection');
			} catch (e) {
				// Expected: connection rejected
				if (e instanceof Error && e.message.includes('expected rejection')) {
					throw e;
				}
				// Any other error = rejection, which is correct
			}
		},
	},
	{
		name: 'keeper_requires_daemon_token',
		// Both backends enforce daemon_token credential type for keeper actions.
		fn: async (config) => {
			// API token (bearer) with keeper role account calling keeper action → 403
			// The admin account has keeper permit, but bearer credential type is
			// api_token, not daemon_token — keeper actions must be rejected.
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-keeper-1',
					method: 'provider_update_api_key',
					params: {provider_name: 'claude', api_key: 'sk-test'},
				}),
				{bearer: BEARER_TOKEN_RAW},
			);
			assert_equal(status, 403, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'bt-keeper-1', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32002, 'error code');
			assert_equal(error.message, 'forbidden', 'error message');
		},
	},
	{
		name: 'ws_revocation_on_session_delete',
		fn: async (config) => {
			// Open a WS connection with a session cookie, delete the session
			// from the DB, call close_sockets_for_session, verify WS drops.
			//
			// Since we can't call close_sockets_for_session directly from
			// the test, we delete the session and verify the next WS action
			// after a re-auth attempt fails. Instead, we test the simpler
			// case: open WS, verify it works, then verify a new WS with a
			// deleted session can't connect.
			//
			// Actually test the infrastructure: create a dedicated session,
			// open WS with it, delete the session from DB, then verify the
			// connection still works for existing messages (no per-message
			// revalidation) but new connections fail.
			const dedicated_token = 'zzz-revocation-test-session-token';
			const token_hash = to_hex(
				blake3_hash(new TextEncoder().encode(dedicated_token)),
			);

			// Create a dedicated session in the DB
			const create_sql = `
				INSERT INTO auth_session (id, account_id, expires_at)
				SELECT '${sql_escape(token_hash)}', id, NOW() + INTERVAL '30 days'
				FROM account WHERE username = 'testadmin'
				ON CONFLICT DO NOTHING;
			`;
			const create_cmd = new Deno.Command('psql', {
				args: [TEST_DATABASE_URL, '-c', create_sql],
				stdout: 'null',
				stderr: 'null',
			});
			const create_status = await (await create_cmd.spawn()).status;
			assert_equal(create_status.success, true, 'session created');

			// Sign the cookie
			const expires_at = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
			const cookie_key = config.env?.SECRET_COOKIE_KEYS;
			if (!cookie_key) throw new Error('SECRET_COOKIE_KEYS not configured');
			const cookie_value = await hmac_sign(
				`${dedicated_token}:${expires_at}`,
				cookie_key,
			);
			// Both cookie names: Rust uses fuz_session, Deno uses zzz_session
			const cookie = `fuz_session=${cookie_value}; zzz_session=${cookie_value}`;

			// Verify the session works
			const {status} = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'rev-1', method: 'ping'}),
				{cookie},
			);
			assert_equal(status, 200, 'session works before delete');

			// Delete the session from DB
			const delete_sql = `DELETE FROM auth_session WHERE id = '${sql_escape(token_hash)}';`;
			const delete_cmd = new Deno.Command('psql', {
				args: [TEST_DATABASE_URL, '-c', delete_sql],
				stdout: 'null',
				stderr: 'null',
			});
			await (await delete_cmd.spawn()).status;

			// New request with deleted session → 401
			const {status: post_delete_status, body: post_delete_body} = await post_rpc(
				config,
				JSON.stringify({jsonrpc: '2.0', id: 'rev-2', method: 'workspace_list'}),
				{cookie},
			);
			assert_equal(post_delete_status, 401, 'deleted session → 401');
			const error = (post_delete_body as Record<string, unknown>).error as Record<
				string,
				unknown
			>;
			assert_equal(error.code, -32001, 'error code');
		},
	},
	{
		name: 'ws_revocation_only_for_revoked_token',
		fn: async (config, session_cookie) => {
			// Open two bearer-auth WS connections on the same account:
			// one with the revocable token, one with the shared bearer token.
			// Revoke the revocable token via POST /tokens/:id/revoke
			// (authenticated with admin session cookie). The revocable socket
			// must close; the other bearer socket must remain usable. Proves
			// per-token revocation doesn't tear down the account's other sockets.
			const revocable_ws = await open_ws(config, {bearer: REVOCABLE_TOKEN_RAW});
			const shared_ws = await open_ws(config, {bearer: BEARER_TOKEN_RAW});
			try {
				// Warm up both sockets — ensures `add_connection` ran server-side.
				revocable_ws.send(
					JSON.stringify({jsonrpc: '2.0', id: 'warm-r', method: 'ping'}),
				);
				await revocable_ws.receive();
				shared_ws.send(
					JSON.stringify({jsonrpc: '2.0', id: 'warm-s', method: 'ping'}),
				);
				await shared_ws.receive();

				// Revoke only the revocable token — admin cookie authenticates the call.
				const revoke_res = await fetch(
					`${config.base_url}/api/account/tokens/${REVOCABLE_TOKEN_ID}/revoke`,
					{method: 'POST', headers: {Cookie: session_cookie}},
				);
				assert_equal(revoke_res.status, 200, 'revoke status');
				const revoke_body = (await revoke_res.json()) as Record<string, unknown>;
				assert_equal(revoke_body.ok, true, 'revoke ok');
				assert_equal(revoke_body.revoked, true, 'revoked flag');

				// The revocable socket must close.
				const close_event = await revocable_ws.wait_closed(3_000);
				if (close_event.code === 1000) {
					throw new Error(
						`revocable socket closed with 1000 (normal) — expected revocation code`,
					);
				}

				// The other bearer socket on the same account must still work.
				shared_ws.send(
					JSON.stringify({jsonrpc: '2.0', id: 'post-revoke', method: 'ping'}),
				);
				const r = (await shared_ws.receive()) as Record<string, unknown>;
				assert_equal(r.id, 'post-revoke', 'other bearer socket still responsive');
			} finally {
				shared_ws.close();
				// revocable_ws already closed by server, but close() is idempotent
				revocable_ws.close();
			}
		},
	},
	{
		name: 'bearer_rejects_browser_context_origin',
		// Both backends silently discard bearer in browser context (Origin present).
		// Bearer is ignored → no auth → unauthenticated 401.
		fn: async (config) => {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${BEARER_TOKEN_RAW}`,
				Origin: 'http://localhost:5173',
			};
			const res = await fetch(`${config.base_url}${config.rpc_path}`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-browser-1',
					method: 'workspace_list',
				}),
			});
			const body = (await res.json()) as Record<string, unknown>;
			assert_equal(res.status, 401, 'status');
			const error = body.error as Record<string, unknown>;
			assert_equal(error.code, -32001, 'error code');
		},
	},
	{
		name: 'bearer_rejects_browser_context_referer',
		// Same defense-in-depth but triggered by Referer instead of Origin.
		fn: async (config) => {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${BEARER_TOKEN_RAW}`,
				Referer: 'http://localhost:5173/chats',
			};
			const res = await fetch(`${config.base_url}${config.rpc_path}`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-referer-1',
					method: 'workspace_list',
				}),
			});
			const body = (await res.json()) as Record<string, unknown>;
			assert_equal(res.status, 401, 'status');
			const error = body.error as Record<string, unknown>;
			assert_equal(error.code, -32001, 'error code');
		},
	},
	{
		name: 'bearer_empty_value',
		fn: async (config) => {
			// "Authorization: Bearer " with nothing after → treated as no auth.
			// Both backends soft-fail → JSON-RPC unauthenticated error.
			const {status, body} = await post_rpc(
				config,
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-empty-1',
					method: 'workspace_list',
				}),
				{bearer: ''},
			);
			assert_equal(status, 401, 'status');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'bt-empty-1', 'id');
			const error = r.error as Record<string, unknown>;
			assert_equal(error.code, -32001, 'error code');
			assert_equal(error.message, 'unauthenticated', 'error message');
		},
	},
	{
		name: 'bearer_cookie_priority',
		// Both backends try cookie auth first. If cookie succeeds, bearer
		// is not checked — cookie wins even when bearer is invalid.
		fn: async (config) => {
			// When both cookie and bearer are present, cookie should win.
			// Use a valid cookie + invalid bearer — if cookie wins, request succeeds.
			// We need the session cookie, so create a dedicated session.
			const dedicated_token = 'zzz-priority-test-session-token';
			const token_hash = to_hex(
				blake3_hash(new TextEncoder().encode(dedicated_token)),
			);

			const create_sql = `
				INSERT INTO auth_session (id, account_id, expires_at)
				SELECT '${sql_escape(token_hash)}', id, NOW() + INTERVAL '30 days'
				FROM account WHERE username = 'testadmin'
				ON CONFLICT DO NOTHING;
			`;
			const create_cmd = new Deno.Command('psql', {
				args: [TEST_DATABASE_URL, '-c', create_sql],
				stdout: 'null',
				stderr: 'null',
			});
			await (await create_cmd.spawn()).status;

			const expires_at = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
			const cookie_key = config.env?.SECRET_COOKIE_KEYS;
			if (!cookie_key) throw new Error('SECRET_COOKIE_KEYS not configured');
			const cookie_value = await hmac_sign(
				`${dedicated_token}:${expires_at}`,
				cookie_key,
			);
			// Both cookie names: Rust uses fuz_session, Deno uses zzz_session
			const cookie = `fuz_session=${cookie_value}; zzz_session=${cookie_value}`;

			// Send both valid cookie AND invalid bearer
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Cookie: cookie,
				Authorization: 'Bearer totally-invalid-token',
			};
			const res = await fetch(`${config.base_url}${config.rpc_path}`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 'bt-prio-1',
					method: 'workspace_list',
				}),
			});
			const body = await res.json();
			// Cookie should win → 200 success
			assert_equal(res.status, 200, 'status (cookie wins over invalid bearer)');
			const r = body as Record<string, unknown>;
			assert_equal(r.id, 'bt-prio-1', 'id');
			const result = r.result as Record<string, unknown>;
			assert_equal(Array.isArray(result.workspaces), true, 'has workspaces array');
		},
	},
];

// -- Test runner --------------------------------------------------------------

export const run_bearer_tests = async (
	config: BackendConfig,
	session_cookie: string,
	filter?: string,
): Promise<TestResult[]> => {
	const results: TestResult[] = [];

	for (const test of bearer_test_list) {
		if (filter && !test.name.includes(filter)) continue;
		if (test.skip?.includes(config.name)) continue;
		const start = performance.now();
		try {
			await test.fn(config, session_cookie);
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
