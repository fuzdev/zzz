/**
 * Scroll sync between the markdown view's editor and preview, in lockstep:
 * whichever pane the user is driving leads, and the other follows it,
 * aligned on the rendered blocks (`to_markdown_scroll_anchors`) — between
 * two anchors, each pane is interpolated linearly, so the follower moves
 * smoothly as the leader scrolls through a block.
 *
 * The leader is the pane the user last touched — a wheel, a pointer press,
 * a touch, a key, or the focus entering it — and only its scrolls sync. A
 * follower scrolled by a sync doesn't sync back, so there's no feedback
 * loop to guard against with timers or expected positions.
 *
 * The mapping is `to_synced_scroll_top`, a pure function the class only
 * feeds measurements; another policy (say, the preview following only the
 * caret's block) is a different caller of the same pieces.
 *
 * @module
 */

import type { Attachment } from 'svelte/attachments';
import { clamp } from '@fuzdev/fuz_util/maths.ts';

import type { MarkdownScrollAnchor } from './markdown_source_map.ts';

export type MarkdownScrollSide = 'editor' | 'preview';

/** A pane's scroll position and extent. */
export interface MarkdownScrollMetrics {
	scroll_top: number;
	/** The height of the scrolled content. */
	scroll_height: number;
	/** The height of the visible part. */
	client_height: number;
}

const to_scroll_metrics = (element: Element): MarkdownScrollMetrics => ({
	scroll_top: element.scrollTop,
	scroll_height: element.scrollHeight,
	client_height: element.clientHeight
});

/**
 * The scroll position for the follower that matches the leader's, mapped
 * through `count` shared anchors: `from_y(i)` and `to_y(i)` are the `i`th
 * anchor's content y in the leader and the follower, each non-decreasing in
 * `i` (out-of-order measurements land somewhere in their segment, never
 * outside it). The content's top and bottom anchor both panes too. Over the
 * leader's last screenful the result eases to the follower's bottom, so both
 * reach their ends together, without a jump on the last step.
 *
 * Measures lazily — a binary search over the leader's anchors, then the
 * follower's two around it — so a sync costs a few measurements, not one per
 * block.
 *
 * @param count - the number of anchors
 * @param from_y - the leader's content y of an anchor, `null` when it can't be measured
 * @param to_y - the follower's content y of an anchor, `null` when it can't be measured
 * @param from - the leader's scroll metrics
 * @param to - the follower's scroll metrics
 * @returns the follower's `scrollTop`, or `null` when a needed anchor couldn't be measured
 */
export const to_synced_scroll_top = (
	count: number,
	from_y: (index: number) => number | null,
	to_y: (index: number) => number | null,
	from: MarkdownScrollMetrics,
	to: MarkdownScrollMetrics
): number | null => {
	const from_max = Math.max(0, from.scroll_height - from.client_height);
	const to_max = Math.max(0, to.scroll_height - to.client_height);
	const top = clamp(from.scroll_top, 0, from_max);

	// point `k` of `count + 2`: the content's top, the anchors, the content's bottom
	const point_from = (k: number): number | null =>
		k === 0 ? 0 : k === count + 1 ? from.scroll_height : from_y(k - 1);
	const point_to = (k: number): number | null =>
		k === 0 ? 0 : k === count + 1 ? to.scroll_height : to_y(k - 1);

	// the last point at or above the leader's top - point 0 always is
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		const y = point_from(mid);
		if (y === null) return null;
		if (y <= top) lo = mid;
		else hi = mid - 1;
	}

	const from_a = point_from(lo);
	const from_b = point_from(lo + 1);
	const to_a = point_to(lo);
	const to_b = point_to(lo + 1);
	if (from_a === null || from_b === null || to_a === null || to_b === null) return null;
	const fraction = from_b > from_a ? clamp((top - from_a) / (from_b - from_a), 0, 1) : 0;
	let mapped = to_a + fraction * (to_b - to_a);

	const window = Math.min(from.client_height, from_max);
	if (window > 0 && top > from_max - window) {
		mapped += ((top - (from_max - window)) / window) * (to_max - mapped);
	}
	return clamp(mapped, 0, to_max);
};

/** A pane as scroll sync sees it. */
export interface MarkdownScrollPane {
	/** The scrolling element. */
	element: HTMLElement;
	/**
	 * The content y of `anchor` in this pane — the `scrollTop` that puts it at
	 * the pane's top edge — or `null` when it can't be measured.
	 */
	measure: (anchor: MarkdownScrollAnchor) => number | null;
}

/**
 * The content ys of an element's top and bottom inside `container`, the
 * element scrolling it — where a `scrollTop` of `top` puts the element at
 * the container's top edge.
 */
export const measure_element_extent = (
	container: HTMLElement,
	element: Element
): { top: number; bottom: number } => {
	const rect = element.getBoundingClientRect();
	const base = container.getBoundingClientRect().top + container.clientTop - container.scrollTop;
	return { top: rect.top - base, bottom: rect.bottom - base };
};

/**
 * The content y of an element's top or bottom inside `container`, the
 * element scrolling it — how the preview measures its anchors.
 */
export const measure_element_anchor = (
	container: HTMLElement,
	anchor: MarkdownScrollAnchor
): number => {
	const extent = measure_element_extent(container, anchor.element);
	return anchor.edge === 'top' ? extent.top : extent.bottom;
};

