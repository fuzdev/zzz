// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert, vi } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath, DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import type {
	ProjectOpenOutput,
	RepoFocusOutput,
	RepoUnfocusOutput,
	SessionLoadData
} from '#lib/action_specs.ts';
import type { ProjectInfoJson } from '#lib/project.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { content_hash } from './diskfile_test_helpers.ts';

const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
const APP = parse_or_throw(DiskfileDirectoryPath, '/dev/app/');
const SITE = parse_or_throw(DiskfileDirectoryPath, '/dev/site/');
const README = parse_or_throw(DiskfilePath, '/dev/README.md');
const APP_A = parse_or_throw(DiskfilePath, '/dev/app/a.txt');
const SITE_A = parse_or_throw(DiskfilePath, '/dev/site/a.txt');
const SITE_B = parse_or_throw(DiskfilePath, '/dev/site/b.txt');
const SITE_C = parse_or_throw(DiskfilePath, '/dev/site/c.txt');

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: number; message: string } };

/** A pending request, resolved by the test. */
interface Call<T> {
	input: { root?: string; dir?: string; path?: string };
	resolve: (result: Reply<T>) => void;
}

let app: Frontend;
let focus_calls: Array<Call<RepoFocusOutput>>;
let unfocus_calls: Array<Call<RepoUnfocusOutput>>;
let open_calls: Array<Call<ProjectOpenOutput>>;
let session: SessionLoadData;
let session_loads: number;

const node = (path: DiskfilePath): SerializableDisknode => ({
	id: path,
	source_dir: path.startsWith(APP) ? APP : path.startsWith(SITE) ? SITE : DEV,
	size: 1,
	ctime: 1,
	mtime: 1
});

/** The registry project at `/dev/` with `app` and `site` present, focusing `focused`. */
const registry_info = (focused: Array<DiskfileDirectoryPath>): ProjectInfoJson => ({
	root: DEV,
	name: 'dev',
	opened_at: '2026-11-16T00:00:00.000Z',
	kind: 'registry',
	registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
	entries: [
		{ key: 'app', kind: 'repo', dir: APP, state: 'present' },
		{ key: 'site', kind: 'repo', dir: SITE, state: 'present' }
	],
	focused
});

const pending =
	<T>(calls: Array<Call<T>>) =>
	(input: Call<T>['input']) =>
		new Promise<Reply<T>>((resolve) => calls.push({ input, resolve }));

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	focus_calls = [];
	unfocus_calls = [];
	open_calls = [];
	session_loads = 0;
	session = {
		zzz_dir: parse_or_throw(DiskfileDirectoryPath, '/zzz/'),
		scoped_dirs: [],
		files: [],
		file_roots: [parse_or_throw(DiskfileDirectoryPath, '/zzz/'), DEV],
		provider_status: [],
		projects: [],
		terminal_ids: [],
		jobs: [],
		server_instance_id: create_uuid()
	};
	(app as unknown as { api: unknown }).api = {
		repo_focus: pending(focus_calls),
		repo_unfocus: pending(unfocus_calls),
		project_open: pending(open_calls),
		session_load: () => {
			session_loads++;
			return Promise.resolve({ ok: true, value: { data: session } });
		},
		diskfile_read: () =>
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
			})
	};
});

afterEach(() => {
	app.dispose();
});

const flush = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Delivers a `project_changed` update through the real handler. */
const receive_update = (project: ProjectInfoJson): void => {
	(app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }).receive(
		{ data: { input: { type: 'update', project } } }
	);
};

/** The registry open with `focused`, its files known here. */
const setup = (focused: Array<DiskfileDirectoryPath>, files: Array<DiskfilePath>): void => {
	app.projects.add(registry_info(focused));
	app.diskfiles.add_initial(files.map(node));
};

/** Opens the file at `path` in a tab with a draft. */
const edit = async (path: DiskfilePath): Promise<void> => {
	const diskfile = app.diskfiles.get_by_path(path);
	assert.ok(diskfile);
	await app.diskfiles.ensure_content(diskfile);
	app.diskfiles.select(diskfile.id, true);
	app.diskfiles.get_editor_state(diskfile).current_content = 'edited';
};

