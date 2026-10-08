/**
 * Cross-backend integration tests for the file byte routes
 * (`GET` / `HEAD` / `POST` / `PATCH` on `/api/files/bytes`): reads with
 * `Range`, the response-header lockdown, exclusive create, offset-checked
 * append, and the gates in front of all of them. The routes are hand-written,
 * outside the action system, so their auth posture is pinned here directly.
 *
 * @module
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

import {
	FILE_BYTES_MAX_BODY_BYTES,
	to_file_bytes_append_url,
	to_file_bytes_url
} from '$lib/file_bytes.ts';

import './cross_test_types.ts';
import { request_status } from './request_status.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

const scoped_dir = handle.config.env.PUBLIC_ZZZ_SCOPED_DIRS!;

const api_path = handle.config.rpc_path.replace(/\/rpc$/, '');
const bytes_url = (path: string): string => to_file_bytes_url(api_path, path);
const append_url = (path: string, offset: number): string =>
	to_file_bytes_append_url(api_path, path, offset);

/** Bytes that are not valid UTF-8, like the head of a media file. */
const BINARY = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x00, 0x80, 0xfe, 0x0a, 0x0d]);

const new_path = async (name: string): Promise<string> => {
	await mkdir(scoped_dir, { recursive: true });
	return join(scoped_dir, `${randomUUID()}_${name}`);
};

const file_exists = async (path: string): Promise<boolean> => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

const read_bytes = async (res: Response): Promise<Uint8Array> =>
	new Uint8Array(await res.arrayBuffer());

/** The headers every byte-route response must carry. */
const assert_locked_down = (res: Response): void => {
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
	assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
	assert.equal(res.headers.get('cache-control'), 'no-store');
};

