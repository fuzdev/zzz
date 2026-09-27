// @slop Claude Opus 4

import { z } from 'zod';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';

import { Cell, type CellOptions } from '$lib/cell.svelte.ts';
import { IndexedCollection } from '$lib/indexed_collection.svelte.ts';
import {
	create_single_index,
	create_derived_index
} from '$lib/indexed_collection_helpers.svelte.ts';
import { CellJson } from '$lib/cell_types.ts';
import { BrowserTab, BrowserTabJson } from './browser_tab.svelte.ts';
import { create_collection_decoder, HANDLED } from '$lib/cell_helpers.ts';
import { to_reordered_list } from '$lib/list_helpers.ts';
import { fake_sites } from './sample_tabs.ts';

export const BrowserTabsJson = CellJson.extend({
	tabs: z.array(BrowserTabJson).default(() => []),
	recently_closed_tabs: z.array(BrowserTabJson).default(() => [])
}).meta({ cell_class_name: 'BrowserTabs' });
export type BrowserTabsJsonInput = z.input<typeof BrowserTabsJson>;

export type BrowserTabsOptions = CellOptions<typeof BrowserTabsJson>;

/** How many closed tabs `BrowserTabs` keeps for reopening — the oldest are forgotten first. */
export const BROWSER_TABS_CLOSED_MAX = 50;

export class BrowserTabs extends Cell<typeof BrowserTabsJson> {
	items: IndexedCollection<BrowserTab> = new IndexedCollection({
		dispose_item: (tab) => tab.dispose(),
		indexes: [
			create_single_index({
				key: 'url',
				extractor: (tab) => tab.url
			}),
			create_derived_index({
				key: 'manual_order',
				compute: (collection) => collection.values
			})
		]
	});

	/** Ordered array of tabs derived from the `manual_order` index. */
	readonly ordered_tabs: Array<BrowserTab> = $derived(this.items.derived_index('manual_order'));

	/**
	 * Snapshots of closed tabs for reopening, oldest first, at most
	 * `BROWSER_TABS_CLOSED_MAX`. Kept as JSON, not cells: a closed tab's cell
	 * is disposed, so a reopen creates a fresh one.
	 */
	recently_closed_tabs: Array<BrowserTabJson> = $state.raw([]);

	readonly selected_tab: BrowserTab | undefined = $derived(
		this.ordered_tabs.find((t) => t.selected)
	);

	readonly selected_url: string = $derived(this.selected_tab?.url || '');

	constructor(options: BrowserTabsOptions) {
		super(BrowserTabsJson, options);

		this.decoders = {
			tabs: create_collection_decoder(
				() => this.items.clear(),
				(json) => this.items.add(new BrowserTab({ app: this.app, json }))
			),
			recently_closed_tabs: (tabs) => {
				if (Array.isArray(tabs)) {
					this.recently_closed_tabs = tabs
						.map((tab_json) => BrowserTabJson.parse(tab_json))
						.slice(-BROWSER_TABS_CLOSED_MAX);
				}
				return HANDLED;
			}
		};

		this.init();
	}

	add(tab_data: BrowserTabJson): void {
		// Add new tab to collection
		const tab = new BrowserTab({
			app: this.app,
			json: tab_data
		});
		this.items.add(tab);
	}

	add_new_tab(): void {
		// Deselect all existing tabs
		for (const tab of this.items.by_id.values()) {
			tab.selected = false;
		}

		// Create new tab with embedded content
		const created = get_datetime_now();
		this.add({
			id: create_uuid(),
			title: 'new tab',
			selected: true,
			url: '/newtab',
			type: 'embedded_html',
			content: fake_sites.new_tab.content,
			refresh_counter: 0,
			created,
			updated: created
		});
	}

	close(index: number): void {
		const tabs = this.ordered_tabs;
		if (index >= 0 && index < tabs.length) {
			const tab_to_close = tabs[index];
			if (!tab_to_close) return;

			const was_selected = tab_to_close.selected;

			// snapshot the tab before removing it, since removing disposes it
			this.recently_closed_tabs = [
				...this.recently_closed_tabs.slice(1 - BROWSER_TABS_CLOSED_MAX),
				tab_to_close.to_json()
			];

			this.items.remove(tab_to_close.id);

			// If we closed the selected tab and there are other tabs, select the nearest one to the right
			if (was_selected && this.ordered_tabs.length > 0) {
				// Try to select the tab to the right (next index), or the last tab if there's nothing to the right
				const new_index = Math.min(this.ordered_tabs.length - 1, index);
				// Select the tab at the new index
				const tab_to_select = this.ordered_tabs[new_index];
				if (tab_to_select) {
					tab_to_select.selected = true;
				}
			}
		}
	}

	/**
	 * Reopens the most recently closed tab as a new cell from its snapshot,
	 * selected if it was selected when closed.
	 */
	reopen_last_closed_tab(): void {
		const tab_to_reopen = this.recently_closed_tabs.at(-1);
		if (!tab_to_reopen) return;
		this.recently_closed_tabs = this.recently_closed_tabs.slice(0, -1);
		// If the tab was previously selected, deselect all current tabs
		if (tab_to_reopen.selected) {
			for (const tab of this.items.by_id.values()) {
				tab.selected = false;
			}
		}
		this.add(tab_to_reopen);
	}

	select(index: number): void {
		const tabs = this.ordered_tabs;
		if (index >= 0 && index < tabs.length) {
			for (let i = 0; i < tabs.length; i++) {
				const tab = tabs[i];
				if (tab) {
					tab.selected = i === index;
				}
			}
		}
	}

	update_url(url: string): void {
		const selected_tab = this.selected_tab;
		if (selected_tab) {
			selected_tab.url = url;

			// If navigating to a real URL from a new tab, change type to external_url
			if (selected_tab.type === 'embedded_html' && url !== '~newtab' && url !== '/newtab') {
				selected_tab.type = 'external_url';
				selected_tab.content = undefined; // Clear embedded content
			}

			// If it's an external URL tab, force a refresh
			if (selected_tab.type === 'external_url') {
				selected_tab.refresh();
			}
		}
	}

	refresh_selected(): void {
		const selected_tab = this.selected_tab;
		if (selected_tab) {
			selected_tab.refresh();
		}
	}

	reorder_tabs(from_index: number, to_index: number): void {
		this.items.indexes.manual_order = to_reordered_list(this.ordered_tabs, from_index, to_index);
	}
}

export const BrowserTabsSchema = z.instanceof(BrowserTabs);
