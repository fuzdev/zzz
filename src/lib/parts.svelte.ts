import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { Part, PartJson, type PartJsonInput, type PartUnion } from './part.svelte.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index } from './indexed_collection_helpers.svelte.ts';
import { get_unique_name } from './helpers.ts';
import { CellJson } from './cell_types.ts';

export const PartsJson = CellJson.extend({
	items: z.array(PartJson).default(() => [])
}).meta({ cell_class_name: 'Parts' });
export type PartsJson = z.infer<typeof PartsJson>;
export type PartsJsonInput = z.input<typeof PartsJson>;

export interface PartsOptions extends CellOptions<typeof PartsJson> {}

export class Parts extends Cell<typeof PartsJson> {
	// Initialize items with proper typing and unified indexes
	readonly items: IndexedCollection<PartUnion> = new IndexedCollection({
		dispose_item: (part) => part.dispose(),
		indexes: [
			create_single_index({
				key: 'by_name',
				extractor: (part) => part.name
			}),
			create_single_index({
				key: 'by_diskfile_path',
				extractor: (part) => (part.type === 'diskfile' ? part.path : undefined)
			})
			// TODO an index over the rendered content? needs to be lazy, ideally a `reactive` index
		]
	});

	constructor(options: PartsOptions) {
		super(PartsJson, options);

		this.decoders = {
			items: create_collection_decoder(
				() => this.items.clear(),
				(json) => this.add(json)
			)
		};

		this.init();
	}

	// TODO this json type is incorrect, it should have `json.type` as required
	/**
	 * Add a part to the collection.
	 */
	add(json: PartJsonInput): PartUnion {
		const j = !json.name ? { ...json, name: this.generate_unique_name('new part') } : json;
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
	 * Removes the parts in `ids` that no turn references anymore. Turns are the only
	 * owners of the parts in this collection — a prompt's parts are its own instances,
	 * and `Diskfile.part` is a lookup, not a reference.
	 *
	 * @returns the number of parts removed
	 */
	remove_unreferenced(ids: Iterable<Uuid>): number {
		const referenced: Set<Uuid> = new Set();
		for (const thread of this.app.threads.items.by_id.values()) {
			for (const turn of thread.turns.by_id.values()) {
				for (const id of turn.part_ids) referenced.add(id);
			}
		}
		const unreferenced: Array<Uuid> = [];
		for (const id of ids) {
			if (!referenced.has(id)) unreferenced.push(id);
		}
		return this.items.remove_many(unreferenced);
	}

	/**
	 * Find a part that references a specific file path.
	 */
	find_part_by_diskfile_path(path: string): PartUnion | undefined {
		return this.items.single_index('by_diskfile_path').get(path);
	}
}
