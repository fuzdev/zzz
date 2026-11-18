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
import { content_hash, encode_snapshot_files, seed_diskfile } from './diskfile_test_helpers.ts';

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
	ignored: {},
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
		home_dir: null,
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
	const diskfile = seed_diskfile(app, path);
	assert.ok(diskfile);
	await app.diskfiles.ensure_content(diskfile);
	app.diskfiles.select(diskfile.path, true);
	app.diskfiles.get_editor_state(diskfile).current_content = 'edited';
};

/** The plain checkout at `SITE`, resynced `resyncs` times, as stamped at `rev`. */
const checkout = (rev: number, resyncs: number): ProjectInfoJson => ({
	root: SITE,
	name: 'site',
	opened_at: '2026-11-16T00:00:00.000Z',
	kind: 'git_repo',
	registry_path: null,
	fallback: null,
	entries: [],
	focused: [SITE],
	ignored: { [SITE]: { paths: [], nested: [], resyncs } },
	rev
});

/** Delivers a `project_changed` close through the real handler. */
const receive_close = (project: ProjectInfoJson): void => {
	(app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }).receive(
		{ data: { input: { type: 'close', project } } }
	);
};

/** Answers the own open `open_calls[i]` with `project` and `files`, focusing `SITE`. */
const reply_open = (i: number, project: ProjectInfoJson, files: Array<DiskfilePath>): void => {
	open_calls[i]!.resolve({
		ok: true,
		value: {
			project,
			focus: SITE,
			watch_status: 'full',
			files: encode_snapshot_files(files.map(node)),
			refused: [],
			opened: true
		}
	});
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
				files: encode_snapshot_files([node(README), node(SITE_A)]),
				watch_status: 'degraded'
			}
		});
		const result = await focused;
		assert.ok(result.ok);
		assert.deepEqual(result.value?.focused, [SITE]);
		assert.strictEqual(result.value?.rev, 2);
		assert.strictEqual(result.value?.watch_status, 'degraded');
		assert.ok(seed_diskfile(app, SITE_A));
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
			value: {
				project: registry_info([SITE], 2),
				files: encode_snapshot_files([node(SITE_A)]),
				watch_status: 'full'
			}
		});
		assert.ok((await focused).ok);
		await flush();
		assert.ok(seed_diskfile(app, SITE_A), 'the reply at the same rev carries the files');
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
			value: {
				project: registry_info([SITE], 2),
				files: encode_snapshot_files([node(SITE_A)]),
				watch_status: 'full'
			}
		});
		const result = await focused;
		assert.ok(result.ok);
		assert.deepEqual(result.value?.focused, [APP, SITE], 'the newer state stands');
		assert.ok(!seed_diskfile(app, SITE_A), "the older reply's files aren't applied");
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
		const b = seed_diskfile(app, SITE_B);
		assert.ok(b);
		assert.isFalse(b.deleted_on_disk);

		const focused = app.projects.focus_repo(DEV, SITE);
		focus_calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([SITE], 3),
				files: encode_snapshot_files([node(SITE_A)]),
				watch_status: 'full'
			}
		});
		assert.ok((await focused).ok);
		assert.strictEqual(seed_diskfile(app, SITE_B), b);
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
		const a = seed_diskfile(app, SITE_A)!;
		app.diskfiles.select(a.path, true);
		assert.ok(app.diskfiles.editor.tabs.by_path.get(a.path));

		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		assert.deepEqual(unfocus_calls[0]!.input, { root: DEV, dir: SITE });
		assert.isTrue(app.projects.pending_repos.has(SITE));
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([APP], 2) } });
		const result = await unfocused;
		assert.ok(result.ok);
		assert.deepEqual(result.value?.focused, [APP]);
		assert.ok(!seed_diskfile(app, SITE_C), 'nothing holds it, so forgotten');
		assert.strictEqual(seed_diskfile(app, SITE_A), a, 'kept for its tab');
		assert.isFalse(a.deleted_on_disk);
		assert.ok(app.diskfiles.editor.tabs.by_path.get(a.path), 'its tab stays open');
		const b = seed_diskfile(app, SITE_B);
		assert.ok(b, 'kept for its draft');
		assert.isFalse(b.deleted_on_disk, 'still on disk, only unindexed');
		assert.ok(seed_diskfile(app, APP_A), 'the other repo keeps its files');
		assert.ok(seed_diskfile(app, README), 'and the root its loose files');
		assert.strictEqual(session_loads, 0);

		// its tab closed, nothing holds it
		app.diskfiles.editor.close_tab(app.diskfiles.editor.tabs.by_path.get(a.path)!.id);
		assert.ok(!seed_diskfile(app, SITE_A), 'released');
		// discarded and closed, nothing holds it
		app.diskfiles.get_editor_state(b).discard_draft();
		assert.ok(seed_diskfile(app, SITE_B), 'its tab still holds it');
		app.diskfiles.editor.close_tab(app.diskfiles.editor.tabs.by_path.get(b.path)!.id);
		assert.ok(!seed_diskfile(app, SITE_B), 'released');
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
		assert.ok(seed_diskfile(app, SITE_A), 'a loose file of the nested registry');
		assert.ok(
			!seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/site/sub/x.txt')),
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
		assert.ok(seed_diskfile(app, SITE_A), 'not released by the older state');
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
			value: { files: encode_snapshot_files([node(APP_A)]), watch_status: 'full', rev: 3 }
		});
		await flush();
		assert.ok(seed_diskfile(app, APP_A));
		assert.ok(!seed_diskfile(app, SITE_A), 'the unfocused repo released');
		assert.strictEqual(session_loads, 0);
	});

	test('a file another root still covers stays', async () => {
		session.scoped_dirs = [SITE];
		app.scoped_dirs = [SITE];
		setup([SITE], [SITE_A]);
		const unfocused = app.projects.unfocus_repo(DEV, SITE);
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([], 2) } });
		assert.ok((await unfocused).ok);
		assert.ok(seed_diskfile(app, SITE_A));
	});
});

