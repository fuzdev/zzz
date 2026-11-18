// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfilePath } from '#lib/diskfile_types.ts';
import CommandPalette from '#lib/CommandPalette.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { write_diskfile } from './diskfile_tree_test_helpers.ts';

const MD = parse_or_throw(DiskfilePath, '/w/x.md');

let app: Frontend;
const cleanups: Array<() => void> = [];

// jsdom has no modal dialogs
const dialog_proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
const originals = { showModal: dialog_proto.showModal, close: dialog_proto.close };

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	dialog_proto.showModal = function (this: HTMLDialogElement) {
		this.open = true;
	};
	dialog_proto.close = function (this: HTMLDialogElement) {
		this.open = false;
	};
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/w/';
	write_diskfile(app, MD);
});

afterEach(() => {
	// unmount while the stubs are still in place
	for (const cleanup of cleanups.splice(0)) cleanup();
	dialog_proto.showModal = originals.showModal;
	dialog_proto.close = originals.close;
	app.dispose();
	vi.restoreAllMocks();
});

const render = (): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: CommandPalette, props: {} }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

const open = (): void => {
	app.intents.palette_toggle({ show: true });
	flushSync();
};

const get_input = (target: HTMLElement): HTMLInputElement => {
	const input = target.querySelector<HTMLInputElement>('input[role="combobox"]');
	assert.ok(input, 'the palette input');
	return input;
};

const options = (target: HTMLElement): Array<HTMLElement> =>
	Array.from(target.querySelectorAll<HTMLElement>('[role="option"]'));

const active_label = (target: HTMLElement): string | undefined => {
	const id = get_input(target).getAttribute('aria-activedescendant');
	return options(target)
		.find((o) => o.id === id)
		?.textContent.trim();
};

const type = (input: HTMLInputElement, text: string): void => {
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

const key = (input: HTMLInputElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
	input.dispatchEvent(event);
	flushSync();
	return event;
};

describe('CommandPalette', () => {
	test('opens on its intent with the input focused, the first command active', () => {
		const target = render();
		assert.isNull(target.querySelector('dialog'));
		open();
		const input = get_input(target);
		assert.strictEqual(document.activeElement, input);
		const list = target.querySelector('[role="listbox"]');
		assert.ok(list);
		assert.strictEqual(input.getAttribute('aria-controls'), list.id);
		const first = options(target)[0];
		assert.ok(first);
		assert.strictEqual(input.getAttribute('aria-activedescendant'), first.id);
		assert.strictEqual(first.getAttribute('aria-selected'), 'true');
	});

	test('typing filters, and Up and Down move the active command, wrapping', () => {
		const target = render();
		open();
		const input = get_input(target);
		type(input, 'desk');
		assert.deepEqual(
			options(target).map((o) => o.textContent.trim()),
			['show the desk menu', 'pin the desk menu']
		);
		assert.strictEqual(active_label(target), 'show the desk menu');
		assert.isTrue(key(input, 'ArrowDown').defaultPrevented);
		assert.strictEqual(active_label(target), 'pin the desk menu');
		key(input, 'ArrowDown');
		assert.strictEqual(active_label(target), 'show the desk menu');
		key(input, 'ArrowUp');
		assert.strictEqual(active_label(target), 'pin the desk menu');
		// typing again starts from the top
		type(input, 'desk m');
		assert.strictEqual(active_label(target), 'show the desk menu');
	});

	test('Enter closes the palette and runs the active command, one intent each', () => {
		const target = render();
		open();
		const input = get_input(target);
		type(input, 'pin the desk');
		assert.isTrue(key(input, 'Enter').defaultPrevented);
		assert.isFalse(app.ui.show_palette);
		assert.isTrue(app.ui.desk_pinned);
		assert.isNull(target.querySelector('dialog'));
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => [entry.method, entry.input]),
			[
				['palette_toggle', { show: true }],
				['palette_toggle', { show: false }],
				['desk_pin_toggle', { pinned: true }]
			],
			'the close lands before the command'
		);
	});

	test('a click runs the command clicked', () => {
		app.intents.tab_open({ path: MD });
		const target = render();
		open();
		const option = options(target).find((o) => o.textContent.trim() === 'show the markdown source');
		assert.ok(option);
		option.click();
		flushSync();
		assert.isFalse(app.ui.show_palette);
		assert.strictEqual(app.diskfiles.markdown_view_modes.get(MD), 'source');
	});

	test('no match says so, and Enter does nothing', () => {
		const target = render();
		open();
		const input = get_input(target);
		type(input, 'nothing like this');
		assert.strictEqual(options(target).length, 0);
		const list = target.querySelector('[role="listbox"]');
		assert.ok(list);
		assert.strictEqual(list.children.length, 0, 'the note is outside the listbox');
		assert.include(target.textContent, '[no matching commands]');
		assert.isFalse(input.hasAttribute('aria-activedescendant'));
		assert.isFalse(key(input, 'Enter').defaultPrevented);
		assert.isTrue(app.ui.show_palette);
	});

	test('Ctrl+K and Ctrl+Space in the input close it, swallowed, a held chord once', () => {
		const target = render();
		open();
		const held = key(get_input(target), 'k', { ctrlKey: true, repeat: true });
		assert.isTrue(held.defaultPrevented, 'never the browser’s own Ctrl+K');
		assert.isTrue(app.ui.show_palette);
		assert.isTrue(key(get_input(target), 'k', { ctrlKey: true }).defaultPrevented);
		assert.isFalse(app.ui.show_palette);
		open();
		key(get_input(target), ' ', { ctrlKey: true, code: 'Space' });
		assert.isFalse(app.ui.show_palette);
	});

	test('the Enter that confirms an input method’s text runs nothing', () => {
		const target = render();
		open();
		const event = key(get_input(target), 'Enter', { isComposing: true });
		assert.isFalse(event.defaultPrevented);
		assert.isTrue(app.ui.show_palette);
	});

	test('a press on the list keeps the focus in the input', () => {
		const target = render();
		open();
		const list = target.querySelector('[role="listbox"]');
		assert.ok(list);
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		options(target)[0]!.dispatchEvent(press);
		assert.isTrue(press.defaultPrevented);
	});

	test('reopening starts afresh', () => {
		const target = render();
		open();
		type(get_input(target), 'desk');
		key(get_input(target), 'ArrowDown');
		app.intents.palette_toggle({ show: false });
		flushSync();
		open();
		assert.strictEqual(get_input(target).value, '');
		assert.strictEqual(active_label(target), options(target)[0]?.textContent.trim());
	});

	test('the most recently used commands come first', () => {
		app.intents.desk_pin_toggle({ pinned: true });
		app.intents.desk_pin_toggle({ pinned: false });
		const target = render();
		open();
		assert.strictEqual(options(target)[0]?.textContent.trim(), 'pin the desk menu');
	});
});
