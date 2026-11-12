// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { create_uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { Frontend } from '#lib/frontend.svelte.ts';

import TerminalRunItemHarness from './TerminalRunItemHarness.svelte';
import { create_test_fuz_terminal_deps } from './fuz_terminal/fuz_terminal_test_helpers.ts';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { stub_terminal_api } from './terminal_test_helpers.ts';

// the module never loads: the entry's gating is the run item's, not the view's
vi.mock('#lib/fuz_terminal_module.ts', () => ({
	load_fuz_terminal_module: () => new Promise(() => {})
}));

const cleanups: Array<() => void> = [];

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
	vi.unstubAllGlobals();
});

const find_paste_entry = (): HTMLElement | undefined =>
	Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
		(el) => el.textContent.trim() === 'paste'
	);

const open_menu = (target: HTMLElement): void => {
	const el = target.querySelector('.terminal-run-item');
	assert.ok(el);
	el.dispatchEvent(
		new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
	);
	flushSync();
};

describe('TerminalRunItem paste entry', () => {
	test('enabled while the process takes input, disabled once it ended', () => {
		const app = monkeypatch_zzz_for_tests(new Frontend());
		stub_terminal_api(app);
		const terminal = app.terminals.add({ command: 'sh' });
		terminal.start(create_uuid());
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(TerminalRunItemHarness, {
			target,
			props: { deps: create_test_fuz_terminal_deps(() => new Promise(() => {})), terminal }
		});
		flushSync();
		cleanups.push(() => {
			void unmount(mounted);
			target.remove();
			flushSync();
		});
		open_menu(target);
		assert.strictEqual(find_paste_entry()?.getAttribute('aria-disabled'), 'false');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		flushSync();
		terminal.receive_exited(0);
		flushSync();
		open_menu(target);
		assert.strictEqual(find_paste_entry()?.getAttribute('aria-disabled'), 'true');
	});
});
