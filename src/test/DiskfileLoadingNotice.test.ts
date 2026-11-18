// @vitest-environment jsdom

import { test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import DiskfileLoadingNotice, {
	DISKFILE_LOADING_NOTICE_DELAY,
	DISKFILE_LOADING_NOTICE_SLOW_DELAY
} from '#lib/DiskfileLoadingNotice.svelte';
import { DISKFILE_CONTENT_LOADING_MESSAGE } from '#lib/diskfile_helpers.ts';

let target: HTMLElement;
let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	vi.useFakeTimers();
	target = document.body.appendChild(document.createElement('div'));
});
afterEach(() => {
	if (instance) void unmount(instance);
	instance = null;
	target.remove();
	vi.useRealTimers();
});

const advance = (ms: number): void => {
	vi.advanceTimersByTime(ms);
	flushSync();
};

test('nothing at first, the animation after a delay, the message once the read is slow', () => {
	instance = mount(DiskfileLoadingNotice, { target, props: { suffix: 'read-only' } });
	flushSync();
	assert.isNull(target.querySelector('p'), 'a quick read flashes nothing');

	advance(DISKFILE_LOADING_NOTICE_DELAY);
	const p = target.querySelector('p');
	assert.ok(p, 'the animation shows');
	assert.notInclude(p.textContent, DISKFILE_CONTENT_LOADING_MESSAGE);

	advance(DISKFILE_LOADING_NOTICE_SLOW_DELAY - DISKFILE_LOADING_NOTICE_DELAY);
	assert.include(target.textContent, `still ${DISKFILE_CONTENT_LOADING_MESSAGE} — read-only`);
});

test('unmounting before the delay clears its timers', () => {
	instance = mount(DiskfileLoadingNotice, { target, props: {} });
	flushSync();
	void unmount(instance);
	instance = null;
	assert.strictEqual(vi.getTimerCount(), 0);
});
