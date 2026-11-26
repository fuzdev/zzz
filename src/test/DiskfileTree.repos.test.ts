// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import type { RepoFocusOutput, RepoUnfocusOutput } from '#lib/action_specs.ts';
import type { ProjectInfoJson } from '#lib/project.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	ResizeObserverStub,
	mount_tree,
	write_diskfile,
	active_text,
	choose_menuitem,
	click,
	find_row,
	menuitem_labels,
	open_contextmenu,
	open_submenu,
	outline,
	press,
	row_texts
} from './diskfile_tree_test_helpers.ts';
import { encode_snapshot_files, seed_diskfile } from './diskfile_test_helpers.ts';

/**
 * A registry project's repos in the file tree: focused ones as folders,
 * unfocused ones as lazy rows that a key, a click, or the menu focuses
 * (`repo_focus`), and the folder menu's unfocus (`repo_unfocus`).
 */

const navigation = vi.hoisted(() => ({ goto: vi.fn((_url: string) => Promise.resolve()) }));
vi.mock('$app/navigation', () => navigation);
vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/files') },
	navigating: { complete: null as Promise<void> | null }
}));

const DEV = parse_or_throw(DiskfileDirectoryPath, '/dev/');
const APP = parse_or_throw(DiskfileDirectoryPath, '/dev/app/');
const SITE = parse_or_throw(DiskfileDirectoryPath, '/dev/site/');

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: number; message: string } };

let app: Frontend;
let focus_calls: Array<{ input: unknown; resolve: (result: Reply<RepoFocusOutput>) => void }>;
let unfocus_calls: Array<{ input: unknown; resolve: (result: Reply<RepoUnfocusOutput>) => void }>;
const cleanups: Array<() => void> = [];

/** The registry at `/dev/`: `app` and `site` present, `gone` missing, `keys` refused. */
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

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = parse_or_throw(DiskfileDirectoryPath, '/zzz/');
	focus_calls = [];
	unfocus_calls = [];
	(app as unknown as { api: unknown }).api = {
		repo_focus: (input: unknown) => new Promise((resolve) => focus_calls.push({ input, resolve })),
		repo_unfocus: (input: unknown) =>
			new Promise((resolve) => unfocus_calls.push({ input, resolve }))
	};
	app.projects.add(registry_info([APP]));
	write_diskfile(app, '/dev/README.md', DEV);
	write_diskfile(app, '/dev/app/src/a.ts', APP);
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const render_tree = (): HTMLElement => mount_tree(app, cleanups).target;

/** Presses ArrowDown until the row reading `text` is active. */
const move_to_row = (target: HTMLElement, text: string): void => {
	for (let i = 0; i < 20 && active_text(target) !== text; i++) press(target, 'ArrowDown');
	assert.strictEqual(active_text(target), text);
};

/** The rows under the `/dev/` root, past the app directory's empty root row. */
const dev_outline = (): Array<string> => {
	const rows = outline(app.diskfiles.editor.tree.rows);
	return rows.slice(rows.indexOf('- /dev/'));
};

const tick = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Answers the pending `repo_focus` of `site` as the daemon would. */
const focus_site = async (): Promise<void> => {
	focus_calls.at(-1)!.resolve({
		ok: true,
		value: {
			project: registry_info([APP, SITE], 2),
			files: encode_snapshot_files([
				{
					id: parse_or_throw(DiskfilePath, '/dev/site/s.md'),
					source_dir: SITE,
					size: 1,
					ctime: 1,
					mtime: 1
				}
			]),
			watch_status: 'full'
		}
	});
	await tick();
};

