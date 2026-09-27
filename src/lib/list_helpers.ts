/**
 * Reorders an array, mutating it by moving an item from one index to another.
 */
export const reorder_list = (items: Array<any>, from_index: number, to_index: number): void => {
	if (from_index === to_index) return;

	// Validate indices
	if (from_index < 0 || to_index < 0 || from_index >= items.length || to_index > items.length) {
		console.error(
			`Invalid indices: from ${from_index} to ${to_index} in array of length ${items.length}`
		);
		return; // Better to return than throw here
	}

	// Perform the reorder
	const [moved] = items.splice(from_index, 1);
	items.splice(to_index, 0, moved);
};

/**
 * Creates a new reordered array without modifying the original.
 */
export const to_reordered_list = <T>(
	items: Array<T>,
	from_index: number,
	to_index: number
): Array<T> => {
	if (from_index === to_index) return items;

	// Validate indices
	if (from_index < 0 || to_index < 0 || from_index >= items.length || to_index > items.length) {
		console.error(
			`Invalid indices: from ${from_index} to ${to_index} in array of length ${items.length}`
		);
		return items;
	}

	const item_moved = items[from_index];
	if (item_moved === undefined) {
		// Defensive check: should never happen due to validation above
		console.error('Unexpected undefined item at validated index', from_index);
		return items;
	}

	if (from_index < to_index) {
		// Moving forward: take slices before and after the move, skipping the moved item
		return [
			...items.slice(0, from_index),
			...items.slice(from_index + 1, to_index + 1),
			item_moved,
			...items.slice(to_index + 1)
		];
	} else {
		// Moving backward: take slices before and after the move, skipping the moved item
		return [
			...items.slice(0, to_index),
			item_moved,
			...items.slice(to_index, from_index),
			...items.slice(from_index + 1)
		];
	}
};

/**
 * Creates a new array with `item` first, followed by `items`, keeping at most
 * `max` — the oldest (last) entries fall off. For bounded most-recent-first
 * stacks, like back/forward navigation.
 */
export const to_prepended_list = <T>(items: Array<T>, item: T, max: number): Array<T> => {
	const result = [item, ...items];
	if (result.length > max) result.length = Math.max(0, max);
	return result;
};

/** A half-open `[start, end)` range of list indexes. */
export interface ListWindow {
	start: number;
	end: number;
}

export interface ListWindowOptions {
	/** The number of rows in the list. */
	count: number;
	/** The height of every row, in pixels. */
	row_height: number;
	/** The top of the visible area, in pixels from the top of the list — negative when the list starts below it. */
	viewport_start: number;
	/** The bottom of the visible area, in pixels from the top of the list. */
	viewport_end: number;
	/** Extra rows rendered on each side of the visible ones. */
	overscan: number;
}

/**
 * Computes which rows of a fixed-row-height list to render: those overlapping
 * the visible area plus `overscan` rows on each side, clamped to the list.
 * A list entirely outside the visible area yields at most the `overscan` rows
 * at its nearest edge. Without a usable `row_height` or visible area (say,
 * before the first measurement) it yields the first `overscan` rows.
 */
export const compute_list_window = (options: ListWindowOptions): ListWindow => {
	const { count, row_height, viewport_start, viewport_end, overscan } = options;
	if (count <= 0 || !(row_height > 0) || !(viewport_end > viewport_start)) {
		return { start: 0, end: Math.max(0, Math.min(count, overscan)) };
	}
	const first_visible = Math.floor(viewport_start / row_height);
	const last_visible = Math.ceil(viewport_end / row_height);
	const start = Math.min(count, Math.max(0, first_visible - overscan));
	const end = Math.min(count, Math.max(start, last_visible + overscan));
	return { start, end };
};

/**
 * Creates a case-insensitive substring filter over the text `get_text` gives
 * each item, or `null` when `query` is blank (nothing to filter). The query is
 * trimmed, so stray spaces don't hide everything.
 */
export const create_text_filter = <T>(
	query: string,
	get_text: (item: T) => string
): ((item: T) => boolean) | null => {
	const needle = query.trim().toLowerCase();
	if (!needle) return null;
	return (item) => get_text(item).toLowerCase().includes(needle);
};

/**
 * Finds the nearest ancestor of `el` whose computed `overflow-y` is `auto`,
 * `scroll`, or `overlay`, or `null` when there's none (the document scrolls).
 *
 * Computed style can't tell a vertical scroller apart from an ancestor with
 * only `overflow-x: auto` (its `overflow-y: visible` computes to `auto`) or an
 * `overflow: auto` box whose height grows with its content, and those are
 * returned too. Callers that window a list by this ancestor's visible area
 * need the real scroller to be the nearest one, with a constrained height.
 */
export const find_scroll_container = (el: Element): HTMLElement | null => {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
	}
	return null;
};
