// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import {
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '#lib/diskfile_types.ts';
import {
	Frontend,
	SESSION_LOAD_RETRY_DELAY,
	SESSION_LOAD_RETRY_DELAY_MAX
} from '#lib/frontend.svelte.ts';
import type { SessionLoadData } from '#lib/action_specs.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { encode_snapshot_files, seed_diskfile } from './diskfile_test_helpers.ts';

const ZZZ_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/zzz/');
const PATH_A = parse_or_throw(DiskfilePath, '/zzz/a.txt');
const PATH_B = parse_or_throw(DiskfilePath, '/zzz/b.txt');
const PATH_C = parse_or_throw(DiskfilePath, '/zzz/c.txt');

/** A disknode as the backend sends it — metadata only, `mtime` telling versions apart. */
const create_disknode = (path: DiskfilePath, mtime = 1): SerializableDisknode => ({
	id: path,
	source_dir: ZZZ_DIR,
	size: 1,
	ctime: 1,
	mtime
});

const SERVER_INSTANCE_ID = create_uuid();

const create_session = (files: Array<SerializableDisknode> = []): SessionLoadData => ({
	zzz_dir: ZZZ_DIR,
	scoped_dirs: [],
	files: encode_snapshot_files(files),
	file_roots: [ZZZ_DIR],
	provider_status: [],
	projects: [],
	projects_rev: 1,
	terminal_ids: [],
	jobs: [],
	server_instance_id: SERVER_INSTANCE_ID
});

type SessionLoadResult =
	| { ok: true; value: { data: SessionLoadData } }
	| { ok: false; error: { code: number; message: string } };

let app: Frontend;
/** Pending `session_load` calls, resolved by the test. */
let calls: Array<(result: SessionLoadResult) => void>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = [];
	(app as unknown as { api: unknown }).api = {
		session_load: () => new Promise<SessionLoadResult>((resolve) => calls.push(resolve))
	};
});

afterEach(() => {
	app.dispose();
	vi.useRealTimers();
});

const succeed = (index: number, files?: Array<SerializableDisknode>): void =>
	calls[index]!({ ok: true, value: { data: create_session(files) } });

const fail = (index: number, message = 'backend down'): void =>
	calls[index]!({ ok: false, error: { code: -32603, message } });

const filer_change = (type: DiskfileChangeType, path: DiskfilePath, mtime?: number): void => {
	app.diskfiles.handle_change({
		change: { type, path },
		disknode: create_disknode(path, mtime)
	});
};

