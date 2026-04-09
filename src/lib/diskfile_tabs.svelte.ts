// @slop Claude Sonnet 3.7

import {z} from 'zod';
import {SvelteMap} from 'svelte/reactivity';

import {Cell, type CellOptions} from './cell.svelte.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_uuid, Uuid} from './zod_helpers.js';
import {to_reordered_list} from './list_helpers.js';
import {DiskfileTab} from './diskfile_tab.svelte.js';
import {CellJson} from './cell_types.js';
import {create_map_by_property} from './iterable_helpers.js';

export const DiskfileTabsJson = CellJson.extend({
	selected_tab_id: Uuid.nullable().default(null),
	preview_tab_id: Uuid.nullable().default(null),
	tab_order: z.array(Uuid).default(() => []),
	/** Tracks recently accessed tabs for better tab selection when closing tabs. */
	recent_tab_ids: z.array(Uuid).default(() => []),
	/** Maximum number of tabs to track in access history. */
	max_tab_history: z.number().default(20),
}).meta({cell_class_name: 'DiskfileTabs'});
export type DiskfileTabsJson = z.infer<typeof DiskfileTabsJson>;
export type DiskfileTabsJsonInput = z.input<typeof DiskfileTabsJson>;

export type DiskfileTabsOptions = CellOptions<typeof DiskfileTabsJson>;

/**
 * Manages tabs for diskfiles in the editor with preview behavior.
 */
export class DiskfileTabs extends Cell<typeof DiskfileTabsJson> {
	selected_tab_id: Uuid | null = $state()!;
	preview_tab_id: Uuid | null = $state()!;
	tab_order: Array<Uuid> = $state()!;
	recent_tab_ids: Array<Uuid> = $state.raw()!;
	max_tab_history: number = $state()!;

	items: IndexedCollection<DiskfileTab> = new IndexedCollection();

	/**
	 * Map for looking up tabs by their associated diskfile_id.
	 */
	readonly by_diskfile_id: Map<Uuid, DiskfileTab> = $derived(
		create_map_by_property(this.items.by_id.values(), 'diskfile_id'),
	);

	/**
	 * Ordered array of tabs derived directly from tab_order.
	 * Includes tabs in the explicit order plus any tabs not yet in the order.
	 */
	readonly ordered_tabs: Array<DiskfileTab> = $derived.by(() => {
		const {by_id} = this.items;
		const result: Array<DiskfileTab> = [];
		// Track which tabs have been added to avoid duplicates
		const added_tab_ids: Set<string> = new Set();

		// First pass: add tabs in the explicit order from tab_order
		for (const tab_id of this.tab_order) {
			const tab = by_id.get(tab_id);
			if (tab) {
				result.push(tab);
				added_tab_ids.add(tab_id);
			}
		}

		// Second pass: add any tabs not yet included
		for (const tab of by_id.values()) {
			if (!added_tab_ids.has(tab.id)) {
				result.push(tab);
			}
		}

		return result;
	});

	/** The currently selected tab. */
	readonly selected_tab: DiskfileTab | undefined = $derived(
		this.selected_tab_id ? this.items.by_id.get(this.selected_tab_id) : undefined,
	);

	/** The selected tab's diskfile id. */
	readonly selected_diskfile_id: Uuid | null = $derived(this.selected_tab?.diskfile_id ?? null);

	/** The preview tab, if any. */
	readonly preview_tab: DiskfileTab | undefined = $derived(
		this.preview_tab_id ? this.items.by_id.get(this.preview_tab_id) : undefined,
	);

	readonly recent_tabs: Array<DiskfileTab> = $derived.by(() => {
		const result: Array<DiskfileTab> = [];
		for (const tab_id of this.recent_tab_ids) {
			const tab = this.items.by_id.get(tab_id);
			if (tab) result.push(tab); // for now just ignore missing tabs
		}
		return result;
	});

	/** Recently closed tabs for potential reopening. */
	recently_closed_tabs: Array<DiskfileTab> = $state([]);

	/** Map of closed tab ids to their diskfile ids - used for browser navigation. */
	readonly closed_tab_diskfiles: SvelteMap<Uuid, Uuid> = new SvelteMap();

	constructor(options: DiskfileTabsOptions) {
		super(DiskfileTabsJson, options);
		this.init();
	}

	/**
	 * Updates the tab access history when a tab is selected.
	 * Moves the selected tab to the front of the history.
	 */
	#update_tab_history(tab_id: Uuid): void {
		const tab = this.items.by_id.get(tab_id);
		if (!tab) return;

		// Remove the tab from its current position in history if it exists
		const updated_history = this.recent_tab_ids.filter((id) => id !== tab_id);

		// Add the tab to the front of the history
		updated_history.unshift(tab.id);

		// Trim the history to the maximum length
		if (updated_history.length > this.max_tab_history) {
			updated_history.length = this.max_tab_history;
		}

