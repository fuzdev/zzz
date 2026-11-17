import { untrack } from 'svelte';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';

import type { DiskfilePath, SerializableDisknode } from './diskfile_types.ts';
import { sort_by_numeric, type Sorter } from './sortable.svelte.ts';
import { to_file_directories } from './diskfile_helpers.ts';
import { DiskfileTreeIndex } from './diskfile_tree_state.svelte.ts';

/** A path's subscription while a reactive reader holds it — see `DiskfileIndex.get`. */
interface DiskfileIndexWatch {
	subscribe: () => void;
	/** Notifies the path's readers, `null` until the subscription starts. */
	update: (() => void) | null;
}

/**
 * The file index's metadata: each file on disk the index reports, as the
 * disknode that reported it (a record's `id` is its path), with the folder
 * counts and tree they make. Owned by `Diskfiles`, which writes it as files
 * come and go — a file kept for a draft or a tab after leaving the index
 * (`Diskfile.deleted_on_disk`, `Diskfile.uncovered`) isn't in it.
 *
 * Reactivity is coarse by default and fine where asked for:
 * - `membership` moves when a file is added or removed, `meta` when a
 *   record's size, times, or root change — each at most once per write or
 *   `batch`, so a whole snapshot moves each once.
 * - `get` and `has` subscribe a reactive reader to that path alone. A path
 *   no reader holds has no signal, so a write to it notifies nothing. Read
 *   them only in component effects, or deriveds that live in one — a
 *   `$derived` read outside any effect leaves a watch that never goes
 *   (see `#watch`). Bulk or imperative reads use the counters.
 */
export class DiskfileIndex {
	/** Moves once per write or batch that adds or removes a file. */
	membership: number = $state.raw(0);

	/** Moves once per write or batch that changes a record in place (size, times, root). */
	meta: number = $state.raw(0);

	/** The records by path. Not reactive — reads go through `get`, `has`, and the counters. */
	readonly #records: Map<DiskfilePath, SerializableDisknode> = new Map();

	/** Each path a reactive reader holds — created and dropped by its subscription. */
	readonly #watches: Map<string, DiskfileIndexWatch> = new Map();

	/**
	 * How many files each directory holds, at any depth, by its path with a
	 * trailing `/` — every ancestor of each file up to its root (see
	 * `to_file_directories`). Kept in step as files come and go, never
	 * rebuilt. Not reactive: `directory_paths` is.
	 */
	readonly #directory_counts: Map<string, number> = new Map();

	readonly #directory_paths: SvelteSet<string> = new SvelteSet();

	/**
	 * The directories holding a file, each with a trailing `/` — changing only
	 * as a directory gains its first file or loses its last.
	 */
	readonly directory_paths: ReadonlySet<string> = this.#directory_paths;

	/**
	 * Each folder's children among the files, every file linked up to `/` —
	 * not its `source_dir`, which is whichever root's filer reported it last —
	 * so any root's folder shows it. The file tree reads it (see
	 * `DiskfileTreeState`).
	 */
	readonly tree_index: DiskfileTreeIndex = new DiskfileTreeIndex();

	#batch_depth = 0;
	#membership_moved = false;
	#meta_moved = false;

	/** How many paths have a reactive reader — for tests. */
	get watch_count(): number {
		return this.#watches.size;
	}

	/**
	 * How many files each directory in `directory_paths` holds — not reactive,
	 * for tests and DEV checks (`to_diskfile_index_mismatches`).
	 */
	get directory_counts(): ReadonlyMap<string, number> {
		return this.#directory_counts;
	}

	/** How many files the index holds. Tracks `membership`. */
	get size(): number {
		this.#track_membership();
		return this.#records.size;
	}

	/** The file at `path`'s record. Subscribes a reactive reader to `path` alone. */
	get(path: DiskfilePath): SerializableDisknode | undefined {
		this.#watch(path);
		return this.#records.get(path);
	}

	/** Whether the index holds the file at `path`. Subscribes a reactive reader to `path` alone. */
	has(path: string): boolean {
		this.#watch(path);
		return this.#records.has(path as DiskfilePath);
	}

	/** Every record. Tracks `membership` and `meta`. */
	values(): MapIterator<SerializableDisknode> {
		this.#track_membership();
		this.#track_meta();
		return this.#records.values();
	}

