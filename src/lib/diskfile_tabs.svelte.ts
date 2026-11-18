// @slop Claude Sonnet 3.7

import {
	array,
	nullable,
	number,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { untrack } from 'svelte';
import { create_uuid, Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { DiskfileTab } from './diskfile_tab.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { create_map_by_property } from './iterable_helpers.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import { to_prepended_list } from './list_helpers.ts';

export const DiskfileTabsJson = cell_json_schema(
	{
		selected_tab_id: with_default(nullable(Uuid), null),
		preview_tab_id: with_default(nullable(Uuid), null),
		tab_order: with_default_fn(array(Uuid), () => []),
		/** Tracks recently accessed tabs for better tab selection when closing tabs. */
		recent_tab_ids: with_default_fn(array(Uuid), () => []),
		/** Maximum number of tabs to track in access history. */
		max_tab_history: with_default(number, 20)
	},
	'DiskfileTabs'
);
export type DiskfileTabsJson = Infer<typeof DiskfileTabsJson>;
export type DiskfileTabsJsonInput = InferInput<typeof DiskfileTabsJson>;

export type DiskfileTabsOptions = CellOptions<typeof DiskfileTabsJson>;

/**
 * How many closed tabs `DiskfileTabs` remembers for reopening
 * (`recently_closed_tabs`) — the oldest are forgotten first.
 */
export const DISKFILE_TABS_CLOSED_MAX = 50;

/** How many files each of `back_paths` and `forward_paths` remembers. */
export const DISKFILE_TABS_HISTORY_MAX = 50;

/**
 * Manages tabs for diskfiles in the editor with preview behavior. Tabs are
 * keyed by file path, and a path has at most one tab (`by_path`): opening,
 * previewing, reopening, and navigating back to a file that's open select its
 * tab.
 */
export class DiskfileTabs extends Cell<typeof DiskfileTabsJson> {
	selected_tab_id: Uuid | null = $state.raw()!;
	preview_tab_id: Uuid | null = $state.raw()!;
	tab_order: Array<Uuid> = $state()!;
	recent_tab_ids: Array<Uuid> = $state.raw()!;
	max_tab_history: number = $state.raw()!;

	items: IndexedCollection<DiskfileTab> = new IndexedCollection({
		// closed tabs kept in `recently_closed_tabs` are only read for their `path`
		dispose_item: (tab) => {
			this.app.diskfiles.release(tab.path, tab);
			tab.dispose();
		}
	});

	/** Map for looking up tabs by their file's path. */
	readonly by_path: Map<DiskfilePath, DiskfileTab> = $derived(
		create_map_by_property(this.items.by_id.values(), 'path')
	);

	/**
	 * Ordered array of tabs derived directly from tab_order.
	 * Includes tabs in the explicit order plus any tabs not yet in the order.
	 */
	readonly ordered_tabs: Array<DiskfileTab> = $derived.by(() => {
		const { by_id } = this.items;
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
		this.selected_tab_id ? this.items.by_id.get(this.selected_tab_id) : undefined
	);

	/** The selected tab's file path. */
	readonly selected_path: DiskfilePath | null = $derived(this.selected_tab?.path ?? null);

	/** The preview tab, if any. */
	readonly preview_tab: DiskfileTab | undefined = $derived(
		this.preview_tab_id ? this.items.by_id.get(this.preview_tab_id) : undefined
	);

	readonly recent_tabs: Array<DiskfileTab> = $derived.by(() => {
		const result: Array<DiskfileTab> = [];
		for (const tab_id of this.recent_tab_ids) {
			const tab = this.items.by_id.get(tab_id);
			if (tab) result.push(tab); // for now just ignore missing tabs
		}
		return result;
	});

	/** Recently closed tabs for potential reopening, oldest first, at most `DISKFILE_TABS_CLOSED_MAX`. */
	recently_closed_tabs: Array<DiskfileTab> = $state([]);

	/**
	 * Back / forward navigation, by file path, newest first: each file the
	 * selection left (`back_paths`) or went back from (`forward_paths`), at
	 * most `DISKFILE_TABS_HISTORY_MAX` each. A path whose tab closed stays —
	 * going back to it previews the file again. Kept here, not by the editor's
	 * nav component, so it survives the component remounting per file.
	 */
	back_paths: ReadonlyArray<DiskfilePath> = $state.raw([]);
	forward_paths: ReadonlyArray<DiskfilePath> = $state.raw([]);

	/** The path the history last recorded as selected. */
	#history_current: DiskfilePath | null = null;

	/** Set while `go_back` / `go_forward` select, so they don't record a new step. */
	#navigating = false;

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
		this.selected_tab_id = tab_id;
		this.#update_tab_history(tab_id);
		this.#record_selection();
	}

	/**
	 * Records a change of the selected file in the back / forward history:
	 * the file left joins `back_paths` and `forward_paths` clears, as in a
	 * browser — unless `go_back` / `go_forward` is selecting. Called after
	 * every change of the selection, by path, so a preview tab reused for
	 * another file counts as a move. A selection cleared (no tab left) records
	 * nothing: the next file selected steps away from the last one.
	 */
	#record_selection(): void {
		untrack(() => {
			const path = this.selected_tab?.path ?? null;
			if (path === null || path === this.#history_current) return;
			if (this.#history_current !== null && !this.#navigating) {
				this.back_paths = to_prepended_list(
					[...this.back_paths],
					this.#history_current,
					DISKFILE_TABS_HISTORY_MAX
				);
				this.forward_paths = [];
			}
			this.#history_current = path;
		});
	}

	/**
	 * Goes back to the file the selection last left: selects its tab, or
	 * previews it if its tab closed.
	 *
	 * @returns the path gone back to, `null` with nowhere to go
	 */
	go_back(): DiskfilePath | null {
		return this.#step('back');
	}

	/**
	 * Goes forward again after `go_back`.
	 *
	 * @returns the path gone forward to, `null` with nowhere to go
	 */
	go_forward(): DiskfilePath | null {
		return this.#step('forward');
	}

	#step(direction: 'back' | 'forward'): DiskfilePath | null {
		const from = direction === 'back' ? [...this.back_paths] : [...this.forward_paths];
		const current = this.#history_current;
		// a path that's the current one again (after removals) is skipped
		let target = from.shift();
		while (target !== undefined && target === current) target = from.shift();
		if (target === undefined) {
			// only entries equal to the current file were left: drop them
			if (direction === 'back') this.back_paths = from;
			else this.forward_paths = from;
			return null;
		}
		const to = direction === 'back' ? this.forward_paths : this.back_paths;
		const next_to =
			current === null ? [...to] : to_prepended_list([...to], current, DISKFILE_TABS_HISTORY_MAX);
		if (direction === 'back') {
			this.back_paths = from;
			this.forward_paths = next_to;
		} else {
			this.forward_paths = from;
			this.back_paths = next_to;
		}
		this.#navigating = true;
		try {
			const tab = this.by_path.get(target);
			if (tab) {
				this.select_tab(tab.id);
			} else {
				this.preview_diskfile(target);
			}
		} finally {
			this.#navigating = false;
		}
		return target;
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
	 * Creates a new tab for the file at `path`.
	 * If insert_after is provided, the new tab will be positioned after that tab in the order.
	 */
	#create_tab(path: DiskfilePath, insert_after?: Uuid | null): DiskfileTab {
		const new_tab = new DiskfileTab({
			app: this.app,
			tabs: this,
			json: {
				id: create_uuid(),
				path
			}
		});

		this.items.add(new_tab);
		// an open tab holds its file's cell (`Diskfiles.acquire`), until it closes
		this.app.diskfiles.acquire(path, new_tab);
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
		path: DiskfilePath,
		create_mode: 'preview' | 'permanent'
	): { tab: DiskfileTab; is_new: boolean } {
		// Check if the file is already open in a tab - use direct map lookup for reliability
		const existing_tab = this.by_path.get(path);
		if (existing_tab) {
			// If opening as permanent and the tab is currently a preview, convert it
			if (create_mode === 'permanent' && existing_tab.id === this.preview_tab_id) {
				this.preview_tab_id = null;
			}
			return { tab: existing_tab, is_new: false };
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
			const previous_path = current_preview.path;
			current_preview.path = path;
			const { diskfiles } = this.app;
			diskfiles.acquire(path, current_preview);
			diskfiles.release(previous_path, current_preview);
			this.#notify_if_detached(previous_path);

			return { tab: current_preview, is_new: false };
		}

		// Create a new tab positioned after the selected tab
		const new_tab = this.#create_tab(path, this.selected_tab_id);

		// Set preview status based on mode
		if (create_mode === 'preview') {
			this.preview_tab_id = new_tab.id;
		}

		return { tab: new_tab, is_new: true };
	}

	/**
	 * Handles preview state when opening a file.
	 * If a preview tab for this file already exists, it just selects it.
	 */
	preview_diskfile(path: DiskfilePath): DiskfileTab {
		const previously_selected_id = this.selected_tab_id;
		const previous_preview_path = this.preview_tab?.path;
		const { tab, is_new } = this.#get_or_create_tab(path, 'preview');

		// Select the tab
		this.selected_tab_id = tab.id;
		this.#update_tab_history(tab.id);
		this.#record_selection();

		// Only reposition if we're reusing a preview tab for a DIFFERENT file
		if (
			!is_new &&
			tab.id === this.preview_tab_id &&
			previous_preview_path !== path &&
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
	open_diskfile(path: DiskfilePath): DiskfileTab {
		const { tab } = this.#get_or_create_tab(path, 'permanent');

		// Select the tab
		this.selected_tab_id = tab.id;
		this.#update_tab_history(tab.id);
		this.#record_selection();

		return tab;
	}

	/**
	 * Promotes the current preview tab to a permanent tab.
	 * @returns true if a tab was promoted, false otherwise
	 */
	promote_preview_to_permanent(): boolean {
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
		const tab_to_close = this.items.by_id.get(tab_id);
		if (!tab_to_close) return;

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
		this.#push_recently_closed([tab_to_close]);

		// Remove tab from collections and state
		this.tab_order = this.tab_order.filter((id) => id !== tab_id);
		this.items.remove(tab_id);

		// Remove from access history
		this.recent_tab_ids = this.recent_tab_ids.filter((id) => id !== tab_id);

		// Update state flags
		if (was_preview) {
			this.preview_tab_id = null;
		}

		this.#record_selection();
		this.#notify_if_detached(tab_to_close.path);
	}

	/**
	 * Adds closed tabs to the reopen stack (`recently_closed_tabs`, the last
	 * reopened first), forgetting the oldest past `DISKFILE_TABS_CLOSED_MAX`.
	 */
	#push_recently_closed(closed: Array<DiskfileTab>): void {
		this.recently_closed_tabs.push(...closed);
		const excess = this.recently_closed_tabs.length - DISKFILE_TABS_CLOSED_MAX;
		if (excess > 0) this.recently_closed_tabs.splice(0, excess);
	}

	/**
	 * Tells `Diskfiles` when a path has no tab left, so a diskfile kept for its
	 * tab (deleted on disk, or uncovered) can be released.
	 */
	#notify_if_detached(path: DiskfilePath): void {
		if (!this.by_path.has(path)) {
			this.app.diskfiles.handle_diskfile_detached(path);
		}
	}

	/**
	 * Opens a tab by id: makes it permanent if it's the preview tab, and selects it.
	 * No-op for an unknown tab.
	 */
	open_tab(tab_id: Uuid): void {
		if (!this.items.by_id.has(tab_id)) return;
		if (tab_id === this.preview_tab_id) {
			this.preview_tab_id = null;
		}
		this.select_tab(tab_id);
	}

	/**
	 * Moves the tab of `path` in front of the tab of `before_path`, or to the
	 * end for `null` — addressed by path, not index, so the move means the same
	 * whatever else moved meanwhile.
	 *
	 * @returns whether both tabs exist and the order changed
	 */
	move_tab(path: DiskfilePath, before_path: DiskfilePath | null): boolean {
		const tab = this.by_path.get(path);
		if (!tab) return false;
		const before = before_path === null ? null : this.by_path.get(before_path);
		if (before === undefined || before === tab) return false;
		// the visible order, which `tab_order` may lag (a tab missing from it)
		const current = this.ordered_tabs.map((t) => t.id);
		const order = current.filter((id) => id !== tab.id);
		const index = before === null ? order.length : order.indexOf(before.id);
		order.splice(index, 0, tab.id);
		if (order.every((id, i) => id === current[i])) return false;
		this.tab_order = order;
		return true;
	}

	/**
	 * Reopens the most recently closed tab whose file isn't open, as a
	 * permanent tab, and selects it. Like VS Code's "reopen closed editor", a
	 * closed tab whose file is open again (in any tab) is skipped and dropped,
	 * so a reopen never duplicates a tab.
	 *
	 * @returns the reopened tab, or `null` when there's none to reopen
	 */
	reopen_last_closed_tab(): DiskfileTab | null {
		let closed_tab: DiskfileTab | undefined;
		while ((closed_tab = this.recently_closed_tabs.pop())) {
			if (this.by_path.has(closed_tab.path)) continue;
			const new_tab = this.#create_tab(closed_tab.path);
			this.select_tab(new_tab.id);
			return new_tab;
		}
		return null;
	}

	/**
	 * Removes every trace of a diskfile that's forgotten: closes its path's
	 * tab (selection moves as with `close_tab`) and drops the path from the
	 * reopen and back-navigation history, so neither can resurrect a tab
	 * pointing at it.
	 */
	remove_diskfile(path: DiskfilePath): void {
		const tab = this.by_path.get(path);
		if (tab) this.close_tab(tab.id);

		this.recently_closed_tabs = this.recently_closed_tabs.filter((tab) => tab.path !== path);
		this.back_paths = this.back_paths.filter((p) => p !== path);
		this.forward_paths = this.forward_paths.filter((p) => p !== path);
		if (this.#history_current === path) this.#history_current = null;
	}

	/**
	 * Closes all tabs. Like VS Code's "close all editors", they join the
	 * reopen stack on top of the earlier closed tabs — pushed last-to-first,
	 * so reopening them one by one restores their order.
	 */
	close_all_tabs(): void {
		const closed = this.ordered_tabs;

		// Store all tabs for potential reopening
		this.#push_recently_closed([...closed].reverse());

		// Clear all state
		this.selected_tab_id = null;
		this.preview_tab_id = null;
		this.tab_order = [];
		this.recent_tab_ids = [];

		// Clear all tabs
		const paths = new Set(this.items.values.map((tab) => tab.path));
		this.items.clear();
		for (const path of paths) {
			this.#notify_if_detached(path);
		}
	}
}
