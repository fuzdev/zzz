// @slop Claude Sonnet 3.7

import { z } from 'zod';
import { EMPTY_OBJECT } from '@fuzdev/fuz_util/object.ts';
import { create_uuid, Uuid, UuidWithDefault } from '@fuzdev/fuz_util/id.ts';

import { DiskfilePath } from './diskfile_types.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';

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
	/** An unsaved edit that was set aside unsaved — kept so its text can still be restored. */
	is_discarded_edit: z.boolean().default(false)
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Default cap on the number of entries a `DiskfileHistory` keeps. */
export const DISKFILE_HISTORY_MAX_ENTRIES = 100;

/**
 * Default cap on the total content length (UTF-16 code units) a
 * `DiskfileHistory` keeps — about four versions of a file at the 4 MiB index cap.
 */
export const DISKFILE_HISTORY_MAX_CONTENT_LENGTH = 16 * 1024 * 1024;

/**
 * Schema for the DiskfileHistory cell.
 */
export const DiskfileHistoryJson = CellJson.extend({
	path: DiskfilePath,
	entries: z.array(HistoryEntry).default(() => []),
	max_entries: z.number().default(DISKFILE_HISTORY_MAX_ENTRIES), // TODO rename? `history_size`? `max_size`? `capacity`?
	max_content_length: z.number().default(DISKFILE_HISTORY_MAX_CONTENT_LENGTH)
}).meta({ cell_class_name: 'DiskfileHistory' });
export type DiskfileHistoryJson = z.infer<typeof DiskfileHistoryJson>;
export type DiskfileHistoryJsonInput = z.input<typeof DiskfileHistoryJson>;

export type DiskfileHistoryOptions = CellOptions<typeof DiskfileHistoryJson>;

/** Options for `DiskfileHistory.add_entry`. */
export interface DiskfileHistoryAddEntryOptions {
	is_disk_change?: boolean;
	is_unsaved_edit?: boolean;
	is_original_state?: boolean;
	is_discarded_edit?: boolean;
	label?: string;
	created?: number;
	/** An entry trimming must keep, e.g. the one an editor shows. */
	keep_id?: Uuid | null;
}

/**
 * Stores edit history for a single diskfile, newest first. Owned by the file's
 * app-level `DiskfileEditorState`, which keeps at most one unsaved edit in it.
 *
 * Capped by `max_entries` and `max_content_length`: adding or growing an entry
 * drops the oldest entries past either cap (discarded edits included), but
 * never an unsaved edit, the newest saved state, or the caller's `keep_id` —
 * so the caps can be exceeded only by those.
 */
export class DiskfileHistory extends Cell<typeof DiskfileHistoryJson> {
	path: DiskfilePath = $state.raw()!;
	entries: Array<HistoryEntry> = $state()!;
	max_entries: number = $state.raw()!;
	max_content_length: number = $state.raw()!;

	/**
	 * The most recent history entry (by creation timestamp)
	 * Since entries are always kept sorted by creation time (newest first),
	 * the most recent is always the first element.
	 */
	readonly current_entry: HistoryEntry | null = $derived(this.entries[0] ?? null);

	/** The newest entry holding unsaved user edits — the file's draft. */
	readonly draft_entry: HistoryEntry | null = $derived(
		this.entries.find((entry) => entry.is_unsaved_edit) ?? null
	);

	/** Whether any entry holds unsaved user edits. */
	readonly has_unsaved_edits: boolean = $derived(this.draft_entry !== null);

	constructor(options: DiskfileHistoryOptions) {
		super(DiskfileHistoryJson, options);
		this.init();
	}

	/**
	 * Add a new history entry — or return the current one when it's a duplicate:
	 * the same content, the same kind (an unsaved edit, a discarded edit, or a
	 * saved state — each defaulting to a saved state when not given), and the
	 * same `is_disk_change` / `is_original_state` / `label` wherever `options`
	 * sets them. So adding a saved state never returns a draft or a discarded
	 * edit that happens to hold its content.
	 */
	add_entry(content: string, options: DiskfileHistoryAddEntryOptions = EMPTY_OBJECT): HistoryEntry {
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
			is_discarded_edit: options.is_discarded_edit ?? false
		};

		const new_entries = [...this.entries];
		insert_sorted(new_entries, entry);
		this.entries = this.#trim(new_entries, options.keep_id ?? null);

		// the stored proxy, so callers' mutations are reactive
		return this.find_entry_by_id(entry.id) ?? entry;
	}

	/**
	 * Replaces the content of entry `id` and dates it now, moving it to the
	 * front — how a draft tracks the latest edit.
	 *
	 * @returns the entry, or `undefined` if it's gone
	 */
	update_entry_content(id: Uuid, content: string): HistoryEntry | undefined {
		const entry = this.find_entry_by_id(id);
		if (!entry) return undefined;
		const new_entries = this.entries.filter((e) => e.id !== id);
		entry.content = content;
		entry.created = Math.max(Date.now(), entry.created);
		insert_sorted(new_entries, entry);
		this.entries = this.#trim(new_entries, id);
		return entry;
	}

	/**
	 * Removes entry `id`.
	 *
	 * @returns whether it existed
	 */
	remove_entry(id: Uuid): boolean {
		const index = this.entries.findIndex((entry) => entry.id === id);
		if (index === -1) return false;
		this.entries.splice(index, 1);
		return true;
	}

	/**
	 * Drops the oldest entries until `entries` fits `max_entries` and
	 * `max_content_length`, sparing unsaved edits, the newest saved state, and `keep_id`.
	 */
	#trim(entries: Array<HistoryEntry>, keep_id: Uuid | null): Array<HistoryEntry> {
		let count = entries.length;
		let length = 0;
		for (const entry of entries) length += entry.content.length;
		if (count <= this.max_entries && length <= this.max_content_length) return entries;

		const newest_saved = entries.find(
			(entry) => !entry.is_unsaved_edit && !entry.is_discarded_edit
		);
		const removed: Set<HistoryEntry> = new Set();
		for (let i = entries.length - 1; i >= 0; i--) {
			if (count <= this.max_entries && length <= this.max_content_length) break;
			const entry = entries[i]!; // loop bounds guarantee
			if (entry.is_unsaved_edit || entry === newest_saved || entry.id === keep_id) continue;
			removed.add(entry);
			count--;
			length -= entry.content.length;
		}
		return removed.size ? entries.filter((entry) => !removed.has(entry)) : entries;
	}

	/**
	 * Whether `entry` matches `options` — the entry's kind always (the kind
	 * flags default to `false`), the descriptive fields only where given.
	 */
	#has_same_metadata(entry: HistoryEntry, options: DiskfileHistoryAddEntryOptions): boolean {
		return (
			entry.is_unsaved_edit === (options.is_unsaved_edit ?? false) &&
			entry.is_discarded_edit === (options.is_discarded_edit ?? false) &&
			entry.is_disk_change === (options.is_disk_change ?? entry.is_disk_change) &&
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

/**
 * Inserts `entry` into `entries` (newest first) after every entry at least as new.
 *
 * @mutates entries - splices `entry` in
 */
const insert_sorted = (entries: Array<HistoryEntry>, entry: HistoryEntry): void => {
	let index = 0;
	while (index < entries.length && entries[index]!.created > entry.created) index++;
	entries.splice(index, 0, entry);
};