describe('Projects.focus_repo', () => {
	test("adds the focus and the repo's files, pending while in flight", async () => {
		setup([], [README]);
		const focused = app.projects.focus_repo(DEV, SITE);
		assert.deepEqual(focus_calls[0]!.input, { root: DEV, dir: SITE });
		assert.isTrue(app.projects.pending_repos.has(SITE));
		focus_calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([SITE]),
				files: [node(README), node(SITE_A)],
				watch_status: 'degraded'
			}
		});
		const result = await focused;
		assert.ok(result.ok);
		assert.deepEqual(result.value.focused, [SITE]);
		assert.strictEqual(result.value.watch_status, 'degraded');
		assert.ok(app.diskfiles.get_by_path(SITE_A));
		assert.isFalse(app.projects.pending_repos.has(SITE));
		assert.strictEqual(session_loads, 0, 'the reply carries the files');
	});

	test('its own notification before the reply needs no resync', async () => {
		setup([], [README]);
		const focused = app.projects.focus_repo(DEV, SITE);
		receive_update(registry_info([SITE]));
		focus_calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([SITE]), files: [node(SITE_A)], watch_status: 'full' }
		});
		assert.ok((await focused).ok);
		await flush();
		assert.strictEqual(session_loads, 0);
	});

	test('a file kept for its draft while unfocused that the reply lacks is flagged deleted', async () => {
		setup([SITE], [SITE_A, SITE_B]);
		await edit(SITE_B);
		app.projects.add(registry_info([]));
		app.diskfiles.release_unfocused(SITE);
		const b = app.diskfiles.get_by_path(SITE_B);
		assert.ok(b);
		assert.isFalse(b.deleted_on_disk);

		const focused = app.projects.focus_repo(DEV, SITE);
		focus_calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([SITE]), files: [node(SITE_A)], watch_status: 'full' }
		});
		assert.ok((await focused).ok);
		assert.strictEqual(app.diskfiles.get_by_path(SITE_B), b);
		assert.isTrue(b.deleted_on_disk, 'gone from disk meanwhile');
	});

	test('returns the error and changes nothing on failure', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		setup([], [README]);
		const focused = app.projects.focus_repo(DEV, SITE);
		focus_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.not_found, message: 'failed to focus repo: gone' }
		});
		const result = await focused;
		assert.ok(!result.ok);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, []);
		assert.isFalse(app.projects.pending_repos.has(SITE));
	});
});

