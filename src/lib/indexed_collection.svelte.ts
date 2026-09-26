import { SvelteMap } from 'svelte/reactivity';
import { DEV } from 'esm-env';
import { EMPTY_ARRAY } from '@fuzdev/fuz_util/array.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { IndexedItem } from './indexed_collection_helpers.svelte.ts';

// TODO @many rethink the indexed collection API -
// particularly type safety, performance, and integration with Svelte patterns -
// consider the whole graph's POV, not just individual collections, for relationships/transactions

/**
 * The index categories the typed accessors check: `single_index` and
 * `by_optional` read a `single` index, `where` a `multi` one,
 * and `derived_index` a `derived` one.
 */
export type IndexType = 'single' | 'multi' | 'derived';

/**
 * An index definition. The `create_*_index` helpers build these;
 * a custom definition without a `type` is read through `indexes`.
 */
export interface IndexDefinition<T extends IndexedItem, TResult = any> {
	/** Unique identifier for this index. */
	key: string;

	/** The category the typed accessors check before reading the index. */
	type?: IndexType;

	/** Function to compute the index value from scratch. */
	compute: (collection: IndexedCollection<T>) => TResult;

	/** Optional predicate to determine if an item is relevant to this index. */
	matches?: (item: T) => boolean;

	/**
	 * When `true`, the index is a `$derived` of `compute` — recomputed on the next
	 * read after the collection changes or any reactive state `compute` read changes,
	 * so it follows items whose indexed fields change after they're added.
	 * `onadd` and `onremove` are unused.
	 *
	 * When `false` or omitted, `onadd` and `onremove` maintain the index incrementally,
	 * which is only correct when the indexed values of an item never change
	 * while it's in the collection.
	 */
	reactive?: boolean;

	/** Optional function to update the index when an item is added. */
	onadd?: (result: TResult, item: T, collection: IndexedCollection<T>) => TResult;

	/**
	 * Optional function to update the index when an item is removed.
	 * Runs after the item (and every other item removed in the same call) has left `by_id`.
	 */
	onremove?: (result: TResult, item: T, collection: IndexedCollection<T>) => TResult;
}

export interface IndexedCollectionOptions<T extends IndexedItem> {
	indexes?: Array<IndexDefinition<T>>;
	initial_items?: Array<T>;
	/**
	 * Disposes an item after it leaves the collection through `remove`, `remove_many`,
	 * or `clear`. Pass it when the collection owns its items, so removed ones
	 * release their resources (for cells, their `cell_registry` entry).
	 */
	dispose_item?: (item: T) => void;
}

/**
 * A reactive collection of items keyed by `id`, with indexes kept current
 * as items are added and removed (see `IndexDefinition` for how each index is maintained).
 *
 * @param T - the type of items stored in the collection
 */
export class IndexedCollection<T extends IndexedItem> {
	/** The main source of truth, the full collection keyed by `Uuid`. */
	readonly by_id: SvelteMap<Uuid, T> = new SvelteMap();

	// TODO change to `ReadonlyArray`s? problem is downstream usage type errors
	// TODO `derived_index` likewise returns a mutable `Array<T>` — the index's own `$state` proxy,
	// mutated in place by `onadd`/`onremove` — unlike `where`, which returns a `ReadonlyArray`
	readonly values: Array<T> = $derived(Array.from(this.by_id.values()));
	readonly keys: Array<Uuid> = $derived(Array.from(this.by_id.keys()));

	/** Get the current count of items. */
	readonly size: number = $derived(this.by_id.size);

	/**
	 * All index values by key. Each property is an accessor over a reactive holder:
	 * incremental indexes are deeply reactive `$state` (so arrays can be mutated in place,
	 * and replaced by assignment), while `reactive` indexes are read-only `$derived` values.
	 */
	readonly indexes: Record<string, any> = {};

	// the `type` of each index that declares one, checked by the typed accessors
	readonly #index_types: Map<string, IndexType> = new Map();

	// incrementally maintained index definitions (the ones with `onadd`/`onremove` hooks)
	readonly #incremental_definitions: ReadonlyArray<IndexDefinition<T>> = [];

