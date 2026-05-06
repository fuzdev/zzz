import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Action, ActionJson, type ActionJsonInput} from './action.svelte.js';
import {ActionMethod} from './action_metatypes.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_multi_index} from './indexed_collection_helpers.svelte.js';
import {CellJson} from './cell_types.js';

export const HISTORY_LIMIT_DEFAULT = 512;
export const PONG_DISPLAY_LIMIT = 6;

export const ActionsJson = CellJson.extend({
	items: z.array(ActionJson).default(() => []),
}).meta({cell_class_name: 'Actions'});
export type ActionsJson = z.infer<typeof ActionsJson>;
export type ActionsJsonInput = z.input<typeof ActionsJson>;

export interface ActionsOptions extends CellOptions<typeof ActionsJson> {
	history_limit?: number;
}

/** Stores the action history. */
export class Actions extends Cell<typeof ActionsJson> {
	// TODO maybe rename to `history`, or extract an `ActionHistory` or more generic class
	readonly items: IndexedCollection<Action> = new IndexedCollection({
		indexes: [
			create_multi_index({
				key: 'by_method',
				extractor: (action) => action.method,
				query_schema: ActionMethod,
			}),
		],
	});

	// TODO @many refactor this into the IndexedCollection -- if this state remains we can have a setter that forwards the value
	history_limit: number = $state.raw(HISTORY_LIMIT_DEFAULT);

	// TODO think about these - filter/sort by method/kind?
	// readonly pings: Array<Action> = $derived(this.items.where('by_method', 'ping'));
	// get_latest_by_method(method: ActionMethod, limit: number = this.history_limit): Array<Action> {
	// 	return this.items.latest('by_method', method, limit);
	// }

	constructor(options: ActionsOptions) {
		super(ActionsJson, options);

		// Set history limit if provided
		if (options.history_limit !== undefined) {
			this.history_limit = options.history_limit;
		}

		this.decoders = {
			// TODO @many improve this API, maybe infer or create a helper, duplicated many places
			items: (items) => {
				if (Array.isArray(items)) {
					this.items.clear();
					for (const item_json of items) {
						this.add_from_json(item_json);
					}
				}
				return HANDLED;
			},
		};

		this.init();
	}

	/**
	 * Override to populate the indexed collection after parsing JSON.
	 */
	override set_json(value?: ActionsJsonInput): void {
		super.set_json(value);

		// Trim to history limit after loading
		this.#trim_to_history_limit(); // TODO should be unnecessary to override `set_json` for this
	}

	add(action: Action): void {
		this.items.add(action);

		// TODO refactor
		this.#trim_to_history_limit();
	}

	add_from_json(action_json: ActionJsonInput): Action {
		const action = new Action({app: this.app, json: action_json});
		this.add(action);
		return action;
	}

	// TODO @many refactor this into the IndexedCollection -- need to test the new behavior
	/**
	 * Trims the collection to the maximum allowed size by removing oldest actions. (FIFO)
	 */
	#trim_to_history_limit(): void {
		// Calculate how many items to remove and use the optimized method
		const excess = this.items.size - this.history_limit;
		if (excess <= 0) return;
		const ids = [];
		for (const action of this.items.by_id.values()) {
			ids.push(action.id);
			if (ids.length === excess) break;
		}
		this.items.remove_many(ids);
	}
}
