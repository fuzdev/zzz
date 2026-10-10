// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { Frontend } from '$lib/frontend.svelte.ts';
import type { Diskfile } from '$lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import DiskfileContextmenuHarness from './DiskfileContextmenuHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');

let app: Frontend;
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
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const add_diskfile = (path: string, contents: string | null): Diskfile =>
	app.diskfiles.upsert({
		id: DiskfilePath.parse(path),
		source_dir: SOURCE_DIR,
		contents,
		ctime: 1,
		mtime: 1,
		dependents: [],
		dependencies: []
	});

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
		const a = add_diskfile('/w/a.md', '# a');
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

	test('only markdown files get the view submenu', () => {
		const a = add_diskfile('/w/a.txt', 'a');
		const target = render(a);
		open_menu(target);
		assert.ok(find_menuitem(target, 'file'));
		assert.isUndefined(find_menuitem(target, 'view'));
	});
});
