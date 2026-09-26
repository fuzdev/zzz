import { z } from 'zod';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { Thread } from './thread.svelte.ts';
import { ThreadJson } from './thread_types.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { CellJson } from './cell_types.ts';

export const ThreadsJson = CellJson.extend({
	items: z.array(ThreadJson).default(() => [])
}).meta({ cell_class_name: 'Threads' });
export type ThreadsJson = z.infer<typeof ThreadsJson>;
export type ThreadsJsonInput = z.input<typeof ThreadsJson>;

export interface ThreadsOptions extends CellOptions<typeof ThreadsJson> {}

export class Threads extends Cell<typeof ThreadsJson> {
	readonly items: IndexedCollection<Thread> = new IndexedCollection({
		dispose_item: (thread) => thread.dispose()
	});

	constructor(options: ThreadsOptions) {
		super(ThreadsJson, options);

		this.decoders = {
			items: create_collection_decoder(
				() => this.items.clear(),
				(json) => this.add_thread(new Thread({ app: this.app, json }))
			)
		};

		// Initialize explicitly after all properties are defined
		this.init();
	}

	// Consistent method signature with other collection classes
	add_thread(thread: Thread): Thread {
		this.items.add(thread);
		return thread;
	}

	/**
	 * Removes a thread — from every chat that has it, and its turns' parts
	 * unless another turn references them. Disposing the thread cancels its in-flight completion.
	 */
	remove(id: Uuid): void {
		this.remove_many([id]);
	}

	/**
	 * Removes threads — see `remove`.
	 *
	 * @returns the number of threads removed
	 */
	remove_many(ids: Array<Uuid>): number {
		for (const chat of this.app.chats.items.by_id.values()) {
			chat.detach_threads(ids);
		}
		return this.#remove_detached(ids);
	}

	/**
	 * Removes the threads in `ids` that no chat has anymore.
	 *
	 * @returns the number of threads removed
	 */
	remove_unreferenced(ids: Iterable<Uuid>): number {
		const referenced: Set<Uuid> = new Set();
		for (const chat of this.app.chats.items.by_id.values()) {
			for (const id of chat.thread_ids) referenced.add(id);
		}
		const unreferenced: Array<Uuid> = [];
		for (const id of ids) {
			if (!referenced.has(id)) unreferenced.push(id);
		}
		// already in no chat, so there's nothing to detach
		return unreferenced.length ? this.#remove_detached(unreferenced) : 0;
	}

	/**
	 * Removes threads no chat has, with their turns' parts unless another turn references them.
	 */
	#remove_detached(ids: Array<Uuid>): number {
		const part_ids: Array<Uuid> = [];
		for (const id of ids) {
			const thread = this.items.by_id.get(id);
			if (thread) part_ids.push(...thread.part_ids);
		}
		const removed_count = this.items.remove_many(ids);
		this.app.parts.remove_unreferenced(part_ids);
		return removed_count;
	}
}
