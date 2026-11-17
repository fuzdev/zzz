// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath } from '#lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	ResizeObserverStub,
	mount_explorer,
	mount_tree,
	stub_layout,
	write_diskfile,
	type MountedExplorer,
	active_text,
	click,
	find_row,
	menuitem_labels,
	mode_button,
	open_contextmenu,
	press,
	row_texts,
	tree_el
} from './diskfile_tree_test_helpers.ts';

/**
 * The file explorer's tree mode, driven as a user would: the mode switch in
 * the header, then the tree by keyboard and pointer.
 */

let app: Frontend;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/w/';
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const write = (path: string): Diskfile => write_diskfile(app, path);
const render = (): MountedExplorer => mount_explorer(app, cleanups);
const render_tree = (): MountedExplorer => mount_tree(app, cleanups);

describe('the mode switch', () => {
	test('switches the list to the tree and back, and the sort toggle is the list’s', () => {
		write('/w/a.md');
		write('/w/b.md');
		const { target } = render();
		const button = mode_button(target);
		assert.strictEqual(button.getAttribute('aria-pressed'), 'false');
		assert.isNull(target.querySelector('[role="tree"]'));
		assert.ok(target.querySelector('button[title="toggle sort controls"]'));

		button.click();
		flushSync();
		assert.strictEqual(app.diskfiles.editor.explorer_mode, 'tree');
		assert.strictEqual(button.getAttribute('aria-pressed'), 'true');
		assert.ok(tree_el(target));
		assert.isNull(target.querySelector('button[title="toggle sort controls"]'));
		assert.ok(target.querySelector('button[aria-label="collapse all folders"]'));

		button.click();
		flushSync();
		assert.strictEqual(app.diskfiles.editor.explorer_mode, 'list');
		assert.isNull(target.querySelector('[role="tree"]'));
	});

	test('the mode is serialized with the editor', () => {
		app.diskfiles.editor.toggle_explorer_mode();
		assert.strictEqual(app.diskfiles.editor.to_json().explorer_mode, 'tree');
	});

	test('the expanded folders survive a switch to the list and back, and a remount', () => {
		write('/w/a/x.md');
		write('/w/b/y.md');
		const first = render_tree();
		click(find_row(first.target, 'a'));
		assert.deepEqual(row_texts(first.target), ['/w/', 'a', 'x.md', 'b']);

		mode_button(first.target).click();
		flushSync();
		mode_button(first.target).click();
		flushSync();
		assert.deepEqual(row_texts(first.target), ['/w/', 'a', 'x.md', 'b']);

		first.destroy();
		const second = render();
		assert.deepEqual(row_texts(second.target), ['/w/', 'a', 'x.md', 'b']);
	});

	test('collapse all collapses everything', () => {
		write('/w/a/x.md');
		const { target } = render_tree();
		click(find_row(target, 'a'));
		target.querySelector<HTMLButtonElement>('button[aria-label="collapse all folders"]')!.click();
		flushSync();
		assert.deepEqual(row_texts(target), ['/w/']);
	});
});

