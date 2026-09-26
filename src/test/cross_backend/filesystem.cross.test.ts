/**
 * Cross-backend integration tests for filesystem actions
 * (`diskfile_update`, `diskfile_create`, `diskfile_delete`, `directory_create`) plus the
 * `filer_change` notification path.
 *
 * @module
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	access,
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { request as http_request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { RPC_MESSAGE_MAX_BYTES } from '$lib/rpc_message_limit.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

const scoped_dir = handle.config.env.PUBLIC_ZZZ_SCOPED_DIRS!;
const zzz_dir = handle.config.env.PUBLIC_ZZZ_DIR!;

const file_exists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * POST `body` and resolve the response status. Unlike `fetch`, tolerates the
 * server answering (413) and closing before the upload finishes — the write
 * then fails with `EPIPE` after the response already arrived.
 */
const post_status = (url: string, headers: Record<string, string>, body: string): Promise<number> =>
	new Promise((resolve, reject) => {
		let status: number | undefined;
		const req = http_request(url, { method: 'POST', headers }, (res) => {
			status = res.statusCode;
			res.on('error', () => undefined);
			res.resume();
			res.on('end', () => resolve(status!));
		});
		// the unfinished upload's EPIPE also surfaces on the socket
		req.on('socket', (socket) => socket.on('error', () => undefined));
		req.on('error', (error) => {
			if (status === undefined) reject(error);
			else resolve(status);
		});
		req.end(body);
	});

