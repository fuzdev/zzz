/**
 * Cross-backend integration tests for provider + session_load actions.
 *
 * @module
 */

import { join } from 'node:path';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, test, assert } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { parse } from '@fuzdev/fuz_schema/schema.ts';

import type { SerializableDisknode, SnapshotFile } from '#lib/diskfile_types.ts';
import { SessionLoadOutput } from '#lib/action_specs.ts';
import { decode_snapshot_files } from '#lib/diskfile_helpers.ts';

import { parse_snapshot_files } from '../diskfile_test_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

const zzz_dir = handle.config.env.PUBLIC_ZZZ_DIR!;

/** The contents `diskfile_read` returns for `path`. */
const read_contents = async (
	fixture: Awaited<ReturnType<typeof setup_test>>,
	path: string
): Promise<unknown> => {
	const read = await rpc_call({
		app: fixture.transport,
		path: handle.config.rpc_path,
		method: 'diskfile_read',
		params: { path },
		headers: fixture.create_session_headers()
	});
	assert.ok(read.ok, `diskfile_read failed: ${JSON.stringify(read)}`);
	return (read.result as Record<string, unknown>).contents;
};

describe('provider + session cross-backend', () => {
	test('provider_load_status_empty', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'provider_load_status',
			params: { provider_name: 'gemini' },
			headers: fixture.create_session_headers()
		});
		assert.ok(res.ok, `provider_load_status failed: ${JSON.stringify(res)}`);
		const status = (res.result as Record<string, unknown>).status as Record<string, unknown>;
		assert.equal(status.name, 'gemini');
		assert.equal(typeof status.available, 'boolean');
		assert.equal(typeof status.checked_at, 'number');
		if (status.available === false) {
			assert.equal(typeof status.error, 'string');
		}
	});

	test('session_load_basic', async () => {
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'session_load',
			headers: fixture.create_session_headers()
		});
		assert.ok(res.ok);
		const data = (res.result as Record<string, unknown>).data as Record<string, unknown>;

		const zzz_dir_out = data.zzz_dir as string;
		assert.ok(zzz_dir_out.startsWith('/'), 'zzz_dir is absolute');
		assert.ok(zzz_dir_out.endsWith('/'), 'zzz_dir has trailing slash');

		const scoped_dirs = data.scoped_dirs as Array<string>;
		assert.ok(scoped_dirs.length >= 1, `scoped_dirs has entries (got ${scoped_dirs.length})`);
		const first = scoped_dirs[0]!;
		assert.ok(first.startsWith('/'), 'scoped_dirs[0] is absolute');
		assert.ok(first.endsWith('/'), 'scoped_dirs[0] has trailing slash');

		assert.ok(Array.isArray(data.files), 'files is array');
		assert.ok(Array.isArray(data.provider_status), 'provider_status is array');
		assert.ok(Array.isArray(data.projects), 'projects is array');

		// the file roots are the watched dirs, so they cover zzz_dir and the scoped dirs
		const file_roots = data.file_roots as Array<string>;
		assert.include(file_roots, zzz_dir_out, 'zzz_dir is a file root');
		for (const dir of scoped_dirs) assert.include(file_roots, dir, `${dir} is a file root`);
		for (const file of parse_snapshot_files(data.files)) {
			assert.ok(
				file_roots.some((root) => file.id.startsWith(root)),
				`${file.id} is under a file root`
			);
		}

		assert.deepEqual(data.terminal_ids, [], 'a fresh account has no terminals');
		assert.match(data.server_instance_id as string, /^[0-9a-f-]{36}$/);
	});

	test('session_load_server_instance_id_is_stable', async () => {
		const fixture = await setup_test();
		const load = async (): Promise<unknown> => {
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'session_load',
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok);
			return ((res.result as Record<string, unknown>).data as Record<string, unknown>)
				.server_instance_id;
		};
		assert.strictEqual(await load(), await load(), 'the same while the daemon runs');
	});

	test('session_load_returns_zzz_dir_files', async () => {
		const fixture = await setup_test();
		await mkdir(zzz_dir, { recursive: true });
		const file_name = `test_session_${randomUUID()}.txt`;
		const file_path = join(zzz_dir, file_name);
		const content = 'session load file test';
		try {
			await writeFile(file_path, content, 'utf-8');

			// Read-after-write race: the Filer can index a newly-detected file
			// mid-write, so an immediate `session_load` can snapshot the entry
			// at an earlier size. Poll until it carries the written size (or
			// time out). The exact timing is nondeterministic (async watcher),
			// so a fixed single call is flaky; the poll makes it deterministic.
			// (Cross-process analog of `wait_for_audit_row`; mirrors
			// `session_load_returns_nested_files` below.)
			let test_file: SerializableDisknode | undefined;
			const deadline = Date.now() + 5_000;
			for (;;) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'session_load',
					headers: fixture.create_session_headers()
				});
				assert.ok(res.ok);
				const data = (res.result as Record<string, unknown>).data as Record<string, unknown>;
				const files = parse_snapshot_files(data.files);
				test_file = files.find((f) => f.id.endsWith(`/${file_name}`));
				if (test_file?.size === Buffer.byteLength(content)) break;
				if (Date.now() > deadline) {
					if (!test_file) {
						const ids = files.map((f) => f.id);
						assert.fail(`test file not found in ${files.length} files: ${JSON.stringify(ids)}`);
					}
					break; // fall through to the assertion below for a clear diff
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(test_file.size, Buffer.byteLength(content), 'size in bytes');
			// metadata only — the strict schema admits a file's tuple and nothing
			// more, and the contents come by a read
			assert.equal(await read_contents(fixture, test_file.id), content);
			assert.ok(test_file.source_dir.startsWith('/'), 'source_dir absolute');
			assert.ok(test_file.source_dir.endsWith('/'), 'source_dir trailing slash');
			assert.ok(test_file.id.startsWith('/'), 'file id absolute');
			assert.ok(Number.isSafeInteger(test_file.mtime), 'mtime in whole ms');
		} finally {
			await rm(file_path, { force: true });
		}
	});

	test('session_load_returns_nested_files', async () => {
		const fixture = await setup_test();
		const sub_dir = join(zzz_dir, 'state', `nested_${randomUUID()}`);
		await mkdir(sub_dir, { recursive: true });
		const file_path = join(sub_dir, 'deep.txt');
		try {
			await writeFile(file_path, 'nested content', 'utf-8');

			// Read-after-write race: the Filer can index a newly-detected
			// nested file mid-write, so an immediate `session_load` can
			// snapshot the entry at an earlier size. Poll until it carries the
			// written size (or time out). The exact timing is nondeterministic
			// (async watcher), so a fixed single call is flaky; the poll makes
			// it deterministic. (Cross-process analog of `wait_for_audit_row`.)
			let nested: SerializableDisknode | undefined;
			const deadline = Date.now() + 5_000;
			for (;;) {
				const res = await rpc_call({
					app: fixture.transport,
					path: handle.config.rpc_path,
					method: 'session_load',
					headers: fixture.create_session_headers()
				});
				assert.ok(res.ok);
				const data = (res.result as Record<string, unknown>).data as Record<string, unknown>;
				const files = parse_snapshot_files(data.files);
				nested = files.find((f) => f.id.endsWith('/deep.txt'));
				if (nested?.size === 'nested content'.length) break;
				if (Date.now() > deadline) {
					if (!nested) {
						const ids = files.map((f) => f.id);
						assert.fail(`nested file not found in ${files.length} files: ${JSON.stringify(ids)}`);
					}
					break; // fall through to the assertion below for a clear diff
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(nested.size, 'nested content'.length);
			assert.equal(await read_contents(fixture, nested.id), 'nested content');
		} finally {
			await rm(sub_dir, { recursive: true, force: true });
		}
	});

	test('session_load_sends_ctime_only_when_it_differs_from_mtime', async () => {
		const fixture = await setup_test();
		const dir = join(zzz_dir, 'state', `ctime_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		const same = join(dir, 'same.txt');
		const older = join(dir, 'older.txt');
		try {
			await writeFile(same, 'same', 'utf-8');
			await writeFile(older, 'older', 'utf-8');
			const { birthtimeMs } = await stat(same);
			// no birth time here (`statx` unsupported): the wire `ctime` is null, never equal
			const has_birth_time = birthtimeMs > 0;
			// mtime moved onto the birth time's millisecond, and well before it
			await utimes(same, new Date(), (Math.floor(birthtimeMs) + 0.5) / 1000);
			await utimes(older, new Date(), 1_000_000);

			// a rescan before every snapshot picks the moved stamps up
			const res = await rpc_call({
				app: fixture.transport,
				path: handle.config.rpc_path,
				method: 'session_load',
				headers: fixture.create_session_headers()
			});
			assert.ok(res.ok);
			const parsed = parse(SessionLoadOutput, res.result);
			assert.ok(parsed.ok, JSON.stringify(parsed));
			const { files } = parsed.value.data;
			/** `path`'s tuple, and its path relative to the tuple's group. */
			const tuple_of = (path: string): { rel: string; tuple: SnapshotFile | undefined } => {
				const group = files.find(({ dir }) => path.startsWith(dir));
				assert.ok(group, `no group holds ${path}`);
				const rel = path.slice(group.dir.length);
				return { rel, tuple: group.files.find((file) => file[0] === rel) };
			};
			const older_birth = has_birth_time ? Math.floor((await stat(older)).birthtimeMs) : null;
			const older_tuple = tuple_of(older);
			assert.deepEqual(
				older_tuple.tuple,
				[older_tuple.rel, 'older'.length, 1_000_000_000, older_birth],
				'ctime sent where it differs'
			);
			if (has_birth_time) {
				const same_tuple = tuple_of(same);
				assert.deepEqual(
					same_tuple.tuple,
					[same_tuple.rel, 'same'.length, Math.floor(birthtimeMs)],
					'ctime left off where it equals mtime'
				);
			}
			// and decoded, each has its own ctime again
			const decoded = new Map(
				decode_snapshot_files(files).map((f): [string, SerializableDisknode] => [f.id, f])
			);
			assert.strictEqual(decoded.get(older)?.mtime, 1_000_000_000);
			assert.strictEqual(decoded.get(older)?.ctime, older_birth);
			if (has_birth_time) {
				assert.strictEqual(decoded.get(same)?.ctime, Math.floor(birthtimeMs));
				assert.strictEqual(decoded.get(same)?.mtime, Math.floor(birthtimeMs));
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// There is no runtime API-key setter to cover: provider keys come from the
	// server's environment (`SECRET_ANTHROPIC_API_KEY` &c.) and nowhere else.
});