describe('Projects.unfocus_repo', () => {
	test("drops the focus and forgets the repo's files, keeping drafts and tabs unflagged", async () => {
		setup([APP, SITE], [README, APP_A, SITE_A, SITE_B, SITE_C]);
		await edit(SITE_B);
		// a tab with no draft
		const a = app.diskfiles.get_by_path(SITE_A)!;
		app.diskfiles.select(a.id, true);
		assert.ok(app.diskfiles.editor.tabs.by_diskfile_id.get(a.id));

		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		assert.deepEqual(unfocus_calls[0]!.input, { root: DEV, dir: SITE });
		assert.isTrue(app.projects.pending_repos.has(SITE));
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([APP]) } });
		const result = await unfocused;
		assert.ok(result.ok);
		assert.deepEqual(result.value.focused, [APP]);
		assert.ok(!app.diskfiles.get_by_path(SITE_C), 'nothing holds it, so forgotten');
		assert.strictEqual(app.diskfiles.get_by_path(SITE_A), a, 'kept for its tab');
		assert.isFalse(a.deleted_on_disk);
		assert.ok(app.diskfiles.editor.tabs.by_diskfile_id.get(a.id), 'its tab stays open');
		const b = app.diskfiles.get_by_path(SITE_B);
		assert.ok(b, 'kept for its draft');
		assert.isFalse(b.deleted_on_disk, 'still on disk, only unindexed');
		assert.ok(app.diskfiles.get_by_path(APP_A), 'the other repo keeps its files');
		assert.ok(app.diskfiles.get_by_path(README), 'and the root its loose files');
		assert.strictEqual(session_loads, 0);

		// its tab closed, nothing holds it
		app.diskfiles.editor.close_tab(app.diskfiles.editor.tabs.by_diskfile_id.get(a.id)!.id);
		assert.ok(!app.diskfiles.get_by_path(SITE_A), 'released');
		// discarded and closed, nothing holds it
		app.diskfiles.get_editor_state(b).discard_draft();
		assert.ok(app.diskfiles.get_by_path(SITE_B), 'its tab still holds it');
		app.diskfiles.editor.close_tab(app.diskfiles.editor.tabs.by_diskfile_id.get(b.id)!.id);
		assert.ok(!app.diskfiles.get_by_path(SITE_B), 'released');
	});

	test("a nested registry's loose files stay, indexed at its top level", async () => {
		// a registry rooted at `site`, open beside `/dev/`, indexes its loose files
		app.projects.add({
			...registry_info([]),
			root: SITE,
			name: 'site',
			entries: []
		});
		setup([SITE], [SITE_A, parse_or_throw(DiskfilePath, '/dev/site/sub/x.txt')]);
		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([]) } });
		assert.ok((await unfocused).ok);
		assert.ok(app.diskfiles.get_by_path(SITE_A), 'a loose file of the nested registry');
		assert.ok(
			!app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/site/sub/x.txt')),
			'below its top level, nothing indexes it'
		);
	});

	test("a reply that predates another client's focus keeps it", async () => {
		setup([APP], []);
		session.projects = [registry_info([SITE])]; // the daemon's state after both
		const unfocused = app.projects.unfocus_repo(DEV, APP);
		// another client focuses `site` after the unfocus, its notification first here
		receive_update(registry_info([APP, SITE]));
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([]) } });
		const result = await unfocused;
		assert.ok(result.ok);
		assert.deepEqual(result.value.focused, [SITE]);
	});

	test('a file another root still covers stays', async () => {
		session.scoped_dirs = [SITE];
		app.scoped_dirs = [SITE];
		setup([SITE], [SITE_A]);
		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([]) } });
		assert.ok((await unfocused).ok);
		assert.ok(app.diskfiles.get_by_path(SITE_A));
	});
});

describe('a remote unfocus', () => {
	test("releases the repo's files here without a resync, keeping drafts unflagged", async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B]);
		await edit(SITE_B);
		receive_update(registry_info([APP]));
		await flush();
		assert.strictEqual(session_loads, 0);
		assert.ok(!app.diskfiles.get_by_path(SITE_A));
		assert.isFalse(app.diskfiles.get_by_path(SITE_B)?.deleted_on_disk);
		assert.ok(app.diskfiles.get_by_path(APP_A));
	});

	test('during an own open, resyncs once it settles — the snapshot keeps drafts and tabs unflagged', async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B, SITE_C]);
		const c = app.diskfiles.get_by_path(SITE_C)!;
		app.diskfiles.select(c.id, true);
		await edit(SITE_B);
		const opened = app.projects.open(APP);
		receive_update(registry_info([APP]));
		assert.ok(app.diskfiles.get_by_path(SITE_A), 'not yet');
		session.projects = [registry_info([APP])];
		session.files = [node(APP_A)];
		open_calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([APP, SITE]),
				focus: APP,
				files: [node(APP_A), node(SITE_A)],
				watch_status: 'full'
			}
		});
		assert.ok((await opened).ok);
		await flush();
		assert.strictEqual(session_loads, 1);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP], 'the snapshot wins');
		assert.ok(!app.diskfiles.get_by_path(SITE_A));
		assert.isFalse(app.diskfiles.get_by_path(SITE_B)?.deleted_on_disk);
		assert.isFalse(app.diskfiles.get_by_path(SITE_C)?.deleted_on_disk, 'kept for its tab');
	});

	test('a focus dropped because its entry went missing resyncs, flagging drafts deleted', async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B]);
		await edit(SITE_B);
		const missing = registry_info([APP]);
		missing.entries[1] = { ...missing.entries[1]!, state: 'missing' };
		session.projects = [missing];
		session.files = [node(APP_A)];
		receive_update(missing);
		await flush();
		assert.strictEqual(session_loads, 1);
		assert.ok(!app.diskfiles.get_by_path(SITE_A));
		assert.isTrue(app.diskfiles.get_by_path(SITE_B)?.deleted_on_disk);
	});
});
