/**
 * Tests that origin verification applies to WebSocket upgrade requests.
 *
 * Browsers always send an Origin header on WebSocket upgrades (spec-enforced,
 * not overridable by JS). The verify_request_source middleware runs for ALL
 * routes including the WebSocket GET, so cross-origin connections are rejected
 * before the upgrade happens.
 */

import {describe, test, assert} from 'vitest';
import {Hono} from 'hono';
import {parse_allowed_origins, verify_request_source} from '@fuzdev/fuz_app/http/origin.js';

import {
	build_allowed_hostnames,
	create_host_validation_middleware,
} from '../../lib/server/security.js';

/**
 * Create a minimal Hono app that mirrors the zzz middleware stack.
 * Uses a plain GET handler at /ws instead of a real WebSocket upgrade
 * (which needs Deno) — what matters is that middleware runs before it.
 */
const create_test_app = (allowed_origins_str: string, bind_host = 'localhost'): Hono => {
	const app = new Hono();
	const allowed_hostnames = build_allowed_hostnames(bind_host);
	app.use(create_host_validation_middleware(allowed_hostnames));
	const allowed_origins = parse_allowed_origins(allowed_origins_str);
	app.use(verify_request_source(allowed_origins));
	// Simulates the WebSocket upgrade handler — if middleware lets the request through,
	// this handler responds 200. In production, upgradeWebSocket would upgrade instead.
	app.get('/ws', (c) => c.json({upgraded: true}));
	app.post('/api/rpc', (c) => c.json({ok: true}));
	return app;
};

const request_ws = async (app: Hono, headers: Record<string, string> = {}): Promise<Response> =>
	await app.request('/ws', {
		method: 'GET',
		headers: {
			Connection: 'Upgrade',
			Upgrade: 'websocket',
			'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'Sec-WebSocket-Version': '13',
			...headers,
		},
	});

const request_rpc = async (app: Hono, headers: Record<string, string> = {}): Promise<Response> =>
	await app.request('/api/rpc', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...headers,
		},
		body: '{}',
	});

describe('WebSocket origin security', () => {
	const app = create_test_app('http://localhost:*');

	describe('cross-origin WebSocket blocked', () => {
		test('rejects WebSocket upgrade from evil.com', async () => {
			const res = await request_ws(app, {
				Host: 'localhost:4460',
				Origin: 'https://evil.com',
			});
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error, 'forbidden_origin');
		});

		test('rejects WebSocket upgrade from attacker localhost lookalike', async () => {
			const res = await request_ws(app, {
				Host: 'localhost:4460',
				Origin: 'http://localhost.evil.com',
			});
			assert.strictEqual(res.status, 403);
		});

		test('rejects WebSocket upgrade from different protocol', async () => {
			const res = await request_ws(app, {
				Host: 'localhost:4460',
				Origin: 'https://localhost:4460',
			});
			assert.strictEqual(res.status, 403);
		});
	});

	describe('same-origin WebSocket allowed', () => {
		test('allows WebSocket upgrade from localhost dev server', async () => {
			const res = await request_ws(app, {
				Host: 'localhost:4460',
				Origin: 'http://localhost:5173',
			});
			assert.strictEqual(res.status, 200);
		});

		test('allows WebSocket upgrade from localhost any port', async () => {
			const res = await request_ws(app, {
				Host: 'localhost:4460',
				Origin: 'http://localhost:4460',
			});
			assert.strictEqual(res.status, 200);
		});

		test('allows WebSocket upgrade from localhost no port', async () => {
			const res = await request_ws(app, {
				Host: 'localhost:4460',
				Origin: 'http://localhost',
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('CLI/tool access (no Origin)', () => {
		test('allows WebSocket upgrade without Origin header', async () => {
			// CLI tools, curl, etc. don't send Origin — allowed through
			const res = await request_ws(app, {
				Host: 'localhost:4460',
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('DNS rebinding defense', () => {
		test('rejects WebSocket with bad Host header', async () => {
			const res = await request_ws(app, {
				Host: 'evil.com:4460',
				Origin: 'http://evil.com:4460',
			});
			// Host validation middleware rejects before origin check
			assert.strictEqual(res.status, 403);
		});

		test('rejects even when origin matches but host does not', async () => {
			// DNS rebinding: evil.com resolves to 127.0.0.1, page sends
			// Origin: http://evil.com, browser sets Host: evil.com
			const res = await request_ws(app, {
				Host: 'evil.com:4460',
				Origin: 'http://localhost:5173',
			});
			assert.strictEqual(res.status, 403);
			const body = await res.json();
			assert.strictEqual(body.error, 'forbidden_host');
		});
	});

	describe('HTTP RPC has same protection', () => {
		test('rejects HTTP RPC from evil origin', async () => {
			const res = await request_rpc(app, {
				Host: 'localhost:4460',
				Origin: 'https://evil.com',
			});
			assert.strictEqual(res.status, 403);
		});

		test('allows HTTP RPC from localhost', async () => {
			const res = await request_rpc(app, {
				Host: 'localhost:4460',
				Origin: 'http://localhost:5173',
			});
			assert.strictEqual(res.status, 200);
		});
	});
});
