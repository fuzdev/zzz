import { describe, test, assert } from 'vitest';

import {
	HEALTH_PATH,
	is_public_route,
	probe_backend,
	to_auth_gate_state,
	to_auth_redirect,
	type AuthGateInput
} from '$lib/auth_gate.ts';

describe('is_public_route', () => {
	test('about and docs, and pages below them, are public', () => {
		for (const pathname of ['/about', '/about/', '/docs', '/docs/', '/docs/api/foo.ts']) {
			assert.ok(is_public_route(pathname), pathname);
		}
	});

	test('prerendered files served without clean URLs are public too', () => {
		for (const pathname of ['/about.html', '/docs.html', '/docs/library.html']) {
			assert.ok(is_public_route(pathname), pathname);
		}
	});

	test('everything else is gated', () => {
		for (const pathname of [
			'/',
			'/chats',
			'/chats.html',
			'/index.html',
			'/aboutx',
			'/aboutx.html',
			'/docsx',
			'/files/docs',
			'/settings'
		]) {
			assert.ok(!is_public_route(pathname), pathname);
		}
	});

	test('takes paths resolved against a base path', () => {
		assert.ok(is_public_route('/zzz/docs/api', ['/zzz/about', '/zzz/docs']));
		assert.ok(!is_public_route('/docs', ['/zzz/about', '/zzz/docs']));
	});
});

describe('to_auth_gate_state', () => {
	const settled: AuthGateInput = {
		session_checked: true,
		backend_checked: true,
		backend_reachable: true,
		verified: false,
		needs_bootstrap: false
	};

	test('checking until both the first session check and the backend probe settle', () => {
		assert.strictEqual(to_auth_gate_state({ ...settled, session_checked: false }), 'checking');
		assert.strictEqual(to_auth_gate_state({ ...settled, backend_checked: false }), 'checking');
	});

	test('a verified session is the app mounting, not a form', () => {
		assert.strictEqual(to_auth_gate_state({ ...settled, verified: true }), 'checking');
	});

	test('no backend says the daemon is needed, never a login form', () => {
		assert.strictEqual(
			to_auth_gate_state({ ...settled, backend_reachable: false }),
			'daemon_unreachable'
		);
		assert.strictEqual(
			to_auth_gate_state({ ...settled, backend_reachable: false, needs_bootstrap: true }),
			'daemon_unreachable'
		);
	});

	test('bootstrap when no account exists, else login', () => {
		assert.strictEqual(to_auth_gate_state({ ...settled, needs_bootstrap: true }), 'bootstrap');
		assert.strictEqual(to_auth_gate_state(settled), 'login');
	});

	test('a login or bootstrap in flight keeps its form (no spinner after the first check)', () => {
		// `AuthState.verifying` isn't an input: only the first check shows `checking`
		assert.strictEqual(to_auth_gate_state(settled), 'login');
		assert.strictEqual(to_auth_gate_state({ ...settled, needs_bootstrap: true }), 'bootstrap');
	});
});

describe('probe_backend', () => {
	const json =
		(body: unknown, status = 200) =>
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			});

	test("the backend's health reply is reachable", async () => {
		assert.ok(await probe_backend(json({ status: 'ok' })));
	});

	test('a static server is not a backend', async () => {
		// no health route
		assert.ok(!(await probe_backend(async () => new Response('not found', { status: 404 }))));
		// an SPA fallback answering every path with the app shell
		assert.ok(
			!(await probe_backend(
				async () =>
					new Response('<!doctype html><html></html>', {
						status: 200,
						headers: { 'content-type': 'text/html' }
					})
			))
		);
		// JSON that isn't the health reply
		assert.ok(!(await probe_backend(json({ status: 'nope' }))));
		assert.ok(!(await probe_backend(json(null))));
	});

	test('errors are unreachable', async () => {
		assert.ok(!(await probe_backend(json({ status: 'ok' }, 502))));
		assert.ok(!(await probe_backend(() => Promise.reject(new TypeError('Failed to fetch')))));
	});

	test('probes the health route by default', () => {
		assert.strictEqual(HEALTH_PATH, '/health');
	});
});

describe('to_auth_redirect', () => {
	test('keeps the path, query, and hash of the page the gate replaced', () => {
		assert.strictEqual(
			to_auth_redirect(new URL('http://localhost:4460/workspaces?workspace=%2Fhome%2Fa#x')),
			'/workspaces?workspace=%2Fhome%2Fa#x'
		);
		assert.strictEqual(to_auth_redirect(new URL('http://localhost:4460/')), '/');
	});

	test('a protocol-relative path returns to the root, never another origin', () => {
		for (const href of [
			'http://localhost:4460//evil.example/x?q=1',
			'http://localhost:4460/\\evil.example/x',
			'http://localhost:4460///evil.example'
		]) {
			const url = new URL(href);
			assert.ok(url.pathname.startsWith('//'), `precondition: ${url.pathname}`);
			assert.strictEqual(to_auth_redirect(url), '/', href);
			assert.strictEqual(to_auth_redirect(url, '/base/'), '/base/', href);
		}
		// a double slash later in the path is just a path
		assert.strictEqual(to_auth_redirect(new URL('http://localhost:4460/a//b')), '/a//b');
	});

	test('a pathname starting with a slash and backslash falls back too', () => {
		// the URL parser normalizes `\` to `/` for http, so feed the pathname directly
		const url = { pathname: '/\\evil.example', search: '', hash: '' } as URL;
		assert.strictEqual(to_auth_redirect(url), '/');
	});
});
