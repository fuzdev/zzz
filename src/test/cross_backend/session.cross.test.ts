/**
 * Cross-backend tests for zzz's session cookie and for what a tab's socket
 * sees when a revocation elsewhere leaves its own session valid.
 *
 * - The cookie is per port (`zzz_session_<port>`), so zzz daemons on one host
 *   (the installed daemon, `cargo xtask dev`, test binaries) don't share a
 *   session — plus fuz_app's hardened-attribute suite under that name.
 * - Logging out closes every socket of the account (the fuz_app contract), so
 *   another tab's socket closes while its session stays valid — the client
 *   rechecks and rebuilds its socket, which needs the status probe to say
 *   valid and a fresh socket on the same session to work.
 * - An RPC revocation closes sockets only after its transaction commits, so
 *   the recheck a revoked socket triggers already sees the session gone (a
 *   smoke check here — the order is a race over the wire; the spine's
 *   Postgres dispatch test pins it).
 *
 * @module
 */

import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
	type TestFixture
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { describe_cookie_attributes_cross_tests } from '@fuzdev/fuz_app/testing/cross_backend/cookie_attributes.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import type { FetchTransport } from '@fuzdev/fuz_app/testing/transports/fetch_transport.ts';
import { DEFAULT_TEST_PASSWORD } from '@fuzdev/fuz_app/testing/test_credentials.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

import './cross_test_types.ts';
import { zzz_session_cookie_name } from './zzz_backend_config.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);
const { cookie_name } = handle.config;

const STATUS_PATH = '/api/account/status';
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Log `username` in on a fresh transport — one browser tab's session. */
const log_in = async (fixture: TestFixture, username: string): Promise<FetchTransport> => {
	const tab = fixture.fresh_transport();
	const res = await tab('/api/account/login', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ username, password: DEFAULT_TEST_PASSWORD })
	});
	assert.strictEqual(res.status, 200, 'login succeeds');
	return tab;
};

/** Open a socket on `tab`'s session and round-trip a ping. */
const open_ws = async (tab: FetchTransport) => {
	const ws = await create_ws_transport({
		base_url: handle.config.base_url,
		ws_path: handle.config.ws_path,
		cookies: tab.cookies()
	});
	await ws.request('warmup', 'ping', undefined);
	return ws;
};

const status_of = async (tab: FetchTransport): Promise<number> =>
	(await tab(STATUS_PATH, { method: 'GET' })).status;

describe_cookie_attributes_cross_tests({ setup_test, cookie_name });

describe('session cookie name', () => {
	test('is per port', () => {
		const port = Number(new URL(handle.config.base_url).port);
		assert.strictEqual(cookie_name, zzz_session_cookie_name(port));
	});

	test('login sets only the per-port cookie, and the shared default name is not read', async () => {
		const fixture = await setup_test();
		await fixture.create_account({
			username: 'cookie_port',
			password_value: DEFAULT_TEST_PASSWORD
		});
		const tab = await log_in(fixture, 'cookie_port');
		const cookies = tab.cookies();
		assert.strictEqual(cookies.length, 1, `only the session cookie is set: ${cookies.join(', ')}`);
		const cookie = cookies[0]!;
		assert.ok(cookie.startsWith(`${cookie_name}=`), `jar holds '${cookie_name}': ${cookie}`);
		const value = cookie.slice(cookie_name.length + 1);

		const probe = (cookie_header: string) =>
			fixture.fresh_transport()(STATUS_PATH, { method: 'GET', headers: { cookie: cookie_header } });
		assert.strictEqual((await probe(`${cookie_name}=${value}`)).status, 200);
		// another daemon's cookie (the old shared `fuz_session`) is not this daemon's session
		assert.strictEqual((await probe(`fuz_session=${value}`)).status, 401);
	});
});

describe('a revocation that leaves this session valid', () => {
	test("another session's logout closes this socket, but the session stays valid and a new socket works", async () => {
		const fixture = await setup_test();
		await fixture.create_account({ username: 'two_tabs', password_value: DEFAULT_TEST_PASSWORD });
		const tab_a = await log_in(fixture, 'two_tabs');
		const tab_b = await log_in(fixture, 'two_tabs');
		const ws_a = await open_ws(tab_a);
		let ws_a2: Awaited<ReturnType<typeof open_ws>> | null = null;
		try {
			const out = await tab_b('/api/account/logout', {
				method: 'POST',
				headers: JSON_HEADERS,
				body: '{}'
			});
			assert.strictEqual(out.status, 200, 'tab B logs out');

			// logout closes every socket of the account, tab A's included
			assert.ok(await ws_a.wait_for_close(5_000), "tab A's socket closed");
			// tab A's session is untouched — the recheck the client runs reads valid
			assert.strictEqual(await status_of(tab_a), 200, "tab A's session is still valid");
			assert.strictEqual(await status_of(tab_b), 401, "tab B's session ended");
			// so the client rebuilds its socket, and a new one on the same session works
			ws_a2 = await open_ws(tab_a);
			await ws_a2.request('after', 'ping', undefined);
		} finally {
			await ws_a.close();
			await ws_a2?.close();
		}
	});

	// smoke check: over the wire the commit-vs-close order is a race this would
	// usually win even with the bug — the deterministic regression test is the
	// spine's `revocations_close_sockets_after_the_transaction_commits`
	test('smoke: an RPC revocation has committed by the time the socket closes', async () => {
		const fixture = await setup_test();
		await fixture.create_account({
			username: 'revoked_tabs',
			password_value: DEFAULT_TEST_PASSWORD
		});
		const tab_a = await log_in(fixture, 'revoked_tabs');
		const tab_b = await log_in(fixture, 'revoked_tabs');
		const ws_a = await open_ws(tab_a);
		try {
			const res = await rpc_call({
				app: tab_b,
				path: handle.config.rpc_path,
				method: 'account_session_revoke_all'
			});
			assert.ok(res.ok, 'tab B revokes every session');
			assert.ok(await ws_a.wait_for_close(5_000), "tab A's socket closed");
			// the recheck a revoked socket triggers must not find the session alive
			assert.strictEqual(await status_of(tab_a), 401, "tab A's session is gone");
		} finally {
			await ws_a.close();
		}
	});
});