	readonly #dispose_item: ((item: T) => void) | undefined;

	constructor(options?: IndexedCollectionOptions<T>) {
		this.#dispose_item = options?.dispose_item;

		if (options?.indexes) {
			this.#incremental_definitions = options.indexes.filter((def) => !def.reactive);

			for (const def of options.indexes) {
				define_index_property(this.indexes, def.key, create_index_holder(def, this));
				if (def.type) {
					this.#index_types.set(def.key, def.type);
				}
			}
		}

		if (options?.initial_items) {
			this.add_many(options.initial_items);
		}
	}

	// TODO type (add another generic? infer from cell? currently we have no dep on that)
	toJSON(): ReadonlyArray<any> {
		return $state.snapshot(this.values);
	}

	/**
	 * Get a single-value index.
	 *
	 * @throws Error if `key` isn't a `single` index
	 */
	single_index(key: string): ReadonlyMap<any, T> {
		this.#ensure_index(key, 'single');
		return this.indexes[key];
	}

	/**
	 * Get a derived index.
	 *
	 * @throws Error if `key` isn't a `derived` index
	 */
	derived_index(key: string): Array<T> {
		this.#ensure_index(key, 'derived');
		return this.indexes[key];
	}

	/**
	 * Ensures that the index exists and is of the expected type.
	 *
	 * @param key - the index key to check
	 * @param expected_type - the expected `IndexType` of the index
	 * @throws Error if the index doesn't exist or has the wrong type
	 */
	#ensure_index(key: string, expected_type: IndexType): void {
		// checks the definition, not the value — reading a `reactive` index outside
		// a reactive context costs a walk of its dependencies, so callers read it once
		if (!Object.hasOwn(this.indexes, key)) {
			throw new Error(`Index not found: ${key}`);
		}

