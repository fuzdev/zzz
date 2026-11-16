// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import {
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '#lib/diskfile_types.ts';
import type { SessionLoadData, ProjectOpenOutput } from '#lib/action_specs.ts';
import type { ProjectInfoJson } from '#lib/project.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const WS_DIR = parse_or_throw(DiskfileDirectoryPath, '/ws/');
const PATH_A = parse_or_throw(DiskfilePath, '/ws/a.txt');
const PATH_B = parse_or_throw(DiskfilePath, '/ws/b.txt');
const PATH_C = parse_or_throw(DiskfilePath, '/ws/c.txt');

/** A disknode as the backend sends it — metadata only, `mtime` telling versions apart. */
const create_disknode = (path: DiskfilePath, mtime = 1): SerializableDisknode => ({
	id: path,
	source_dir: WS_DIR,
	size: 1,
	ctime: 1,
	mtime
});

type ProjectOpenResult =
	{ ok: true; value: ProjectOpenOutput } | { ok: false; error: { code: number; message: string } };

let app: Frontend;
let calls: Array<{
	path: string;
	resolve: (result: ProjectOpenResult) => void;
	reject: (error: unknown) => void;
}>;

/** The session snapshot `session_load` returns — the daemon's view after the remote open. */
let session: SessionLoadData;
let session_loads: number;
/** The `repo_files` pulls, each its input, answered with no files. */
let repo_files_calls: Array<{ root: string; dir: string }>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = [];
	session_loads = 0;
	repo_files_calls = [];
	session = {
		zzz_dir: parse_or_throw(DiskfileDirectoryPath, '/zzz/'),
		scoped_dirs: [],
		files: [],
		file_roots: [parse_or_throw(DiskfileDirectoryPath, '/zzz/')],
		provider_status: [],
		projects: [],
		terminal_ids: [],
		jobs: [],
		server_instance_id: create_uuid()
	};
	(app as unknown as { api: unknown }).api = {
		project_open: ({ path }: { path: string }) =>
			new Promise<ProjectOpenResult>((resolve, reject) => calls.push({ path, resolve, reject })),
		session_load: () => {
			session_loads++;
			return Promise.resolve({ ok: true, value: { data: session } });
		},
		repo_files: (input: { root: string; dir: string }) => {
			repo_files_calls.push(input);
			return Promise.resolve({ ok: true, value: { files: [], watch_status: 'full' } });
		}
	};
});

afterEach(() => {
	app.dispose();
});

const WS_INFO: ProjectInfoJson = {
	root: WS_DIR,
	name: 'ws',
	opened_at: '2026-09-26T00:00:00.000Z',
	kind: 'plain_dir',
	registry_path: null,
	entries: [],
	focused: [WS_DIR]
};

/** Delivers a `project_changed` notification through the real handler. */
const receive_change = (project: ProjectInfoJson, type: 'open' | 'update' = 'open'): void => {
	(
		app.action_handlers.project_changed as unknown as {
			receive: (event: unknown) => void;
		}
	).receive({ data: { input: { type, project } } });
};

/** Lets the resync's promise continuations run. */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

const filer_change = (type: DiskfileChangeType, path: DiskfilePath, mtime?: number): void => {
	app.diskfiles.handle_change({
		change: { type, path },
		disknode: create_disknode(path, mtime)
	});
};

describe('Projects.open', () => {
	test('adds the project the daemon returns, with its focus, watch status, and files', async () => {
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/ws/./'));
		assert.strictEqual(calls[0]!.path, '/ws/./');
		calls[0]!.resolve({
			ok: true,
			value: {
				project: WS_INFO,
				focus: WS_DIR,
				files: [create_disknode(PATH_A, 5)],
				watch_status: 'degraded'
			}
		});

		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value.project.root, WS_DIR);
		assert.strictEqual(result.value.focus, WS_DIR);
		assert.strictEqual(result.value.project.watch_status, 'degraded');
		assert.strictEqual(app.projects.get_by_root(WS_DIR), result.value.project);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.mtime, 5);
	});

	test('`filer_change` during the request wins over the older file tree', async () => {
		const opened = app.projects.open(WS_DIR);
		filer_change('delete', PATH_A);
		filer_change('change', PATH_B, 3);
		calls[0]!.resolve({
			ok: true,
			value: {
				project: WS_INFO,
				focus: WS_DIR,
				files: [create_disknode(PATH_A, 2), create_disknode(PATH_B, 2), create_disknode(PATH_C, 2)],
				watch_status: 'full'
			}
		});
		assert.ok((await opened).ok);

		assert.ok(!app.diskfiles.get_by_path(PATH_A), 'a file deleted in flight stays deleted');
		assert.strictEqual(app.diskfiles.get_by_path(PATH_B)?.mtime, 3);
		assert.strictEqual(app.diskfiles.get_by_path(PATH_C)?.mtime, 2);
	});

	test('returns the error and adds nothing on failure', async () => {
		const opened = app.projects.open(WS_DIR);
		calls[0]!.resolve({ ok: false, error: { code: -32602, message: 'not found' } });

		const result = await opened;
		assert.ok(!result.ok);
		assert.strictEqual(result.error.message, 'not found');
		assert.strictEqual(app.projects.items.size, 0);
	});
});