describe('filesystem cross-backend', () => {
	test('diskfile_update_and_read', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, { recursive: true });
		const file_path = join(scoped_dir, `test_write_${randomUUID()}.txt`);
		const content = 'hello from integration test';
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: { path: file_path, content },
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const actual = await readFile(file_path, 'utf-8');
			assert.equal(actual, content);
		} finally {
			await rm(file_path, { force: true });
		}
	});

	test('diskfile_update_in_zzz_dir', async () => {
		const fixture = await setup_test();
		await mkdir(zzz_dir, { recursive: true });
		const file_path = join(zzz_dir, `test_scoped_write_${randomUUID()}.txt`);
		const content = 'write to zzz_dir';
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: { path: file_path, content },
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const actual = await readFile(file_path, 'utf-8');
			assert.equal(actual, content);
		} finally {
			await rm(file_path, { force: true });
		}
	});

	test('diskfile_update_in_zzz_dir_subdirectory', async () => {
		const fixture = await setup_test();
		const sub_dir = join(zzz_dir, 'state', `sub_${randomUUID()}`);
		await mkdir(sub_dir, { recursive: true });
		const file_path = join(sub_dir, 'new_file.txt');
		const content = 'nested write';
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: { path: file_path, content },
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const actual = await readFile(file_path, 'utf-8');
			assert.equal(actual, content);
		} finally {
			await rm(sub_dir, { recursive: true, force: true });
		}
	});

	test('diskfile_delete', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, { recursive: true });
		const file_path = join(scoped_dir, `test_delete_${randomUUID()}.txt`);
		await writeFile(file_path, 'to be deleted', 'utf-8');

		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_delete',
			params: { path: file_path },
			headers: fixture.create_session_headers()
		});
		assert.ok(res.ok);
		assert.equal(res.result, null);

		assert.ok(!(await file_exists(file_path)), 'file should not exist after delete');
	});

	test('directory_create', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, { recursive: true });
		const dir_path = join(scoped_dir, `nested_${randomUUID()}`, 'deep', 'dir');
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'directory_create',
				params: { path: dir_path },
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const s = await stat(dir_path);
			assert.ok(s.isDirectory(), 'is directory');
		} finally {
			await rm(dir_path, { recursive: true, force: true });
		}
	});

	test('directory_create_never_reuses_an_existing_name', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `existing_dir_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		const create = (path: string) =>
			rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'directory_create',
				params: { path },
				headers: fixture.create_session_headers()
			});
		try {
			const dir_path = join(dir, 'new');
			const first = await create(dir_path);
			assert.ok(first.ok, JSON.stringify(first));
			await writeFile(join(dir_path, 'kept.txt'), 'x', 'utf-8');

			// a taken name fails like `diskfile_create`, whatever holds it
			const file_path = join(dir, 'file.txt');
			await writeFile(file_path, 'x', 'utf-8');
			for (const path of [dir_path, file_path]) {
				const again = await create(path);
				assert.ok(!again.ok, `${path} should fail`);
				assert.equal(again.error.code, JSONRPC_ERROR_CODES.conflict, path);
				assert.deepEqual(again.error.data, { reason: 'already_exists' }, path);
				assert.ok(
					again.error.message.startsWith('failed to create directory: Path already exists'),
					`unexpected message: ${again.error.message}`
				);
			}
			assert.deepEqual(await readdir(dir_path), ['kept.txt'], 'untouched');
			assert.equal(await readFile(file_path, 'utf-8'), 'x', 'untouched');

			// only the final name must be free — existing parents are fine
			const sibling = await create(join(dir, 'new_sibling'));
			assert.ok(sibling.ok, JSON.stringify(sibling));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('diskfile_update_outside_scope', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_update',
			params: { path: '/tmp/zzz_outside_scope/evil.txt', content: 'nope' },
			headers: fixture.create_session_headers()
		});
		assert.ok(!res.ok, 'expected error for out-of-scope write');
		assert.equal(res.error.code, JSONRPC_ERROR_CODES.forbidden);
		assert.deepEqual(res.error.data, { reason: 'path_not_allowed' });
		assert.ok(
			res.error.message.startsWith('failed to write file: Path is not allowed'),
			`unexpected message: ${res.error.message}`
		);
	});

	test('diskfile_update_path_traversal', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_update',
			params: {
				path: `${scoped_dir}/../../../tmp/evil.txt`,
				content: 'nope'
			},
			headers: fixture.create_session_headers()
		});
		assert.ok(!res.ok, 'expected error for traversal');
		assert.equal(res.error.code, JSONRPC_ERROR_CODES.forbidden);
		assert.deepEqual(res.error.data, { reason: 'path_not_allowed' });
	});

	test('diskfile_update_relative_path', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_update',
			params: { path: 'relative/path.txt', content: 'nope' },
			headers: fixture.create_session_headers()
		});
		assert.ok(!res.ok, 'expected invalid_params');
		assert.equal(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
	});

	test('diskfile_delete_nonexistent', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, { recursive: true });
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_delete',
			params: { path: join(scoped_dir, `does_not_exist_${randomUUID()}.txt`) },
			headers: fixture.create_session_headers()
		});
		assert.ok(!res.ok, 'expected error');
		assert.equal(res.error.code, JSONRPC_ERROR_CODES.not_found);
		assert.deepEqual(res.error.data, { reason: 'path_not_found' });
		assert.ok(
			res.error.message.startsWith('failed to delete file:'),
			`unexpected message: ${res.error.message}`
		);
	});

	test('wrong_file_kinds_are_invalid_params', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `kinds_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		try {
			const file_path = join(dir, 'file.txt');
			await writeFile(file_path, 'x', 'utf-8');
			const fifo_path = join(dir, 'fifo');
			execFileSync('mkfifo', [fifo_path]);

			const cases: Array<[string, Record<string, unknown>, string]> = [
				['diskfile_update', { path: dir, content: 'x' }, 'is_a_directory'],
				// a FIFO is refused, not opened — opening one blocks until a reader appears
				['diskfile_update', { path: fifo_path, content: 'x' }, 'not_a_regular_file'],
				['diskfile_delete', { path: dir }, 'is_a_directory'],
				['directory_create', { path: join(file_path, 'sub') }, 'not_a_directory']
			];
			for (const [method, params, reason] of cases) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method,
					params,
					headers: fixture.create_session_headers()
				});
				const label = `${method} ${JSON.stringify(params)}`;
				assert.ok(!res.ok, `${label} should fail`);
				assert.equal(res.error.code, JSONRPC_ERROR_CODES.invalid_params, label);
				assert.deepEqual(res.error.data, { reason }, label);
			}
			assert.ok((await lstat(fifo_path)).isFIFO(), 'the FIFO is left in place');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('diskfile_update_replaces_atomically', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `atomic_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		try {
			const file_path = join(dir, 'script.sh');
			await writeFile(file_path, 'old', 'utf-8');
			await chmod(file_path, 0o750);
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: { path: file_path, content: 'new' },
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok, JSON.stringify(res));
			assert.equal(await readFile(file_path, 'utf-8'), 'new');
			assert.equal((await stat(file_path)).mode & 0o7777, 0o750, 'mode kept');
			assert.deepEqual(await readdir(dir), ['script.sh'], 'no staged temp file left');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('diskfile_create_never_overwrites', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `create_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		const create = (params: Record<string, unknown>) =>
			rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_create',
				params,
				headers: fixture.create_session_headers()
			});
		try {
			const file_path = join(dir, 'sub', 'new.txt');
			const first = await create({ path: file_path, content: 'first' });
			assert.ok(first.ok, JSON.stringify(first));
			assert.equal(first.result, null);
			assert.equal(await readFile(file_path, 'utf-8'), 'first');

			const again = await create({ path: file_path, content: '' });
			assert.ok(!again.ok, 'an existing file is not replaced');
			assert.equal(again.error.code, JSONRPC_ERROR_CODES.conflict);
			assert.deepEqual(again.error.data, { reason: 'already_exists' });
			assert.equal(await readFile(file_path, 'utf-8'), 'first', 'untouched');

			const strict = await create({ path: join(dir, 'x.txt'), content: '', overwrite: true });
			assert.ok(!strict.ok);
			assert.equal(strict.error.code, JSONRPC_ERROR_CODES.invalid_params);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('permissions_are_respected', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `perms_${randomUUID()}`);
		const ro_dir = join(dir, 'rodir');
		await mkdir(ro_dir, { recursive: true });
		const update = (path: string) =>
			rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: { path, content: 'NEW' },
				headers: fixture.create_session_headers()
			});
		try {
			// a rename needs only the directory's permission — the file's is checked too
			const ro_file = join(dir, 'ro.txt');
			await writeFile(ro_file, 'orig', 'utf-8');
			await chmod(ro_file, 0o444);
			const refused = await update(ro_file);
			assert.ok(!refused.ok, 'a read-only file is not replaced');
			assert.equal(refused.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.deepEqual(refused.error.data, { reason: 'permission_denied' });
			assert.equal(await readFile(ro_file, 'utf-8'), 'orig');

			// a writable file in a read-only directory is written in place
			const w_file = join(ro_dir, 'w.txt');
			await writeFile(w_file, 'orig', 'utf-8');
			await chmod(ro_dir, 0o555);
			const in_place = await update(w_file);
			assert.ok(in_place.ok, JSON.stringify(in_place));
			assert.equal(await readFile(w_file, 'utf-8'), 'NEW');

			const created = await update(join(ro_dir, 'new.txt'));
			assert.ok(!created.ok);
			assert.equal(created.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.deepEqual(created.error.data, { reason: 'directory_not_writable' });
			assert.ok(!created.error.message.includes('.zzz-tmp-'), created.error.message);

			const created_dir = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'directory_create',
				params: { path: join(ro_dir, 'sub') },
				headers: fixture.create_session_headers()
			});
			assert.ok(!created_dir.ok);
			assert.equal(created_dir.error.code, JSONRPC_ERROR_CODES.forbidden);
			assert.deepEqual(created_dir.error.data, { reason: 'directory_not_writable' });
		} finally {
			await chmod(ro_dir, 0o755).catch(() => undefined);
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('filesystem_inputs_are_strict', async () => {
		const fixture = await setup_test();
		const path = join(scoped_dir, `strict_${randomUUID()}.txt`);
		const cases: Array<[string, Record<string, unknown>]> = [
			['diskfile_update', { path, content: 'x', extra: true }],
			['diskfile_update', { path, content: null }],
			['diskfile_update', { path }],
			['diskfile_delete', { path, recursive: true }],
			['directory_create', { path: null }]
		];
		for (const [method, params] of cases) {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method,
				params,
				headers: fixture.create_session_headers()
			});
			const label = `${method} ${JSON.stringify(params)}`;
			assert.ok(!res.ok, `${label} should fail`);
			assert.equal(res.error.code, JSONRPC_ERROR_CODES.invalid_params, label);
		}
		assert.ok(!(await file_exists(path)), 'nothing written');
	});

	// the frontend's `RPC_MESSAGE_MAX_BYTES` twins the backend constant of the
	// same name: building both boundary messages from it pins
	// the two together (a lower backend cap fails the "under" writes, a higher
	// one the "over" refusals). Both sides exceed axum's 2 MiB extractor
	// default, which the backend has to lift.
	test('rpc_message_cap_on_both_transports', async () => {
		const fixture = await setup_test();
		const path = join(scoped_dir, `rpc_cap_${randomUUID()}.txt`);
		const under = 'u'.repeat(RPC_MESSAGE_MAX_BYTES - 1024);
		const over = 'o'.repeat(RPC_MESSAGE_MAX_BYTES + 1);
		const ws = await create_ws_transport({
			base_url: handle.config.base_url,
			ws_path: handle.config.ws_path,
			cookies: fixture.transport.cookies()
		});
		try {
			// HTTP: under the cap is written, over it is a 413
			const http_under = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: { path, content: under },
				headers: fixture.create_session_headers()
			});
			assert.ok(http_under.ok, JSON.stringify(http_under).slice(0, 500));
			assert.equal((await stat(path)).size, under.length);

			const http_over = await post_status(
				`${handle.config.base_url}${handle.config.rpc_path}`,
				{
					'Content-Type': 'application/json',
					origin: 'http://localhost:5173',
					...fixture.create_session_headers()
				},
				JSON.stringify({
					jsonrpc: '2.0',
					id: 'over',
					method: 'diskfile_update',
					params: { path, content: over }
				})
			);
			assert.equal(http_over, 413);

			// WebSocket: under the cap is written, over it closes the socket
			await rm(path);
			await ws.request('under', 'diskfile_update', { path, content: under }, 30_000);
			assert.equal((await stat(path)).size, under.length);

			await ws.send({
				jsonrpc: '2.0',
				id: 'over',
				method: 'diskfile_update',
				params: { path, content: over }
			});
			assert.ok(await ws.wait_for_close(10_000), 'an oversized message closes the socket');
			assert.equal((await stat(path)).size, under.length, 'not written');
		} finally {
			await ws.close().catch(() => undefined);
			await rm(path, { force: true });
		}
	});

	test('filer_change_on_file_create', async () => {
		const fixture = await setup_test();
		const tmp_dir = join(tmpdir(), `zzz_cross_filer_${randomUUID()}`);
		await mkdir(tmp_dir, { recursive: true });
		try {
			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(open.ok);

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fixture.transport.cookies()
			});
			try {
				await ws.request('_warmup', 'ping', undefined);

				const new_file = join(tmp_dir, `filer_test_${randomUUID()}.txt`);
				await writeFile(new_file, 'hello from filer test', 'utf-8');

				const msg = await ws.wait_for<Record<string, unknown>>((m) => {
					if (!m || typeof m !== 'object') return false;
					const rec = m as Record<string, unknown>;
					if (rec.method !== 'filer_change') return false;
					const params = rec.params as Record<string, unknown> | undefined;
					const change = params?.change as Record<string, unknown> | undefined;
					return typeof change?.path === 'string' && typeof change?.type === 'string';
				}, 10_000);
				assert.ok(msg, 'received filer_change notification');
			} finally {
				await ws.close();
			}

			await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			}).catch(() => undefined);
		} finally {
			await rm(tmp_dir, { recursive: true, force: true });
		}
	});

	test('filer_change_on_rename', async () => {
		const fixture = await setup_test();
		const tmp_dir = join(tmpdir(), `zzz_cross_filer_rename_${randomUUID()}`);
		await mkdir(tmp_dir, { recursive: true });
		const old_path = join(tmp_dir, 'old.txt');
		const new_path = join(tmp_dir, 'new.txt');
		await writeFile(old_path, 'renamed', 'utf-8');
		try {
			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(open.ok);

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fixture.transport.cookies()
			});
			try {
				await ws.request('_warmup', 'ping', undefined);

				await rename(old_path, new_path);

				const is_filer_change = (type: string, path: string) => (m: unknown) => {
					if (!m || typeof m !== 'object') return false;
					const rec = m as Record<string, unknown>;
					if (rec.method !== 'filer_change') return false;
					const change = (rec.params as Record<string, unknown> | undefined)?.change as
						Record<string, unknown> | undefined;
					return change?.type === type && change.path === path;
				};
				// the old path is deleted (not left as a contentless ghost), the new one added
				await ws.wait_for(is_filer_change('delete', old_path), 10_000);
				const added = await ws.wait_for<Record<string, unknown>>(
					is_filer_change('add', new_path),
					10_000
				);
				const disknode = (added.params as Record<string, unknown>).disknode as Record<
					string,
					unknown
				>;
				assert.equal(disknode.contents, 'renamed');
			} finally {
				await ws.close();
			}

			await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_close',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			}).catch(() => undefined);
		} finally {
			await rm(tmp_dir, { recursive: true, force: true });
		}
	});
});
