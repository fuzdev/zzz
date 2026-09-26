import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { Space, SpaceJson, type SpaceJsonInput } from './space.svelte.ts';
import { HANDLED } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index } from './indexed_collection_helpers.svelte.ts';
import { get_unique_name } from './helpers.ts';
import { CellJson } from './cell_types.ts';

export const SCRATCHPAD_NAME = 'scratchpad';

export const SpacesJson = CellJson.extend({
	items: z.array(SpaceJson).default(() => []),
	active_id: Uuid.nullable().default(null),
	scratchpad_id: Uuid.nullable().default(null).meta({
		description:
			"The scratchpad, the default space, which can't be removed. Renaming it keeps it the scratchpad."
	})
}).meta({ cell_class_name: 'Spaces' });
export type SpacesJson = z.infer<typeof SpacesJson>;
export type SpacesJsonInput = z.input<typeof SpacesJson>;

export interface SpacesOptions extends CellOptions<typeof SpacesJson> {}

export class Spaces extends Cell<typeof SpacesJson> {
	readonly items: IndexedCollection<Space> = new IndexedCollection({
		dispose_item: (space) => space.dispose(),
		indexes: [
			create_single_index({
				key: 'by_name',
				extractor: (space) => space.name,
				query_schema: z.string()
			})
		]
	});

	active_id: Uuid | null = $state.raw()!;

	readonly active: Space | undefined = $derived(
		this.active_id ? this.items.by_id.get(this.active_id) : undefined
	);

	scratchpad_id: Uuid | null = $state.raw()!;

	/** The default space, identified by id so renaming it doesn't change which space it is. */
	readonly scratchpad: Space | undefined = $derived(
		this.scratchpad_id ? this.items.by_id.get(this.scratchpad_id) : undefined
	);

	constructor(options: SpacesOptions) {
		super(SpacesJson, options);

		this.decoders = {
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

		this.init();
	}

	/**
	 * Applies `value`, then ensures the scratchpad — including on construction,
	 * so replacing the spaces can never leave none.
	 */
	override set_json(value?: SpacesJsonInput): void {
		super.set_json(value);
		this.ensure_scratchpad();
	}

	/**
	 * Returns the scratchpad, adopting a space named `SCRATCHPAD_NAME`
	 * (e.g. from JSON without a `scratchpad_id`) or creating and activating one if needed.
	 */
	ensure_scratchpad(): Space {
		let scratchpad = this.scratchpad;
		if (!scratchpad) {
			scratchpad = this.items.single_index('by_name').get(SCRATCHPAD_NAME);
			if (!scratchpad) {
				scratchpad = this.add({ name: SCRATCHPAD_NAME });
				this.active_id = scratchpad.id;
			}
			this.scratchpad_id = scratchpad.id;
		}
		return scratchpad;
	}

	add(json?: SpaceJsonInput): Space {
		const j = !json?.name ? { ...json, name: this.generate_unique_name('new space') } : json;
		const space = new Space({ app: this.app, json: j });
		this.items.add(space);
		return space;
	}

	generate_unique_name(base_name: string = 'new space'): string {
		return get_unique_name(base_name, this.items.single_index('by_name'));
	}

	/**
	 * Removes and disposes a space. The scratchpad can't be removed.
	 */
	remove(id: Uuid): void {
		if (id === this.scratchpad_id) return;
		if (!this.items.remove(id)) return;
		if (id === this.active_id) {
			this.active_id = this.scratchpad?.id ?? null;
		}
	}

	activate(id: Uuid): void {
		if (this.items.by_id.has(id)) {
			this.active_id = id;
		}
	}
}