describe('Projects.receive_remote_change', () => {
	test('a project opened elsewhere gets its files by a resync and is not activated', async () => {
		session.projects = [WS_INFO];
		session.file_roots = [...session.file_roots, WS_DIR];
		session.files = [create_disknode(PATH_A, 5)];

		receive_change(WS_INFO);
		const project = app.projects.get_by_root(WS_DIR);
		assert.ok(project, 'added right away');
		assert.isNull(app.projects.active_id, 'not activated');
		assert.strictEqual(session_loads, 1, 'resynced');

		await flush();
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.mtime, 5);
		assert.strictEqual(app.projects.get_by_root(WS_DIR), project);
		assert.isNull(app.projects.active_id);
	});

	test('a known project with no new focus is not resynced', () => {
		app.projects.add(WS_INFO);
		receive_change(WS_INFO);
		assert.strictEqual(session_loads, 0);
		assert.strictEqual(app.projects.items.size, 1);
	});

	test("this client's own open, notified before its reply, is not resynced", async () => {
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/ws/./'));
		receive_change(WS_INFO); // the broadcast lands first, under the canonical root
		assert.strictEqual(session_loads, 0);
		calls[0]!.resolve({
			ok: true,
			value: {
				project: WS_INFO,
				focus: WS_DIR,
				files: [create_disknode(PATH_A, 5)],
				watch_status: 'full'
			}
		});
		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value.project, app.projects.get_by_root(WS_DIR));
		assert.strictEqual(app.diskfiles.get_by_path(PATH_A)?.mtime, 5);
		assert.strictEqual(session_loads, 0);
	});

	test('a remote open during an own open is resynced once the open settles', async () => {
		const other = {
			...WS_INFO,
			root: parse_or_throw(DiskfileDirectoryPath, '/other/'),
			name: 'other',
			focused: [parse_or_throw(DiskfileDirectoryPath, '/other/')]
		};
		session.projects = [other];
		const opened = app.projects.open(WS_DIR);
		receive_change(other);
		assert.strictEqual(session_loads, 0, 'deferred while the open is in flight');
		calls[0]!.resolve({ ok: false, error: { code: -32003, message: 'gone' } });
		await opened;
		assert.strictEqual(session_loads, 1);
		await flush();
		assert.ok(app.projects.get_by_root(other.root));
	});

	test('a remote open during an own open that throws is still resynced', async () => {
		const other = {
			...WS_INFO,
			root: parse_or_throw(DiskfileDirectoryPath, '/other/'),
			name: 'other',
			focused: [parse_or_throw(DiskfileDirectoryPath, '/other/')]
		};
		session.projects = [other];
		const opened = app.projects.open(WS_DIR);
		receive_change(other);
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
		assert.ok(app.projects.get_by_root(other.root));
	});
});

