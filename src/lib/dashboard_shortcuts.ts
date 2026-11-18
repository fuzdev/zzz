/**
 * The dashboard's global keyboard shortcuts, run in the capture phase on
 * `window` so they win over whatever has focus: Ctrl+K and Ctrl+Space toggle
 * the command palette, backtick toggles the sidebar, `~` the desk menu, and
 * Escape closes an open, unpinned desk menu.
 *
 * A key meant for what has focus is left alone: one typed into a text field,
 * or into a terminal view that takes keys (`is_fuz_terminal_key_target`),
 * where every key — a backtick, a `~`, Escape, Ctrl+K (kill-line), Ctrl+Space
 * (NUL) — may be the program's.
 *
 * @module
 */

import { is_editable, swallow } from '@fuzdev/fuz_util/dom.ts';

import { is_fuz_terminal_key_target } from './fuz_terminal/fuz_terminal_key_target.ts';
import type { FrontendIntentsApi } from './intent_spec.ts';

/** What the shortcuts read (the app's `Ui`) and call (its intents). */
export interface DashboardShortcutsApp {
	readonly ui: {
		readonly show_desk_menu: boolean;
		readonly desk_pinned: boolean;
	};
	readonly intents: Pick<FrontendIntentsApi, 'desk_toggle' | 'sidebar_toggle' | 'palette_toggle'>;
}

/** The palette's shortcuts, as shown in the UI — Ctrl on every platform. */
export const PALETTE_SHORTCUTS = 'Ctrl+K or Ctrl+Space';

/**
 * Whether a keydown is one of the palette's shortcuts: Ctrl+K, or Ctrl+Space
 * (an input method switch on some systems, so Ctrl+K comes first). Ctrl on
 * every platform, like the markdown view's shortcuts. K is matched by the
 * character it types, so a Dvorak K is K, and by its physical key only on a
 * layout whose key there types no ASCII letter (Cyrillic, Greek).
 */
export const is_palette_shortcut = (
	event: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'key' | 'code'>
): boolean =>
	event.ctrlKey &&
	!event.shiftKey &&
	!event.altKey &&
	!event.metaKey &&
	(event.key === 'k' ||
		event.key === 'K' ||
		(event.code === 'KeyK' && !/^[\x20-\x7e]$/.test(event.key)) ||
		event.code === 'Space');

/** Whether a modal `<dialog>` is open — fuz_ui's `Dialog` opens one with `showModal`. */
export const has_open_modal_dialog = (): boolean => {
	for (const dialog of document.querySelectorAll('dialog[open]')) {
		if (dialog.matches(':modal')) return true;
	}
	return false;
};

/** Whether a key event belongs to what has focus, so no shortcut takes it. */
export const is_dashboard_shortcut_excluded = (target: EventTarget | null): boolean =>
	is_editable(target) || is_fuz_terminal_key_target(target);

/**
 * Run the shortcut `event` is, if any, swallowing it.
 *
 * @returns whether a shortcut ran
 */
export const handle_dashboard_shortcut = (
	event: KeyboardEvent,
	app: DashboardShortcutsApp
): boolean => {
	if (is_dashboard_shortcut_excluded(event.target)) return false;
	const { ui, intents } = app;
	if (is_palette_shortcut(event)) {
		// the browser's own Ctrl+K (its search bar) stays shut either way; a modal dialog over the
		// page keeps the palette from stacking on it
		swallow(event);
		if (!event.repeat && !has_open_modal_dialog()) intents.palette_toggle();
		return true;
	}
	// a modal dialog's Escape is its own, closing it, not the desk menu behind it
	if (event.key === 'Escape' && ui.show_desk_menu && !ui.desk_pinned && !has_open_modal_dialog()) {
		intents.desk_toggle({ show: false });
	} else if (event.key === '~') {
		intents.desk_toggle();
	} else if (event.key === '`') {
		intents.sidebar_toggle();
	} else {
		return false;
	}
	swallow(event);
	return true;
};
