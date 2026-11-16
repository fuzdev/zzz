import { assert, vi } from 'vitest';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import type { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import type { DiskfileTreeRow } from '#lib/diskfile_tree_state.svelte.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import DiskfileExplorerHarness from './DiskfileExplorerHarness.svelte';
import { to_visible_text } from './test_helpers.ts';

/**
 * Helpers for the file explorer's tree tests: fixtures — files written into an
 * app, the explorer mounted under a `ContextmenuRoot` (`DiskfileExplorerHarness`),
 * the rows as an outline — and DOM drivers that use the tree and its menus as a
 * user would.
 */

/** jsdom has no `ResizeObserver`, which windowing and the menus' size bindings use. */
export class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/**
 * Each row as `depth label`, with `+`/`-` for a collapsed or expanded folder, `~` for an
 * unfocused repo's lazy row, and an inline create's input as `[new file]` or `[new folder]` —
 * the tree at a glance.
 */
export const outline = (rows: ReadonlyArray<DiskfileTreeRow>): Array<string> =>
	rows.map((row) => {
		const indent = '  '.repeat(row.depth);
		if (row.kind === 'create') return `${indent}[new ${row.create_kind}]`;
		if (row.kind === 'unfocused') return `${indent}~ ${row.label}`;
		return `${indent}${row.kind === 'file' ? '' : row.expanded ? '- ' : '+ '}${row.label}`;
	});

/**
 * Adds the file at `path` to `app` as its root's filer reports it (metadata
 * only), loaded with contents `x` as a read would leave it.
 */
export const write_diskfile = (
	app: Frontend,
	path: string,
	source_dir: string = '/w/'
): Diskfile => {
	const diskfile = app.diskfiles.upsert({
		id: parse_or_throw(DiskfilePath, path),
		source_dir: parse_or_throw(SerializableDisknode.def.source_dir, source_dir),
		size: 1,
		ctime: 1,
		mtime: 1
	});
	if (diskfile.content_status === 'unrequested') diskfile.content = 'x';
	return diskfile;
};

export interface MountedExplorer {
	target: HTMLElement;
	/** Unmounts it — once, however often it's called. */
	destroy: () => void;
}

/**
 * Mounts `component` (the explorer by default) in `app`'s context, its
 * `destroy` pushed onto `cleanups` for the test's `afterEach`.
 */
export const mount_explorer = (
	app: Frontend,
	cleanups: Array<() => void>,
	component: ComponentProps<typeof FrontendContextHarness>['component'] = DiskfileExplorerHarness,
	props: Record<string, unknown> = {}
): MountedExplorer => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, { target, props: { app, component, props } });
	flushSync();
	let destroyed = false;
	const destroy = (): void => {
		if (destroyed) return;
		destroyed = true;
		void unmount(mounted);
		target.remove();
		flushSync();
	};
	cleanups.push(destroy);
	return { target, destroy };
};

/** Mounts the explorer and switches it to the tree with its header's mode switch. */
export const mount_tree = (app: Frontend, cleanups: Array<() => void>): MountedExplorer => {
	const mounted = mount_explorer(app, cleanups);
	mode_button(mounted.target).click();
	flushSync();
	return mounted;
};

/** Every row's height in `stub_layout`. */
const STUB_ROW_HEIGHT = 20;

/**
 * A layout for jsdom, which has none: the page scrolls (no scrolling ancestor
 * has `overflow` styles here), the tree `offset` from the top of the page
 * (`0` to start), every row `STUB_ROW_HEIGHT` tall. `window.scrollBy` moves
 * it, and the result records each call; set `scrolled` or `offset` and
 * dispatch a `scroll` on `window` to move it by hand.
 */