describe('a registry project', () => {
	const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
	const APP = parse_or_throw(DiskfileDirectoryPath, '/dev/app/');
	const SITE = parse_or_throw(DiskfileDirectoryPath, '/dev/site/');
	const registry_info = (focused: Array<DiskfileDirectoryPath>): ProjectInfoJson => ({
		root: DEV,
		name: 'dev',
		opened_at: '2026-09-26T00:00:00.000Z',
		kind: 'registry',
		registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
		entries: [
			{ key: 'app', kind: 'repo', dir: APP, state: 'present' },
			{ key: 'site', kind: 'repo', dir: SITE, state: 'present' }
		],
		focused
	});
	const node = (path: string, mtime = 1): SerializableDisknode => ({
		id: parse_or_throw(DiskfilePath, path),
		source_dir: DEV,
		size: 1,
		ctime: 1,
		mtime
	});

	test('a remote update that drops a focus resyncs, pruning its files', async () => {
		app.projects.add(registry_info([APP, SITE]));
		app.diskfiles.add_initial([node('/dev/app/a.ts'), node('/dev/site/a.ts')]);
		// `site`'s entry is gone, so the daemon dropped its focus and filer
		const without_site = {
			...registry_info([APP]),
			entries: registry_info([]).entries.slice(0, 1)
		};
		session.projects = [without_site];
		session.file_roots = [...session.file_roots, DEV, APP];
		session.files = [node('/dev/app/a.ts')];
		receive_change(without_site, 'update');
		assert.strictEqual(session_loads, 1);
		await flush();
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP]);
		assert.ok(app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/app/a.ts')));
		assert.ok(!app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/site/a.ts')), 'pruned');
	});

	test("this client's open narrowing a plain root to a registry resyncs once it settles", async () => {
		// `/dev` was a plain directory, focused on its root, before its registry appeared
		app.projects.add({
			root: DEV,
			kind: 'plain_dir',
			focused: [DEV]
		});
		app.diskfiles.add_initial([node('/dev/README.md'), node('/dev/scratch/x.txt')]);
		session.projects = [registry_info([])];
		session.file_roots = [...session.file_roots, DEV];
		session.files = [node('/dev/README.md')];
		const opened = app.projects.open(DEV);
		calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([]),
				focus: null,
				files: [node('/dev/README.md')],
				watch_status: 'full'
			}
		});
		const result = await opened;
		assert.ok(result.ok);
		assert.deepEqual(result.value.project.focused, [], 'the root focus the registry dropped');
		assert.strictEqual(session_loads, 1);
		await flush();
		assert.ok(
			!app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/scratch/x.txt')),
			'the unindexed file pruned'
		);
		assert.ok(app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/README.md')));
	});

	test('a focus dropped while an own open is in flight resyncs once it settles', async () => {
		(app.api as unknown as Record<string, unknown>).session_load = () => {
			session_loads++;
			return new Promise(() => {});
		};
		app.projects.add(registry_info([APP, SITE]));
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/dev/app/'));
		const without_site = {
			...registry_info([APP]),
			entries: registry_info([]).entries.slice(0, 1)
		};
		receive_change(without_site, 'update');
		assert.strictEqual(session_loads, 0, 'deferred');
		calls[0]!.resolve({
			ok: true,
			value: { project: without_site, focus: APP, files: [], watch_status: 'full' }
		});
		assert.ok((await opened).ok);
		assert.strictEqual(session_loads, 1);
	});

	test('a remote update that adds a focus pulls that repo, not a resync', () => {
		app.projects.add(registry_info([APP]));
		receive_change(registry_info([APP, SITE]), 'update');
		assert.strictEqual(session_loads, 0);
		assert.deepEqual(repo_files_calls, [{ root: DEV, dir: SITE }]);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
	});

	test("a remote focus during this client's own open of the root pulls it once the open settles", async () => {
		app.projects.add(registry_info([APP]));
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/dev/app/'));
		// another client focuses `site` while the open is in flight
		receive_change(registry_info([APP, SITE]), 'update');
		assert.strictEqual(session_loads, 0);
		assert.deepEqual(repo_files_calls, [], 'deferred while the open is in flight');
		// the reply was built before that focus
		calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([APP]), focus: APP, files: [], watch_status: 'full' }
		});
		const result = await opened;
		assert.ok(result.ok);
		assert.deepEqual(
			app.projects.get_by_root(DEV)?.focused,
			[APP, SITE],
			'an older reply never shrinks the focus'
		);
		assert.deepEqual(
			repo_files_calls,
			[{ root: DEV, dir: SITE }],
			"pulled the focus the reply didn't carry"
		);
		assert.strictEqual(session_loads, 0);
	});

	test('a remote focus a reply covers needs no fetch', async () => {
		app.projects.add(registry_info([APP]));
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/dev/site/'));
		receive_change(registry_info([APP, SITE]), 'update'); // this open's own notification
		calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([APP, SITE]), focus: SITE, files: [], watch_status: 'full' }
		});
		assert.ok((await opened).ok);
		assert.strictEqual(session_loads, 0);
		assert.deepEqual(repo_files_calls, []);
		assert.strictEqual(app.projects.get_by_root(DEV)?.last_focus, SITE, 'new files go there');
		assert.strictEqual(app.diskfiles.new_files_dir, SITE);
	});

	test('a reconciling open prunes only under the focused directories', async () => {
		for (const path of ['/dev/README.md', '/dev/app/gone.ts', '/dev/site/kept.ts']) {
			app.diskfiles.add_initial([node(path)]);
		}
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/dev/app/src/'), {
			reconcile_files: true
		});
		calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([APP]),
				focus: APP,
				files: [node('/dev/README.md', 2), node('/dev/app/a.ts')],
				watch_status: 'full'
			}
		});
		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value.focus, APP);
		assert.ok(!app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/app/gone.ts')));
		assert.ok(app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/app/a.ts')));
		assert.ok(
			app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/site/kept.ts')),
			'not focused yet, so not pruned'
		);
		assert.strictEqual(
			app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/README.md'))?.mtime,
			2
		);
	});
});
