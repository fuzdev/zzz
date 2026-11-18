// @vitest-environment jsdom

import { test, describe, assert, afterEach } from 'vitest';

import { handle_dashboard_shortcut, type DashboardShortcutsApp } from '#lib/dashboard_shortcuts.ts';
import { FUZ_TERMINAL_KEYS_ATTRIBUTE } from '#lib/fuz_terminal/fuz_terminal_key_target.ts';

/** A stand-in app: its `Ui` state, and intents that set it as the real handlers do. */
interface TestApp extends DashboardShortcutsApp {
	show_sidebar: boolean;
	show_desk_menu: boolean;
	show_palette: boolean;
	desk_pinned: boolean;
	toggle_desk_menu: (value?: boolean) => boolean;
}

const create_ui = (): TestApp => {
	const ui: TestApp = {
		show_sidebar: false,
		show_desk_menu: false,
		show_palette: false,
		desk_pinned: false,
		toggle_desk_menu: (value = !ui.show_desk_menu) => (ui.show_desk_menu = value),
		get ui() {
			return ui;
		},
		intents: {
			desk_toggle: (input) => ({ show: ui.toggle_desk_menu(input?.show) }),
			sidebar_toggle: (input) => ({ show: (ui.show_sidebar = input?.show ?? !ui.show_sidebar) }),
			palette_toggle: (input) => ({ show: (ui.show_palette = input?.show ?? !ui.show_palette) })
		}
	};
	return ui;
};

const elements: Array<Element> = [];
afterEach(() => {
	for (const element of elements.splice(0)) element.remove();
});

const add = <T extends Element>(element: T): T => {
	document.body.append(element);
	elements.push(element);
	return element;
};

/** Dispatch a keydown on `target`, running the handler as `Dashboard` does: on `window`, in capture. */
const press = (
	target: Element,
	key: string,
	app: DashboardShortcutsApp,
	init: KeyboardEventInit = {}
): { event: KeyboardEvent; ran: boolean } => {
	let ran = false;
	const handler = (e: KeyboardEvent): void => {
		ran = handle_dashboard_shortcut(e, app);
	};
	window.addEventListener('keydown', handler, { capture: true });
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	window.removeEventListener('keydown', handler, { capture: true });
	return { event, ran };
};