export const stub_layout = (
	scrolled: number = 0
): { scrolled: number; offset: number; scroll_calls: Array<number> } => {
	const layout = { scrolled, offset: 0, scroll_calls: [] as Array<number> };
	const rect = (top: number, height: number): DOMRect =>
		({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top }) as DOMRect;
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		const top = layout.offset - layout.scrolled;
		if (this.matches('[role="tree"]')) return rect(top, 0);
		const item = this.closest('[data-index]');
		if (item)
			return rect(top + Number(item.getAttribute('data-index')) * STUB_ROW_HEIGHT, STUB_ROW_HEIGHT);
		return rect(0, 0);
	});
	vi.spyOn(window, 'scrollBy').mockImplementation((_x: number, y: number) => {
		layout.scroll_calls.push(y);
		layout.scrolled += y;
	});
	return layout;
};

export const mode_button = (target: HTMLElement): HTMLButtonElement => {
	const button = target.querySelector<HTMLButtonElement>(
		'button[aria-label="show files as a tree"]'
	);
	assert.ok(button, 'the mode switch');
	return button;
};

export const tree_el = (target: HTMLElement): HTMLElement => {
	const el = target.querySelector<HTMLElement>('[role="tree"]');
	assert.ok(el, 'a tree');
	return el;
};

/** The rendered rows' visible text, in order. */
export const row_texts = (target: HTMLElement): Array<string> =>
	Array.from(target.querySelectorAll('[role="treeitem"]')).map((el) => to_visible_text(el));

export const find_row = (target: HTMLElement, text: string): HTMLElement => {
	const row = Array.from(target.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
		(el) => to_visible_text(el) === text
	);
	assert.ok(row, `a "${text}" row`);
	return row;
};

/** Dispatches a keydown on `el`, the tree by default, and says whether it was claimed. */
export const press = (
	target: HTMLElement,
	key: string,
	el: HTMLElement = tree_el(target)
): boolean => {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	el.dispatchEvent(event);
	flushSync();
	return event.defaultPrevented;
};

/** A click on a row's content, as the `detail`th click of a sequence (2 for a double click). */
export const click = (row: HTMLElement, detail: number = 1): void => {
	const content = row.querySelector('.menuitem');
	assert.ok(content);
	content.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
	flushSync();
};

/** The text of the row `aria-activedescendant` names. */
export const active_text = (target: HTMLElement): string | null => {
	const id = tree_el(target).getAttribute('aria-activedescendant');
	if (!id) return null;
	const row = document.getElementById(id);
	assert.ok(row, 'names a rendered row');
	return to_visible_text(row);
};

/** Right-clicks `el`'s first `.menuitem` (a row's content), saying whether zzz's menu took it. */
export const open_contextmenu = (el: HTMLElement): boolean => {
	const content = el.matches('.menuitem') ? el : el.querySelector('.menuitem');
	assert.ok(content, 'a row’s content');
	const event = new MouseEvent('contextmenu', {
		bubbles: true,
		cancelable: true,
		clientX: 10,
		clientY: 10
	});
	content.dispatchEvent(event);
	flushSync();
	return event.defaultPrevented;
};

/** A menu item's label: its text without a copy entry's preview (a `small`), whitespace collapsed. */
const to_menuitem_label = (el: Element): string => {
	const copy = el.cloneNode(true) as Element;
	for (const small of copy.querySelectorAll('small')) small.remove();
	return copy.textContent.replace(/\s+/g, ' ').trim();
};

/** The open contextmenu's item labels — a submenu's only once it's open. */
export const menuitem_labels = (): Array<string> =>
	Array.from(document.querySelectorAll('[role="menuitem"]')).map(to_menuitem_label);

const find_menuitem = (label: string): HTMLElement => {
	const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
		(el) => to_menuitem_label(el) === label
	);
	assert.ok(item, `a "${label}" menu item`);
	return item;
};

const tick = async (): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

/** Opens the submenu labeled `label`, which opens on hover a tick later. */
export const open_submenu = async (label: string): Promise<void> => {
	find_menuitem(label).dispatchEvent(new MouseEvent('mouseenter'));
	await tick();
};

/** Clicks the menu entry labeled `label`, which runs a tick later. */
export const choose_menuitem = async (label: string): Promise<void> => {
	find_menuitem(label).click();
	await tick();
};
