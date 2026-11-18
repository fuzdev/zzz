// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { icon_checkmark } from '@fuzdev/fuz_ui/icons.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import DiskfileContextmenuHarness from './DiskfileContextmenuHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import {
	content_hash,
	install_fake_disk,
	type FakeDisk,
	seed_diskfile
} from './diskfile_test_helpers.ts';

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;
let disk: FakeDisk;
const cleanups: Array<() => void> = [];

// jsdom has no `ResizeObserver`, which the menu's size bindings use
class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const add_diskfile = (path: string, contents: string | null): Promise<Diskfile> =>
	disk.load(path, contents);

const render = (diskfile: Diskfile): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: DiskfileContextmenuHarness, props: { diskfile } }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

const open_menu = (target: HTMLElement): void => {
	const el = target.querySelector('.contextmenu-target');
	assert.ok(el);
	el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
	);
	flushSync();
};

const find_menuitem = (target: HTMLElement, text: string): HTMLElement | undefined =>
	Array.from(target.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
		(el) => el.textContent.trim() === text
	);

/** Submenus open on hover, a tick later. */
const open_submenu = async (target: HTMLElement, text: string): Promise<void> => {
	const item = find_menuitem(target, text);
	assert.ok(item, `a "${text}" submenu`);
	item.dispatchEvent(new MouseEvent('mouseenter'));
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

describe('DiskfileContextmenu view submenu', () => {
	test('opening the menu or choosing a mode creates no editing state; the choice is kept by path', async () => {
		const a = await add_diskfile('/w/a.md', '# a');
		const target = render(a);
		open_menu(target);
		await open_submenu(target, 'view');
		assert.ok(find_menuitem(target, 'preview'), 'the view submenu lists the modes');
		assert.isUndefined(app.diskfiles.find_editor_state(a.path));

		// entries activate a tick after the click
		find_menuitem(target, 'preview')!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.isUndefined(app.diskfiles.find_editor_state(a.path));
		assert.strictEqual(app.diskfiles.markdown_view_modes.get(a.path), 'preview');
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => [entry.method, entry.input]),
			[['markdown_mode_set', { path: a.path, mode: 'preview' }]]
		);
		assert.strictEqual(
			app.diskfiles.get_editor_state_at(a.path)?.markdown_view_mode_choice,
			'preview',
			'an editing state made later shows it'
		);
	});

	test('the checkmark marks the choice kept by path', async () => {
		const a = await add_diskfile('/w/a.md', '# a');
		app.diskfiles.markdown_view_modes.set(a.path, 'source');
		const target = render(a);
		open_menu(target);
		await open_submenu(target, 'view');

		const checked = (text: string): boolean => {
			const item = find_menuitem(target, text);
			assert.ok(item, `a "${text}" entry`);
			return !!item.querySelector(`path[d="${icon_checkmark.paths[0]!.d}"]`);
		};
		// the choice, not the default (split)
		assert.isTrue(checked('source'));
		assert.isFalse(checked('split view'));
	});

	test('only markdown files get the view submenu', async () => {
		const a = await add_diskfile('/w/a.txt', 'a');
		const target = render(a);
		open_menu(target);
		assert.ok(find_menuitem(target, 'file'));
		assert.isUndefined(find_menuitem(target, 'view'));
	});
});

const find_copy_entry = (target: HTMLElement): HTMLElement | undefined =>
	Array.from(target.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) =>
		el.textContent.includes('copy file content')
	);

