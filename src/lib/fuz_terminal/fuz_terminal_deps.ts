/**
 * What a terminal view takes from its environment — loading the emulator,
 * frames, a timer, resize observation, and measuring — as one interface with
 * browser defaults, provided through Svelte context so a test can step frames
 * and inject measurements without faking globals.
 *
 * @module
 */

import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';

import type { FuzTerminalFrameScheduler } from './fuz_terminal_frame.ts';
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
}

/**
 * The browser's capabilities: `load_ghostty_vt`, `requestAnimationFrame`,
 * `setTimeout`, `ResizeObserver` (nothing is observed where it doesn't
 * exist), and layout reads.
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
	}
});

/**
 * The capabilities `FuzTerminal` uses, defaulting to the browser's
 * (`create_fuz_terminal_deps`); a test sets its own above the view.
 */
export const fuz_terminal_deps_context = create_context<FuzTerminalDeps>(create_fuz_terminal_deps);
