/**
 * Cross-backend tests for the gates that keep browser pages other than zzz's
 * own from driving the daemon, over every route — the static frontend
 * included:
 *
 * - **Host** — a `Host` that isn't loopback or named by an allowed origin is
 *   refused (403 `forbidden_host`). A DNS-rebinding page talks to zzzd
 *   same-origin, so it sends no `Origin`, but its `Host` is its own domain.
 * - **Origin** — the backends run with exact origins, as the production
 *   template ships them, so a page on another `localhost` port — same-site,
 *   so its requests carry the session cookie — is refused (403
 *   `forbidden_origin`), on the WebSocket upgrade too.
 * - **CORS simple requests** — a `POST` with no `Content-Type`, or a form or
 *   text one, is refused (415 `unsupported_content_type`) before anything
 *   reads it: a browser sends those cross-origin with no preflight, carrying
 *   the session cookie from any `localhost` port.
 * - **Body cap** — each route group's cap sits outside the gates above, so a
 *   request declaring a `Content-Length` over its route's cap is a 413 even
 *   from a foreign origin.
 *
 * Requests go through `node:http`, since `fetch` won't send a chosen `Host`.
 * `dev_origins.cross.test.ts` covers the origins a dev checkout allows.
 *
 * @module
 */

import { join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, test, assert } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { raw_http_send_head } from '@fuzdev/fuz_app/testing/transports/raw_http.ts';
import { RAW_WS_UPGRADE_HEADERS } from '@fuzdev/fuz_app/testing/transports/ws_raw_client.ts';

import { FILE_BYTES_MAX_BODY_BYTES, to_file_bytes_url } from '#lib/file_bytes.ts';
import { RPC_MESSAGE_MAX_BYTES } from '#lib/rpc_message_limit.ts';

import { raw_request as send_raw_request, type RawResponse } from './raw_request.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

const { base_url, rpc_path } = handle.config;
const port = new URL(base_url).port;
const api_path = rpc_path.replace(/\/rpc$/, '');
const scoped_dir = handle.config.env.PUBLIC_ZZZ_SCOPED_DIRS!;

/** A page on another local port: same-site with zzzd, not an allowed origin. */
const OTHER_PORT_ORIGIN = 'http://localhost:8000';

/**
 * The cap on every route group but RPC and the byte routes — the spine's
 * default, `fuz_http::DEFAULT_BODY_LIMIT_BYTES`.
 */
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/** The `Host` a rebinding page sends: its own domain, at the daemon's port. */
const REBOUND_HOST = `rebind.example.com:${port}`;

/** Send one request to the backend exactly as given — `Host` included. */
const raw_request = (
	path: string,
	options?: Parameters<typeof send_raw_request>[1]
): Promise<RawResponse> => send_raw_request(`${base_url}${path}`, options);

const ping_envelope = JSON.stringify({ jsonrpc: '2.0', id: 'gate', method: 'ping' });

const assert_error = (res: RawResponse, status: number, error: string, label: string): void => {
	assert.strictEqual(res.status, status, label);
	assert.deepStrictEqual(JSON.parse(res.body), { error }, label);
};

