// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import type { ProjectInfoJson } from '#lib/project.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { install_fake_disk, seed_diskfile, type FakeDisk } from './diskfile_test_helpers.ts';

const navigation = vi.hoisted(() => ({ goto: vi.fn((_url: string) => Promise.resolve()) }));
vi.mock('$app/navigation', () => navigation);
const state = vi.hoisted(() => ({
	page: { url: new URL('http://localhost/projects') },
	navigating: { complete: null as Promise<void> | null }
}));
vi.mock('$app/state', () => state);

const ROOT = parse_or_throw(DiskfileDirectoryPath, '/w/');
const FILE = parse_or_throw(DiskfilePath, '/w/a.txt');

const info = (root: DiskfileDirectoryPath, name: string): ProjectInfoJson => ({
	root,
	name,
	opened_at: '2026-11-18T00:00:00.000Z',
	kind: 'plain_dir',
	registry_path: null,
	fallback: null,
	entries: [],
	focused: [root],
	ignored: {},
	rev: 1
});

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: number; message: string } };

let app: Frontend;
let disk: FakeDisk;
let replies: Array<(reply: Reply) => void>;

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	navigation.goto.mockClear();
	state.page.url = new URL('http://localhost/projects');
	state.navigating.complete = null;
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, '/w/');
	// saves go through the fake disk
	delete (app.diskfiles as unknown as { update?: unknown }).update;
	await disk.load(FILE, 'a');
	replies = [];
	const api = app.api as unknown as Record<string, unknown>;
	api.project_open = () => new Promise<Reply>((resolve) => replies.push(resolve));
});

afterEach(() => {
	app.dispose();
	vi.restoreAllMocks();
});

const tick = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

const opened = (root: DiskfileDirectoryPath, name: string): Reply => ({
	ok: true,
	value: {
		project: info(root, name),
		focus: root,
		files: [],
		watch_status: 'full',
		refused: [],
		opened: true
	}
});

describe('path_open', () => {
	test('a file the open indexed opens in a tab, its project active, the files page shown', async () => {
		const pending = app.intents.path_open({ path: FILE });
		await tick();
		replies[0]!(opened(ROOT, 'w'));
		const result = await pending;
		assert.ok(result.ok);
		assert.deepEqual(result.value, { root: ROOT, file: true });
		assert.strictEqual(app.projects.active?.root, ROOT);
		assert.strictEqual(app.diskfiles.selected_path, FILE);
		assert.deepEqual(
			navigation.goto.mock.calls.map((call) => call[0]),
			['/files']
		);
		const entry = app.recent_intents.entries.at(-1);
		assert.ok(entry);
		assert.strictEqual(entry.outcome, 'applied');
	});

	test('a directory opens no tab and stays on the page', async () => {
		const pending = app.intents.path_open({ path: ROOT });
		await tick();
		replies[0]!(opened(ROOT, 'w'));
		const result = await pending;
		assert.ok(result.ok);
		assert.deepEqual(result.value, { root: ROOT, file: false });
		assert.strictEqual(navigation.goto.mock.calls.length, 0);
	});

	test('a page left while the open was in flight stays left, no tab opened', async () => {
		const pending = app.intents.path_open({ path: FILE });
		await tick();
		state.page.url = new URL('http://localhost/chats');
		replies[0]!(opened(ROOT, 'w'));
		const result = await pending;
		assert.ok(result.ok);
		assert.deepEqual(result.value, { root: ROOT, file: false });
		assert.isNull(app.diskfiles.selected_path);
		assert.strictEqual(navigation.goto.mock.calls.length, 0);
		assert.strictEqual(app.projects.active?.root, ROOT, 'still activated');
	});

	test('a navigation under way when the open lands settles first, then decides', async () => {
		const pending = app.intents.path_open({ path: FILE });
		await tick();
		// a click elsewhere, still loading when the open lands
		let settle!: () => void;
		state.navigating.complete = new Promise<void>((resolve) => (settle = resolve));
		replies[0]!(opened(ROOT, 'w'));
		await tick();
		assert.isNull(app.diskfiles.selected_path, 'waits for it');
		state.page.url = new URL('http://localhost/chats');
		settle();
		const result = await pending;
		assert.ok(result.ok);
		assert.deepEqual(result.value, { root: ROOT, file: false });
		assert.strictEqual(navigation.goto.mock.calls.length, 0);
	});

	test('a navigation overtaking another is waited out too', async () => {
		const pending = app.intents.path_open({ path: FILE });
		await tick();
		// the strip, aborted by a click elsewhere that is still loading when the strip rejects
		let abort!: () => void;
		let settle!: () => void;
		const click = new Promise<void>((resolve) => (settle = resolve));
		state.navigating.complete = new Promise<void>(
			(_resolve, reject) => (abort = () => reject(new Error('aborted')))
		);
		replies[0]!(opened(ROOT, 'w'));
		await tick();
		state.navigating.complete = click;
		abort();
		await tick();
		assert.isNull(app.diskfiles.selected_path, 'still waiting on the click');
		state.page.url = new URL('http://localhost/chats');
		state.navigating.complete = null;
		settle();
		const result = await pending;
		assert.ok(result.ok);
		assert.deepEqual(result.value, { root: ROOT, file: false });
		assert.strictEqual(navigation.goto.mock.calls.length, 0);
	});

	test("a refusal is the call's error, recorded as failed with the daemon's message", async () => {
		const pending = app.intents.path_open({ path: FILE });
		await tick();
		replies[0]!({ ok: false, error: { code: -32602, message: 'not allowed' } });
		const result = await pending;
		assert.ok(!result.ok);
		assert.strictEqual(result.error.message, 'not allowed');
		const entry = app.recent_intents.entries.at(-1);
		assert.ok(entry);
		assert.strictEqual(entry.outcome, 'failed');
		assert.strictEqual(entry.error, 'not allowed');
	});
});

