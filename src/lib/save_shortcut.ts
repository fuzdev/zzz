/**
 * The editors' save shortcut, Ctrl+S / Cmd+S — shared by `ContentEditor` and
 * `SourceEditor` so both save the same way.
 *
 * @module
 */

import { swallow } from '@fuzdev/fuz_util/dom.ts';

/**
 * Where an editor's save shortcut triggers its save: `'focused'` only while
 * its textarea has focus, `'page'` from anywhere on the page unless a focused
 * editor handles it first. Use `'page'` only for the one main editor of a page.
 */
export type SaveShortcutScope = 'focused' | 'page';

/**
 * Calls `save` on Ctrl+S / Cmd+S (case-insensitive, without Alt), swallowing
 * the event so the browser's save dialog never opens and a page-level
 * listener never saves a different editor than the focused one. An event a
 * handler already took (`defaultPrevented`) is ignored, and a held key saves
 * once per press.
 *
 * @param event - the keydown event
 * @param save - the editor's save, or nullish to let the event through untouched
 * @mutates event - swallowed (`preventDefault` + `stopImmediatePropagation`) when it's the shortcut
 */
export const handle_save_shortcut_keydown = (
	event: KeyboardEvent,
	save: (() => void) | null | undefined
): void => {
	if (!save || event.defaultPrevented) return;
	// case-insensitive so Caps Lock doesn't fall through to the browser's save dialog
	if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
		swallow(event);
		// a held key repeats — save once per press
		if (event.repeat) return;
		save();
	}
};
