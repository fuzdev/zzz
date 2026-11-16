// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { SerializableDisknode } from '#lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	ResizeObserverStub,
	click,
	mode_button,
	mount_tree,
	stub_layout,
	write_diskfile,
	choose_menuitem,
	find_row,
	open_contextmenu,
	open_submenu,
	press,
	row_texts,
	tree_el
} from './diskfile_tree_test_helpers.ts';

/**
 * The file tree's inline create, driven as a user would: started from a
 * folder's menu or the explorer's header, named in the input, committed or
 * cancelled from the keyboard or by leaving it.
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

const write = (path: string, source_dir?: string): Diskfile =>
	write_diskfile(app, path, source_dir);
const render_tree = (): HTMLElement => mount_tree(app, cleanups).target;

const tick = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

/** Starts a create from `row`'s folder menu, returning the input. */
const start = async (
	target: HTMLElement,
	row: string,
	entry: 'new file…' | 'new folder…'
): Promise<HTMLInputElement> => {
	assert.isTrue(open_contextmenu(find_row(target, row)));
	await open_submenu('folder');
	await choose_menuitem(entry);
	return create_input(target);
};

const create_input = (target: HTMLElement): HTMLInputElement => {
	const input = target.querySelector<HTMLInputElement>('[role="tree"] input');
	assert.ok(input, 'the inline input');
	return input;
};

