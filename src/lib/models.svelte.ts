import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Model, ModelJson, type ModelJsonInput} from './model.svelte.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {
	create_single_index,
	create_multi_index,
	create_derived_index,
} from './indexed_collection_helpers.svelte.js';
import {CellJson} from './cell_types.js';

export const ModelsJson = CellJson.extend({
	items: z.array(ModelJson).default(() => []),
}).meta({cell_class_name: 'Models'});
export type ModelsJson = z.infer<typeof ModelsJson>;
export type ModelsJsonInput = z.input<typeof ModelsJson>;

export interface ModelsOptions extends CellOptions<typeof ModelsJson> {}

export class Models extends Cell<typeof ModelsJson> {
	readonly items: IndexedCollection<Model> = new IndexedCollection({
		indexes: [
			// TODO this is a mistake to have `name` be unique,
			// unless we prefix with `${provider_name}/${model_name}` and have some other property -
			// I think designing around multiple providers per model is the wrong approach,
			// because there may be a lot of details that need to be overridden per-provider,
			// although that could potentially work with some rules around overrrides
			create_single_index({
				key: 'name',
				extractor: (model) => model.name,
				query_schema: z.string(),
			}),

			create_multi_index({
				key: 'provider_name',
				extractor: (model) => model.provider_name,
				query_schema: z.string(),
			}),

			create_multi_index({
				key: 'tag',
				extractor: (model) => model.tags,
				query_schema: z.string(),
				matches: (model) => model.tags.length > 0,
			}),

			create_derived_index({
				key: 'ordered_by_name',
				compute: (collection) => collection.values,
				sort: (a, b) => a.name.localeCompare(b.name),
			}),
		],
	});

	/** Get all models ordered alphabetically by name. */
	readonly ordered_by_name: Array<Model> = $derived(this.items.derived_index('ordered_by_name'));

	constructor(options: ModelsOptions) {
		super(ModelsJson, options);

		// Add custom decoder for the items property,
		// which also prevents it from automatically overwriting our collection
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

	add(model_json: ModelJsonInput): void {
		const model = new Model({app: this.app, json: model_json});
		this.items.add(model);
	}

	add_many(models_json: Array<ModelJsonInput>): void {
		const models = models_json.map((json) => new Model({app: this.app, json}));
		this.items.add_many(models);
	}

	find_by_name(name: string): Model | undefined {
		return this.items.by_optional('name', name);
	}

	filter_by_names(names: Array<string>): Array<Model> | undefined {
		let found: Array<Model> | undefined = undefined;

		for (const name of names) {
			const model = this.items.by_optional('name', name);
			if (!model) continue;
			(found ??= []).push(model);
		}

		return found;
	}

	filter_by_tag(tag: string): Array<Model> {
		return this.items.where('tag', tag);
	}
}
