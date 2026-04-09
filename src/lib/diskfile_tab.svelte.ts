import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {Uuid} from './zod_helpers.js';
import {CellJson} from './cell_types.js';
import type {Diskfile} from './diskfile.svelte.js';
import type {DiskfileTabs} from './diskfile_tabs.svelte.js';

export const DiskfileTabJson = CellJson.extend({
	diskfile_id: Uuid,
}).meta({cell_class_name: 'DiskfileTab'});
export type DiskfileTabJson = z.infer<typeof DiskfileTabJson>;
export type DiskfileTabJsonInput = z.input<typeof DiskfileTabJson>;

export interface DiskfileTabOptions extends CellOptions<typeof DiskfileTabJson> {
	tabs: DiskfileTabs;
}

export class DiskfileTab extends Cell<typeof DiskfileTabJson> {
	diskfile_id: Uuid = $state.raw()!;

	/**
	 * Reference to the parent tabs collection,
	 * allowing us to have collection-derived data,
	 * at the cost of requiring exactly 1 parent.
	 *
	 * This pattern is somewhat experimental -
	 * the idea is it's more declarative to have things
	 * like the "preview" or "selected" tabs be state on the collection,
	 * so it doesn't need to be separately managed as state on each tab.
	 */
	readonly tabs: DiskfileTabs;

	/** Derived from parent collection's state. */
	readonly is_preview: boolean = $derived.by(() => this.tabs.preview_tab_id === this.id);

	/** Derived from parent collection's state. */
	readonly is_selected: boolean = $derived.by(() => this.tabs.selected_tab_id === this.id);

	readonly diskfile: Diskfile | undefined = $derived(
		this.app.diskfiles.items.by_id.get(this.diskfile_id),
	);

	constructor(options: DiskfileTabOptions) {
		super(DiskfileTabJson, options);
		this.tabs = options.tabs;
		this.init();
	}
}

export const DiskfileTabSchema = z.instanceof(DiskfileTab);
