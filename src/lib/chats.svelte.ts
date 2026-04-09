import {z} from 'zod';
import {page} from '$app/state';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Chat, ChatJson, type ChatJsonInput} from './chat.svelte.js';
import type {Uuid} from './zod_helpers.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_single_index, create_derived_index} from './indexed_collection_helpers.svelte.js';
import {to_reordered_list} from './list_helpers.js';
import {get_unique_name} from './helpers.js';
import {to_chats_url} from './nav_helpers.js';
import {chat_template_defaults} from './config_defaults.js';
import type {ChatTemplate} from './chat_template.js';
import {CellJson} from './cell_types.js';
import {goto_unless_current} from './navigation_helpers.js';

export const ChatsJson = CellJson.extend({
	items: z.array(ChatJson).default(() => []),
	selected_id: z.string().nullable().default(null),
	selected_id_last_non_null: z.string().nullable().default(null),
	show_sort_controls: z.boolean().default(false),
}).meta({cell_class_name: 'Chats'});
export type ChatsJson = z.infer<typeof ChatsJson>;
export type ChatsJsonInput = z.input<typeof ChatsJson>;

export interface ChatsOptions extends CellOptions<typeof ChatsJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Chats extends Cell<typeof ChatsJson> {
	readonly items: IndexedCollection<Chat> = new IndexedCollection({
		indexes: [
			create_single_index({
				key: 'by_name',
				extractor: (chat) => chat.name,
				query_schema: z.string(),
			}),

			create_derived_index({
				key: 'manual_order',
				compute: (collection) => collection.values,
			}),
		],
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
		this.#selected_id ? this.items.by_id.get(this.#selected_id) : undefined,
	);
	readonly selected_id_error: boolean = $derived(
		this.#selected_id !== null && this.selected === undefined,
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
			},
		};

		// Initialize explicitly after all properties are defined
		this.init();
	}

	add(json?: ChatJsonInput, select?: boolean): Chat {
		const j = !json?.name ? {...json, name: this.generate_unique_name('new chat')} : json;
		const chat = new Chat({app: this.app, json: j});
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

	add_many(chats_json: Array<ChatJsonInput>, select?: boolean | number): Array<Chat> {
		const chats = chats_json.map((json) => new Chat({app: this.app, json}));
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

	remove(id: Uuid): void {
		const removed = this.items.remove(id);
		if (removed && id === this.#selected_id) {
			void this.select_next();
		}
	}

	remove_many(ids: Array<Uuid>): number {
		// Remove the chats
		const removed_count = this.items.remove_many(ids);

		// If the selected chat was removed, select a new one
		if (this.#selected_id !== null && ids.includes(this.#selected_id)) {
			void this.select_next();
		}

		return removed_count;
	}

	// TODO @many extract a selection helper class?
	select(chat_id: Uuid | null): Promise<void> {
		return this.navigate_to(chat_id);
	}

	select_next(): Promise<void> {
		const {by_id} = this.items;
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
