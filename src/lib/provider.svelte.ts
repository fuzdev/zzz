import {z} from 'zod';
import {Cell, type CellOptions} from './cell.svelte.js';

import type {Model} from './model.svelte.js';
import {ProviderName, type ProviderStatus} from './provider_types.js';
import {CellJson} from './cell_types.js';

// TODO optional/defaults?
export const ProviderJson = CellJson.extend({
	name: ProviderName,
	title: z.string(),
	// TODO maybe change this to `docs_url` and add `url` for the homepage? and/or some other homepage url property?
	url: z.string(),
	homepage: z.string(), // TODO name? see `url` too
	company: z.string(),
	api_key_url: z.string().nullable(),
}).meta({cell_class_name: 'Provider'});
export type ProviderJson = z.infer<typeof ProviderJson>;
export type ProviderJsonInput = z.input<typeof ProviderJson>;

export interface ProviderOptions extends CellOptions<typeof ProviderJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Provider extends Cell<typeof ProviderJson> {
	name: ProviderName = $state.raw()!;
	title: string = $state.raw()!;
	url: string = $state.raw()!; // TODO @many should these be optional? or just default to `''`? need init patterns
	homepage: string = $state.raw()!; // TODO @many should these be optional? or just default to `''`? need init patterns
	company: string = $state.raw()!;
	api_key_url: string | null = $state.raw()!;

	readonly models: Array<Model> = $derived(this.app.models.items.where('provider_name', this.name));

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
