// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import { Thread } from '#lib/thread.svelte.ts';
import { Turn } from '#lib/turn.svelte.ts';
import TurnContextmenu from '#lib/TurnContextmenu.svelte';

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
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(
		new Frontend({ models: [{ name: 'test-model', provider_name: 'claude' }] })
	);
	app.zzz_dir = '/w/';
	disk = install_fake_disk(app, '/w/');
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const render = (turn: Turn): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: ContextmenuHarness, props: { menu: TurnContextmenu, props: { turn } } }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

const find_copy_entry = (target: HTMLElement): HTMLElement | undefined =>
	Array.from(target.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) =>
		el.textContent.includes('copy content')
	);

/** Opens the menu and its "turn" submenu (submenus open on hover, a tick later). */
const open_turn_submenu = async (target: HTMLElement): Promise<void> => {
	const el = target.querySelector('.contextmenu-target');
	assert.ok(el);
	el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
	);
	flushSync();
	const item = Array.from(target.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
		(e) => e.textContent.trim() === 'turn'
	);
	assert.ok(item, 'a "turn" submenu');
	item.dispatchEvent(new MouseEvent('mouseenter'));
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
};

describe('TurnContextmenu copy content', () => {
	test('"copy again" after a refused write copies what was loaded, without reading again', async () => {
		const write_text = vi
			.fn((_text: string) => Promise.resolve())
			.mockImplementationOnce(() => Promise.reject(new Error('not allowed')));
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write_text },
			configurable: true
		});
		disk.write('/w/a.txt', 'text');
		disk.fail_reads(10, 'permission denied'); // every read fails
		const thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));
		const part = app.parts.add({ type: 'diskfile', path: '/w/a.txt' });
		const turn = new Turn({ app, json: { role: 'user', part_ids: [part.id] } });
		thread.add_turn(turn);
		await flush_reads();
		const marker = '[a.txt: content not loaded — permission denied]';
		assert.strictEqual(turn.content, marker);
		disk.reads.length = 0;

		const target = render(turn);
		await open_turn_submenu(target);
		find_copy_entry(target)!.click();
		for (let i = 0; i < 3; i++) await flush_reads();
		flushSync();
		const entry = find_copy_entry(target);
		assert.ok(entry, 'the menu stays open');
		assert.strictEqual(entry.getAttribute('title'), 'Error: loaded — copy again');
		assert.deepEqual(disk.reads, ['/w/a.txt']);
		assert.isTrue(turn.content_pending_read, 'still failing, so a click would load again');

		vi.useFakeTimers();
		try {
			entry.click();
			vi.advanceTimersByTime(1);
			assert.deepEqual(write_text.mock.calls, [[marker], [marker]], 'copied at once');
		} finally {
			vi.useRealTimers();
		}
		await flush_reads();
		assert.deepEqual(disk.reads, ['/w/a.txt'], 'no second read');
	});

	test('reads a failed file part once more on click, copying its text', async () => {
		const write_text = vi.fn((_text: string) => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: write_text },
			configurable: true
		});
		disk.write('/w/a.txt', 'text');
		disk.fail_reads(1, 'connection lost');
		const thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));
		const part = app.parts.add({ type: 'diskfile', path: '/w/a.txt' });
		const turn = new Turn({ app, json: { role: 'user', part_ids: [part.id] } });
		thread.add_turn(turn);
		await flush_reads();
		assert.strictEqual(turn.content, '[a.txt: content not loaded — connection lost]');
		disk.reads.length = 0;

		const target = render(turn);
		await open_turn_submenu(target);
		const entry = find_copy_entry(target);
		assert.ok(entry);
		entry.click();
		for (let i = 0; i < 3; i++) await flush_reads();
		assert.deepEqual(disk.reads, ['/w/a.txt'], 'one retry');
		assert.deepEqual(write_text.mock.calls, [['text']]);
	});
});