describe('a registry root', () => {
	test('shows its focused repos as folders and the other present ones as lazy rows', () => {
		const target = render_tree();
		assert.deepEqual(dev_outline(), ['- /dev/', '  + app', '  ~ site', '  README.md']);
		const site = find_row(target, 'site');
		assert.strictEqual(site.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(site.getAttribute('aria-label'), 'site, not focused');
		// missing and refused entries aren't rows: the projects page says why
		assert.notInclude(row_texts(target), 'gone');
		assert.notInclude(row_texts(target), 'keys');
	});

	test('a focused repo is a row of its own, never part of a compact one', () => {
		const target = render_tree();
		move_to_row(target, 'app');
		press(target, 'ArrowRight');
		assert.deepEqual(dev_outline().slice(1, 3), ['  - app', '    + src']);
	});

	test('revealing a folder inside a collapsed repo expands the repo, its own row', () => {
		render_tree();
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(dev_outline().slice(1, 2), ['  + app'], 'collapsed, holding only `src`');
		assert.isTrue(tree.reveal('/dev/app/src/'));
		assert.deepEqual(dev_outline().slice(1, 3), ['  - app', '    + src']);
		assert.strictEqual(tree.active_row?.path, '/dev/app/src/');
	});
});

describe('focusing a lazy row', () => {
	test('ArrowRight focuses it, then shows it expanded with its files, still active', async () => {
		const target = render_tree();
		move_to_row(target, 'site');
		assert.isTrue(press(target, 'ArrowRight'));
		assert.deepEqual(
			focus_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }]
		);
		assert.strictEqual(active_text(target), 'site focusing…');
		assert.strictEqual(find_row(target, 'site focusing…').getAttribute('aria-busy'), 'true');
		// a second key while it's in flight sends nothing more
		press(target, 'ArrowRight');
		assert.strictEqual(focus_calls.length, 1);

		await focus_site();
		assert.deepEqual(dev_outline(), ['- /dev/', '  + app', '  - site', '    s.md', '  README.md']);
		assert.strictEqual(active_text(target), 'site');
	});

	test('Enter and a click focus it too', async () => {
		const target = render_tree();
		move_to_row(target, 'site');
		press(target, 'Enter');
		assert.strictEqual(focus_calls.length, 1);
		await focus_site();
		assert.deepEqual(dev_outline().slice(2, 4), ['  - site', '    s.md']);

		// unfocused again, elsewhere
		app.projects.receive_remote_change(registry_info([APP], 3));
		click(find_row(target, 'site'));
		assert.strictEqual(focus_calls.length, 2);
	});

	test('a failure says why and leaves it lazy', async () => {
		const target = render_tree();
		click(find_row(target, 'site'));
		focus_calls[0]!.resolve({
			ok: false,
			error: { code: JSONRPC_ERROR_CODES.not_found, message: 'failed to focus repo: gone' }
		});
		await tick();
		assert.include(target.querySelector('[role="status"]')!.textContent, 'couldn’t focus site');
		assert.deepEqual(dev_outline().slice(2, 3), ['  ~ site']);
		assert.isFalse(app.diskfiles.editor.tree.expanded.has(SITE));
	});

	test('"expand all below" leaves it lazy', () => {
		render_tree();
		const { tree } = app.diskfiles.editor;
		const root = tree.rows.find((row) => row.path === DEV)!;
		assert(root.kind === 'root');
		tree.expand_all_below(root);
		assert.deepEqual(dev_outline(), [
			'- /dev/',
			'  - app',
			'    - src',
			'      a.ts',
			'  ~ site',
			'  README.md'
		]);
		assert.strictEqual(focus_calls.length, 0);
		assert.isFalse(tree.expanded.has(SITE), 'so a later focus shows it as it was');
	});
});

describe('the repo contextmenus', () => {
	test('a lazy row’s "repo" menu focuses it', async () => {
		const target = render_tree();
		assert.isTrue(open_contextmenu(find_row(target, 'site')));
		await open_submenu('repo');
		assert.deepEqual(menuitem_labels(), [
			'repo',
			'focus repo',
			'open terminal here',
			'copy path',
			'copy relative path',
			'copy name'
		]);
		await choose_menuitem('focus repo');
		assert.deepEqual(
			focus_calls.map((c) => c.input),
			[{ root: DEV, dir: SITE }]
		);
	});

	test('a focused repo’s folder menu unfocuses it, and its files leave the tree', async () => {
		const target = render_tree();
		assert.isTrue(open_contextmenu(find_row(target, 'app')));
		await open_submenu('folder');
		assert.include(menuitem_labels(), 'unfocus repo');
		await choose_menuitem('unfocus repo');
		assert.deepEqual(
			unfocus_calls.map((c) => c.input),
			[{ root: DEV, dir: APP }]
		);
		assert.strictEqual(find_row(target, 'app unfocusing…').getAttribute('aria-busy'), 'true');
		unfocus_calls[0]!.resolve({ ok: true, value: { project: registry_info([], 3) } });
		await tick();
		assert.deepEqual(dev_outline(), ['- /dev/', '  ~ app', '  ~ site', '  README.md']);
		assert.ok(!seed_diskfile(app, parse_or_throw(DiskfilePath, '/dev/app/src/a.ts')));
	});

	test('a plain folder’s menu has no unfocus', async () => {
		const target = render_tree();
		click(find_row(target, 'app'));
		assert.isTrue(open_contextmenu(find_row(target, 'src')));
		await open_submenu('folder');
		assert.notInclude(menuitem_labels(), 'unfocus repo');
	});
});
