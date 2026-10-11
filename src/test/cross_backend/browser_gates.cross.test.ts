/**
 * Cross-backend tests for the gates that keep browser pages other than zzz's
 * own from driving the daemon, over every route — the static frontend
 * included:
 *
 * - **Host** — a `Host` that isn't loopback or named by an allowed origin is
 *   refused (403 `forbidden_host`). A DNS-rebinding page talks to zzzd
 *   same-origin, so it sends no `Origin`, but its `Host` is its own domain.
 * - **Origin** — the backends run with exact origins, as the `.env`
 *   templates ship them, so a page on another `localhost` port — same-site,
 *   so its requests carry the session cookie — is refused (403
 *   `forbidden_origin`), on the WebSocket upgrade too.
 * - **CORS simple requests** — a `POST` with no `Content-Type`, or a form or
 *   text one, is refused (415 `unsupported_content_type`) before anything
 *   reads it: a browser sends those cross-origin with no preflight, carrying
 *   the session cookie from any `localhost` port.
 *
 * Requests go through `node:http`, since `fetch` won't send a chosen `Host`.
 *
 * @module
 */

import { request as http_request } from 'node:http';
import { join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

import { to_file_bytes_url } from '#lib/file_bytes.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

const { base_url, rpc_path } = handle.config;
const port = new URL(base_url).port;
const api_path = rpc_path.replace(/\/rpc$/, '');
const scoped_dir = handle.config.env.PUBLIC_ZZZ_SCOPED_DIRS!;

/** A page on another local port: same-site with zzzd, not an allowed origin. */
const OTHER_PORT_ORIGIN = 'http://localhost:8000';

/** The `Host` a rebinding page sends: its own domain, at the daemon's port. */
const REBOUND_HOST = `rebind.example.com:${port}`;

interface RawResponse {
	status: number;
	body: string;
}

/** Send one request exactly as given — `Host` included — and read the reply. */
const raw_request = (
	path: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawResponse> =>
	new Promise((resolve, reject) => {
		const req = http_request(`${base_url}${path}`, {
			method: options.method ?? 'GET',
			headers: options.headers
		});
		const on_response = (res: import('node:http').IncomingMessage): void => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode!, body }));
		};
		req.on('response', on_response);
		// a 101 would mean the gate let an upgrade through
		req.on('upgrade', (res, socket) => {
			socket.destroy();
			resolve({ status: res.statusCode!, body: '' });
		});
		req.on('error', reject);
		req.end(options.body);
	});

/** A WebSocket upgrade's own headers (the key is RFC 6455's sample). */
const WS_UPGRADE_HEADERS = {
	connection: 'Upgrade',
	upgrade: 'websocket',
	'sec-websocket-version': '13',
	'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
};

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
					...WS_UPGRADE_HEADERS
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
					...WS_UPGRADE_HEADERS
				}
			});
			assert_error(ws, 403, 'forbidden_origin', 'ws upgrade');
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
});
