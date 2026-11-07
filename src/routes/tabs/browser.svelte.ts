// @slop Claude Opus 4

import {
	array,
	boolean,
	string,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from '#lib/cell.svelte.ts';
import { cell_json_schema } from '#lib/cell_types.ts';
import { BrowserTabs } from './browser_tabs.svelte.ts';
import { BrowserTabJson } from './browser_tab.svelte.ts';
import { HANDLED } from '#lib/cell_helpers.ts';
import { to_browser_tab_url } from './browser_helpers.ts';

export const BrowserJson = cell_json_schema(
	{
		tabs: with_default_fn(array(BrowserTabJson), () => []),
		edited_url: with_default(string, ''),
		browserified: with_default(boolean, false)
	},
	'Browser'
);
export type BrowserJson = Infer<typeof BrowserJson>;
export type BrowserJsonInput = InferInput<typeof BrowserJson>;

export type BrowserOptions = CellOptions<typeof BrowserJson>;

export class Browser extends Cell<typeof BrowserJson> {
	tabs: BrowserTabs = new BrowserTabs({ app: this.app });
	edited_url: string = $state.raw()!;
	browserified: boolean = $state.raw()!;

	/** True when the edited URL differs from the selected tab's URL. */
	readonly url_edited: boolean = $derived(this.edited_url !== this.tabs.selected_url);

	constructor(options: BrowserOptions) {
		super(BrowserJson, options);

		this.decoders = {
			tabs: (tabs) => {
				if (Array.isArray(tabs)) {
					// Add tabs to the browser tabs collection
					for (const tab_json of tabs) {
						this.tabs.add(tab_json);
					}

					// Make sure one tab is selected
					const selected_tab = this.tabs.ordered_tabs.find((tab) => tab.selected);
					if (!selected_tab && this.tabs.ordered_tabs.length > 0) {
						const first_tab = this.tabs.ordered_tabs[0];
						if (first_tab) {
							first_tab.selected = true;
						}
					}

					// Set the edited URL from the selected tab
					this.edited_url = this.tabs.selected_url;
				}
				return HANDLED;
			}
		};

		this.init();
	}

	navigate_to(url: string): void {
		// Update the selected tab's URL
		this.tabs.update_url(url);
		this.edited_url = url;
	}

	go_back(): void {
		// no-op for now
		return;
	}

	go_forward(): void {
		// no-op for now
		return;
	}

	refresh(): void {
		this.tabs.refresh_selected();
	}

	add_new_tab(): void {
		this.tabs.add_new_tab();
		this.edited_url = this.tabs.selected_url;
	}

	close_tab(index: number): void {
		this.tabs.close(index);
		this.edited_url = this.tabs.selected_url;
	}

	reopen_last_closed_tab(): void {
		this.tabs.reopen_last_closed_tab();
		this.edited_url = this.tabs.selected_url;
	}

	select_tab(index: number): void {
		this.tabs.select(index);
		this.edited_url = this.tabs.selected_url;
	}

	/**
	 * Navigates to the address bar's URL, adding `https://` when it has no scheme.
	 */
	submit_edited_url(): void {
		this.navigate_to(to_browser_tab_url(this.edited_url));
	}

	reorder_tab(from_index: number, to_index: number): void {
		this.tabs.reorder_tabs(from_index, to_index);
	}
}
