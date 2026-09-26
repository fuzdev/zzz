// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import {
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
	type DiskfileChangeType
} from '$lib/diskfile_types.ts';
import { Frontend, SESSION_BOOT_FALLBACK_DELAY } from '$lib/frontend.svelte.ts';
import type { SessionLoadData } from '$lib/action_specs.ts';
import type { WorkspaceInfoJson } from '$lib/workspace.svelte.ts';
import { ERROR_WORKSPACE_NOT_OPEN } from '$lib/workspace_helpers.ts';
import type { Terminal } from '$lib/terminal.svelte.ts';
import { DiskfileEditorState } from '$lib/diskfile_editor_state.svelte.ts';
import {
	TERMINAL_LOST_TO_RESTART_MESSAGE,
	TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE
} from '$lib/terminal_helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const ZZZ_DIR = DiskfileDirectoryPath.parse('/zzz/');
const WS_DIR = DiskfileDirectoryPath.parse('/ws/');
const OTHER_DIR = DiskfileDirectoryPath.parse('/other/');

const ZZZ_A = DiskfilePath.parse('/zzz/a.txt');
const ZZZ_B = DiskfilePath.parse('/zzz/b.txt');
const WS_A = DiskfilePath.parse('/ws/a.txt');
const OTHER_A = DiskfilePath.parse('/other/a.txt');

const create_disknode = (path: DiskfilePath, contents = 'contents'): SerializableDisknode => ({
	id: path,
	source_dir: path.startsWith(WS_DIR) ? WS_DIR : ZZZ_DIR,
	contents,
	ctime: 1,
	mtime: 1,
	dependents: [],
	dependencies: []
});

const create_workspace_info = (path: DiskfileDirectoryPath): WorkspaceInfoJson => ({
	path,
	name: path,
	opened_at: new Date(0).toISOString()
});

let server_instance_id: Uuid;

const create_session = (data: Partial<SessionLoadData> = {}): SessionLoadData => ({
	zzz_dir: ZZZ_DIR,
	scoped_dirs: [],
	files: [],
	file_roots: [ZZZ_DIR],
	provider_status: [],
	workspaces: [],
	terminal_ids: [],
	server_instance_id,
	...data
});

type SessionLoadResult =
	| { ok: true; value: { data: SessionLoadData } }
	| { ok: false; error: { code: number; message: string } };

type WorkspaceOpenResult =
	| {
			ok: true;
			value: {
				workspace: WorkspaceInfoJson;
				files: Array<SerializableDisknode>;
				watch_status: 'full';
			};
	  }
	| { ok: false; error: { code: number; message: string } };

let app: Frontend;
/** Pending `session_load` calls, resolved by the test. */
let calls: Array<(result: SessionLoadResult) => void>;
/** Pending `workspace_open` calls, resolved by the test. */
let open_calls: Array<{ path: string; resolve: (result: WorkspaceOpenResult) => void }>;

