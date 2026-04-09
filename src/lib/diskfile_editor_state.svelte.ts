// @slop Claude Sonnet 3.7

import {estimate_token_count} from './helpers.js';
import type {Diskfile} from './diskfile.svelte.js';
import type {DiskfilePath} from './diskfile_types.js';
import type {Frontend} from './frontend.svelte.js';
import type {DiskfileHistory, HistoryEntry} from './diskfile_history.svelte.js';
import type {Uuid} from './zod_helpers.js';

// TODO maybe should be a cell?
/**
 * Manages the editor state for a diskfile.
 */
export class DiskfileEditorState {
	app: Frontend;
	diskfile: Diskfile = $state.raw()!; // TODO maybe should be nullable to make initialization easier?

	// Store the id of the unsaved edit entry
	unsaved_edit_entry_id: Uuid | null = $state.raw(null);

	// Track which history entry is currently selected in the UI
	selected_history_entry_id: Uuid | null = $state.raw(null);

	// Used to track if the user has edited the content
	content_was_modified_by_user: boolean = $state.raw(false);

	// Track last seen disk content to detect changes
	last_seen_disk_content: string | null = $state.raw(null);

	// Basic derived states
	readonly original_content: string | null = $derived(this.diskfile.content);
	readonly path: DiskfilePath = $derived.by(() => this.diskfile.path);
	readonly has_changes = $derived.by(() => {
		// For null content files, empty content is the baseline so we shouldn't show changes
		if (this.original_content === null) {
			return this.current_content !== '';
		}
		return this.current_content !== this.original_content;
	});

	// History-related derived states
	readonly history: DiskfileHistory | undefined = $derived.by(() =>
		this.app.get_diskfile_history(this.diskfile.path),
	);
	readonly selected_history_entry = $derived.by(() =>
		this.history && this.selected_history_entry_id
			? this.history.find_entry_by_id(this.selected_history_entry_id)
			: null,
	);
	readonly content_history: Array<HistoryEntry> = $derived(this.history?.entries || []);
	readonly saved_history_entries: Array<HistoryEntry> = $derived(
		this.content_history.filter((entry) => !entry.is_unsaved_edit),
	);
	readonly unsaved_history_entries: Array<HistoryEntry> = $derived(
		this.content_history.filter((entry) => entry.is_unsaved_edit),
	);

	readonly has_history = $derived(this.content_history.length > 1);
	readonly has_unsaved_edits = $derived(this.unsaved_history_entries.length > 0);

	// Derived properties for UI state management
	readonly can_clear_history = $derived(this.saved_history_entries.length > 1);
	readonly can_clear_unsaved_edits = $derived(this.unsaved_history_entries.length > 0);

	readonly unsaved_entry_ids = $derived(this.unsaved_history_entries.map((entry) => entry.id));
	readonly content_matching_entry_ids: Array<Uuid> = $derived(
		this.content_history
			.filter((entry) => entry.content === this.current_content)
			.map((entry) => entry.id),
	);

	// Length-related calculations
	readonly original_length = $derived.by(() => this.original_content?.length ?? 0);
	readonly current_length = $derived(this.current_content.length);
	readonly length_diff = $derived(this.current_length - this.original_length);
	readonly length_diff_percent = $derived(
		this.original_length > 0 ? Math.round((this.length_diff / this.original_length) * 100) : 100,
	);

	// Token-related calculations
	readonly original_token_count = $derived.by(() =>
		this.original_content == null ? 0 : estimate_token_count(this.original_content),
	);
	readonly current_token_count = $derived(estimate_token_count(this.current_content));
	readonly token_diff = $derived(this.current_token_count - this.original_token_count);
	readonly token_diff_percent = $derived(
		this.original_token_count > 0
			? Math.round((this.token_diff / this.original_token_count) * 100)
			: 100,
	);

	// Getter/setter for current_content
	get current_content(): string {
		// If we have a selected entry, use its content
		if (this.selected_history_entry) {
			return this.selected_history_entry.content;
		}

		// If no entry is selected or found, use original content or empty string
		return this.original_content || '';
	}

	set current_content(value: string) {
		const content_changed = value !== this.current_content;

		// Mark as modified only if different from original
		this.content_was_modified_by_user = value !== this.original_content;

		// Only update history if content actually changed
		if (content_changed) {
			this.#update_history_entry(value);
		}
	}

	constructor(options: {app: Frontend; diskfile: Diskfile}) {
		this.app = options.app; // TODO make this a Cell
		this.diskfile = options.diskfile;

		// Set initial last_seen_disk_content
		this.last_seen_disk_content = this.diskfile.content;

		// Always ensure a history object exists for the file
		const history = this.#ensure_history();

		// Only add entry if content is not null and history is empty
		if (this.original_content !== null && history.entries.length === 0) {
			history.add_entry(this.original_content, {
				is_original_state: true,
			});
		}

		// Always select the current entry when initializing, if one exists
		if (history.current_entry) {
			this.selected_history_entry_id = history.current_entry.id;
		}
	}