describe('a remote unfocus', () => {
	test("releases the repo's files here without a resync, keeping drafts unflagged", async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B]);
		await edit(SITE_B);
		receive_update(registry_info([APP], 2));
		await flush();
		assert.strictEqual(session_loads, 0);
		assert.ok(!seed_diskfile(app, SITE_A));
		assert.isFalse(seed_diskfile(app, SITE_B)?.deleted_on_disk);
		assert.ok(seed_diskfile(app, APP_A));
	});

	test("during an own open, releases at once, and the open's older reply brings nothing back", async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B, SITE_C]);
		const c = seed_diskfile(app, SITE_C)!;
		app.diskfiles.select(c.path, true);
		await edit(SITE_B);
		const opened = app.projects.open(APP);
		receive_update(registry_info([APP], 2));
		assert.ok(!seed_diskfile(app, SITE_A), 'released by the newer state');
		// the open changed nothing, so its reply is the state before the unfocus
		open_calls[0]!.resolve({
			ok: true,
			value: {
				project: registry_info([APP, SITE], 1),
				focus: APP,
				files: encode_snapshot_files([node(APP_A), node(SITE_A)]),
				watch_status: 'full',
				refused: [],
				opened: false
			}
		});
		assert.ok((await opened).ok);
		await flush();
		assert.strictEqual(session_loads, 0, 'no resync');
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP]);
		assert.ok(!seed_diskfile(app, SITE_A), "the older reply's files aren't applied");
		assert.isFalse(seed_diskfile(app, SITE_B)?.deleted_on_disk);
		assert.isFalse(seed_diskfile(app, SITE_C)?.deleted_on_disk, 'kept for its tab');
	});

	test('a focus dropped because its entry went missing is released, flagging drafts uncovered', async () => {
		setup([APP, SITE], [APP_A, SITE_A, SITE_B]);
		await edit(SITE_B);
		const missing = registry_info([APP], 2);
		missing.entries[1] = { ...missing.entries[1]!, state: 'missing' };
		receive_update(missing);
		await flush();
		assert.strictEqual(session_loads, 0);
		assert.ok(!seed_diskfile(app, SITE_A));
		const kept = seed_diskfile(app, SITE_B);
		assert.ok(kept, 'its draft keeps it');
		assert.isTrue(kept.uncovered, 'out of the index, not seen deleted');
		assert.isFalse(kept.deleted_on_disk);
		assert.ok(seed_diskfile(app, APP_A));
	});

	test.each(['left the registry', 'went missing'] as const)(
		'an unfocused repo that %s releases its held files, flagged uncovered',
		async (how) => {
			setup([APP, SITE], [APP_A, SITE_A, SITE_B]);
			await edit(SITE_B);
			receive_update(registry_info([APP], 2));
			await flush();
			const b = seed_diskfile(app, SITE_B);
			assert.ok(b, 'unfocused, kept for its draft');
			assert.isFalse(b.uncovered, 'kept as it is while its repo is listed');

			const next = registry_info([APP], 3);
			if (how === 'left the registry') {
				next.entries = next.entries.slice(0, 1);
			} else {
				next.entries[1] = { ...next.entries[1]!, state: 'missing' };
			}
			receive_update(next);
			await flush();
			assert.strictEqual(seed_diskfile(app, SITE_B), b);
			assert.isTrue(b.uncovered, 'no longer an unfocused repo of an open project');
			assert.notInclude(
				app.diskfiles.on_disk.map((r) => r.id),
				b.path,
				'not listed as an indexed file'
			);
			assert.isFalse(app.diskfiles.open_path(b.path), 'not openable as indexed');

			app.diskfiles.get_editor_state(b).discard_draft();
			app.diskfiles.editor.tabs.close_all_tabs();
			assert.isUndefined(seed_diskfile(app, SITE_B), 'forgotten once nothing holds it');
		}
	);
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
			value: {
				files: encode_snapshot_files([node(SITE_A), node(SITE_B)]),
				watch_status: 'degraded',
				rev: 2
			}
		});
		await flush();
		assert.ok(seed_diskfile(app, SITE_A));
		assert.ok(!seed_diskfile(app, SITE_B), 'the notification wins over the older reply');
		assert.ok(!seed_diskfile(app, SITE_C), 'known under the repo, absent from it: gone');
		assert.ok(seed_diskfile(app, README), 'outside the repo, left alone');
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
			value: { files: encode_snapshot_files([node(SITE_A)]), watch_status: 'full', rev: 2 }
		});
		await flush();
		assert.ok(!seed_diskfile(app, SITE_A));
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
			value: {
				files: encode_snapshot_files([node(SITE_A), node(created)]),
				watch_status: 'full',
				rev: 4
			}
		});
		await flush();
		assert.ok(seed_diskfile(app, created));
		files_calls[0]!.resolve({
			ok: true,
			value: { files: encode_snapshot_files([node(SITE_A)]), watch_status: 'full', rev: 2 }
		});
		await flush();
		assert.ok(seed_diskfile(app, created), 'not pruned by the read of the earlier focus');
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
			value: { files: encode_snapshot_files([node(SITE_A)]), watch_status: 'full', rev: 2 }
		});
		await flush();
		assert.ok(seed_diskfile(app, SITE_A), 'the focus it read is the one held');
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
				files: encode_snapshot_files([node(APP_A)]),
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
			value: { files: encode_snapshot_files([node(SITE_A)]), watch_status: 'full', rev: 3 }
		});
		await flush();
		assert.ok(seed_diskfile(app, SITE_A));
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
				files: encode_snapshot_files([node(APP_A)]),
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
			value: { files: encode_snapshot_files([node(SITE_A)]), watch_status: 'full', rev: 3 }
		});
		await flush();
		assert.ok(seed_diskfile(app, APP_A));
		assert.ok(seed_diskfile(app, SITE_A));
		assert.strictEqual(session_loads, 0);
	});
});