describe('the tree’s ARIA', () => {
	test('rows carry their level, position, expansion, and selection', () => {
		write('/w/a/x.md');
		const b = write('/w/b.md');
		app.diskfiles.select(b.path);
		const { target } = render_tree();
		click(find_row(target, 'a'));
		const attrs = Array.from(target.querySelectorAll('[role="treeitem"]')).map((el) =>
			['aria-level', 'aria-posinset', 'aria-setsize', 'aria-expanded', 'aria-selected'].map(
				(name) => el.getAttribute(name)
			)
		);
		assert.deepEqual(attrs, [
			['1', '1', '1', 'true', 'false'],
			['2', '1', '2', 'true', 'false'],
			['3', '1', '1', null, 'false'],
			['2', '2', '2', null, 'true']
		]);
		assert.strictEqual(tree_el(target).getAttribute('tabindex'), '0');
	});

	test('a file row marks unsaved and deleted files, past its truncating name', () => {
		const a = write('/w/a.md');
		app.diskfiles.get_editor_state(a).current_content = 'draft';
		app.diskfiles.remove_by_path(parse_or_throw(DiskfilePath, '/w/a.md'));
		const { target } = render_tree();
		const row = find_row(target, 'a.md');
		assert.strictEqual(row.getAttribute('aria-label'), 'a.md, deleted on disk, unsaved changes');
		const truncating = Array.from(row.querySelectorAll('.ellipsis'));
		assert.deepEqual(
			truncating.map((el) => el.textContent.trim()),
			['a.md']
		);
		for (const marker of ['●', '(deleted)']) {
			const el = Array.from(row.querySelectorAll('[aria-hidden="true"]')).find(
				(e) => e.textContent.trim() === marker
			);
			assert.ok(el, `shows ${marker}`);
			assert.isNull(el.closest('.ellipsis'), `${marker} is outside the truncation`);
		}
	});

	test('file rows have the file contextmenu, folder and root rows the folder one', () => {
		write('/w/a/x.md');
		write('/w/b.md');
		const { target } = render_tree();
		assert.isTrue(open_contextmenu(find_row(target, 'b.md')), 'a file');
		assert.deepEqual(menuitem_labels(), ['file', 'view']);
		assert.isTrue(open_contextmenu(find_row(target, 'a')), 'a folder');
		assert.deepEqual(menuitem_labels(), ['folder'], 'only its own entries, no other row’s');
		assert.isTrue(open_contextmenu(find_row(target, '/w/')), 'a root');
		assert.deepEqual(menuitem_labels(), ['folder']);
	});
});

describe('the tree’s keyboard', () => {
	test('arrows move and expand, enter opens a file for good, space previews', () => {
		write('/w/a/x.md');
		const b = write('/w/b.md');
		const x = app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/w/a/x.md'))!;
		const { target } = render_tree();
		const { tabs } = app.diskfiles.editor;

		tree_el(target).focus();
		flushSync();
		assert.strictEqual(active_text(target), '/w/', 'focus starts at the first row');

		press(target, 'ArrowDown');
		assert.strictEqual(active_text(target), 'a');
		press(target, 'ArrowRight');
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'x.md', 'b.md'], 'right expands');
		press(target, 'ArrowRight');
		assert.strictEqual(active_text(target), 'x.md', 'right again moves in');

		press(target, ' ');
		assert.strictEqual(app.diskfiles.selected_path, x.path);
		assert.isTrue(tabs.by_path.get(x.path)?.is_preview, 'space previews');

		press(target, 'End');
		assert.strictEqual(active_text(target), 'b.md');
		press(target, 'Enter');
		assert.strictEqual(app.diskfiles.selected_path, b.path);
		assert.isFalse(tabs.by_path.get(b.path)?.is_preview, 'enter opens it for good');

		press(target, 'Home');
		assert.strictEqual(active_text(target), '/w/');
		press(target, 'ArrowLeft');
		assert.deepEqual(row_texts(target), ['/w/'], 'left collapses');
		press(target, 'Enter');
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'x.md', 'b.md'], 'enter toggles a folder');
	});

	test('the menu key opens the active row’s menu: a file’s, a folder’s, a root’s', () => {
		write('/w/a/x.md');
		write('/w/b.md');
		const { target } = render_tree();
		const menu_key = (): boolean => {
			// the ContextMenu key and Shift+F10 fire on the focused element: the tree
			const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
			tree_el(target).dispatchEvent(event);
			flushSync();
			return event.defaultPrevented;
		};

		tree_el(target).focus();
		flushSync();
		assert.strictEqual(active_text(target), '/w/');
		assert.isTrue(menu_key(), 'a root');
		assert.deepEqual(menuitem_labels(), ['folder']);

		press(target, 'ArrowDown');
		assert.strictEqual(active_text(target), 'a');
		assert.isTrue(menu_key(), 'a folder');
		assert.deepEqual(menuitem_labels(), ['folder']);

		press(target, 'End');
		assert.strictEqual(active_text(target), 'b.md');
		assert.isTrue(menu_key());
		assert.deepEqual(menuitem_labels(), ['file', 'view'], 'the file menu');
	});

	test('it claims only the keys it handles, unmodified', () => {
		write('/w/a.md');
		const { target } = render_tree();
		const dispatch = (init: KeyboardEventInit): boolean => {
			const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
			tree_el(target).dispatchEvent(event);
			flushSync();
			return event.defaultPrevented;
		};
		assert.isTrue(dispatch({ key: 'ArrowDown' }));
		assert.isFalse(dispatch({ key: 'ArrowDown', ctrlKey: true }));
		assert.isFalse(dispatch({ key: 'q' }));
	});
});

