// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT } from '#lib/diskfile_tree_state.svelte.ts';

import DiskfileTabListitemHarness from './DiskfileTabListitemHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	ResizeObserverStub,
	mount_explorer,
	mount_tree,
	write_diskfile,
	active_text,
	choose_menuitem,
	find_row,
	menuitem_labels,
	open_contextmenu,
	open_submenu,
	row_texts
} from './diskfile_tree_test_helpers.ts';

/**
 * The file explorer's contextmenus, driven as a user would: a folder or root
 * row's menu in the tree, and the file menu's entries that reach the tree and
 * the terminals.
 */

const navigation = vi.hoisted(() => ({ goto: vi.fn((_url: string) => Promise.resolve()) }));
vi.mock('$app/navigation', () => navigation);
// `goto_unless_current` reads the page's path: the files page
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/files') } }));

let app: Frontend;
let copied: Array<string>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/w/';
	copied = [];
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: (text: string) => {
				copied.push(text);
				return Promise.resolve();
			}
		}
	});
	navigation.goto.mockClear();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	Reflect.deleteProperty(navigator, 'clipboard');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const write = (path: string, source_dir?: string): Diskfile =>
	write_diskfile(app, path, source_dir);
const render = (
	component?: Parameters<typeof mount_explorer>[2],
	props?: Record<string, unknown>
): HTMLElement => mount_explorer(app, cleanups, component, props).target;
const render_tree = (): HTMLElement => mount_tree(app, cleanups).target;

/** Opens `row`'s menu and its `submenu`. */
const open_menu = async (row: HTMLElement, submenu: string): Promise<void> => {
	assert.isTrue(open_contextmenu(row), 'zzz’s menu');
	await open_submenu(submenu);
};

/** A spy on spawning terminals, which records each `cwd` and spawns nothing. */
const spy_terminals = (): Array<string | undefined> => {
	const cwds: Array<string | undefined> = [];
	vi.spyOn(app.terminals, 'create').mockImplementation((json) => {
		cwds.push(json.cwd);
		return Promise.resolve(app.terminals.add(json));
	});
	return cwds;
};

describe('the folder contextmenu', () => {
	test('a folder’s entries, with no rename, move, or delete', async () => {
		write('/w/a/x.md');
		const target = render_tree();
		await open_menu(find_row(target, 'a'), 'folder');
		assert.deepEqual(menuitem_labels(), [
			'folder',
			'new file…',
			'new folder…',
			'open terminal here',
			'expand all below',
			'collapse all below',
			'copy path',
			'copy relative path',
			'copy name'
		]);
		for (const label of menuitem_labels()) {
			assert.notMatch(label, /rename|move|delete/);
		}
	});

	test('a root copies only its path', async () => {
		write('/w/a/x.md');
		const target = render_tree();
		await open_menu(find_row(target, '/w/'), 'folder');
		const copies = menuitem_labels().filter((label) => label.startsWith('copy'));
		assert.deepEqual(copies, ['copy path']);
		await choose_menuitem('copy path');
		assert.deepEqual(copied, ['/w']);
	});

	test('a folder copies its path, its path from the innermost root, and its name', async () => {
		app.scoped_dirs = ['/w/src/'];
		write('/w/src/lib/x.ts', '/w/src/');
		write('/w/README.md');
		const target = render_tree();
		const rows = row_texts(target);
		assert.deepEqual(rows, ['/w/', 'src/lib', 'README.md', '/w/src/', 'lib']);
		// `lib` under the nested root `/w/src/`
		const lib = find_row(target, 'lib');
		for (const label of ['copy path', 'copy relative path', 'copy name']) {
			await open_menu(lib, 'folder');
			await choose_menuitem(label);
		}
		// `src/lib` under `/w/`: relative to the innermost root holding it all the same
		await open_menu(find_row(target, 'src/lib'), 'folder');
		await choose_menuitem('copy relative path');
		assert.deepEqual(copied, ['/w/src/lib', 'lib', 'lib', 'lib']);
	});

	test('open terminal here spawns a shell in the folder and shows the terminals', async () => {
		write('/w/a/x.md');
		const cwds = spy_terminals();
		const target = render_tree();
		await open_menu(find_row(target, 'a'), 'folder');
		await choose_menuitem('open terminal here');
		assert.deepEqual(cwds, ['/w/a']);
		assert.deepEqual(
			navigation.goto.mock.calls.map((call) => call[0]),
			['/terminals']
		);
	});

	test('expand all below and collapse all below', async () => {
		write('/w/a/b/x.md');
		write('/w/a/c/y.md');
		const target = render_tree();
		await open_menu(find_row(target, 'a'), 'folder');
		await choose_menuitem('expand all below');
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'b', 'x.md', 'c', 'y.md']);
		await open_menu(find_row(target, 'a'), 'folder');
		await choose_menuitem('collapse all below');
		assert.deepEqual(row_texts(target), ['/w/', 'a']);
	});
});

