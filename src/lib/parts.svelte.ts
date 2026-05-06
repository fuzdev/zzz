import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Part, PartJson, type PartJsonInput, type PartUnion} from './part.svelte.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_single_index} from './indexed_collection_helpers.svelte.js';
import {get_unique_name} from './helpers.js';
import {CellJson} from './cell_types.js';

export const PartsJson = CellJson.extend({
	items: z.array(PartJson).default(() => []),
}).meta({cell_class_name: 'Parts'});
export type PartsJson = z.infer<typeof PartsJson>;
export type PartsJsonInput = z.input<typeof PartsJson>;

export interface PartsOptions extends CellOptions<typeof PartsJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Parts extends Cell<typeof PartsJson> {
	// Initialize items with proper typing and unified indexes
	readonly items: IndexedCollection<PartUnion> = new IndexedCollection({
		indexes: [
			create_single_index({
				key: 'by_name',
				extractor: (part) => part.name,
				query_schema: z.string(),
			}),
			create_single_index({
				key: 'by_diskfile_path',
				extractor: (part) => (part.type === 'diskfile' ? part.path : undefined),
				query_schema: z.string(),
			}),
			// TODO dynamic index with the rendered content? needs to be lazy, ideally just using $derived
		],
	});

	constructor(options: PartsOptions) {
		super(PartsJson, options);

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

		this.init();
	}

	// TODO this json type is incorrect, it should have `json.type` as required
	/**
	 * Add a part to the collection.
	 */
	add(json: PartJsonInput): PartUnion {
		const j = !json.name ? {...json, name: this.generate_unique_name('new part')} : json;
		const part = Part.create(this.app, j);
		this.items.add(part);
		return part;
	}

	/**
	 * Generate a unique name for a part.
	 */
	generate_unique_name(base_name: string = 'new part'): string {
		return get_unique_name(base_name, this.items.single_index('by_name'));
	}

	/**
	 * Remove a part by id.
	 */
	remove(id: Uuid): boolean {
		return this.items.remove(id);
	}

	/**
	 * Find a part that references a specific file path.
	 */
	find_part_by_diskfile_path(path: string): PartUnion | undefined {
		return this.items.single_index('by_diskfile_path').get(path);
	}
}
