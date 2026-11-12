/**
 * What a terminal view takes from its environment — loading the emulator,
 * frames, a timer, resize observation, measuring, and the selection and
 * clipboard a copy reads and writes — as one interface with
 * browser defaults, provided through Svelte context so a test can step frames
 * and inject measurements without faking globals.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

import type { FuzTerminalFrameScheduler } from './fuz_terminal_frame.ts';
import type { FuzTerminalKeyPlatform } from './fuz_terminal_keyboard.ts';
import type { FuzTerminalMeasurement } from './fuz_terminal_layout.ts';
import { load_ghostty_vt, type GhosttyVt } from './ghostty_vt.ts';

/** A terminal view's capabilities. `create_fuz_terminal_deps` makes the browser's. */
export interface FuzTerminalDeps extends FuzTerminalFrameScheduler {
	/** Instantiate the compiled module into a new instance, owned by one view. */
	load_vt: (module: WebAssembly.Module) => Promise<GhosttyVt>;
	/** Run `callback` once after `ms` milliseconds, returning an id `clear_timeout` takes. */
	set_timeout: (callback: () => void, ms: number) => number;
	clear_timeout: (id: number) => void;
	/**
	 * Call `callback` whenever any of `elements` changes size (and once, soon,
	 * as `ResizeObserver` does), returning a function that stops observing.
	 */
	observe_resize: (elements: ReadonlyArray<Element>, callback: () => void) => () => void;
	/**
	 * The view's box and one cell, in CSS pixels — `root` is the element the
	 * rows fill, and `probe` a run of `probe.textContent` cells of the
	 * terminal's font — or `null` when there's no layout to measure.
	 */
	measure: (root: HTMLElement, probe: HTMLElement) => FuzTerminalMeasurement | null;
	/** Whose keyboard conventions the keys follow (`to_fuz_terminal_key_input`). */
	key_platform: FuzTerminalKeyPlatform;
	/**
	 * The page's selected text when the selection takes some of the view's
	 * `root`, else `''` (`get_fuz_terminal_selection_text`) — what a copy
	 * chord copies.
	 */
	read_selection: (root: HTMLElement) => string;
	/** Put text on the system clipboard; rejects when it can't. */
	write_clipboard: (text: string) => Promise<void>;
}

/**
 * The text of `selection` when one of its ranges selects some of `root`'s
 * text — something other than blanks — else `''`: as for a collapsed
 * selection, one that only touches the view's edge (a triple-click above it
 * ends at the view's start), or one of blank cells only. The whole
 * selection's text, even where it reaches outside the view: it's what the
 * user selected, and what the browser's own copy would take. Inside the
 * view that's the rows, and the status message when one shows (selectable,
 * so an error can be copied); the measuring probe and the cursor can't be
 * selected.
 */
export const get_fuz_terminal_selection_text = (
	selection: Selection | null,
	root: Node
): string => {
	if (selection === null) return '';
	for (let i = 0; i < selection.rangeCount; i++) {
		const range = selection.getRangeAt(i);
		if (!range.intersectsNode(root)) continue;
		// only the part inside the view counts: a range that just touches its
		// edge (a triple-click's end at the next block's start, a drag from the
		// rows' end down out of it) selects none of it
		const inside = range.cloneRange();
		if (!root.contains(range.startContainer)) inside.setStart(root, 0);
		if (!root.contains(range.endContainer)) inside.setEnd(root, root.childNodes.length);
		// the probe and the cursor hold text no selection takes, and the
		// template's whitespace between the view's elements is no one's text
		// (so a selection of blank cells alone takes none either)
		const contents = inside.cloneContents();
		// TODO: aria-hidden doubles as "not text" — an a11y rung that hides the rows needs its own marker
		for (const hidden of contents.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
		if (contents.textContent.trim() !== '') return selection.toString();
	}
	return '';
};

/**
 * The browser's clipboard write, `navigator.clipboard.writeText`: it needs a
 * secure context (`localhost` is one) and a user activation (a key press
 * is one); without the API it rejects saying so.
 */
const write_browser_clipboard = (text: string): Promise<void> => {
	const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
	if (clipboard === undefined) {
		return Promise.reject(
			new Error('the clipboard is unavailable here: it needs a secure context (https or localhost)')
		);
	}
	return clipboard.writeText(text);
};

/** The fields of `navigator` the platform is read from. */
export interface FuzTerminalNavigatorPlatform {
	readonly platform?: string;
	/** User-Agent Client Hints, where the browser has them (Chromium). */
	readonly userAgentData?: { readonly platform?: string };
}

/**
 * The keyboard platform a browser runs on: `mac` on macOS and iOS (where
 * Option types characters), else `other`. Reads the client hints' platform
 * where there are hints, else `navigator.platform`.
 */
export const to_fuz_terminal_key_platform = (
	navigator: FuzTerminalNavigatorPlatform | undefined
): FuzTerminalKeyPlatform => {
	const platform = navigator?.userAgentData?.platform || navigator?.platform || '';
	return /^(mac|iphone|ipad|ipod)/i.test(platform) ? 'mac' : 'other';
};

/**
 * The browser's capabilities: `load_ghostty_vt`, `requestAnimationFrame`,
 * `setTimeout`, `ResizeObserver` (nothing is observed where it doesn't
 * exist), layout reads, the platform from `navigator`, the document's
 * selection, and `navigator.clipboard`.
 */
export const create_fuz_terminal_deps = (): FuzTerminalDeps => ({
	load_vt: (module) => load_ghostty_vt(module),
	request_frame: (callback) => requestAnimationFrame(() => callback()),
	cancel_frame: (id) => cancelAnimationFrame(id),
	set_timeout: (callback, ms) => window.setTimeout(callback, ms),
	clear_timeout: (id) => window.clearTimeout(id),
	observe_resize: (elements, callback) => {
		if (typeof ResizeObserver === 'undefined') return () => {};
		const observer = new ResizeObserver(() => callback());
		for (const element of elements) observer.observe(element);
		return () => observer.disconnect();
	},
	measure: (root, probe) => {
		const cells = Array.from(probe.textContent).length;
		if (cells === 0) return null;
		const cell = probe.getBoundingClientRect();
		return {
			width: root.clientWidth,
			height: root.clientHeight,
			cell_width: cell.width / cells,
			cell_height: cell.height
		};
	},
	key_platform: to_fuz_terminal_key_platform(
		typeof navigator === 'undefined' ? undefined : navigator
	),
	read_selection: (root) =>
		get_fuz_terminal_selection_text(root.ownerDocument.getSelection(), root),
	write_clipboard: write_browser_clipboard
});

/**
 * The capabilities `FuzTerminal` uses, defaulting to the browser's
 * (`create_fuz_terminal_deps`); a test sets its own above the view.
 */
export const fuz_terminal_deps_context = create_context<FuzTerminalDeps>(create_fuz_terminal_deps);