		this.recent_tab_ids = updated_history;
	}

	/**
	 * Returns the most recently accessed tab id that still exists,
	 * excluding the specified tab id.
	 */
	find_most_recent_tab(exclude_id: Uuid): Uuid | null {
		for (const recent_tab of this.recent_tabs) {
			if (recent_tab.id !== exclude_id && this.items.by_id.has(recent_tab.id)) {
				return recent_tab.id;
			}
		}
		return null;
	}

	/**
	 * Sets the selected tab.
	 */
	select_tab(tab_id: Uuid): void {
		console.log('DiskfileTabs.select_tab', {tab_id});
		this.selected_tab_id = tab_id;
		this.#update_tab_history(tab_id);
	}

	/**
	 * Positions a tab after another tab in the order.
	 * If no reference tab is provided, or it's not found, appends to the end.
	 */
	#position_tab(tab_id: Uuid, after_tab_id?: Uuid | null): void {
		// Find the current position of the tab
		const current_index = this.tab_order.indexOf(tab_id);

		// Remove tab from its current position if it exists
		if (current_index !== -1) {
			this.tab_order.splice(current_index, 1);
		}

		// If after_tab_id is provided and exists, insert after it
		if (after_tab_id != null) {
			const target_index = this.tab_order.indexOf(after_tab_id);
			if (target_index !== -1) {
				this.tab_order.splice(target_index + 1, 0, tab_id);
				return;
			}
		}

		// If after_tab_id is null or not found, append to end
		this.tab_order.push(tab_id);
	}

	/**
	 * Creates a new tab with the given diskfile id.
	 * If insert_after is provided, the new tab will be positioned after that tab in the order.
	 */
	#create_tab(diskfile_id: Uuid, insert_after?: Uuid | null): DiskfileTab {
		const new_tab = new DiskfileTab({
			app: this.app,
			tabs: this,
			json: {
				id: create_uuid(),
				diskfile_id,
			},
		});

		this.items.add(new_tab);
		this.#position_tab(new_tab.id, insert_after);

		return new_tab;
	}

	/**
	 * Finds a tab for the given diskfile or creates a new one.
	 * If create_mode is "preview", the tab will be a preview tab.
	 * If create_mode is "permanent", any preview tab will be repurposed.
	 * Returns the tab and whether it was newly created.
	 */
	#get_or_create_tab(
		diskfile_id: Uuid,
		create_mode: 'preview' | 'permanent',
	): {tab: DiskfileTab; is_new: boolean} {
		// Check if the file is already open in a tab - use direct map lookup for reliability
		const existing_tab = this.by_diskfile_id.get(diskfile_id);
		if (existing_tab) {
			// If opening as permanent and the tab is currently a preview, convert it
			if (create_mode === 'permanent' && existing_tab.id === this.preview_tab_id) {
				this.preview_tab_id = null;
			}
			return {tab: existing_tab, is_new: false};
		}

		// Check if we have a preview tab that could be repurposed
		if (this.preview_tab) {
			const current_preview = this.preview_tab;

			// For preview mode, reuse the preview tab
			// For permanent mode, convert the preview tab to permanent
			if (create_mode === 'permanent') {
				this.preview_tab_id = null;
			}

			// Update the tab content
			current_preview.diskfile_id = diskfile_id;

			return {tab: current_preview, is_new: false};
		}

		// Create a new tab positioned after the selected tab
		const new_tab = this.#create_tab(diskfile_id, this.selected_tab_id);

		// Set preview status based on mode
		if (create_mode === 'preview') {
			this.preview_tab_id = new_tab.id;
		}

		return {tab: new_tab, is_new: true};
	}

	/**
	 * Handles preview state when opening a file.
	 * If a preview tab for this file already exists, it just selects it.
	 */
	preview_diskfile(diskfile_id: Uuid): DiskfileTab {
		console.log('DiskfileTabs.preview_diskfile', {diskfile_id});

		const previously_selected_id = this.selected_tab_id;
		const previous_preview_diskfile_id = this.preview_tab?.diskfile_id;
		const {tab, is_new} = this.#get_or_create_tab(diskfile_id, 'preview');

		// Select the tab
		this.selected_tab_id = tab.id;
		this.#update_tab_history(tab.id);

		// Only reposition if we're reusing a preview tab for a DIFFERENT file
		if (
			!is_new &&
			tab.id === this.preview_tab_id &&
			previous_preview_diskfile_id !== diskfile_id &&
			previously_selected_id &&
			previously_selected_id !== tab.id
		) {
			this.#position_tab(tab.id, previously_selected_id);
		}

		return tab;
	}

	/**
	 * Opens a diskfile as a permanent tab (not preview).
	 * If the file is already in a preview tab, promotes it to permanent.
	 */
	open_diskfile(diskfile_id: Uuid): DiskfileTab {
		console.log('DiskfileTabs.open_diskfile', {diskfile_id});

		const {tab} = this.#get_or_create_tab(diskfile_id, 'permanent');

		// Select the tab
		this.selected_tab_id = tab.id;
		this.#update_tab_history(tab.id);

		return tab;
	}

	/**
	 * Promotes the current preview tab to a permanent tab.
	 * @returns true if a tab was promoted, false otherwise
	 */
	promote_preview_to_permanent(): boolean {
		console.log('DiskfileTabs.promote_preview_to_permanent');
		if (this.preview_tab_id) {
			this.preview_tab_id = null;
			return true;
		}
		return false;
	}

	/**
	 * Closes a tab by id.
	 */
	close_tab(tab_id: Uuid): void {
		console.log('DiskfileTabs.close_tab', {tab_id});
		const tab_to_close = this.items.by_id.get(tab_id);
		if (!tab_to_close) return;

		// Remember the diskfile id for this tab in case we navigate back to it
		this.closed_tab_diskfiles.set(tab_id, tab_to_close.diskfile_id);

		const was_selected = tab_id === this.selected_tab_id;
		const was_preview = tab_id === this.preview_tab_id;

		// Find a new tab to select if needed
		if (was_selected) {
			// First try to select the most recently used tab
			const recent_tab_id = this.find_most_recent_tab(tab_id);
			if (recent_tab_id) {
				this.selected_tab_id = recent_tab_id;
			} else {
				// Fall back to simple next/previous logic if no history
				const tab_index = this.tab_order.indexOf(tab_id);

				// Try to select the next tab first
				if (tab_index !== -1 && tab_index < this.tab_order.length - 1) {
					this.selected_tab_id = this.tab_order[tab_index + 1]!; // bounds check guarantees
				}
				// If no next tab, try to select the previous tab
				else if (tab_index > 0) {
					this.selected_tab_id = this.tab_order[tab_index - 1]!; // bounds check guarantees
				}
				// If no tabs left, set to null
				else {
					this.selected_tab_id = null;
				}
			}
		}

		// Store a copy for reopening later
		this.recently_closed_tabs.push(tab_to_close);

		// Remove tab from collections and state
		this.tab_order = this.tab_order.filter((id) => id !== tab_id);
		this.items.remove(tab_id);

		// Remove from access history
		this.recent_tab_ids = this.recent_tab_ids.filter((id) => id !== tab_id);

		// Update state flags
		if (was_preview) {
			this.preview_tab_id = null;
		}
	}

	/**
	 * Navigates to a tab by id. If the tab doesn't exist but was previously closed,
	 * creates a preview tab for that diskfile.
	 *
	 * @param tab_id - the tab id to navigate to
	 * @returns object containing the resulting tab id and a boolean indicating if a new tab was created
	 */
	navigate_to_tab(tab_id: Uuid): {resulting_tab_id: Uuid | null; created_preview: boolean} {
		console.log('DiskfileTabs.navigate_to_tab', {tab_id});

		// If the tab still exists, just select it
		if (this.items.by_id.has(tab_id)) {
			this.select_tab(tab_id);
			return {resulting_tab_id: tab_id, created_preview: false};
		}

		// If the tab was closed but we know what diskfile it pointed to, create a preview
		const diskfile_id = this.closed_tab_diskfiles.get(tab_id);
		if (diskfile_id) {
			// Create a new preview tab for this diskfile
			const preview_tab = this.preview_diskfile(diskfile_id);
			return {resulting_tab_id: preview_tab.id, created_preview: true};
		}

		// Tab doesn't exist and we don't know what diskfile it was for
		return {resulting_tab_id: null, created_preview: false};
	}

	/**
	 * Opens (makes permanent) a tab by id.
	 */
	open_tab(tab_id: Uuid): void {
		console.log('DiskfileTabs.open_tab', {tab_id});
		if (tab_id === this.preview_tab_id) {
			this.preview_tab_id = null;
		}
	}

	/**
	 * Reorders tabs by dragging.
	 */
	reorder_tabs(from_index: number, to_index: number): void {
		console.log('DiskfileTabs.reorder_tabs', {from_index, to_index});
		this.tab_order = to_reordered_list(this.tab_order, from_index, to_index);
	}

	/**
	 * Reopens the last closed tab.
	 */
	reopen_last_closed_tab(): void {
		console.log('DiskfileTabs.reopen_last_closed_tab');
		if (this.recently_closed_tabs.length > 0) {
			const tab_to_reopen = this.recently_closed_tabs.pop();
			if (tab_to_reopen) {
				// Recreate the tab with the same properties
				const new_tab = this.#create_tab(tab_to_reopen.diskfile_id);

				// Always select the reopened tab
				this.selected_tab_id = new_tab.id;
				this.#update_tab_history(new_tab.id);
			}
		}
	}

	/**
	 * Closes all tabs.
	 */
	close_all_tabs(): void {
		console.log('DiskfileTabs.close_all_tabs');

		// Remember diskfile ids for all tabs before clearing
		for (const tab of this.ordered_tabs) {
			this.closed_tab_diskfiles.set(tab.id, tab.diskfile_id);
		}

		// Store all tabs for potential reopening
		this.recently_closed_tabs = [...this.ordered_tabs];

		// Clear all state
		this.selected_tab_id = null;
		this.preview_tab_id = null;
		this.tab_order = [];
		this.recent_tab_ids = [];

		// Clear all tabs
		this.items.clear();
	}
}

export const DiskfileTabsSchema = z.instanceof(DiskfileTabs);