const type = (input: HTMLInputElement, value: string): void => {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

/** A refused commit's reason, announced at once. */
const alert_text = (target: HTMLElement): string | undefined =>
	target.querySelector('[role="tree"] [role="alert"]')?.textContent.trim();

/**
 * A name's problem as it's typed, in the polite region — `undefined` when it's empty or holds a
 * refused commit's alert. The region itself is always there, never hidden.
 */
const polite_text = (target: HTMLElement): string | undefined => {
	const region = target.querySelector<HTMLElement>('[role="tree"] [aria-live="polite"]');
	assert.ok(region, 'the polite region, always present');
	assert.isFalse(region.hidden);
	if (region.querySelector('[role="alert"]')) return undefined;
	return region.textContent.trim() || undefined;
};

const spy_create_file = () =>
	vi.spyOn(app.diskfiles, 'create_file_at').mockImplementation(() => Promise.resolve());

describe('the inline create', () => {
	test('new file… shows a focused input as the folder’s first child; Enter creates there', async () => {
		write('/w/a/x.md');
		const create_file_at = spy_create_file();
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		assert.deepEqual(row_texts(target), ['/w/', 'a', '', 'x.md']);
		assert.strictEqual(document.activeElement, input);
		assert.strictEqual(input.getAttribute('aria-label'), 'new file name in /w/a/');

		type(input, 'new.md');
		assert.isTrue(press(target, 'Enter', input));
		await tick();
		assert.deepEqual(
			create_file_at.mock.calls.map((call) => call[0]),
			['/w/a/new.md']
		);
		assert.isNull(target.querySelector('[role="tree"] input'), 'the input is gone');
		assert.strictEqual(document.activeElement, tree_el(target), 'focus is back on the tree');
	});

	test('Escape cancels, creating nothing', async () => {
		write('/w/a/x.md');
		const create_file_at = spy_create_file();
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		type(input, 'new.md');
		assert.isTrue(press(target, 'Escape', input));
		await tick();
		assert.deepEqual(create_file_at.mock.calls, []);
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'x.md']);
		assert.strictEqual(document.activeElement, tree_el(target));
		assert.strictEqual(app.diskfiles.editor.tree.active_row?.path, '/w/a/');
	});

	test('a name’s problem shows politely as it’s typed, a refused commit’s at once', async () => {
		write('/w/a/x.md');
		const create_file_at = spy_create_file();
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		assert.isUndefined(polite_text(target), 'nothing while empty');

		type(input, 'sub/');
		assert.isUndefined(polite_text(target), 'a trailing slash is a name on its way');
		assert.strictEqual(input.getAttribute('aria-invalid'), 'false');

		type(input, '../x.md');
		assert.include(polite_text(target), 'must stay inside the directory');
		assert.isUndefined(alert_text(target), 'not an alert while typing');
		assert.strictEqual(input.getAttribute('aria-invalid'), 'true');
		const described_by = input.getAttribute('aria-describedby');
		assert.ok(described_by);
		assert.include(document.getElementById(described_by)?.textContent, 'must stay inside');

		type(input, 'sub/');
		press(target, 'Enter', input);
		await tick();
		assert.include(alert_text(target), 'file name must end with a file name');
		assert.deepEqual(create_file_at.mock.calls, []);
		assert.strictEqual(document.activeElement, input, 'the input stays, focused');

		type(input, 'sub/ok.md');
		assert.isUndefined(alert_text(target));
		assert.isUndefined(polite_text(target));
		assert.strictEqual(input.getAttribute('aria-invalid'), 'false');
	});

	test('a failed create shows the backend’s reason and keeps the input', async () => {
		write('/w/a/x.md');
		vi.spyOn(app.diskfiles, 'create_file_at').mockImplementation(() =>
			Promise.reject(new Error('already exists'))
		);
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		type(input, 'x.md');
		press(target, 'Enter', input);
		await tick();
		assert.strictEqual(alert_text(target), 'already exists');
		assert.strictEqual(create_input(target), input);
		assert.strictEqual(document.activeElement, input);

		type(input, 'y.md');
		assert.isUndefined(alert_text(target), 'typing clears it');
	});

	test('the tree leaves the input’s keys and clicks to it', async () => {
		write('/w/a/x.md');
		write('/w/b.md');
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		const tree = app.diskfiles.editor.tree;
		const active = tree.active_key;
		const rows = row_texts(target);
		for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ']) {
			assert.isFalse(press(target, key, input), `${key} is the input’s`);
		}
		assert.strictEqual(tree.active_key, active);
		assert.deepEqual(row_texts(target), rows);

		const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
		input.dispatchEvent(click);
		flushSync();
		assert.isFalse(click.defaultPrevented);
		assert.strictEqual(create_input(target), input);
	});

	test('leaving the input creates a valid name, and drops a blank one', async () => {
		write('/w/a/x.md');
		const create_file_at = spy_create_file();
		const target = render_tree();
		const header_button = target.querySelector<HTMLButtonElement>(
			'button[aria-label="collapse all folders"]'
		)!;

		let input = await start(target, 'a', 'new file…');
		header_button.focus();
		await tick();
		assert.deepEqual(create_file_at.mock.calls, [], 'blank: nothing');
		assert.isNull(target.querySelector('[role="tree"] input'));

		input = await start(target, 'a', 'new file…');
		type(input, 'sub/');
		header_button.focus();
		await tick();
		assert.deepEqual(create_file_at.mock.calls, [], 'refused: nothing');
		assert.isNull(target.querySelector('[role="tree"] input'));

		input = await start(target, 'a', 'new file…');
		type(input, 'left.md');
		header_button.focus();
		await tick();
		assert.deepEqual(
			create_file_at.mock.calls.map((call) => call[0]),
			['/w/a/left.md']
		);
		assert.isNull(target.querySelector('[role="tree"] input'));
		assert.strictEqual(document.activeElement, header_button, 'focus stays where it went');
	});

	test('new folder… creates the folder, which shows though empty, expanded', async () => {
		write('/w/a/x.md');
		const create_directory_at = vi
			.spyOn(app.diskfiles, 'create_directory_at')
			.mockImplementation(() => Promise.resolve());
		const target = render_tree();
		const input = await start(target, 'a', 'new folder…');
		assert.strictEqual(input.getAttribute('aria-label'), 'new folder name in /w/a/');
		type(input, 'p/q');
		press(target, 'Enter', input);
		await tick();
		assert.deepEqual(
			create_directory_at.mock.calls.map((call) => call[0]),
			['/w/a/p/q']
		);
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'p/q', 'x.md']);
		const row = find_row(target, 'p/q');
		assert.strictEqual(row.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(app.diskfiles.editor.tree.active_row?.path, '/w/a/p/q/');
	});

	test('in the tree, the header’s create buttons name the file inline in the workspace', async () => {
		app.workspaces.add({ path: parse_or_throw(SerializableDisknode.def.source_dir, '/ws/') });
		write('/ws/a.md', '/ws/');
		const create_file_at = spy_create_file();
		const target = render_tree();
		target.querySelector<HTMLButtonElement>('button[title="create file in /ws/"]')!.click();
		flushSync();
		const input = create_input(target);
		assert.strictEqual(input.getAttribute('aria-label'), 'new file name in /ws/');
		assert.strictEqual(document.activeElement, input);
		assert.deepEqual(row_texts(target), ['/w/', '/ws/', '', 'a.md']);
		type(input, 'b.md');
		press(target, 'Enter', input);
		await tick();
		assert.deepEqual(
			create_file_at.mock.calls.map((call) => call[0]),
			['/ws/b.md']
		);
	});

	test('leaving after the backend refused the name drops it, not sending it again', async () => {
		write('/w/a/x.md');
		const create_file_at = vi
			.spyOn(app.diskfiles, 'create_file_at')
			.mockImplementation(() => Promise.reject(new Error('already exists')));
		const target = render_tree();
		const header_button = target.querySelector<HTMLButtonElement>(
			'button[aria-label="collapse all folders"]'
		)!;
		const input = await start(target, 'a', 'new file…');
		type(input, 'x.md');
		press(target, 'Enter', input);
		await tick();
		assert.strictEqual(alert_text(target), 'already exists');

		header_button.focus();
		await tick();
		assert.strictEqual(create_file_at.mock.calls.length, 1, 'sent once');
		assert.isNull(target.querySelector('[role="tree"] input'), 'dropped');
		assert.isUndefined(alert_text(target), 'its box with it');
	});

	test('a create resolving after the user moved focus on leaves focus there', async () => {
		write('/w/a/x.md');
		let resolve_create = (): void => {};
		vi.spyOn(app.diskfiles, 'create_file_at').mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolve_create = resolve;
				})
		);
		const target = render_tree();
		const header_button = target.querySelector<HTMLButtonElement>(
			'button[aria-label="collapse all folders"]'
		)!;
		const input = await start(target, 'a', 'new file…');
		type(input, 'slow.md');
		press(target, 'Enter', input);
		header_button.focus();
		await tick();
		resolve_create();
		await tick();
		assert.isNull(target.querySelector('[role="tree"] input'));
		assert.strictEqual(document.activeElement, header_button, 'not pulled back to the tree');
	});

	test('a create the index skips says so in a note that stays through clicks', async () => {
		write('/w/a/x.md');
		const y = write('/w/a/y.md');
		spy_create_file();
		const target = render_tree();
		const status = (): HTMLElement => {
			const el = target.querySelector<HTMLElement>('[role="status"]');
			assert.ok(el, 'the status region, always present');
			assert.isFalse(el.hidden, 'never hidden, so it stays in the accessibility tree');
			return el;
		};
		const note = (): string | undefined => status().querySelector('small')?.textContent.trim();
		assert.isUndefined(note());

		let input = await start(target, 'a', 'new file…');
		type(input, 'node_modules/x.js');
		press(target, 'Enter', input);
		await tick();
		assert.strictEqual(
			note(),
			'created a/node_modules/x.js, which the tree doesn’t show: the file index skips "node_modules"'
		);
		// a file named like an ignored folder is skipped too
		input = await start(target, 'a', 'new file…');
		type(input, 'dist');
		press(target, 'Enter', input);
		await tick();
		assert.include(note(), 'skips "dist"');

		// a double click on a file: the note stays, so the rows don't shift between its clicks
		click(find_row(target, 'y.md'));
		click(find_row(target, 'y.md'), 2);
		assert.include(note(), 'skips "dist"');
		assert.isFalse(app.diskfiles.editor.tabs.by_diskfile_id.get(y.id)?.is_preview);

		status().querySelector<HTMLButtonElement>('button')!.click();
		flushSync();
		assert.isUndefined(note(), 'dismissed');

		input = await start(target, 'a', 'new file…');
		type(input, '.git');
		press(target, 'Enter', input);
		await tick();
		assert.ok(note());
		press(target, 'ArrowDown');
		assert.isUndefined(note(), 'cleared by a key in the tree');
	});

	test('switching to the list ends an open input', async () => {
		write('/w/a/x.md');
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		type(input, 'later.md');
		mode_button(target).click();
		flushSync();
		assert.isNull(app.diskfiles.editor.tree.creating);
		mode_button(target).click();
		flushSync();
		assert.isNull(target.querySelector('[role="tree"] input'), 'not back with the tree');
	});

	test('an input scrolled out and back takes focus again — unless focus moved on meanwhile', async () => {
		write('/w/a/x.md');
		for (let i = 0; i < 60; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const target = render_tree();
		const header_button = target.querySelector<HTMLButtonElement>(
			'button[aria-label="collapse all folders"]'
		)!;
		const scroll_to = (y: number): void => {
			layout.scrolled = y;
			window.dispatchEvent(new Event('scroll'));
			flushSync();
		};

		let input = await start(target, 'a', 'new file…');
		type(input, 'kept.md');
		scroll_to(1000);
		assert.isNull(target.querySelector('[role="tree"] input'), 'scrolled out, unmounted');
		scroll_to(0);
		input = create_input(target);
		assert.strictEqual(document.activeElement, input, 'focus lost: it takes it again');
		assert.strictEqual(input.value, 'kept.md');

		scroll_to(1000);
		header_button.focus();
		scroll_to(0);
		assert.isNull(app.diskfiles.editor.tree.creating, 'focus moved on: it ends');
		assert.isNull(target.querySelector('[role="tree"] input'));
		assert.strictEqual(document.activeElement, header_button);
	});

	test('an input whose folder stops showing is dropped, not left to come back', async () => {
		write('/w/a/x.md');
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		type(input, 'later.md');
		// collapsing its folder from the code, with focus still in the input
		app.diskfiles.editor.tree.collapse_all();
		flushSync();
		assert.isNull(app.diskfiles.editor.tree.creating);
		const root_row = app.diskfiles.editor.tree.rows[0];
		assert.ok(root_row?.kind === 'root');
		app.diskfiles.editor.tree.expand_all_below(root_row);
		flushSync();
		assert.isNull(target.querySelector('[role="tree"] input'), 'it doesn’t reappear');
	});

	test('a second create in the same folder gets a fresh, focused input', async () => {
		app.workspaces.add({ path: parse_or_throw(SerializableDisknode.def.source_dir, '/ws/') });
		write('/ws/a.md', '/ws/');
		const target = render_tree();
		target.querySelector<HTMLButtonElement>('button[title="create file in /ws/"]')!.click();
		flushSync();
		const first = create_input(target);
		type(first, 'half');
		const folder_button = target.querySelector<HTMLButtonElement>(
			'button[title="create folder in /ws/"]'
		)!;
		folder_button.focus();
		folder_button.click();
		flushSync();
		const second = create_input(target);
		assert.strictEqual(second.getAttribute('aria-label'), 'new folder name in /ws/');
		assert.strictEqual(document.activeElement, second, 'focused, not left on the button');
		assert.strictEqual(second.value, '');
		assert.isFalse(app.diskfiles.editor.tree.creating!.focus_pending);
	});

	test('dismissing the note puts focus on the tree, not the page', async () => {
		write('/w/a/x.md');
		spy_create_file();
		const target = render_tree();
		const input = await start(target, 'a', 'new file…');
		type(input, 'dist');
		press(target, 'Enter', input);
		await tick();
		const dismiss = target.querySelector<HTMLButtonElement>('[role="status"] button');
		assert.ok(dismiss);
		dismiss.focus();
		dismiss.click();
		flushSync();
		assert.isNull(target.querySelector('[role="status"] button'));
		assert.strictEqual(document.activeElement, tree_el(target));
	});

	test('the note coming and going moves the rows, and the tree measures them again', () => {
		for (let i = 0; i < 40; i++) write(`/w/f${i}.md`);
		const layout = stub_layout(200); // scrolled past the first 10 rows
		const target = render_tree();
		const { tree } = app.diskfiles.editor;
		// the note pushes the rows 2 down, so 8 rows are past the top, not 10
		layout.offset = 2 * 20;
		tree.notice = 'a note';
		flushSync();
		tree_el(target).focus();
		flushSync();
		assert.strictEqual(tree.active_index, 8, 'focus starts at the first row on screen');
		// and going, the rows move back up: 10 past the top again
		tree_el(target).blur();
		layout.offset = 0;
		tree.notice = null;
		tree.active_key = null;
		flushSync();
		tree_el(target).focus();
		flushSync();
		assert.strictEqual(tree.active_index, 10, 'measured again as the note goes');
	});
});
