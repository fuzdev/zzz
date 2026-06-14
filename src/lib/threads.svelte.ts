import {z} from 'zod';
import type {Uuid} from '@fuzdev/fuz_util/id.js';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Thread} from './thread.svelte.js';
import {ThreadJson} from './thread_types.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {CellJson} from './cell_types.js';

export const ThreadsJson = CellJson.extend({
	items: z.array(ThreadJson).default(() => []),
}).meta({cell_class_name: 'Threads'});
export type ThreadsJson = z.infer<typeof ThreadsJson>;
export type ThreadsJsonInput = z.input<typeof ThreadsJson>;

export interface ThreadsOptions extends CellOptions<typeof ThreadsJson> {}

export class Threads extends Cell<typeof ThreadsJson> {
	readonly items: IndexedCollection<Thread> = new IndexedCollection();

	constructor(options: ThreadsOptions) {
		super(ThreadsJson, options);

		this.decoders = {
			// TODO @many improve this API, maybe infer or create a helper, duplicated many places
			items: (items) => {
				if (Array.isArray(items)) {
					this.items.clear();
					for (const item_json of items) {
						this.add_thread(new Thread({app: this.app, json: item_json}));
					}
				}
				return HANDLED;
			},
		};

		// Initialize explicitly after all properties are defined
		this.init();
	}

	// Consistent method signature with other collection classes
	add_thread(thread: Thread): Thread {
		this.items.add(thread);
		return thread;
	}

	remove(id: Uuid): void {
		// For a single id, use a direct approach rather than creating an array
		this.#remove_reference_from_chats(id);
		this.items.remove(id);
	}

	remove_many(ids: Array<Uuid>): number {
		// Remove references to these threads from all chats before removing them
		this.#remove_references_from_chats(ids);
		return this.items.remove_many(ids);
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
}
