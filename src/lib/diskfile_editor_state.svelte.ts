// @slop Claude Sonnet 3.7

import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { SvelteSet } from 'svelte/reactivity';

import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { estimate_token_count } from './helpers.ts';
import type { Diskfile } from './diskfile.svelte.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import type { Frontend } from './frontend.svelte.ts';
import type { DiskfileHistory, HistoryEntry } from './diskfile_history.svelte.ts';

/**
 * Rounded percent change `diff` makes to `original`. An empty original has no
 * meaningful ratio, so any growth from it reads as 100% and no change as 0%.
 */
const to_diff_percent = (diff: number, original: number): number => {
	if (diff === 0) return 0;
	if (original <= 0) return 100;
	return Math.round((diff / original) * 100);
};

/**
 * Removes the unsaved-edit entry `entry_id` once `saved_content` is written,
 * if it still holds exactly that content — not if it was edited since, if a
 * disk-change broadcast already claimed it as the disk state, or if it's
 * `keep_entry_id`.
 *
 * @returns whether the entry was removed
 * @mutates history - splices the entry out of `entries`
 */
const remove_superseded_unsaved_entry = (
	history: DiskfileHistory,
	entry_id: Uuid | null,
	saved_content: string,
	keep_entry_id: Uuid | null = null
): boolean => {
	if (entry_id === null || entry_id === keep_entry_id) return false;
	const index = history.entries.findIndex((entry) => entry.id === entry_id);
	const entry = history.entries[index];
	if (!entry?.is_unsaved_edit || entry.content !== saved_content) return false;
	history.entries.splice(index, 1);
	return true;
};