		const actual_type = this.#index_types.get(key);
		if (actual_type !== expected_type) {
			throw new Error(
				`Index type mismatch: ${key} is ${actual_type ? `a ${actual_type}` : 'an untyped'} index, not a ${expected_type} index`
			);
		}
	}

	/**
	 * Add an item to the collection and update all indexes.
	 */
	add(item: T): void {
		const { by_id } = this;

		if (by_id.has(item.id)) {
			if (DEV)
				console.error(
					'item already exists in collection with id: ' + item.id,
					item,
					by_id.get(item.id)
				);
			return;
		}

		by_id.set(item.id, item);

		this.#update_indexes_for_added_item(item);
	}

	/**
	 * Add multiple items to the collection at once.
	 */
	add_many(items: Array<T>): void {
		for (const item of items) {
			this.add(item);
		}
	}

	/**
	 * Update all incremental indexes when an item is added.
	 */
	#update_indexes_for_added_item(item: T): void {
		for (const def of this.#incremental_definitions) {
			if (def.onadd && (!def.matches || def.matches(item))) {
				this.indexes[def.key] = def.onadd(this.indexes[def.key], item, this);
			}
		}
	}

	/**
	 * Update all incremental indexes when an item is removed.
	 */
	#update_indexes_for_removed_item(item: T): void {
		for (const def of this.#incremental_definitions) {
			if (def.onremove && (!def.matches || def.matches(item))) {
				this.indexes[def.key] = def.onremove(this.indexes[def.key], item, this);
			}
		}
	}

	/**
	 * Remove an item by its id and update all indexes.
	 * Disposes the item when the collection has `dispose_item`.
	 */
	remove(id: Uuid): boolean {
		const item = this.by_id.get(id);
		if (!item) return false;

		// remove first, so index hooks see the collection without it
		this.by_id.delete(id);

		this.#update_indexes_for_removed_item(item);

		this.#dispose_item?.(item);

		return true;
	}

	/**
	 * Remove multiple items efficiently.
	 * Disposes the items when the collection has `dispose_item`.
	 */
	remove_many(ids: Array<Uuid>): number {
		if (!ids.length) return 0;

		// remove them all first, so index hooks see the collection without any of them
		// (a single index falling back to another holder of a key must not pick one being removed),
		// deduping repeated ids
		const removed: Array<T> = [];
		for (const id of ids) {
			const item = this.by_id.get(id);
			if (item && this.by_id.delete(id)) {
				removed.push(item);
			}
		}

		for (const item of removed) {
			this.#update_indexes_for_removed_item(item);
		}

		if (this.#dispose_item) {
			for (const item of removed) {
				this.#dispose_item(item);
			}
		}

		return removed.length;
	}

	/**
	 * Get an item by its id.
	 */
	get(id: Uuid): T | undefined {
		return this.by_id.get(id);
	}

	/**
	 * Check if the collection has an item with the given id.
	 */
	has(id: Uuid): boolean {
		return this.by_id.has(id);
	}

	/**
	 * Clear all items and reset indexes.
	 * Disposes the items when the collection has `dispose_item`.
	 */
	clear(): void {
		const removed = this.#dispose_item ? Array.from(this.by_id.values()) : null;

		this.by_id.clear();

		// reset the incremental indexes, reactive ones follow `by_id`
		for (const def of this.#incremental_definitions) {
			this.indexes[def.key] = def.compute(this);
		}

		if (removed) {
			for (const item of removed) {
				this.#dispose_item!(item);
			}
		}
	}

	// TODO `V = any` needs to be typesafe to the key/value pair

	/**
	 * Get the items a multi index holds for `value`. The result is read-only:
	 * it's the index's own bucket, or a shared empty array when there's none,
	 * so copy it before changing it.
	 *
	 * @throws Error if `index_key` isn't a `multi` index
	 */
	where<V = any>(index_key: string, value: V): ReadonlyArray<T> {
		this.#ensure_index(index_key, 'multi');
		return this.indexes[index_key].get(value) ?? EMPTY_ARRAY;
	}

	/**
	 * Get the item a single index holds for `value`, or `undefined`.
	 *
	 * @throws Error if `index_key` isn't a `single` index
	 */
	by_optional<V = any>(index_key: string, value: V): T | undefined {
		this.#ensure_index(index_key, 'single');
		return this.indexes[index_key].get(value);
	}
}

/**
 * A reactive holder for one index value.
 */
interface IndexHolder {
	value: any;
}

/**
 * Holds an incrementally maintained index. Deeply reactive,
 * so arrays assigned to it are proxied and can be mutated in place.
 */
class IncrementalIndexHolder implements IndexHolder {
	value: any = $state();

	constructor(value: unknown) {
		this.value = value;
	}
}

/**
 * Holds a `reactive` index, recomputed lazily from its definition's `compute`.
 */
class ReactiveIndexHolder<T extends IndexedItem> implements IndexHolder {
	readonly #def: IndexDefinition<T>;
	readonly #collection: IndexedCollection<T>;

	readonly value: any = $derived.by(() => this.#def.compute(this.#collection));

	constructor(def: IndexDefinition<T>, collection: IndexedCollection<T>) {
		this.#def = def;
		this.#collection = collection;
	}
}

const create_index_holder = <T extends IndexedItem>(
	def: IndexDefinition<T>,
	collection: IndexedCollection<T>
): IndexHolder =>
	def.reactive
		? new ReactiveIndexHolder(def, collection)
		: new IncrementalIndexHolder(def.compute(collection));

/**
 * Exposes an index holder's value as the `key` property of `indexes`,
 * so every index reads (and incremental ones assign) like a plain property.
 *
 * @mutates indexes - defines an enumerable accessor for `key`, which throws on assignment to a `reactive` index
 */
const define_index_property = (
	indexes: Record<string, any>,
	key: string,
	holder: IndexHolder
): void => {
	Object.defineProperty(indexes, key, {
		enumerable: true,
		configurable: false,
		get: () => holder.value,
		set: (value) => {
			if (holder instanceof ReactiveIndexHolder) {
				throw new Error(`Cannot assign to reactive index: ${key}`);
			}
			holder.value = value;
		}
	});
};
