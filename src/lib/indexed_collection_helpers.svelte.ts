// @slop Claude Sonnet 3.7

import { SvelteMap } from 'svelte/reactivity';
import { z } from 'zod';
import { UuidWithDefault } from '@fuzdev/fuz_util/id.ts';

import type { IndexDefinition, IndexedCollection } from './indexed_collection.svelte.ts';

// TODO @many rethink the indexed collection API -
// particularly type safety, performance, and integration with Svelte patterns -
// consider the whole graph's POV, not just individual collections, for relationships/transactions

/**
 * Interface for objects that can be stored in an `IndexedCollection`.
 */
export const IndexedItem = z.strictObject({
	id: UuidWithDefault
});
export type IndexedItem = z.infer<typeof IndexedItem>;

// TODO I think these helpers should be on the base cell for type inference, `this.create_single_index`,
// but the extracted logic could still be here if it made the base class cleaner, or if these are usefully reusable

/**
 * Common options interface for all index types.
 */
export interface IndexOptions<T extends IndexedItem, TQuery = any> {
	/** Unique key for this index. */
	key: string;

	/** Optional predicate to determine if an item is relevant to this index. */
	matches?: (item: T) => boolean;

	/** Schema for query input validation and typing. */
	query_schema?: z.ZodType<TQuery>;
}

/**
 * Options shared by the key-extracting single-value and multi-value indexes.
 */
export interface KeyedIndexOptions<T extends IndexedItem, K> extends IndexOptions<T, K> {
	/**
	 * Declares that the extracted key(s) of an item never change while it's in
	 * the collection, so the index is maintained incrementally on add and remove
	 * (O(1) per change, reactive per key through a `SvelteMap`).
	 * If a key does change, lookups go stale — only use it for identity-like fields
	 * (like a diskfile's `path`).
	 *
	 * By default the index is `reactive`: a `$derived` rebuilt in O(n) on the next read
	 * after the collection or any reactive field the extractor (or `matches`) reads changes,
	 * so it stays correct when a field like `name` is edited. The costs:
	 *
	 * - every rebuild makes a new map, so everything reading the index re-runs
	 *   on any change to the collection or an indexed field, not just the keys it read
	 * - reads outside a reactive context (event handlers, plain functions) can't rely on
	 *   change notifications, so each one checks all O(n) dependencies — fine for occasional
	 *   lookups, but code that adds an item and then reads the index in a loop is O(n²)
	 *
	 * Opt into `immutable_key` for large or busy collections when the key allows it.
	 */
	immutable_key?: boolean;
}

/**
 * Options for single-value indexes.
 */
export interface SingleIndexOptions<T extends IndexedItem, K> extends KeyedIndexOptions<T, K> {
	/** Function that extracts the key from an item. */
	extractor: (item: T) => K;
}

/**
 * Create a single-value index (one key maps to one item).
 * When several items share a key, the last one added wins.
 */
export const create_single_index = <T extends IndexedItem, K>(
	options: SingleIndexOptions<T, K>
): IndexDefinition<T, Map<K, T>, K> => {
	const { key, extractor, query_schema, matches } = options;

	if (!options.immutable_key) {
		return {
			key,
			type: 'single',
			extractor,
			query_schema,
			matches,
			reactive: true,
			compute: (collection) => fill_single_map(new Map<K, T>(), collection.by_id.values(), options)
		};
	}

	return {
		key,
		type: 'single',
		extractor,
		query_schema,
		matches,
		compute: (collection) =>
			fill_single_map(new SvelteMap<K, T>(), collection.by_id.values(), options),
		onadd: (map, item) => {
			if (!should_include_item(item, matches)) return map;

			const extract_key = extractor(item);
			if (extract_key !== undefined) {
				map.set(extract_key, item);
			}
			return map;
		},
		onremove: (map, item, collection) => {
			if (!should_include_item(item, matches)) return map;

			const extract_key = extractor(item);
			if (extract_key === undefined) return map;

			// Check if this item is currently indexed for this key
			const current = map.get(extract_key);
			if (!current || current.id !== item.id) {
				// This item isn't the one indexed for this key, so nothing to do
				return map;
			}

			// Find the last remaining item with the same key, matching `compute` —
			// `by_id` no longer has any item removed in this call
			let item_with_same_key;
			for (const other of collection.by_id.values()) {
				if (should_include_item(other, matches) && extractor(other) === extract_key) {
					item_with_same_key = other;
				}
			}

			if (item_with_same_key) {
				map.set(extract_key, item_with_same_key);
			} else {
				// No other items with this key - delete the entry
				map.delete(extract_key);
			}

			return map;
		}
	};
};

