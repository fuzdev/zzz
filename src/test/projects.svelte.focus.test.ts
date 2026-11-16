// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert, vi } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath, DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import type {
	ProjectOpenOutput,
	RepoFilesOutput,
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

type Reply<T> =
	{ ok: true; value: T } | { ok: false; error: { code: number; message: string; data?: unknown } };

/** A pending request, resolved by the test. */
interface Call<T> {
	input: { root?: string; dir?: string; path?: string };
	resolve: (result: Reply<T>) => void;
}

let app: Frontend;
let focus_calls: Array<Call<RepoFocusOutput>>;
let unfocus_calls: Array<Call<RepoUnfocusOutput>>;
let open_calls: Array<Call<ProjectOpenOutput>>;
let files_calls: Array<Call<RepoFilesOutput>>;
let session: SessionLoadData;
let session_loads: number;

const node = (path: DiskfilePath): SerializableDisknode => ({
	id: path,
	source_dir: path.startsWith(APP) ? APP : path.startsWith(SITE) ? SITE : DEV,
	size: 1,
	ctime: 1,
	mtime: 1
});

/**
 * The registry project at `/dev/` with `app` and `site` present, focusing
 * `focused`, as the daemon stamped it at `rev`.
 */
const registry_info = (focused: Array<DiskfileDirectoryPath>, rev = 1): ProjectInfoJson => ({
	root: DEV,
	name: 'dev',
	opened_at: '2026-11-16T00:00:00.000Z',
	kind: 'registry',
	registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
	fallback: null,
	entries: [
		{ key: 'app', kind: 'repo', dir: APP, state: 'present' },
		{ key: 'site', kind: 'repo', dir: SITE, state: 'present' }
	],
	focused,
	rev
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
	files_calls = [];
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
		projects_rev: 1,
		server_instance_id: create_uuid()
	};
	(app as unknown as { api: unknown }).api = {
		repo_focus: pending(focus_calls),
		repo_unfocus: pending(unfocus_calls),
		project_open: pending(open_calls),
		repo_files: pending(files_calls),
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

/** The registry open with `focused` at rev 1, its files known here. */
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
				project: registry_info([SITE], 2),
				files: [node(README), node(SITE_A)],
				watch_status: 'degraded'
			}
		});
		const result = await focused;
		assert.ok(result.ok);
		assert.deepEqual(result.value?.focused, [SITE]);
		assert.strictEqual(result.value?.rev, 2);
		assert.strictEqual(result.value?.watch_status, 'degraded');
		assert.ok(app.diskfiles.get_by_path(SITE_A));
		assert.isFalse(app.projects.pending_repos.has(SITE));
		assert.strictEqual(session_loads, 0, 'the reply carries the files');
	});

	test('its own notification before the reply needs no fetch', async () => {
		setup([], [README]);
		const focused = app.projects.focus_repo(DEV, SITE);
		receive_update(registry_info([SITE], 2));
		assert.strictEqual(files_calls.length, 0, 'deferred while the focus is in flight');
		focus_calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([SITE], 2), files: [node(SITE_A)], watch_status: 'full' }
		});
		assert.ok((await focused).ok);
		await flush();
		assert.ok(app.diskfiles.get_by_path(SITE_A), 'the reply at the same rev carries the files');
		assert.strictEqual(files_calls.length, 0);
		assert.strictEqual(session_loads, 0);
	});

	test('a reply older than the state held applies neither, and what it would carry is pulled', async () => {
		setup([], [README]);
		const focused = app.projects.focus_repo(DEV, SITE);
		receive_update(registry_info([SITE], 2)); // its own
		receive_update(registry_info([APP, SITE], 3)); // another client's, after it
		focus_calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([SITE], 2), files: [node(SITE_A)], watch_status: 'full' }
		});
		const result = await focused;
		assert.ok(result.ok);
		assert.deepEqual(result.value?.focused, [APP, SITE], 'the newer state stands');
		assert.ok(!app.diskfiles.get_by_path(SITE_A), "the older reply's files aren't applied");
		assert.deepEqual(
			files_calls.map((c) => c.input).sort((a, b) => a.dir!.localeCompare(b.dir!)),
			[
				{ root: DEV, dir: APP },
				{ root: DEV, dir: SITE }
			],
			'what no applied reply carried is pulled once the focus settles'
		);
		assert.strictEqual(session_loads, 0);
	});

	test('a file kept for its draft while unfocused that the reply lacks is flagged deleted', async () => {
		setup([SITE], [SITE_A, SITE_B]);
		await edit(SITE_B);
		receive_update(registry_info([], 2));
		const b = app.diskfiles.get_by_path(SITE_B);
		assert.ok(b);
		assert.isFalse(b.deleted_on_disk);

		const focused = app.projects.focus_repo(DEV, SITE);
		focus_calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([SITE], 3), files: [node(SITE_A)], watch_status: 'full' }
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
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([APP], 2) } });
		const result = await unfocused;
		assert.ok(result.ok);
		assert.deepEqual(result.value?.focused, [APP]);
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
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([], 2) } });
		assert.ok((await unfocused).ok);
		assert.ok(app.diskfiles.get_by_path(SITE_A), 'a loose file of the nested registry');
		assert.ok(
			!app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/dev/site/sub/x.txt')),
			'below its top level, nothing indexes it'
		);
	});

	// the race logged as "an own unfocus reply dropping a remote focus"
	test("a reply older than another client's focus since leaves that focus and its files", async () => {
		setup([APP, SITE], [APP_A, SITE_A]);
		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		// another client focuses `site` again after the unfocus (rev 2); its
		// notification lands first here, the unfocus's own late
		receive_update(registry_info([APP, SITE], 3));
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([APP], 2) } });
		const result = await unfocused;
		assert.ok(result.ok);
		assert.deepEqual(result.value?.focused, [APP, SITE]);
		receive_update(registry_info([APP], 2));
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
		assert.ok(app.diskfiles.get_by_path(SITE_A), 'not released by the older state');
		assert.strictEqual(session_loads, 0);
	});

	test('a reply listing a focus this client had not heard of pulls it', async () => {
		setup([SITE], [README, SITE_A]);
		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		// another client focused `app` (rev 2), its notification never reached here
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([APP], 3) } });
		assert.ok((await unfocused).ok);
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: APP }]
		);
		files_calls[0]!.resolve({
			ok: true,
			value: { files: [node(APP_A)], watch_status: 'full', rev: 3 }
		});
		await flush();
		assert.ok(app.diskfiles.get_by_path(APP_A));
		assert.ok(!app.diskfiles.get_by_path(SITE_A), 'the unfocused repo released');
		assert.strictEqual(session_loads, 0);
	});

	test('a file another root still covers stays', async () => {
		session.scoped_dirs = [SITE];
		app.scoped_dirs = [SITE];
		setup([SITE], [SITE_A]);
		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([], 2) } });
		assert.ok((await unfocused).ok);
		assert.ok(app.diskfiles.get_by_path(SITE_A));
	});
});

