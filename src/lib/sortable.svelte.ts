// @slop Claude Sonnet 3.7

import type { Thunk } from '@fuzdev/fuz_util/function.ts';

export interface Sorter<T> {
	key: string;
	label: string;
	fn: (a: T, b: T) => number;
	/**
	 * Read before each sort, so a sort over values the items array doesn't
	 * track — like fields of records replaced in place — re-runs when they
	 * change. Without it, a sort re-runs only when the items or the sorter do.
	 */
	track?: () => unknown;
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
 * pair (`sort_by_text` and `sort_by_numeric` break ties by `id`) the result doesn't depend on
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

/** Something a sorter orders, told apart by its `id` when its values tie. */
export interface SortableItem {
	readonly id: string;
}

/**
 * What a sorter compares: a key of the item, or a function giving the value
 * for an item — for a value the item doesn't hold, like a path relative to a
 * directory.
 */
export type SortField<T> = keyof T | ((item: T) => unknown);

const to_field_value = <T>(item: T, field: SortField<T>): unknown =>
	typeof field === 'function' ? field(item) : item[field];

/**
 * Orders `a` and `b` by `id` — the tiebreak of `sort_by_text` and
 * `sort_by_numeric`, so items with equal values keep one order whatever the
 * input's. The order means nothing more: for a Uuid it's arbitrary.
 */
export const compare_sort_ids = (a: SortableItem, b: SortableItem): number =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Creates a text sorter with optional direction.
 * Falls back to `id` for equal values (`compare_sort_ids`).
 */
export const sort_by_text = <T extends SortableItem>(
	key: string,
	label: string,
	field: SortField<T>,
	direction: 'asc' | 'desc' = 'asc'
): Sorter<T> => {
	const multiplier = direction === 'desc' ? -1 : 1;
	return {
		key,
		label,
		fn: (a: T, b: T) => {
			const result =
				multiplier *
				String(to_field_value(a, field)).localeCompare(String(to_field_value(b, field)));
			return result !== 0 ? result : compare_sort_ids(a, b);
		}
	};
};

/**
 * Creates a numeric sorter with optional direction.
 * A `null` or `undefined` value (unknown, like a file's size the backend
 * couldn't say) sorts after every known one in both directions.
 * Falls back to `id` for equal values (`compare_sort_ids`).
 */
export const sort_by_numeric = <T extends SortableItem>(
	key: string,
	label: string,
	field: SortField<T>,
	direction: 'asc' | 'desc' = 'asc'
): Sorter<T> => {
	return {
		key,
		label,
		fn: (item_a: T, item_b: T) => {
			const a = to_field_value(item_a, field) as number | null | undefined;
			const b = to_field_value(item_b, field) as number | null | undefined;
			let result: number;
			if (a == null || b == null) {
				// unknown values last, whichever the direction
				result = Number(a == null) - Number(b == null);
			} else {
				result = a < b ? -1 : a > b ? 1 : 0;
				if (direction === 'desc') result = -result;
			}
			return result !== 0 ? result : compare_sort_ids(item_a, item_b);
		}
	};
};
