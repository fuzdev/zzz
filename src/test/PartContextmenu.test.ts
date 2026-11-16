// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { PartUnion } from '#lib/part.svelte.ts';
import PartContextmenu from '#lib/PartContextmenu.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import ContextmenuHarness from './ContextmenuHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

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
	disk = install_fake_disk(app, '/w/');
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const render = (part: PartUnion): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: ContextmenuHarness, props: { menu: PartContextmenu, props: { part } } }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

/** Opens the menu and its "part" submenu (submenus open on hover, a tick later). */
const open_part_submenu = async (target: HTMLElement): Promise<void> => {
	const el = target.querySelector('.contextmenu-target');
	assert.ok(el);
	el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
	);
	flushSync();
	const item = Array.from(target.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
		(e) => e.textContent.trim() === 'part'
	);
	assert.ok(item, 'a "part" submenu');
	item.dispatchEvent(new MouseEvent('mouseenter'));
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

const find_copy_entry = (target: HTMLElement): HTMLElement | undefined =>
	Array.from(target.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) =>
		el.textContent.includes('copy content')
	);

describe('PartContextmenu copy content', () => {
	test('is not offered for a file part of an empty file, by its size before it loads', async () => {
		disk.write('/w/empty.txt', '');
		const release = disk.hold_reads(); // the part's read stays in flight
		const part = app.parts.add({ type: 'diskfile', path: '/w/empty.txt' });
		assert(part.type === 'diskfile');
		const target = render(part);
		await open_part_submenu(target);
		assert.strictEqual(part.content_status, 'loading');
		assert.isUndefined(find_copy_entry(target), 'not before it loads');

		release();
		await flush_reads();
		flushSync();
		assert.strictEqual(part.content, '');
		assert.isUndefined(find_copy_entry(target), 'nor after');
	});

	test('is offered for a file part of an empty file with a draft', async () => {
		const empty = await disk.load('/w/empty.txt', '');
		app.diskfiles.get_editor_state(empty).current_content = 'draft';
		const drafted = app.parts.add({ type: 'diskfile', path: '/w/empty.txt' });
		const drafted_target = render(drafted);
		await open_part_submenu(drafted_target);
		assert.ok(find_copy_entry(drafted_target), 'the draft is what it copies');
	});

	test('is offered for a file part not loaded yet', async () => {
		disk.write('/w/a.txt', 'text');
		const release = disk.hold_reads();
		const loading = app.parts.add({ type: 'diskfile', path: '/w/a.txt' });
		assert(loading.type === 'diskfile');
		const target = render(loading);
		await open_part_submenu(target);
		assert.strictEqual(loading.content_status, 'loading');
		assert.ok(find_copy_entry(target), 'loaded on click');
		release();
		await flush_reads();
	});

	test('a text part is offered even when empty, as before', async () => {
		const part = app.parts.add({ type: 'text', content: '' });
		const target = render(part);
		await open_part_submenu(target);
		assert.ok(find_copy_entry(target));
	});
});