describe('a resync of a focused repo', () => {
	/** `registry_info` with `ignored` for `SITE`. */
	const with_ignored = (
		info: ProjectInfoJson,
		paths: Array<string>,
		resyncs: number
	): ProjectInfoJson => ({ ...info, ignored: { [SITE]: { paths, nested: [], resyncs } } });

	test("pulls the repo whole: what's now ignored pruned, what's no longer ignored added", async () => {
		app.projects.add(with_ignored(registry_info([SITE]), ['c.txt'], 0));
		app.diskfiles.add_initial([README, SITE_A, SITE_B].map(node));
		// `b.txt` newly ignored and `c.txt` un-ignored, past what the daemon
		// sends per file
		receive_update(with_ignored(registry_info([SITE], 2), ['b.txt'], 1));
		assert.deepEqual(app.projects.get_by_root(DEV)?.ignored[SITE], {
			paths: ['b.txt'],
			nested: [],
			resyncs: 1
		});
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }]
		);
		files_calls[0]!.resolve({
			ok: true,
			value: {
				files: encode_snapshot_files([node(SITE_A), node(SITE_C)]),
				watch_status: 'full',
				rev: 2
			}
		});
		await flush();
		assert.ok(seed_diskfile(app, SITE_A));
		assert.ok(!seed_diskfile(app, SITE_B), 'now ignored: pruned');
		assert.ok(seed_diskfile(app, SITE_C), 'no longer ignored: added');
		assert.ok(seed_diskfile(app, README), 'outside the repo, left alone');
		assert.strictEqual(session_loads, 0);
	});

	test('a change of the paths alone pulls nothing: its changes were sent per file', () => {
		app.projects.add(with_ignored(registry_info([SITE]), [], 0));
		receive_update(with_ignored(registry_info([SITE], 2), ['x.log', 'out/'], 0));
		assert.deepEqual(app.projects.get_by_root(DEV)?.ignored[SITE]?.paths, ['x.log', 'out/']);
		assert.strictEqual(files_calls.length, 0);
	});

	test('the entry going (git falling back to fixed names) pulls', () => {
		app.projects.add(with_ignored(registry_info([SITE]), ['b.txt'], 0));
		receive_update(registry_info([SITE], 2));
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }]
		);
	});

	test('an older resync changes nothing and fetches nothing', () => {
		app.projects.add(with_ignored(registry_info([SITE], 3), ['b.txt'], 2));
		receive_update(with_ignored(registry_info([SITE], 2), [], 1));
		assert.strictEqual(app.projects.get_by_root(DEV)?.ignored[SITE]?.resyncs, 2);
		assert.strictEqual(files_calls.length, 0);
	});

	test('a pull read before a later resync is dropped, whatever order the pulls land in', async () => {
		app.projects.add(with_ignored(registry_info([SITE]), [], 0));
		app.diskfiles.add_initial([README, SITE_A].map(node));
		// un-ignored past what the daemon sends per file, then ignored again
		// while the first pull is in flight
		receive_update(with_ignored(registry_info([SITE], 2), [], 1));
		receive_update(with_ignored(registry_info([SITE], 3), ['b.txt'], 2));
		assert.strictEqual(files_calls.length, 2);
		files_calls[1]!.resolve({
			ok: true,
			value: { files: encode_snapshot_files([node(SITE_A)]), watch_status: 'full', rev: 3 }
		});
		await flush();
		// the first pull, larger, lands last
		files_calls[0]!.resolve({
			ok: true,
			value: {
				files: encode_snapshot_files([node(SITE_A), node(SITE_B)]),
				watch_status: 'full',
				rev: 2
			}
		});
		await flush();
		assert.ok(seed_diskfile(app, SITE_A));
		assert.ok(!seed_diskfile(app, SITE_B), "the older pull's files aren't applied");
	});

	test('during an own focus, pulls once it settles — unless the reply covers the repo', async () => {
		app.projects.add(with_ignored(registry_info([SITE]), [], 0));
		app.diskfiles.add_initial([README, SITE_A].map(node));
		const focusing = app.projects.focus_repo(DEV, APP);
		receive_update(with_ignored(registry_info([APP, SITE], 2), [], 1));
		assert.strictEqual(files_calls.length, 0, 'held while the focus is in flight');
		focus_calls[0]!.resolve({
			ok: true,
			value: {
				project: with_ignored(registry_info([APP, SITE], 2), [], 1),
				files: encode_snapshot_files([node(APP_A)]),
				watch_status: 'full'
			}
		});
		await focusing;
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }],
			'the reply covered the focused repo alone'
		);
	});

	test('a resynced plain checkout pulls its root, not the session', async () => {
		app.projects.add(checkout(1, 0));
		app.diskfiles.add_initial([SITE_A].map(node));
		receive_update(checkout(2, 1));
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: SITE, dir: SITE }]
		);
		await flush();
		assert.strictEqual(session_loads, 0, 'no session resync');
	});

	/** An own open of a path in `SITE` whose reply carries `project`. */
	const open_with_reply = async (project: ProjectInfoJson): Promise<void> => {
		const opening = app.projects.open(SITE_A);
		receive_update(with_ignored(registry_info([SITE], 2), [], 1));
		assert.strictEqual(files_calls.length, 0, 'held while the open is in flight');
		open_calls[0]!.resolve({
			ok: true,
			value: {
				project,
				focus: SITE,
				watch_status: 'full',
				files: encode_snapshot_files([node(SITE_A), node(SITE_B)]),
				refused: [],
				opened: false
			}
		});
		await opening;
		await flush();
	};

	test('an own reply covering the resynced repo at its rev settles it: no pull', async () => {
		app.projects.add(with_ignored(registry_info([SITE]), [], 0));
		app.diskfiles.add_initial([README, SITE_A].map(node));
		await open_with_reply(with_ignored(registry_info([SITE], 2), [], 1));
		assert.ok(seed_diskfile(app, SITE_B), 'the reply carried the files');
		assert.strictEqual(files_calls.length, 0);
		assert.strictEqual(session_loads, 0);
	});

	test('an own reply covering the resynced repo at an older rev is dropped: the pull goes out', async () => {
		app.projects.add(with_ignored(registry_info([SITE]), [], 0));
		app.diskfiles.add_initial([README, SITE_A].map(node));
		await open_with_reply(with_ignored(registry_info([SITE], 1), [], 0));
		assert.ok(!seed_diskfile(app, SITE_B), "the older reply's files aren't applied");
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }]
		);
		assert.strictEqual(session_loads, 0);
	});
});