describe('expand all below on a large folder', () => {
	const expand_all = async (target: HTMLElement): Promise<void> => {
		await open_menu(find_row(target, 'a/b'), 'folder');
		await choose_menuitem('expand all below');
	};

	test('up to the threshold it expands without asking', async () => {
		write('/w/a/b/x.md');
		const confirm = vi.fn(() => false);
		vi.stubGlobal('confirm', confirm);
		const target = render_tree();
		vi.spyOn(app.diskfiles.editor.tree, 'count_files_below').mockReturnValue(
			EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT
		);
		await expand_all(target);
		assert.deepEqual(confirm.mock.calls, []);
		assert.deepEqual(row_texts(target), ['/w/', 'a/b', 'x.md']);
	});

	test('past it, it asks first, and a no leaves the tree as it was', async () => {
		write('/w/a/b/x.md');
		const answers = [false, true];
		const confirm = vi.fn((_message: string) => answers.shift());
		vi.stubGlobal('confirm', confirm);
		const target = render_tree();
		const count = vi
			.spyOn(app.diskfiles.editor.tree, 'count_files_below')
			.mockReturnValue(EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT + 1);

		await expand_all(target);
		assert.strictEqual(confirm.mock.calls.length, 1);
		assert.include(confirm.mock.calls[0]![0], `${EXPAND_ALL_BELOW_CONFIRM_FILE_COUNT + 1} files`);
		assert.deepEqual(count.mock.calls, [['/w/a/b/']], 'counted from the row’s folder');
		assert.deepEqual(row_texts(target), ['/w/', 'a/b'], 'a no: unchanged');

		await expand_all(target);
		assert.deepEqual(row_texts(target), ['/w/', 'a/b', 'x.md'], 'a yes: expanded');
	});
});

describe('the file contextmenu, toward the tree and the terminals', () => {
	test('a file copies its path, its path from the innermost root, and its name', async () => {
		app.scoped_dirs = ['/w/src/'];
		write('/w/src/lib/x.ts', '/w/src/');
		const target = render();
		const row = target.querySelector<HTMLElement>('[role="button"].menuitem');
		assert.ok(row, 'the list row');
		for (const label of ['copy path', 'copy relative path', 'copy name']) {
			await open_menu(row, 'file');
			await choose_menuitem(label);
		}
		assert.deepEqual(copied, ['/w/src/lib/x.ts', 'lib/x.ts', 'x.ts']);
	});

	test('reveal in tree from a list row shows the tree with the file active', async () => {
		write('/w/a/b/x.md');
		write('/w/c.md');
		const target = render();
		const row = Array.from(target.querySelectorAll<HTMLElement>('[role="button"].menuitem')).find(
			(el) => el.textContent.includes('x.md')
		);
		assert.ok(row, 'the list row');
		await open_menu(row, 'file');
		await choose_menuitem('reveal in tree');
		assert.strictEqual(app.diskfiles.editor.explorer_mode, 'tree');
		assert.deepEqual(row_texts(target), ['/w/', 'a/b', 'x.md', 'c.md']);
		assert.strictEqual(app.diskfiles.editor.tree.active_row?.path, '/w/a/b/x.md');
		assert.strictEqual(active_text(target), 'x.md');
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => [entry.method, entry.input]),
			[['file_reveal', { path: '/w/a/b/x.md' }]]
		);
	});

	test('reveal in tree from a tab switches the explorer to the tree, the file active', async () => {
		const x = write('/w/a/b/x.md');
		write('/w/c.md');
		app.diskfiles.select(x.path, true);
		const tab = app.diskfiles.editor.tabs.by_path.get(x.path);
		assert.ok(tab);
		const target = render(DiskfileTabListitemHarness, { tab });
		const tab_button = target.querySelector<HTMLElement>('.diskfile-tab-button');
		assert.ok(tab_button);
		tab_button.dispatchEvent(
			new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
		);
		flushSync();
		await open_submenu('file');
		await choose_menuitem('reveal in tree');
		assert.strictEqual(app.diskfiles.editor.explorer_mode, 'tree');
		assert.strictEqual(app.diskfiles.editor.tree.active_row?.path, '/w/a/b/x.md');
		assert.isTrue(app.diskfiles.editor.tree.expanded.has('/w/a/'), 'its folders opened');
	});

	test('a file deleted on disk offers no terminal in its folder', async () => {
		const x = write('/w/x.md');
		app.diskfiles.get_editor_state(x).current_content = 'draft';
		app.diskfiles.remove_by_path(x.path);
		assert.isTrue(x.deleted_on_disk);
		const target = render_tree();
		await open_menu(find_row(target, 'x.md'), 'file');
		assert.notInclude(menuitem_labels(), 'open terminal in its folder');
		assert.include(menuitem_labels(), 'copy path');
	});

	test('a tree row offers no reveal in tree', async () => {
		write('/w/x.md');
		const target = render_tree();
		await open_menu(find_row(target, 'x.md'), 'file');
		assert.notInclude(menuitem_labels(), 'reveal in tree');
		assert.include(menuitem_labels(), 'open terminal in its folder');
	});

	test('open terminal in its folder spawns a shell in the file’s folder', async () => {
		write('/w/a/x.md');
		const cwds = spy_terminals();
		const target = render_tree();
		await open_menu(find_row(target, 'a'), 'folder');
		await choose_menuitem('expand all below');
		await open_menu(find_row(target, 'x.md'), 'file');
		await choose_menuitem('open terminal in its folder');
		assert.deepEqual(cwds, ['/w/a']);
		assert.deepEqual(
			navigation.goto.mock.calls.map((call) => call[0]),
			['/terminals']
		);
	});
});
