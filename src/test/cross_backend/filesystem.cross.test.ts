/**
 * Cross-backend integration tests for filesystem actions
 * (`diskfile_update`, `diskfile_delete`, `directory_create`) plus the
 * `filer_change` notification path.
 *
 * @module
 */

import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {access, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {describe, test, inject, assert} from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {rpc_call} from '@fuzdev/fuz_app/testing/rpc_helpers.js';
import {create_ws_transport} from '@fuzdev/fuz_app/testing/transports/ws_transport.js';

import './cross_test_types.js';

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

describe('filesystem cross-backend', () => {
	test('diskfile_update_and_read', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, {recursive: true});
		const file_path = join(scoped_dir, `test_write_${randomUUID()}.txt`);
		const content = 'hello from integration test';
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: {path: file_path, content},
				headers: fixture.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const actual = await readFile(file_path, 'utf-8');
			assert.equal(actual, content);
		} finally {
			await rm(file_path, {force: true});
		}
	});

	test('diskfile_update_in_zzz_dir', async () => {
		const fixture = await setup_test();
		await mkdir(zzz_dir, {recursive: true});
		const file_path = join(zzz_dir, `test_scoped_write_${randomUUID()}.txt`);
		const content = 'write to zzz_dir';
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: {path: file_path, content},
				headers: fixture.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const actual = await readFile(file_path, 'utf-8');
			assert.equal(actual, content);
		} finally {
			await rm(file_path, {force: true});
		}
	});

	test('diskfile_update_in_zzz_dir_subdirectory', async () => {
		const fixture = await setup_test();
		const sub_dir = join(zzz_dir, 'state', `sub_${randomUUID()}`);
		await mkdir(sub_dir, {recursive: true});
		const file_path = join(sub_dir, 'new_file.txt');
		const content = 'nested write';
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_update',
				params: {path: file_path, content},
				headers: fixture.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const actual = await readFile(file_path, 'utf-8');
			assert.equal(actual, content);
		} finally {
			await rm(sub_dir, {recursive: true, force: true});
		}
	});

	test('diskfile_delete', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, {recursive: true});
		const file_path = join(scoped_dir, `test_delete_${randomUUID()}.txt`);
		await writeFile(file_path, 'to be deleted', 'utf-8');

		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_delete',
			params: {path: file_path},
			headers: fixture.create_session_headers(),
		});
		assert.ok(res.ok);
		assert.equal(res.result, null);

		assert.ok(!(await file_exists(file_path)), 'file should not exist after delete');
	});

	test('directory_create', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, {recursive: true});
		const dir_path = join(scoped_dir, `nested_${randomUUID()}`, 'deep', 'dir');
		try {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'directory_create',
				params: {path: dir_path},
				headers: fixture.create_session_headers(),
			});
			assert.ok(res.ok);
			assert.equal(res.result, null);

			const s = await stat(dir_path);
			assert.ok(s.isDirectory(), 'is directory');
		} finally {
			await rm(dir_path, {recursive: true, force: true});
		}
	});

	test('directory_create_already_exists', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, {recursive: true});
		const dir_path = join(scoped_dir, `idempotent_dir_${randomUUID()}`);
		try {
			const r1 = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'directory_create',
				params: {path: dir_path},
				headers: fixture.create_session_headers(),
			});
			assert.ok(r1.ok);

			const r2 = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'directory_create',
				params: {path: dir_path},
				headers: fixture.create_session_headers(),
			});
			assert.ok(r2.ok);
			assert.equal(r2.result, null);
		} finally {
			await rm(dir_path, {recursive: true, force: true});
		}
	});

	test('diskfile_update_outside_scope', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_update',
			params: {path: '/tmp/zzz_outside_scope/evil.txt', content: 'nope'},
			headers: fixture.create_session_headers(),
		});
		assert.ok(!res.ok, 'expected error for out-of-scope write');
		assert.equal(res.error.code, -32603);
		assert.ok(
			res.error.message.startsWith('failed to write file:'),
			`unexpected message: ${res.error.message}`,
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
				content: 'nope',
			},
			headers: fixture.create_session_headers(),
		});
		assert.ok(!res.ok, 'expected error for traversal');
		assert.equal(res.error.code, -32603);
	});

	test('diskfile_update_relative_path', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_update',
			params: {path: 'relative/path.txt', content: 'nope'},
			headers: fixture.create_session_headers(),
		});
		assert.ok(!res.ok, 'expected invalid_params');
		assert.equal(res.error.code, -32602);
	});

	test('diskfile_delete_nonexistent', async () => {
		const fixture = await setup_test();
		await mkdir(scoped_dir, {recursive: true});
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'diskfile_delete',
			params: {path: join(scoped_dir, `does_not_exist_${randomUUID()}.txt`)},
			headers: fixture.create_session_headers(),
		});
		assert.ok(!res.ok, 'expected error');
		assert.equal(res.error.code, -32603);
	});

	test('filer_change_on_file_create', async () => {
		const fixture = await setup_test();
		const tmp_dir = join(tmpdir(), `zzz_cross_filer_${randomUUID()}`);
		await mkdir(tmp_dir, {recursive: true});
		try {
			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'workspace_open',
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			});
			assert.ok(open.ok);

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fixture.transport.cookies(),
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
				params: {path: tmp_dir},
				headers: fixture.create_session_headers(),
			}).catch(() => undefined);
		} finally {
			await rm(tmp_dir, {recursive: true, force: true});
		}
	});
});
