// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import {
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType,
	type SnapshotFiles
} from '#lib/diskfile_types.ts';
import { Frontend, SESSION_BOOT_FALLBACK_DELAY } from '#lib/frontend.svelte.ts';
import type { ProjectFocusRefusal, RepoFocusOutput, SessionLoadData } from '#lib/action_specs.ts';
import type { ProjectInfoJson } from '#lib/project.svelte.ts';
import { ERROR_PROJECT_NOT_OPEN, ERROR_REPO_INDEX_FAILED } from '#lib/project_helpers.ts';
import type { Terminal } from '#lib/terminal.svelte.ts';
import {
	TERMINAL_LOST_TO_RESTART_MESSAGE,
	TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE
} from '#lib/terminal_helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { content_hash, encode_snapshot_files } from './diskfile_test_helpers.ts';

const ZZZ_DIR = parse_or_throw(DiskfileDirectoryPath, '/zzz/');
const WS_DIR = parse_or_throw(DiskfileDirectoryPath, '/ws/');
const OTHER_DIR = parse_or_throw(DiskfileDirectoryPath, '/other/');

const ZZZ_A = parse_or_throw(DiskfilePath, '/zzz/a.txt');
const ZZZ_B = parse_or_throw(DiskfilePath, '/zzz/b.txt');
const WS_A = parse_or_throw(DiskfilePath, '/ws/a.txt');
const OTHER_A = parse_or_throw(DiskfilePath, '/other/a.txt');

/** A disknode as the backend sends it — metadata only, `mtime` telling versions apart. */
const create_disknode = (path: DiskfilePath, mtime = 1): SerializableDisknode => ({
	id: path,
	source_dir: [WS_DIR, OTHER_DIR].find((dir) => path.startsWith(dir)) ?? ZZZ_DIR,
	size: 1,
	ctime: 1,
	mtime
});

/** A plain-directory project at `root`, as the daemon stamped it at `rev`. */
const create_project_info = (root: DiskfileDirectoryPath, rev = 1): ProjectInfoJson => ({
	root,
	name: root,
	opened_at: new Date(0).toISOString(),
	kind: 'plain_dir',
	registry_path: null,
	fallback: null,
	entries: [],
	focused: [root],
	ignored: {},
	rev
});

let server_instance_id: Uuid;

const create_session = (data: Partial<SessionLoadData> = {}): SessionLoadData => ({
	zzz_dir: ZZZ_DIR,
	scoped_dirs: [],
	files: [],
	file_roots: [ZZZ_DIR],
	provider_status: [],
	projects: [],
	projects_rev: 1,
	terminal_ids: [],
	jobs: [],
	server_instance_id,
	...data
});

type SessionLoadResult =
	| { ok: true; value: { data: SessionLoadData } }
	| { ok: false; error: { code: number; message: string } };

type ProjectOpenResult =
	| {
			ok: true;
			value: {
				project: ProjectInfoJson;
				focus: DiskfileDirectoryPath | null;
				files: SnapshotFiles;
				watch_status: 'full';
				refused: Array<ProjectFocusRefusal>;
				opened: boolean;
			};
	  }
	| { ok: false; error: { code: number; message: string } };

let app: Frontend;
/** What each path reads as (`diskfile_read`) — `contents` when not set. */
let disk: Map<string, string>;
/** Every path read, in order. */
let reads: Array<string>;
/** Pending `session_load` calls, resolved by the test. */
let calls: Array<(result: SessionLoadResult) => void>;
/** Pending `project_open` calls, each its path and requested focus, resolved by the test. */
let open_calls: Array<{
	path: string;
	focus: Array<string>;
	resolve: (result: ProjectOpenResult) => void;
}>;
/** Pending `repo_focus` calls, resolved by the test. */
let focus_calls: Array<(result: { ok: true; value: RepoFocusOutput }) => void>;

beforeEach(() => {
	server_instance_id = create_uuid();
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = [];
	open_calls = [];
	focus_calls = [];
	disk = new Map();
	reads = [];
	(app as unknown as { api: unknown }).api = {
		session_load: () => new Promise<SessionLoadResult>((resolve) => calls.push(resolve)),
		diskfile_read: ({ path }: { path: string }) => {
			reads.push(path);
			const contents = disk.get(path) ?? 'contents';
			return Promise.resolve({
				ok: true,
				value: {
					contents,
					unloaded_reason: null,
					hash: content_hash(contents),
					size: contents.length,
					ctime: 1,
					mtime: 1
				}
			});
		},
		project_open: ({ path, focus }: { path: string; focus?: Array<string> }) =>
			new Promise<ProjectOpenResult>((resolve) =>
				open_calls.push({ path, focus: focus ?? [], resolve })
			),
		repo_focus: () => new Promise((resolve) => focus_calls.push(resolve)),
		repo_files: () =>
			Promise.resolve({ ok: true, value: { files: [], watch_status: 'full', rev: 0 } })
	};
});

const flush = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
	app.dispose();
});

/** Resolves pending `session_load` call `index` with `data` and lets it apply. */
const succeed = async (index: number, data: Partial<SessionLoadData> = {}): Promise<void> => {
	calls[index]!({ ok: true, value: { data: create_session(data) } });
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Loads a session snapshot to completion. */
const load = async (data: Partial<SessionLoadData> = {}): Promise<void> => {
	const loaded = app.load_session();
	await succeed(calls.length - 1, data);
	assert.ok(await loaded);
};

const filer_change = (type: DiskfileChangeType, path: DiskfilePath, mtime?: number): void => {
	app.diskfiles.handle_change({
		change: { type, path },
		disknode: create_disknode(path, mtime)
	});
};

/** Loads the content of the file at `path` (`diskfile_read`), as a view would. */
const load_content = async (path: DiskfilePath): Promise<void> => {
	const diskfile = app.diskfiles.get_by_path(path);
	assert.ok(diskfile);
	await app.diskfiles.ensure_content(diskfile);
};

/** Overrides the socket's reactive `connected` for the test. */
const set_socket_connected = (connected: boolean): void => {
	Object.defineProperty(app.socket, 'connected', { value: connected, configurable: true });
};

const add_running_terminal = (): Terminal =>
	app.terminals.add({ status: 'running', terminal_id: create_uuid() });

/** Delivers a `project_changed` notification through the real handler. */
const notify = (type: 'open' | 'update' | 'close', project: ProjectInfoJson): void =>
	(app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }).receive(
		{ data: { input: { type, project } } }
	);

/** A socket connect time after everything so far. */
let clock = 0;
const connect_time = (): number => (clock = Math.max(clock + 1, Date.now() + 1_000));

