import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';

export const UiJson = CellJson.extend({
	show_main_dialog: z.boolean().default(false),
	show_sidebar: z.boolean().default(true),
	tutorial_for_database: z.boolean().default(true),
	tutorial_for_chats: z.boolean().default(true),
	tutorial_for_prompts: z.boolean().default(true),
	tutorial_for_diskfiles: z.boolean().default(true),
	show_desk_menu: z.boolean().default(false),
	desk_pinned: z.boolean().default(false),
}).meta({cell_class_name: 'Ui'});
export type UiJson = z.infer<typeof UiJson>;
export type UiJsonInput = z.input<typeof UiJson>;

export interface UiOptions extends CellOptions<typeof UiJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type
export class Ui extends Cell<typeof UiJson> {
	show_main_dialog: boolean = $state()!;
	show_sidebar: boolean = $state()!;
	tutorial_for_database: boolean = $state()!;
	tutorial_for_chats: boolean = $state()!;
	tutorial_for_prompts: boolean = $state()!;
	tutorial_for_diskfiles: boolean = $state()!;
	show_desk_menu: boolean = $state()!;
	desk_pinned: boolean = $state()!;

	// TODO revisit this API, maybe with an associated attachment?
	/** Consumed by components like `ContentEditor` for focusing elements. */
	pending_element_to_focus_key: string | number | null = $state(null);

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
