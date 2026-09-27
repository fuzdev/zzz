// @slop Claude Sonnet 3.7

import type { Thunk } from '@fuzdev/fuz_util/function.ts';
import type { Cell } from './cell.svelte.ts';

export interface Sorter<T> {
	key: string;
	label: string;
	fn: (a: T, b: T) => number;
}

/**
 * Manages which of a reactive set of sorters is active. Sorting itself is the
 * consumer's (see `SortableList` and `sort_with_hint`).
 */
export class Sortable<T> {
	/**
	 * Thunk to get the current sorters reactively.
	 */
	#sorters_getter: Thunk<Array<Sorter<T>>>;
	readonly sorters: Array<Sorter<T>> = $derived.by(() => this.#sorters_getter());

	/**
	 * Optional thunk to get the current default sort key reactively.
	 */
	#key_getter_default: Thunk<string | undefined> | undefined;
	readonly default_key: string | undefined = $derived.by(() => this.#key_getter_default?.());

	/** Current active sort key. */
	active_key: string = $state.raw('');

	/**
	 * The currently active sorter.
	 */
	readonly active_sorter: Sorter<T> | undefined = $derived(
		this.sorters.find((s) => s.key === this.active_key)
	);

	/**
	 * The sort function from the active sorter.
	 */
	readonly active_sort_fn: ((a: T, b: T) => number) | undefined = $derived(this.active_sorter?.fn);

	/**
	 * Creates a new `Sortable` instance with reactive sources.
	 *
	 * @param sorters_getter - function that returns the current sorters
	 * @param key_getter_default - optional function that returns the current default sort key
	 */
	constructor(
		sorters_getter: Thunk<Array<Sorter<T>>>,
		key_getter_default?: Thunk<string | undefined>
	) {
		this.#sorters_getter = sorters_getter;
		this.#key_getter_default = key_getter_default;

		// Initialize active key from sorters or default
		this.update_active_key();
	}

	/**
	 * Updates the active key based on sorters and default key.
	 * Called on initialization only — nothing re-runs it when the sorters or
	 * the default key change, so call it again after they do.
	 */
	update_active_key(): void {
		const sorters = this.sorters;
		const default_key = this.default_key;

		// Skip if no sorters
		if (!sorters.length) {
			this.active_key = '';
			return;
		}

		// If we have a default key and it exists in sorters, use it
		if (default_key && sorters.some((sorter) => sorter.key === default_key)) {
			this.active_key = default_key;
			return;
		}

		// If current key isn't valid anymore, reset to first sorter
		if (!sorters.some((sorter) => sorter.key === this.active_key)) {
			const first_sorter = sorters[0];
			if (first_sorter) {
				this.active_key = first_sorter.key;
			} else {
				// Should never happen due to length check above, but handle defensively
				console.error('Unexpected empty sorters array after length check');
				this.active_key = '';
			}
		}
	}
}

/**
 * Sorts a copy of `items`, starting from the order of `hint` — typically the
 * previous sorted result. The items still present keep their hinted order and
 * new ones are appended, so after a small change the input is nearly sorted,
 * which the engine's sort (TimSort in V8) handles in close to linear time
 * instead of a full `n log n` re-sort. With a comparator that orders every
 * pair (the cell sorters break ties by `cid`) the result doesn't depend on
 * `hint`, only the cost does: a stale or unrelated hint just sorts slower.
 *
 * @param items - the items to sort, left unmodified
 * @param compare - the sort comparator
 * @param hint - an earlier ordering of (some of) the items, or `null` for none
 * @returns a new sorted array
 */
export const sort_with_hint = <T>(
	items: ReadonlyArray<T>,
	compare: (a: T, b: T) => number,
	hint: ReadonlyArray<T> | null | undefined
): Array<T> => {
	if (!hint?.length) return items.slice().sort(compare);
	const remaining = new Set(items);
	// duplicate items would collapse in the set, so they sort without the hint
	if (remaining.size !== items.length) return items.slice().sort(compare);
	const result: Array<T> = [];
	for (const item of hint) {
		if (remaining.delete(item)) result.push(item);
	}
	// a set iterates in insertion order, so new items keep their order in `items`
	for (const item of remaining) result.push(item);
	return result.sort(compare);
};

// TODO @many these arent used in a typesafe way, asserting cell subtypes, maybe require the cell?
/**
 * Creates a text sorter with optional direction.
 * Falls back to cell's `cid` for equal values.
 */
export const sort_by_text = <T extends Cell<any>>(
	key: string,
	label: string,
	field: keyof T,
	direction: 'asc' | 'desc' = 'asc'
): Sorter<T> => {
	const multiplier = direction === 'desc' ? -1 : 1;
	return {
		key,
		label,
		fn: (a: T, b: T) => {
			const result = multiplier * String(a[field]).localeCompare(String(b[field]));
			// If values are equal, sort by cid for stable ordering
			return result !== 0 ? result : b.cid - a.cid;
		}
	};
};

// TODO @many these arent used in a typesafe way, asserting cell subtypes, maybe require the cell?
/**
 * Creates a numeric sorter with optional direction.
 * Falls back to cell's `cid` for equal values.
 */
export const sort_by_numeric = <T extends Cell<any>>(
	key: string,
	label: string,
	field: keyof T,
	direction: 'asc' | 'desc' = 'asc'
): Sorter<T> => {
	return {
		key,
		label,
		fn: (item_a: T, item_b: T) => {
			const a = item_a[field];
			const b = item_b[field];
			const result =
				direction === 'asc' ? (a < b ? -1 : a > b ? 1 : 0) : a > b ? -1 : a < b ? 1 : 0;
			// If values are equal, sort by cid for stable ordering
			return result !== 0 ? result : item_b.cid - item_a.cid;
		}
	};
};
