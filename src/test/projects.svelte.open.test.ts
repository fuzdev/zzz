// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
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
import { content_hash, encode_snapshot_files, seed_diskfile } from './diskfile_test_helpers.ts';

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
	/** The input as sent — `focus` absent unless requested. */
	input: Record<string, unknown>;
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
		home_dir: null,
		files: [],
		file_roots: [parse_or_throw(DiskfileDirectoryPath, '/zzz/')],
		provider_status: [],
		projects: [],
		projects_rev: 1,
		terminal_ids: [],
		jobs: [],
		server_instance_id: create_uuid()
	};
	(app as unknown as { api: unknown }).api = {
		project_open: (input: { path: string }) =>
			new Promise<ProjectOpenResult>((resolve, reject) =>
				calls.push({ path: input.path, input, resolve, reject })
			),
		session_load: () => {
			session_loads++;
			return Promise.resolve({ ok: true, value: { data: session } });
		},
		repo_files: (input: { root: string; dir: string }) => {
			repo_files_calls.push(input);
			return Promise.resolve({ ok: true, value: { files: [], watch_status: 'full', rev: 0 } });
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
	fallback: null,
	entries: [],
	focused: [WS_DIR],
	ignored: {},
	rev: 1
};

/** Delivers a `project_changed` notification through the real handler. */
const receive_change = (
	project: ProjectInfoJson,
	type: 'open' | 'update' | 'close' = 'open'
): void => {
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

/** An open's reply, as the daemon sends it — `opened` unless given. */
const reply = (
	project: ProjectInfoJson,
	value: Partial<Omit<ProjectOpenOutput, 'project'>> = {}
): ProjectOpenResult => ({
	ok: true,
	value: {
		project,
		focus: project.kind === 'registry' ? null : project.root,
		files: [],
		watch_status: 'full',
		refused: [],
		opened: true,
		...value
	}
});

describe('Projects.open', () => {
	test('adds the project the daemon returns, with its focus, watch status, and files', async () => {
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/ws/./'));
		assert.strictEqual(calls[0]!.path, '/ws/./');
		calls[0]!.resolve(
			reply(WS_INFO, {
				files: encode_snapshot_files([create_disknode(PATH_A, 5)]),
				watch_status: 'degraded'
			})
		);

		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value.project?.root, WS_DIR);
		assert.strictEqual(result.value.focus, WS_DIR);
		assert.isTrue(result.value.opened);
		assert.strictEqual(result.value.rev, 1);
		assert.strictEqual(result.value.project?.rev, 1);
		assert.strictEqual(result.value.project?.watch_status, 'degraded');
		assert.strictEqual(app.projects.get_by_root(WS_DIR), result.value.project);
		assert.strictEqual(seed_diskfile(app, PATH_A)?.mtime, 5);
	});

	test('`filer_change` during the request wins over the older file tree', async () => {
		const opened = app.projects.open(WS_DIR);
		filer_change('delete', PATH_A);
		filer_change('change', PATH_B, 3);
		calls[0]!.resolve(
			reply(WS_INFO, {
				files: encode_snapshot_files([
					create_disknode(PATH_A, 2),
					create_disknode(PATH_B, 2),
					create_disknode(PATH_C, 2)
				])
			})
		);
		assert.ok((await opened).ok);

		assert.ok(!seed_diskfile(app, PATH_A), 'a file deleted in flight stays deleted');
		assert.strictEqual(seed_diskfile(app, PATH_B)?.mtime, 3);
		assert.strictEqual(seed_diskfile(app, PATH_C)?.mtime, 2);
	});

	test('requests a focus in the same open and returns what it refused', async () => {
		const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
		const APP = parse_or_throw(DiskfileDirectoryPath, '/dev/app/');
		const SITE = parse_or_throw(DiskfileDirectoryPath, '/dev/site/');
		const opened = app.projects.open(DEV, { focus: [APP, SITE] });
		assert.deepEqual(calls[0]!.input, { path: DEV, focus: [APP, SITE] });
		const refused = [{ dir: SITE, reason: 'repo_not_present' }];
		calls[0]!.resolve(
			reply(
				{
					...WS_INFO,
					root: DEV,
					kind: 'registry',
					registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
					fallback: null,
					entries: [
						{ key: 'app', kind: 'repo', dir: APP, state: 'present' },
						{ key: 'site', kind: 'repo', dir: SITE, state: 'missing' }
					],
					focused: [APP]
				},
				{ refused }
			)
		);
		const result = await opened;
		assert.ok(result.ok);
		assert.deepEqual(result.value.refused, refused);
		assert.deepEqual(result.value.project?.focused, [APP]);

		// an open asking for no focus sends none
		void app.projects.open(WS_DIR, { focus: [] });
		assert.deepEqual(calls[1]!.input, { path: WS_DIR });
	});

	test('returns the error and adds nothing on failure', async () => {
		const opened = app.projects.open(WS_DIR);
		calls[0]!.resolve({ ok: false, error: { code: -32602, message: 'not found' } });

		const result = await opened;
		assert.ok(!result.ok);
		assert.strictEqual(result.error.message, 'not found');
		assert.strictEqual(app.projects.items.size, 0);
	});

	// the race logged as "an open reply re-adding a project that was closed"
	test('a reply older than a close applied here adds nothing back, nor its files', async () => {
		const opened = app.projects.open(WS_DIR);
		receive_change(WS_INFO); // its own, rev 1
		assert.ok(app.projects.get_by_root(WS_DIR));
		// another client closes it, the notification ahead of this open's reply
		receive_change({ ...WS_INFO, rev: 2 }, 'close');
		assert.ok(!app.projects.get_by_root(WS_DIR));
		calls[0]!.resolve(reply(WS_INFO, { files: encode_snapshot_files([create_disknode(PATH_A)]) }));
		const result = await opened;
		assert.ok(result.ok);
		assert.isNull(result.value.project, 'closed here, so not held');
		assert.ok(!app.projects.get_by_root(WS_DIR), 'the tombstone keeps it closed');
		assert.ok(!seed_diskfile(app, PATH_A), "the dropped state's files aren't applied");
		// nor does its own late notification
		receive_change(WS_INFO);
		assert.ok(!app.projects.get_by_root(WS_DIR));
		// a newer open does
		receive_change({ ...WS_INFO, rev: 3 });
		assert.ok(app.projects.get_by_root(WS_DIR));
	});

	test('an own close takes its rev from the reply, which keeps an older reply out', async () => {
		(app.api as unknown as Record<string, unknown>).project_close = () =>
			Promise.resolve({ ok: true, value: { rev: 2 } });
		app.projects.add(WS_INFO);
		const opened = app.projects.open(WS_DIR);
		assert.ok((await app.close_project(WS_DIR)).ok);
		assert.ok(!app.projects.get_by_root(WS_DIR));
		calls[0]!.resolve(reply(WS_INFO, { opened: false }));
		assert.ok((await opened).ok);
		assert.ok(!app.projects.get_by_root(WS_DIR));
	});

	test('a close older than the state held changes nothing', () => {
		app.projects.add({ ...WS_INFO, rev: 3 });
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		receive_change({ ...WS_INFO, rev: 2 }, 'close');
		assert.ok(app.projects.get_by_root(WS_DIR), 'opened again after that close');
		assert.ok(seed_diskfile(app, PATH_A), 'its files stay');
	});

	test("a close releases the project's files, keeping a draft flagged uncovered", async () => {
		app.projects.add(WS_INFO);
		app.diskfiles.add_initial([create_disknode(PATH_A), create_disknode(PATH_B)]);
		const b = seed_diskfile(app, PATH_B)!;
		(app.api as unknown as Record<string, unknown>).diskfile_read = () =>
			Promise.resolve({
				ok: true,
				value: {
					contents: 'x',
					unloaded_reason: null,
					hash: content_hash('x'),
					size: 1,
					ctime: 1,
					mtime: 1
				}
			});
		await app.diskfiles.ensure_content(b);
		app.diskfiles.select(b.path, true);
		app.diskfiles.get_editor_state(b).current_content = 'edited';

		receive_change({ ...WS_INFO, rev: 2 }, 'close');
		assert.ok(!app.projects.get_by_root(WS_DIR));
		assert.ok(!seed_diskfile(app, PATH_A), 'nothing indexes it now');
		const kept = seed_diskfile(app, PATH_B);
		assert.ok(kept, 'kept for its draft');
		assert.isTrue(kept.uncovered);
		assert.isFalse(kept.deleted_on_disk, 'not seen deleted');
	});

	test('a close keeps the files another root covers', () => {
		app.scoped_dirs = [WS_DIR];
		app.projects.add(WS_INFO);
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		receive_change({ ...WS_INFO, rev: 2 }, 'close');
		assert.ok(!app.projects.get_by_root(WS_DIR));
		assert.ok(seed_diskfile(app, PATH_A), 'the scoped dir still indexes it');
	});

	test('a removal the daemon could not stamp leaves a tombstone at the rev held', () => {
		app.projects.add({ ...WS_INFO, rev: 2 });
		app.diskfiles.add_initial([create_disknode(PATH_A)]);
		app.projects.remove_by_root(WS_DIR);
		assert.ok(!app.projects.get_by_root(WS_DIR));
		assert.ok(!seed_diskfile(app, PATH_A), 'its files released');
		// a state at or below the rev held, landing late, adds nothing back
		receive_change({ ...WS_INFO, rev: 2 });
		assert.ok(!app.projects.get_by_root(WS_DIR), 'the tombstone keeps it out');
		receive_change({ ...WS_INFO, rev: 3 });
		assert.ok(app.projects.get_by_root(WS_DIR), 'a newer open adds it');
	});
});

describe('Projects.receive_remote_change', () => {
	test('a project opened elsewhere gets its files by a resync and is not activated', async () => {
		session.projects = [WS_INFO];
		session.file_roots = [...session.file_roots, WS_DIR];
		session.files = encode_snapshot_files([create_disknode(PATH_A, 5)]);

		receive_change(WS_INFO);
		const project = app.projects.get_by_root(WS_DIR);
		assert.ok(project, 'added right away');
		assert.isNull(app.projects.active_id, 'not activated');
		assert.strictEqual(session_loads, 1, 'resynced');

		await flush();
		assert.strictEqual(seed_diskfile(app, PATH_A)?.mtime, 5);
		assert.strictEqual(app.projects.get_by_root(WS_DIR), project);
		assert.isNull(app.projects.active_id);
	});

	test('a known project at the same rev changes and fetches nothing', () => {
		app.projects.add(WS_INFO);
		receive_change(WS_INFO);
		assert.strictEqual(session_loads, 0);
		assert.strictEqual(app.projects.items.size, 1);
	});

	test("this client's own open, notified before its reply, is not resynced", async () => {
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/ws/./'));
		receive_change(WS_INFO); // the broadcast lands first, under the canonical root
		assert.strictEqual(session_loads, 0);
		calls[0]!.resolve(
			reply(WS_INFO, { files: encode_snapshot_files([create_disknode(PATH_A, 5)]) })
		);
		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value.project, app.projects.get_by_root(WS_DIR));
		assert.strictEqual(seed_diskfile(app, PATH_A)?.mtime, 5, 'the same rev: its files');
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
		await assert_rejects(() => opened, /transport down/);
		assert.strictEqual(session_loads, 1, 'the deferred remote open resynced');
		await flush();
		assert.ok(app.projects.get_by_root(other.root));
	});
});

