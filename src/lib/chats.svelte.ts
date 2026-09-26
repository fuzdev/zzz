import { z } from 'zod';
import { page } from '$app/state';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { Chat, ChatJson, type ChatJsonInput } from './chat.svelte.ts';
import { HANDLED } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index, create_derived_index } from './indexed_collection_helpers.svelte.ts';
import { to_reordered_list } from './list_helpers.ts';
import { get_unique_name } from './helpers.ts';
import { to_chats_url } from './nav_helpers.ts';
import { chat_template_defaults } from './config_defaults.ts';
import type { ChatTemplate } from './chat_template.ts';
import { CellJson } from './cell_types.ts';
import { goto_unless_current } from './navigation_helpers.ts';

export const ChatsJson = CellJson.extend({
	items: z.array(ChatJson).default(() => []),
	selected_id: z.string().nullable().default(null),
	selected_id_last_non_null: z.string().nullable().default(null),
	show_sort_controls: z.boolean().default(false)
}).meta({ cell_class_name: 'Chats' });
export type ChatsJson = z.infer<typeof ChatsJson>;
export type ChatsJsonInput = z.input<typeof ChatsJson>;

export interface ChatsOptions extends CellOptions<typeof ChatsJson> {}

export class Chats extends Cell<typeof ChatsJson> {
	readonly items: IndexedCollection<Chat> = new IndexedCollection({
		dispose_item: (chat) => chat.dispose(),
		indexes: [
			create_single_index({
				key: 'by_name',
				extractor: (chat) => chat.name,
				query_schema: z.string()
			}),

			create_derived_index({
				key: 'manual_order',
				compute: (collection) => collection.values
			})
		]
	});

	// TODO would be nice to story a history of selected ids so
	// e.g. when deleting a chat we can navigate back to where we were
	#selected_id: Uuid | null = $state.raw()!;
	selected_id_last_non_null: Uuid | null = $state.raw()!;
	get selected_id(): Uuid | null {
		return this.#selected_id;
	}
	set selected_id(value: Uuid | null) {
		this.#selected_id = value;
		if (value !== null) this.selected_id_last_non_null = value;
	}

	readonly selected: Chat | undefined = $derived(
		this.#selected_id ? this.items.by_id.get(this.#selected_id) : undefined
	);
	readonly selected_id_error: boolean = $derived(
		this.#selected_id !== null && this.selected === undefined
	);

	/** Controls visibility of sort controls in the chats list. */
	show_sort_controls: boolean = $state.raw()!;

	/** Ordered array of chats derived from the `manual_order` index. */
	readonly ordered_items: Array<Chat> = $derived(this.items.derived_index('manual_order'));

	readonly items_by_name = $derived(this.items.single_index('by_name'));