/**
 * Options for multi-value indexes.
 */
export interface MultiIndexOptions<T extends IndexedItem, K> extends KeyedIndexOptions<T, K> {
	/** Function that extracts the key(s) from an item. */
	extractor: (item: T) => K | Array<K> | undefined;

	/** Optional sort function for items in each bucket. */
	sort?: (a: T, b: T) => number;
}

/**
 * Create a multi-value index (one key maps to many items).
 */
export const create_multi_index = <T extends IndexedItem, K>(
	options: MultiIndexOptions<T, K>
): IndexDefinition<T, Map<K, Array<T>>, K> => {
	const { key, extractor, query_schema, matches, sort } = options;

	if (!options.immutable_key) {
		return {
			key,
			type: 'multi',
			extractor,
			query_schema,
			matches,
			reactive: true,
			compute: (collection) => {
				const map: Map<K, Array<T>> = new Map();
				for (const item of collection.by_id.values()) {
					if (!should_include_item(item, matches)) continue;
					for_each_key(extractor(item), (k) => {
						if (k === undefined) return;
						const items = map.get(k);
						if (items) {
							items.push(item);
						} else {
							map.set(k, [item]);
						}
					});
				}
				if (sort) {
					for (const items of map.values()) {
						items.sort(sort);
					}
				}
				return map;
			}
		};
	}

	return {
		key,
		type: 'multi',
		extractor,
		query_schema,
		matches,
		compute: (collection) => {
			const map: SvelteMap<K, Array<T>> = new SvelteMap();
			for (const item of collection.by_id.values()) {
				if (!should_include_item(item, matches)) continue;
				for_each_key(extractor(item), (k) => add_to_multi_map(map, k, item, sort));
			}
			return map;
		},
		onadd: (map, item) => {
			if (!should_include_item(item, matches)) return map;
			for_each_key(extractor(item), (k) => add_to_multi_map(map, k, item, sort));
			return map;
		},
		onremove: (map, item) => {
			if (!should_include_item(item, matches)) return map;
			for_each_key(extractor(item), (k) => remove_from_multi_map(map, k, item));
			return map;
		}
	};
};

// TODO maybe renamed? obviously overlaps with Svelte derived and doesn't use it -
// the goal is the be incremental, but that's the right API here?
// see the comment at the top of the file too
/**
 * Options for derived indexes.
 */
export interface DerivedIndexOptions<
	T extends IndexedItem,
	TResult extends Array<T> = Array<T>
> extends IndexOptions<T, void> {
	/** Function that computes the derived collection from the full collection. */
	compute: (collection: IndexedCollection<T>) => TResult;

	/**
	 * Optional sort function for the derived array. `compute`'s result is
	 * copied before sorting, so `compute` can return an array it doesn't own
	 * (like `collection.values`).
	 */
	sort?: (a: T, b: T) => number;

	/** Optional custom add handler. */
	onadd?: (items: TResult, item: T, collection: IndexedCollection<T>) => TResult;

	/** Optional custom remove handler. */
	onremove?: (items: TResult, item: T, collection: IndexedCollection<T>) => TResult;
}

/**
 * Creates an incremental derived collection index.
 */
