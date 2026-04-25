// @slop Claude Sonnet 3.7

import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {Cell, type CellOptions} from './cell.svelte.js';
import {DiskfileTabs} from './diskfile_tabs.svelte.js';
import {CellJson} from './cell_types.js';

export const DiskfilesEditorJson = CellJson.extend({
	show_sort_controls: z.boolean().default(false),
}).meta({cell_class_name: 'DiskfilesEditor'});
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
	readonly tabs: DiskfileTabs = new DiskfileTabs({app: this.app});

	constructor(options: DiskfilesEditorOptions) {
		super(DiskfilesEditorJson, options);
		this.init();
	}

	/**
	 * Opens a diskfile in preview mode.
	 */
	preview_diskfile(diskfile_id: Uuid): void {
		console.log('DiskfilesEditor.preview_diskfile', {diskfile_id});
		this.tabs.preview_diskfile(diskfile_id);
	}

	/**
	 * Opens a diskfile in permanent mode.
	 */
	open_diskfile(diskfile_id: Uuid): void {
		console.log('DiskfilesEditor.open_diskfile', {diskfile_id});
		this.tabs.open_diskfile(diskfile_id);
	}

	/**
	 * Reorders tabs.
	 */
	reorder_tabs(from_index: number, to_index: number): void {
		console.log('DiskfilesEditor.reorder_tabs', {from_index, to_index});
		this.tabs.reorder_tabs(from_index, to_index);
	}

	/**
	 * Selects a tab by id.
	 */
	select_tab(tab_id: Uuid): void {
		console.log('DiskfilesEditor.select_tab', {tab_id});
		this.tabs.select_tab(tab_id);
	}

	/**
	 * Closes a tab by id.
	 */
	close_tab(tab_id: Uuid): void {
		console.log('DiskfilesEditor.close_tab', {tab_id});
		this.tabs.close_tab(tab_id);
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
	 * Opens (makes permanent) a tab by id.
	 */
	open_tab(tab_id: Uuid): void {
		console.log('DiskfilesEditor.open_tab', {tab_id});
		this.tabs.open_tab(tab_id);
	}

	/**
	 * Handles when a diskfile's content is modified.
	 */
	handle_file_modified(diskfile_id: Uuid): void {
		console.log('DiskfilesEditor.handle_file_modified', {diskfile_id});
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
