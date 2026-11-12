/**
 * The dashboard's global keyboard shortcuts, run in the capture phase on
 * `window` so they win over whatever has focus: backtick toggles the sidebar,
 * `~` the desk menu, and Escape closes an open, unpinned desk menu.
 *
 * A key meant for what has focus is left alone: one typed into a text field,
 * or into a terminal view that takes keys (`is_fuz_terminal_key_target`),
 * where every key — a backtick, a `~`, Escape — may be the program's.
 *
 * @module
 */

import { is_editable, swallow } from '@fuzdev/fuz_util/dom.ts';

import { is_fuz_terminal_key_target } from './fuz_terminal/fuz_terminal_key_target.ts';

/** What the shortcuts read and toggle — the app's `Ui`. */
export interface DashboardShortcutsUi {
	readonly show_desk_menu: boolean;
	readonly desk_pinned: boolean;
	toggle_desk_menu: (value?: boolean) => unknown;
	toggle_sidebar: (value?: boolean) => unknown;
}

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
	ui: DashboardShortcutsUi
): boolean => {
	if (is_dashboard_shortcut_excluded(event.target)) return false;
	if (event.key === 'Escape' && ui.show_desk_menu && !ui.desk_pinned) {
		ui.toggle_desk_menu(false);
	} else if (event.key === '~') {
		ui.toggle_desk_menu();
	} else if (event.key === '`') {
		ui.toggle_sidebar();
	} else {
		return false;
	}
	swallow(event);
	return true;
};
