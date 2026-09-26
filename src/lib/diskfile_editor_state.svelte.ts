// @slop Claude Sonnet 3.7

import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { estimate_token_count } from './helpers.ts';
import type { Diskfile } from './diskfile.svelte.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import { DISKFILE_CONTENT_NOT_LOADED_MESSAGE } from './diskfile_helpers.ts';
import type { Frontend } from './frontend.svelte.ts';
import { DiskfileHistory, type HistoryEntry } from './diskfile_history.svelte.ts';

/** Label of the history entry holding a file's draft. */
export const HISTORY_LABEL_UNSAVED_EDIT = 'Unsaved edit';
/** Label of a history entry recording a disk state. */
export const HISTORY_LABEL_DISK_CHANGE = 'Disk change';
/** Label of a draft set aside unsaved (see `DiskfileEditorState`). */
export const HISTORY_LABEL_DISCARDED_EDIT = 'Discarded edit';

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
	const entry = history.find_entry_by_id(entry_id);
	if (!entry?.is_unsaved_edit || entry.content !== saved_content) return false;
	return history.remove_entry(entry_id);
};

/** Whether `entry` records a saved or disk state — not the draft, nor a discarded edit. */
const is_saved_state = (entry: HistoryEntry): boolean =>
	!entry.is_unsaved_edit && !entry.is_discarded_edit;

/** A `save_changes` write in flight: the content it writes, and its result. */
interface InFlightSave {
	readonly content: string;
	saving: Promise<boolean>;
}

/** Options for `DiskfileEditorState.save_changes`. */
export interface DiskfileSaveOptions {
	/**
	 * Save even though the file changed on disk under the edit
	 * (`has_conflict`) — the user chose to overwrite that change.
	 */
	overwrite?: boolean;
}

/**
 * The editing state of one file, shared by every view of it — the `/files`
 * editor, file-part editors, tabs — and kept while none is mounted, like a
 * VS Code text model. Get it with `Diskfiles.get_editor_state`, which creates
 * it on first use and keeps it until the diskfile is removed; views never
 * own it.
 *
 * It holds the file's `DiskfileHistory`, and records every change of the
 * file's content on disk into it (`Diskfiles.upsert` calls
 * `check_disk_changes`), whether or not an editor shows it:
 *
 * - The editor shows the selected history entry (`current_content`), or the
 *   disk content when none is selected. A clean editor follows the disk.
 * - Editing keeps the file's one draft: a single unsaved-edit entry, updated
 *   in place and re-dated on each edit. Editing from another entry (an older
 *   state picked from the history) starts a new draft and sets the old one
 *   aside as a discarded-edit entry, so its text stays restorable.
 * - When the disk changes under a draft, or under a picked entry, the edit is
 *   kept and `has_conflict` is set: saving stops until the user chooses to
 *   overwrite (`save_changes({overwrite: true})`) or reload from disk
 *   (`discard_draft`). Our own save's broadcast never counts — the disk
 *   then holds the edit, which settles it. The check is frontend-only: an
 *   external write landing after the backend received our save but before
 *   its broadcast reached us isn't seen as a conflict.
 */
export class DiskfileEditorState {
	readonly app: Frontend;
	readonly diskfile: Diskfile;
	/** The file's edit history — owned by this state, disposed with it. */
	readonly history: DiskfileHistory;

	/** The history entry the editor shows, `null` for the disk content. */
	selected_history_entry_id: Uuid | null = $state.raw(null);

	/** Whether the editor shows content the user chose — typed, or picked from the history. */
	content_was_modified_by_user: boolean = $state.raw(false);

	/** The disk content last recorded in the history. */
	last_seen_disk_content: string | null = $state.raw(null);

	/**
	 * The disk changed while the editor held the user's content (a draft, or a
	 * picked entry), so that content predates what's on disk. Surfaced, and
	 * saving blocked, as `has_conflict` while the editor shows something else
	 * than the disk. Cleared by saving with `overwrite`, `discard_draft`,
	 * or the editor settling on the disk content.
	 */
	disk_conflict: boolean = $state.raw(false);

	/** Whether a `save_changes` write is in flight. */
	saving: boolean = $state.raw(false);

