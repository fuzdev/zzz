import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.ts';
import {Provider, ProviderJson} from './provider.svelte.ts';
import {CellJson} from './cell_types.ts';
import type {ProviderName} from './provider_types.ts';

export const ProvidersJson = CellJson.extend({
	items: z.array(ProviderJson).default(() => []),
}).meta({cell_class_name: 'Providers'});
export type ProvidersJson = z.infer<typeof ProvidersJson>;
export type ProvidersJsonInput = z.input<typeof ProvidersJson>;

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
