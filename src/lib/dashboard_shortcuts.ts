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
import type { FrontendIntentsApi } from './intent_spec.ts';

/** What the shortcuts read (the app's `Ui`) and call (its intents). */
export interface DashboardShortcutsApp {
	readonly ui: {
		readonly show_desk_menu: boolean;
		readonly desk_pinned: boolean;
	};
	readonly intents: Pick<FrontendIntentsApi, 'desk_toggle' | 'sidebar_toggle'>;
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
	app: DashboardShortcutsApp
): boolean => {
	if (is_dashboard_shortcut_excluded(event.target)) return false;
	const { ui, intents } = app;
	if (event.key === 'Escape' && ui.show_desk_menu && !ui.desk_pinned) {
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
