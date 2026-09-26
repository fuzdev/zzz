// @vitest-environment jsdom

import { test, beforeEach, afterEach, describe, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import {
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '$lib/diskfile_types.ts';
import type { SessionLoadData, WorkspaceOpenOutput } from '$lib/action_specs.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const WS_DIR = DiskfileDirectoryPath.parse('/ws/');
const PATH_A = DiskfilePath.parse('/ws/a.txt');
const PATH_B = DiskfilePath.parse('/ws/b.txt');
const PATH_C = DiskfilePath.parse('/ws/c.txt');

const create_disknode = (path: DiskfilePath, contents: string | null): SerializableDisknode => ({
	id: path,
	source_dir: WS_DIR,
	contents,
	ctime: 1,
	mtime: 1,
	dependents: [],
	dependencies: []
});

type WorkspaceOpenResult =
	| { ok: true; value: WorkspaceOpenOutput }
	| { ok: false; error: { code: number; message: string } };

let app: Frontend;
let calls: Array<{
	path: string;
	resolve: (result: WorkspaceOpenResult) => void;
	reject: (error: unknown) => void;
}>;

/** The session snapshot `session_load` returns — the daemon's view after the remote open. */
let session: SessionLoadData;
let session_loads: number;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = [];
	session_loads = 0;
	session = {
		zzz_dir: DiskfileDirectoryPath.parse('/zzz/'),
		scoped_dirs: [],
		files: [],
		file_roots: [DiskfileDirectoryPath.parse('/zzz/')],
		provider_status: [],
		workspaces: [],
		terminal_ids: [],
		server_instance_id: create_uuid()
	};
	(app as unknown as { api: unknown }).api = {
		workspace_open: ({ path }: { path: string }) =>
			new Promise<WorkspaceOpenResult>((resolve, reject) => calls.push({ path, resolve, reject })),
		session_load: () => {
			session_loads++;
			return Promise.resolve({ ok: true, value: { data: session } });
		}
	};
});

afterEach(() => {
	app.dispose();
});

const WS_INFO = { path: WS_DIR, name: 'ws', opened_at: '2026-09-26T00:00:00.000Z' };

/** Delivers a `workspace_changed` open notification through the real handler. */
const receive_open = (workspace: typeof WS_INFO): void => {
	(
		app.action_handlers.workspace_changed as unknown as {
			receive: (event: unknown) => void;
		}
	).receive({ data: { input: { type: 'open', workspace } } });
};

/** Lets the resync's promise continuations run. */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

const filer_change = (type: DiskfileChangeType, path: DiskfilePath, contents?: string): void => {
	app.diskfiles.handle_change({
		change: { type, path },
		disknode: create_disknode(path, type === 'delete' ? null : (contents ?? null))
	});
};

describe('Workspaces.open', () => {
	test('adds the workspace the daemon returns, with its watch status and files', async () => {
		const opened = app.workspaces.open(DiskfileDirectoryPath.parse('/ws/./'));
		assert.strictEqual(calls[0]!.path, '/ws/./');
		calls[0]!.resolve({
			ok: true,
			value: {
				workspace: { path: WS_DIR, name: 'ws', opened_at: '2026-09-26T00:00:00.000Z' },
				files: [create_disknode(PATH_A, 'a')],
				watch_status: 'degraded'
			}
		});

		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value.path, WS_DIR);
		assert.strictEqual(result.value.watch_status, 'degraded');
		assert.strictEqual(app.workspaces.get_by_path(WS_DIR), result.value);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.content, 'a');
	});

	test('`filer_change` during the request wins over the older file tree', async () => {
		const opened = app.workspaces.open(WS_DIR);
		filer_change('delete', PATH_A);
		filer_change('change', PATH_B, 'b new');
		calls[0]!.resolve({
			ok: true,
			value: {
				workspace: { path: WS_DIR, name: 'ws', opened_at: '2026-09-26T00:00:00.000Z' },
				files: [
					create_disknode(PATH_A, 'a old'),
					create_disknode(PATH_B, 'b old'),
					create_disknode(PATH_C, 'c')
				],
				watch_status: 'full'
			}
		});
		assert.ok((await opened).ok);

		assert.ok(!app.diskfiles.get_by_path(PATH_A), 'a file deleted in flight stays deleted');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B)?.content, 'b new');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_C)?.content, 'c');
	});

	test('returns the error and adds nothing on failure', async () => {
		const opened = app.workspaces.open(WS_DIR);
		calls[0]!.resolve({ ok: false, error: { code: -32602, message: 'not found' } });

		const result = await opened;
		assert.ok(!result.ok);
		assert.strictEqual(result.error.message, 'not found');
		assert.strictEqual(app.workspaces.items.size, 0);
	});
});

describe('Workspaces.receive_remote_open', () => {
	test('a workspace opened elsewhere gets its files by a resync and is not activated', async () => {
		session.workspaces = [WS_INFO];
		session.file_roots = [...session.file_roots, WS_DIR];
		session.files = [create_disknode(PATH_A, 'a')];

		receive_open(WS_INFO);
		const workspace = app.workspaces.get_by_path(WS_DIR);
		assert.ok(workspace, 'added right away');
		assert.isNull(app.workspaces.active_id, 'not activated');
		assert.strictEqual(session_loads, 1, 'resynced');

		await flush();
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.content, 'a');
		assert.strictEqual(app.workspaces.get_by_path(WS_DIR), workspace);
		assert.isNull(app.workspaces.active_id);
	});

	test('a known workspace is not resynced', () => {
		app.workspaces.add(WS_INFO);
		receive_open(WS_INFO);
		assert.strictEqual(session_loads, 0);
		assert.strictEqual(app.workspaces.items.size, 1);
	});

	test("this client's own open, notified before its reply, is not resynced", async () => {
		const opened = app.workspaces.open(DiskfileDirectoryPath.parse('/ws/./'));
		receive_open(WS_INFO); // the broadcast lands first, under the canonical path
		assert.strictEqual(session_loads, 0);
		calls[0]!.resolve({
			ok: true,
			value: { workspace: WS_INFO, files: [create_disknode(PATH_A, 'a')], watch_status: 'full' }
		});
		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value, app.workspaces.get_by_path(WS_DIR));
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.content, 'a');
		assert.strictEqual(session_loads, 0);
	});

	test('a remote open during an own open is resynced once the open settles', async () => {
		const other = { ...WS_INFO, path: DiskfileDirectoryPath.parse('/other/'), name: 'other' };
		session.workspaces = [other];
		const opened = app.workspaces.open(WS_DIR);
		receive_open(other);
		assert.strictEqual(session_loads, 0, 'deferred while the open is in flight');
		calls[0]!.resolve({ ok: false, error: { code: -32003, message: 'gone' } });
		await opened;
		assert.strictEqual(session_loads, 1);
		await flush();
		assert.ok(app.workspaces.get_by_path(other.path));
	});

	test('a remote open during an own open that throws is still resynced', async () => {
		const other = { ...WS_INFO, path: DiskfileDirectoryPath.parse('/other/'), name: 'other' };
		session.workspaces = [other];
		const opened = app.workspaces.open(WS_DIR);
		receive_open(other);
		assert.strictEqual(session_loads, 0);
		calls[0]!.reject(new Error('transport down'));
		let thrown: unknown;
		try {
			await opened;
		} catch (error) {
			thrown = error;
		}
		assert.ok(thrown instanceof Error, 'the throw propagates');
		assert.strictEqual(session_loads, 1, 'the deferred remote open resynced');
		await flush();
		assert.ok(app.workspaces.get_by_path(other.path));
	});
});
