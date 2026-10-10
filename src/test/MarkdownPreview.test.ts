// @vitest-environment jsdom

import { describe, test, assert, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import MarkdownPreview from '$lib/MarkdownPreview.svelte';

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

const render = (props: Record<string, unknown>): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(MarkdownPreview, { target, props: props as any });
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
	});
	return target;
};

/**
 * Clicks the preview's link with `text`, returning whether the click was
 * prevented once it bubbled out of the preview (where SvelteKit's router
 * and the browser would act on it).
 */
const click_link = (target: HTMLElement, text: string, init: MouseEventInit = {}): boolean => {
	const anchor = Array.from(target.querySelectorAll('a')).find(
		(a) => a.textContent.trim() === text
	);
	assert.ok(anchor, `a "${text}" link`);
	let prevented: boolean | null = null;
	const listener = (event: Event): void => {
		prevented = event.defaultPrevented;
		// keep jsdom from attempting the navigation itself
		event.preventDefault();
	};
	document.addEventListener('click', listener);
	anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
	document.removeEventListener('click', listener);
	assert.isNotNull(prevented, 'the click bubbled out of the preview');
	return prevented;
};

describe('MarkdownPreview links', () => {
	test('a link into the app does nothing, so the files page stays', () => {
		const target = render({
			content: '[rel](./docs/x.md) [root](/settings) [query](?x=1) [bare](notes.md)'
		});
		for (const text of ['rel', 'root', 'query', 'bare']) {
			assert.isTrue(click_link(target, text), text);
			assert.isTrue(click_link(target, text, { ctrlKey: true }), `${text} with ctrl`);
		}
	});

	test('a fragment scrolls to its heading in the preview without navigating', () => {
		const target = render({ content: '[jump](#later)\n\n## later' });
		const heading = target.querySelector('h2');
		assert.ok(heading);
		assert.strictEqual(heading.id, 'later');
		const scroll = vi.fn();
		heading.scrollIntoView = scroll;
		assert.isTrue(click_link(target, 'jump'));
		assert.strictEqual(scroll.mock.calls.length, 1);
	});

	test('a malformed fragment escape is still prevented and throws nothing', () => {
		const target = render({ content: '[bad](#a%zz)\n\n## a' });
		const errors: Array<unknown> = [];
		const on_error = (event: ErrorEvent): void => {
			errors.push(event.error);
		};
		window.addEventListener('error', on_error);
		cleanups.push(() => window.removeEventListener('error', on_error));
		assert.isTrue(click_link(target, 'bad'));
		assert.deepEqual(errors, []);
	});

	test('an external link opens in a new tab, never in place of the app', () => {
		const open = vi.spyOn(window, 'open').mockImplementation(() => null);
		const target = render({ content: '[ext](https://example.com/page)' });
		const anchor = target.querySelector('a');
		assert.strictEqual(anchor?.target, '_blank');
		assert.isFalse(click_link(target, 'ext'), 'left to the browser, which opens a new tab');
		assert.strictEqual(open.mock.calls.length, 0);
	});
});

describe('MarkdownPreview focus', () => {
	test('takes the pending focus key, clearing it', () => {
		let pending: string | null = 'k';
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(MarkdownPreview, {
			target,
			props: {
				content: '# a',
				focus_key: 'k',
				get pending_element_to_focus_key() {
					return pending;
				},
				set pending_element_to_focus_key(v) {
					pending = v;
				}
			}
		});
		flushSync();
		cleanups.push(() => {
			void unmount(mounted);
			target.remove();
		});
		const container = target.firstElementChild;
		assert.ok(container);
		assert.strictEqual(document.activeElement, container);
		assert.isNull(pending);
	});
});