beforeEach(() => {
	server_instance_id = create_uuid();
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = [];
	open_calls = [];
	(app as unknown as { api: unknown }).api = {
		session_load: () => new Promise<SessionLoadResult>((resolve) => calls.push(resolve)),
		workspace_open: ({ path }: { path: string }) =>
			new Promise<WorkspaceOpenResult>((resolve) => open_calls.push({ path, resolve }))
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

const filer_change = (type: DiskfileChangeType, path: DiskfilePath, contents?: string): void => {
	app.diskfiles.handle_change({
		change: { type, path },
		disknode: create_disknode(path, contents)
	});
};

/** Overrides the socket's reactive `connected` for the test. */
const set_socket_connected = (connected: boolean): void => {
	Object.defineProperty(app.socket, 'connected', { value: connected, configurable: true });
};

const add_running_terminal = (): Terminal =>
	app.terminals.add({ status: 'running', terminal_id: create_uuid() });

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

	test('does nothing once disposed', () => {
		app.handle_socket_connect(connect_time());
		app.dispose();
		assert.ok(!app.handle_socket_connect(connect_time()));
		assert.strictEqual(calls.length, 1);
	});
});

describe('file reconcile', () => {
	test('prunes files under the snapshot roots that it lacks', async () => {
		await load({ files: [create_disknode(ZZZ_A), create_disknode(ZZZ_B)] });
		assert.ok(app.diskfiles.get_by_path(ZZZ_B));

		await load({ files: [create_disknode(ZZZ_A, 'a new')] });
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A)?.content, 'a new');
		assert.ok(!app.diskfiles.get_by_path(ZZZ_B), 'deleted while disconnected');
	});

	test('never prunes files outside the snapshot roots', async () => {
		app.diskfiles.add_initial([create_disknode(OTHER_A)]);
		await load({ files: [create_disknode(ZZZ_A)] });
		assert.ok(app.diskfiles.get_by_path(OTHER_A));

		// no roots at all prunes nothing
		await load({ files: [], file_roots: [] });
		assert.ok(app.diskfiles.get_by_path(ZZZ_A));
	});

	test('keeps a pruned file open with unsaved edits, flagged deleted on disk', async () => {
		await load({ files: [create_disknode(ZZZ_A, 'a')] });
		const a = app.diskfiles.get_by_path(ZZZ_A);
		assert.ok(a);
		app.diskfiles.select(a.id, true);
		const editor_state = new DiskfileEditorState({ app, diskfile: a });
		editor_state.current_content = 'a edited';

		await load({ files: [] });
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A), a);
		assert.isTrue(a.deleted_on_disk);
		assert.ok(app.diskfiles.editor.tabs.by_diskfile_id.get(a.id));

		// and reattaches it when a later snapshot has the file again
		await load({ files: [create_disknode(ZZZ_A, 'a')] });
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A), a);
		assert.isFalse(a.deleted_on_disk);
	});

	test('a file `filer_change` touched during the request is neither pruned nor reverted', async () => {
		await load({ files: [create_disknode(ZZZ_A, 'a')] });

		const loaded = app.load_session();
		filer_change('add', ZZZ_B, 'b');
		filer_change('change', ZZZ_A, 'a newer');
		await succeed(1, { files: [create_disknode(ZZZ_A, 'a older')] });
		assert.ok(await loaded);

		assert.strictEqual(
			app.diskfiles.get_by_path(ZZZ_B)?.content,
			'b',
			'created after the snapshot'
		);
		assert.strictEqual(app.diskfiles.get_by_path(ZZZ_A)?.content, 'a newer');
	});
});

