import { nullable, string, type Infer, type InferInput } from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';

import type { Model } from './model.svelte.ts';
import { ProviderName, type ProviderStatus } from './provider_types.ts';
import { cell_json_schema } from './cell_types.ts';

// TODO optional/defaults?
export const ProviderJson = cell_json_schema(
	{
		name: ProviderName,
		title: string,
		// TODO maybe change this to `docs_url` and add `url` for the homepage? and/or some other homepage url property?
		url: string,
		homepage: string, // TODO name? see `url` too
		company: string,
		api_key_url: nullable(string)
	},
	'Provider'
);
export type ProviderJson = Infer<typeof ProviderJson>;
export type ProviderJsonInput = InferInput<typeof ProviderJson>;

export interface ProviderOptions extends CellOptions<typeof ProviderJson> {}

export class Provider extends Cell<typeof ProviderJson> {
	name: ProviderName = $state.raw()!;
	title: string = $state.raw()!;
	url: string = $state.raw()!; // TODO @many should these be optional? or just default to `''`? need init patterns
	homepage: string = $state.raw()!; // TODO @many should these be optional? or just default to `''`? need init patterns
	company: string = $state.raw()!;
	api_key_url: string | null = $state.raw()!;

	readonly models: ReadonlyArray<Model> = $derived(
		this.app.models.items.where('provider_name', this.name)
	);

	/**
	 * Status for this provider (availability, error messages, etc.).
	 */
	readonly status: ProviderStatus | null = $derived(this.app.lookup_provider_status(this.name));

	/**
	 * Whether this provider is available (configured with API keys, etc.).
	 */
	readonly available: boolean = $derived(this.status?.available ?? false);

	constructor(options: ProviderOptions) {
		super(ProviderJson, options);
		this.init();
	}
}
