// @slop Claude Sonnet 3.7

import {z} from 'zod';
import {EMPTY_OBJECT} from '@fuzdev/fuz_util/object.js';
import {create_uuid, Uuid, UuidWithDefault} from '@fuzdev/fuz_util/id.js';

import {DiskfilePath} from './diskfile_types.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';

/**
 * Schema for history entries.
 */
export const HistoryEntry = z.strictObject({
	id: UuidWithDefault,
	created: z.number(),
	content: z.string(),
	label: z.string(),
	is_disk_change: z.boolean().default(false),
	is_unsaved_edit: z.boolean().default(false), // Indicates entries containing unsaved user edits
	is_original_state: z.boolean().default(false), // Indicates if this entry represents the original disk state
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/**
 * Schema for the DiskfileHistory cell.
 */
export const DiskfileHistoryJson = CellJson.extend({
	path: DiskfilePath,
	entries: z.array(HistoryEntry).default(() => []),
	max_entries: z.number().default(100), // TODO rename? `history_size`? `max_size`? `capacity`?
}).meta({cell_class_name: 'DiskfileHistory'});
export type DiskfileHistoryJson = z.infer<typeof DiskfileHistoryJson>;
export type DiskfileHistoryJsonInput = z.input<typeof DiskfileHistoryJson>;

export type DiskfileHistoryOptions = CellOptions<typeof DiskfileHistoryJson>;

/**
 * Stores edit history for a single diskfile.
 */
export class DiskfileHistory extends Cell<typeof DiskfileHistoryJson> {
	path: DiskfilePath = $state.raw()!;
	entries: Array<HistoryEntry> = $state()!;
	max_entries: number = $state.raw()!;

	/**
	 * The most recent history entry (by creation timestamp)
	 * Since entries are always kept sorted by creation time (newest first),
	 * the most recent is always the first element.
	 */
	readonly current_entry: HistoryEntry | null = $derived(this.entries[0] ?? null);

	constructor(options: DiskfileHistoryOptions) {
		super(DiskfileHistoryJson, options);
		this.init();
	}

	/**
	 * Add a new history entry.
	 */
	add_entry(
		content: string,
		options: {
			is_disk_change?: boolean;
			is_unsaved_edit?: boolean;
			is_original_state?: boolean;
			label?: string;
			created?: number;
		} = EMPTY_OBJECT,
	): HistoryEntry {
		// Don't add duplicate entries with the same content and metadata back-to-back
		if (
			this.current_entry?.content === content &&
			this.#has_same_metadata(this.current_entry, options)
		) {
			return this.current_entry;
		}

		const entry: HistoryEntry = {
			id: create_uuid(),
			created: options.created ?? Date.now(),
			content,
			label: options.label ?? '',
			is_disk_change: options.is_disk_change ?? false,
			is_unsaved_edit: options.is_unsaved_edit ?? false,
			is_original_state: options.is_original_state ?? false,
		};

		// Process the entries in a single operation
		let new_entries = [...this.entries];

		// Find the correct insertion point to maintain sort order (newest first)
		let insertion_index = 0;
		while (insertion_index < new_entries.length) {
			const current_entry = new_entries[insertion_index]!; // loop bounds guarantee
			if (current_entry.created <= entry.created) {
				break;
			}
			insertion_index++;
		}

		// Insert the entry at the correct position
		new_entries.splice(insertion_index, 0, entry);

		// Trim history if it exceeds max size - already sorted by creation time
		if (new_entries.length > this.max_entries) {
			new_entries = new_entries.slice(0, this.max_entries);
		}

		// Assign entries only once
		this.entries = new_entries;

		return entry;
	}

	/**
	 * Compare entry metadata flags with options
	 */
	#has_same_metadata(
		entry: HistoryEntry,
		options: {
			is_disk_change?: boolean;
			is_unsaved_edit?: boolean;
			is_original_state?: boolean;
			label?: string;
		},
	): boolean {
		return (
			entry.is_disk_change === (options.is_disk_change ?? entry.is_disk_change) &&
			entry.is_unsaved_edit === (options.is_unsaved_edit ?? entry.is_unsaved_edit) &&
			entry.is_original_state === (options.is_original_state ?? entry.is_original_state) &&
			entry.label === (options.label ?? entry.label)
		);
	}

	// TODO maybe make a map for faster lookup?
	/**
	 * Find a history entry by id.
	 */
	find_entry_by_id(id: Uuid): HistoryEntry | undefined {
		return this.entries.find((entry) => entry.id === id);
	}

	/**
	 * Get the content of a specific history entry.
	 */
	get_content(id: Uuid): string | null {
		const entry = this.find_entry_by_id(id);
		return entry ? entry.content : null;
	}

	/**
	 * Clear all history entries except the most recent one by creation time
	 * and any entries that match the optional keep predicate.
	 */
	clear_except_current(keep?: (entry: HistoryEntry) => boolean): void {
		if (this.entries.length <= 1) return;

		// Get the current (most recent) entry
		const current = this.entries.length ? this.entries[0] : null;

		// Filter entries to keep
		this.entries = this.entries.filter((entry) => {
			// Always keep the current entry
			if (current && entry.id === current.id) return true;

			// Keep entries that match the predicate if provided
			return keep ? keep(entry) : false;
		});
	}
}
