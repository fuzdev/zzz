import {z} from 'zod';

import {ProviderName} from './provider_types.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import type {Provider} from './provider.svelte.js';

export const ModelName = z.string().trim();
export type ModelName = z.infer<typeof ModelName>;

export const ModelJson = CellJson.extend({
	// TODO consider whether we should support one model with multiple providers,
	// or individual models per provider, currently we expect
	// `name` to be unique across providers and this needs to change,
	// I think it's like chats/prompts/etc, names should not be unique,
	// unless we think they're more like file paths? `provider_name/model_name` seems good for `path`?
	// that would make model/provider name like filenames, makes sense
	name: ModelName,
	provider_name: ProviderName,
	tags: z.array(z.string()).default(() => []),

	// TODO expand/improve these
	// fetched from provider APIs:
	architecture: z.string().optional(),
	parameter_count: z.number().optional(),
	context_window: z.number().optional(),
	output_token_limit: z.number().optional(),
	embedding_length: z.number().optional(),
	/** Size in gigabytes. */
	filesize: z.number().optional(),
	cost_input: z.number().optional(),
	cost_output: z.number().optional(),
	training_cutoff: z.string().optional(),
}).meta({cell_class_name: 'Model'});
export type ModelJson = z.infer<typeof ModelJson>;
export type ModelJsonInput = z.input<typeof ModelJson>;

export interface ModelOptions extends CellOptions<typeof ModelJson> {}

export class Model extends Cell<typeof ModelJson> {
	name: ModelName = $state.raw()!;
	provider_name: ProviderName = $state.raw()!;
	tags: Array<string> = $state()!;
	architecture: string | undefined = $state.raw();
	parameter_count: number | undefined = $state.raw();
	context_window: number | undefined = $state.raw();
	output_token_limit: number | undefined = $state.raw();
	embedding_length: number | undefined = $state.raw();
	/** Size in gigabytes. */
	filesize: number | undefined = $state.raw();
	cost_input: number | undefined = $state.raw();
	cost_output: number | undefined = $state.raw();
	training_cutoff: string | undefined = $state.raw();

	/**
	 * Lookup the provider for this model.
	 */
	readonly provider: Provider | undefined = $derived(
		this.app.providers.find_by_name(this.provider_name),
	);

	readonly context_window_formatted: string | null = $derived(
		this.context_window ? (this.context_window / 1000).toFixed(0) + 'k' : null,
	);

	constructor(options: ModelOptions) {
		super(ModelJson, options);
		this.init();
	}
}

export const ModelSchema = z.instanceof(Model);
