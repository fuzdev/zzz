import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {RepoJson, type RepoCheckout} from '$routes/projects/projects_schema.js';

export type RepoOptions = CellOptions<typeof RepoJson>;

export class Repo extends Cell<typeof RepoJson> {
	git_url: string = $state.raw()!;
	checkouts: Array<RepoCheckout> = $state.raw()!;

	constructor(options: RepoOptions) {
		super(RepoJson, options);
		this.init();
	}
}