describe('a remote unfocus', () => {
	test("releases the repo's files here without a resync, keeping drafts unflagged", async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B]);
		await edit(SITE_B);
		receive_update(registry_info([APP], 2));
		await flush();
		assert.strictEqual(session_loads, 0);
		assert.ok(!app.diskfiles.get_by_path(SITE_A));
		assert.isFalse(app.diskfiles.get_by_path(SITE_B)?.deleted_on_disk);
		assert.ok(app.diskfiles.get_by_path(APP_A));
	});

	test("during an own open, releases at once, and the open's older reply brings nothing back", async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B, SITE_C]);
		const c = app.diskfiles.get_by_path(SITE_C)!;
		app.diskfiles.select(c.id, true);
		await edit(SITE_B);
		const opened = app.projects.open(APP);
		receive_update(registry_info([APP], 2));
		assert.ok(!app.diskfiles.get_by_path(SITE_A), 'released by the newer state');
		// the open changed nothing, so its reply is the state before the unfocus
		open_calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([APP, SITE], 1),
				focus: APP,
				files: [node(APP_A), node(SITE_A)],
				watch_status: 'full',
				refused: [],
				opened: false
			}
		});
		assert.ok((await opened).ok);
		await flush();
		assert.strictEqual(session_loads, 0, 'no resync');
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP]);
		assert.ok(!app.diskfiles.get_by_path(SITE_A), "the older reply's files aren't applied");
		assert.isFalse(app.diskfiles.get_by_path(SITE_B)?.deleted_on_disk);
		assert.isFalse(app.diskfiles.get_by_path(SITE_C)?.deleted_on_disk, 'kept for its tab');
	});

	test('a focus dropped because its entry went missing is released, flagging drafts deleted', async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B]);
		await edit(SITE_B);
		const missing = registry_info([APP], 2);
		missing.entries[1] = { ...missing.entries[1]!, state: 'missing' };
		receive_update(missing);
		await flush();
		assert.strictEqual(session_loads, 0);
		assert.ok(!app.diskfiles.get_by_path(SITE_A));
		assert.isTrue(app.diskfiles.get_by_path(SITE_B)?.deleted_on_disk, 'gone with its dir');
		assert.ok(app.diskfiles.get_by_path(APP_A));
	});
});

