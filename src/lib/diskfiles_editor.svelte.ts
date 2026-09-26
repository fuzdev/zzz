// @slop Claude Sonnet 3.7

import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { DiskfileTabs } from './diskfile_tabs.svelte.ts';
import type { DiskfileTab } from './diskfile_tab.svelte.ts';
import { CellJson } from './cell_types.ts';

/**
 * A tab close waiting on the user — see `DiskfilesEditor.request_close_tab`.
 * Whoever acts on it (e.g. saving first) holds the request and checks
 * `cancelled` before closing, since saving the draft lapses the request.
 */
export interface DiskfileTabCloseRequest {
	readonly tab_id: Uuid;
	readonly draft_id: Uuid;
	/** Set by `cancel_close_tab` — the user chose to keep the tab. */
	cancelled: boolean;
}

export const DiskfilesEditorJson = CellJson.extend({
	show_sort_controls: z.boolean().default(false)
}).meta({ cell_class_name: 'DiskfilesEditor' });
export type DiskfilesEditorJson = z.infer<typeof DiskfilesEditorJson>;
export type DiskfilesEditorJsonInput = z.input<typeof DiskfilesEditorJson>;

export type DiskfilesEditorOptions = CellOptions<typeof DiskfilesEditorJson>;

/**
 * Editor state management for diskfiles.
 */
export class DiskfilesEditor extends Cell<typeof DiskfilesEditorJson> {
	/** Controls visibility of sort controls in the file explorer. */
	show_sort_controls: boolean = $state.raw(false);

	/** Tabs for managing the open diskfiles. */
	readonly tabs: DiskfileTabs = new DiskfileTabs({ app: this.app });

	/** The latest tab close asked about — see `pending_close_request`. */
	#pending_close: DiskfileTabCloseRequest | null = $state.raw(null);

	/**
	 * A tab close waiting on the user's choice — save, don't save, or cancel —
	 * because it's the last tab of a file with a draft (see `request_close_tab`).
	 * Lapses on its own once that tab closes or that draft is gone (saved,
	 * discarded, …), so a later draft never revives it; a lapsed request is
	 * dropped by the next close or request.
	 */
	readonly pending_close_request: DiskfileTabCloseRequest | null = $derived.by(() => {
		const request = this.#pending_close;
		if (!request) return null;
		const tab = this.tabs.items.by_id.get(request.tab_id);
		if (!tab) return null;
		const draft = this.app.diskfiles.find_editor_state(tab.diskfile_id)?.history.draft_entry;
		return draft?.id === request.draft_id ? request : null;
	});

	/** The tab `pending_close_request` asks about. */
	readonly pending_close_tab: DiskfileTab | undefined = $derived(
		this.pending_close_request
			? this.tabs.items.by_id.get(this.pending_close_request.tab_id)
			: undefined
	);

	/** The id of `pending_close_tab`. */
	readonly pending_close_tab_id: Uuid | null = $derived(this.pending_close_tab?.id ?? null);

	constructor(options: DiskfilesEditorOptions) {
		super(DiskfilesEditorJson, options);
		this.init();
	}

	/**
	 * Opens a diskfile in preview mode.
	 */
	preview_diskfile(diskfile_id: Uuid): void {
		console.log('DiskfilesEditor.preview_diskfile', { diskfile_id });
		this.tabs.preview_diskfile(diskfile_id);
	}

	/**
	 * Opens a diskfile in permanent mode.
	 */
	open_diskfile(diskfile_id: Uuid): void {
		console.log('DiskfilesEditor.open_diskfile', { diskfile_id });
		this.tabs.open_diskfile(diskfile_id);
	}

	/**
	 * Reorders tabs.
	 */
	reorder_tabs(from_index: number, to_index: number): void {
		console.log('DiskfilesEditor.reorder_tabs', { from_index, to_index });
		this.tabs.reorder_tabs(from_index, to_index);
	}

	/**
	 * Selects a tab by id.
	 */
	select_tab(tab_id: Uuid): void {
		console.log('DiskfilesEditor.select_tab', { tab_id });
		this.tabs.select_tab(tab_id);
	}