/** A `save_changes` write in flight: the content it writes, and its result. */
interface InFlightSave {
	readonly content: string;
	saving: Promise<boolean>;
}

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

	/** Ids of the diskfiles with a `save_changes` write in flight. */
	readonly #saving_diskfile_ids: SvelteSet<Uuid> = new SvelteSet();

	/** The in-flight `save_changes` writes and the content each is writing, by diskfile id. */
	readonly #in_flight_saves: Map<Uuid, InFlightSave> = new Map();

	/** The follow-up saves queued behind an in-flight write, by diskfile id. */
	readonly #queued_saves: Map<Uuid, Promise<boolean>> = new Map();

	/**
	 * Whether a `save_changes` write for the current diskfile is in flight.
	 * Keyed to the diskfile, so a save still running for a file the editor has
	 * moved away from doesn't block saving the one it shows now.
	 */
	readonly saving: boolean = $derived(this.#saving_diskfile_ids.has(this.diskfile.id));

	/** The error message from the last failed save, cleared when a save starts. */
	save_error: string | null = $state.raw(null);

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
	/**
	 * Whether saving would write anything. Always true for a file deleted on
	 * disk — saving recreates it even when the content matches its last state.
	 */
	readonly can_save: boolean = $derived(this.has_changes || this.diskfile.deleted_on_disk);

	// History-related derived states
	readonly history: DiskfileHistory | undefined = $derived.by(() =>
		this.app.get_diskfile_history(this.diskfile.path)
	);
	readonly selected_history_entry = $derived.by(() =>
		this.history && this.selected_history_entry_id
			? this.history.find_entry_by_id(this.selected_history_entry_id)
			: null
	);
	readonly content_history: Array<HistoryEntry> = $derived(this.history?.entries || []);
	readonly saved_history_entries: Array<HistoryEntry> = $derived(
		this.content_history.filter((entry) => !entry.is_unsaved_edit)
	);
	readonly unsaved_history_entries: Array<HistoryEntry> = $derived(
		this.content_history.filter((entry) => entry.is_unsaved_edit)
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
			.map((entry) => entry.id)
	);

	// Length-related calculations
	readonly original_length = $derived.by(() => this.original_content?.length ?? 0);
	readonly current_length = $derived(this.current_content.length);
	readonly length_diff = $derived(this.current_length - this.original_length);
	/**
	 * Percent change in length from the original. Growth from an empty original
	 * reads as 100% (no change reads as 0%).
	 */
	readonly length_diff_percent = $derived(to_diff_percent(this.length_diff, this.original_length));

	// Token-related calculations
	readonly original_token_count = $derived.by(() =>
		this.original_content == null ? 0 : estimate_token_count(this.original_content)
	);
	readonly current_token_count = $derived(estimate_token_count(this.current_content));
	readonly token_diff = $derived(this.current_token_count - this.original_token_count);
	/**
	 * Percent change in token count from the original — see `length_diff_percent`.
	 */
	readonly token_diff_percent = $derived(
		to_diff_percent(this.token_diff, this.original_token_count)
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

	constructor(options: { app: Frontend; diskfile: Diskfile }) {
		this.app = options.app; // TODO make this a Cell
		this.diskfile = options.diskfile;

		// Set initial last_seen_disk_content
		this.last_seen_disk_content = this.diskfile.content;

		// Always ensure a history object exists for the file
		const history = this.#ensure_history();

		// Only add entry if content is not null and history is empty
		if (this.original_content !== null && history.entries.length === 0) {
			history.add_entry(this.original_content, {
				is_original_state: true
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
				is_original_state: true
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
					(entry) => entry.id === this.unsaved_edit_entry_id
				);
				if (entry_index !== -1) {
					history.entries.splice(entry_index, 1);
				}
				this.unsaved_edit_entry_id = null;
			}

			// Find the original entry (most likely the first non-unsaved entry that matches original content)
			const original_entry = history.entries.find(
				(entry) => !entry.is_unsaved_edit && entry.content === this.original_content
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
			(entry) => entry.content === content && entry.is_unsaved_edit
		);

		if (matching_unsaved_entry) {
			// Found a matching unsaved entry, select it instead of creating a new one
			this.selected_history_entry_id = matching_unsaved_entry.id;
			this.unsaved_edit_entry_id = matching_unsaved_entry.id;
			return;
		}

		// Then look for a matching saved entry
		const matching_saved_entry = history.entries.find(
			(entry) => entry.content === content && !entry.is_unsaved_edit
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
			is_unsaved_edit: true
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
		this.save_error = null;

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
				label: 'Disk change'
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

		// the editor already shows what's now on disk — e.g. a save's own write whose
		// broadcast lands after the response, behind an external write's — so
		// nothing is unsaved anymore
		if (this.diskfile.content === this.current_content) {
			this.#settle_on_disk_content(history, this.diskfile.content);
		}
	}

	/**
	 * Settles the editor on `disk_content` when it already shows it: drops the
	 * unsaved-edit entry holding that content, selects the newest saved entry
	 * for it if the selection was an unsaved edit, and clears the modified flag.
	 *
	 * @mutates history - splices the superseded unsaved entry out of `entries`
	 */
	#settle_on_disk_content(history: DiskfileHistory, disk_content: string): void {
		const selected_unsaved = this.selected_history_entry?.is_unsaved_edit ?? false;
		remove_superseded_unsaved_entry(history, this.unsaved_edit_entry_id, disk_content);
		this.unsaved_edit_entry_id = null;
		this.content_was_modified_by_user = false;
		if (selected_unsaved || !this.selected_history_entry) {
			const disk_entry = history.entries.find(
				(entry) => !entry.is_unsaved_edit && entry.content === disk_content
			);
			if (disk_entry) this.selected_history_entry_id = disk_entry.id;
		}
	}

	/**
	 * Save changes to the diskfile. History, selection, and the modified flag
	 * change only once the write succeeds; a failure leaves the edit unsaved and
	 * sets `save_error` — including a write that throws, so this never rejects.
	 * One save per diskfile runs at a time: saving while a
	 * write is in flight queues a single follow-up save (repeat calls share it)
	 * that writes whatever the editor holds once the first settles — skipped if
	 * that write failed or the editor moved to another diskfile. If the editor or
	 * the disk moves on while the write is in flight — more typing, another
	 * history entry picked, an external edit landing after the save's own — the
	 * saved content is recorded in history without taking over the editor. If
	 * the editor switched to another diskfile meanwhile, only the saved file's
	 * history is settled; the editor's state now belongs to the other file.
	 *
	 * @returns whether the content was written — for a queued follow-up with
	 * nothing left to write, whether the in-flight save succeeded
	 */
	save_changes(): Promise<boolean> {
		const { diskfile } = this;
		const in_flight = this.#in_flight_saves.get(diskfile.id);
		if (in_flight) {
			let queued = this.#queued_saves.get(diskfile.id);
			if (!queued) {
				// cleared as soon as the in-flight save settles (it never rejects),
				// so a save issued during the follow-up queues a fresh one
				queued = in_flight.saving.then((ok) => {
					this.#queued_saves.delete(diskfile.id);
					if (!ok || this.diskfile !== diskfile) return false;
					// nothing typed since — the in-flight save already wrote it
					if (this.current_content === in_flight.content || !this.can_save) return true;
					return this.save_changes();
				});
				this.#queued_saves.set(diskfile.id, queued);
			}
			return queued;
		}
		if (!this.can_save) return Promise.resolve(false);

		// registered before the write starts — a write that throws synchronously
		// settles `#save` before it returns, and its cleanup must find the entry
		const in_flight_save: InFlightSave = {
			content: this.current_content,
			saving: Promise.resolve(false)
		};
		this.#in_flight_saves.set(diskfile.id, in_flight_save);
		in_flight_save.saving = this.#save(diskfile, in_flight_save);
		return in_flight_save.saving;
	}

	async #save(diskfile: Diskfile, in_flight_save: InFlightSave): Promise<boolean> {
		const content_to_save = in_flight_save.content;
		const history = this.#ensure_history();
		const unsaved_edit_entry_id = this.unsaved_edit_entry_id;
		const last_seen_at_start = this.last_seen_disk_content;
		const started = Date.now();

		this.save_error = null;
		this.#saving_diskfile_ids.add(diskfile.id);
		// a thrown write (e.g. the transport failing) is a failed save like any
		// other — reported through `save_error`, never a rejection
		let error_message: string | null = null;
		try {
			const result = await this.app.diskfiles.update(diskfile.path, content_to_save);
			if (!result.ok) error_message = result.error.message;
		} catch (error) {
			console.error('[DiskfileEditorState] save threw:', error);
			error_message = to_error_message(error, 'save failed');
		} finally {
			this.#saving_diskfile_ids.delete(diskfile.id);
			if (this.#in_flight_saves.get(diskfile.id) === in_flight_save) {
				this.#in_flight_saves.delete(diskfile.id);
			}
		}

		if (this.diskfile !== diskfile) {
			// nothing here shows the saved file anymore, so settle its history alone
			if (error_message === null) {
				remove_superseded_unsaved_entry(history, unsaved_edit_entry_id, content_to_save);
				history.add_entry(content_to_save, { is_unsaved_edit: false, created: started });
			}
			return error_message === null;
		}

		if (error_message !== null) {
			this.save_error = error_message;
			return false;
		}
		this.save_error = null;

		// a disk change other than this save landed while in flight — the disk no
		// longer holds the saved content, and `check_disk_changes` already recorded it
		const disk_moved_on =
			this.last_seen_disk_content !== last_seen_at_start && diskfile.content !== content_to_save;

		// nothing moved while in flight, so the editor settles on the saved content
		const settled = !disk_moved_on && this.current_content === content_to_save;

		// a still-viewed entry stays put when the editor doesn't settle on the save
		const removed = remove_superseded_unsaved_entry(
			history,
			unsaved_edit_entry_id,
			content_to_save,
			settled ? null : this.selected_history_entry_id
		);
		if (removed && this.unsaved_edit_entry_id === unsaved_edit_entry_id) {
			this.unsaved_edit_entry_id = null;
		}

		// dated to when the save was issued, so it sorts below later disk changes;
		// deduped by `add_entry` when a disk-change entry for it is already newest
		const saved_entry =
			disk_moved_on &&
			history.entries.some((entry) => !entry.is_unsaved_edit && entry.content === content_to_save)
				? null
				: history.add_entry(content_to_save, { is_unsaved_edit: false, created: started });

		if (!disk_moved_on) {
			this.last_seen_disk_content = content_to_save;
		}

		if (settled && saved_entry) {
			this.content_was_modified_by_user = false;
			this.unsaved_edit_entry_id = null;
			this.selected_history_entry_id = saved_entry.id;
		}

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
					is_original_state: true
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
				(entry) => entry.content === this.original_content
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