export const create_derived_index = <T extends IndexedItem, TResult extends Array<T> = Array<T>>(
	options: DerivedIndexOptions<T, TResult>
): IndexDefinition<T, TResult, void> => {
	return {
		key: options.key,
		type: 'derived',
		matches: options.matches,
		query_schema: options.query_schema,
		compute: (collection) => {
			const result = options.compute(collection);
			if (options.sort) {
				// sort a copy — never reorder the array `compute` returned
				return result.slice().sort(options.sort) as TResult;
			}
			return result;
		},
		onadd: (items, item, collection) => {
			// Use custom handler if provided
			if (options.onadd) {
				return options.onadd(items, item, collection);
			}

			// Default behavior for arrays
			if (should_include_item(item, options.matches)) {
				items.push(item);
				if (options.sort) {
					items.sort(options.sort); // TODO @many incremental patterns -- here, maybe instead of sorting, insert at the right index? and maybe clone the array if not pushing?
				}
			}
			return items;
		},
		onremove: (items, item, collection) => {
			// Use custom handler if provided
			if (options.onremove) {
				return options.onremove(items, item, collection);
			}

			// Default behavior for arrays
			if (should_include_item(item, options.matches)) {
				const index = items.findIndex((i) => i.id === item.id);
				if (index !== -1) {
					items.splice(index, 1); // TODO @many incremental patterns -- here, maybe instead of splicing, remove at the right index, and clone the array if not popping?
				}
			}
			return items;
		}
	};
};

/**
 * Options for dynamic indexes.
 */
export interface DynamicIndexOptions<
	T extends IndexedItem,
	F extends (...args: Array<any>) => any
> extends IndexOptions<T, Parameters<F>[0]> {
	/** Function that creates a query function from the collection. */
	factory: (collection: IndexedCollection<T>) => F;

	/** Optional custom add handler. */
	onadd?: (fn: F, item: T, collection: IndexedCollection<T>) => F;

	/** Optional custom remove handler. */
	onremove?: (fn: F, item: T, collection: IndexedCollection<T>) => F;
}

/**
 * Create a dynamic index that computes results on-demand based on query parameters.
 */
export const create_dynamic_index = <T extends IndexedItem, F extends (...args: Array<any>) => any>(
	options: DynamicIndexOptions<T, F>
): IndexDefinition<T, F, Parameters<F>[0]> => {
	return {
		key: options.key,
		compute: options.factory,
		query_schema: options.query_schema,
		matches: options.matches,
		// Dynamic indexes typically don't change as items are added/removed
		// since they compute their results on-demand from the current collection state
		onadd: options.onadd || ((fn) => fn),
		onremove: options.onremove || ((fn) => fn)
	};
};

/**
 * Helper function to check if an item matches the index criteria.
 */
const should_include_item = <T extends IndexedItem>(
	item: T,
	matches?: (item: T) => boolean
): boolean => !matches || matches(item);

/**
 * Fills `map` with the single-index entries of `items`, later items winning.
 *
 * @mutates map - sets an entry per included item with a defined key
 */
const fill_single_map = <T extends IndexedItem, K, TMap extends Map<K, T>>(
	map: TMap,
	items: Iterable<T>,
	options: SingleIndexOptions<T, K>
): TMap => {
	for (const item of items) {
		if (!should_include_item(item, options.matches)) continue;
		const extract_key = options.extractor(item);
		if (extract_key !== undefined) {
			map.set(extract_key, item);
		}
	}
	return map;
};

/**
 * Calls `fn` with each key a multi-index extractor returned.
 */
const for_each_key = <K>(keys: K | Array<K> | undefined, fn: (key: K) => void): void => {
	if (keys === undefined) return;
	if (Array.isArray(keys)) {
		for (const k of keys) fn(k);
	} else {
		fn(keys);
	}
};

/**
 * Helper function to add an item to a multi-value map.
 */
const add_to_multi_map = <T extends IndexedItem, K>(
	map: Map<K, Array<T>>,
	key: K,
	item: T,
	sort?: (a: T, b: T) => number
): void => {
	if (key === undefined) return;

	let items = map.get(key);
	if (!items) {
		const value = $state([]);
		map.set(key, (items = value));
	}
	items.push(item); // TODO maybe optimize to insert at index=0 (or similar heuristics) using the sort fn

	if (sort) {
		items.sort(sort); // TODO instead of sorting all, maybe find the insertion index instead?
	}
};

/**
 * Helper function to remove an item from a multi-value map.
 */
const remove_from_multi_map = <T extends IndexedItem, K>(
	map: Map<K, Array<T>>,
	key: K,
	item: T
): void => {
	if (key === undefined) return;

	const items = map.get(key);
	if (!items) return;

	const index = items.findIndex((i) => i.id === item.id);
	if (index === -1) return;

	if (items.length === 1) {
		// If this was the last item, remove the key entirely
		map.delete(key);
	} else {
		// Remove just this item
		items.splice(index, 1);
	}
};