describe('boot load', () => {
	test('waits for the first connect and loads over it, without a resync', async () => {
		app.socket.url_input = 'ws://localhost/api/ws';
		app.boot_session();
		assert.strictEqual(calls.length, 0, 'waits for the socket');
		assert.strictEqual(app.session_status, 'initial');

		assert.ok(!app.handle_socket_connect(connect_time()), 'the boot load, not a resync');
		assert.strictEqual(calls.length, 1);
		await succeed(0);
		assert.strictEqual(app.session_status, 'success');
		assert.strictEqual(calls.length, 1);
	});

	test('falls back to HTTP when the socket does not open in time, then resyncs on connect', async () => {
		vi.useFakeTimers();
		try {
			app.socket.url_input = 'ws://localhost/api/ws';
			app.boot_session();
			await vi.advanceTimersByTimeAsync(SESSION_BOOT_FALLBACK_DELAY - 1);
			assert.strictEqual(calls.length, 0);
			await vi.advanceTimersByTimeAsync(1);
			assert.strictEqual(calls.length, 1, 'loaded without the socket');
			await succeed(0);

			// changes between that snapshot and the socket opening were never sent here
			assert.ok(app.handle_socket_connect(connect_time()), 'the first connect resyncs');
			assert.strictEqual(calls.length, 2);
		} finally {
			vi.useRealTimers();
		}
	});

	test('a connect cancels the fallback', async () => {
		vi.useFakeTimers();
		try {
			app.socket.url_input = 'ws://localhost/api/ws';
			app.boot_session();
			app.handle_socket_connect(connect_time());
			await succeed(0);
			await vi.advanceTimersByTimeAsync(SESSION_BOOT_FALLBACK_DELAY * 2);
			assert.strictEqual(calls.length, 1);
		} finally {
			vi.useRealTimers();
		}
	});

	test('loads right away without a socket', () => {
		app.boot_session();
		assert.strictEqual(calls.length, 1);
		app.boot_session();
		assert.strictEqual(calls.length, 1, 'once');
	});

	test('a first connect during a failed load’s backoff retries now', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			app.boot_session();
			calls[0]!({ ok: false, error: { code: -32603, message: 'down' } });
			await vi.advanceTimersByTimeAsync(0);
			assert.strictEqual(app.session_status, 'failure');

			assert.ok(app.handle_socket_connect(connect_time()));
			assert.strictEqual(calls.length, 2, 'without waiting out the backoff');
		} finally {
			vi.useRealTimers();
		}
	});

	test('a first connect after a load sent over the socket does not resync, even in the same ms', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			set_socket_connected(true);
			await load();
			assert.ok(!app.handle_socket_connect(Date.now()), 'the load went over this socket');
		} finally {
			vi.useRealTimers();
		}
		assert.strictEqual(calls.length, 1);
	});

	test('a first connect after a load sent without the socket resyncs, even in the same ms', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			await load();
			assert.ok(app.handle_socket_connect(Date.now()), 'the load missed this socket');
		} finally {
			vi.useRealTimers();
		}
		assert.strictEqual(calls.length, 2);
	});

	test('when already connected, loads right away with no fallback timer', async () => {
		vi.useFakeTimers();
		try {
			app.socket.url_input = 'ws://localhost/api/ws';
			set_socket_connected(true);
			app.boot_session();
			assert.strictEqual(calls.length, 1, 'immediately');
			await succeed(0);
			await vi.advanceTimersByTimeAsync(SESSION_BOOT_FALLBACK_DELAY * 2);
			assert.strictEqual(calls.length, 1, 'no fallback load');
			assert.ok(!app.handle_socket_connect(connect_time()), 'its connect needs nothing more');
			assert.strictEqual(calls.length, 1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('reconnect detection', () => {
	test('each reconnect resyncs', async () => {
		assert.ok(!app.handle_socket_connect(null), 'not connected yet');
		assert.ok(!app.handle_socket_connect(connect_time()), 'the first connect boots');
		assert.strictEqual(calls.length, 1);
		await succeed(0);

		const same = clock;
		assert.ok(!app.handle_socket_connect(same), 'the same connect seen again');
		assert.strictEqual(calls.length, 1);

		assert.ok(app.handle_socket_connect(connect_time()), 'a reconnect');
		assert.strictEqual(calls.length, 2);
		await succeed(1);
		assert.strictEqual(app.session_status, 'success');

		// the disconnect in between doesn't count, the next open does
		assert.ok(!app.handle_socket_connect(null));
		assert.ok(app.handle_socket_connect(connect_time()));
		assert.strictEqual(calls.length, 3);
	});

	test('a reconnect during an in-flight load resyncs once that load finishes', async () => {
		app.handle_socket_connect(connect_time());
		assert.ok(app.handle_socket_connect(connect_time()));
		assert.strictEqual(calls.length, 1, 'no overlapping load');

		await succeed(0);
		assert.strictEqual(calls.length, 2, 'the snapshot may predate the reconnect, so it reloads');
		await succeed(1);
		assert.strictEqual(calls.length, 2, 'once');
	});

	test('a reconnect flags running terminals as possibly missing output', () => {
		const running = add_running_terminal();
		const exited = app.terminals.add({ status: 'exited', terminal_id: create_uuid() });

		app.handle_socket_connect(connect_time());
		assert.ok(!running.output_gap, 'nothing was missed on the first connect');

		app.handle_socket_connect(connect_time());
		assert.ok(running.output_gap);
		assert.ok(!exited.output_gap);

		running.reset();
		assert.ok(!running.output_gap, 'a fresh process has no gap');
	});

	test("every connect re-announces the terminals' output, the first included", () => {
		const receive_socket_connect = vi.spyOn(app.terminals, 'receive_socket_connect');
		app.handle_socket_connect(null);
		assert.strictEqual(receive_socket_connect.mock.calls.length, 0, 'not connected yet');
		const first = connect_time();
		app.handle_socket_connect(first);
		assert.strictEqual(receive_socket_connect.mock.calls.length, 1, 'a new connection');
		app.handle_socket_connect(first);
		assert.strictEqual(receive_socket_connect.mock.calls.length, 1, 'the same connect seen again');
		app.handle_socket_connect(connect_time());
		assert.strictEqual(receive_socket_connect.mock.calls.length, 2, 'a reconnect');
	});

	test('does nothing once disposed', () => {
		app.handle_socket_connect(connect_time());
		app.dispose();
		assert.ok(!app.handle_socket_connect(connect_time()));
		assert.strictEqual(calls.length, 1);
	});
});

describe('file reconcile', () => {
	test('prunes files under the snapshot roots that it lacks', async () => {
		await load({ files: encode_snapshot_files([create_disknode(ZZZ_A), create_disknode(ZZZ_B)]) });
		assert.ok(app.diskfiles.get_by_path(ZZZ_B));

		await load({ files: encode_snapshot_files([create_disknode(ZZZ_A, 2)]) });
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A)?.mtime, 2);
		assert.ok(!app.diskfiles.get_by_path(ZZZ_B), 'deleted while disconnected');
	});

	test('never prunes files outside the snapshot roots', async () => {
		app.diskfiles.add_initial([create_disknode(OTHER_A)]);
		await load({ files: encode_snapshot_files([create_disknode(ZZZ_A)]) });
		assert.ok(app.diskfiles.get_by_path(OTHER_A));

		// no roots at all prunes nothing
		await load({ files: [], file_roots: [] });
		assert.ok(app.diskfiles.get_by_path(ZZZ_A));
	});

	test('keeps a pruned file open with unsaved edits, flagged deleted on disk', async () => {
		await load({ files: encode_snapshot_files([create_disknode(ZZZ_A)]) });
		await load_content(ZZZ_A);
		const a = app.diskfiles.get_by_path(ZZZ_A);
		assert.ok(a);
		app.diskfiles.select(a.path, true);
		const editor_state = app.diskfiles.get_editor_state(a);
		editor_state.current_content = 'a edited';

		await load({ files: [] });
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A), a);
		assert.isTrue(a.deleted_on_disk);
		assert.ok(app.diskfiles.editor.tabs.by_path.get(a.path));

		// and reattaches it when a later snapshot has the file again
		await load({ files: encode_snapshot_files([create_disknode(ZZZ_A)]) });
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A), a);
		assert.isFalse(a.deleted_on_disk);
	});

	test('a `filer_change` during the request is neither pruned nor reverted', async () => {
		await load({ files: encode_snapshot_files([create_disknode(ZZZ_A)]) });

		const loaded = app.load_session();
		filer_change('add', ZZZ_B, 3);
		filer_change('change', ZZZ_A, 3);
		await succeed(1, { files: encode_snapshot_files([create_disknode(ZZZ_A, 2)]) });
		assert.ok(await loaded);

		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_B)?.mtime, 3, 'created after the snapshot');
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A)?.mtime, 3);
	});

	test('a reconnect reads the files held eagerly again, the shown first, and drops the rest', async () => {
		const ZZZ_C = parse_or_throw(DiskfilePath, '/zzz/c.txt');
		const files = [create_disknode(ZZZ_A), create_disknode(ZZZ_B), create_disknode(ZZZ_C)];
		await load({ files: encode_snapshot_files(files) });
		for (const path of [ZZZ_A, ZZZ_B, ZZZ_C]) await load_content(path);
		const a = app.diskfiles.get_by_path(ZZZ_A)!;
		const b = app.diskfiles.get_by_path(ZZZ_B)!;
		const c = app.diskfiles.get_by_path(ZZZ_C)!;
		// a has an editing state, b is shown in the selected tab, c is held by nothing
		const a_state = app.diskfiles.get_editor_state(a);
		app.diskfiles.select(b.path, true);
		app.diskfiles.get_editor_state(b);
		reads.length = 0;
		// missed while disconnected: b changed on disk, and a was rewritten with the same text
		disk.set(ZZZ_B, 'b changed');

		await load({ files: encode_snapshot_files(files) });
		assert.strictEqual(c.content_status, 'unrequested', 'dropped, to be read when next needed');
		assert.strictEqual(a.content, 'contents', 'kept while it reads again');
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.deepEqual(reads, [ZZZ_B, ZZZ_A], 'the shown file first, and only the files held');
		assert.strictEqual(b.content, 'b changed');
		assert.strictEqual(app.diskfiles.get_editor_state(b).current_content, 'b changed');
		assert.strictEqual(a.content, 'contents');
		assert.isFalse(a_state.disk_conflict, 'the same text is no change');
		assert.strictEqual(a_state.history.entries.length, 1, 'nothing recorded for it');
	});
});