	constructor(options: ChatsOptions) {
		super(ChatsJson, options);

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
			}
		};

		// Initialize explicitly after all properties are defined
		this.init();
	}

	/**
	 * Adds a chat. Without a `name` it gets a unique default one that
	 * auto-naming may replace; a given `name` is kept unless `json.autoname`
	 * says otherwise.
	 */
	add(json?: ChatJsonInput, select?: boolean): Chat {
		const j = !json?.name
			? { ...json, name: this.generate_unique_name('new chat') }
			: { autoname: false, ...json };
		const chat = new Chat({ app: this.app, json: j });
		return this.add_chat(chat, select);
	}

	generate_unique_name(base_name: string = 'new chat'): string {
		return get_unique_name(base_name, this.items_by_name);
	}

	add_chat(chat: Chat, select?: boolean): Chat {
		this.items.add(chat);
		if (select) {
			void this.select(chat.id);
		}
		return chat;
	}

	/**
	 * Duplicates `chat` with a unique name and fresh, empty threads for the same
	 * models — no threads or turns are shared with the original. The duplicate's
	 * selected thread mirrors the original's by position, and it inherits
	 * `autoname`, so auto-naming leaves its name alone unless the original's
	 * was still a default one.
	 * Threads whose model can't be found are skipped.
	 *
	 * @param chat - the chat to duplicate
	 * @returns the new chat, unselected
	 */
	duplicate(chat: Chat): Chat {
		const now = get_datetime_now();
		const new_chat = this.add_chat(
			chat.clone({
				name: this.generate_unique_name(to_duplicate_base_name(chat.name, this.items_by_name)),
				created: now,
				updated: now,
				thread_ids: [],
				selected_thread_id: null
			})
		);
		const { threads, selected_thread } = chat;
		for (const thread of threads) {
			if (thread.model) new_chat.add_thread(thread.model, thread === selected_thread);
		}
		return new_chat;
	}

	add_many(chats_json: Array<ChatJsonInput>, select?: boolean | number): Array<Chat> {
		const chats = chats_json.map((json) => new Chat({ app: this.app, json }));
		this.items.add_many(chats);

		// Select the first or the specified chat if none is currently selected
		if (
			select === true ||
			typeof select === 'number' ||
			(this.#selected_id === null && chats.length > 0)
		) {
			const index = typeof select === 'number' ? select : 0;
			const chat = chats[index];
			if (chat) {
				void this.select(chat.id);
			}
		}

		return chats;
	}

	/**
	 * Removes a chat, along with its threads unless another chat still has them —
	 * which cancels their in-flight completions and removes their turns' parts.
	 */
	remove(id: Uuid): void {
		this.remove_many([id]);
	}

	/**
	 * Removes chats — see `remove`.
	 *
	 * @returns the number of chats removed
	 */
	remove_many(ids: Array<Uuid>): number {
		const thread_ids: Array<Uuid> = [];
		for (const id of ids) {
			const chat = this.items.by_id.get(id);
			if (chat) thread_ids.push(...chat.thread_ids);
		}

		const removed_count = this.items.remove_many(ids);
		this.app.threads.remove_unreferenced(thread_ids);

		// nav links fall back to the last selected chat, which may be gone now
		if (this.selected_id_last_non_null !== null && ids.includes(this.selected_id_last_non_null)) {
			this.selected_id_last_non_null = null;
		}

		// If the selected chat was removed, select a new one
		if (removed_count && this.#selected_id !== null && ids.includes(this.#selected_id)) {
			void this.select_next();
		}

		return removed_count;
	}

	// TODO @many extract a selection helper class?
	select(chat_id: Uuid | null): Promise<void> {
		return this.navigate_to(chat_id);
	}

	select_next(): Promise<void> {
		const { by_id } = this.items;
		const next = by_id.values().next();
		return this.navigate_to(next.value?.id ?? null);
	}

	async navigate_to(chat_id: Uuid | null, force = false): Promise<void> {
		const url = to_chats_url(chat_id);
		this.app.ui.pending_element_to_focus_key = chat_id;
		if (!force && page.url.pathname === url) return;
		return goto_unless_current(url);
	}

	reorder_chats(from_index: number, to_index: number): void {
		this.items.indexes.manual_order = to_reordered_list(this.ordered_items, from_index, to_index);
	}

	/**
	 * Toggles the visibility of sort controls in the chats list.
	 */
	toggle_sort_controls(value = !this.show_sort_controls): void {
		this.show_sort_controls = value;
	}

	// TODO @many refactor with db
	chat_templates = $state.raw(chat_template_defaults);
	get_template_by_id(id: string): ChatTemplate | undefined {
		return this.chat_templates.find((t) => t.id === id);
	}
	get_default_template(): ChatTemplate {
		const template = this.chat_templates[0];
		if (!template) {
			throw new Error('No chat templates available');
		}
		return template;
	}
}

export const ChatsSchema = z.instanceof(Chats);

/**
 * Gets the base name to number a duplicate from, so duplicating `my chat 2`
 * yields `my chat 3` rather than `my chat 2 2`. The numeric suffix is only
 * stripped when the base name is itself an existing chat, so names that merely
 * end in a number (like `gpt 4`) are kept whole.
 *
 * @param name - the name of the chat being duplicated
 * @param existing_names - the names of existing chats
 * @returns the base name for `get_unique_name`
 */
export const to_duplicate_base_name = (
	name: string,
	existing_names: { has: (name: string) => boolean }
): string => {
	if (!name) return 'new chat';
	const base = name.replace(/ \d+$/, '');
	return base !== name && existing_names.has(base) ? base : name;
};
