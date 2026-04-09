import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {PageJson} from '$routes/projects/projects_schema.js';

export type PageOptions = CellOptions<typeof PageJson>;

/**
 * Represents a page in a project.
 */
export class Page extends Cell<typeof PageJson> {
	path: string = $state.raw()!;
	title: string = $state.raw()!;
	content: string = $state.raw()!;

	constructor(options: PageOptions) {
		super(PageJson, options);
		this.init();
	}
}
