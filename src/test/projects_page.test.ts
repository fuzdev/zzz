// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import type { ProjectInfoJson } from '#lib/project.svelte.ts';
import ProjectsPage from '#routes/projects/+page.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';

/** The projects page's per-entry focus and unfocus buttons for a registry project. */

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/projects') } }));
// the footer reads the site context, which isn't the page's concern here
vi.mock('#routes/PageFooter.svelte', () => ({ default: () => undefined }));

const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
const APP = parse_or_throw(DiskfileDirectoryPath, '/dev/app/');
const SITE = parse_or_throw(DiskfileDirectoryPath, '/dev/site/');

const registry_info = (focused: Array<DiskfileDirectoryPath>, rev = 1): ProjectInfoJson => ({
	root: DEV,
	name: 'dev',
	opened_at: '2026-11-16T00:00:00.000Z',
	kind: 'registry',
	registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml'),
	entries: [
		{ key: 'app', kind: 'repo', dir: APP, state: 'present' },
		{ key: 'site', kind: 'repo', dir: SITE, state: 'present' },
		{
			key: 'gone',
			kind: 'repo',
			dir: parse_or_throw(DiskfileDirectoryPath, '/dev/gone/'),
			state: 'missing'
		},
		{
			key: 'keys',
			kind: 'reference',
			dir: parse_or_throw(DiskfileDirectoryPath, '/dev/keys/'),
			state: 'refused',
			reason: 'entry_not_confined'
		}
	],
	focused,
	rev
});

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: number; message: string } };

let app: Frontend;
let calls: Array<{ method: string; input: unknown; resolve: (result: Reply) => void }>;
let target: HTMLElement;
let mounted: ReturnType<typeof mount>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = [];
	const pending = (method: string) => (input: unknown) =>
		new Promise<Reply>((resolve) => calls.push({ method, input, resolve }));
	(app as unknown as { api: unknown }).api = {
		repo_focus: pending('repo_focus'),
		repo_unfocus: pending('repo_unfocus')
	};
	app.projects.add(registry_info([APP]));
	target = document.createElement('div');
	document.body.append(target);
	mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: ProjectsPage, props: {} }
	});
	flushSync();
});
afterEach(() => {
	void unmount(mounted);
	target.remove();
	app.dispose();
	vi.restoreAllMocks();
});

/** Each entry's line, as it reads. */
const entry_texts = (): Array<string> =>
	Array.from(target.querySelectorAll('li li')).map((el) => to_visible_text(el));

const entry_button = (dir: string): HTMLButtonElement => {
	const item = Array.from(target.querySelectorAll('li li')).find((el) =>
		to_visible_text(el).startsWith(dir)
	);
	const button = item?.querySelector('button');
	assert.ok(button, `a button for ${dir}`);
	return button;
};

const tick = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	flushSync();
};

describe('a registry project on the projects page', () => {
	test('lists each entry: present ones with a focus toggle, the rest with why not', () => {
		assert.deepEqual(entry_texts(), [
			'app/ unfocus',
			'site/ focus',
			'gone/ not cloned',
			'keys/ reference refused: entry_not_confined'
		]);
	});

	test('focus and unfocus buttons call the daemon, disabled while in flight', async () => {
		entry_button('site/').click();
		flushSync();
		assert.deepEqual(
			calls.map((c) => [c.method, c.input]),
			[['repo_focus', { root: DEV, dir: SITE }]]
		);
		assert.isTrue(entry_button('site/').disabled);
		assert.strictEqual(to_visible_text(entry_button('site/')), 'focusing…');
		calls[0]!.resolve({
			ok: true,
			value: { project: registry_info([APP, SITE], 2), files: [], watch_status: 'full' }
		});
		await tick();
		assert.deepEqual(entry_texts().slice(0, 2), ['app/ unfocus', 'site/ unfocus']);

		entry_button('app/').click();
		flushSync();
		assert.deepEqual(calls[1]!.method, 'repo_unfocus');
		assert.strictEqual(to_visible_text(entry_button('app/')), 'unfocusing…');
		calls[1]!.resolve({ ok: true, value: { project: registry_info([SITE], 3) } });
		await tick();
		assert.deepEqual(entry_texts().slice(0, 2), ['app/ focus', 'site/ unfocus']);
	});

	test('a failure says why', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		entry_button('site/').click();
		calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.not_found, message: 'failed to focus repo: gone' }
		});
		await tick();
		assert.include(
			to_visible_text(target),
			'failed to focus /dev/site/: failed to focus repo: gone'
		);
	});
});
