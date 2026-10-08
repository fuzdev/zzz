import { test, describe, assert } from 'vitest';

import {
	append_file_bytes,
	create_file_bytes,
	to_file_bytes_append_url,
	to_file_bytes_url
} from '$lib/file_bytes.ts';

import { FakeByteRoutes, blob_of } from './byte_route_test_helpers.ts';

describe('to_file_bytes_url', () => {
	test('puts the path in the query, encoded', () => {
		assert.strictEqual(
			to_file_bytes_url('/api', '/w/a b&c=d#e?.webm'),
			'/api/files/bytes?path=%2Fw%2Fa%20b%26c%3Dd%23e%3F.webm'
		);
		assert.strictEqual(
			to_file_bytes_url('http://localhost:4460/api', '/w/é.ogg'),
			'http://localhost:4460/api/files/bytes?path=%2Fw%2F%C3%A9.ogg'
		);
	});

	test('round-trips through URL parsing', () => {
		const path = '/w/a b&c=d#e?+%20.webm';
		const url = new URL(to_file_bytes_url('/api', path), 'http://zzz.test');
		assert.strictEqual(url.searchParams.get('path'), path);
		const append = new URL(to_file_bytes_append_url('/api', path, 42), 'http://zzz.test');
		assert.strictEqual(append.searchParams.get('path'), path);
		assert.strictEqual(append.searchParams.get('offset'), '42');
	});
});

describe('create_file_bytes and append_file_bytes', () => {
	test('create then append, reporting the size', async () => {
		const routes = new FakeByteRoutes();
		assert.deepEqual(await create_file_bytes(routes.fetch, '/api', '/w/a.webm'), {
			ok: true,
			size: 0
		});
		assert.deepEqual(await append_file_bytes(routes.fetch, '/api', '/w/a.webm', 0, blob_of(5)), {
			ok: true,
			size: 5
		});
		assert.deepEqual(
			routes.requests.map((r) => [r.method, r.offset, r.size]),
			[
				['POST', null, 0],
				['PATCH', 0, 5]
			]
		);
	});

	test('a refusal carries the status, the reason, and a size when there is one', async () => {
		const routes = new FakeByteRoutes();
		await create_file_bytes(routes.fetch, '/api', '/w/a.webm', blob_of(3));
		assert.deepEqual(await create_file_bytes(routes.fetch, '/api', '/w/a.webm'), {
			ok: false,
			status: 409,
			reason: 'already_exists'
		});
		assert.deepEqual(await append_file_bytes(routes.fetch, '/api', '/w/a.webm', 9, blob_of(1)), {
			ok: false,
			status: 409,
			reason: 'offset_mismatch',
			size: 3
		});
	});

	test('no answer is a network error with status 0', async () => {
		const routes = new FakeByteRoutes();
		routes.replies.push('network_error');
		assert.deepEqual(await create_file_bytes(routes.fetch, '/api', '/w/a.webm'), {
			ok: false,
			status: 0,
			reason: 'network_error'
		});
	});

	test('a body that is not the expected JSON is an invalid response', async () => {
		const routes = new FakeByteRoutes();
		routes.replies.push({ status: 502, body: null }, { status: 200, body: { nope: true } });
		assert.deepEqual(await create_file_bytes(routes.fetch, '/api', '/w/a.webm'), {
			ok: false,
			status: 502,
			reason: 'invalid_response'
		});
		assert.deepEqual(await create_file_bytes(routes.fetch, '/api', '/w/a.webm'), {
			ok: false,
			status: 200,
			reason: 'invalid_response'
		});
	});
});
