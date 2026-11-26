// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { allow_logged_error } from '@fuzdev/fuz_app/testing/logged_errors.ts';
import { flushSync } from 'svelte';
import { create_deferred, type Deferred, wait } from '@fuzdev/fuz_util/async.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import type { DiskfilePath } from '#lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	ResizeObserverStub,
	active_text,
	choose_menuitem,
	click,
	find_row,
	mode_button,
	mount_tree,
	open_contextmenu,
	open_submenu,
	press,
	row_texts,
	stub_layout,
	tree_el,
	write_diskfile
} from './diskfile_tree_test_helpers.ts';

/**
 * The file tree's inline rename, driven as a user would: started by F2 or a
 * file row's "rename file", named in the input that replaces the row,
 * committed or cancelled from the keyboard or by leaving it — through the
 * real `file_rename` intent, the daemon's `diskfile_rename` faked.
 */

type RenameReply =
	| { ok: true; value: { renamed: Array<{ path: string; new_path: string }> } }
	| { ok: false; error: { code: number; message: string } };

let app: Frontend;
let calls: Array<{ path: string; name: string }>;
let reply: Deferred<RenameReply> | null;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/w/';
	calls = [];
	reply = null;
	// the daemon moves the file as asked, unless a test holds the reply
	const diskfile_rename = (input: { path: string; name: string }): Promise<RenameReply> => {
		calls.push(input);
		if (reply) return reply.promise;
		const dir = input.path.slice(0, input.path.lastIndexOf('/') + 1);
		return Promise.resolve(moved(input.path, dir + input.name));
	};
	// the rpc client is a proxy, so it's wrapped, its other methods left as they are
	const { api } = app;
	(app as unknown as { api: unknown }).api = new Proxy(api, {
		get: (target, key) =>
			key === 'diskfile_rename' ? diskfile_rename : Reflect.get(target, key, target)
	});
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const moved = (path: string, new_path: string): RenameReply => ({
	ok: true,
	value: { renamed: [{ path, new_path }] }
});

const write = (path: string): Diskfile => write_diskfile(app, path);
const render_tree = (): HTMLElement => mount_tree(app, cleanups).target;

const tick = async (): Promise<void> => {
	await wait();
	flushSync();
};

const name_input = (target: HTMLElement): HTMLInputElement | null =>
	target.querySelector<HTMLInputElement>('[role="tree"] input');

const rename_input = (target: HTMLElement): HTMLInputElement => {
	const input = name_input(target);
	assert.ok(input, 'the inline input');
	return input;
};

const type = (input: HTMLInputElement, value: string): void => {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

/** Makes the row showing `text` active, from the tree's keyboard, and presses F2 there. */
const press_f2_on = (target: HTMLElement, text: string): HTMLInputElement => {
	tree_el(target).focus();
	const tree = app.diskfiles.editor.tree;
	const index = row_texts(target).indexOf(text);
	assert.notStrictEqual(index, -1, `a "${text}" row`);
	tree.active_key = tree.rows[index]!.key;
	flushSync();
	assert.strictEqual(active_text(target), text);
	assert.isTrue(press(target, 'F2'), 'F2 is the tree’s');
	return rename_input(target);
};

const selected_text = (input: HTMLInputElement): string =>
	input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);

const alert_text = (target: HTMLElement): string | undefined =>
	target.querySelector('[role="tree"] [role="alert"]')?.textContent.trim();

const polite_text = (target: HTMLElement): string | undefined => {
	const region = target.querySelector<HTMLElement>('[role="tree"] [aria-live="polite"]');
	assert.ok(region, 'the polite region, always present');
	if (region.querySelector('[role="alert"]')) return undefined;
	return region.textContent.trim() || undefined;
};

const renamed_intents = (): Array<unknown> =>
	app.recent_intents.entries
		.filter((entry) => entry.method === 'file_rename')
		.map((entry) => [entry.input, entry.outcome]);