describe('project reconcile', () => {
	test('replaces the open projects with the snapshot', async () => {
		await load({
			projects: [create_project_info(WS_DIR)],
			files: encode_snapshot_files([create_disknode(WS_A)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(app.projects.get_by_root(WS_DIR));
		assert.ok(app.diskfiles.get_by_path(WS_A));

		// another tab closed it and opened another, while this one was disconnected
		await load({ projects: [create_project_info(OTHER_DIR, 3)], projects_rev: 3 });
		assert.ok(!app.projects.get_by_root(WS_DIR), 'closed on the backend');
		assert.ok(app.projects.get_by_root(OTHER_DIR));
		assert.strictEqual(app.projects.items.size, 1);
		assert.ok(!app.diskfiles.get_by_path(WS_A), "a removed project's files go with it");
	});

	test("a removed project's files another root covers follow that root", async () => {
		const nested_dir = parse_or_throw(DiskfileDirectoryPath, '/zzz/nested/');
		const nested_a = parse_or_throw(DiskfilePath, '/zzz/nested/a.txt');
		const nested_b = parse_or_throw(DiskfilePath, '/zzz/nested/b.txt');
		await load({
			projects: [create_project_info(nested_dir)],
			files: encode_snapshot_files([create_disknode(nested_a), create_disknode(nested_b)]),
			file_roots: [ZZZ_DIR, nested_dir]
		});

		await load({ files: encode_snapshot_files([create_disknode(nested_a)]) });
		assert.ok(app.diskfiles.get_by_path(nested_a), 'still under the zzz dir root');
		assert.ok(!app.diskfiles.get_by_path(nested_b));
	});

	test('a close or open applied during the request is newer than the snapshot, which loses', async () => {
		await load({ projects: [create_project_info(WS_DIR)] });

		const loaded = app.load_session();
		// closed, and another opened with its files, while the request was in
		// flight — after the daemon read the snapshot (`projects_rev` 2)
		app.receive_project_closed(WS_DIR, 3);
		app.projects.receive_remote_change(create_project_info(OTHER_DIR, 4));
		app.diskfiles.add_initial([create_disknode(OTHER_A)]);
		await succeed(1, {
			projects: [create_project_info(WS_DIR)],
			projects_rev: 2,
			file_roots: [ZZZ_DIR, WS_DIR, OTHER_DIR]
		});
		assert.ok(await loaded);

		assert.ok(!app.projects.get_by_root(WS_DIR), 'the close stands');
		assert.ok(app.projects.get_by_root(OTHER_DIR), 'the open stands');
		assert.ok(app.diskfiles.get_by_path(OTHER_A), "the opened project's files aren't pruned");

		// the open is new here, so its files come by another snapshot, which is
		// newer than both
		assert.strictEqual(calls.length, 3);
		await succeed(2, {
			projects: [create_project_info(OTHER_DIR, 4)],
			projects_rev: 4,
			files: encode_snapshot_files([create_disknode(OTHER_A)]),
			file_roots: [ZZZ_DIR, OTHER_DIR]
		});
		assert.ok(app.projects.get_by_root(OTHER_DIR));
		assert.ok(app.diskfiles.get_by_path(OTHER_A));

		// a later snapshot without it closes it
		await load({ projects: [], projects_rev: 5 });
		assert.strictEqual(app.projects.items.size, 0);
	});

	test('a held project newer than the snapshot is neither removed nor pruned', async () => {
		await load({
			projects: [create_project_info(WS_DIR)],
			files: encode_snapshot_files([create_disknode(WS_A)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		// a reopen applied after the daemon read the next snapshot, which saw it closed
		const loaded = app.load_session();
		app.projects.receive_remote_change(create_project_info(WS_DIR, 4));
		await succeed(1, { projects: [], projects_rev: 3 });
		assert.ok(await loaded);
		assert.ok(app.projects.get_by_root(WS_DIR), 'held at a newer rev');
		assert.ok(app.diskfiles.get_by_path(WS_A), 'its files left to the newer state');
		// one no newer is removed
		await load({ projects: [], projects_rev: 5 });
		assert.ok(!app.projects.get_by_root(WS_DIR));
	});

	test("a close releases the project's files, and no later snapshot brings them back", async () => {
		await load({
			projects: [create_project_info(WS_DIR, 1)],
			files: encode_snapshot_files([create_disknode(WS_A)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(app.diskfiles.get_by_path(WS_A));
		notify('close', create_project_info(WS_DIR, 2));
		assert.ok(!app.projects.get_by_root(WS_DIR));
		assert.ok(!app.diskfiles.get_by_path(WS_A), 'released with its project');
		await load({ projects_rev: 2 });
		assert.ok(!app.diskfiles.get_by_path(WS_A));
	});

	test('a snapshot listing a root closed here since it was read adds none of its files', async () => {
		await load({ projects: [], file_roots: [ZZZ_DIR] });
		const loaded = app.load_session();
		const before = calls.length;
		// opened at 2 and closed at 3, both landing before the snapshot read at 2
		notify('open', create_project_info(WS_DIR, 2));
		notify('close', create_project_info(WS_DIR, 3));
		await succeed(before - 1, {
			projects: [create_project_info(WS_DIR, 2)],
			projects_rev: 2,
			files: encode_snapshot_files([create_disknode(WS_A), create_disknode(ZZZ_A)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(await loaded);
		await flush();
		assert.ok(!app.projects.get_by_root(WS_DIR), 'the close stands');
		assert.ok(!app.diskfiles.get_by_path(WS_A), "the closed root's files aren't added");
		assert.ok(app.diskfiles.get_by_path(ZZZ_A), 'the rest of the snapshot is');
	});

	test("a closed root's files another root covers are still added by the snapshot", async () => {
		await load({ scoped_dirs: [WS_DIR], projects: [], file_roots: [ZZZ_DIR, WS_DIR] });
		const loaded = app.load_session();
		const before = calls.length;
		notify('open', create_project_info(WS_DIR, 2));
		notify('close', create_project_info(WS_DIR, 3));
		await succeed(before - 1, {
			scoped_dirs: [WS_DIR],
			projects: [create_project_info(WS_DIR, 2)],
			projects_rev: 2,
			files: encode_snapshot_files([create_disknode(WS_A)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(await loaded);
		assert.ok(!app.projects.get_by_root(WS_DIR));
		assert.ok(app.diskfiles.get_by_path(WS_A), 'the scoped dir indexes it');
	});

	test('a root the snapshot saw closed stays closed to older state', async () => {
		await load({ projects: [create_project_info(WS_DIR)] });
		await load({ projects: [], projects_rev: 3 });
		assert.ok(!app.projects.get_by_root(WS_DIR));
		// a reply or notification read before the snapshot, landing after it
		app.projects.receive_remote_change(create_project_info(WS_DIR, 2));
		assert.ok(!app.projects.get_by_root(WS_DIR), 'at or below the floor');
		app.projects.receive_remote_change(create_project_info(WS_DIR, 4));
		assert.ok(app.projects.get_by_root(WS_DIR), 'opened again after the snapshot');
	});
});

describe('projects after a restart', () => {
	const WS_B = parse_or_throw(DiskfilePath, '/ws/b.txt');

	/** Opens `WS_DIR` with `WS_A` and `WS_B`, `WS_B` in a tab with unsaved edits. */
	const setup = async (): Promise<void> => {
		await load({
			projects: [create_project_info(WS_DIR)],
			files: encode_snapshot_files([create_disknode(WS_A), create_disknode(WS_B)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		await load_content(WS_B);
		const b = app.diskfiles.get_by_path(WS_B)!;
		app.diskfiles.select(b.path, true);
		app.diskfiles.get_editor_state(b).current_content = 'b edited';
	};

	/** The backend restarted without the open project. */
	const load_restarted = async (data: Partial<SessionLoadData> = {}): Promise<void> => {
		server_instance_id = create_uuid();
		await load(data);
	};

	test('reopens the projects it lost, keeping their files and tabs', async () => {
		await setup();
		const project = app.projects.get_by_root(WS_DIR);
		await load_restarted();

		assert.strictEqual(app.projects.get_by_root(WS_DIR), project, 'kept while reopening');
		assert.ok(app.diskfiles.get_by_path(WS_A), 'files kept while reopening');
		assert.deepEqual(
			open_calls.map((c) => [c.path, c.focus]),
			[[WS_DIR, []]],
			'its root, the one focus of a plain directory'
		);

		// reopened: WS_B was deleted while zzzd was down
		open_calls[0]!.resolve({
			ok: true,
			value: {
				project: create_project_info(WS_DIR, 2),
				focus: WS_DIR,
				files: encode_snapshot_files([create_disknode(WS_A)]),
				watch_status: 'full',
				refused: [],
				opened: true
			}
		});
		await flush();
		assert.strictEqual(app.projects.get_by_root(WS_DIR), project);
		assert.ok(app.diskfiles.get_by_path(WS_A));
		const b = app.diskfiles.get_by_path(WS_B);
		assert.ok(b?.deleted_on_disk, 'the dirty tab survives, flagged deleted');
		assert.ok(app.diskfiles.editor.tabs.by_path.get(b.path));

		// a later snapshot listing it is plain replace again, with no more reopens
		await load({
			projects: [create_project_info(WS_DIR, 2)],
			projects_rev: 2,
			files: encode_snapshot_files([create_disknode(WS_A)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.strictEqual(open_calls.length, 1);
	});

	test('a reopen refused because the directory is gone drops it and its files', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await setup();
		await load_restarted({ files: encode_snapshot_files([create_disknode(ZZZ_A)]) });

		open_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.not_found, message: 'failed to open project: gone' }
		});
		await flush();
		assert.ok(!app.projects.get_by_root(WS_DIR));
		assert.ok(!app.diskfiles.get_by_path(WS_A));
		assert.ok(app.diskfiles.get_by_path(WS_B)?.uncovered, 'unsaved edits still kept');
		assert.ok(app.diskfiles.get_by_path(ZZZ_A), 'other roots untouched');
		assert.ok(vi.mocked(console.error).mock.calls.length > 0, 'the failure is logged');

		await load({ files: encode_snapshot_files([create_disknode(ZZZ_A)]) });
		assert.strictEqual(open_calls.length, 1, 'not retried');
	});

	test('any other reopen failure keeps it for the next snapshot to retry once', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await setup();
		await load_restarted();
		open_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.service_unavailable, message: 'socket closed' }
		});
		await flush();
		assert.ok(app.projects.get_by_root(WS_DIR), 'kept');
		assert.ok(app.diskfiles.get_by_path(WS_A));
		assert.strictEqual(open_calls.length, 1, 'no retry loop');

		// the next snapshot (same instance) retries instead of closing it
		await load();
		assert.ok(app.projects.get_by_root(WS_DIR));
		assert.strictEqual(open_calls.length, 2);
	});

	test('a refused reopen spares files under a nested file root', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const nested_dir = parse_or_throw(DiskfileDirectoryPath, '/ws/nested/');
		const nested_a = parse_or_throw(DiskfilePath, '/ws/nested/a.txt');
		await setup();
		// the restarted daemon still watches a scoped dir inside the project
		await load_restarted({
			scoped_dirs: [nested_dir],
			files: encode_snapshot_files([create_disknode(nested_a)]),
			file_roots: [ZZZ_DIR, nested_dir]
		});
		open_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.forbidden, message: 'failed to open project' }
		});
		await flush();
		assert.ok(!app.projects.get_by_root(WS_DIR));
		assert.ok(!app.diskfiles.get_by_path(WS_A), 'only the project covered it');
		assert.ok(app.diskfiles.get_by_path(nested_a), 'another root still covers it');
	});

	/** Stubs `project_close` with calls the test resolves. */
	const stub_close = (): Array<{ root: string; resolve: (result: unknown) => void }> => {
		const close_calls: Array<{ root: string; resolve: (result: unknown) => void }> = [];
		(app.api as unknown as Record<string, unknown>).project_close = ({
			root
		}: {
			root: string;
		}) => new Promise((resolve) => close_calls.push({ root, resolve }));
		return close_calls;
	};

	const NOT_OPEN = {
		ok: false,
		error: {
			code: JSONRPC_ERROR_CODES.invalid_params,
			message: `project not open: ${WS_DIR}`,
			data: { reason: ERROR_PROJECT_NOT_OPEN }
		}
	};

	const REOPENED: ProjectOpenResult = {
		ok: true,
		value: {
			project: create_project_info(WS_DIR, 2),
			focus: WS_DIR,
			files: encode_snapshot_files([create_disknode(WS_A)]),
			watch_status: 'full',
			refused: [],
			opened: true
		}
	};

	test('closing a project pending a reopen retry cancels the retry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await setup();
		await load_restarted();
		open_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.service_unavailable, message: 'socket closed' }
		});
		await flush();
		assert.ok(app.projects.get_by_root(WS_DIR), 'kept for a retry');

		const close_calls = stub_close();
		const closed = app.close_project(WS_DIR);
		// a snapshot while the close is in flight, with the project still here
		await load();
		assert.strictEqual(open_calls.length, 1, 'the close cancelled the retry');

		// the backend never reopened it
		close_calls[0]!.resolve(NOT_OPEN);
		assert.ok((await closed).ok);
		assert.ok(!app.projects.get_by_root(WS_DIR), 'removed here');
		await load();
		assert.strictEqual(open_calls.length, 1);
	});

	test('a close during an in-flight reopen sticks', async () => {
		await setup();
		await load_restarted();
		const close_calls = stub_close();

		// the backend's open is still scanning, so the close finds nothing open
		const closed = app.close_project(WS_DIR);
		close_calls[0]!.resolve(NOT_OPEN);
		assert.ok((await closed).ok);
		assert.ok(!app.projects.get_by_root(WS_DIR));

		// then the open registers anyway
		open_calls[0]!.resolve(REOPENED);
		await flush();
		assert.deepEqual(
			close_calls.map((c) => c.root),
			[WS_DIR, WS_DIR],
			'closed again'
		);
		close_calls[1]!.resolve({ ok: true, value: { rev: 3 } });
		await flush();
		assert.ok(!app.projects.get_by_root(WS_DIR), 'absent');
	});

	test('a snapshot listing the project mid-reopen closes nothing', async () => {
		await setup();
		await load_restarted();
		const close_calls = stub_close();
		// another client reopened it first
		await load({
			projects: [create_project_info(WS_DIR, 2)],
			projects_rev: 2,
			files: encode_snapshot_files([create_disknode(WS_A)]),
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		open_calls[0]!.resolve({
			...REOPENED,
			value: { ...REOPENED.value, project: create_project_info(WS_DIR, 2), opened: false }
		});
		await flush();
		assert.strictEqual(close_calls.length, 0);
		assert.ok(app.projects.get_by_root(WS_DIR));
	});

	test('any other close failure is returned and keeps the project', async () => {
		await load({ projects: [create_project_info(WS_DIR)] });
		(app.api as unknown as Record<string, unknown>).project_close = () =>
			Promise.resolve({
				ok: false,
				error: { code: JSONRPC_ERROR_CODES.internal_error, message: 'boom' }
			});
		const result = await app.close_project(WS_DIR);
		assert.ok(!result.ok);
		assert.strictEqual(result.error.message, 'boom');
		assert.ok(app.projects.get_by_root(WS_DIR));
	});

	test('a close older than the reopened state, landing mid-reopen, cancels nothing', async () => {
		await setup();
		await load_restarted();
		const close_calls = stub_close();
		// this reopen's own notification (rev 4), then a stale close (rev 3)
		notify('open', create_project_info(WS_DIR, 4));
		app.receive_project_closed(WS_DIR, 3);
		assert.ok(app.projects.get_by_root(WS_DIR), 'the close is older than the state held');
		open_calls[0]!.resolve({
			...REOPENED,
			value: { ...REOPENED.value, project: create_project_info(WS_DIR, 4) }
		});
		await flush();
		assert.strictEqual(close_calls.length, 0, 'not closed again');
		assert.ok(app.projects.get_by_root(WS_DIR));
	});

	test("another client's reopen, ahead of this one's older reply, still prunes what changed", async () => {
		await setup();
		await load_restarted();
		const before = calls.length;
		// another client reopened it and changed it (rev 3) — the state held
		// was the lost instance's, so its files say nothing of the new one's
		notify('open', create_project_info(WS_DIR, 3));
		// this client's own open, older, lands after: its files are dropped
		open_calls[0]!.resolve({
			...REOPENED,
			value: { ...REOPENED.value, project: create_project_info(WS_DIR, 2), files: [] }
		});
		await flush();
		assert.strictEqual(calls.length, before + 1, 'resynced for the files');
		// `WS_A` was deleted while zzzd was down
		await succeed(before, {
			projects: [create_project_info(WS_DIR, 3)],
			projects_rev: 3,
			files: [],
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(!app.diskfiles.get_by_path(WS_A), 'pruned');
		assert.isTrue(app.diskfiles.get_by_path(WS_B)?.deleted_on_disk, 'the draft kept, flagged');
	});

	test('a snapshot during the reopen leaves the project alone', async () => {
		await setup();
		await load_restarted();
		await load();
		assert.ok(app.projects.get_by_root(WS_DIR));
		assert.ok(app.diskfiles.get_by_path(WS_A));
		assert.strictEqual(open_calls.length, 1);
	});
});

describe('a registry project after a restart', () => {
	const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
	const APP = parse_or_throw(DiskfileDirectoryPath, '/dev/app/');
	const SITE = parse_or_throw(DiskfileDirectoryPath, '/dev/site/');
	const APP_A = parse_or_throw(DiskfilePath, '/dev/app/a.txt');
	const APP_B = parse_or_throw(DiskfilePath, '/dev/app/b.txt');
	const SITE_A = parse_or_throw(DiskfilePath, '/dev/site/a.txt');
	const registry_info = (focused: Array<DiskfileDirectoryPath>, rev = 1): ProjectInfoJson => ({
		...create_project_info(DEV, rev),
		kind: 'registry',
		registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
		fallback: null,
		entries: [
			{ key: 'app', kind: 'repo', dir: APP, state: 'present' },
			{ key: 'site', kind: 'repo', dir: SITE, state: 'present' }
		],
		focused
	});
	const node = (path: DiskfilePath): SerializableDisknode => ({
		...create_disknode(path),
		source_dir: path.startsWith(APP) ? APP : SITE
	});

	/** Open `DEV` with both repos focused, then restart the backend without it. */
	const setup_restarted = async (): Promise<void> => {
		await load({
			projects: [registry_info([APP, SITE])],
			files: encode_snapshot_files([node(APP_A), node(SITE_A)]),
			file_roots: [ZZZ_DIR, DEV, APP, SITE]
		});
		server_instance_id = create_uuid();
		await load();
	};

	/** The `project_open` calls so far, each its path and requested focus. */
	const opens = () => open_calls.map((c) => [c.path, c.focus]);

	/**
	 * A reopen's reply: the project focusing `focused`, `refused` the rest, at
	 * `rev` — after the restart's snapshot (`projects_rev` 1) by default.
	 */
	const reply = (
		focused: Array<DiskfileDirectoryPath>,
		refused: Array<ProjectFocusRefusal> = [],
		rev = 2
	): ProjectOpenResult => ({
		ok: true,
		value: {
			project: registry_info(focused, rev),
			focus: null,
			files: encode_snapshot_files(focused.includes(APP) ? [node(APP_A)] : []),
			watch_status: 'full',
			refused,
			opened: true
		}
	});
	const transient = {
		ok: false as const,
		error: { code: JSONRPC_ERROR_CODES.service_unavailable, message: 'socket closed' }
	};

	test('reopens it in one open of its root, requesting the whole focus', async () => {
		await setup_restarted();
		assert.deepEqual(opens(), [[DEV, [APP, SITE]]]);
		// `site`'s file was deleted while zzzd was down
		open_calls[0]!.resolve(reply([APP, SITE]));
		await flush();
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
		assert.ok(app.diskfiles.get_by_path(APP_A));
		assert.ok(!app.diskfiles.get_by_path(SITE_A), 'gone from its reopened repo');
		await load({
			projects: [registry_info([APP, SITE], 2)],
			projects_rev: 2,
			file_roots: [ZZZ_DIR, DEV, APP, SITE]
		});
		assert.strictEqual(open_calls.length, 1, 'reopened, so no retry');
	});

	test('a repo focused from the tree reopens with the rest of the focus', async () => {
		await load({
			projects: [registry_info([APP])],
			files: encode_snapshot_files([node(APP_A)]),
			file_roots: [ZZZ_DIR, DEV, APP]
		});
		const focused = app.projects.focus_repo(DEV, SITE);
		focus_calls[0]!({
			ok: true,
			value: {
				project: registry_info([APP, SITE], 2),
				files: encode_snapshot_files([node(APP_A), node(SITE_A)]),
				watch_status: 'full'
			}
		});
		assert.ok((await focused).ok);
		server_instance_id = create_uuid();
		await load();
		assert.deepEqual(opens(), [[DEV, [APP, SITE]]]);
		open_calls[0]!.resolve(reply([APP, SITE]));
		await flush();
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
		assert.strictEqual(focus_calls.length, 1, 'no `repo_focus` on a reopen');
	});

	test('a refused focus is dropped and the rest of the project reopens', async () => {
		await setup_restarted();
		// unlistable now: the entry stays present, so only `refused` says so
		open_calls[0]!.resolve(reply([APP], [{ dir: SITE, reason: 'permission_denied' }]));
		await flush();
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP]);
		await load({
			projects: [registry_info([APP], 2)],
			projects_rev: 2,
			file_roots: [ZZZ_DIR, DEV, APP]
		});
		assert.strictEqual(open_calls.length, 1, 'nothing left to retry');
	});

	test('a focus that failed to index is kept and retried alone', async () => {
		await setup_restarted();
		open_calls[0]!.resolve(reply([APP], [{ dir: SITE, reason: ERROR_REPO_INDEX_FAILED }]));
		await flush();
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP], "the daemon's focus");

		// listed, with `app` reopened and `site` not: `site` is retried
		await load({
			projects: [registry_info([APP], 2)],
			projects_rev: 2,
			file_roots: [ZZZ_DIR, DEV, APP]
		});
		assert.deepEqual(opens(), [
			[DEV, [APP, SITE]],
			[DEV, [SITE]]
		]);
		open_calls[1]!.resolve(reply([APP, SITE], [], 3));
		await flush();
		await load({
			projects: [registry_info([APP, SITE], 3)],
			projects_rev: 3,
			file_roots: [ZZZ_DIR, DEV, APP, SITE]
		});
		assert.strictEqual(open_calls.length, 2, 'reopened, so no more retries');
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
	});

	test('an open that fails transiently keeps the project and retries its whole focus', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await setup_restarted();
		open_calls[0]!.resolve(transient);
		await flush();
		assert.ok(app.projects.get_by_root(DEV), 'kept for the retry');
		assert.ok(app.diskfiles.get_by_path(APP_A), 'its files kept');
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);

		// the next snapshot (same instance, the project still lost) retries it
		await load();
		assert.deepEqual(opens(), [
			[DEV, [APP, SITE]],
			[DEV, [APP, SITE]]
		]);
	});

	test('after a restart, a project another client reopened first gets the rest of the focus', async () => {
		const OTHER = parse_or_throw(DiskfileDirectoryPath, '/dev/other/');
		await setup_restarted();
		open_calls[0]!.resolve(reply([APP], [{ dir: SITE, reason: ERROR_REPO_INDEX_FAILED }]));
		await flush();
		// zzzd restarts again, and another client reopens the project on `other` alone
		server_instance_id = create_uuid();
		await load({
			projects: [{ ...registry_info([OTHER]), entries: [...registry_info([]).entries] }],
			file_roots: [ZZZ_DIR, DEV, OTHER]
		});
		assert.deepEqual(
			opens(),
			[
				[DEV, [APP, SITE]],
				[DEV, [APP, SITE]]
			],
			'`app` too, not only the pending `site`'
		);
	});

	test('a restart during a reopen queues its whole focus again once it settles', async () => {
		await setup_restarted();
		// zzzd restarts again while the project is reopening: the snapshot skips it
		server_instance_id = create_uuid();
		await load();
		assert.strictEqual(open_calls.length, 1);
		// it lands — on the instance that's gone
		open_calls[0]!.resolve(reply([APP, SITE]));
		await flush();
		// a resync was asked for, and it reopens the whole focus
		assert.strictEqual(calls.length, 4, 'a session load follows the reopen');
		await succeed(3);
		assert.deepEqual(opens(), [
			[DEV, [APP, SITE]],
			[DEV, [APP, SITE]]
		]);
	});

	test('an update applied while a snapshot is in flight is newer, and the snapshot leaves it', async () => {
		await load({ projects: [registry_info([APP])], file_roots: [ZZZ_DIR, DEV, APP] });
		const loaded = app.load_session();
		(
			app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }
		).receive({ data: { input: { type: 'update', project: registry_info([APP, SITE], 3) } } });
		const before = calls.length;
		// read before the update
		await succeed(before - 1, { projects: [registry_info([APP])], projects_rev: 2 });
		assert.ok(await loaded);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
		assert.strictEqual(calls.length, before, 'no other snapshot needed');
	});

	test("a restart's snapshot is followed by another when state was applied while it was in flight", async () => {
		await load({ projects: [registry_info([APP])], file_roots: [ZZZ_DIR, DEV, APP] });
		server_instance_id = create_uuid();
		const loaded = app.load_session();
		// the new instance's notification, ahead of a snapshot read before it —
		// which the reset lets win, so another is loaded
		(
			app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }
		).receive({ data: { input: { type: 'open', project: registry_info([APP, SITE], 9) } } });
		const before = calls.length;
		await succeed(before - 1, { projects: [registry_info([APP], 8)], projects_rev: 8 });
		assert.ok(await loaded);
		assert.strictEqual(calls.length, before + 1, 'another snapshot follows');
		await succeed(before, {
			projects: [registry_info([APP, SITE], 9)],
			projects_rev: 9,
			file_roots: [ZZZ_DIR, DEV, APP, SITE]
		});
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
		assert.strictEqual(open_calls.length, 0, 'listed, so nothing to reopen');
	});

	test('a restart whose clock stepped back loads another snapshot for state it dropped', async () => {
		await load({
			projects: [create_project_info(WS_DIR, 50)],
			projects_rev: 50,
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		server_instance_id = create_uuid();
		const loaded = app.load_session();
		const before = calls.length;
		// the new instance (lower revs) opens `other` after reading the
		// snapshot; its notification, below the old instance's revs, is dropped
		notify('open', create_project_info(OTHER_DIR, 6));
		await succeed(before - 1, {
			projects: [create_project_info(WS_DIR, 5)],
			projects_rev: 5,
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(await loaded);
		assert.strictEqual(calls.length, before + 1, 'another snapshot follows');
		await succeed(before, {
			projects: [create_project_info(WS_DIR, 5), create_project_info(OTHER_DIR, 6)],
			projects_rev: 6,
			file_roots: [ZZZ_DIR, WS_DIR, OTHER_DIR]
		});
		assert.ok(app.projects.get_by_root(OTHER_DIR));
		assert.strictEqual(calls.length, before + 1, 'the follow-up loads no other');
	});

	test("a snapshot older than a narrower state held adds none of the dropped repo's files", async () => {
		await load({
			projects: [registry_info([APP, SITE])],
			files: encode_snapshot_files([node(APP_A), node(SITE_A)]),
			file_roots: [ZZZ_DIR, DEV, APP, SITE]
		});
		const loaded = app.load_session();
		const before = calls.length;
		// the snapshot is read at 2, with both focused; another client then
		// unfocuses `site` (3), which releases its files here
		notify('update', registry_info([APP], 3));
		assert.ok(!app.diskfiles.get_by_path(SITE_A));
		await succeed(before - 1, {
			projects: [registry_info([APP, SITE], 2)],
			projects_rev: 2,
			// `b.txt` is new here — the snapshot is first to carry it
			files: encode_snapshot_files([node(APP_A), node(APP_B), node(SITE_A)]),
			file_roots: [ZZZ_DIR, DEV, APP, SITE]
		});
		assert.ok(await loaded);
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP], 'the newer state stands');
		assert.ok(app.diskfiles.get_by_path(APP_B), 'what it indexes is added');
		assert.ok(!app.diskfiles.get_by_path(SITE_A), 'the unfocused repo stays released');
	});

	test("a restart's snapshot is followed by another for a close the old revs dropped", async () => {
		await load({
			projects: [create_project_info(WS_DIR, 50)],
			projects_rev: 50,
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		server_instance_id = create_uuid();
		const loaded = app.load_session();
		const before = calls.length;
		// the new instance (lower revs) has `ws` open, read into the snapshot,
		// then closes it — below the old instance's revs, the close is dropped
		notify('close', create_project_info(WS_DIR, 6));
		assert.ok(app.projects.get_by_root(WS_DIR), 'dropped by the old rev');
		await succeed(before - 1, {
			projects: [create_project_info(WS_DIR, 5)],
			projects_rev: 5,
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(await loaded);
		assert.strictEqual(calls.length, before + 1, 'another snapshot follows');
		await succeed(before, { projects: [], projects_rev: 6 });
		assert.ok(!app.projects.get_by_root(WS_DIR), 'closed');
		assert.strictEqual(calls.length, before + 1, 'the follow-up loads no other');
	});

	test("a restart's snapshot is followed by another for a close received while it was in flight", async () => {
		await load({ projects: [], file_roots: [ZZZ_DIR] });
		server_instance_id = create_uuid();
		const loaded = app.load_session();
		const before = calls.length;
		// `other`, opened on the new instance before this socket connected and
		// read into the snapshot, is then closed — its close lands ahead of it
		notify('close', create_project_info(OTHER_DIR, 7));
		await succeed(before - 1, {
			projects: [create_project_info(OTHER_DIR, 6)],
			projects_rev: 6,
			file_roots: [ZZZ_DIR, OTHER_DIR]
		});
		assert.ok(await loaded);
		assert.strictEqual(calls.length, before + 1, 'another snapshot follows');
		await succeed(before, { projects: [], projects_rev: 7 });
		assert.ok(!app.projects.get_by_root(OTHER_DIR), 'closed');
		assert.strictEqual(calls.length, before + 1, 'the follow-up loads no other');
	});

	test('a reopen landing on an instance gone since keeps no rev of it', async () => {
		await setup_restarted();
		// zzzd restarts again while the project is reopening
		server_instance_id = create_uuid();
		await load();
		// it lands — on the instance that's gone, whose clock ran ahead
		open_calls[0]!.resolve(reply([APP, SITE], [], 100));
		await flush();
		assert.strictEqual(app.projects.get_by_root(DEV)?.rev, -1);
		// so the new instance's state applies
		notify('update', registry_info([APP], 5));
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP]);
	});

	test('a restart resets every rev held, so a lower-seeded instance still applies', async () => {
		await load({ projects: [registry_info([APP], 50)], projects_rev: 50 });
		// the clock stepped back: the new instance stamps lower revs
		server_instance_id = create_uuid();
		await load({ projects: [registry_info([APP, SITE], 5)], projects_rev: 5 });
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
		assert.strictEqual(app.projects.get_by_root(DEV)?.rev, 5);
		// and a close at the new instance's rev applies
		app.receive_project_closed(DEV, 6);
		assert.ok(!app.projects.get_by_root(DEV));
	});

	test('another restart before a retry reopens the whole focus, not just the retry', async () => {
		await setup_restarted();
		open_calls[0]!.resolve(reply([APP], [{ dir: SITE, reason: ERROR_REPO_INDEX_FAILED }]));
		await flush();
		// zzzd restarts again before any snapshot retried `site`
		server_instance_id = create_uuid();
		await load();
		assert.deepEqual(
			opens(),
			[
				[DEV, [APP, SITE]],
				[DEV, [APP, SITE]]
			],
			'the lost project reopens from its whole focus'
		);
	});

	test('a close during the reopen closes it again once it lands', async () => {
		await setup_restarted();
		const close_calls: Array<{ root: string; resolve: (result: unknown) => void }> = [];
		(app.api as unknown as Record<string, unknown>).project_close = ({ root }: { root: string }) =>
			new Promise((resolve) => close_calls.push({ root, resolve }));
		const closed = app.close_project(DEV);
		close_calls[0]!.resolve({
			ok: false,
			error: {
				code: JSONRPC_ERROR_CODES.invalid_params,
				message: `project not open: ${DEV}`,
				data: { reason: ERROR_PROJECT_NOT_OPEN }
			}
		});
		assert.ok((await closed).ok);
		open_calls[0]!.resolve(reply([APP, SITE]));
		await flush();
		assert.deepEqual(
			close_calls.map((c) => c.root),
			[DEV, DEV],
			'the open that landed anyway is closed again'
		);
		close_calls[1]!.resolve({ ok: true, value: { rev: 3 } });
		await flush();
		assert.ok(!app.projects.get_by_root(DEV));
	});

	test("another client's close during a reopen closes it again when this open created it after", async () => {
		await setup_restarted();
		const close_calls: Array<{ root: string; resolve: (result: unknown) => void }> = [];
		(app.api as unknown as Record<string, unknown>).project_close = ({ root }: { root: string }) =>
			new Promise((resolve) => close_calls.push({ root, resolve }));
		// the other client's close of the instance's earlier open (rev 2) lands
		// while the project is reopening
		(
			app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }
		).receive({ data: { input: { type: 'close', project: registry_info([], 2) } } });
		assert.ok(!app.projects.get_by_root(DEV), 'removed here');
		open_calls[0]!.resolve(reply([APP, SITE], [], 3));
		await flush();
		assert.deepEqual(
			close_calls.map((c) => c.root),
			[DEV],
			'the open that landed anyway is closed again'
		);
		close_calls[0]!.resolve({ ok: true, value: { rev: 4 } });
		await flush();
		assert.ok(!app.projects.get_by_root(DEV));
		await load({ projects_rev: 4 });
		assert.strictEqual(open_calls.length, 1, 'no retry');
	});

	// the race logged as "a remote close re-closing a fresh open"
	test('a reopen that merged into a fresh open after a close leaves that open alone', async () => {
		await setup_restarted();
		const close_calls: Array<{ root: string; resolve: (result: unknown) => void }> = [];
		(app.api as unknown as Record<string, unknown>).project_close = ({ root }: { root: string }) =>
			new Promise((resolve) => close_calls.push({ root, resolve }));
		const receive = (type: 'open' | 'close', project: ProjectInfoJson): void =>
			(
				app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }
			).receive({ data: { input: { type, project } } });
		// another client closes it, then a third opens it fresh, while this
		// client's reopen is in flight
		receive('close', registry_info([], 2));
		receive('open', registry_info([SITE], 3));
		assert.ok(app.projects.get_by_root(DEV), 'the fresh open is newer than the close');
		// this reopen merged into that open
		const merged = reply([APP, SITE], [], 4);
		assert.ok(merged.ok);
		open_calls[0]!.resolve({ ok: true, value: { ...merged.value, opened: false } });
		await flush();
		assert.deepEqual(close_calls, [], 'not closed again');
		assert.deepEqual(app.projects.get_by_root(DEV)?.focused, [APP, SITE]);
	});

	test('a reopen that created the project, changed by someone since, is left open', async () => {
		await setup_restarted();
		const close_calls: Array<{ root: string; resolve: (result: unknown) => void }> = [];
		(app.api as unknown as Record<string, unknown>).project_close = ({ root }: { root: string }) =>
			new Promise((resolve) => close_calls.push({ root, resolve }));
		const receive = (type: 'open' | 'update' | 'close', project: ProjectInfoJson): void =>
			(
				app.action_handlers.project_changed as unknown as { receive: (event: unknown) => void }
			).receive({ data: { input: { type, project } } });
		receive('close', registry_info([], 2));
		// this reopen created it after the close (rev 3), and another client has
		// opened a path in it since (rev 4), which this client saw first
		receive('open', registry_info([APP, SITE], 3));
		receive('update', registry_info([APP, SITE], 4));
		open_calls[0]!.resolve(reply([APP, SITE], [], 3));
		await flush();
		assert.deepEqual(close_calls, [], 'someone acted on it after the close');
		assert.ok(app.projects.get_by_root(DEV));
	});

	test('a root that is no longer a registry reopens as what it is, its focus refused', async () => {
		await setup_restarted();
		const loads = calls.length;
		// `repos.toml` is gone: the root opens as a plain directory
		open_calls[0]!.resolve({
			ok: true,
			value: {
				project: create_project_info(DEV, 2),
				focus: DEV,
				files: encode_snapshot_files([node(APP_A), node(SITE_A)]),
				watch_status: 'full',
				refused: [
					{ dir: APP, reason: 'project_not_registry' },
					{ dir: SITE, reason: 'project_not_registry' }
				],
				opened: true
			}
		});
		await flush();
		const project = app.projects.get_by_root(DEV);
		assert.ok(project);
		assert.strictEqual(project.kind, 'plain_dir');
		assert.deepEqual(project.focused, [DEV]);
		assert.ok(app.diskfiles.get_by_path(APP_A), 'its root, a tree now, covers the repos');
		assert.strictEqual(calls.length, loads, 'a narrowing state settles here, no resync');
		await load({
			projects: [create_project_info(DEV, 2)],
			projects_rev: 2,
			file_roots: [ZZZ_DIR, DEV]
		});
		assert.strictEqual(open_calls.length, 1, 'nothing left to retry');
	});

	test('a reopen resolving to another project drops the old one, not the new one', async () => {
		const UPPER = parse_or_throw(DiskfileDirectoryPath, '/');
		await setup_restarted();
		open_calls[0]!.resolve({
			ok: true,
			value: {
				project: { ...create_project_info(UPPER, 2), kind: 'git_repo' },
				focus: UPPER,
				files: encode_snapshot_files([node(APP_A)]),
				watch_status: 'full',
				// another project's refusals say nothing of this one's focus
				refused: [{ dir: SITE, reason: ERROR_REPO_INDEX_FAILED }],
				opened: true
			}
		});
		await flush();
		assert.ok(!app.projects.get_by_root(DEV), 'the registry project is dropped');
		assert.ok(app.projects.get_by_root(UPPER));
		assert.ok(app.diskfiles.get_by_path(APP_A), "the new project's files stay");
	});
});

describe('terminal reconcile', () => {
	test('a running terminal the backend lacks is lost', async () => {
		await load();
		const kept = add_running_terminal();
		const gone = add_running_terminal();

		await load({ terminal_ids: [kept.terminal_id!] });
		assert.strictEqual(kept.status, 'running');
		assert.strictEqual(gone.status, 'lost');
		assert.strictEqual(gone.error_message, TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE);
	});

	test('a restarted backend loses every terminal, with a message saying so', async () => {
		await load();
		const terminal = add_running_terminal();
		terminal.mark_output_gap();

		server_instance_id = create_uuid();
		await load();
		assert.strictEqual(app.server_instance_id, server_instance_id);
		assert.strictEqual(terminal.status, 'lost');
		assert.strictEqual(terminal.error_message, TERMINAL_LOST_TO_RESTART_MESSAGE);
		assert.ok(!terminal.output_gap, 'the lost status supersedes the gap notice');
	});

	test('a terminal started during the request is not judged by it', async () => {
		await load();
		const loaded = app.load_session();
		const started = add_running_terminal();
		await succeed(1, { terminal_ids: [] });
		assert.ok(await loaded);
		assert.strictEqual(started.status, 'running');
	});

	test('a real exit after being marked lost wins', async () => {
		await load();
		const terminal = add_running_terminal();
		// the backend drops a terminal just before sending its exit
		await load();
		assert.strictEqual(terminal.status, 'lost');

		app.terminals.receive_exited(terminal.terminal_id!, 3);
		assert.strictEqual(terminal.status, 'exited');
		assert.strictEqual(terminal.exit_code, 3);
		assert.strictEqual(terminal.error_message, null);
	});

	test('only running terminals can be lost', async () => {
		await load();
		const exited = app.terminals.add({
			status: 'exited',
			terminal_id: create_uuid(),
			exit_code: 0
		});
		const closed = app.terminals.add({ status: 'closed', terminal_id: create_uuid() });
		await load();
		assert.strictEqual(exited.status, 'exited');
		assert.strictEqual(closed.status, 'closed');
	});
});