describe('browser gates', () => {
	describe('Host', () => {
		test('loopback hosts are served', async () => {
			for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
				const res = await raw_request('/health', { headers: { host } });
				assert.strictEqual(res.status, 200, host);
			}
		});

		test('a foreign host is refused on every kind of route', async () => {
			const fixture = await setup_test();
			const session = fixture.create_session_headers();
			for (const [label, path, init] of [
				['health', '/health', {}],
				['static fallback', '/', {}],
				['account status', '/api/account/status', {}],
				['rpc GET', `${rpc_path}?method=ping&id=gate`, {}],
				[
					'rpc POST',
					rpc_path,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: ping_envelope
					}
				],
				['file bytes', to_file_bytes_url(api_path, join(scoped_dir, 'x.webm')), {}]
			] as const) {
				const res = await raw_request(path, {
					...init,
					headers: { ...session, ...('headers' in init ? init.headers : {}), host: REBOUND_HOST }
				});
				assert_error(res, 403, 'forbidden_host', label);
			}
		});

		test('a foreign host is refused a WebSocket upgrade', async () => {
			const fixture = await setup_test();
			const res = await raw_request(`${api_path}/ws`, {
				headers: {
					...fixture.create_session_headers(),
					host: REBOUND_HOST,
					...RAW_WS_UPGRADE_HEADERS
				}
			});
			assert_error(res, 403, 'forbidden_host', 'ws upgrade');
		});
	});

	describe('Origin', () => {
		test('a page on another localhost port is refused, the upgrade included', async () => {
			const fixture = await setup_test();
			const session = fixture.create_session_headers();
			const rpc = await raw_request(rpc_path, {
				method: 'POST',
				headers: {
					...session,
					origin: OTHER_PORT_ORIGIN,
					'content-type': 'application/json'
				},
				body: ping_envelope
			});
			assert_error(rpc, 403, 'forbidden_origin', 'rpc POST');
			// a forged form POST is refused for its origin first
			const form = await raw_request(rpc_path, {
				method: 'POST',
				headers: {
					...session,
					origin: OTHER_PORT_ORIGIN,
					'content-type': 'text/plain'
				},
				body: ping_envelope
			});
			assert_error(form, 403, 'forbidden_origin', 'text/plain rpc POST');
			const ws = await raw_request(`${api_path}/ws`, {
				headers: {
					...session,
					origin: OTHER_PORT_ORIGIN,
					...RAW_WS_UPGRADE_HEADERS
				}
			});
			assert_error(ws, 403, 'forbidden_origin', 'ws upgrade');
		});

		test('a foreign origin is refused on the probe, the static fallback, and unrouted paths', async () => {
			for (const path of ['/health', '/', '/chats/x', '/no/such/route', `${api_path}/nope`]) {
				const res = await raw_request(path, { headers: { origin: OTHER_PORT_ORIGIN } });
				assert_error(res, 403, 'forbidden_origin', path);
			}
			// with no `Origin` they answer as usual
			assert.strictEqual((await raw_request('/health')).status, 200, '/health');
			assert.strictEqual((await raw_request(`${api_path}/nope`)).status, 404, 'unrouted api path');
		});

		test("zzzd's own origins are allowed a JSON POST", async () => {
			for (const origin of [base_url, `http://127.0.0.1:${port}`]) {
				const res = await raw_request(rpc_path, {
					method: 'POST',
					headers: { origin, 'content-type': 'application/json; charset=utf-8' },
					body: ping_envelope
				});
				assert.strictEqual(res.status, 200, origin);
			}
		});
	});

	describe('CORS simple requests', () => {
		test('a text/plain RPC POST with a session is refused, not dispatched', async () => {
			const fixture = await setup_test();
			for (const content_type of [
				'text/plain;charset=UTF-8',
				'application/x-www-form-urlencoded',
				'multipart/form-data; boundary=x'
			]) {
				const res = await raw_request(rpc_path, {
					method: 'POST',
					headers: {
						...fixture.create_session_headers(),
						origin: base_url,
						'content-type': content_type
					},
					body: ping_envelope
				});
				assert_error(res, 415, 'unsupported_content_type', content_type);
			}
		});

		test('an untyped RPC POST is refused', async () => {
			const fixture = await setup_test();
			const res = await raw_request(rpc_path, {
				method: 'POST',
				headers: { ...fixture.create_session_headers(), origin: base_url },
				body: ping_envelope
			});
			assert_error(res, 415, 'unsupported_content_type', 'untyped');
		});

		test('a text/plain file create is refused and writes nothing', async () => {
			const fixture = await setup_test();
			await mkdir(scoped_dir, { recursive: true });
			const path = join(scoped_dir, `${randomUUID()}_forged.webm`);
			const res = await raw_request(to_file_bytes_url(api_path, path), {
				method: 'POST',
				headers: {
					...fixture.create_session_headers(),
					origin: base_url,
					'content-type': 'text/plain'
				},
				body: 'forged'
			});
			assert_error(res, 415, 'unsupported_content_type', 'file create');
			const exists = await stat(path).then(
				() => true,
				() => false
			);
			assert.isFalse(exists, 'no file created');
		});
	});

	describe('Body cap', () => {
		test('an over-cap body from a foreign origin is a 413 on every route group', async () => {
			const fixture = await setup_test();
			const file_bytes = to_file_bytes_url(api_path, join(scoped_dir, `${randomUUID()}.bin`));
			for (const [label, path, cap] of [
				['health', '/health', DEFAULT_BODY_LIMIT_BYTES],
				['static fallback', '/', DEFAULT_BODY_LIMIT_BYTES],
				['unrouted path', '/no/such/route', DEFAULT_BODY_LIMIT_BYTES],
				['account login', '/api/account/login', DEFAULT_BODY_LIMIT_BYTES],
				['rpc POST', rpc_path, RPC_MESSAGE_MAX_BYTES],
				['file bytes', file_bytes, FILE_BYTES_MAX_BODY_BYTES]
			] as const) {
				const res = await raw_http_send_head(base_url, {
					path,
					headers: {
						...fixture.create_session_headers(),
						origin: OTHER_PORT_ORIGIN,
						'content-type': 'application/json'
					},
					content_length: cap + 1
				});
				assert.strictEqual(res.status, 413, label);
			}
		});
	});
});