	/** The error message from the last failed save, cleared when a save starts. */
	save_error: string | null = $state.raw(null);

	#in_flight_save: InFlightSave | null = null;

	/** The follow-up save queued behind the in-flight write. */
	#queued_save: Promise<boolean> | null = null;

	// Basic derived states
	readonly original_content: string | null = $derived.by(() => this.diskfile.content);
	readonly path: DiskfilePath = $derived.by(() => this.diskfile.path);
	/**
	 * Whether the file's content was loaded (see `Diskfile.content_loaded`).
	 * When it wasn't, the editor is read-only: edits are ignored and nothing
	 * can be saved, since a save would overwrite a file nobody has seen.
	 */
	readonly content_loaded: boolean = $derived(this.original_content !== null);
	readonly has_changes = $derived.by(() => {
		// an unloaded file has no baseline to differ from, and can't be edited
		if (this.original_content === null) return false;
		return this.current_content !== this.original_content;
	});
	/**
	 * Whether saving would write anything. Always true for a file deleted on
	 * disk — saving recreates it even when the content matches its last state.
	 * Never true when the content wasn't loaded.
	 */
	readonly can_save: boolean = $derived.by(
		() => this.content_loaded && (this.has_changes || this.diskfile.deleted_on_disk)
	);
	/**
	 * Whether the editor shows the user's content over a disk change it
	 * predates (see `disk_conflict`). While true, `save_changes` refuses unless
	 * asked to `overwrite`.
	 */
	readonly has_conflict: boolean = $derived(this.disk_conflict && this.has_changes);

	// History-related derived states
	readonly selected_history_entry: HistoryEntry | null = $derived.by(() =>
		this.selected_history_entry_id
			? (this.history.find_entry_by_id(this.selected_history_entry_id) ?? null)
			: null
	);
	readonly content_history: Array<HistoryEntry> = $derived.by(() => this.history.entries);
	readonly saved_history_entries: Array<HistoryEntry> = $derived(
		this.content_history.filter((entry) => !entry.is_unsaved_edit)
	);
	readonly unsaved_history_entries: Array<HistoryEntry> = $derived(
		this.content_history.filter((entry) => entry.is_unsaved_edit)
	);
	/** The id of the file's draft — its unsaved-edit entry — if it has one. */
	readonly unsaved_edit_entry_id: Uuid | null = $derived.by(
		() => this.history.draft_entry?.id ?? null
	);

	readonly has_history = $derived(this.content_history.length > 1);
	readonly has_unsaved_edits = $derived.by(() => this.history.has_unsaved_edits);
	/**
	 * Whether the file is marked modified (the tab's and explorer's ●): it has a
	 * draft, or the editor shows something other than the disk content.
	 */
	readonly dirty: boolean = $derived(this.has_changes || this.has_unsaved_edits);

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

	/**
	 * The editor's text: the selected history entry's, else the disk content.
	 * Always `''` when the content isn't loaded — earlier text in history
	 * (from before the file grew past the index cap, say) isn't what's on
	 * disk, so the read-only editor never shows or copies it.
	 */
	get current_content(): string {
		if (!this.content_loaded) return '';
		if (this.selected_history_entry) return this.selected_history_entry.content;
		return this.original_content ?? '';
	}

	/** Applies an edit — see the class docs for how it lands in the history. */
	set current_content(value: string) {
		// read-only — see `content_loaded`
		if (!this.content_loaded) return;

		const shown = this.current_content;
		this.content_was_modified_by_user = value !== this.original_content;
		if (value !== shown) this.#apply_edit(value, shown);
	}

	constructor(options: { app: Frontend; diskfile: Diskfile }) {
		this.app = options.app;
		this.diskfile = options.diskfile;
		this.history = new DiskfileHistory({ app: this.app, json: { path: this.diskfile.path } });

		const { content } = this.diskfile;
		this.last_seen_disk_content = content;
		if (content !== null) {
			this.selected_history_entry_id = this.history.add_entry(content, {
				is_original_state: true
			}).id;
		}
	}

	/** Disposes the history. Called by `Diskfiles` when the diskfile goes away. */
	dispose(): void {
		this.history.dispose();
	}

