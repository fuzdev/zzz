// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import {
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '$lib/diskfile_types.ts';
import {
	Frontend,
	SESSION_LOAD_RETRY_DELAY,
	SESSION_LOAD_RETRY_DELAY_MAX
} from '$lib/frontend.svelte.ts';
import type { SessionLoadData } from '$lib/action_specs.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const ZZZ_DIR = SerializableDisknode.shape.source_dir.parse('/zzz/');
const PATH_A = DiskfilePath.parse('/zzz/a.txt');
const PATH_B = DiskfilePath.parse('/zzz/b.txt');
const PATH_C = DiskfilePath.parse('/zzz/c.txt');

const create_disknode = (path: DiskfilePath, contents: string | null): SerializableDisknode => ({
	id: path,
	source_dir: ZZZ_DIR,
	contents,
	ctime: 1,
	mtime: 1,
	dependents: [],
	dependencies: []
});

const SERVER_INSTANCE_ID = create_uuid();

const create_session = (files: Array<SerializableDisknode> = []): SessionLoadData => ({
	zzz_dir: ZZZ_DIR,
	scoped_dirs: [],
	files,
	file_roots: [ZZZ_DIR],
	provider_status: [],
	workspaces: [],
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

const filer_change = (type: DiskfileChangeType, path: DiskfilePath, contents?: string): void => {
	app.diskfiles.handle_change({
		change: { type, path },
		disknode: create_disknode(path, type === 'delete' ? null : (contents ?? null))
	});
};

describe('Frontend.load_session', () => {
	test('applies the snapshot', async () => {
		const loaded = app.load_session();
		assert.strictEqual(app.session_status, 'pending');
		succeed(0, [create_disknode(PATH_A, 'a')]);

		assert.ok(await loaded);
		assert.strictEqual(app.session_status, 'success');
		assert.strictEqual(app.zzz_dir, ZZZ_DIR);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.content, 'a');
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
		succeed(0, [create_disknode(PATH_A, 'a')]);

		assert.ok(!(await loaded));
		assert.strictEqual(app.zzz_dir, null);
		assert.ok(!app.diskfiles.get_by_path(PATH_A));
	});

	test('`filer_change` during the request wins over the older snapshot', async () => {
		const loaded = app.load_session();
		filer_change('delete', PATH_A);
		filer_change('change', PATH_B, 'b new');

		succeed(0, [
			create_disknode(PATH_A, 'a old'),
			create_disknode(PATH_B, 'b old'),
			create_disknode(PATH_C, 'c')
		]);
		assert.ok(await loaded);

		assert.ok(!app.diskfiles.get_by_path(PATH_A), 'a file deleted in flight stays deleted');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B)?.content, 'b new');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_C)?.content, 'c');
	});

	test('changes before or after the request are not tracked', async () => {
		filer_change('change', PATH_A, 'a before');
		const loaded = app.load_session();
		succeed(0, [create_disknode(PATH_A, 'a snapshot')]);
		await loaded;
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.content, 'a snapshot');

		// a later snapshot (e.g. a retry) isn't affected by the earlier request's window
		app.diskfiles.add_initial([create_disknode(PATH_B, 'b')]);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B)?.content, 'b');
	});
});