describe('a checkout new here, once its files arrive', () => {
	test('settled by its own open reply, a later resync pulls its root', async () => {
		const opening = app.projects.open(SITE_A);
		receive_update(checkout(5, 0)); // its own notification first: new here
		reply_open(0, checkout(5, 0), [SITE_A]);
		await opening;
		await flush();
		assert.strictEqual(session_loads, 0);
		receive_update(checkout(6, 1));
		await flush();
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: SITE, dir: SITE }]
		);
		assert.strictEqual(session_loads, 0, 'no session resync');
	});

	test('settled by a snapshot during an own open, a later resync pulls its root', async () => {
		session.projects = [checkout(5, 0)];
		session.projects_rev = 5;
		session.file_roots = [parse_or_throw(DiskfileDirectoryPath, '/zzz/'), SITE];
		const opening = app.projects.open(parse_or_throw(DiskfilePath, '/elsewhere/x'));
		receive_update(checkout(5, 0));
		app.resync_session();
		await flush();
		assert.strictEqual(session_loads, 1);
		open_calls[0]!.resolve({ ok: false, error: { code: -32000, message: 'nope' } });
		await opening;
		await flush();
		assert.strictEqual(session_loads, 1, 'the snapshot settled it');
		receive_update(checkout(6, 1));
		await flush();
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: SITE, dir: SITE }]
		);
		assert.strictEqual(session_loads, 1, 'no session resync');
	});

	test('closed while held, then reopened by its own reply, a later resync pulls its root', async () => {
		const opening = app.projects.open(SITE_A);
		receive_update(checkout(5, 0));
		receive_close(checkout(6, 0));
		assert.ok(!app.projects.get_by_root(SITE));
		reply_open(0, checkout(7, 0), [SITE_A]);
		await opening;
		await flush();
		assert.ok(app.projects.get_by_root(SITE));
		const loads = session_loads;
		receive_update(checkout(8, 1));
		await flush();
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: SITE, dir: SITE }]
		);
		assert.strictEqual(session_loads, loads, 'no session resync');
	});

	test('held across a restart snapshot during an own open, a later resync pulls its root', async () => {
		app.resync_session();
		await flush();
		const opening = app.projects.open(parse_or_throw(DiskfilePath, '/elsewhere/x'));
		receive_update(checkout(5, 0));
		session = {
			...session,
			projects: [checkout(2, 0)],
			projects_rev: 2,
			server_instance_id: create_uuid(),
			file_roots: [parse_or_throw(DiskfileDirectoryPath, '/zzz/'), SITE]
		};
		app.resync_session();
		await flush();
		open_calls[0]!.resolve({ ok: false, error: { code: -32000, message: 'nope' } });
		await opening;
		await flush();
		const loads = session_loads;
		receive_update(checkout(3, 1));
		await flush();
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: SITE, dir: SITE }]
		);
		assert.strictEqual(session_loads, loads, 'no session resync');
	});

	test('resynced by the session once, a later resync pulls its root', async () => {
		session.projects = [checkout(5, 0)];
		session.projects_rev = 5;
		session.file_roots = [parse_or_throw(DiskfileDirectoryPath, '/zzz/'), SITE];
		receive_update(checkout(5, 0));
		await flush();
		assert.strictEqual(session_loads, 1);
		receive_update(checkout(6, 1));
		await flush();
		assert.deepEqual(
			files_calls.map((c) => c.input),
			[{ root: SITE, dir: SITE }]
		);
		assert.strictEqual(session_loads, 1, 'no second session resync');
	});
});