describe('handle_dashboard_shortcut', () => {
	test('backtick, tilde, and Escape run from an ordinary target, swallowed', () => {
		const ui = create_ui();
		const button = add(document.createElement('button'));
		assert.ok(press(button, '`', ui).event.defaultPrevented);
		assert.isTrue(ui.show_sidebar);
		press(button, '~', ui);
		assert.isTrue(ui.show_desk_menu);
		press(button, 'Escape', ui);
		assert.isFalse(ui.show_desk_menu);
	});

	test('Escape leaves a pinned or closed desk menu alone', () => {
		const ui = create_ui();
		const button = add(document.createElement('button'));
		assert.isFalse(press(button, 'Escape', ui).ran);
		ui.toggle_desk_menu(true);
		ui.desk_pinned = true;
		assert.isFalse(press(button, 'Escape', ui).ran);
		assert.isTrue(ui.show_desk_menu);
	});

	test('a text field keeps its keys', () => {
		const ui = create_ui();
		const input = add(document.createElement('input'));
		for (const key of ['`', '~']) {
			const { event, ran } = press(input, key, ui);
			assert.isFalse(ran || event.defaultPrevented, key);
		}
		assert.isFalse(ui.show_sidebar || ui.show_desk_menu);
	});

	test('a terminal taking keys keeps them, an element inside it included', () => {
		const ui = create_ui();
		ui.toggle_desk_menu(true);
		const root = add(document.createElement('div'));
		root.setAttribute(FUZ_TERMINAL_KEYS_ATTRIBUTE, '');
		const row = root.appendChild(document.createElement('span'));
		for (const target of [root, row]) {
			for (const key of ['`', '~', 'Escape']) {
				const { event, ran } = press(target, key, ui);
				assert.isFalse(ran || event.defaultPrevented, key);
			}
		}
		assert.isFalse(ui.show_sidebar);
		assert.isTrue(ui.show_desk_menu);
		// one that stops taking keys drops the attribute, and the shortcuts apply again
		root.removeAttribute(FUZ_TERMINAL_KEYS_ATTRIBUTE);
		assert.isTrue(press(row, '`', ui).ran);
	});

	test('Ctrl+K and Ctrl+Space open the palette, swallowed', () => {
		const ui = create_ui();
		const button = add(document.createElement('button'));
		assert.ok(press(button, 'k', ui, { ctrlKey: true }).event.defaultPrevented);
		assert.isTrue(ui.show_palette);
		ui.show_palette = false;
		press(button, ' ', ui, { ctrlKey: true, code: 'Space' });
		assert.isTrue(ui.show_palette);
		// a held chord's repeats are swallowed but toggle nothing
		ui.show_palette = false;
		const held = press(button, 'k', ui, { ctrlKey: true, repeat: true });
		assert.isTrue(held.event.defaultPrevented);
		assert.isFalse(ui.show_palette);
	});

	test('the palette leaves other chords alone', () => {
		const ui = create_ui();
		const button = add(document.createElement('button'));
		for (const init of [
			{ ctrlKey: true, shiftKey: true },
			{ ctrlKey: true, altKey: true },
			{ ctrlKey: true, metaKey: true },
			{ metaKey: true },
			{}
		]) {
			const { event, ran } = press(button, 'k', ui, init);
			assert.isFalse(ran || event.defaultPrevented, JSON.stringify(init));
		}
		assert.isFalse(ui.show_palette);
	});

	test('Ctrl+K and Ctrl+Space open the palette from a text field, but a terminal keeps them', () => {
		const ui = create_ui();
		const input = add(document.createElement('textarea'));
		for (const [key, code] of [
			['k', 'KeyK'],
			[' ', 'Space']
		] as const) {
			ui.show_palette = false;
			assert.ok(press(input, key, ui, { ctrlKey: true, code }).event.defaultPrevented, key);
			assert.isTrue(ui.show_palette, key);
		}
		ui.show_palette = false;
		const terminal = add(document.createElement('div'));
		terminal.setAttribute(FUZ_TERMINAL_KEYS_ATTRIBUTE, '');
		for (const [key, code] of [
			['k', 'KeyK'],
			[' ', 'Space']
		] as const) {
			const { event, ran } = press(terminal, key, ui, { ctrlKey: true, code });
			assert.isFalse(ran || event.defaultPrevented, key);
		}
		assert.isFalse(ui.show_palette);
	});

	test('the open palette gets its own chord, to close itself, the browser kept out', () => {
		const ui = create_ui();
		ui.show_palette = true;
		const input = add(document.createElement('input'));
		let reached = false;
		input.addEventListener('keydown', () => (reached = true));
		const { event, ran } = press(input, 'k', ui, { ctrlKey: true });
		assert.isFalse(ran);
		assert.isTrue(reached, 'the palette input still gets it');
		assert.isTrue(event.defaultPrevented, "the browser's Ctrl+K stays shut");
		assert.isTrue(ui.show_palette);
		// focus dropped out of the palette (a click on its padding) — still never the browser's
		const outside = press(document.body, 'k', ui, { ctrlKey: true });
		assert.isTrue(outside.event.defaultPrevented);
		assert.isTrue(ui.show_palette);
	});

	test("an input method's Ctrl+Space in a text field stays the IME's", () => {
		const ui = create_ui();
		const input = add(document.createElement('input'));
		for (const init of [
			{ isComposing: true },
			{ key: 'Process' },
			{ keyCode: 229 }
		] as Array<KeyboardEventInit>) {
			const { event, ran } = press(input, init.key ?? ' ', ui, {
				ctrlKey: true,
				code: 'Space',
				...init
			});
			assert.isFalse(ran || event.defaultPrevented, JSON.stringify(init));
		}
		assert.isFalse(ui.show_palette);
	});

	test('Ctrl+K on a layout whose K key types no ASCII letter, but not a Dvorak K', () => {
		const ui = create_ui();
		const button = add(document.createElement('button'));
		press(button, 'л', ui, { ctrlKey: true, code: 'KeyK' });
		assert.isTrue(ui.show_palette);
		// Dvorak's physical K types `t`
		const { ran } = press(button, 't', ui, { ctrlKey: true, code: 'KeyK' });
		assert.isFalse(ran);
		assert.isTrue(ui.show_palette);
	});

	test('Escape under a modal dialog is the dialog’s, not the desk menu’s', () => {
		const ui = create_ui();
		ui.toggle_desk_menu(true);
		const button = add(document.createElement('button'));
		const dialog = add(document.createElement('dialog'));
		dialog.setAttribute('open', '');
		const matches = dialog.matches.bind(dialog);
		Object.defineProperty(dialog, 'matches', {
			value: (selector: string) => selector === ':modal' || matches(selector)
		});
		const { event, ran } = press(button, 'Escape', ui);
		assert.isFalse(ran || event.defaultPrevented);
		assert.isTrue(ui.show_desk_menu);
	});

	test('a modal dialog keeps the palette from opening over it, the chord still swallowed', () => {
		const ui = create_ui();
		const button = add(document.createElement('button'));
		const dialog = add(document.createElement('dialog'));
		// jsdom has no `showModal`, so the dialog claims `:modal` itself
		dialog.setAttribute('open', '');
		const matches = dialog.matches.bind(dialog);
		// `defineProperty`, not assignment: lib.dom types `matches` with type-predicate overloads
		Object.defineProperty(dialog, 'matches', {
			value: (selector: string) => selector === ':modal' || matches(selector)
		});
		assert.ok(press(button, 'k', ui, { ctrlKey: true }).event.defaultPrevented);
		assert.isFalse(ui.show_palette);
	});
});