describe('DiskfileContextmenu copy file content', () => {
	test('loads content not yet loaded on click, then copies it', async () => {
		const write_text = vi.fn((_text: string) => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write_text },
			configurable: true
		});
		const read_paths: Array<string> = [];
		(app as unknown as { api: unknown }).api = {
			diskfile_read: ({ path }: { path: string }) => {
				read_paths.push(path);
				return Promise.resolve({
					ok: true,
					value: {
						contents: 'lazy text',
						unloaded_reason: null,
						hash: content_hash('lazy text'),
						size: 9,
						ctime: 1,
						mtime: 1
					}
				});
			}
		};
		const path = parse_or_throw(DiskfilePath, '/w/lazy.txt');
		app.diskfiles.add_initial([{ id: path, source_dir: SOURCE_DIR, size: 9, ctime: 1, mtime: 1 }]);
		const diskfile = seed_diskfile(app, path)!;
		assert.strictEqual(diskfile.content_status, 'unrequested');

		const target = render(diskfile);
		open_menu(target);
		await open_submenu(target, 'file');
		const entry = find_copy_entry(target);
		assert.ok(entry, 'offered before the content is loaded');
		assert.deepEqual(read_paths, [], 'opening the menu reads nothing');

		entry.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(read_paths, [path]);
		assert.deepEqual(write_text.mock.calls, [['lazy text']]);
	});

	test('copies loaded content with no await before the clipboard write', async () => {
		const write_text = vi.fn((_text: string) => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write_text },
			configurable: true
		});
		const a = await add_diskfile('/w/a.txt', 'loaded text');
		const target = render(a);
		open_menu(target);
		await open_submenu(target, 'file');
		const entry = find_copy_entry(target);
		assert.ok(entry);

		vi.useFakeTimers();
		try {
			entry.click();
			// the entry activates in a timeout — run it, then look before any microtask
			vi.advanceTimersByTime(1);
			assert.deepEqual(write_text.mock.calls, [['loaded text']], 'written within the activation');
		} finally {
			vi.useRealTimers();
		}
	});

	test('a write refused after a load keeps the menu open, and a second click copies', async () => {
		const write_text = vi
			.fn((_text: string) => Promise.resolve())
			.mockImplementationOnce(() => Promise.reject(new Error('not allowed')));
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write_text },
			configurable: true
		});
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		(app as unknown as { api: unknown }).api = {
			diskfile_read: () =>
				Promise.resolve({
					ok: true,
					value: {
						contents: 'lazy text',
						unloaded_reason: null,
						hash: content_hash('lazy text'),
						size: 9,
						ctime: 1,
						mtime: 1
					}
				})
		};
		const path = parse_or_throw(DiskfilePath, '/w/lazy.txt');
		app.diskfiles.add_initial([{ id: path, source_dir: SOURCE_DIR, size: 9, ctime: 1, mtime: 1 }]);
		const target = render(seed_diskfile(app, path)!);
		open_menu(target);
		await open_submenu(target, 'file');

		find_copy_entry(target)!.click();
		for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		const entry = find_copy_entry(target);
		assert.ok(entry, 'the menu stays open');
		assert.strictEqual(entry.getAttribute('title'), 'Error: loaded — copy again');

		vi.useFakeTimers();
		try {
			entry.click();
			vi.advanceTimersByTime(1);
			assert.deepEqual(write_text.mock.calls, [['lazy text'], ['lazy text']], 'copied at once');
		} finally {
			vi.useRealTimers();
		}
	});

	test('a failed load keeps the menu open, saying why, and a second click reads again', async () => {
		const write_text = vi.fn((_text: string) => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write_text },
			configurable: true
		});
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		let read_count = 0;
		(app as unknown as { api: unknown }).api = {
			diskfile_read: () =>
				Promise.resolve(
					++read_count === 1
						? { ok: false, error: { code: -32603, message: 'connection lost' } }
						: {
								ok: true,
								value: {
									contents: 'lazy text',
									unloaded_reason: null,
									hash: content_hash('lazy text'),
									size: 9,
									ctime: 1,
									mtime: 1
								}
							}
				)
		};
		const path = parse_or_throw(DiskfilePath, '/w/lazy.txt');
		app.diskfiles.add_initial([{ id: path, source_dir: SOURCE_DIR, size: 9, ctime: 1, mtime: 1 }]);
		const target = render(seed_diskfile(app, path)!);
		open_menu(target);
		await open_submenu(target, 'file');

		find_copy_entry(target)!.click();
		for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		const entry = find_copy_entry(target);
		assert.ok(entry, 'the menu stays open');
		assert.include(entry.getAttribute('title'), 'connection lost');
		assert.strictEqual(write_text.mock.calls.length, 0);

		entry.click();
		for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(read_count, 2, 'the click read again');
		assert.deepEqual(write_text.mock.calls, [['lazy text']]);
	});

	test('is not offered for an empty file, by its size before it loads', async () => {
		const empty = disk.write('/w/empty.txt', '');
		const target = render(empty);
		open_menu(target);
		await open_submenu(target, 'file');
		assert.strictEqual(empty.content_status, 'unrequested');
		assert.strictEqual(empty.size, 0);
		assert.isUndefined(find_copy_entry(target), 'not before it loads');

		await app.diskfiles.ensure_content(empty);
		flushSync();
		assert.strictEqual(empty.content, '');
		assert.isUndefined(find_copy_entry(target), 'nor after');
	});

	test('is not offered for a file that can not load', async () => {
		const a = await add_diskfile('/w/big.bin', null);
		const target = render(a);
		open_menu(target);
		await open_submenu(target, 'file');
		const entry = find_copy_entry(target);
		assert.isUndefined(entry);
	});
});

describe('DiskfileContextmenu on a file nothing holds', () => {
	test('the open menu makes the cell, copies through it, and lets it go on close', async () => {
		const write_text = vi
			.fn((_text: string) => Promise.resolve())
			.mockImplementationOnce(() => Promise.reject(new Error('not allowed')));
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write_text },
			configurable: true
		});
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const read_paths: Array<string> = [];
		(app as unknown as { api: unknown }).api = {
			diskfile_read: ({ path }: { path: string }) => {
				read_paths.push(path);
				return Promise.resolve({
					ok: true,
					value: {
						contents: 'lazy text',
						unloaded_reason: null,
						hash: content_hash('lazy text'),
						size: 9,
						ctime: 1,
						mtime: 1
					}
				});
			}
		};
		const path = parse_or_throw(DiskfilePath, '/w/lazy.txt');
		app.diskfiles.add_initial([{ id: path, source_dir: SOURCE_DIR, size: 9, ctime: 1, mtime: 1 }]);
		const target = render({ path } as Diskfile);
		assert.isUndefined(app.diskfiles.peek(path), 'rendering the target makes no cell');

		open_menu(target);
		await open_submenu(target, 'file');
		assert.ok(app.diskfiles.peek(path), 'the open menu holds a cell');
		assert.deepEqual(read_paths, [], 'opening the menu reads nothing');

		// the first write is refused after the load, so the menu stays open
		find_copy_entry(target)!.click();
		for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		const entry = find_copy_entry(target);
		assert.ok(entry, 'the menu stays open');
		assert.strictEqual(entry.getAttribute('title'), 'Error: loaded — copy again');

		vi.useFakeTimers();
		try {
			entry.click();
			vi.advanceTimersByTime(1);
			assert.deepEqual(write_text.mock.calls, [['lazy text'], ['lazy text']], 'copied at once');
		} finally {
			vi.useRealTimers();
		}
		assert.deepEqual(read_paths, [path], 'read once');

		for (const cleanup of cleanups.splice(0)) cleanup();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.isUndefined(app.diskfiles.peek(path), 'closing lets the cell go');
		assert.isTrue(app.diskfiles.index.has(path), 'its record stays');
	});
});
