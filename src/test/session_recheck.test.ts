// @vitest-environment jsdom

import { describe, test, assert, vi, afterEach } from 'vitest';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import {
	ACCOUNT_STATUS_PATH,
	create_session_recheck,
	probe_session,
	type SessionProbe
} from '$lib/session_recheck.ts';
import { Frontend } from '$lib/frontend.svelte.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('probe_session', () => {
	test('200 is valid, 401 is invalid', async () => {
		assert.strictEqual(
			await probe_session(async () => new Response('{}', { status: 200 })),
			'valid'
		);
		assert.strictEqual(
			await probe_session(async () => new Response('{}', { status: 401 })),
			'invalid'
		);
	});

	test('other statuses and network failures are unknown', async () => {
		assert.strictEqual(
			await probe_session(async () => new Response('', { status: 502 })),
			'unknown'
		);
		assert.strictEqual(
			await probe_session(async () => new Response('', { status: 500 })),
			'unknown'
		);
		assert.strictEqual(
			await probe_session(() => Promise.reject(new TypeError('Failed to fetch'))),
			'unknown'
		);
	});

	test('defaults to the account status route with credentials', async () => {
		const fetch_spy = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetch_spy);
		await probe_session();
		const [url, init] = fetch_spy.mock.calls[0] as unknown as [string, RequestInit];
		assert.strictEqual(url, ACCOUNT_STATUS_PATH);
		assert.strictEqual(init.credentials, 'include');
	});
});

describe('create_session_recheck', () => {
	test('calls on_invalid only when the probe finds the session invalid', async () => {
		for (const [probe_result, expected] of [
			['invalid', 1],
			['valid', 0],
			['unknown', 0]
		] as Array<[SessionProbe, number]>) {
			let invalid_count = 0;
			const recheck = create_session_recheck({
				probe: async () => probe_result,
				on_invalid: () => {
					invalid_count++;
				}
			});
			await recheck();
			assert.strictEqual(invalid_count, expected, probe_result);
		}
	});

	test('calls on_valid only when the probe finds the session valid', async () => {
		for (const [probe_result, expected] of [
			['invalid', 0],
			['valid', 1],
			['unknown', 0]
		] as Array<[SessionProbe, number]>) {
			let valid_count = 0;
			const recheck = create_session_recheck({
				probe: async () => probe_result,
				on_invalid: () => {},
				on_valid: () => {
					valid_count++;
				}
			});
			await recheck();
			assert.strictEqual(valid_count, expected, probe_result);
		}
	});

	test('concurrent rechecks share one probe', async () => {
		let probes = 0;
		let resolve_probe!: (result: SessionProbe) => void;
		const recheck = create_session_recheck({
			probe: () => {
				probes++;
				return new Promise((resolve) => (resolve_probe = resolve));
			},
			on_invalid: () => {}
		});
		const a = recheck();
		const b = recheck();
		assert.strictEqual(a, b);
		resolve_probe('valid');
		await a;
		assert.strictEqual(probes, 1);

		// a later recheck probes again
		const c = recheck();
		resolve_probe('valid');
		await c;
		assert.strictEqual(probes, 2);
	});

	test('never rejects', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const recheck = create_session_recheck({
			probe: async () => 'invalid',
			on_invalid: () => {
				throw new Error('boom');
			}
		});
		await recheck();
	});
});

describe('Frontend on_unauthenticated', () => {
	const stub_rpc_error = (status: number, code: number): void => {
		vi.stubGlobal('fetch', async (_url: string, init: { body?: string }) => {
			const id = init.body ? JSON.parse(init.body).id : null;
			return new Response(
				JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'no session' } }),
				{ status }
			);
		});
	};

	test('fires when an action fails with unauthenticated', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		stub_rpc_error(401, JSONRPC_ERROR_CODES.unauthenticated);
		let calls = 0;
		const app = new Frontend({
			http_rpc_url: 'http://x/api/rpc',
			on_unauthenticated: () => calls++
		});
		const result = await app.api.diskfile_update({ path: '/a/b.txt' as any, content: 'x' });
		assert.ok(!result.ok);
		assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.unauthenticated);
		assert.strictEqual(calls, 1);
	});

	test('does not fire for other errors', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		stub_rpc_error(403, JSONRPC_ERROR_CODES.forbidden);
		let calls = 0;
		const app = new Frontend({
			http_rpc_url: 'http://x/api/rpc',
			on_unauthenticated: () => calls++
		});
		const result = await app.api.diskfile_update({ path: '/a/b.txt' as any, content: 'x' });
		assert.ok(!result.ok);
		assert.strictEqual(calls, 0);
	});
});

describe('Frontend dispose', () => {
	test('closes the socket so no reconnect loop is left behind', () => {
		const app = new Frontend();
		const disconnect = vi.spyOn(app.socket, 'disconnect');
		app.dispose();
		assert.strictEqual(disconnect.mock.calls.length, 1);
	});
});
