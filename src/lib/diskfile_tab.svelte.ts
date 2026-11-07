import type { Infer, InferInput } from '@fuzdev/fuz_schema/schema.ts';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import type { Diskfile } from './diskfile.svelte.ts';
import type { DiskfileTabs } from './diskfile_tabs.svelte.ts';

export const DiskfileTabJson = cell_json_schema(
	{
		diskfile_id: Uuid
	},
	'DiskfileTab'
);
export type DiskfileTabJson = Infer<typeof DiskfileTabJson>;
export type DiskfileTabJsonInput = InferInput<typeof DiskfileTabJson>;

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
		this.app.diskfiles.items.by_id.get(this.diskfile_id)
	);

	constructor(options: DiskfileTabOptions) {
		super(DiskfileTabJson, options);
		this.tabs = options.tabs;
		this.init();
	}
}
