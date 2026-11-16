import { untrack } from 'svelte';
import { on } from 'svelte/events';
import type { Attachment } from 'svelte/attachments';

import { find_scroll_container } from './list_helpers.ts';

/**
 * Measures a windowed list (see `compute_list_window`): the height its rows
 * share, and where the visible area sits relative to the list. Attach
 * `measure` to the list element, whose children are the rendered rows; the
 * nearest scrolling ancestor (see `find_scroll_container`), or the page,
 * scrolls it.
 *
 * Every row must have the same height, measured as the distance between the
 * first two rows' tops (so margins count). The visible area is the
 * scroller's box clipped to the window, which keeps a scroller that isn't
 * height-constrained from rendering every row.
 */
export class ListViewport {
	/** `0` until the first rows render. */
	row_height: number = $state.raw(0);
	/** The top of the visible area, in pixels from the top of the list. */
	viewport_start: number = $state.raw(0);
	/** The bottom of the visible area, in pixels from the top of the list. */
	viewport_end: number = $state.raw(0);

	// not reactive — the attached list's scroller and measurement, for `scroll_into_view`
	#scroller: HTMLElement | null = null;
	#measure: (() => void) | null = null;

	#measure_window(list: HTMLElement, scroller: HTMLElement | null): void {
		const first = list.firstElementChild;
		if (first) {
			const first_rect = first.getBoundingClientRect();
			const second = first.nextElementSibling;
			const height = second
				? second.getBoundingClientRect().top - first_rect.top
				: first_rect.height;
			if (height > 0 && height !== this.row_height) this.row_height = height;
		}
		const list_top = list.getBoundingClientRect().top;
		let top = 0;
		let bottom = window.innerHeight;
		if (scroller) {
			const scroller_top = scroller.getBoundingClientRect().top;
			top = Math.max(top, scroller_top);
			bottom = Math.min(bottom, scroller_top + scroller.clientHeight);
		}
		const start = top - list_top;
		const end = bottom - list_top;
		if (start !== this.viewport_start) this.viewport_start = start;
		if (end !== this.viewport_end) this.viewport_end = end;
	}

	/** Measures the list it's attached to now, and whenever it or the layout moves. */
	measure: Attachment<HTMLElement> = (list) => {
		const scroller = find_scroll_container(list);

		// synchronous everywhere: scroll events fire at most once per frame and
		// resize observations after layout, both before paint, so the new window
		// renders in the same frame instead of painting a stale one
		const measure = () => this.#measure_window(list, scroller);
		this.#scroller = scroller;
		this.#measure = measure;

		// the first rows are in the DOM by now — measure before they paint
		untrack(measure);

		// captured at the window, so scrolling any ancestor (not only `scroller`) re-measures
		const cleanup_scroll = on(window, 'scroll', measure, { capture: true, passive: true });
		const cleanup_resize = on(window, 'resize', measure);
		// the list resizes when its row count or row height changes, the scroller when the layout does.
		// the list's border box (padding + rendered rows = count × row height) is observed, not the
		// default content box, whose height changes with the number of rendered rows as the window
		// shifts — a measure in the callback would then resize it again at the same depth, looping
		const observer = new ResizeObserver(measure);
		observer.observe(list, { box: 'border-box' });
		if (scroller) observer.observe(scroller);

		return () => {
			cleanup_scroll();
			cleanup_resize();
			observer.disconnect();
			if (this.#measure === measure) {
				this.#measure = null;
				this.#scroller = null;
			}
		};
	};

	/**
	 * The index of the first row whose top is in the visible area, of `count`
	 * rows — `0` before a measurement, and the last row when the area is past
	 * the end. A row clipped by a pixel or less still counts, since layout
	 * positions are fractional.
	 */
	first_visible_index(count: number): number {
		if (count <= 0) return 0;
		const { row_height, viewport_start } = this;
		if (!(row_height > 0)) return 0;
		return Math.min(count - 1, Math.max(0, Math.ceil((viewport_start - 1) / row_height)));
	}

	/**
	 * Scrolls the least distance that brings row `index` fully into the
	 * visible area — none when it's already there, or before a measurement —
	 * and measures again, so the window can include it before the next frame.
	 */
	scroll_into_view(index: number): void {
		const measure = this.#measure;
		if (!measure) return;
		untrack(measure);
		const { row_height, viewport_start, viewport_end } = untrack(() => ({
			row_height: this.row_height,
			viewport_start: this.viewport_start,
			viewport_end: this.viewport_end
		}));
		if (!(row_height > 0)) return;
		const top = index * row_height;
		const bottom = top + row_height;
		const delta =
			top < viewport_start
				? top - viewport_start
				: bottom > viewport_end
					? bottom - viewport_end
					: 0;
		if (!delta) return;
		if (this.#scroller) {
			this.#scroller.scrollTop += delta;
		} else {
			window.scrollBy(0, delta);
		}
		// now, not on the scroll event a frame later, so a caller can render the row right away
		untrack(measure);
	}
}