describe('file bytes cross-backend', () => {
	describe('read', () => {
		test('serves a media file whole, typed by its extension', async () => {
			const fixture = await setup_test();
			const path = await new_path('clip.webm');
			await writeFile(path, BINARY);
			try {
				const res = await fixture.transport(bytes_url(path), {
					headers: fixture.create_session_headers()
				});
				assert.equal(res.status, 200);
				assert.equal(res.headers.get('content-type'), 'video/webm');
				assert.equal(res.headers.get('content-length'), String(BINARY.length));
				assert.equal(res.headers.get('accept-ranges'), 'bytes');
				assert.equal(res.headers.get('content-disposition'), null);
				assert_locked_down(res);
				assert.deepEqual(await read_bytes(res), BINARY);
			} finally {
				await rm(path, { force: true });
			}
		});

		test('serves documents and scripts as downloads, never as a page', async () => {
			const fixture = await setup_test();
			for (const name of ['page.html', 'drawing.svg', 'feed.xml', 'script.js', 'notes.txt']) {
				const path = await new_path(name);
				await writeFile(path, '<script>alert(1)</script>');
				try {
					const res = await fixture.transport(bytes_url(path), {
						headers: fixture.create_session_headers()
					});
					assert.equal(res.status, 200, name);
					assert.equal(res.headers.get('content-type'), 'application/octet-stream', name);
					assert.match(res.headers.get('content-disposition') ?? '', /^attachment; /, name);
					assert_locked_down(res);
					await res.arrayBuffer();
				} finally {
					await rm(path, { force: true });
				}
			}
		});

		test('honors a single byte range', async () => {
			const fixture = await setup_test();
			const path = await new_path('ranged.ogg');
			const content = new Uint8Array(1000).map((_, i) => i % 251);
			await writeFile(path, content);
			const get = (range: string): Promise<Response> =>
				fixture.transport(bytes_url(path), {
					headers: { ...fixture.create_session_headers(), range }
				});
			try {
				const middle = await get('bytes=100-199');
				assert.equal(middle.status, 206);
				assert.equal(middle.headers.get('content-range'), 'bytes 100-199/1000');
				assert.equal(middle.headers.get('content-length'), '100');
				assert.equal(middle.headers.get('content-type'), 'audio/ogg');
				assert_locked_down(middle);
				assert.deepEqual(await read_bytes(middle), content.slice(100, 200));

				const open_ended = await get('bytes=990-');
				assert.equal(open_ended.status, 206);
				assert.equal(open_ended.headers.get('content-range'), 'bytes 990-999/1000');
				assert.deepEqual(await read_bytes(open_ended), content.slice(990));

				const suffix = await get('bytes=-10');
				assert.equal(suffix.status, 206);
				assert.equal(suffix.headers.get('content-range'), 'bytes 990-999/1000');
				assert.deepEqual(await read_bytes(suffix), content.slice(990));

				const past_end = await get('bytes=1000-');
				assert.equal(past_end.status, 416);
				assert.equal(past_end.headers.get('content-range'), 'bytes */1000');
				assert_locked_down(past_end);
				await past_end.arrayBuffer();

				// several ranges aren't supported: the whole file is served
				const several = await get('bytes=0-1,5-6');
				assert.equal(several.status, 200);
				assert.equal((await read_bytes(several)).length, 1000);
			} finally {
				await rm(path, { force: true });
			}
		});

		test('answers HEAD with the headers and no body', async () => {
			const fixture = await setup_test();
			const path = await new_path('head.mp3');
			await writeFile(path, BINARY);
			try {
				const res = await fixture.transport(bytes_url(path), {
					method: 'HEAD',
					headers: fixture.create_session_headers()
				});
				assert.equal(res.status, 200);
				assert.equal(res.headers.get('content-type'), 'audio/mpeg');
				assert.equal(res.headers.get('content-length'), String(BINARY.length));
				assert.equal((await read_bytes(res)).length, 0);
			} finally {
				await rm(path, { force: true });
			}
		});

		test('refuses paths it must not serve', async () => {
			const fixture = await setup_test();
			const outside_dir = await mkdtemp(join(tmpdir(), 'zzz_bytes_outside_'));
			const outside = join(outside_dir, 'secret.txt');
			await writeFile(outside, 'secret');
			const target = await new_path('target.txt');
			await writeFile(target, 'target');
			const link = await new_path('link.txt');
			await symlink(target, link);
			const directory = await new_path('dir');
			await mkdir(directory);
			const expect = async (path: string, status: number, error: string): Promise<void> => {
				const res = await fixture.transport(bytes_url(path), {
					headers: fixture.create_session_headers()
				});
				assert.equal(res.status, status, path);
				assert.deepEqual(await res.json(), { error }, path);
				assert_locked_down(res);
			};
			try {
				await expect(outside, 403, 'path_not_allowed');
				await expect(`${scoped_dir}/../${randomUUID()}`, 403, 'path_not_allowed');
				await expect('relative/path.txt', 400, 'invalid_path');
				await expect(link, 403, 'symlink_not_allowed');
				await expect(directory, 400, 'is_a_directory');
				await expect(await new_path('missing.txt'), 404, 'path_not_found');
			} finally {
				await rm(outside_dir, { recursive: true, force: true });
				await rm(link, { force: true });
				await rm(target, { force: true });
				await rm(directory, { recursive: true, force: true });
			}
		});
	});

	describe('create and append', () => {
		test('creates a file from bytes, exclusively', async () => {
			const fixture = await setup_test();
			const path = join(await new_path('nested'), 'deep', 'clip.webm');
			try {
				const created = await fixture.transport(bytes_url(path), {
					method: 'POST',
					headers: fixture.create_session_headers(),
					body: BINARY
				});
				assert.equal(created.status, 201);
				assert.deepEqual(await created.json(), { size: BINARY.length });
				assert_locked_down(created);
				assert.deepEqual(new Uint8Array(await readFile(path)), BINARY);

				const again = await fixture.transport(bytes_url(path), {
					method: 'POST',
					headers: fixture.create_session_headers(),
					body: new Uint8Array([1, 2, 3])
				});
				assert.equal(again.status, 409);
				assert.deepEqual(await again.json(), { error: 'already_exists' });
				assert.deepEqual(new Uint8Array(await readFile(path)), BINARY, 'untouched');
			} finally {
				await rm(join(path, '..', '..'), { recursive: true, force: true });
			}
		});

		test('appends only at the expected offset', async () => {
			const fixture = await setup_test();
			const path = await new_path('growing.webm');
			const append = (offset: number, body: Uint8Array<ArrayBuffer>): Promise<Response> =>
				fixture.transport(append_url(path, offset), {
					method: 'PATCH',
					headers: fixture.create_session_headers(),
					body
				});
			try {
				// an empty create, then chunks
				const created = await fixture.transport(bytes_url(path), {
					method: 'POST',
					headers: fixture.create_session_headers()
				});
				assert.equal(created.status, 201);
				assert.deepEqual(await created.json(), { size: 0 });

				const first = await append(0, BINARY);
				assert.equal(first.status, 200);
				assert.deepEqual(await first.json(), { size: BINARY.length });
				assert_locked_down(first);
				const second = await append(BINARY.length, new Uint8Array([7, 8]));
				assert.deepEqual(await second.json(), { size: BINARY.length + 2 });

				// a retried chunk and a skipped one write nothing and report the size
				for (const stale of [BINARY.length, 0, 999]) {
					const res = await append(stale, new Uint8Array([9]));
					assert.equal(res.status, 409, String(stale));
					assert.deepEqual(await res.json(), {
						error: 'offset_mismatch',
						size: BINARY.length + 2
					});
				}
				assert.deepEqual(new Uint8Array(await readFile(path)), new Uint8Array([...BINARY, 7, 8]));
			} finally {
				await rm(path, { force: true });
			}
		});

		test('append never creates a file, and needs a valid offset', async () => {
			const fixture = await setup_test();
			const path = await new_path('absent.webm');
			const patch = (url: string): Promise<Response> =>
				fixture.transport(url, {
					method: 'PATCH',
					headers: fixture.create_session_headers(),
					body: BINARY
				});
			const missing = await patch(append_url(path, 0));
			assert.equal(missing.status, 404);
			assert.deepEqual(await missing.json(), { error: 'path_not_found' });
			assert.ok(!(await file_exists(path)), 'nothing created');

			for (const query of [
				'',
				'&offset=',
				'&offset=-1',
				'&offset=1.5',
				'&offset=+1',
				'&offset=x'
			]) {
				const res = await patch(bytes_url(path) + query);
				assert.equal(res.status, 400, query);
				assert.deepEqual(await res.json(), { error: 'invalid_query_params' }, query);
			}
		});

		// the frontend's `FILE_BYTES_MAX_BODY_BYTES` twins the backend constant
		// of the same name: a body of exactly the cap is written, one byte more
		// is refused
		test('caps one request body', async () => {
			const fixture = await setup_test();
			const path = await new_path('big.bin');
			try {
				const at_cap = await fixture.transport(bytes_url(path), {
					method: 'POST',
					headers: fixture.create_session_headers(),
					body: new Uint8Array(FILE_BYTES_MAX_BODY_BYTES)
				});
				assert.equal(at_cap.status, 201);
				assert.equal((await stat(path)).size, FILE_BYTES_MAX_BODY_BYTES);

				const over = await request_status(
					`${handle.config.base_url}${append_url(path, FILE_BYTES_MAX_BODY_BYTES)}`,
					{ origin: handle.config.base_url, ...fixture.create_session_headers() },
					new Uint8Array(FILE_BYTES_MAX_BODY_BYTES + 1),
					'PATCH'
				);
				assert.equal(over, 413);
				assert.equal((await stat(path)).size, FILE_BYTES_MAX_BODY_BYTES, 'nothing appended');
			} finally {
				await rm(path, { force: true });
			}
		});
	});

	describe('gates', () => {
		test('refuses a malformed query before anything else', async () => {
			const fixture = await setup_test();
			const path = await new_path('query.txt');
			const anonymous = fixture.fresh_transport();
			for (const url of [
				`${api_path}/files/bytes`,
				`${bytes_url(path)}&extra=1`,
				// `offset` belongs to the append alone
				`${bytes_url(path)}&offset=0`
			]) {
				// the same answer with and without credentials
				for (const transport of [fixture.transport, anonymous]) {
					const res = await transport(url, {});
					assert.equal(res.status, 400, url);
					assert.deepEqual(await res.json(), { error: 'invalid_query_params' }, url);
				}
			}
		});

		test('requires authentication on every method', async () => {
			const fixture = await setup_test();
			const path = await new_path('anonymous.webm');
			await writeFile(path, BINARY);
			const anonymous = fixture.fresh_transport();
			try {
				for (const [method, url] of [
					['GET', bytes_url(path)],
					['HEAD', bytes_url(path)],
					['POST', bytes_url(await new_path('never.webm'))],
					['PATCH', append_url(path, BINARY.length)]
				] as const) {
					const res = await anonymous(url, {
						method,
						body: method === 'POST' || method === 'PATCH' ? BINARY : undefined
					});
					assert.equal(res.status, 401, method);
					if (method !== 'HEAD') {
						assert.deepEqual(await res.json(), { error: 'authentication_required' }, method);
					}
				}
				assert.deepEqual(new Uint8Array(await readFile(path)), BINARY, 'nothing appended');
			} finally {
				await rm(path, { force: true });
			}
		});

		// a media element's same-origin `src` request carries the session cookie
		// and no `Origin` header
		test('serves a session request that has no Origin header', async () => {
			const fixture = await setup_test();
			const path = await new_path('no_origin.webm');
			await writeFile(path, BINARY);
			try {
				const res = await fixture.fresh_transport({ origin: null })(bytes_url(path), {
					headers: { ...fixture.create_session_headers(), range: 'bytes=0-' }
				});
				assert.equal(res.status, 206);
				assert.deepEqual(await read_bytes(res), BINARY);
			} finally {
				await rm(path, { force: true });
			}
		});

		test('refuses an origin outside the allowlist', async () => {
			const fixture = await setup_test();
			const path = await new_path('origin.webm');
			await writeFile(path, BINARY);
			try {
				for (const method of ['GET', 'POST', 'PATCH'] as const) {
					const res = await fixture.transport(
						method === 'PATCH' ? append_url(path, BINARY.length) : bytes_url(path),
						{
							method,
							headers: { ...fixture.create_session_headers(), origin: 'https://evil.example' },
							body: method === 'GET' ? undefined : BINARY
						}
					);
					assert.equal(res.status, 403, method);
					await res.arrayBuffer();
				}
				assert.deepEqual(new Uint8Array(await readFile(path)), BINARY, 'nothing written');
			} finally {
				await rm(path, { force: true });
			}
		});

		test('admits a full-scope bearer token and refuses a method-scoped one', async () => {
			const fixture = await setup_test();
			const path = await new_path('bearer.webm');
			await writeFile(path, BINARY);
			// no Origin, or the bearer is discarded as browser context
			const bearer_only = fixture.fresh_transport({ origin: null });
			try {
				const full = await bearer_only(bytes_url(path), {
					headers: fixture.create_bearer_headers()
				});
				assert.equal(full.status, 200);
				assert.deepEqual(await read_bytes(full), BINARY);

				const minted = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'account_token_create',
					params: {
						scope: { kind: 'methods', methods: ['diskfile_update', 'diskfile_create'] },
						lifetime: { kind: 'eternal' }
					},
					headers: fixture.create_session_headers()
				});
				assert.ok(minted.ok, JSON.stringify(minted));
				const narrowed = { authorization: `Bearer ${(minted.result as { token: string }).token}` };
				for (const [method, url] of [
					['GET', bytes_url(path)],
					['POST', bytes_url(await new_path('never.webm'))],
					['PATCH', append_url(path, BINARY.length)]
				] as const) {
					const res = await bearer_only(url, {
						method,
						headers: narrowed,
						body: method === 'GET' ? undefined : BINARY
					});
					assert.equal(res.status, 403, method);
					assert.deepEqual(
						await res.json(),
						{ error: 'token_scope_required', required_scope: 'surface:file_bytes' },
						method
					);
				}
				assert.deepEqual(new Uint8Array(await readFile(path)), BINARY, 'nothing appended');
			} finally {
				await rm(path, { force: true });
			}
		});
	});
});
