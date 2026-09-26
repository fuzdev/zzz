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
		this.tabs.preview_diskfile(diskfile_id);
	}

	/**
	 * Opens a diskfile in permanent mode.
	 */
	open_diskfile(diskfile_id: Uuid): void {
		this.tabs.open_diskfile(diskfile_id);
	}

	/**
	 * Reorders tabs.
	 */
	reorder_tabs(from_index: number, to_index: number): void {
		this.tabs.reorder_tabs(from_index, to_index);
	}

	/**
	 * Navigates back or forward to a tab (see `DiskfileTabs.navigate_to_tab`),
	 * and selects its file.
	 *
	 * @returns the id of the tab navigated to, `null` if there's none
	 */
	navigate_to_tab(tab_id: Uuid): Uuid | null {
		const resulting_tab_id = this.tabs.navigate_to_tab(tab_id);
		if (resulting_tab_id) this.app.diskfiles.follow_selected_tab();
		return resulting_tab_id;
	}

	/**
	 * Closes a tab by id, now — see `request_close_tab` for the user-facing
	 * close. If its file was the selected one, selection follows the newly
	 * selected tab. A draft isn't lost either way: it's app-level, and the file
	 * reopens on it.
	 */
	close_tab(tab_id: Uuid): void {
		const tab = this.tabs.items.by_id.get(tab_id);
		if (!tab) return;
		const { diskfiles } = this.app;
		const was_selected_file = diskfiles.selected_file_id === tab.diskfile_id;
		if (this.#pending_close?.tab_id === tab_id || !this.pending_close_request) {
			this.#pending_close = null;
		}
		this.tabs.close_tab(tab_id);
		if (was_selected_file && diskfiles.selected_file_id === tab.diskfile_id) {
			diskfiles.follow_selected_tab();
		}
	}

	/**
	 * Closes a tab as the user asked, like VS Code: the tab of a file with a
	 * draft isn't closed yet — it becomes `pending_close_tab_id`, for the user
	 * to save, not save (`DiskfileEditorState.discard_draft`), or cancel. (A
	 * file has at most one tab — see `DiskfileTabs`.)
	 *
	 * @returns whether the tab closed now
	 */
	request_close_tab(tab_id: Uuid): boolean {
		const tab = this.tabs.items.by_id.get(tab_id);
		if (!tab) return false;
		const draft = this.app.diskfiles.find_editor_state(tab.diskfile_id)?.history.draft_entry;
		if (draft) {
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
	 * Reopens the last closed tab whose file isn't open (see
	 * `DiskfileTabs.reopen_last_closed_tab`), and selects its file.
	 */
	reopen_last_closed_tab(): void {
		if (this.tabs.reopen_last_closed_tab()) this.app.diskfiles.follow_selected_tab();
	}

	/**
	 * Opens a tab by id — see `DiskfileTabs.open_tab` — and selects its file.
	 */
	open_tab(tab_id: Uuid): void {
		if (!this.tabs.items.by_id.has(tab_id)) return;
		this.tabs.open_tab(tab_id);
		this.app.diskfiles.follow_selected_tab();
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
		// a modified file's preview tab becomes permanent
		const tab = this.tabs.by_diskfile_id.get(diskfile_id);
		if (tab && tab.id === this.tabs.preview_tab_id) {
			this.tabs.promote_preview_to_permanent();
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
