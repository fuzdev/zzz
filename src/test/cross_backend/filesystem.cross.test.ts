/**
 * Cross-backend integration tests for filesystem actions
 * (`diskfile_read`, `diskfile_update`, `diskfile_create`, `diskfile_delete`,
 * `diskfile_rename`, `directory_create`) plus the `filer_change` notification
 * path.
 *
 * @module
 */

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	access,
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, test, assert } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { raw_http_send_head } from '@fuzdev/fuz_app/testing/transports/raw_http.ts';
import { TEST_ORIGIN } from '@fuzdev/fuz_app/testing/test_origin.ts';
import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';

import {
	DiskfileReadOutput,
	DiskfileRenameOutput,
	DiskfileUpdateOutput,
	FilerChangeInput
} from '#lib/action_specs.ts';
import { RPC_MESSAGE_MAX_BYTES } from '#lib/rpc_message_limit.ts';

import { parse_snapshot_files } from '../diskfile_test_helpers.ts';

const handle = inject_backend_handle();
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
			// the written bytes' BLAKE3, bare lowercase hex
			assert.deepEqual(res.result, { hash: hash_blake3(content) });

			const actual = await readFile(file_path, 'utf-8');
			assert.equal(actual, content);
		} finally {
			await rm(file_path, { force: true });
		}
	});

	test('diskfile_read', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `read_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		const read = (path: string) =>
			rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_read',
				params: { path },
				headers: fixture.create_session_headers()
			});
		/** Read `path`, expecting success, parsed against the spec's output. */
		const read_ok = async (path: string): Promise<DiskfileReadOutput> => {
			const res = await read(path);
			assert.ok(res.ok, `${path}: ${JSON.stringify(res).slice(0, 500)}`);
			return parse_or_throw(DiskfileReadOutput, res.result);
		};
		/** Read `path`, expecting a refusal with `code` and `reason`. */
		const read_refused = async (path: string, code: number, reason: string): Promise<void> => {
			const res = await read(path);
			assert.ok(!res.ok, `${path} should fail`);
			assert.equal(res.error.code, code, path);
			assert.deepEqual(res.error.data, { reason }, path);
			assert.ok(
				res.error.message.startsWith('failed to read file: '),
				`unexpected message: ${res.error.message}`
			);
		};
		const app_dir_file = join(zzz_dir, `read_${randomUUID()}.txt`);
		try {
			// a text file, whole, with the stats of the handle it was read from
			const text_path = join(dir, 'text.txt');
			await writeFile(text_path, 'héllo', 'utf-8');
			const text = await read_ok(text_path);
			assert.equal(text.contents, 'héllo');
			assert.isNull(text.unloaded_reason);
			assert.equal(text.hash, hash_blake3('héllo'), "the bytes' BLAKE3");
			assert.equal(text.size, Buffer.byteLength('héllo'));
			const text_stat = await stat(text_path);
			assert.ok(text.mtime !== null && Math.abs(text.mtime - text_stat.mtimeMs) < 1, 'mtime');

			// read through to the disk, whatever the filer has seen: a same-length
			// rewrite read at once, and a file in an ignored directory, which the
			// filer never indexes or watches
			await writeFile(text_path, 'hallo!', 'utf-8');
			assert.equal((await read_ok(text_path)).contents, 'hallo!');
			await mkdir(join(dir, 'node_modules'));
			await writeFile(join(dir, 'node_modules', 'x.txt'), 'never indexed', 'utf-8');
			assert.equal((await read_ok(join(dir, 'node_modules', 'x.txt'))).contents, 'never indexed');

			await writeFile(join(dir, 'empty.txt'), '', 'utf-8');
			const empty = await read_ok(join(dir, 'empty.txt'));
			assert.equal(empty.contents, '');
			assert.equal(empty.size, 0);
			assert.equal(empty.hash, hash_blake3(''));

			// a file the index doesn't hold, in the app dir: readable
			await mkdir(zzz_dir, { recursive: true });
			await writeFile(app_dir_file, 'app dir', 'utf-8');
			assert.equal((await read_ok(app_dir_file)).contents, 'app dir');

			// over the size limit, or not UTF-8: no contents, and why
			const limit = 4 * 1024 * 1024;
			const big_path = join(dir, 'big.txt');
			await writeFile(big_path, Buffer.alloc(limit + 1, 'x'));
			const big = await read_ok(big_path);
			assert.isNull(big.contents);
			assert.equal(big.unloaded_reason, 'too_large');
			assert.equal(big.size, limit + 1);
			assert.isNull(big.hash);
			const bin_path = join(dir, 'bin');
			await writeFile(bin_path, Buffer.from([0xff, 0xfe]));
			const bin = await read_ok(bin_path);
			assert.isNull(bin.contents);
			assert.equal(bin.unloaded_reason, 'not_utf8');
			assert.equal(bin.size, 2);
			assert.isNull(bin.hash);

			// not found, out of scope, relative
			await read_refused(join(dir, 'missing.txt'), JSONRPC_ERROR_CODES.not_found, 'path_not_found');
			await read_refused(
				'/tmp/zzz_outside_scope/x.txt',
				JSONRPC_ERROR_CODES.forbidden,
				'path_not_allowed'
			);
			await read_refused(
				`${dir}/../../../../etc/passwd`,
				JSONRPC_ERROR_CODES.forbidden,
				'path_not_allowed'
			);
			const relative = await read('relative/x.txt');
			assert.ok(!relative.ok);
			assert.equal(relative.error.code, JSONRPC_ERROR_CODES.invalid_params);

			// a `.zzz` directory other than the app dir — however it's spelled, and
			// whether or not the file exists, so the refusal says nothing about it
			const home = join(dir, '.zzz');
			await mkdir(join(home, 'run'), { recursive: true });
			await writeFile(join(home, '.env'), 'SECRET_FUZ_COOKIE_KEYS=not-for-reading', 'utf-8');
			for (const path of [
				join(home, '.env'),
				join(home, 'run', 'missing'),
				`${dir}/sub/../.zzz/./.env`
			]) {
				await read_refused(path, JSONRPC_ERROR_CODES.forbidden, 'protected_dir_not_allowed');
			}

			// a credential directory, the same way
			const ssh = join(dir, '.ssh');
			await mkdir(ssh);
			await writeFile(join(ssh, 'id_ed25519'), 'not-for-reading', 'utf-8');
			for (const path of [
				join(ssh, 'id_ed25519'),
				join(ssh, 'missing'),
				`${dir}/sub/../.ssh/./id_ed25519`,
				join(dir, 'deep', '.gnupg', 'x'),
				join(dir, '.password-store', 'x.gpg')
			]) {
				await read_refused(path, JSONRPC_ERROR_CODES.forbidden, 'protected_dir_not_allowed');
			}
			// `.env` files stay readable
			await writeFile(join(dir, '.env'), 'X=1', 'utf-8');
			assert.equal((await read_ok(join(dir, '.env'))).contents, 'X=1');

			// a symlink, to a file or along the path
			await symlink(text_path, join(dir, 'link.txt'));
			await read_refused(
				join(dir, 'link.txt'),
				JSONRPC_ERROR_CODES.forbidden,
				'symlink_not_allowed'
			);
			await mkdir(join(dir, 'real'));
			await writeFile(join(dir, 'real', 'f.txt'), 'f', 'utf-8');
			await symlink(join(dir, 'real'), join(dir, 'dir_link'));
			await read_refused(
				join(dir, 'dir_link', 'f.txt'),
				JSONRPC_ERROR_CODES.forbidden,
				'symlink_not_allowed'
			);

			// not a regular file — a FIFO is refused, not opened, so it can't block
			await read_refused(dir, JSONRPC_ERROR_CODES.invalid_params, 'is_a_directory');
			const fifo_path = join(dir, 'fifo');
			execFileSync('mkfifo', [fifo_path]);
			await read_refused(fifo_path, JSONRPC_ERROR_CODES.invalid_params, 'not_a_regular_file');
			// a socket, which `open(2)` itself refuses — bound through the dir's fd,
			// since a socket's path must fit in `sun_path` (108 bytes), which a long
			// `TMPDIR` overflows
			const socket_path = join(dir, 'socket');
			const dir_handle = await open(dir, 'r');
			const server = createServer();
			try {
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject);
					server.listen(`/proc/self/fd/${dir_handle.fd}/socket`, resolve);
				});
				await read_refused(socket_path, JSONRPC_ERROR_CODES.invalid_params, 'not_a_regular_file');
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await dir_handle.close();
				await rm(socket_path, { force: true });
			}

			// strict input
			for (const params of [{ path: text_path, extra: 1 }, { path: null }, {}]) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'diskfile_read',
					params,
					headers: fixture.create_session_headers()
				});
				assert.ok(!res.ok, `${JSON.stringify(params)} should fail`);
				assert.equal(res.error.code, JSONRPC_ERROR_CODES.invalid_params);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(app_dir_file, { force: true });
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
			assert.deepEqual(res.result, { hash: hash_blake3(content) });

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
			assert.deepEqual(res.result, { hash: hash_blake3(content) });

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

	test('diskfile_rename moves a file and its transcripts, never replacing', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `rename_${randomUUID()}`);
		await mkdir(join(dir, 'sub'), { recursive: true });
		const rename_file = (path: string, name: string) =>
			rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_rename',
				params: { path, name },
				headers: fixture.create_session_headers()
			});
		try {
			const audio = join(dir, 'a.webm');
			await writeFile(audio, 'audio', 'utf-8');
			await writeFile(join(dir, 'a.webm.base-en.transcript.json'), '{}', 'utf-8');
			await writeFile(join(dir, 'a.webm.md'), 'a copy — yours, left alone', 'utf-8');
			await writeFile(join(dir, 'a.webm.x.webm.m.transcript.json'), '{}', 'utf-8');

			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'diskfile_rename',
				params: { path: audio, name: 'b.webm' },
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok, JSON.stringify(res));
			const output = parse_or_throw(DiskfileRenameOutput, res.result);
			assert.deepEqual(output.renamed, [
				{ path: audio, new_path: join(dir, 'b.webm') },
				{
					path: join(dir, 'a.webm.base-en.transcript.json'),
					new_path: join(dir, 'b.webm.base-en.transcript.json')
				}
			]);
			assert.deepEqual((await readdir(dir)).sort(), [
				'a.webm.md',
				'a.webm.x.webm.m.transcript.json',
				'b.webm',
				'b.webm.base-en.transcript.json',
				'sub'
			]);
			assert.equal(await readFile(join(dir, 'b.webm'), 'utf-8'), 'audio');

			// a taken name is refused, nothing moved
			await writeFile(join(dir, 'c.webm'), 'taken', 'utf-8');
			const taken = await rename_file(join(dir, 'b.webm'), 'c.webm');
			assert.ok(!taken.ok);
			assert.equal(taken.error.code, JSONRPC_ERROR_CODES.conflict);
			assert.deepEqual(taken.error.data, { reason: 'already_exists' });
			assert.equal(await readFile(join(dir, 'c.webm'), 'utf-8'), 'taken');
			assert.ok(await file_exists(join(dir, 'b.webm.base-en.transcript.json')), 'kept');

			// one plain name in the file's own directory, never its own name
			for (const name of ['', '.', '..', 'sub/x.webm', '../x.webm', 'b.webm', 'x\\y.webm']) {
				const bad = await rename_file(join(dir, 'b.webm'), name);
				assert.ok(!bad.ok, name);
				assert.equal(bad.error.code, JSONRPC_ERROR_CODES.invalid_params, name);
			}

			// files only
			const folder = await rename_file(join(dir, 'sub'), 'sub2');
			assert.ok(!folder.ok);
			assert.deepEqual(folder.error.data, { reason: 'is_a_directory' });

			// a missing file
			const missing = await rename_file(join(dir, 'missing.webm'), 'm2.webm');
			assert.ok(!missing.ok);
			assert.deepEqual(missing.error.data, { reason: 'path_not_found' });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
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

	// `ScopedFs` refuses a credential directory under every root, so no file
	// action reaches keys a project or scoped dir covers
	test('file_actions_refuse_credential_dirs', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `credentials_${randomUUID()}`);
		const ssh = join(dir, '.ssh');
		const key_path = join(ssh, 'id_ed25519');
		const key_content = 'not-for-writing';
		await mkdir(ssh, { recursive: true });
		await writeFile(key_path, key_content, 'utf-8');
		try {
			const cases: Array<[string, Record<string, unknown>, string]> = [
				['diskfile_update', { path: key_path, content: 'overwritten' }, 'failed to write file'],
				['diskfile_create', { path: join(ssh, 'new'), content: 'x' }, 'failed to create file'],
				[
					'diskfile_create',
					{ path: join(dir, 'x', '.aws', 'credentials'), content: 'x' },
					'failed to create file'
				],
				['diskfile_delete', { path: key_path }, 'failed to delete file'],
				['directory_create', { path: join(dir, '.kube') }, 'failed to create directory'],
				['directory_create', { path: join(dir, '.docker', 'x') }, 'failed to create directory'],
				// taken, which would otherwise be `already_exists`
				['directory_create', { path: `${ssh}/` }, 'failed to create directory']
			];
			for (const [method, params, action] of cases) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method,
					params,
					headers: fixture.create_session_headers()
				});
				const label = `${method} ${JSON.stringify(params)}`;
				assert.ok(!res.ok, `${label} should fail`);
				assert.equal(res.error.code, JSONRPC_ERROR_CODES.forbidden, label);
				assert.deepEqual(res.error.data, { reason: 'protected_dir_not_allowed' }, label);
				assert.ok(res.error.message.startsWith(`${action}: `), `${label}: ${res.error.message}`);
			}
			assert.equal(await readFile(key_path, 'utf-8'), key_content, 'untouched');
			assert.deepEqual((await readdir(dir)).sort(), ['.ssh'], 'nothing created');
			assert.deepEqual(await readdir(ssh), ['id_ed25519'], 'nothing created');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// `ScopedFs` refuses a `.zzz` directory other than the app dir under every
	// root, so no file action reaches the CLI daemon home's `.env` and
	// `bootstrap_token` through a project or scoped dir that covers it
	test('file_actions_refuse_zzz_homes', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `zzz_home_${randomUUID()}`);
		const home = join(dir, '.zzz');
		const env_path = join(home, '.env');
		const env_content = 'SECRET_FUZ_COOKIE_KEYS=not-for-writing';
		await mkdir(join(home, 'run'), { recursive: true });
		await writeFile(env_path, env_content, 'utf-8');
		try {
			const cases: Array<[string, Record<string, unknown>, string]> = [
				['diskfile_update', { path: env_path, content: 'overwritten' }, 'failed to write file'],
				[
					'diskfile_update',
					{ path: `${dir}/sub/../.zzz/./new.txt`, content: 'x' },
					'failed to write file'
				],
				['diskfile_create', { path: join(home, 'new.txt'), content: 'x' }, 'failed to create file'],
				[
					'diskfile_create',
					{ path: join(home, 'run', 'deep', 'new.txt'), content: 'x' },
					'failed to create file'
				],
				['diskfile_delete', { path: env_path }, 'failed to delete file'],
				['diskfile_delete', { path: join(home, 'missing') }, 'failed to delete file'],
				['directory_create', { path: join(home, 'new_dir') }, 'failed to create directory'],
				// taken, which would otherwise be `already_exists`
				['directory_create', { path: `${home}/` }, 'failed to create directory'],
				// another daemon's app dir
				['directory_create', { path: join(dir, 'other', '.zzz') }, 'failed to create directory']
			];
			for (const [method, params, action] of cases) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method,
					params,
					headers: fixture.create_session_headers()
				});
				const label = `${method} ${JSON.stringify(params)}`;
				assert.ok(!res.ok, `${label} should fail`);
				assert.equal(res.error.code, JSONRPC_ERROR_CODES.forbidden, label);
				assert.deepEqual(res.error.data, { reason: 'protected_dir_not_allowed' }, label);
				assert.ok(res.error.message.startsWith(`${action}: `), `${label}: ${res.error.message}`);
			}
			assert.equal(await readFile(env_path, 'utf-8'), env_content, 'untouched');
			assert.deepEqual((await readdir(home)).sort(), ['.env', 'run'], 'nothing created');
			assert.deepEqual(await readdir(join(home, 'run')), [], 'nothing created');
			assert.ok(!(await file_exists(join(dir, 'sub'))), 'nothing created');
			assert.ok(!(await file_exists(join(dir, 'other'))), 'nothing created');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('diskfile_update_with_expected_hash_is_a_compare_and_swap', async () => {
		const fixture = await setup_test();
		const dir = join(scoped_dir, `cas_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		const call = (method: string, params: Record<string, unknown>) =>
			rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method,
				params,
				headers: fixture.create_session_headers()
			});
		/** `diskfile_update` with `expected_hash`, expecting `conflict` / `disk_changed`. */
		const update_refused = async (path: string, expected_hash: string): Promise<void> => {
			const res = await call('diskfile_update', { path, content: 'mine', expected_hash });
			assert.ok(!res.ok, `${path} should be refused`);
			assert.equal(res.error.code, JSONRPC_ERROR_CODES.conflict, path);
			assert.deepEqual(res.error.data, { reason: 'disk_changed' }, path);
			assert.ok(
				res.error.message.startsWith('failed to write file: '),
				`unexpected message: ${res.error.message}`
			);
		};
		try {
			const path = join(dir, 'notes.txt');
			await writeFile(path, 'base', 'utf-8');
			const read = await call('diskfile_read', { path });
			assert.ok(read.ok, JSON.stringify(read));
			const base = parse_or_throw(DiskfileReadOutput, read.result).hash;
			assert.equal(base, hash_blake3('base'));

			// another process writes, and the save follows at once — before any
			// filer event could be processed: the backend compares the disk itself
			await writeFile(path, 'theirs', 'utf-8');
			await update_refused(path, base!);
			assert.equal(await readFile(path, 'utf-8'), 'theirs', 'untouched');
			assert.deepEqual(await readdir(dir), ['notes.txt'], 'no staged temp file left');

			// based on what is there: written, and the response hashes the written bytes
			const content = 'mine — ünïcode';
			const saved = await call('diskfile_update', {
				path,
				content,
				expected_hash: hash_blake3('theirs')
			});
			assert.ok(saved.ok, JSON.stringify(saved));
			const { hash } = parse_or_throw(DiskfileUpdateOutput, saved.result);
			assert.equal(hash, hash_blake3(await readFile(path)));
			assert.equal(await readFile(path, 'utf-8'), content);
			// the next save's base, no read in between
			const next = await call('diskfile_update', { path, content: 'next', expected_hash: hash });
			assert.ok(next.ok, JSON.stringify(next));

			// gone: a change too, and nothing is created — not the file, not its directory
			const gone = join(dir, 'sub', 'gone.txt');
			await update_refused(gone, hash_blake3(''));
			assert.ok(!(await file_exists(join(dir, 'sub'))), 'nothing created');

			// larger than a read returns as text: refused without being matched
			const big = join(dir, 'big.txt');
			const big_bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 'x');
			await writeFile(big, big_bytes);
			await update_refused(big, hash_blake3(big_bytes));
			assert.equal((await stat(big)).size, big_bytes.length, 'untouched');

			// without one, written over whatever is there
			await writeFile(path, 'theirs again', 'utf-8');
			const plain = await call('diskfile_update', { path, content: 'overwrite' });
			assert.ok(plain.ok, JSON.stringify(plain));
			assert.equal(await readFile(path, 'utf-8'), 'overwrite');

			// the hash's grammar is strict: refused, never folded
			for (const expected_hash of [
				hash_blake3('overwrite').toUpperCase(),
				`blake3:${hash_blake3('overwrite')}`,
				hash_blake3('overwrite').slice(1),
				null
			]) {
				const res = await call('diskfile_update', { path, content: 'x', expected_hash });
				assert.ok(!res.ok, `${String(expected_hash)} should fail`);
				assert.equal(res.error.code, JSONRPC_ERROR_CODES.invalid_params, String(expected_hash));
			}
			assert.equal(await readFile(path, 'utf-8'), 'overwrite');
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
			['diskfile_update', { path, content: 'x', expected_hash: null }],
			['diskfile_create', { path, content: 'x', expected_hash: hash_blake3('') }],
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

			// the head alone, declaring the envelope's length: the cap refuses on it
			const http_over = await raw_http_send_head(handle.config.base_url, {
				path: handle.config.rpc_path,
				headers: {
					'Content-Type': 'application/json',
					origin: TEST_ORIGIN,
					...fixture.create_session_headers()
				},
				content_length: Buffer.byteLength(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'over',
						method: 'diskfile_update',
						params: { path, content: over }
					})
				)
			});
			assert.equal(http_over.status, 413);

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
				method: 'project_open',
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
				method: 'project_close',
				params: { root: `${tmp_dir}/` },
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
				method: 'project_open',
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
				assert.notProperty(disknode, 'contents');
				const read = await ws.request('read_renamed', 'diskfile_read', { path: new_path });
				assert.equal((read as Record<string, unknown>).contents, 'renamed');
			} finally {
				await ws.close();
			}

			await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'project_close',
				params: { root: `${tmp_dir}/` },
				headers: fixture.create_session_headers()
			}).catch(() => undefined);
		} finally {
			await rm(tmp_dir, { recursive: true, force: true });
		}
	});
	test('filer_change_sends_metadata_only', async () => {
		const CHANGED = 'chängéd';
		const fixture = await setup_test();
		const tmp_dir = join(tmpdir(), `zzz_cross_filer_${randomUUID()}`);
		await mkdir(tmp_dir, { recursive: true });
		const path = join(tmp_dir, 'touched.txt');
		await writeFile(path, 'unchanged', 'utf-8');
		try {
			const open = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'project_open',
				params: { path: tmp_dir },
				headers: fixture.create_session_headers()
			});
			assert.ok(open.ok);
			// the project's files: metadata, a tuple the strict schema admits nothing past
			const opened_files = parse_snapshot_files((open.result as Record<string, unknown>).files);
			const opened_file = opened_files.find((f) => f.id === path);
			assert.ok(opened_file);
			assert.equal(opened_file.size, 'unchanged'.length);

			const ws = await create_ws_transport({
				base_url: handle.config.base_url,
				ws_path: handle.config.ws_path,
				cookies: fixture.transport.cookies()
			});
			try {
				await ws.request('_warmup', 'ping', undefined);

				/**
				 * The next `filer_change` for `path` after message `from`, parsed
				 * against the spec — the next one whose disknode's `mtime` passes
				 * `accept_mtime`, when given, since a write and a later `utimes`
				 * can land in one debounce window or in two.
				 */
				const next_change = async (
					from: number,
					accept_mtime?: (mtime: unknown) => boolean
				): Promise<FilerChangeInput> => {
					const msg = await ws.wait_for<Record<string, unknown>>((m) => {
						if (ws.messages.indexOf(m) < from) return false;
						const rec = m as Record<string, unknown> | null;
						if (rec?.method !== 'filer_change') return false;
						const params = rec.params as Record<string, unknown> | undefined;
						const change = params?.change as Record<string, unknown> | undefined;
						if (change?.path !== path) return false;
						if (accept_mtime === undefined) return true;
						return accept_mtime((params?.disknode as Record<string, unknown> | undefined)?.mtime);
					}, 10_000);
					return parse_or_throw(FilerChangeInput, msg.params);
				};

				// an mtime-only change: a `change` with the new metadata, no contents key
				let from = ws.messages.length;
				await utimes(path, new Date(1_000_000), new Date(1_000_000));
				const touched = await next_change(from, (mtime) => mtime === 1_000_000);
				assert.equal(touched.change.type, 'change');
				assert.notProperty(touched.disknode, 'contents');
				assert.equal(touched.disknode.mtime, 1_000_000);
				assert.equal(touched.disknode.size, 'unchanged'.length);

				// a rewrite of the same bytes is the same
				from = ws.messages.length;
				await writeFile(path, 'unchanged', 'utf-8');
				await utimes(path, new Date(2_000_000), new Date(2_000_000));
				// the frame carrying the `utimes` — the write's own may come first
				const rewritten = await next_change(from, (mtime) => mtime === 2_000_000);
				assert.equal(rewritten.change.type, 'change');
				assert.notProperty(rewritten.disknode, 'contents');

				// and so is a plain rewrite of the same bytes — the daemon holds no
				// contents to compare, and the write moved the file's stamp
				from = ws.messages.length;
				await writeFile(path, 'unchanged', 'utf-8');
				const rewritten_plain = await next_change(
					from,
					(mtime) => typeof mtime === 'number' && mtime > 2_000_000
				);
				assert.equal(rewritten_plain.change.type, 'change');
				assert.equal(rewritten_plain.disknode.size, 'unchanged'.length);

				// new contents too: the size in bytes, not characters, and the
				// contents only by a read
				from = ws.messages.length;
				await writeFile(path, CHANGED, 'utf-8');
				const changed = await next_change(from);
				assert.equal(changed.change.type, 'change');
				assert.notProperty(changed.disknode, 'contents');
				assert.equal(changed.disknode.size, Buffer.byteLength(CHANGED));
				const read = await ws.request('read_changed', 'diskfile_read', { path });
				assert.equal((read as Record<string, unknown>).contents, CHANGED);

				// a snapshot has the file's latest metadata, and no contents
				const session = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'session_load',
					headers: fixture.create_session_headers()
				});
				assert.ok(session.ok);
				const files = parse_snapshot_files(
					((session.result as Record<string, unknown>).data as Record<string, unknown>).files
				);
				const snapshot_file = files.find((f) => f.id === path);
				assert.ok(snapshot_file);
				assert.equal(snapshot_file.size, Buffer.byteLength(CHANGED));
			} finally {
				await ws.close();
			}

			await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'project_close',
				params: { root: `${tmp_dir}/` },
				headers: fixture.create_session_headers()
			}).catch(() => undefined);
		} finally {
			await rm(tmp_dir, { recursive: true, force: true });
		}
	});
});