	/**
	 * Closes a tab by id, now — see `request_close_tab` for the user-facing
	 * close. If its file was the selected one, selection follows the newly
	 * selected tab. A draft isn't lost either way: it's app-level, and the file
	 * reopens on it.
	 */
	close_tab(tab_id: Uuid): void {
		console.log('DiskfilesEditor.close_tab', { tab_id });
		const tab = this.tabs.items.by_id.get(tab_id);
		if (!tab) return;
		const { diskfiles } = this.app;
		const was_selected_file = diskfiles.selected_file_id === tab.diskfile_id;
		if (this.#pending_close?.tab_id === tab_id || !this.pending_close_request) {
			this.#pending_close = null;
		}
		this.tabs.close_tab(tab_id);
		if (was_selected_file && diskfiles.selected_file_id === tab.diskfile_id) {
			diskfiles.selected_file_id = this.tabs.selected_diskfile_id;
		}
	}

	/**
	 * Closes a tab as the user asked, like VS Code: the last tab of a file with a
	 * draft isn't closed yet — it becomes `pending_close_tab_id`, for the user
	 * to save, not save (`DiskfileEditorState.discard_draft`), or cancel.
	 *
	 * @returns whether the tab closed now
	 */
	request_close_tab(tab_id: Uuid): boolean {
		const tab = this.tabs.items.by_id.get(tab_id);
		if (!tab) return false;
		const last_tab = this.tabs.ordered_tabs.every(
			(t) => t.id === tab_id || t.diskfile_id !== tab.diskfile_id
		);
		const draft = this.app.diskfiles.find_editor_state(tab.diskfile_id)?.history.draft_entry;
		if (last_tab && draft) {
			this.#pending_close = { tab_id, draft_id: draft.id, cancelled: false };
			return false;
		}
		this.close_tab(tab_id);
		return true;
	}

	/** Cancels a pending tab close, marking its request `cancelled` — see `request_close_tab`. */
	cancel_close_tab(): void {
		if (this.#pending_close) this.#pending_close.cancelled = true;
		this.#pending_close = null;
	}

	/**
	 * Reopens the last closed tab.
	 */
	reopen_last_closed_tab(): void {
		console.log('DiskfilesEditor.reopen_last_closed_tab');
		this.tabs.reopen_last_closed_tab();
	}

	/**
	 * Promotes the current preview tab to permanent.
	 */
	promote_preview_tab(): void {
		console.log('DiskfilesEditor.promote_preview_tab');
		this.tabs.promote_preview_to_permanent();
	}

	/**
	 * Opens a tab by id — see `DiskfileTabs.open_tab`.
	 */
	open_tab(tab_id: Uuid): void {
		console.log('DiskfilesEditor.open_tab', { tab_id });
		this.tabs.open_tab(tab_id);
	}

	/**
	 * Forgets a diskfile that no longer exists — see `DiskfileTabs.remove_diskfile`.
	 */
	remove_diskfile(diskfile_id: Uuid): void {
		this.tabs.remove_diskfile(diskfile_id);
	}

	/**
	 * Handles when a diskfile's content is modified.
	 */
	handle_file_modified(diskfile_id: Uuid): void {
		console.log('DiskfilesEditor.handle_file_modified', { diskfile_id });
		// If the modified file is in a preview tab, promote it to permanent
		const tab = this.tabs.by_diskfile_id.get(diskfile_id);
		if (tab?.id === this.tabs.preview_tab_id) {
			this.tabs.preview_tab_id = null; // Convert to permanent by removing preview status
		}
	}

	/**
	 * Syncs the selected diskfile in diskfiles with the selected tab.
	 */
	sync_selected_file(): void {
		console.log('DiskfilesEditor.sync_selected_file');
		const selected_diskfile_id = this.tabs.selected_diskfile_id;
		if (selected_diskfile_id) {
			this.app.diskfiles.selected_file_id = selected_diskfile_id;
		}
	}

	/**
	 * Toggles the visibility of sort controls in the file explorer.
	 */
	toggle_sort_controls(value = !this.show_sort_controls): void {
		this.show_sort_controls = value;
	}
}

export const DiskfilesEditorSchema = z.instanceof(DiskfilesEditor);
