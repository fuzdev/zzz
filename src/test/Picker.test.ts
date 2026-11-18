// @vitest-environment jsdom

import { test, describe, afterEach, assert, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import PickerHarness from './PickerHarness.svelte';
import { ResizeObserverStub } from './diskfile_tree_test_helpers.ts';

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const render = (
	items: Array<{ id: string }>,
	windowed = false
): { target: HTMLElement; picked: Array<string | undefined> } => {
	const picked: Array<string | undefined> = [];
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(PickerHarness, {
		target,
		props: { items, windowed, onpick: (item) => picked.push(item?.id) }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
	});
	return { target, picked };
};

const get_input = (target: HTMLElement): HTMLInputElement => {
	const input = target.querySelector<HTMLInputElement>('input[role="combobox"]');
	assert.ok(input);
	return input;
};

const active_text = (target: HTMLElement): string | undefined => {
	const id = get_input(target).getAttribute('aria-activedescendant');
	if (!id) return undefined;
	return document.getElementById(id)?.textContent.trim();
};

const key = (input: HTMLInputElement, k: string): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
	input.dispatchEvent(event);
	flushSync();
	return event;
};

const type = (input: HTMLInputElement, text: string): void => {
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

const ITEMS = [{ id: 'alpha' }, { id: 'beta' }, { id: 'alphabet' }];

describe('Picker active row', () => {
	test('the filter input names the active item in a listbox it controls', () => {
		const { target } = render(ITEMS);
		const input = get_input(target);
		const list = target.querySelector('[role="listbox"]');
		assert.ok(list);
		assert.strictEqual(input.getAttribute('aria-controls'), list.id);
		assert.strictEqual(list.getAttribute('aria-label'), 'pick one');
		assert.strictEqual(active_text(target), 'alpha');
		const options = Array.from(list.querySelectorAll('[role="option"]'));
		assert.strictEqual(options.length, 3);
		assert.deepEqual(
			options.map((o) => o.getAttribute('aria-selected')),
			['true', 'false', 'false']
		);
	});

	test('Up and Down move through the shown items, wrapping; typing starts again at the top', () => {
		const { target } = render(ITEMS);
		const input = get_input(target);
		assert.isTrue(key(input, 'ArrowDown').defaultPrevented);
		assert.strictEqual(active_text(target), 'beta');
		key(input, 'ArrowUp');
		key(input, 'ArrowUp');
		assert.strictEqual(active_text(target), 'alphabet');
		type(input, 'alph');
		assert.strictEqual(active_text(target), 'alpha');
		key(input, 'ArrowDown');
		assert.strictEqual(active_text(target), 'alphabet');
		key(input, 'ArrowDown');
		assert.strictEqual(active_text(target), 'alpha', 'only the matches');
	});

	test('Enter picks the active item; with no match it does nothing', () => {
		const { target, picked } = render(ITEMS);
		const input = get_input(target);
		key(input, 'ArrowDown');
		assert.isTrue(key(input, 'Enter').defaultPrevented);
		assert.deepEqual(picked, ['beta']);
		type(input, 'nothing');
		assert.isFalse(input.hasAttribute('aria-activedescendant'));
		assert.isFalse(key(input, 'Enter').defaultPrevented);
		assert.deepEqual(picked, ['beta']);
	});

	test('a click still picks', () => {
		const { target, picked } = render(ITEMS);
		target.querySelectorAll<HTMLButtonElement>('button.listitem')[2]!.click();
		assert.deepEqual(picked, ['alphabet']);
	});

	test('windowed, the options carry their index in the shown order', () => {
		vi.stubGlobal('ResizeObserver', ResizeObserverStub);
		const { target } = render(ITEMS, true);
		const input = get_input(target);
		key(input, 'ArrowDown');
		assert.strictEqual(active_text(target), 'beta');
	});
});
