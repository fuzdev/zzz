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
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/projects') },
	navigating: { complete: null as Promise<void> | null }
}));
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
	fallback: null,
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
	ignored: {},
	rev
});

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: number; message: string } };

let app: Frontend;
let calls: Array<{ method: string; input: unknown; resolve: (result: Reply) => void }>;
/** The status polls, apart from `calls`: the page starts one per registry. */
let status_calls: Array<{ input: unknown; resolve: (result: Reply) => void }>;
let target: HTMLElement;
let mounted: ReturnType<typeof mount>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = [];
	status_calls = [];
	const pending = (method: string) => (input: unknown) =>
		new Promise<Reply>((resolve) => calls.push({ method, input, resolve }));
	(app as unknown as { api: unknown }).api = {
		repo_focus: pending('repo_focus'),
		repo_unfocus: pending('repo_unfocus'),
		project_open: pending('project_open'),
		project_status: (input: unknown) =>
			new Promise<Reply>((resolve) => status_calls.push({ input, resolve }))
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
	// an open settles a few turns after its reply: the intent, then the navigation check
	for (let i = 0; i < 20; i++) await Promise.resolve();
	flushSync();
};

describe('a registry project on the projects page', () => {
	test('lists each entry: present ones with a focus toggle, the rest with why not', () => {
		assert.deepEqual(entry_texts(), [
			'app/ unfocus …',
			'site/ focus …',
			'gone/ not cloned',
			'keys/ reference refused: entry_not_confined'
		]);
	});

	test("polls each present entry's git status and shows what differs from rest", async () => {
		assert.deepEqual(
			status_calls.map((c) => c.input),
			[{ root: DEV }]
		);
		const at_rest = {
			state: 'ok',
			probing: false,
			probed_at: 1,
			branch: 'main',
			detached: false,
			on_branch: true,
			uncommitted: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
			in_progress: null,
			followed: { kind: 'in_sync', ahead: 0, behind: 0 },
			stashes: 0,
			fetched_at: null,
			needs_human: [],
			error: null
		};
		status_calls[0]!.resolve({
			ok: true,
			value: {
				entries: [
					{ ...at_rest, key: 'app', uncommitted: { ...at_rest.uncommitted, unstaged: 2 } },
					{ ...at_rest, key: 'site' },
					{ ...at_rest, key: 'gone', state: 'missing', probed_at: null }
				]
			}
		});
		await tick();
		assert.deepEqual(entry_texts().slice(0, 3), [
			'app/ unfocus 2 unstaged',
			'site/ focus clean',
			'gone/ not cloned'
		]);
	});

	test('a status names its needs-human reason, says not cloned, and marks a probe beside a known status', async () => {
		const base = {
			probed_at: 1,
			branch: 'main',
			detached: false,
			on_branch: true,
			uncommitted: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
			in_progress: null,
			followed: null,
			stashes: 0,
			fetched_at: null,
			error: null
		};
		status_calls[0]!.resolve({
			ok: true,
			value: {
				entries: [
					{
						...base,
						key: 'app',
						state: 'ok',
						probing: true,
						needs_human: ['origin_mismatch']
					},
					{ ...base, key: 'site', state: 'missing', probing: false, needs_human: [] }
				]
			}
		});
		await tick();
		assert.deepEqual(entry_texts().slice(0, 2), [
			'app/ unfocus origin mismatch …',
			'site/ focus not cloned'
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
		assert.deepEqual(entry_texts().slice(0, 2), ['app/ unfocus …', 'site/ unfocus …']);

		entry_button('app/').click();
		flushSync();
		assert.deepEqual(calls[1]!.method, 'repo_unfocus');
		assert.strictEqual(to_visible_text(entry_button('app/')), 'unfocusing…');
		calls[1]!.resolve({ ok: true, value: { project: registry_info([SITE], 3) } });
		await tick();
		assert.deepEqual(entry_texts().slice(0, 2), ['app/ focus …', 'site/ unfocus …']);
	});

	test('a failure says why', async () => {
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

const LOOSE = parse_or_throw(DiskfileDirectoryPath, '/dev/loose/');

/** A checkout opened under the registry at `/dev/`, which passed it over. */
const fallback_info = (fallback: ProjectInfoJson['fallback'], rev = 1): ProjectInfoJson => ({
	root: LOOSE,
	name: 'loose',
	opened_at: '2026-11-16T00:00:00.000Z',
	kind: 'git_repo',
	registry_path: null,
	fallback,
	entries: [],
	focused: [LOOSE],
	ignored: {},
	rev
});

/** The projects listed, each row's text as it reads. */
const project_texts = (): Array<string> =>
	Array.from(target.querySelectorAll('section > ul > li')).map((el) => to_visible_text(el));

describe('a project opened past a registry on the projects page', () => {
	const REGISTRY = parse_or_throw(DiskfilePath, '/dev/repos.toml');

	test('says the registry above it lists no cloned repo holding it', () => {
		app.projects.add(fallback_info({ kind: 'unregistered', registry_path: REGISTRY }));
		flushSync();
		const row = project_texts().find((text) => text.startsWith('loose'));
		assert.ok(row);
		assert.include(row, 'git repo');
		assert.include(row, '/dev/repos.toml lists no cloned repo holding it');
	});

	test('says why a registry in a checkout was refused', () => {
		app.projects.add(
			fallback_info({
				kind: 'registry_refused',
				registry_path: REGISTRY,
				reason: 'registry_invalid'
			})
		);
		flushSync();
		const row = project_texts().find((text) => text.startsWith('loose'));
		assert.include(row, "/dev/repos.toml isn't a valid registry");
	});

	test('an open says where it was rooted and why', async () => {
		const input = target.querySelector('input');
		assert.ok(input);
		input.value = '/dev/loose/src';
		input.dispatchEvent(new Event('input'));
		flushSync();
		target.querySelector('form')!.requestSubmit();
		await tick();
		assert.deepEqual(
			calls.map((c) => [c.method, c.input]),
			[['project_open', { path: '/dev/loose/src' }]]
		);
		calls[0]!.resolve({
			ok: true,
			value: {
				project: fallback_info({ kind: 'unregistered', registry_path: REGISTRY }),
				focus: LOOSE,
				files: [],
				watch_status: 'full',
				refused: [],
				opened: true
			}
		});
		await tick();
		assert.include(
			to_visible_text(target),
			'Opened /dev/loose/src, rooted at /dev/loose/ — a git checkout; /dev/repos.toml lists no cloned repo holding it.'
		);
		const entry = app.recent_intents.entries.at(-1);
		assert.ok(entry);
		assert.strictEqual(entry.method, 'path_open');
		assert.strictEqual(entry.outcome, 'applied', 'recorded once it settled');
		assert.strictEqual(app.projects.active?.root, LOOSE);
	});

	test("a refused open shows the daemon's message, recorded as failed", async () => {
		const input = target.querySelector('input');
		assert.ok(input);
		input.value = '/dev/nope';
		input.dispatchEvent(new Event('input'));
		flushSync();
		target.querySelector('form')!.requestSubmit();
		await tick();
		calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.invalid_params, message: 'path not allowed' }
		});
		await tick();
		assert.include(to_visible_text(target), 'path not allowed');
		const entry = app.recent_intents.entries.at(-1);
		assert.ok(entry);
		assert.strictEqual(entry.method, 'path_open');
		assert.strictEqual(entry.outcome, 'failed');
		assert.strictEqual(entry.error, 'path not allowed');
	});

	test('a click makes a project the active one, by its root', () => {
		app.projects.add(fallback_info({ kind: 'unregistered', registry_path: REGISTRY }));
		flushSync();
		const button = Array.from(
			target.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
		).find((b) => b.textContent.includes('loose'));
		assert.ok(button);
		button.click();
		flushSync();
		assert.strictEqual(app.projects.active?.root, LOOSE);
		assert.strictEqual(button.getAttribute('aria-pressed'), 'true');
		assert.deepEqual(
			app.recent_intents.entries.map((e) => [e.method, e.input]),
			[['project_activate', { root: LOOSE }]]
		);
	});
});