export interface MarkdownScrollSyncOptions {
	/** The editor pane, or `null` when it isn't shown. */
	get_editor: () => MarkdownScrollPane | null;
	/** The preview pane, or `null` when it isn't shown. */
	get_preview: () => MarkdownScrollPane | null;
	/** The anchors of the preview's current render, from `to_markdown_scroll_anchors`. */
	get_anchors: () => ReadonlyArray<MarkdownScrollAnchor>;
	/**
	 * Called once per frame in which anything inside the attached element
	 * scrolled, it resized, or `refresh` asked — after that frame's sync, in
	 * any layout, panes not synced included. For what reads where the panes
	 * are, like the outline's highlight, so it shares the sync's frame.
	 */
	onframe?: (() => void) | undefined;
}

/**
 * Keeps the editor and preview scrolled together (see the module comment).
 * A plain class with no runes — its state changes per scroll frame and
 * nothing renders it. Mount it with `attach` on an element holding both
 * panes, and `destroy` it with its component.
 */
export class MarkdownScrollSync {
	readonly #options: MarkdownScrollSyncOptions;
	#leader: MarkdownScrollSide | null = null;
	#frame: number | null = null;
	#sync_due = false;

	constructor(options: MarkdownScrollSyncOptions) {
		this.#options = options;
	}

	/** The pane the user last touched, whose scrolls the other follows. */
	get leader(): MarkdownScrollSide | null {
		return this.#leader;
	}

	/** Makes `side` the leader. */
	lead(side: MarkdownScrollSide): void {
		this.#leader = side;
	}

	/**
	 * A pane scrolled: the leader's scroll moves the other, a follower's moves
	 * nothing, and either runs `onframe`.
	 */
	handle_scroll(side: MarkdownScrollSide): void {
		if (side === this.#leader) this.#sync_due = true;
		this.#schedule();
	}

	/**
	 * The layout changed — the preview re-rendered, a pane resized — so
	 * realign the follower, and run `onframe`.
	 */
	refresh(): void {
		if (this.#leader) this.#sync_due = true;
		this.#schedule();
	}

	/**
	 * Aligns the follower to the leader now.
	 *
	 * @returns whether the follower was scrolled
	 */
	sync(): boolean {
		const leader = this.#leader;
		if (!leader) return false;
		const editor = this.#options.get_editor();
		const preview = this.#options.get_preview();
		if (!editor || !preview) return false;
		const [from, to] = leader === 'editor' ? [editor, preview] : [preview, editor];
		const anchors = this.#options.get_anchors();
		const top = to_synced_scroll_top(
			anchors.length,
			(i) => from.measure(anchors[i]!),
			(i) => to.measure(anchors[i]!),
			to_scroll_metrics(from.element),
			to_scroll_metrics(to.element)
		);
		if (top === null || Math.abs(to.element.scrollTop - top) < 1) return false;
		to.element.scrollTop = top;
		return true;
	}

	/** Cancels a pending frame. */
	destroy(): void {
		if (this.#frame !== null) cancelAnimationFrame(this.#frame);
		this.#frame = null;
		this.#sync_due = false;
	}

	/** One frame, however many scrolls and renders asked - none when it has nothing to do. */
	#schedule(): void {
		if (!this.#sync_due && !this.#options.onframe) return;
		if (this.#frame !== null || typeof requestAnimationFrame !== 'function') return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = null;
			if (this.#sync_due) {
				this.#sync_due = false;
				this.sync();
			}
			this.#options.onframe?.();
		});
	}

	/** Which pane `target` is in, if either. */
	#side_of(target: EventTarget | null): MarkdownScrollSide | null {
		if (!(target instanceof Node)) return null;
		if (this.#options.get_editor()?.element.contains(target)) return 'editor';
		if (this.#options.get_preview()?.element.contains(target)) return 'preview';
		return null;
	}

	/**
	 * Listens on an element holding both panes: input inside a pane makes it
	 * the leader, a pane's scroll syncs, and a resize realigns.
	 */
	readonly attach: Attachment<HTMLElement> = (el) => {
		const handle_input = (event: Event): void => {
			const side = this.#side_of(event.target);
			if (side) this.lead(side);
		};
		const handle_scroll = (event: Event): void => {
			// only a pane's own scrolls sync - the editor's highlight backdrop scrolls along with it -
			// but any scroll can move what `onframe` reads, like a pane shown alone, which isn't synced
			const { target } = event;
			if (target === this.#options.get_editor()?.element) this.handle_scroll('editor');
			else if (target === this.#options.get_preview()?.element) this.handle_scroll('preview');
			else this.#schedule();
		};
		const input_events = ['wheel', 'pointerdown', 'touchstart', 'keydown', 'focusin'] as const;
		const listener_options = { capture: true, passive: true };
		for (const type of input_events) el.addEventListener(type, handle_input, listener_options);
		// scroll doesn't bubble, but it's captured on the way to the pane
		el.addEventListener('scroll', handle_scroll, listener_options);
		const resize_observer =
			typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.refresh()) : null;
		resize_observer?.observe(el);
		return () => {
			for (const type of input_events) el.removeEventListener(type, handle_input, listener_options);
			el.removeEventListener('scroll', handle_scroll, listener_options);
			resize_observer?.disconnect();
		};
	};
}
