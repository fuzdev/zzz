// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import DashboardDiskfiles from '#lib/DashboardDiskfiles.svelte';
import { DISKFILE_DETAILS_DRAWER_ID } from '#lib/DiskfileDetailsDrawer.svelte';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';
import { install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

/**
 * The files page's header: the tabs, then the details toggle for the file
 * shown, then room for the desk menu's fixed button while it shows.
 */

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;
let disk: FakeDisk;
const cleanups: Array<() => void> = [];

// jsdom has no Web Animations, which Svelte transitions use
const animate_original = Element.prototype.animate as Element['animate'] | undefined;
const animate_stub = function (this: Element): Animation {
	const animation = {
		onfinish: null as (() => void) | null,
		cancel: () => {},
		finished: Promise.resolve()
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};

// jsdom has no `ResizeObserver`, which the file explorer's list uses
class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	Element.prototype.animate = animate_stub;
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
	// a backend with a filesystem, so the page shows its files
	app.capabilities.backend = {
		name: 'backend',
		data: null,
		status: 'success',
		message_id: null,
		error_message: null,
		updated: 1
	};
	app.zzz_dir = '/w/';
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (animate_original) {
		Element.prototype.animate = animate_original;
	} else {
		delete (Element.prototype as Partial<Element>).animate;
	}
});

const write_file = (path: string, contents: string): Promise<Diskfile> => disk.load(path, contents);

const render = () => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: DashboardDiskfiles, props: {} }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

const details_button = (target: HTMLElement): HTMLButtonElement | null =>
	target.querySelector<HTMLButtonElement>(`button[aria-controls="${DISKFILE_DETAILS_DRAWER_ID}"]`);

/** The invisible copy of the desk menu button that reserves its footprint. */
const desk_placeholder = (target: HTMLElement): HTMLButtonElement | null =>
	target.querySelector<HTMLButtonElement>('button.visibility\\:hidden');

describe('DashboardDiskfiles header', () => {
	test('the details toggle shows only with a file view', async () => {
		await write_file('/w/a.txt', 'hello');
		const target = render();
		assert.isNull(details_button(target), 'no tab, no toggle');

		const a = app.diskfiles.get_by_path(parse_or_throw(DiskfilePath, '/w/a.txt'));
		assert.ok(a);
		app.diskfiles.select(a.id, true);
		flushSync();
		assert.ok(details_button(target));
	});

	test('it is an icon, named by its label and stating whether the drawer is open', async () => {
		const a = await write_file('/w/a.txt', 'hello');
		app.diskfiles.select(a.id, true);
		const target = render();
		const button = details_button(target);
		assert.ok(button);
		assert.strictEqual(to_visible_text(button), '', 'icon only');
		assert.ok(button.querySelector('svg'));
		assert.strictEqual(button.getAttribute('aria-label'), 'hide the file details');
		assert.strictEqual(button.title, 'hide the file details');
		assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
		assert.ok(document.getElementById(DISKFILE_DETAILS_DRAWER_ID), 'it controls the drawer');
	});

	test('a click toggles the setting, and the file view follows', async () => {
		const a = await write_file('/w/a.txt', 'hello');
		app.diskfiles.select(a.id, true);
		const target = render();
		const button = details_button(target);
		assert.ok(button);
		assert.ok(target.querySelector('.details-drawer-content'));

		button.click();
		flushSync();
		assert.isFalse(app.ui.show_diskfile_details);
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(button.getAttribute('aria-label'), 'show the file details');
		assert.isNull(target.querySelector('.details-drawer-content'));

		button.click();
		flushSync();
		assert.isTrue(app.ui.show_diskfile_details);
		assert.ok(target.querySelector('.details-drawer-content'));
	});

	test('the desk menu button keeps its room in the header only while it shows', async () => {
		const a = await write_file('/w/a.txt', 'hello');
		app.diskfiles.select(a.id, true);
		const target = render();
		const placeholder = desk_placeholder(target);
		assert.ok(placeholder, 'the desk menu button shows');
		assert.strictEqual(placeholder.previousElementSibling, details_button(target), 'after it');
		assert.strictEqual(placeholder.getAttribute('aria-hidden'), 'true');
		assert.strictEqual(placeholder.tabIndex, -1);
		assert.isTrue(placeholder.disabled);
		// the same classes as the desk menu button's in `Dashboard`, so the same size
		for (const c of ['icon-button', 'plain', 'border-radius:0', 'border_bottom_left_radius_md']) {
			assert.isTrue(placeholder.classList.contains(c), c);
		}

		app.ui.toggle_desk_menu(true);
		flushSync();
		assert.isNull(desk_placeholder(target), 'the desk menu is open, its button gone');

		app.ui.toggle_desk_menu(false);
		flushSync();
		assert.ok(desk_placeholder(target));
	});

	test('with tabs but no file view, the desk menu button keeps its room, and no toggle shows', async () => {
		const a = await write_file('/w/a.txt', 'hello');
		app.diskfiles.select(a.id, true);
		const target = render();
		assert.ok(details_button(target));

		// no tab selected
		app.diskfiles.editor.tabs.selected_tab_id = null;
		flushSync();
		assert.strictEqual(app.diskfiles.editor.tabs.ordered_tabs.length, 1);
		assert.isNull(details_button(target), 'no file view, no toggle');
		assert.ok(desk_placeholder(target), 'the tabs still run under the desk menu button');

		// a selected tab whose file is gone
		app.diskfiles.editor.tabs.select_tab(app.diskfiles.editor.tabs.ordered_tabs[0]!.id);
		app.diskfiles.items.remove(a.id);
		flushSync();
		assert.include(target.textContent, 'this tab has no diskfile');
		assert.isNull(details_button(target));
		assert.ok(desk_placeholder(target));
	});

	test('the toggle and the placeholder sit at the top, not stretched to the tabs', async () => {
		const a = await write_file('/w/a.txt', 'hello');
		app.diskfiles.select(a.id, true);
		const target = render();
		assert.isTrue(details_button(target)?.classList.contains('align-self:flex-start'));
		assert.isTrue(desk_placeholder(target)?.classList.contains('align-self:flex-start'));
	});

	test('with no tabs, the header reserves nothing', () => {
		const target = render();
		assert.isNull(desk_placeholder(target));
		assert.isNull(details_button(target));
	});
});