describe('a remote focus', () => {
	test("pulls the repo's files alone, reconciled around filer changes, without a resync", async () => {
		setup([], [README, SITE_C]);
		receive_update(registry_info([SITE], 2));
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [SITE]);
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }]
		);
		// deleted on disk while the pull is in flight
		app.diskfiles.handle_change({
			change: { type: 'delete', path: SITE_B },
			disknode: node(SITE_B)
		});
		files_calls[0]!.resolve({
			ok: true,
			value: { files: [node(SITE_A), node(SITE_B)], watch_status: 'degraded', rev: 2 }
		});
		await flush();
		assert.ok(app.diskfiles.get_by_path(SITE_A));
		assert.ok(!app.diskfiles.get_by_path(SITE_B), 'the notification wins over the older reply');
		assert.ok(!app.diskfiles.get_by_path(SITE_C), 'known under the repo, absent from it: gone');
		assert.ok(app.diskfiles.get_by_path(README), 'outside the repo, left alone');
		assert.strictEqual(app.projects.get_by_root(DEV)?.watch_status, 'degraded');
		assert.strictEqual(session_loads, 0);
	});

	test('an older notification changes nothing and fetches nothing', () => {
		setup([SITE], [README]);
		receive_update(registry_info([APP, SITE], 1));
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [SITE]);
		assert.strictEqual(files_calls.length, 0);
	});

	test('a pull answered `repo_not_focused` is left to the change that dropped it', async () => {
		setup([], [README]);
		receive_update(registry_info([SITE], 2));
		files_calls[0]!.resolve({
			ok: false,
			error: {
				code: JSONRPC_ERROR_CODES.invalid_params,
				message: 'not focused',
				data: { reason: 'repo_not_focused' }
			}
		});
		await flush();
		assert.strictEqual(session_loads, 0);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [SITE], 'until its update lands');
	});

	test('a pull whose focus dropped here meanwhile applies nothing', async () => {
		setup([], [README]);
		receive_update(registry_info([SITE], 2));
		receive_update(registry_info([], 3));
		files_calls[0]!.resolve({
			ok: true,
			value: { files: [node(SITE_A)], watch_status: 'full', rev: 2 }
		});
		await flush();
		assert.ok(!app.diskfiles.get_by_path(SITE_A));
		assert.strictEqual(session_loads, 0);
	});

	test('a pull of an earlier focus of the repo, landing after a later one, is dropped', async () => {
		setup([], [README]);
		receive_update(registry_info([SITE], 2));
		receive_update(registry_info([], 3));
		receive_update(registry_info([SITE], 4));
		assert.strictEqual(files_calls.length, 2);
		// a file created while the repo was unfocused, which the later pull has
		const created = parse_or_throw(DiskfilePath, '/dev/site/new.txt');
		files_calls[1]!.resolve({
			ok: true,
			value: { files: [node(SITE_A), node(created)], watch_status: 'full', rev: 4 }
		});
		await flush();
		assert.ok(app.diskfiles.get_by_path(created));
		files_calls[0]!.resolve({
			ok: true,
			value: { files: [node(SITE_A)], watch_status: 'full', rev: 2 }
		});
		await flush();
		assert.ok(app.diskfiles.get_by_path(created), 'not pruned by the read of the earlier focus');
	});

	test("a later focus of another repo leaves an earlier one's pull in flight to apply", async () => {
		setup([], [README]);
		receive_update(registry_info([SITE], 2));
		receive_update(registry_info([APP, SITE], 3));
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[
				{ root: DEV, dir: SITE },
				{ root: DEV, dir: APP }
			]
		);
		// `site`'s pull read the index at its own focus, before `app`'s
		files_calls[0]!.resolve({
			ok: true,
			value: { files: [node(SITE_A)], watch_status: 'full', rev: 2 }
		});
		await flush();
		assert.ok(app.diskfiles.get_by_path(SITE_A), 'the focus it read is the one held');
	});

	test('a pull that fails otherwise resyncs', async () => {
		setup([], [README]);
		receive_update(registry_info([SITE], 2));
		files_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.internal_error, message: 'boom' }
		});
		await flush();
		assert.strictEqual(session_loads, 1);
	});

	test("an own focus's reply listing a focus not heard of pulls that repo after", async () => {
		setup([], [README]);
		const focused = app.projects.focus_repo(DEV, APP);
		// `site`'s notification (rev 2) never reached this client
		focus_calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([APP, SITE], 3),
				files: [node(APP_A)],
				watch_status: 'full'
			}
		});
		assert.ok((await focused).ok);
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }],
			"the reply carries `app`'s files alone"
		);
		files_calls[0]!.resolve({
			ok: true,
			value: { files: [node(SITE_A)], watch_status: 'full', rev: 3 }
		});
		await flush();
		assert.ok(app.diskfiles.get_by_path(SITE_A));
		// the notifications landing late fetch nothing more
		receive_update(registry_info([SITE], 2));
		receive_update(registry_info([APP, SITE], 3));
		assert.strictEqual(files_calls.length, 1);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
		assert.strictEqual(session_loads, 0);
	});

	test('during an own focus, pulls once it settles — what its reply covers excepted', async () => {
		setup([], [README]);
		const focused = app.projects.focus_repo(DEV, APP);
		// another client focuses `site`, then this focus's own notification lands
		receive_update(registry_info([SITE], 2));
		receive_update(registry_info([APP, SITE], 3));
		assert.strictEqual(files_calls.length, 0, 'deferred while the focus is in flight');
		focus_calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([APP, SITE], 3),
				files: [node(APP_A)],
				watch_status: 'full'
			}
		});
		assert.ok((await focused).ok);
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }]
		);
		files_calls[0]!.resolve({
			ok: true,
			value: { files: [node(SITE_A)], watch_status: 'full', rev: 3 }
		});
		await flush();
		assert.ok(app.diskfiles.get_by_path(APP_A));
		assert.ok(app.diskfiles.get_by_path(SITE_A));
		assert.strictEqual(session_loads, 0);
	});
});
