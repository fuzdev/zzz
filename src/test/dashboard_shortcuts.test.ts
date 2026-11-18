// @vitest-environment jsdom

import { test, describe, assert, afterEach } from 'vitest';

import { handle_dashboard_shortcut, type DashboardShortcutsApp } from '#lib/dashboard_shortcuts.ts';
import { FUZ_TERMINAL_KEYS_ATTRIBUTE } from '#lib/fuz_terminal/fuz_terminal_key_target.ts';

/** A stand-in app: its `Ui` state, and intents that set it as the real handlers do. */
interface TestApp extends DashboardShortcutsApp {
	show_sidebar: boolean;
	show_desk_menu: boolean;
	desk_pinned: boolean;
	toggle_desk_menu: (value?: boolean) => boolean;
}

const create_ui = (): TestApp => {
	const ui: TestApp = {
		show_sidebar: false,
		show_desk_menu: false,
		desk_pinned: false,
		toggle_desk_menu: (value = !ui.show_desk_menu) => (ui.show_desk_menu = value),
		get ui() {
			return ui;
		},
		intents: {
			desk_toggle: (input) => ({ show: ui.toggle_desk_menu(input?.show) }),
			sidebar_toggle: (input) => ({ show: (ui.show_sidebar = input?.show ?? !ui.show_sidebar) })
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
	app: DashboardShortcutsApp
): { event: KeyboardEvent; ran: boolean } => {
	let ran = false;
	const handler = (e: KeyboardEvent): void => {
		ran = handle_dashboard_shortcut(e, app);
	};
	window.addEventListener('keydown', handler, { capture: true });
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
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
});