describe('workspace reconcile', () => {
	test('replaces the open workspaces with the snapshot', async () => {
		await load({
			workspaces: [create_workspace_info(WS_DIR)],
			files: [create_disknode(WS_A)],
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.ok(app.workspaces.get_by_path(WS_DIR));
		assert.ok(app.diskfiles.get_by_path(WS_A));

		// another tab closed it and opened another, while this one was disconnected
		await load({ workspaces: [create_workspace_info(OTHER_DIR)] });
		assert.ok(!app.workspaces.get_by_path(WS_DIR), 'closed on the backend');
		assert.ok(app.workspaces.get_by_path(OTHER_DIR));
		assert.strictEqual(app.workspaces.items.size, 1);
		assert.ok(!app.diskfiles.get_by_path(WS_A), "a removed workspace's files go with it");
	});

	test("a removed workspace's files another root covers follow that root", async () => {
		const nested_dir = DiskfileDirectoryPath.parse('/zzz/nested/');
		const nested_a = DiskfilePath.parse('/zzz/nested/a.txt');
		const nested_b = DiskfilePath.parse('/zzz/nested/b.txt');
		await load({
			workspaces: [create_workspace_info(nested_dir)],
			files: [create_disknode(nested_a), create_disknode(nested_b)],
			file_roots: [ZZZ_DIR, nested_dir]
		});

		await load({ files: [create_disknode(nested_a)] });
		assert.ok(app.diskfiles.get_by_path(nested_a), 'still under the zzz dir root');
		assert.ok(!app.diskfiles.get_by_path(nested_b));
	});

	test('an open or close during the request wins over the snapshot', async () => {
		await load({ workspaces: [create_workspace_info(WS_DIR)] });

		const loaded = app.load_session();
		// closed, and another opened with its files, while the request was in flight
		app.workspaces.remove_by_path(WS_DIR);
		app.workspaces.add(create_workspace_info(OTHER_DIR));
		app.diskfiles.add_initial([create_disknode(OTHER_A)]);
		await succeed(1, {
			workspaces: [create_workspace_info(WS_DIR)],
			file_roots: [ZZZ_DIR, WS_DIR, OTHER_DIR]
		});
		assert.ok(await loaded);

		assert.ok(!app.workspaces.get_by_path(WS_DIR), 'the close stands');
		assert.ok(app.workspaces.get_by_path(OTHER_DIR), 'the open stands');
		assert.ok(app.diskfiles.get_by_path(OTHER_A), "the opened workspace's files stay");

		// a later snapshot is authoritative again
		await load({ workspaces: [] });
		assert.strictEqual(app.workspaces.items.size, 0);
	});
});

describe('workspaces after a restart', () => {
	const WS_B = DiskfilePath.parse('/ws/b.txt');

	/** Opens `WS_DIR` with `WS_A` and `WS_B`, `WS_B` in a tab with unsaved edits. */
	const setup = async (): Promise<void> => {
		await load({
			workspaces: [create_workspace_info(WS_DIR)],
			files: [create_disknode(WS_A), create_disknode(WS_B, 'b')],
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		const b = app.diskfiles.get_by_path(WS_B)!;
		app.diskfiles.select(b.id, true);
		new DiskfileEditorState({ app, diskfile: b }).current_content = 'b edited';
	};

	/** The backend restarted without the runtime workspace. */
	const load_restarted = async (data: Partial<SessionLoadData> = {}): Promise<void> => {
		server_instance_id = create_uuid();
		await load(data);
	};

	test('reopens the workspaces it lost, keeping their files and tabs', async () => {
		await setup();
		const workspace = app.workspaces.get_by_path(WS_DIR);
		await load_restarted();

		assert.strictEqual(app.workspaces.get_by_path(WS_DIR), workspace, 'kept while reopening');
		assert.ok(app.diskfiles.get_by_path(WS_A), 'files kept while reopening');
		assert.deepEqual(
			open_calls.map((c) => c.path),
			[WS_DIR]
		);

		// reopened: WS_B was deleted while zzzd was down
		open_calls[0]!.resolve({
			ok: true,
			value: {
				workspace: create_workspace_info(WS_DIR),
				files: [create_disknode(WS_A)],
				watch_status: 'full'
			}
		});
		await flush();
		assert.strictEqual(app.workspaces.get_by_path(WS_DIR), workspace);
		assert.ok(app.diskfiles.get_by_path(WS_A));
		const b = app.diskfiles.get_by_path(WS_B);
		assert.ok(b?.deleted_on_disk, 'the dirty tab survives, flagged deleted');
		assert.ok(app.diskfiles.editor.tabs.by_diskfile_id.get(b.id));

		// a later snapshot listing it is plain replace again, with no more reopens
		await load({
			workspaces: [create_workspace_info(WS_DIR)],
			files: [create_disknode(WS_A)],
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		assert.strictEqual(open_calls.length, 1);
	});

	test('a reopen refused because the directory is gone drops it and its files', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await setup();
		await load_restarted({ files: [create_disknode(ZZZ_A)] });

		open_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.not_found, message: 'failed to open workspace: gone' }
		});
		await flush();
		assert.ok(!app.workspaces.get_by_path(WS_DIR));
		assert.ok(!app.diskfiles.get_by_path(WS_A));
		assert.ok(app.diskfiles.get_by_path(WS_B)?.deleted_on_disk, 'unsaved edits still kept');
		assert.ok(app.diskfiles.get_by_path(ZZZ_A), 'other roots untouched');
		assert.ok(vi.mocked(console.error).mock.calls.length > 0, 'the failure is logged');

		await load({ files: [create_disknode(ZZZ_A)] });
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
		assert.ok(app.workspaces.get_by_path(WS_DIR), 'kept');
		assert.ok(app.diskfiles.get_by_path(WS_A));
		assert.strictEqual(open_calls.length, 1, 'no retry loop');

		// the next snapshot (same instance) retries instead of closing it
		await load();
		assert.ok(app.workspaces.get_by_path(WS_DIR));
		assert.strictEqual(open_calls.length, 2);
	});

	test('a refused reopen spares files under a nested file root', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const nested_dir = DiskfileDirectoryPath.parse('/ws/nested/');
		const nested_a = DiskfilePath.parse('/ws/nested/a.txt');
		await setup();
		// the restarted daemon still watches a scoped dir inside the workspace
		await load_restarted({ files: [create_disknode(nested_a)], file_roots: [ZZZ_DIR, nested_dir] });
		open_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.forbidden, message: 'failed to open workspace' }
		});
		await flush();
		assert.ok(!app.workspaces.get_by_path(WS_DIR));
		assert.ok(!app.diskfiles.get_by_path(WS_A), 'only the workspace covered it');
		assert.ok(app.diskfiles.get_by_path(nested_a), 'another root still covers it');
	});

	/** Stubs `workspace_close` with calls the test resolves. */
	const stub_close = (): Array<{ path: string; resolve: (result: unknown) => void }> => {
		const close_calls: Array<{ path: string; resolve: (result: unknown) => void }> = [];
		(app.api as unknown as Record<string, unknown>).workspace_close = ({
			path
		}: {
			path: string;
		}) => new Promise((resolve) => close_calls.push({ path, resolve }));
		return close_calls;
	};

	const NOT_OPEN = {
		ok: false,
		error: {
			code: JSONRPC_ERROR_CODES.invalid_params,
			message: `workspace not open: ${WS_DIR}`,
			data: { reason: ERROR_WORKSPACE_NOT_OPEN }
		}
	};

	const REOPENED: WorkspaceOpenResult = {
		ok: true,
		value: {
			workspace: create_workspace_info(WS_DIR),
			files: [create_disknode(WS_A)],
			watch_status: 'full'
		}
	};

	test('closing a workspace pending a reopen retry cancels the retry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await setup();
		await load_restarted();
		open_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.service_unavailable, message: 'socket closed' }
		});
		await flush();
		assert.ok(app.workspaces.get_by_path(WS_DIR), 'kept for a retry');

		const close_calls = stub_close();
		const closed = app.close_workspace(WS_DIR);
		// a snapshot while the close is in flight, with the workspace still here
		await load();
		assert.strictEqual(open_calls.length, 1, 'the close cancelled the retry');

		// the backend never reopened it
		close_calls[0]!.resolve(NOT_OPEN);
		assert.ok((await closed).ok);
		assert.ok(!app.workspaces.get_by_path(WS_DIR), 'removed here');
		await load();
		assert.strictEqual(open_calls.length, 1);
	});

	test('a close during an in-flight reopen sticks', async () => {
		await setup();
		await load_restarted();
		const close_calls = stub_close();

		// the backend's open is still scanning, so the close finds nothing open
		const closed = app.close_workspace(WS_DIR);
		close_calls[0]!.resolve(NOT_OPEN);
		assert.ok((await closed).ok);
		assert.ok(!app.workspaces.get_by_path(WS_DIR));

		// then the open registers anyway
		open_calls[0]!.resolve(REOPENED);
		await flush();
		assert.deepEqual(
			close_calls.map((c) => c.path),
			[WS_DIR, WS_DIR],
			'closed again'
		);
		close_calls[1]!.resolve({ ok: true, value: null });
		await flush();
		assert.ok(!app.workspaces.get_by_path(WS_DIR), 'absent');
	});

	test('a snapshot listing the workspace mid-reopen closes nothing', async () => {
		await setup();
		await load_restarted();
		const close_calls = stub_close();
		await load({
			workspaces: [create_workspace_info(WS_DIR)],
			files: [create_disknode(WS_A)],
			file_roots: [ZZZ_DIR, WS_DIR]
		});
		open_calls[0]!.resolve(REOPENED);
		await flush();
		assert.strictEqual(close_calls.length, 0);
		assert.ok(app.workspaces.get_by_path(WS_DIR));
	});

	test('any other close failure is returned and keeps the workspace', async () => {
		await load({ workspaces: [create_workspace_info(WS_DIR)] });
		(app.api as unknown as Record<string, unknown>).workspace_close = () =>
			Promise.resolve({
				ok: false,
				error: { code: JSONRPC_ERROR_CODES.internal_error, message: 'boom' }
			});
		const result = await app.close_workspace(WS_DIR);
		assert.ok(!result.ok);
		assert.strictEqual(result.error.message, 'boom');
		assert.ok(app.workspaces.get_by_path(WS_DIR));
	});

	test('a snapshot during the reopen leaves the workspace alone', async () => {
		await setup();
		await load_restarted();
		await load();
		assert.ok(app.workspaces.get_by_path(WS_DIR));
		assert.ok(app.diskfiles.get_by_path(WS_A));
		assert.strictEqual(open_calls.length, 1);
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