describe('the tree’s pointer', () => {
	test('a click previews a file and a double click opens it', () => {
		const a = write('/w/a.md');
		const { target } = render_tree();
		const { tabs } = app.diskfiles.editor;
		click(find_row(target, 'a.md'));
		assert.strictEqual(app.diskfiles.selected_path, a.path);
		assert.isTrue(tabs.by_path.get(a.path)?.is_preview);
		assert.strictEqual(active_text(target), 'a.md', 'and makes it active');

		click(find_row(target, 'a.md'), 2);
		assert.isFalse(tabs.by_path.get(a.path)?.is_preview);
	});

	test('a click toggles a folder, and a double click toggles it once', () => {
		write('/w/a/x.md');
		const { target } = render_tree();
		click(find_row(target, 'a'));
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'x.md']);
		click(find_row(target, 'a'));
		assert.deepEqual(row_texts(target), ['/w/', 'a']);

		click(find_row(target, 'a'));
		click(find_row(target, 'a'), 2);
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'x.md']);
	});

	test('a chain of single folders is one row', () => {
		write('/w/a/b/c/x.md');
		const { target } = render_tree();
		click(find_row(target, 'a/b/c'));
		assert.deepEqual(row_texts(target), ['/w/', 'a/b/c', 'x.md']);
	});
});

describe('the tree’s window', () => {
	test('focus by Tab starts at the first row on screen, not the top', () => {
		for (let i = 0; i < 40; i++) write(`/w/f${i}.md`);
		stub_layout(200); // scrolled past the first 10 rows
		const { target } = render_tree();
		tree_el(target).focus();
		flushSync();
		assert.strictEqual(app.diskfiles.editor.tree.active_index, 10);
		assert.strictEqual(active_text(target), 'f9.md', 'row 10: the root, then f0…');
	});

	test('a reveal made before the tree mounts scrolls to its row once it does', () => {
		for (let i = 0; i < 40; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const { target } = render();
		assert.isTrue(app.diskfiles.editor.tree.reveal('/w/f39.md'), 'in list mode');
		assert.deepEqual(layout.scroll_calls, []);

		mode_button(target).click();
		flushSync();
		// row 40's bottom, 820px, past the 768px window by 52
		assert.deepEqual(layout.scroll_calls, [52]);
		assert.strictEqual(active_text(target), 'f39.md');
	});

	test('the menu key on an active row scrolled out of the window opens that row’s menu', () => {
		for (let i = 0; i < 100; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const { target } = render_tree();
		tree_el(target).focus();
		press(target, 'End');
		assert.strictEqual(active_text(target), 'f99.md');

		// the user scrolls back to the top: the active row leaves the window
		layout.scrolled = 0;
		window.dispatchEvent(new Event('scroll'));
		flushSync();
		assert.isNull(tree_el(target).getAttribute('aria-activedescendant'));

		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		tree_el(target).dispatchEvent(event);
		flushSync();
		assert.isTrue(event.defaultPrevented);
		assert.strictEqual(active_text(target), 'f99.md', 'scrolled back into the window');
		assert.isTrue(
			Array.from(document.querySelectorAll('[role="menuitem"]')).some(
				(el) => el.textContent.trim() === 'file'
			)
		);
	});

	test('renders only the rows near the view', () => {
		for (let i = 0; i < 40; i++) write(`/w/f${i}.md`);
		const { target } = render_tree();
		const rendered = row_texts(target);
		// unmeasured (jsdom has no layout), the window is its overscan from the top
		assert.isBelow(rendered.length, 41);
		assert.deepEqual(rendered.slice(0, 3), ['/w/', 'f0.md', 'f1.md'], 'in natural order');

		// the active row out of the window names no descendant
		press(target, 'End');
		assert.strictEqual(app.diskfiles.editor.tree.active_row?.label, 'f39.md');
		assert.isNull(tree_el(target).getAttribute('aria-activedescendant'));
	});
});
