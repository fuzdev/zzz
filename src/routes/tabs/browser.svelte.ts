// @slop Claude Opus 4

import {z} from 'zod';

import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {CellJson} from '$lib/cell_types.js';
import {BrowserTabs} from '$routes/tabs/browser_tabs.svelte.js';
import {BrowserTabJson} from '$routes/tabs/browser_tab.svelte.js';
import {HANDLED} from '$lib/cell_helpers.js';

export const BrowserJson = CellJson.extend({
	tabs: z.array(BrowserTabJson).default(() => []),
	edited_url: z.string().default(''),
	browserified: z.boolean().default(false),
}).meta({cell_class_name: 'Browser'});
export type BrowserJson = z.infer<typeof BrowserJson>;
export type BrowserJsonInput = z.input<typeof BrowserJson>;

export type BrowserOptions = CellOptions<typeof BrowserJson>;

export class Browser extends Cell<typeof BrowserJson> {
	tabs: BrowserTabs = new BrowserTabs({app: this.app});
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
			},
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

	submit_edited_url(): void {
		this.navigate_to(this.edited_url);
	}

	reorder_tab(from_index: number, to_index: number): void {
		this.tabs.reorder_tabs(from_index, to_index);
	}
}

export const BrowserSchema = z.instanceof(Browser);