describe('Frontend.load_session', () => {
	test('applies the snapshot', async () => {
		const loaded = app.load_session();
		assert.strictEqual(app.session_status, 'pending');
		succeed(0, [create_disknode(PATH_A, 5)]);

		assert.ok(await loaded);
		assert.strictEqual(app.session_status, 'success');
		assert.strictEqual(app.zzz_dir, ZZZ_DIR);
		const a = seed_diskfile(app, PATH_A);
		assert.ok(a);
		assert.strictEqual(a.mtime, 5);
		assert.strictEqual(a.content_status, 'unrequested', 'metadata only, read when needed');
	});

	test('re-pings a backend whose last ping failed, restoring the filesystem capability', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { capabilities } = app;
		// the mount-time ping failed — the daemon was restarting
		capabilities.handle_ping_sent('p1');
		capabilities.handle_ping_error('p1', 'fetch failed');
		let pings = 0;
		(app.api as unknown as { ping: () => Promise<unknown> }).ping = () => {
			const id = `p${++pings + 1}`;
			capabilities.handle_ping_sent(id);
			capabilities.handle_ping_received(id);
			return Promise.resolve({ ok: true, value: { ping_id: id } });
		};

		const loaded = app.load_session();
		succeed(0);
		assert.ok(await loaded);

		assert.strictEqual(pings, 1);
		assert.strictEqual(capabilities.backend.status, 'success');
		assert.strictEqual(capabilities.filesystem_available, true);

		// a healthy backend isn't re-pinged on later loads
		const reloaded = app.load_session();
		succeed(1);
		assert.ok(await reloaded);
		assert.strictEqual(pings, 1);
	});

	test('retries a failure with backoff and surfaces the error meanwhile', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const loaded = app.load_session();
		fail(0);
		assert.ok(!(await loaded));
		assert.strictEqual(app.session_status, 'failure');
		assert.strictEqual(app.session_error, 'backend down');
		assert.strictEqual(app.capabilities.filesystem.status, 'failure');
		assert.include(app.capabilities.filesystem.error_message, 'backend down');

		await vi.advanceTimersByTimeAsync(SESSION_LOAD_RETRY_DELAY - 1);
		assert.strictEqual(calls.length, 1);
		await vi.advanceTimersByTimeAsync(1);
		assert.strictEqual(calls.length, 2);

		// the next delay doubles
		fail(1);
		await vi.advanceTimersByTimeAsync(SESSION_LOAD_RETRY_DELAY * 2 - 1);
		assert.strictEqual(calls.length, 2);
		await vi.advanceTimersByTimeAsync(1);
		assert.strictEqual(calls.length, 3);

		succeed(2);
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(app.session_status, 'success');
		assert.strictEqual(app.session_error, null);
		assert.strictEqual(app.zzz_dir, ZZZ_DIR);

		// nothing more is scheduled
		await vi.advanceTimersByTimeAsync(SESSION_LOAD_RETRY_DELAY_MAX * 2);
		assert.strictEqual(calls.length, 3);
	});

	test('calling it while a retry waits retries now', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const loaded = app.load_session();
		fail(0);
		await loaded;

		const retried = app.load_session();
		assert.strictEqual(calls.length, 2);
		succeed(1);
		assert.ok(await retried);

		await vi.advanceTimersByTimeAsync(SESSION_LOAD_RETRY_DELAY_MAX);
		assert.strictEqual(calls.length, 2);
	});

	test('a throw from the request is retried like a failed load', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		(app as unknown as { api: unknown }).api = {
			session_load: () => Promise.reject(new Error('transport exploded'))
		};

		assert.ok(!(await app.load_session()));
		assert.strictEqual(app.session_status, 'failure');
		assert.strictEqual(app.session_error, 'transport exploded');

		let retried = false;
		(app as unknown as { api: unknown }).api = {
			session_load: () => {
				retried = true;
				return Promise.resolve({ ok: true, value: { data: create_session() } });
			}
		};
		await vi.advanceTimersByTimeAsync(SESSION_LOAD_RETRY_DELAY);
		assert.ok(retried);
		assert.strictEqual(app.session_status, 'success');
	});

	test('a throw applying the snapshot is retried like a failed load', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const receive_session = vi.spyOn(app, 'receive_session').mockImplementationOnce(() => {
			throw new Error('bad snapshot');
		});

		const loaded = app.load_session();
		succeed(0);
		assert.ok(!(await loaded));
		assert.strictEqual(app.session_status, 'failure');
		assert.strictEqual(app.session_error, 'bad snapshot');

		await vi.advanceTimersByTimeAsync(SESSION_LOAD_RETRY_DELAY);
		assert.strictEqual(calls.length, 2);
		succeed(1);
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(app.session_status, 'success');
		assert.strictEqual(receive_session.mock.calls.length, 2);
	});

	test('dispose stops retrying', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const loaded = app.load_session();
		fail(0);
		await loaded;
		app.dispose();

		await vi.advanceTimersByTimeAsync(SESSION_LOAD_RETRY_DELAY_MAX);
		assert.strictEqual(calls.length, 1);
	});

	test('a response after dispose is ignored', async () => {
		const loaded = app.load_session();
		app.dispose();
		succeed(0, [create_disknode(PATH_A)]);

		assert.ok(!(await loaded));
		assert.strictEqual(app.zzz_dir, null);
		assert.ok(!seed_diskfile(app, PATH_A));
	});

	test('`filer_change` during the request wins over the older snapshot', async () => {
		const loaded = app.load_session();
		filer_change('delete', PATH_A);
		filer_change('change', PATH_B, 3);

		succeed(0, [
			create_disknode(PATH_A, 2),
			create_disknode(PATH_B, 2),
			create_disknode(PATH_C, 2)
		]);
		assert.ok(await loaded);

		assert.ok(!seed_diskfile(app, PATH_A), 'a file deleted in flight stays deleted');
		assert.strictEqual(seed_diskfile(app, PATH_B)?.mtime, 3);
		assert.strictEqual(seed_diskfile(app, PATH_C)?.mtime, 2);
	});

	test('changes before or after the request are not tracked', async () => {
		filer_change('change', PATH_A, 3);
		const loaded = app.load_session();
		succeed(0, [create_disknode(PATH_A, 4)]);
		await loaded;
		assert.strictEqual(seed_diskfile(app, PATH_A)?.mtime, 4);

		// a later snapshot (e.g. a retry) isn't affected by the earlier request's window
		app.diskfiles.add_initial([create_disknode(PATH_B, 5)]);
		assert.strictEqual(seed_diskfile(app, PATH_B)?.mtime, 5);
	});
});
