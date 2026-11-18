// @vitest-environment jsdom

/** The projects page's `?open=` param: what `zzz <path>` lands the browser on. */

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { goto } from '$app/navigation';
import { page } from '$app/state';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath } from '#lib/diskfile_types.ts';
import ProjectsPage from '#routes/projects/+page.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/projects') } }));
vi.mock('#routes/PageFooter.svelte', () => ({ default: () => undefined }));

const HOME = parse_or_throw(DiskfileDirectoryPath, '/home/me/');

let app: Frontend;
let opened: Array<string>;
let indexed: Set<string>;
let selected: Array<[string, boolean]>;
let target: HTMLElement;
let mounted: ReturnType<typeof mount> | null;

const mount_at = (search: string): void => {
	(page as unknown as { url: URL }).url = new URL(`http://localhost/projects${search}`);
	mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: ProjectsPage, props: {} }
	});
	flushSync();
};

const tick = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	flushSync();
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.home_dir = HOME;
	app.session_status = 'success';
	opened = [];
	indexed = new Set();
	selected = [];
	vi.spyOn(app.projects, 'open').mockImplementation((path) => {
		opened.push(path);
		return Promise.resolve({ ok: true, value: { project: null } } as never);
	});
	vi.spyOn(app.diskfiles, 'open_path').mockImplementation((path, options) => {
		if (!indexed.has(path)) return false;
		selected.push([path, options?.open_not_preview ?? false]);
		return true;
	});
	vi.mocked(goto).mockClear();
	target = document.createElement('div');
	document.body.append(target);
	mounted = null;
});
afterEach(() => {
	if (mounted) void unmount(mounted);
	target.remove();
	app.dispose();
	vi.restoreAllMocks();
});

const gone_to = (): Array<string> => vi.mocked(goto).mock.calls.map(([url]) => String(url));

describe('?open= on the projects page', () => {
	test('a file the open indexed opens in a tab on /files', async () => {
		indexed.add('/home/me/dev/zzz/README.md');
		mount_at('?open=%2Fhome%2Fme%2Fdev%2Fzzz%2FREADME.md');
		await tick();
		assert.deepEqual(opened, ['/home/me/dev/zzz/README.md']);
		assert.deepEqual(selected, [['/home/me/dev/zzz/README.md', true]]);
		assert.deepEqual(gone_to(), ['/projects', '/files']);
	});

	test('a directory, or a file the index skips, stays on the projects page', async () => {
		mount_at('?open=%2Fhome%2Fme%2Fdev%2Fzzz%2F');
		await tick();
		assert.deepEqual(opened, ['/home/me/dev/zzz/']);
		assert.deepEqual(selected, []);
		assert.deepEqual(gone_to(), ['/projects'], 'only the param stripped');
	});

	test('~ expands to the daemon home, once the session has loaded', async () => {
		app.session_status = 'pending';
		app.home_dir = null;
		mount_at('?open=~%2Fdev%2Fzzz%2F');
		await tick();
		assert.deepEqual(opened, [], 'waits for the session');
		assert.notInclude(target.textContent, "can't open", 'waiting, not refusing');
		app.home_dir = HOME;
		app.session_status = 'success';
		flushSync();
		await tick();
		assert.deepEqual(opened, ['/home/me/dev/zzz/']);
	});

	test('a file opened after the user left the page leaves them where they went', async () => {
		indexed.add('/home/me/a.md');
		let finish!: () => void;
		vi.mocked(app.projects.open).mockImplementation(
			(path) =>
				new Promise((resolve_open) => {
					opened.push(path);
					finish = () => resolve_open({ ok: true, value: { project: null } } as never);
				})
		);
		mount_at('?open=%2Fhome%2Fme%2Fa.md');
		await tick();
		(page as unknown as { url: URL }).url = new URL('http://localhost/chats');
		finish();
		await tick();
		assert.deepEqual(selected, []);
		assert.deepEqual(gone_to(), ['/projects']);
	});

	test("another user's ~ is refused, saying why", async () => {
		mount_at('?open=~other%2Fdev');
		await tick();
		assert.deepEqual(opened, []);
		assert.include(target.textContent, 'only your own "~" is expanded');
	});
});
