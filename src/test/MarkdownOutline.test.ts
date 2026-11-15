// @vitest-environment jsdom

import { describe, test, assert, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import MarkdownOutline from '#lib/MarkdownOutline.svelte';
import type { MarkdownHeading } from '#lib/markdown_links.ts';

const HEADINGS: Array<MarkdownHeading> = [
	{ level: 1, id: 'a', text: 'A', start: 0 },
	{ level: 2, id: 'b', text: 'B', start: 10 },
	{ level: 2, id: 'c', text: 'C', start: 20 }
];

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const render = (props: {
	onscreen?: ReadonlySet<number>;
	current?: number | null;
}): Array<HTMLButtonElement> => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(MarkdownOutline, {
		target,
		props: { headings: HEADINGS, onselect: () => {}, ...props }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
	});
	return Array.from(target.querySelectorAll('button'));
};

describe('MarkdownOutline highlight', () => {
	test('sections on screen are highlighted, the current one marked current', () => {
		const buttons = render({ onscreen: new Set([0, 1]), current: 1 });
		assert.deepEqual(
			buttons.map((b) => b.classList.contains('highlighted')),
			[true, true, false]
		);
		assert.deepEqual(
			buttons.map((b) => b.classList.contains('current')),
			[false, true, false]
		);
		assert.deepEqual(
			buttons.map((b) => b.getAttribute('aria-current')),
			[null, 'location', null]
		);
	});

	test('the current section is marked even off screen', () => {
		const buttons = render({ onscreen: new Set([0]), current: 2 });
		assert.isFalse(buttons[2]!.classList.contains('highlighted'));
		assert.isTrue(buttons[2]!.classList.contains('current'));
		assert.strictEqual(buttons[2]!.getAttribute('aria-current'), 'location');
	});

	test('without them, nothing is lit', () => {
		const buttons = render({});
		for (const button of buttons) {
			assert.isFalse(button.classList.contains('highlighted'));
			assert.isFalse(button.classList.contains('current'));
			assert.isFalse(button.hasAttribute('aria-current'));
		}
	});
});