describe('project_activate and view_show', () => {
	test('`project_activate` finds an open project by its root', () => {
		const other = parse_or_throw(DiskfileDirectoryPath, '/x/');
		app.projects.add(info(ROOT, 'w'));
		app.projects.add(info(other, 'x'));
		assert.strictEqual(app.projects.active?.root, ROOT);
		assert.deepEqual(app.intents.project_activate({ root: other }), { found: true });
		assert.strictEqual(app.projects.active?.root, other);
		const none = parse_or_throw(DiskfileDirectoryPath, '/none/');
		assert.deepEqual(app.intents.project_activate({ root: none }), { found: false });
		assert.strictEqual(app.projects.active?.root, other);
	});

	test('`view_show` goes to the page, a chat by its id, and not to the page shown', () => {
		app.intents.view_show({ view: 'files' });
		app.intents.view_show({ view: 'home' });
		const id = app.chats.add().id;
		app.intents.view_show({ view: 'chats', id });
		app.intents.view_show({ view: 'projects' });
		assert.deepEqual(
			navigation.goto.mock.calls.map((call) => call[0]),
			['/files', '/', `/chats/${id}`]
		);
	});
});

describe('tab_close_resolve', () => {
	const ask = (): void => {
		app.intents.tab_open({ path: FILE, permanent: true });
		const diskfile = seed_diskfile(app, FILE);
		assert.ok(diskfile);
		app.diskfiles.get_editor_state(diskfile).current_content = 'draft';
		assert.deepEqual(app.intents.tab_close({ path: FILE }), { result: 'asking' });
	};

	test('`cancel` keeps the tab, `discard` drops the draft and closes it', async () => {
		ask();
		const kept = await app.intents.tab_close_resolve({ path: FILE, choice: 'cancel' });
		assert.ok(kept.ok);
		assert.deepEqual(kept.value, { result: 'kept_open' });
		assert.ok(app.diskfiles.editor.tabs.by_path.has(FILE));
		assert.isNull(app.diskfiles.editor.pending_close_request);

		ask();
		const pending = app.intents.tab_close_resolve({ path: FILE, choice: 'discard' });
		// closed before the call's first await, so a caller can act on the new selection at once
		assert.isFalse(app.diskfiles.editor.tabs.by_path.has(FILE));
		const closed = await pending;
		assert.ok(closed.ok);
		assert.deepEqual(closed.value, { result: 'closed' });
		assert.isFalse(app.diskfiles.drafts.has(FILE));
	});

	test('`keep` closes the tab keeping the draft', async () => {
		ask();
		const result = await app.intents.tab_close_resolve({ path: FILE, choice: 'keep' });
		assert.ok(result.ok);
		assert.deepEqual(result.value, { result: 'closed' });
		assert.isFalse(app.diskfiles.editor.tabs.by_path.has(FILE));
		assert.isTrue(app.diskfiles.drafts.has(FILE));
	});

	test('a save that conflicts is a `conflict` error, the tab kept', async () => {
		ask();
		disk.files.set(FILE, 'theirs');
		const result = await app.intents.tab_close_resolve({ path: FILE, choice: 'save' });
		assert.ok(!result.ok);
		assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.conflict);
		assert.deepEqual(result.error.data, { reason: 'disk_changed' });
		assert.ok(app.diskfiles.editor.tabs.by_path.has(FILE));
	});

	test('`save` writes the draft and closes', async () => {
		ask();
		const result = await app.intents.tab_close_resolve({ path: FILE, choice: 'save' });
		assert.ok(result.ok);
		assert.deepEqual(result.value, { result: 'closed' });
		assert.strictEqual(disk.files.get(FILE), 'draft');
	});

	test('a tab with no close asked about is `not_asked`', async () => {
		app.intents.tab_open({ path: FILE, permanent: true });
		const result = await app.intents.tab_close_resolve({ path: FILE, choice: 'discard' });
		assert.ok(result.ok);
		assert.deepEqual(result.value, { result: 'not_asked' });
		assert.ok(app.diskfiles.editor.tabs.by_path.has(FILE));
	});
});
