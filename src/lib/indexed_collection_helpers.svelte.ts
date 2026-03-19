// @slop Claude Sonnet 3.7

import {SvelteMap} from 'svelte/reactivity';
import {z} from 'zod';

import type {IndexDefinition, IndexedCollection} from './indexed_collection.svelte.js';
import {UuidWithDefault} from './zod_helpers.js';

// TODO @many rethink the indexed collection API -
// particularly type safety, performance, and integration with Svelte patterns -
// consider the whole graph's POV, not just individual collections, for relationships/transactions

/**
 * Interface for objects that can be stored in an `IndexedCollection`.
 */
export const IndexedItem = z.strictObject({
	id: UuidWithDefault,
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
 * Options for single-value indexes.
 */
export interface SingleIndexOptions<T extends IndexedItem, K> extends IndexOptions<T, K> {
	/** Function that extracts the key from an item. */
	extractor: (item: T) => K;
}

/**
 * Create a single-value index (one key maps to one item).
 */
export const create_single_index = <T extends IndexedItem, K>(
	options: SingleIndexOptions<T, K>,
): IndexDefinition<T, SvelteMap<K, T>, K> => {
	return {
		key: options.key,
		type: 'single',
		extractor: options.extractor,
		query_schema: options.query_schema,
		matches: options.matches,
		compute: (collection) => {
			const map: SvelteMap<K, T> = new SvelteMap();
			for (const item of collection.by_id.values()) {
				if (!should_include_item(item, options.matches)) continue;

				const extract_key = options.extractor(item);
				if (extract_key !== undefined) {
					map.set(extract_key, item);
				}
			}
			return map;
		},
		onadd: (map, item) => {
			if (!should_include_item(item, options.matches)) return map;

			const extract_key = options.extractor(item);
			if (extract_key !== undefined) {
				map.set(extract_key, item);
			}
			return map;
		},
		onremove: (map, item, collection) => {
			if (!should_include_item(item, options.matches)) return map;

			const extract_key = options.extractor(item);
			if (extract_key === undefined) return map;

			// Check if this item is currently indexed for this key
			const current = map.get(extract_key);
			if (!current || current.id !== item.id) {
				// This item isn't the one indexed for this key, so nothing to do
				return map;
			}

			// Find any other items with the same key
			let item_with_same_key;
			for (const other of collection.by_id.values()) {
				if (other.id !== item.id && options.extractor(other) === extract_key) {
					item_with_same_key = other;
					break;
				}
			}

			if (item_with_same_key) {
				// Found another item with the same key - use the first one
				map.set(extract_key, item_with_same_key);
			} else {
				// No other items with this key - delete the entry
				map.delete(extract_key);
			}

			return map;
		},
	};
};

/**
 * Options for multi-value indexes.
 */
export interface MultiIndexOptions<T extends IndexedItem, K> extends IndexOptions<T, K> {
	/** Function that extracts the key(s) from an item. */
	extractor: (item: T) => K | Array<K> | undefined;

	/** Optional sort function for items in each bucket. */
	sort?: (a: T, b: T) => number;
}

/**
 * Create a multi-value index (one key maps to many items).
 */
export const create_multi_index = <T extends IndexedItem, K>(
	options: MultiIndexOptions<T, K>,
): IndexDefinition<T, SvelteMap<K, Array<T>>, K> => {
	return {
		key: options.key,
		type: 'multi',
		extractor: options.extractor,
		query_schema: options.query_schema,
		matches: options.matches,
		compute: (collection) => {
			const map: SvelteMap<K, Array<T>> = new SvelteMap();
			for (const item of collection.by_id.values()) {
				if (!should_include_item(item, options.matches)) continue;

				const keys = options.extractor(item);
				if (keys === undefined) continue;

				if (Array.isArray(keys)) {
					for (const k of keys) {
						add_to_multi_map(map, k, item, options.sort);
					}
				} else {
					add_to_multi_map(map, keys, item, options.sort);
				}
			}

			return map;
		},
		onadd: (map, item) => {
			if (!should_include_item(item, options.matches)) return map;

			const keys = options.extractor(item);
			if (keys === undefined) return map;

			if (Array.isArray(keys)) {
				for (const k of keys) {
					add_to_multi_map(map, k, item, options.sort);
				}
			} else {
				add_to_multi_map(map, keys, item, options.sort);
			}
			return map;
		},
		onremove: (map, item) => {
			if (!should_include_item(item, options.matches)) return map;

			const keys = options.extractor(item);
			if (keys === undefined) return map;

			if (Array.isArray(keys)) {
				for (const k of keys) {
					remove_from_multi_map(map, k, item);
				}
			} else {
				remove_from_multi_map(map, keys, item);
			}
			return map;
		},
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
	TResult extends Array<T> = Array<T>,
> extends IndexOptions<T, void> {
	/** Function that computes the derived collection from the full collection. */
	compute: (collection: IndexedCollection<T>) => TResult;

	/** Optional sort function for the derived array. */
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
	options: DerivedIndexOptions<T, TResult>,
): IndexDefinition<T, TResult, void> => {
	return {
		key: options.key,
		type: 'derived',
		matches: options.matches,
		query_schema: options.query_schema,
		compute: (collection) => {
			const result = options.compute(collection);
			if (options.sort) {
				return result.sort(options.sort);
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
		},
	};
};

/**
 * Options for dynamic indexes.
 */
export interface DynamicIndexOptions<
	T extends IndexedItem,
	F extends (...args: Array<any>) => any,
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
	options: DynamicIndexOptions<T, F>,
): IndexDefinition<T, F, Parameters<F>[0]> => {
	return {
		key: options.key,
		compute: options.factory,
		query_schema: options.query_schema,
		matches: options.matches,
		// Dynamic indexes typically don't change as items are added/removed
		// since they compute their results on-demand from the current collection state
		onadd: options.onadd || ((fn) => fn),
		onremove: options.onremove || ((fn) => fn),
	};
};

/**
 * Helper function to check if an item matches the index criteria.
 */
const should_include_item = <T extends IndexedItem>(
	item: T,
	matches?: (item: T) => boolean,
): boolean => !matches || matches(item);

/**
 * Helper function to add an item to a multi-value map.
 */
const add_to_multi_map = <T extends IndexedItem, K>(
	map: SvelteMap<K, Array<T>>,
	key: K,
	item: T,
	sort?: (a: T, b: T) => number,
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
	map: SvelteMap<K, Array<T>>,
	key: K,
	item: T,
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
