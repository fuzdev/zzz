/**
 * Cross-backend tests for the built-frontend serving (`--static-dir` /
 * `ZZZ_STATIC_DIR`) through the full `zzz_server` router.
 *
 * The `cross_backend_rust` backend serves `STATIC_FIXTURE_FILES`, a
 * miniature adapter-static build. Covers the resolution order (exact file →
 * prerendered `{path}.html` → the `200.html` SPA shell), that backend paths and
 * missing `_app/` assets 404 instead of getting the shell, and the cache
 * headers.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { describe, test, inject, assert } from 'vitest';
import { reconstruct_bootstrapped_handle } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';

import './cross_test_types.ts';
import { STATIC_FIXTURE_FILES } from './zzz_backend_config.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const { base_url } = handle.config;

const FALLBACK = STATIC_FIXTURE_FILES['200.html'];

const fetch_path = (path: string, init?: RequestInit): Promise<Response> =>
	fetch(`${base_url}${path}`, { redirect: 'manual', ...init });

const assert_html = async (path: string, expected: string): Promise<void> => {
	const res = await fetch_path(path);
	assert.strictEqual(res.status, 200, path);
	assert.strictEqual(await res.text(), expected, path);
	assert.ok(res.headers.get('content-type')?.startsWith('text/html'), path);
	assert.strictEqual(res.headers.get('cache-control'), 'no-cache', path);
};

describe('static frontend serving', () => {
	test('root and prerendered pages serve their html', async () => {
		await assert_html('/', STATIC_FIXTURE_FILES['index.html']);
		await assert_html('/chats', STATIC_FIXTURE_FILES['chats.html']);
		await assert_html('/docs/api', STATIC_FIXTURE_FILES['docs/api.html']);
		// a page beside its same-named directory — not redirected to `/docs/`
		await assert_html('/docs', STATIC_FIXTURE_FILES['docs.html']);
	});

	test('other routes get the SPA fallback, query intact', async () => {
		await assert_html(`/chats/${randomUUID()}`, FALLBACK);
		await assert_html('/workspaces?workspace=/tmp/', FALLBACK);
		await assert_html('/docs/', FALLBACK);
	});

	test('HEAD resolves like GET', async () => {
		const res = await fetch_path(`/chats/${randomUUID()}`, { method: 'HEAD' });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.headers.get('content-length'), String(FALLBACK.length));
		assert.strictEqual(await res.text(), '');
	});

	test('immutable assets are cached for good', async () => {
		const res = await fetch_path('/_app/immutable/x.js');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(await res.text(), STATIC_FIXTURE_FILES['_app/immutable/x.js']);
		assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
	});

	test('a missing asset 404s instead of getting the fallback', async () => {
		const res = await fetch_path('/_app/immutable/missing.js');
		assert.strictEqual(res.status, 404);
		assert.strictEqual(await res.text(), '');
	});

	test('backend paths never get the fallback', async () => {
		for (const path of ['/api', '/api/nope', '/health/nope']) {
			const res = await fetch_path(path);
			assert.strictEqual(res.status, 404, path);
			assert.strictEqual(await res.text(), '', path);
		}
		const health = await fetch_path('/health');
		assert.deepStrictEqual(await health.json(), { status: 'ok' });
	});

	test('non-GET methods are refused', async () => {
		const res = await fetch_path('/chats', { method: 'POST' });
		assert.strictEqual(res.status, 405);
		assert.strictEqual(res.headers.get('allow'), 'GET, HEAD');
	});
});
