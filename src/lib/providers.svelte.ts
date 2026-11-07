import { array, with_default_fn, type Infer, type InferInput } from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { Provider, ProviderJson } from './provider.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import type { ProviderName } from './provider_types.ts';

export const ProvidersJson = cell_json_schema(
	{
		items: with_default_fn(array(ProviderJson), () => [])
	},
	'Providers'
);
export type ProvidersJson = Infer<typeof ProvidersJson>;
export type ProvidersJsonInput = InferInput<typeof ProvidersJson>;

export interface ProvidersOptions extends CellOptions<typeof ProvidersJson> {}
export class Providers extends Cell<typeof ProvidersJson> {
	items: Array<Provider> = $state()!; // TODO probably make an indexed collection for convenient querying, despite small N

	readonly names: ReadonlyArray<ProviderName> = $derived(this.items.map((p) => p.name));

	constructor(options: ProvidersOptions) {
		super(ProvidersJson, options);
		this.init();
	}

	add(provider: Provider): void {
		this.items.push(provider);
	}

	find_by_name(name: string): Provider | undefined {
		return this.items.find((p) => p.name === name);
	}
}
