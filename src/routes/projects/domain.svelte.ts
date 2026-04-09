import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {DomainJson} from '$routes/projects/projects_schema.js';

export type DomainOptions = CellOptions<typeof DomainJson>;

/**
 * Represents a domain in a project.
 */
export class Domain extends Cell<typeof DomainJson> {
	name: string = $state.raw()!;
	status: 'active' | 'pending' | 'inactive' = $state.raw()!;
	ssl: boolean = $state.raw()!;

	constructor(options: DomainOptions) {
		super(DomainJson, options);
		this.init();
	}
}
