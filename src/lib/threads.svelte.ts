import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Thread} from './thread.svelte.js';
import {ThreadJson, type ThreadJsonInput} from './thread_types.js';
import type {Uuid} from './zod_helpers.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_multi_index, create_derived_index} from './indexed_collection_helpers.svelte.js';
import {ModelName} from './model.svelte.js';
import {to_reordered_list} from './list_helpers.js';
import {CellJson} from './cell_types.js';

export const ThreadsJson = CellJson.extend({
	items: z.array(ThreadJson).default(() => []),
	selected_id: z.string().nullable().default(null),
}).meta({cell_class_name: 'Threads'});
export type ThreadsJson = z.infer<typeof ThreadsJson>;
export type ThreadsJsonInput = z.input<typeof ThreadsJson>;

export interface ThreadsOptions extends CellOptions<typeof ThreadsJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Threads extends Cell<typeof ThreadsJson> {
	readonly items: IndexedCollection<Thread> = new IndexedCollection({
		indexes: [
			create_multi_index({
				key: 'by_model_name',
				extractor: (thread) => thread.model_name,
				query_schema: ModelName,
			}),
			create_derived_index({
				key: 'manual_order',
				compute: (collection) => collection.values,
			}),
		],
	});

	selected_id: Uuid | null = $state.raw(null);
	readonly selected: Thread | undefined = $derived(
		this.selected_id ? this.items.by_id.get(this.selected_id) : undefined,
	);
	readonly selected_id_error: boolean = $derived(
		this.selected_id !== null && this.selected === undefined,
	);

	/** Ordered array of threads derived from the `manual_order` index. */
	readonly ordered_items: Array<Thread> = $derived(this.items.derived_index('manual_order'));

	constructor(options: ThreadsOptions) {
		super(ThreadsJson, options);

		this.decoders = {
			// TODO @many improve this API, maybe infer or create a helper, duplicated many places
			items: (items) => {
				if (Array.isArray(items)) {
					this.items.clear();
					for (const item_json of items) {
						this.add(item_json);
					}
				}
				return HANDLED;
			},
		};

		// Initialize explicitly after all properties are defined
		this.init();
	}

	add(json?: ThreadJsonInput, select?: boolean): Thread {
		const thread = new Thread({app: this.app, json});
		return this.add_thread(thread, select);
	}

	// Consistent method signature with other collection classes
	add_thread(thread: Thread, select?: boolean): Thread {
		this.items.add(thread);

		if (select || this.selected_id === null) {
			this.selected_id = thread.id;
		}
		return thread;
	}

	add_many(threads_json: Array<ThreadJsonInput>, select?: boolean | number): Array<Thread> {
		const threads = threads_json.map((json) => new Thread({app: this.app, json}));
		this.items.add_many(threads);

		// Select the first or the specified thread if none is currently selected
		if (
			select === true ||
			typeof select === 'number' ||
			(this.selected_id === null && threads.length > 0)
		) {
			const index = typeof select === 'number' ? select : 0;
			const thread = threads[index];
			if (thread) {
				this.selected_id = thread.id;
			}
		}

		return threads;
	}

	remove(id: Uuid): void {
		// For a single id, use a direct approach rather than creating an array
		this.#remove_reference_from_chats(id);

		const removed = this.items.remove(id);
		if (removed && id === this.selected_id) {
			this.select_next();
		}
	}

	remove_many(ids: Array<Uuid>): number {
		// Remove references to these threads from all chats before removing them
		this.#remove_references_from_chats(ids);

		// Store the current selected id
		const current_selected = this.selected_id;

		// Remove the threads
		const removed_count = this.items.remove_many(ids);

		// If the selected thread was removed, select a new one
		if (current_selected !== null && ids.includes(current_selected)) {
			this.select_next();
		}

		return removed_count;
	}

	// TODO these two methods feel like a code smell, should maintain the collections more automatically
	#remove_reference_from_chats(thread_id: Uuid): void {
		for (const chat of this.app.chats.items.by_id.values()) {
			chat.remove_thread(thread_id);
		}
	}
	#remove_references_from_chats(thread_ids: Array<Uuid>): void {
		// If there's only one item, use the single-item optimized version
		if (thread_ids.length === 1) {
			this.#remove_reference_from_chats(thread_ids[0]!); // guaranteed by length === 1
			return;
		}

		for (const chat of this.app.chats.items.by_id.values()) {
			chat.remove_threads(thread_ids);
		}
	}

	// TODO @many extract a selection helper class?
	select(thread_id: Uuid | null): void {
		this.selected_id = thread_id;
	}

	select_next(): void {
		const {by_id} = this.items;
		const next = by_id.values().next();
		this.select(next.value?.id ?? null);
	}

	reorder_threads(from_index: number, to_index: number): void {
		this.items.indexes.manual_order = to_reordered_list(this.ordered_items, from_index, to_index);
	}
}