	/** Makes the calling reader depend on adds and removes. */
	#track_membership(): number {
		return this.membership;
	}

	/** Makes the calling reader depend on changes in place. */
	#track_meta(): number {
		return this.meta;
	}

	/**
	 * Adds the file `disknode` reports, or replaces its record — kept as given,
	 * not copied. A record equal to the one held (size, times, and root)
	 * changes nothing.
	 */
	set(disknode: SerializableDisknode): void {
		const path = disknode.id;
		const prev = this.#records.get(path);
		if (prev === undefined) {
			this.#records.set(path, disknode);
			this.#count(disknode, 1);
			this.#membership_moved = true;
		} else {
			if (
				prev.size === disknode.size &&
				prev.mtime === disknode.mtime &&
				prev.ctime === disknode.ctime &&
				prev.source_dir === disknode.source_dir
			) {
				return;
			}
			this.#records.set(path, disknode);
			if (prev.source_dir !== disknode.source_dir) {
				this.#count(prev, -1);
				this.#count(disknode, 1);
			}
			this.#meta_moved = true;
		}
		this.#watches.get(path)?.update?.();
		this.#settle();
	}

	/**
	 * Removes the file at `path`.
	 *
	 * @returns whether it was held
	 */
	delete(path: DiskfilePath): boolean {
		const prev = this.#records.get(path);
		if (prev === undefined) return false;
		this.#records.delete(path);
		this.#count(prev, -1);
		this.#membership_moved = true;
		this.#watches.get(path)?.update?.();
		this.#settle();
		return true;
	}

	/**
	 * Runs `fn`, moving `membership` and `meta` at most once each when it ends
	 * — for a snapshot, or any write of many files. Nests: the outermost batch
	 * moves them. Path readers are notified as each write lands.
	 */
	batch<T>(fn: () => T): T {
		this.#batch_depth++;
		try {
			return fn();
		} finally {
			this.#batch_depth--;
			this.#settle();
		}
	}

	#settle(): void {
		if (this.#batch_depth > 0) return;
		if (this.#membership_moved) {
			this.#membership_moved = false;
			this.membership++;
		}
		if (this.#meta_moved) {
			this.#meta_moved = false;
			this.meta++;
		}
	}

	/**
	 * Subscribes a reactive reader to `path`. The entry is made when the
	 * subscription starts, which a `$derived` read outside any effect also
	 * does — and nothing tears that one down: it leaves an entry per path
	 * that stays for good, even once the derived is collected and the path
	 * deleted, and writes to the path still notify it. So read `get` and
	 * `has` per path only in component effects, or deriveds that live in
	 * one; anything bulk or imperative reads the counters.
	 */
	#watch(path: string): void {
		if (!$effect.tracking()) return;
		let watch = this.#watches.get(path);
		if (!watch) {
			const created: DiskfileIndexWatch = { subscribe: null!, update: null };
			created.subscribe = createSubscriber((update) => {
				created.update = update;
				this.#watches.set(path, created);
				return () => {
					created.update = null;
					if (this.#watches.get(path) === created) this.#watches.delete(path);
				};
			});
			watch = created;
		}
		watch.subscribe();
	}

	/** Counts `disknode` into or out of `tree_index` and the directory counts. */
	#count(disknode: SerializableDisknode, delta: 1 | -1): void {
		const path = disknode.id;
		if (delta === 1) {
			this.tree_index.add_file(path, to_file_directories(path, '/'));
		} else {
			this.tree_index.remove_file(path, to_file_directories(path, '/'));
		}
		for (const dir of to_file_directories(path, disknode.source_dir)) {
			const count = (this.#directory_counts.get(dir) ?? 0) + delta;
			if (count > 0) {
				this.#directory_counts.set(dir, count);
				if (count === 1 && delta === 1) this.#directory_paths.add(dir);
			} else {
				this.#directory_counts.delete(dir);
				this.#directory_paths.delete(dir);
			}
		}
	}
}

/**
 * Creates a numeric sorter over records from `index` (`Diskfiles.on_disk`
 * and `Diskfiles.listed`) by a field the index changes in place. Those
 * arrays track only `membership`, and their records' fields other than `id`
 * may be stale, so the sorter reads each record's live one (untracked, so
 * no path is watched) and tracks `meta` itself (`Sorter.track`): a change
 * in place re-sorts under this sorter, and not under one that reads only
 * paths. A record the index doesn't hold (a file kept for a draft or a tab)
 * sorts by its own fields.
 *
 * @param index - the index the records come from
 * @param key - the sorter's key
 * @param label - the sorter's label
 * @param field - the record field to sort by
 * @param direction - the sort direction
 * @returns a sorter, unknown values last (`sort_by_numeric`)
 */
export const sort_index_records_by_numeric = (
	index: DiskfileIndex,
	key: string,
	label: string,
	field: 'size' | 'ctime' | 'mtime',
	direction: 'asc' | 'desc' = 'asc'
): Sorter<SerializableDisknode> => ({
	...sort_by_numeric<SerializableDisknode>(
		key,
		label,
		(record) => (untrack(() => index.get(record.id)) ?? record)[field],
		direction
	),
	track: () => index.meta
});