describe('a registry project', () => {
	const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
	const APP = parse_or_throw(DiskfileDirectoryPath, '/dev/app/');
	const SITE = parse_or_throw(DiskfileDirectoryPath, '/dev/site/');
	const registry_info = (focused: Array<DiskfileDirectoryPath>, rev = 1): ProjectInfoJson => ({
		root: DEV,
		name: 'dev',
		opened_at: '2026-09-26T00:00:00.000Z',
		kind: 'registry',
		registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
		fallback: null,
		entries: [
			{ key: 'app', kind: 'repo', dir: APP, state: 'present' },
			{ key: 'site', kind: 'repo', dir: SITE, state: 'present' }
		],
		focused,
		ignored: {},
		rev
	});
	const node = (path: string, mtime = 1): SerializableDisknode => ({
		id: parse_or_throw(DiskfilePath, path),
		source_dir: DEV,
		size: 1,
		ctime: 1,
		mtime
	});

	test('a remote update that drops a focus with its entry releases its files, no resync', async () => {
		app.projects.add(registry_info([APP, SITE]));
		app.diskfiles.add_initial([node('/dev/app/a.ts'), node('/dev/site/a.ts')]);
		// `site`'s entry is gone, so the daemon dropped its focus and filer
		const without_site = {
			...registry_info([APP], 2),
			entries: registry_info([]).entries.slice(0, 1)
		};
		receive_change(without_site, 'update');
		await flush();
		assert.strictEqual(session_loads, 0);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP]);
		assert.ok(seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/app/a.ts')));
		assert.ok(!seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/site/a.ts')));
	});

	test("this client's open narrowing a plain root to a registry releases what it doesn't index", async () => {
		// `/dev` was a plain directory, focused on its root, before its registry appeared
		app.projects.add({ root: DEV, kind: 'plain_dir', focused: [DEV], rev: 1 });
		app.diskfiles.add_initial([node('/dev/README.md'), node('/dev/scratch/x.txt')]);
		const opened = app.projects.open(DEV);
		calls[0]!.resolve(
			reply(registry_info([], 2), {
				files: encode_snapshot_files([node('/dev/README.md')]),
				opened: false
			})
		);
		const result = await opened;
		assert.ok(result.ok);
		assert.deepEqual(result.value.project?.focused, [], 'the root focus the registry dropped');
		assert.strictEqual(session_loads, 0, 'no resync');
		assert.ok(
			!seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/scratch/x.txt')),
			'the unindexed file released'
		);
		assert.ok(seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/README.md')));
	});

	test('a focus dropped while an own open is in flight is released at once, no resync', async () => {
		app.projects.add(registry_info([APP, SITE]));
		app.diskfiles.add_initial([node('/dev/app/a.ts'), node('/dev/site/a.ts')]);
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/dev/app/'));
		const without_site = {
			...registry_info([APP], 2),
			entries: registry_info([]).entries.slice(0, 1)
		};
		receive_change(without_site, 'update');
		assert.ok(!seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/site/a.ts')));
		calls[0]!.resolve(reply(without_site, { focus: APP, opened: false }));
		assert.ok((await opened).ok);
		assert.strictEqual(session_loads, 0);
	});

	test('a remote update that adds a focus pulls that repo, not a resync', () => {
		app.projects.add(registry_info([APP]));
		receive_change(registry_info([APP, SITE], 2), 'update');
		assert.strictEqual(session_loads, 0);
		assert.deepEqual(repo_files_calls, [{ root: DEV, dir: SITE }]);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
	});

	test("a remote focus during this client's own open of the root pulls it once the open settles", async () => {
		app.projects.add(registry_info([APP]));
		const opened = app.projects.open(parse_or_throw(DiskfilePath, '/dev/app/'));
		// another client focuses `site` while the open is in flight
		receive_change(registry_info([APP, SITE], 2), 'update');
		assert.strictEqual(session_loads, 0);
		assert.deepEqual(repo_files_calls, [], 'deferred while the open is in flight');
		// the open changed nothing, so its reply is the state before that focus
		calls[0]!.resolve(reply(registry_info([APP]), { focus: APP, opened: false }));
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
		receive_change(registry_info([APP, SITE], 2), 'update'); // this open's own notification
		calls[0]!.resolve(reply(registry_info([APP, SITE], 2), { focus: SITE, opened: false }));
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
		calls[0]!.resolve(
			reply(registry_info([APP]), {
				focus: APP,
				files: encode_snapshot_files([node('/dev/README.md', 2), node('/dev/app/a.ts')])
			})
		);
		const result = await opened;
		assert.ok(result.ok);
		assert.strictEqual(result.value.focus, APP);
		assert.ok(!seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/app/gone.ts')));
		assert.ok(seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/app/a.ts')));
		assert.ok(
			seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/site/kept.ts')),
			'not focused yet, so not pruned'
		);
		assert.strictEqual(
			seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/README.md'))?.mtime,
			2
		);
	});
});
