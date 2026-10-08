import { test, describe, assert } from 'vitest';

import { ChunkUpload, CHUNK_UPLOAD_RETRY_DELAYS } from '$lib/chunk_upload.ts';

import { FakeByteRoutes, blob_of } from './byte_route_test_helpers.ts';

const PATH = '/w/recording.webm';

interface Harness {
	routes: FakeByteRoutes;
	upload: ChunkUpload;
	progress: Array<number>;
	errors: Array<string>;
	slept: Array<number>;
}

const create_harness = (retry_delays?: ReadonlyArray<number>): Harness => {
	const routes = new FakeByteRoutes();
	const progress: Array<number> = [];
	const errors: Array<string> = [];
	const slept: Array<number> = [];
	const upload = new ChunkUpload({
		fetch: routes.fetch,
		api_url: '/api',
		path: PATH,
		on_progress: (bytes) => progress.push(bytes),
		on_error: (message) => errors.push(message),
		retry_delays,
		sleep: (ms) => {
			slept.push(ms);
			return Promise.resolve();
		}
	});
	return { routes, upload, progress, errors, slept };
};

describe('ChunkUpload', () => {
	test('creates the file, then appends chunks in order at growing offsets', async () => {
		const { routes, upload, progress } = create_harness();
		await upload.create();
		upload.enqueue(blob_of(10));
		upload.enqueue(blob_of(20));
		upload.enqueue(blob_of(5));
		await upload.flush();

		assert.deepEqual(
			routes.requests.map((r) => [r.method, r.offset, r.size]),
			[
				['POST', null, 0],
				['PATCH', 0, 10],
				['PATCH', 10, 20],
				['PATCH', 30, 5]
			]
		);
		assert.strictEqual(routes.size_of(PATH), 35);
		assert.strictEqual(upload.uploaded_bytes, 35);
		assert.deepEqual(progress, [10, 30, 35]);
	});

	test('create fails on a taken path', async () => {
		const { routes, upload } = create_harness();
		routes.files.set(PATH, []);
		let message = '';
		try {
			await upload.create();
		} catch (error) {
			message = (error as Error).message;
		}
		assert.strictEqual(message, 'already exists');
	});

	test('skips empty chunks', async () => {
		const { routes, upload } = create_harness();
		await upload.create();
		upload.enqueue(blob_of(0));
		await upload.flush();
		assert.strictEqual(routes.requests.length, 1);
	});

	test('retries a request that got no answer, then carries on', async () => {
		const { routes, upload, slept } = create_harness();
		await upload.create();
		routes.replies.push('network_error', { status: 503, body: { error: 'unavailable' } });
		upload.enqueue(blob_of(10));
		upload.enqueue(blob_of(10));
		await upload.flush();

		assert.strictEqual(routes.size_of(PATH), 20);
		assert.deepEqual(slept, CHUNK_UPLOAD_RETRY_DELAYS.slice(0, 2));
		// every attempt of the first chunk used the same offset
		assert.deepEqual(
			routes.requests.slice(1).map((r) => r.offset),
			[0, 0, 0, 10]
		);
	});

	test('a chunk that landed with its reply lost is not appended twice', async () => {
		const { routes, upload, progress } = create_harness();
		await upload.create();
		routes.replies.push('lose_reply');
		upload.enqueue(blob_of(10));
		upload.enqueue(blob_of(4));
		await upload.flush();

		// the retry got `offset_mismatch` with the size the chunk would leave
		assert.strictEqual(routes.size_of(PATH), 14);
		assert.strictEqual(routes.files.get(PATH)!.length, 2);
		assert.deepEqual(progress, [10, 14]);
		assert.strictEqual(upload.error, null);
	});

	test('fails when the file changed underneath, and drops what follows', async () => {
		const { routes, upload, errors } = create_harness();
		await upload.create();
		routes.files.get(PATH)!.push(blob_of(3)); // something else wrote to it
		upload.enqueue(blob_of(10));
		upload.enqueue(blob_of(10));

		let message = '';
		try {
			await upload.flush();
		} catch (error) {
			message = (error as Error).message;
		}
		assert.include(message, 'changed on disk');
		assert.deepEqual(errors, [message]);
		assert.strictEqual(routes.size_of(PATH), 3, 'nothing appended');
		// one attempt for the first chunk, none for the second
		assert.strictEqual(routes.requests.filter((r) => r.method === 'PATCH').length, 1);
	});

	test('fails at once on a refusal that a retry can not fix', async () => {
		const { routes, upload, errors, slept } = create_harness();
		await upload.create();
		routes.replies.push({ status: 401, body: { error: 'authentication_required' } });
		upload.enqueue(blob_of(10));
		let message = '';
		try {
			await upload.flush();
		} catch (error) {
			message = (error as Error).message;
		}
		assert.strictEqual(message, 'authentication_required');
		assert.deepEqual(errors, ['authentication_required']);
		assert.deepEqual(slept, []);
	});

	test('gives up once the retries run out', async () => {
		const { routes, upload, errors, slept } = create_harness([1, 2]);
		await upload.create();
		routes.replies.push('network_error', 'network_error', 'network_error');
		upload.enqueue(blob_of(10));
		let message = '';
		try {
			await upload.flush();
		} catch (error) {
			message = (error as Error).message;
		}
		assert.strictEqual(message, 'network_error');
		assert.deepEqual(errors, ['network_error']);
		assert.deepEqual(slept, [1, 2]);
		assert.strictEqual(routes.size_of(PATH), 0);
	});
});
