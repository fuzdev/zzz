import {
	array,
	min_length,
	number,
	optional,
	pipe,
	string,
	transform,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { ProviderName } from './provider_types.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import type { Provider } from './provider.svelte.ts';

export const ModelName = pipe(
	string,
	transform((v: string) => v.trim()),
	min_length(1)
);
export type ModelName = Infer<typeof ModelName>;

export const ModelJson = cell_json_schema(
	{
		// TODO consider whether we should support one model with multiple providers,
		// or individual models per provider, currently we expect
		// `name` to be unique across providers and this needs to change,
		// I think it's like chats/prompts/etc, names should not be unique,
		// unless we think they're more like file paths? `provider_name/model_name` seems good for `path`?
		// that would make model/provider name like filenames, makes sense
		name: ModelName,
		provider_name: ProviderName,
		tags: with_default_fn(array(string), () => []),

		// TODO expand/improve these
		// fetched from provider APIs:
		architecture: optional(string),
		parameter_count: optional(number),
		context_window: optional(number),
		output_token_limit: optional(number),
		embedding_length: optional(number),
		/** Size in gigabytes. */
		filesize: optional(number),
		cost_input: optional(number),
		cost_output: optional(number),
		training_cutoff: optional(string)
	},
	'Model'
);
export type ModelJson = Infer<typeof ModelJson>;
export type ModelJsonInput = InferInput<typeof ModelJson>;

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
		this.app.providers.find_by_name(this.provider_name)
	);

	readonly context_window_formatted: string | null = $derived(
		this.context_window ? (this.context_window / 1000).toFixed(0) + 'k' : null
	);

	constructor(options: ModelOptions) {
		super(ModelJson, options);
		this.init();
	}
}
