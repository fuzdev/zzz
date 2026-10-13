/**
 * Cross-backend tests for the origins a dev checkout allows: a second backend
 * started with the dev env template's `FUZ_ALLOWED_ORIGINS`, as
 * `cargo xtask dev` runs `zzzd`, and no frontend of its own.
 *
 * `zzzd` trusts whatever page is served at an allowed origin, and the browser
 * attaches the session cookie to a request from any `localhost` port, so the
 * list decides which local pages can drive the daemon. It names the Vite dev
 * server's origin — the port `vite.config.ts` pins, zzz's own — and nothing
 * else: not the ports a default Vite takes, which another project's dev
 * server would hold, not `vite preview`'s, not the dev port under another
 * loopback name, and not the backend's own port, which serves no page in dev.
 *
 * Every request here is one any page could make, with no account: an allowed
 * origin reaches a handler (which answers, or asks for a credential), and a
 * refused one gets the gate's 403 on RPC, REST, and the WebSocket upgrade.
 *
 * @module
 */

import { describe, test, assert, beforeAll, afterAll } from 'vitest';
import {
	spawn_backend,
	type BackendHandle
} from '@fuzdev/fuz_app/testing/cross_backend/spawn_backend.ts';

import { raw_request, WS_UPGRADE_HEADERS, type RawResponse } from './raw_request.ts';
import { read_dev_allowed_origins, rust_dev_origins_backend_config } from './zzz_backend_config.ts';

/** The dev UI's origin: the Vite dev server, at the port `vite.config.ts` pins. */
const DEV_UI_ORIGIN = 'http://localhost:5460';

const config = rust_dev_origins_backend_config();
const { base_url, rpc_path } = config;
const port = new URL(base_url).port;
const api_path = rpc_path.replace(/\/rpc$/, '');

const ping_envelope = JSON.stringify({ jsonrpc: '2.0', id: 'dev', method: 'ping' });

/** The three ways a page reaches the daemon, each from `origin`. */
const request_from = async (
	origin: string
): Promise<{ rpc: RawResponse; rest: RawResponse; ws: RawResponse }> => ({
	rpc: await raw_request(`${base_url}${rpc_path}`, {
		method: 'POST',
		headers: { origin, 'content-type': 'application/json' },
		body: ping_envelope
	}),
	rest: await raw_request(`${base_url}${api_path}/account/status`, { headers: { origin } }),
	ws: await raw_request(`${base_url}${api_path}/ws`, {
		headers: { origin, ...WS_UPGRADE_HEADERS }
	})
});

const assert_refused = async (origin: string): Promise<void> => {
	for (const [label, res] of Object.entries(await request_from(origin))) {
		assert.strictEqual(res.status, 403, `${origin} ${label}`);
		assert.deepStrictEqual(
			JSON.parse(res.body),
			{ error: 'forbidden_origin' },
			`${origin} ${label}`
		);
	}
};

describe('dev origins', () => {
	let backend: BackendHandle;

	beforeAll(async () => {
		backend = await spawn_backend(config);
	}, config.startup_timeout_ms + 10_000);

	afterAll(async () => {
		await backend.teardown();
	});

	test('the dev template allows exactly the dev UI origin', () => {
		assert.strictEqual(read_dev_allowed_origins(), DEV_UI_ORIGIN);
		assert.strictEqual(config.env.FUZ_ALLOWED_ORIGINS, DEV_UI_ORIGIN);
	});

	test('the dev UI origin reaches the handlers', async () => {
		const { rpc, rest, ws } = await request_from(DEV_UI_ORIGIN);
		// past the gates: the dispatcher answers the public `ping`
		assert.strictEqual(rpc.status, 200, rpc.body);
		assert.deepStrictEqual(JSON.parse(rpc.body).result, { ping_id: 'dev' });
		// and the account routes and the upgrade ask for a credential
		assert.strictEqual(rest.status, 401, rest.body);
		assert.strictEqual(ws.status, 401, ws.body);
	});

	test("a default Vite's ports are refused", async () => {
		// the first free port from 5173 up for `vite dev`, from 4173 for
		// `vite preview` — any other project's dev server
		for (const origin of [
			'http://localhost:5173',
			'http://localhost:5174',
			'http://localhost:4173',
			'http://127.0.0.1:5173'
		]) {
			await assert_refused(origin);
		}
	});

	test('the preview port is refused', async () => {
		// pinned in `vite.config.ts`, and opt-in
		await assert_refused('http://localhost:5461');
	});

	test('the dev port under another loopback name is refused', async () => {
		// Vite binds what `localhost` resolves to, so the same port on another
		// loopback address may be another process's page
		for (const origin of ['http://127.0.0.1:5460', 'http://[::1]:5460']) {
			await assert_refused(origin);
		}
	});

	test("the backend's own port is refused: it serves no page in dev", async () => {
		for (const origin of [base_url, `http://127.0.0.1:${port}`]) {
			await assert_refused(origin);
		}
	});

	test('every other origin is refused', async () => {
		for (const origin of [
			'http://localhost:8000',
			'http://localhost:54600',
			'http://localhost:546',
			'http://localhost',
			'https://localhost:5460',
			'http://app.localhost:5460',
			'https://evil.example',
			'null'
		]) {
			await assert_refused(origin);
		}
	});

	test('a request with no origin still passes', async () => {
		// not a browser page's cross-origin request: a script, or a same-origin GET
		const res = await raw_request(`${base_url}${rpc_path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: ping_envelope
		});
		assert.strictEqual(res.status, 200, res.body);
	});
});