	/**
	 * Ensures a history object exists for the current file.
	 */
	#ensure_history(): DiskfileHistory {
		let history = this.app.get_diskfile_history(this.path);
		if (!history) {
			history = this.app.create_diskfile_history(this.path);
		}

		// Ensure we always have at least one entry for the original content
		if (this.original_content !== null && history.entries.length === 0) {
			history.add_entry(this.original_content, {
				is_original_state: true,
			});
		}

		return history;
	}

	/**
	 * Updates existing history entry or creates a new one based on the provided content.
	 */
	#update_history_entry(content: string): void {
		const history = this.#ensure_history();
		const matches_original = content === this.original_content;

		// If content matches original, remove any current unsaved entry and select the original entry
		if (matches_original) {
			if (this.unsaved_edit_entry_id) {
				// Find and remove the unsaved entry
				const entry_index = history.entries.findIndex(
					(entry) => entry.id === this.unsaved_edit_entry_id,
				);
				if (entry_index !== -1) {
					history.entries.splice(entry_index, 1);
				}
				this.unsaved_edit_entry_id = null;
			}

			// Find the original entry (most likely the first non-unsaved entry that matches original content)
			const original_entry = history.entries.find(
				(entry) => !entry.is_unsaved_edit && entry.content === this.original_content,
			);

			if (original_entry) {
				this.selected_history_entry_id = original_entry.id;
			} else {
				// If no matching entry found, select the current entry or null
				this.selected_history_entry_id = history.current_entry?.id ?? null;
			}
			return;
		}

		// If we're currently editing an unsaved entry, update it
		if (this.unsaved_edit_entry_id) {
			const unsaved_entry = history.find_entry_by_id(this.unsaved_edit_entry_id);
			if (unsaved_entry) {
				unsaved_entry.content = content;
				this.selected_history_entry_id = this.unsaved_edit_entry_id;
				return;
			}
		}

		// Check if content matches any existing entry before creating a new one

		// First look for an existing unsaved edit with matching content
		const matching_unsaved_entry = history.entries.find(
			(entry) => entry.content === content && entry.is_unsaved_edit,
		);

		if (matching_unsaved_entry) {
			// Found a matching unsaved entry, select it instead of creating a new one
			this.selected_history_entry_id = matching_unsaved_entry.id;
			this.unsaved_edit_entry_id = matching_unsaved_entry.id;
			return;
		}

		// Then look for a matching saved entry
		const matching_saved_entry = history.entries.find(
			(entry) => entry.content === content && !entry.is_unsaved_edit,
		);

		if (matching_saved_entry) {
			// Found a matching saved entry, select it
			this.selected_history_entry_id = matching_saved_entry.id;
			this.unsaved_edit_entry_id = null;
			return;
		}

		// Create a new unsaved entry
		const new_entry = history.add_entry(content, {
			created: Date.now(),
			label: 'Unsaved edit',
			is_unsaved_edit: true,
		});

		this.unsaved_edit_entry_id = new_entry.id;
		this.selected_history_entry_id = new_entry.id;
	}

	/**
	 * Clear and reset the editor state to match the current diskfile content.
	 */
	reset(): void {
		this.last_seen_disk_content = this.diskfile.content;
		this.content_was_modified_by_user = false;

		// Clear state references but don't modify entries
		this.unsaved_edit_entry_id = null;
		this.selected_history_entry_id = null;
	}

	/**
	 * Check if the diskfile content has changed on disk.
	 * Call this when receiving file updates from the server.
	 */
	check_disk_changes(): void {
		// If we don't have current disk content, we can't check for changes
		if (this.diskfile.content === null) {
			return;
		}

		// If this is the first time checking (last_seen_disk_content is null),
		// initialize it with the current disk content
		if (this.last_seen_disk_content === null) {
			this.last_seen_disk_content = this.diskfile.content;
			return;
		}

		// If content hasn't changed from what we last saw, do nothing
		if (this.diskfile.content === this.last_seen_disk_content) {
			return;
		}

		// At this point, we know the disk content has changed

		// Always add a history entry for any disk change
		const history = this.#ensure_history();

		// Create a disk change entry, but only if content is different from any recent entries
		const first_entry = history.entries[0];
		if (
			history.entries.length === 0 ||
			!first_entry ||
			first_entry.content !== this.diskfile.content
		) {
			const disk_entry = history.add_entry(this.diskfile.content, {
				is_disk_change: true,
				label: 'Disk change',
			});

			// If user hasn't made edits, automatically select the disk change
			if (!this.content_was_modified_by_user) {
				this.selected_history_entry_id = disk_entry.id;
			}
		} else {
			// The first entry is the same as the current disk content
			// TODO maybe update created? should already be the latest one though,
			// given it's the first entry in the logic above
			first_entry.is_disk_change = true;
			first_entry.is_unsaved_edit = false;
		}

		// Always update last seen content
		this.last_seen_disk_content = this.diskfile.content;
	}

	/**
	 * Save changes to the diskfile.
	 */
	async save_changes(): Promise<boolean> {
		if (!this.has_changes) return false;

		const history = this.#ensure_history();

		// Store the current content before modifying any state
		const content_to_save = this.current_content;

		// If currently editing an unsaved entry, remove it completely
		if (this.unsaved_edit_entry_id !== null) {
			// Find and remove the unsaved entry from history
			const entry_index = history.entries.findIndex(
				(entry) => entry.id === this.unsaved_edit_entry_id,
			);
			if (entry_index !== -1) {
				history.entries.splice(entry_index, 1);
			}
		}

		// Add a new entry for the saved content
		const entry = history.add_entry(content_to_save);

		// Save to the file
		await this.app.diskfiles.update(this.path, content_to_save);

		// Update last seen content after saving
		this.last_seen_disk_content = content_to_save;
		this.content_was_modified_by_user = false;

		// Clear unsaved edit reference
		this.unsaved_edit_entry_id = null;

		// Set selection to the newly saved entry
		this.selected_history_entry_id = entry.id;

		return true;
	}

	/**
	 * Set content from history entry.
	 */
	set_content_from_history(id: Uuid): void {
		const history = this.history;
		if (!history) return;

		// Track which history entry is selected
		this.selected_history_entry_id = id;

		// Get the selected entry
		const entry = history.find_entry_by_id(id);
		if (!entry) return;

		// Determine if the content in this entry matches the original
		this.content_was_modified_by_user = entry.content !== this.original_content;

		// If we select an entry that has unsaved changes, update the unsaved entry reference
		if (entry.is_unsaved_edit) {
			this.unsaved_edit_entry_id = id;
		} else {
			// Clear unsaved entry reference for non-unsaved entries
			this.unsaved_edit_entry_id = null;
		}
	}

	/**
	 * Update the diskfile reference.
	 * This allows reusing the same editor state instance with a new diskfile.
	 */
	update_diskfile(diskfile: Diskfile): void {
		if (this.diskfile.id === diskfile.id) return;

		// Store the new diskfile
		this.diskfile = diskfile;

		// Reset the editor state
		this.reset();

		// Ensure history is created for the new diskfile
		if (this.original_content !== null) {
			const history = this.#ensure_history();

			// Only add an entry if there's no history yet for this file
			if (history.entries.length === 0) {
				history.add_entry(this.original_content, {
					is_original_state: true,
				});
			}

			// Always select the current entry when switching files
			if (history.current_entry) {
				this.selected_history_entry_id = history.current_entry.id;
			}
		}
	}

	/**
	 * Clear content history, keeping only specific entries based on selection state.
	 */
	clear_history(): void {
		const history = this.history;
		if (!history) return;

		// If there's only one entry or none, nothing to do
		if (history.entries.length <= 1) return;

		// Identify what needs to be kept:
		// 1. All unsaved edits
		// 2. Only the newest non-unsaved edit

		// Find the most recent non-unsaved entry
		const non_unsaved_entries = history.entries.filter((entry) => !entry.is_unsaved_edit);
		const newest_non_unsaved = non_unsaved_entries.length > 0 ? non_unsaved_entries[0] : null;

		// Find all unsaved entries
		const unsaved_entries = history.entries.filter((entry) => entry.is_unsaved_edit);

		// New entries array with only what we want to keep
		const new_entries = [...unsaved_entries];
		if (newest_non_unsaved) {
			new_entries.push(newest_non_unsaved);

			// Mark it as the original state
			newest_non_unsaved.is_original_state = true;
		}

		// Sort to maintain proper order (newest first)
		new_entries.sort((a, b) => b.created - a.created);

		// Update the entries array
		history.entries = new_entries;

		// Update selection if needed
		if (!this.selected_history_entry && newest_non_unsaved) {
			this.selected_history_entry_id = newest_non_unsaved.id;
		}
	}

	/**
	 * Clear all unsaved edit entries from history and reset the editor state if needed.
	 */
	clear_unsaved_edits(): void {
		const history = this.history;
		if (!history) return;

		// Track if current selection is unsaved
		const current_selection_was_unsaved = this.selected_history_entry?.is_unsaved_edit || false;

		// Filter out unsaved entries
		history.entries = history.entries.filter((entry) => !entry.is_unsaved_edit);

		// Always clear the unsaved edit entry id when clearing unsaved edits
		this.unsaved_edit_entry_id = null;

		// Only update selection if the selected entry was removed
		if (current_selection_was_unsaved) {
			// Find the original entry to select
			const original_entry = history.entries.find(
				(entry) => entry.content === this.original_content,
			);

			if (original_entry) {
				// Select original entry
				this.selected_history_entry_id = original_entry.id;
			} else if (history.current_entry) {
				// Fall back to current entry
				this.selected_history_entry_id = history.current_entry.id;
			} else {
				// Last resort, reset to no selection
				this.selected_history_entry_id = null;
			}

			// Reset state
			this.content_was_modified_by_user = false;
		}
	}
}