describe('the inline rename', () => {
	test('F2 replaces the file’s row with its name, the stem selected; Enter renames it', async () => {
		write('/w/a/notes.md');
		write('/w/a/z.md');
		const target = render_tree();
		app.diskfiles.editor.tree.reveal('/w/a/notes.md');
		flushSync();
		const input = press_f2_on(target, 'notes.md');
		assert.deepEqual(row_texts(target), ['/w/', 'a', '', 'z.md'], 'in place, not added');
		assert.strictEqual(document.activeElement, input);
		assert.strictEqual(input.value, 'notes.md');
		assert.strictEqual(selected_text(input), 'notes', 'the name before its extension');
		assert.strictEqual(input.getAttribute('aria-label'), 'new name for notes.md');
		const item = input.closest('[role="treeitem"]')!;
		assert.strictEqual(item.getAttribute('aria-posinset'), '1', 'its place among its siblings');
		assert.strictEqual(item.getAttribute('aria-setsize'), '2');

		type(input, 'zz.md');
		assert.isTrue(press(target, 'Enter', input));
		await tick();
		assert.deepEqual(calls, [{ path: '/w/a/notes.md', name: 'zz.md' }]);
		assert.deepEqual(renamed_intents(), [[{ path: '/w/a/notes.md', name: 'zz.md' }, 'applied']]);
		assert.isNull(name_input(target), 'the input is gone');
		assert.deepEqual(row_texts(target), ['/w/', 'a', 'z.md', 'zz.md'], 'sorted at its new name');
		assert.strictEqual(active_text(target), 'zz.md', 'the keyboard stays on it');
		assert.strictEqual(document.activeElement, tree_el(target), 'focus is back on the tree');
	});

	test('a dotfile’s whole name is selected; a double extension keeps its last', () => {
		write('/w/.env');
		write('/w/a.tar.gz');
		const target = render_tree();
		assert.strictEqual(selected_text(press_f2_on(target, '.env')), '.env');
		press(target, 'Escape', rename_input(target));
		assert.strictEqual(selected_text(press_f2_on(target, 'a.tar.gz')), 'a.tar');
	});

	test('the tree row’s "rename file" renames inline, never by a prompt', async () => {
		write('/w/a.md');
		const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => 'never.md');
		const target = render_tree();
		assert.isTrue(open_contextmenu(find_row(target, 'a.md')));
		await open_submenu('file');
		await choose_menuitem('rename file');
		const input = rename_input(target);
		assert.strictEqual(document.activeElement, input);
		assert.strictEqual(prompt.mock.calls.length, 0);
		type(input, 'b.md');
		press(target, 'Enter', input);
		await tick();
		assert.deepEqual(calls, [{ path: '/w/a.md', name: 'b.md' }]);
		assert.deepEqual(row_texts(target), ['/w/', 'b.md']);
	});

	test('the list’s "rename file" still prompts', async () => {
		write('/w/a.md');
		const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => ' b.md ');
		const target = render_tree();
		mode_button(target).click();
		flushSync();
		const row = Array.from(target.querySelectorAll<HTMLElement>('.menuitem')).find((el) =>
			el.textContent.includes('a.md')
		);
		assert.ok(row, 'the list’s row');
		assert.isTrue(open_contextmenu(row));
		await open_submenu('file');
		await choose_menuitem('rename file');
		await tick();
		assert.strictEqual(prompt.mock.calls.length, 1);
		assert.deepEqual(calls, [{ path: '/w/a.md', name: 'b.md' }], 'the name trimmed');
	});

	test('Escape cancels, renaming nothing, the keyboard still on the file', () => {
		write('/w/a.md');
		const target = render_tree();
		const input = press_f2_on(target, 'a.md');
		type(input, 'b.md');
		assert.isTrue(press(target, 'Escape', input));
		assert.deepEqual(calls, []);
		assert.isNull(name_input(target));
		assert.deepEqual(row_texts(target), ['/w/', 'a.md']);
		assert.strictEqual(active_text(target), 'a.md');
		assert.strictEqual(document.activeElement, tree_el(target));
	});

	test('Enter on the name unchanged, or blank, ends it sending nothing', async () => {
		write('/w/a.md');
		const target = render_tree();
		let input = press_f2_on(target, 'a.md');
		press(target, 'Enter', input);
		await tick();
		assert.isNull(name_input(target));

		input = press_f2_on(target, 'a.md');
		type(input, '  a.md ');
		press(target, 'Enter', input);
		await tick();
		assert.isNull(name_input(target), 'its own name, once trimmed');

		input = press_f2_on(target, 'a.md');
		type(input, '');
		press(target, 'Enter', input);
		await tick();
		assert.isNull(name_input(target));
		assert.deepEqual(calls, []);
	});

	test('a name holding a separator is refused as typed, and at once on Enter', async () => {
		write('/w/a.md');
		const target = render_tree();
		const input = press_f2_on(target, 'a.md');
		type(input, 'sub/b.md');
		assert.include(polite_text(target), 'a rename stays in its folder');
		assert.isUndefined(alert_text(target));
		press(target, 'Enter', input);
		await tick();
		assert.include(alert_text(target), 'a rename stays in its folder');
		assert.strictEqual(document.activeElement, input, 'the input keeps focus');
		assert.deepEqual(calls, []);
		type(input, '..');
		assert.include(polite_text(target), 'must not be ".."');
	});

	test('the daemon’s refusal shows at once and keeps the input', async () => {
		write('/w/a.md');
		write('/w/b.md');
		const target = render_tree();
		reply = create_deferred();
		const input = press_f2_on(target, 'a.md');
		type(input, 'b.md');
		press(target, 'Enter', input);
		flushSync();
		assert.isTrue(input.readOnly, 'read-only while in flight');
		assert.strictEqual(input.getAttribute('aria-busy'), 'true');
		reply.resolve({ ok: false, error: { code: -32009, message: 'b.md already exists' } });
		await tick();
		assert.strictEqual(alert_text(target), 'b.md already exists');
		assert.isUndefined(
			target.querySelector('[role="status"] small')?.textContent,
			'the input says it, not the note too'
		);
		assert.strictEqual(name_input(target), input);
		assert.isFalse(input.readOnly);
		assert.strictEqual(document.activeElement, input);
		assert.deepEqual(renamed_intents(), [[{ path: '/w/a.md', name: 'b.md' }, 'failed']]);

		// typing clears it; leaving after the refusal drops the name, not sending it again
		type(input, 'c.md');
		assert.isUndefined(alert_text(target));
	});

	test('leaving after the daemon refused the name drops it, not sending it again', async () => {
		write('/w/a.md');
		const target = render_tree();
		reply = create_deferred();
		const input = press_f2_on(target, 'a.md');
		type(input, 'b.md');
		press(target, 'Enter', input);
		reply.resolve({ ok: false, error: { code: -32009, message: 'no' } });
		await tick();
		const header_button = target.querySelector<HTMLButtonElement>(
			'button[aria-label="collapse all folders"]'
		)!;
		header_button.focus();
		await tick();
		assert.strictEqual(calls.length, 1);
		assert.isNull(name_input(target));
		assert.deepEqual(row_texts(target), ['/w/', 'a.md']);
	});

	test('leaving the input renames to a valid new name', async () => {
		write('/w/a.md');
		const target = render_tree();
		const header_button = target.querySelector<HTMLButtonElement>(
			'button[aria-label="collapse all folders"]'
		)!;
		const input = press_f2_on(target, 'a.md');
		type(input, 'b.md');
		header_button.focus();
		await tick();
		await tick();
		assert.deepEqual(calls, [{ path: '/w/a.md', name: 'b.md' }]);
		assert.isNull(name_input(target));
		assert.deepEqual(row_texts(target), ['/w/', 'b.md']);
		assert.strictEqual(document.activeElement, header_button, 'focus stays where it went');
	});

	test('F2 does nothing on a folder, nor on a file deleted on disk', () => {
		write('/w/a/x.md');
		const gone = write('/w/y.md');
		// held, so its row stays once deleted
		app.diskfiles.editor.open_diskfile(gone.path);
		app.diskfiles.remove_by_path(gone.path);
		flushSync();
		const target = render_tree();
		assert.isTrue(gone.deleted_on_disk);
		const tree = app.diskfiles.editor.tree;
		for (const text of ['a', 'y.md']) {
			tree_el(target).focus();
			tree.active_key = tree.rows[row_texts(target).indexOf(text)]!.key;
			flushSync();
			assert.isFalse(press(target, 'F2'), `F2 on ${text} is left alone`);
			assert.isNull(name_input(target));
		}
	});

	test('the open file’s tab follows the rename', async () => {
		allow_logged_error(
			'no transport available',
			'the test runs without a transport, so what the component sends fails'
		);
		const file = write('/w/a.md');
		app.diskfiles.editor.open_diskfile(file.path);
		const target = render_tree();
		const input = press_f2_on(target, 'a.md');
		type(input, 'b.md');
		press(target, 'Enter', input);
		await tick();
		assert.strictEqual(app.diskfiles.editor.tabs.selected_path, '/w/b.md' as DiskfilePath);
		assert.strictEqual(file.path, '/w/b.md');
	});

	test('a rename to a name the index skips says so in a note', async () => {
		write('/w/a.md');
		const target = render_tree();
		const input = press_f2_on(target, 'a.md');
		type(input, 'dist');
		press(target, 'Enter', input);
		await tick();
		assert.strictEqual(
			target.querySelector('[role="status"] small')?.textContent.trim(),
			'renamed to dist, which the tree doesn’t show: the file index skips "dist"'
		);
	});

	test('a rename to a skipped name kept in the tree for its tab says nothing', async () => {
		allow_logged_error(
			'no transport available',
			'the test runs without a transport, so what the component sends fails'
		);
		const file = write('/w/a.md');
		app.diskfiles.editor.open_diskfile(file.path);
		const target = render_tree();
		const input = press_f2_on(target, 'a.md');
		type(input, 'dist');
		press(target, 'Enter', input);
		await tick();
		assert.include(row_texts(target), 'dist', 'kept for its tab');
		assert.strictEqual(active_text(target), 'dist');
		assert.isUndefined(target.querySelector('[role="status"] small')?.textContent);
	});

	test('an untouched name holding whitespace the parse would trim sends nothing', async () => {
		write('/w/a.md ');
		const prompt = vi.spyOn(window, 'prompt').mockImplementation((_message, value) => value!);
		const target = render_tree();
		const input = press_f2_on(target, 'a.md');
		assert.strictEqual(input.value, 'a.md ');
		press(target, 'Enter', input);
		await tick();
		assert.isNull(name_input(target));
		// nor by leaving it
		press_f2_on(target, 'a.md');
		target.querySelector<HTMLButtonElement>('button[aria-label="collapse all folders"]')!.focus();
		await tick();
		// nor the prompt, its name given back as it was
		mode_button(target).click();
		flushSync();
		const row = Array.from(target.querySelectorAll<HTMLElement>('.menuitem')).find((el) =>
			el.textContent.includes('a.md')
		);
		assert.ok(row);
		open_contextmenu(row);
		await open_submenu('file');
		await choose_menuitem('rename file');
		await tick();
		assert.strictEqual(prompt.mock.calls.length, 1);
		assert.deepEqual(calls, []);
	});

	test('ArrowRight on a folder holding only a file being renamed stays on it', async () => {
		write('/w/a/x.md');
		write('/w/b.md');
		const target = render_tree();
		app.diskfiles.editor.tree.reveal('/w/a/x.md');
		flushSync();
		reply = create_deferred();
		const input = press_f2_on(target, 'x.md');
		type(input, 'y.md');
		press(target, 'Enter', input);
		flushSync();
		// in flight, the tree focused: the rename's row is a child the keyboard can't act on
		tree_el(target).focus();
		const tree = app.diskfiles.editor.tree;
		tree.active_key = tree.rows[row_texts(target).indexOf('a')]!.key;
		flushSync();
		press(target, 'ArrowRight');
		assert.strictEqual(active_text(target), 'a');
		reply.resolve(moved('/w/a/x.md', '/w/a/y.md'));
		await tick();
	});

	test('a failed rename whose input is gone says why in the note', async () => {
		write('/w/a/x.md');
		const target = render_tree();
		const tree = app.diskfiles.editor.tree;
		tree.reveal('/w/a/x.md');
		flushSync();
		reply = create_deferred();
		const input = press_f2_on(target, 'x.md');
		type(input, 'y.md');
		press(target, 'Enter', input);
		flushSync();
		// its folder collapsed in flight: the input is dropped
		const folder = tree.rows.find((row) => row.kind === 'dir');
		assert.ok(folder?.kind === 'dir');
		tree.set_expanded(folder, false);
		flushSync();
		assert.isNull(name_input(target));
		reply.resolve({ ok: false, error: { code: -32009, message: 'y.md already exists' } });
		await tick();
		assert.strictEqual(
			target.querySelector('[role="status"] small')?.textContent.trim(),
			'couldn’t rename x.md: y.md already exists'
		);
	});

	test('scrolled out and back, the input keeps the selection the user left', () => {
		write('/w/a.md');
		for (let i = 0; i < 60; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const target = render_tree();
		const scroll_to = (y: number): void => {
			layout.scrolled = y;
			window.dispatchEvent(new Event('scroll'));
			flushSync();
		};
		let input = press_f2_on(target, 'a.md');
		assert.strictEqual(selected_text(input), 'a');
		input.setSelectionRange(input.value.length, input.value.length);
		scroll_to(1000);
		assert.isNull(name_input(target), 'scrolled out, unmounted');
		// focus went with the input, so it's taken again on the way back
		scroll_to(0);
		input = rename_input(target);
		assert.strictEqual(document.activeElement, input);
		assert.strictEqual(selected_text(input), '', 'the stem isn’t selected again');
	});

	test('a rename failing while scrolled out, focus moved on, says why once it’s dropped', async () => {
		write('/w/a.md');
		for (let i = 0; i < 60; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const target = render_tree();
		const scroll_to = (y: number): void => {
			layout.scrolled = y;
			window.dispatchEvent(new Event('scroll'));
			flushSync();
		};
		reply = create_deferred();
		const input = press_f2_on(target, 'a.md');
		type(input, 'b.md');
		press(target, 'Enter', input);
		flushSync();
		scroll_to(1000);
		assert.isNull(name_input(target), 'scrolled out, unmounted');
		const header_button = target.querySelector<HTMLButtonElement>(
			'button[aria-label="collapse all folders"]'
		)!;
		header_button.focus();
		reply.resolve({ ok: false, error: { code: -32009, message: 'b.md already exists' } });
		await tick();
		// back in the window with focus elsewhere, the input is dropped — and its failure said
		scroll_to(0);
		assert.isNull(name_input(target));
		assert.strictEqual(
			target.querySelector('[role="status"] small')?.textContent.trim(),
			'couldn’t rename a.md: b.md already exists'
		);
	});

	test('a rename failing scrolled out says why, though its input never comes back', async () => {
		write('/w/a.md');
		write('/w/b.md');
		for (let i = 0; i < 60; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const target = render_tree();
		const scroll_to = (y: number): void => {
			layout.scrolled = y;
			window.dispatchEvent(new Event('scroll'));
			flushSync();
		};
		reply = create_deferred();
		const input = press_f2_on(target, 'a.md');
		type(input, 'c.md');
		press(target, 'Enter', input);
		flushSync();
		scroll_to(1000);
		assert.isNull(name_input(target), 'scrolled out, unmounted');
		reply.resolve({ ok: false, error: { code: -32009, message: 'c.md already exists' } });
		await tick();
		const note = (): string | undefined =>
			target.querySelector('[role="status"] small')?.textContent.trim();
		// said at once, so a rename started before scrolling back can't lose it
		assert.strictEqual(note(), 'couldn’t rename a.md: c.md already exists');
	});

	test('a rename failing just off screen, its input still mounted, scrolls it back into view', async () => {
		write('/w/a.md');
		for (let i = 0; i < 60; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const target = render_tree();
		reply = create_deferred();
		const input = press_f2_on(target, 'a.md');
		type(input, 'c.md');
		press(target, 'Enter', input);
		flushSync();
		// a few rows down: above the view, but among the rows rendered past its edge
		layout.scrolled = 160;
		window.dispatchEvent(new Event('scroll'));
		flushSync();
		assert.isTrue(input.isConnected);
		layout.scroll_calls.length = 0;
		reply.resolve({ ok: false, error: { code: -32009, message: 'c.md already exists' } });
		await tick();
		assert.strictEqual(alert_text(target), 'c.md already exists');
		assert.isAbove(layout.scroll_calls.length, 0, 'scrolled to the input');
		assert.isBelow(layout.scrolled, 160);
	});

	test('a rename failing after the user clicked another row says why in the note, not scrolling', async () => {
		write('/w/a.md');
		for (let i = 0; i < 60; i++) write(`/w/f${i}.md`);
		const layout = stub_layout();
		const target = render_tree();
		reply = create_deferred();
		const input = press_f2_on(target, 'a.md');
		type(input, 'c.md');
		press(target, 'Enter', input);
		flushSync();
		layout.scrolled = 160;
		window.dispatchEvent(new Event('scroll'));
		flushSync();
		assert.isTrue(input.isConnected, 'among the rows rendered past the edge');
		click(find_row(target, 'f20.md'));
		layout.scroll_calls.length = 0;
		reply.resolve({ ok: false, error: { code: -32009, message: 'c.md already exists' } });
		await tick();
		assert.strictEqual(
			target.querySelector('[role="status"] small')?.textContent.trim(),
			'couldn’t rename a.md: c.md already exists'
		);
		assert.deepEqual(layout.scroll_calls, [], 'the view stays where the user left it');
		assert.strictEqual(layout.scrolled, 160);
	});

	test('a rename resolving after F2 started another leaves the tree at the newer input', async () => {
		write('/w/a.md');
		write('/w/b.md');
		const target = render_tree();
		reply = create_deferred();
		const input = press_f2_on(target, 'a.md');
		type(input, 'c.md');
		press(target, 'Enter', input);
		flushSync();
		const second = press_f2_on(target, 'b.md');
		reply.resolve(moved('/w/a.md', '/w/c.md'));
		await tick();
		assert.isTrue(second.isConnected, 'the newer input stays');
		assert.strictEqual(document.activeElement, second);
		assert.include(row_texts(target), 'c.md');
		assert.strictEqual(
			app.diskfiles.editor.tree.active_row?.kind,
			'rename',
			'the keyboard stays on the newer input'
		);
	});

	test('F2 during a create ends the create for the rename', () => {
		write('/w/a/x.md');
		const target = render_tree();
		const tree = app.diskfiles.editor.tree;
		const dir_row = tree.rows.find((row) => row.kind === 'dir');
		assert.ok(dir_row?.kind === 'dir');
		tree.start_create(dir_row, 'file');
		flushSync();
		assert.deepEqual(row_texts(target), ['/w/', 'a', '', 'x.md']);
		const input = press_f2_on(target, 'x.md');
		assert.deepEqual(row_texts(target), ['/w/', 'a', ''], 'one input, in the file’s row');
		assert.strictEqual(input.value, 'x.md');
	});
});
