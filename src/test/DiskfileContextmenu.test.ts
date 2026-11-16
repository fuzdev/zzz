// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import DiskfileContextmenuHarness from './DiskfileContextmenuHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { content_hash, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

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
	test('opening the menu creates no editing state, and choosing a mode sets it', async () => {
		const a = await add_diskfile('/w/a.md', '# a');
		const target = render(a);
		open_menu(target);
		await open_submenu(target, 'view');
		assert.ok(find_menuitem(target, 'preview'), 'the view submenu lists the modes');
		assert.isUndefined(app.diskfiles.find_editor_state(a.id));

		// entries activate a tick after the click
		find_menuitem(target, 'preview')!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.strictEqual(app.diskfiles.find_editor_state(a.id)?.markdown_view_mode_choice, 'preview');
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
		const diskfile = app.diskfiles.get_by_path(path)!;
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
		const target = render(app.diskfiles.get_by_path(path)!);
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
		const target = render(app.diskfiles.get_by_path(path)!);
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
