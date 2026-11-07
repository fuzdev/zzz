import { boolean, with_default, type Infer, type InferInput } from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';

export const UiJson = cell_json_schema(
	{
		show_main_dialog: with_default(boolean, false),
		show_sidebar: with_default(boolean, true),
		tutorial_for_database: with_default(boolean, true),
		tutorial_for_chats: with_default(boolean, true),
		tutorial_for_prompts: with_default(boolean, true),
		tutorial_for_diskfiles: with_default(boolean, true),
		show_desk_menu: with_default(boolean, false),
		desk_pinned: with_default(boolean, false)
	},
	'Ui'
);
export type UiJson = Infer<typeof UiJson>;
export type UiJsonInput = InferInput<typeof UiJson>;

export interface UiOptions extends CellOptions<typeof UiJson> {}
export class Ui extends Cell<typeof UiJson> {
	show_main_dialog: boolean = $state.raw()!;
	show_sidebar: boolean = $state.raw()!;
	tutorial_for_database: boolean = $state.raw()!;
	tutorial_for_chats: boolean = $state.raw()!;
	tutorial_for_prompts: boolean = $state.raw()!;
	tutorial_for_diskfiles: boolean = $state.raw()!;
	show_desk_menu: boolean = $state.raw()!;
	desk_pinned: boolean = $state.raw()!;

	// TODO revisit this API, maybe with an associated attachment?
	/** Consumed by components like `ContentEditor` for focusing elements. */
	pending_element_to_focus_key: string | number | null = $state.raw(null);

	constructor(options: UiOptions) {
		super(UiJson, options);
		this.init();
	}

	// TODO think about the main menu allowing any components to add snippets
	/**
	 * Toggle the main menu visibility.
	 */
	toggle_main_menu(value: boolean = !this.show_main_dialog): boolean {
		this.show_main_dialog = value;
		return value;
	}

	/**
	 * Toggle the sidebar visibility.
	 */
	toggle_sidebar(value: boolean = !this.show_sidebar): boolean {
		this.show_sidebar = value;
		return value;
	}

	/**
	 * Toggle the desk menu visibility.
	 */
	toggle_desk_menu(value: boolean = !this.show_desk_menu): boolean {
		this.show_desk_menu = value;
		return value;
	}

	/**
	 * Toggle the desk menu pinned state.
	 */
	toggle_desk_pinned(value: boolean = !this.desk_pinned): boolean {
		this.desk_pinned = value;
		return value;
	}
}
