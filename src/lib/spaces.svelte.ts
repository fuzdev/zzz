import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Space, SpaceJson, type SpaceJsonInput} from './space.svelte.js';
import type {Uuid} from './zod_helpers.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_single_index} from './indexed_collection_helpers.svelte.js';
import {get_unique_name} from './helpers.js';
import {CellJson} from './cell_types.js';

export const SCRATCHPAD_NAME = 'scratchpad';

export const SpacesJson = CellJson.extend({
	items: z.array(SpaceJson).default(() => []),
	active_id: z.string().nullable().default(null),
}).meta({cell_class_name: 'Spaces'});
export type SpacesJson = z.infer<typeof SpacesJson>;
export type SpacesJsonInput = z.input<typeof SpacesJson>;

export interface SpacesOptions extends CellOptions<typeof SpacesJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Spaces extends Cell<typeof SpacesJson> {
	readonly items: IndexedCollection<Space> = new IndexedCollection({
		indexes: [
			create_single_index({
				key: 'by_name',
				extractor: (space) => space.name,
				query_schema: z.string(),
			}),
		],
	});

	active_id: Uuid | null = $state.raw()!;

	readonly active: Space | undefined = $derived(
		this.active_id ? this.items.by_id.get(this.active_id) : undefined,
	);

	readonly scratchpad: Space | undefined = $derived(
		this.items.single_index('by_name').get(SCRATCHPAD_NAME),
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
			},
		};

		this.init();

		this.ensure_scratchpad();
	}

	ensure_scratchpad(): Space {
		let scratchpad = this.scratchpad;
		if (!scratchpad) {
			scratchpad = this.add({name: SCRATCHPAD_NAME});
			this.active_id = scratchpad.id;
		}
		return scratchpad;
	}

	add(json?: SpaceJsonInput): Space {
		const j = !json?.name ? {...json, name: this.generate_unique_name('new space')} : json;
		const space = new Space({app: this.app, json: j});
		this.items.add(space);
		return space;
	}

	generate_unique_name(base_name: string = 'new space'): string {
		return get_unique_name(base_name, this.items.single_index('by_name'));
	}

	remove(id: Uuid): void {
		const space = this.items.by_id.get(id);
		// prevent removing the scratchpad
		if (space?.name === SCRATCHPAD_NAME) return;
		this.items.remove(id);
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
