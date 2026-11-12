// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import TerminalContextmenuHarness from './TerminalContextmenuHarness.svelte';

const cleanups: Array<() => void> = [];

// jsdom has no `ResizeObserver`, which the menu's size bindings use
class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const render = (props: {
	paste: ((text: Promise<string>) => unknown) | null;
	read_clipboard: () => Promise<string>;
}): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(TerminalContextmenuHarness, { target, props });
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

const find_menuitem = (text: string): HTMLElement | undefined =>
	Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
		(el) => el.textContent.trim() === text
	);

/** Entries activate a tick after the click. */
const click = async (item: HTMLElement): Promise<void> => {
	item.click();
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

describe('TerminalContextmenu paste', () => {
	test('reads the clipboard in the activation and hands the read to the view; the menu closes', async () => {
		const read = Promise.resolve('pasted text');
		const reads: Array<Promise<string>> = [];
		const pastes: Array<Promise<string>> = [];
		const target = render({
			paste: (text) => pastes.push(text),
			read_clipboard: () => {
				reads.push(read);
				return read;
			}
		});
		open_menu(target);
		const item = find_menuitem('paste');
		assert.ok(item, 'a paste entry');
		assert.strictEqual(item.getAttribute('aria-disabled'), 'false');
		// the activation runs on a timer after the click: the read must start in
		// it, before any microtask, or the browser may refuse it
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		item.click();
		vi.advanceTimersByTime(0);
		assert.deepEqual(reads, [read], 'read in the activation itself');
		vi.useRealTimers();
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		assert.deepEqual(reads, [read], 'read once');
		assert.strictEqual(pastes.length, 1);
		assert.strictEqual(pastes[0], read, 'the read itself, unawaited, so it ran in the activation');
		assert.isUndefined(find_menuitem('paste'), 'the menu closed');
	});

	test('disabled while the terminal takes no input: nothing is read', async () => {
		let reads = 0;
		const target = render({
			paste: null,
			read_clipboard: () => {
				reads++;
				return Promise.resolve('x');
			}
		});
		open_menu(target);
		const item = find_menuitem('paste');
		assert.ok(item);
		assert.strictEqual(item.getAttribute('aria-disabled'), 'true');
		await click(item);
		assert.strictEqual(reads, 0);
	});
});
