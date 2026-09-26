import { z } from 'zod';
import { page } from '$app/state';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { Prompt, PromptJson, type PromptJsonInput } from './prompt.svelte.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index, create_derived_index } from './indexed_collection_helpers.svelte.ts';
import { to_reordered_list } from './list_helpers.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import { get_unique_name } from './helpers.ts';
import { goto_unless_current, to_prompts_url } from './nav.ts';
import { CellJson } from './cell_types.ts';

export const PromptsJson = CellJson.extend({
	items: z.array(PromptJson).default(() => []),
	selected_id: z.string().nullable().default(null),
	show_sort_controls: z.boolean().default(false)
}).meta({ cell_class_name: 'Prompts' });
export type PromptsJson = z.infer<typeof PromptsJson>;
export type PromptsJsonInput = z.input<typeof PromptsJson>;

export interface PromptsOptions extends CellOptions<typeof PromptsJson> {}

export class Prompts extends Cell<typeof PromptsJson> {
	// Initialize items with proper typing and unified indexes
	readonly items: IndexedCollection<Prompt> = new IndexedCollection({
		dispose_item: (prompt) => prompt.dispose(),
		indexes: [
			create_single_index({
				key: 'by_name',
				extractor: (prompt) => prompt.name
			}),

			create_derived_index({
				key: 'recent_prompts',
				compute: (collection) => collection.values,
				sort: (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
				onadd: (items, item) => {
					// Insert at the right position based on creation date
					const index = items.findIndex(
						(p) => new Date(item.created).getTime() > new Date(p.created).getTime()
					);
					if (index === -1) {
						items.push(item);
					} else {
						items.splice(index, 0, item);
					}
					return items;
				}
			}),

			create_derived_index({
				key: 'manual_order',
				compute: (collection) => collection.values
			})
		]
	});

	#selected_id: Uuid | null = $state.raw()!;
	selected_id_last_non_null: Uuid | null = $state.raw()!;
	get selected_id(): Uuid | null {
		return this.#selected_id;
	}
	set selected_id(value: Uuid | null) {
		this.#selected_id = value;
		if (value !== null) this.selected_id_last_non_null = value;
	}

	readonly selected: Prompt | undefined = $derived(
		this.selected_id ? this.items.by_id.get(this.selected_id) : undefined
	);

	/** Controls visibility of sort controls in the prompts list. */
	show_sort_controls: boolean = $state.raw()!;

	/** Ordered array of prompts derived from the `manual_order` index. */
	readonly ordered_items: Array<Prompt> = $derived(this.items.derived_index('manual_order'));

	constructor(options: PromptsOptions) {
		super(PromptsJson, options);

		this.decoders = {
			items: create_collection_decoder(
				() => this.items.clear(),
				(json) => this.add(json)
			)
		};

		this.init();
	}

	/**
	 * The prompts with a diskfile part for `path`. A prompt owns its part
	 * instances, so a file is matched by path, not by part identity.
	 */
	filter_by_diskfile_path(path: DiskfilePath): Array<Prompt> {
		// TODO add an index?
		return this.ordered_items.filter((prompt) =>
			prompt.parts.some((part) => part.type === 'diskfile' && part.path === path)
		);
	}

	add(json?: PromptJsonInput): Prompt {
		const j = !json?.name ? { ...json, name: this.generate_unique_name('new prompt') } : json;
		const prompt = new Prompt({ app: this.app, json: j });
		this.items.add(prompt);
		if (this.selected_id === null) {
			this.selected_id = prompt.id;
		}
		return prompt;
	}

	generate_unique_name(base_name: string = 'new prompt'): string {
		return get_unique_name(base_name, this.items.single_index('by_name'));
	}

	// TODO @many look into making these more generic, less manual bookkeeping
	add_many(prompts_json: Array<PromptJsonInput>): Array<Prompt> {
		const prompts = prompts_json.map((json) => new Prompt({ app: this.app, json }));
		this.items.add_many(prompts);

		// Set selected_id to the first prompt if none is selected
		if (this.selected_id === null && prompts.length > 0) {
			const first_prompt = prompts[0];
			if (first_prompt) {
				this.selected_id = first_prompt.id;
			}
		}

		return prompts;
	}

	/**
	 * Removes a prompt, disposing it with its parts — see `remove_many`.
	 */
	remove(prompt: Prompt): void {
		this.remove_many([prompt.id]);
	}

	// TODO @many look into making these more generic, less manual bookkeeping
	/**
	 * Removes prompts, selecting another if the selected one went, and forgetting
	 * the last selected one if it went.
	 *
	 * @returns the number of prompts removed
	 */
	remove_many(prompt_ids: Array<Uuid>): number {
		// Store the current selected id
		const current_selected = this.selected_id;

		// Remove the prompts
		const removed_count = this.items.remove_many(prompt_ids);

		// nav links fall back to the last selected prompt, which may be gone now
		if (
			this.selected_id_last_non_null !== null &&
			prompt_ids.includes(this.selected_id_last_non_null)
		) {
			this.selected_id_last_non_null = null;
		}

		// If the selected prompt was removed, select a new one
		if (removed_count && current_selected !== null && prompt_ids.includes(current_selected)) {
			void this.select_next();
		}

		return removed_count;
	}

	// TODO @many extract a selection helper class?
	select(prompt_id: Uuid | null): Promise<void> {
		return this.navigate_to(prompt_id);
	}

	select_next(): Promise<void> {
		const { by_id } = this.items;
		const next = by_id.values().next();
		return this.navigate_to(next.value?.id ?? null);
	}

	async navigate_to(prompt_id: Uuid | null, force = false): Promise<void> {
		const url = to_prompts_url(prompt_id);
		if (!force && page.url.pathname === url) return;
		return goto_unless_current(url);
	}

	reorder_prompts(from_index: number, to_index: number): void {
		this.items.indexes.manual_order = to_reordered_list(this.ordered_items, from_index, to_index);
	}

	/**
	 * Toggles the visibility of sort controls in the prompts list.
	 */
	toggle_sort_controls(value = !this.show_sort_controls): void {
		this.show_sort_controls = value;
	}
}

export const PromptsSchema = z.instanceof(Prompts);