	/**
	 * @param content - the edited text
	 * @param shown - what the editor showed before the edit
	 */
	#apply_edit(content: string, shown: string): void {
		const { history } = this;
		const draft = history.draft_entry;

		// typing into the draft updates it — or drops it, once back at the disk content
		if (draft && draft.id === this.selected_history_entry_id) {
			if (content === this.original_content) {
				history.remove_entry(draft.id);
				this.#select_disk_entry();
				this.#clear_conflict_if_settled();
			} else {
				history.update_entry_content(draft.id, content);
			}
			return;
		}

		// an edit from another entry that lands on the disk content or the draft shows it
		if (content === this.original_content) {
			this.#select_disk_entry();
			this.#clear_conflict_if_settled();
			return;
		}
		if (draft?.content === content) {
			this.selected_history_entry_id = draft.id;
			return;
		}

		// new text: it becomes the draft, and a previous draft is set aside —
		// even when it matches an older saved state, it's unsaved in this file
		if (draft) this.#set_aside_draft(draft);
		this.selected_history_entry_id = history.add_entry(content, {
			label: HISTORY_LABEL_UNSAVED_EDIT,
			is_unsaved_edit: true
		}).id;
		// a draft started from the disk content is based on it — any conflict was
		// the set-aside draft's
		if (shown === this.original_content) this.disk_conflict = false;
	}

	/**
	 * Keeps `draft`'s text as a discarded-edit entry instead of an unsaved edit.
	 *
	 * @mutates draft - flags it discarded
	 */
	#set_aside_draft(draft: HistoryEntry): void {
		draft.is_unsaved_edit = false;
		draft.is_discarded_edit = true;
		draft.label = HISTORY_LABEL_DISCARDED_EDIT;
	}

	/** Selects the newest saved entry holding the disk content, or none (showing the disk content). */
	#select_disk_entry(): void {
		const content = this.original_content;
		this.selected_history_entry_id =
			this.history.entries.find((entry) => is_saved_state(entry) && entry.content === content)
				?.id ?? null;
	}

	#clear_conflict_if_settled(): void {
		if (!this.content_was_modified_by_user && !this.history.has_unsaved_edits) {
			this.disk_conflict = false;
		}
	}

	/**
	 * Records the diskfile's content in the history if it changed on disk
	 * since last seen. `Diskfiles.upsert` calls it for every content change, so
	 * the history tracks the disk whether or not an editor shows the file;
	 * calling it again is a no-op.
	 *
	 * A clean editor moves to the new disk content. An editor showing the
	 * user's content keeps it, and the change becomes a `disk_conflict` —
	 * unless it's that very content (e.g. our own save's broadcast, landing
	 * after an external edit's), which settles the editor, or the content of
	 * the save in flight (our own write, with typing continuing past it).
	 */
	check_disk_changes(): void {
		const disk_content = this.diskfile.content;
		if (disk_content === null || disk_content === this.last_seen_disk_content) return;
		this.last_seen_disk_content = disk_content;

		const { history } = this;
		const draft = history.draft_entry;
		let disk_entry: HistoryEntry;
		if (draft?.content === disk_content) {
			// the draft is on disk now — it's the disk state
			draft.is_unsaved_edit = false;
			draft.is_disk_change = true;
			draft.label = HISTORY_LABEL_DISK_CHANGE;
			disk_entry = draft;
		} else {
			const newest_saved = history.entries.find(is_saved_state);
			if (newest_saved?.content === disk_content) {
				newest_saved.is_disk_change = true;
				disk_entry = newest_saved;
			} else {
				disk_entry = history.add_entry(disk_content, {
					is_disk_change: true,
					label: HISTORY_LABEL_DISK_CHANGE,
					keep_id: this.selected_history_entry_id
				});
			}
		}

		if (this.current_content === disk_content) {
			// the editor already shows what's now on disk, so nothing is unsaved in it
			if (!this.selected_history_entry) this.selected_history_entry_id = disk_entry.id;
			this.content_was_modified_by_user = false;
		} else if (!this.content_was_modified_by_user) {
			this.selected_history_entry_id = disk_entry.id;
		}
		// our own write landing (typing may have continued past it) resolves any
		// conflict; any other change leaves the user's content — shown, or a draft
		// viewed away from — predating the disk
		this.disk_conflict =
			this.#in_flight_save?.content !== disk_content &&
			(this.content_was_modified_by_user || history.has_unsaved_edits);
	}

	/**
	 * Save changes to the diskfile. History, selection, and the modified flag
	 * change only once the write succeeds; a failure leaves the edit unsaved and
	 * sets `save_error` — including a write that throws, so this never rejects.
	 * One save runs at a time: saving while a write is in flight queues a
	 * single follow-up save (repeat calls share it) that writes whatever the
	 * editor holds once the first settles — skipped if that write failed. If
	 * the editor or the disk moves on while the write is in flight — more
	 * typing, another history entry picked, an external edit landing after the
	 * save's own — the saved content is recorded in history without taking
	 * over the editor.
	 *
	 * Refuses, writing nothing, while `has_conflict` — unless `overwrite` — so
	 * a change made on disk under the edit is never overwritten silently. A
	 * file whose content wasn't loaded is never saved: this sets `save_error`.
	 *
	 * @returns whether the content was written — for a queued follow-up with
	 * nothing left to write, whether the in-flight save succeeded
	 */
	save_changes(options?: DiskfileSaveOptions): Promise<boolean> {
		// never write over a file whose content wasn't loaded
		// (`Diskfiles.update` refuses it too)
		if (!this.content_loaded) {
			this.save_error = DISKFILE_CONTENT_NOT_LOADED_MESSAGE;
			return Promise.resolve(false);
		}
		const in_flight = this.#in_flight_save;
		if (in_flight) {
			// cleared as soon as the in-flight save settles (it never rejects),
			// so a save issued during the follow-up queues a fresh one
			this.#queued_save ??= in_flight.saving.then((ok) => {
				this.#queued_save = null;
				if (!ok) return false;
				// nothing typed since — the in-flight save already wrote it
				if (this.current_content === in_flight.content || !this.can_save) return true;
				return this.save_changes(options);
			});
			return this.#queued_save;
		}
		if (!this.can_save) return Promise.resolve(false);
		if (this.has_conflict && !options?.overwrite) return Promise.resolve(false);

		// registered before the write starts — a write that throws synchronously
		// settles `#save` before it returns, and its cleanup must find the entry
		const in_flight_save: InFlightSave = {
			content: this.current_content,
			saving: Promise.resolve(false)
		};
		this.#in_flight_save = in_flight_save;
		in_flight_save.saving = this.#save(in_flight_save);
		return in_flight_save.saving;
	}

	/**
	 * Saves the draft — "save" when closing a tab, "overwrite with your draft" on a
	 * conflict — whatever history entry the editor shows: it shows the draft
	 * first, then saves as `save_changes` does. Without a draft, saves what the
	 * editor shows.
	 *
	 * @returns see `save_changes`
	 */
	save_draft(options?: DiskfileSaveOptions): Promise<boolean> {
		const draft = this.history.draft_entry;
		if (draft && draft.id !== this.selected_history_entry_id) {
			this.set_content_from_history(draft.id);
		}
		return this.save_changes(options);
	}

	async #save(in_flight_save: InFlightSave): Promise<boolean> {
		const { diskfile, history } = this;
		const content_to_save = in_flight_save.content;
		const unsaved_edit_entry_id = this.unsaved_edit_entry_id;
		const last_seen_at_start = this.last_seen_disk_content;
		const started = Date.now();

		this.save_error = null;
		this.saving = true;
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
			this.saving = false;
			if (this.#in_flight_save === in_flight_save) this.#in_flight_save = null;
		}

		if (error_message !== null) {
			this.save_error = error_message;
			return false;
		}
		this.save_error = null;
		// the write recreated a file deleted on disk — it's no longer held only
		// for a draft, even before the `add` broadcast arrives
		diskfile.deleted_on_disk = false;

		// a disk change other than this save landed while in flight — the disk no
		// longer holds the saved content, and `check_disk_changes` already recorded it
		const disk_moved_on =
			this.last_seen_disk_content !== last_seen_at_start && diskfile.content !== content_to_save;

		// nothing moved while in flight, so the editor settles on the saved content
		const settled = !disk_moved_on && this.current_content === content_to_save;

		// a still-viewed entry stays put when the editor doesn't settle on the save
		remove_superseded_unsaved_entry(
			history,
			unsaved_edit_entry_id,
			content_to_save,
			settled ? null : this.selected_history_entry_id
		);

		// dated to when the save was issued, so it sorts below later disk changes;
		// deduped by `add_entry` when a disk-change entry for it is already newest
		const saved_entry =
			disk_moved_on &&
			history.entries.some((entry) => !entry.is_unsaved_edit && entry.content === content_to_save)
				? null
				: history.add_entry(content_to_save, {
						is_unsaved_edit: false,
						created: started,
						keep_id: this.selected_history_entry_id
					});

		if (!disk_moved_on) {
			this.last_seen_disk_content = content_to_save;
			// the disk holds what was saved, so nothing edited predates it
			this.disk_conflict = false;
		}

		if (settled && saved_entry) {
			this.content_was_modified_by_user = false;
			this.selected_history_entry_id = saved_entry.id;
		}

		return true;
	}

	/**
	 * Drops the edit in favor of the disk — "reload from disk" on a conflict,
	 * "don't save" on closing a tab: shows the disk content, setting the draft
	 * aside as a discarded-edit entry so its text stays in the history (until
	 * the history caps or a clear drop it). A file deleted on disk that was kept
	 * only for the draft is then forgotten (`Diskfiles.release_if_unneeded`),
	 * disposing this state.
	 */
	discard_draft(): void {
		const draft = this.history.draft_entry;
		if (draft) this.#set_aside_draft(draft);
		this.#select_disk_entry();
		this.content_was_modified_by_user = false;
		this.disk_conflict = false;
		this.save_error = null;
		this.app.diskfiles.release_if_unneeded(this.diskfile.id);
	}

	/**
	 * Resets what the editor shows when the file's last tab closes, so reopening
	 * it shows the draft if there is one, else the disk content.
	 */
	reset_view(): void {
		const draft = this.history.draft_entry;
		if (draft) {
			this.selected_history_entry_id = draft.id;
		} else {
			this.#select_disk_entry();
		}
		this.content_was_modified_by_user = this.current_content !== this.original_content;
		this.#clear_conflict_if_settled();
		this.save_error = null;
	}

	/**
	 * Shows history entry `id` in the editor. Picking an entry changes
	 * nothing else — editing it is what starts a draft.
	 */
	set_content_from_history(id: Uuid): void {
		const entry = this.history.find_entry_by_id(id);
		if (!entry) return;
		this.selected_history_entry_id = id;
		this.content_was_modified_by_user = entry.content !== this.original_content;
		this.#clear_conflict_if_settled();
	}

	/**
	 * Clears the history down to the unsaved edits and the entry for the disk
	 * content (the newest saved entry if none matches), which becomes the
	 * original state. A selection it removes moves to that entry.
	 */
	clear_history(): void {
		const { history } = this;
		if (history.entries.length <= 1) return;

		const saved = history.entries.filter(is_saved_state);
		const disk_entry =
			saved.find((entry) => entry.content === this.original_content) ?? saved[0] ?? null;
		if (disk_entry) disk_entry.is_original_state = true;
		// already sorted newest first
		history.entries = history.entries.filter(
			(entry) => entry.is_unsaved_edit || entry === disk_entry
		);

		if (!this.selected_history_entry) {
			this.selected_history_entry_id = disk_entry?.id ?? null;
			this.content_was_modified_by_user = this.current_content !== this.original_content;
		}
	}

	/**
	 * Deletes the unsaved edits from the history. If the editor showed one, it
	 * moves to the disk content.
	 */
	clear_unsaved_edits(): void {
		const { history } = this;
		const selected_unsaved = this.selected_history_entry?.is_unsaved_edit ?? false;
		history.entries = history.entries.filter((entry) => !entry.is_unsaved_edit);
		if (selected_unsaved) {
			this.#select_disk_entry();
			this.content_was_modified_by_user = false;
		}
		this.#clear_conflict_if_settled();
		this.app.diskfiles.release_if_unneeded(this.diskfile.id);
	}
}
