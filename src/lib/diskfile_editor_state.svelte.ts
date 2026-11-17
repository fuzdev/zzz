// @slop Claude Sonnet 3.7

import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { estimate_token_count } from './helpers.ts';
import type { Diskfile } from './diskfile.svelte.ts';
import type { DiskfileContentStatus, DiskfilePath } from './diskfile_types.ts';
import {
	ERROR_ALREADY_EXISTS,
	ERROR_DISK_CHANGED,
	ERROR_PATH_NOT_FOUND,
	to_diskfile_unloaded_message
} from './diskfile_helpers.ts';
import type { Frontend } from './frontend.svelte.ts';
import { DiskfileHistory, type HistoryEntry } from './diskfile_history.svelte.ts';
import { to_default_markdown_view_mode, type MarkdownViewMode } from './markdown_view_mode.ts';

/** `save_error` for a save that found the file gone — its delete not reported yet. */
export const SAVE_ERROR_DELETED_ON_DISK = 'not saved — the file was deleted on disk';

/**
 * `save_error` for a save that found the file gone, now flagged
 * `deleted_on_disk` — so the next save recreates it.
 */
export const SAVE_ERROR_RECREATES =
	'not saved — the file was deleted on disk; saving again recreates it';

/**
 * `save_error` for an overwrite refused because a newer version than the one
 * shown is on disk — cleared once the disk settles on the editor's content.
 */
export const SAVE_ERROR_CHANGED_AGAIN = 'not saved — the file changed on disk again';

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

/** What an overwrite is checked against, taken when the user asks for it — see `save_changes`. */
interface OverwriteBase {
	/** The hash of the disk version shown, `null` to write unchecked (the last read had failed). */
	readonly hash: string | null;
}

/** A `save_changes` write in flight: the content it writes, and its result. */
interface InFlightSave {
	readonly content: string;
	/** Whether the user asked to overwrite a change on disk (`DiskfileSaveOptions.overwrite`). */
	readonly overwrite: boolean;
	/**
	 * Whether the write recreates a file deleted on disk (`Diskfile.deleted_on_disk`)
	 * — exclusively (`Diskfiles.create_exclusive`), so it never replaces a
	 * file that's there after all, or is there again.
	 */
	readonly create: boolean;
	/**
	 * The hash of the disk content the write is based on, which the backend
	 * compares before writing (`diskfile_update`'s `expected_hash`) — `null`
	 * to write over whatever is there. Unused by a `create`.
	 */
	readonly expected_hash: string | null;
	saving: Promise<boolean>;
}

/** Options for `DiskfileEditorState.save_changes`. */
export interface DiskfileSaveOptions {
	/**
	 * Save even though the file changed on disk under the edit
	 * (`has_conflict`) — the user chose to overwrite that change: the disk
	 * version they were shown, so a newer one they haven't seen still stops
	 * the save (see `save_changes`).
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
 * file's content on disk into it (`Diskfiles` calls `check_disk_changes`
 * whenever new content lands), whether or not an editor shows it — having
 * an editing state keeps a file's content current (see `Diskfiles.upsert`):
 *
 * - The content loads on demand: the views call `Diskfiles.ensure_content`.
 *   Until it lands the editor is read-only, and its first arrival seeds the
 *   history's original state — it's not a change on disk.
 * - The editor shows the selected history entry (`current_content`), or the
 *   disk content when none is selected. A clean editor follows the disk.
 * - Editing keeps the file's one draft: a single unsaved-edit entry, updated
 *   in place and re-dated on each edit. Editing from another entry (an older
 *   state picked from the history) starts a new draft and sets the old one
 *   aside as a discarded-edit entry, so its text stays restorable.
 * - When the disk changes under a draft, or under a picked entry, the edit is
 *   kept and `has_conflict` is set: saving stops until the user chooses to
 *   overwrite (`save_changes({overwrite: true})`) or keep the disk version
 *   (`discard_draft`). Our own save's broadcast never counts — the disk
 *   then holds the edit, which settles it. The backend checks too: a save
 *   carries the hash of the disk content it's based on
 *   (`last_seen_disk_hash`), so a write the frontend hasn't heard of yet
 *   refuses it (`disk_changed`), and the file is read again to show that
 *   change as a conflict like any other.
 * - During a conflict the views can show the disk content instead, read-only
 *   (`showing_disk`, `shown_content`), without touching the edit.
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
	 * The hash of `last_seen_disk_content` (`Diskfile.content_hash`, or the
	 * hash our own save's response returned) — the base a save sends, so the
	 * backend writes only if the file still holds that content
	 * (`diskfile_update`'s `expected_hash`). It moves with
	 * `last_seen_disk_content`: when new content lands, and when our own
	 * save lands — so a save queued behind it is based on what it wrote,
	 * before the re-read its broadcast starts. `null` while the content is
	 * unknown or came without a hash (seeded from JSON, not read), and a save
	 * then writes unchecked.
	 */
	last_seen_disk_hash: string | null = $state.raw(null);

	/**
	 * The disk changed while the editor held the user's content (a draft, or a
	 * picked entry), so that content predates what's on disk. Surfaced, and
	 * saving blocked, as `has_conflict` while the editor shows something else
	 * than the disk. Cleared by saving with `overwrite`, `discard_draft`,
	 * or the editor settling on the disk content.
	 */
	disk_conflict: boolean = $state.raw(false);

	/**
	 * The user asked to see the disk content during a conflict — see
	 * `showing_disk`. Lapses with the conflict, and is cleared by anything that
	 * puts the user's content in the editor (an edit, a history pick, an
	 * overwrite, a view reset, a delete on disk), so a later conflict shows
	 * the user's content first.
	 */
	#show_disk: boolean = $state.raw(false);

	/** Whether a `save_changes` write is in flight. */
	saving: boolean = $state.raw(false);

	/** How many saves wait for a read of the file before deciding (`save_pending`). */
	#save_waits: number = $state.raw(0);

	/**
	 * Whether a save waits for a read of the file to land before it decides
	 * whether to write (see `save_changes`) — busy like `saving`, before the
	 * write starts.
	 */
	readonly save_pending: boolean = $derived.by(() => this.#save_waits > 0);

	/** The error message from the last failed save, cleared when a save starts. */
	save_error: string | null = $state.raw(null);

	/**
	 * The markdown view's mode the user chose for this file, `null` until they
	 * choose one. Kept with the rest of the file's editing state, so it lasts
	 * across tab switches and reopening for as long as the app keeps the file
	 * (in memory, like its drafts). See `markdown_view_mode`.
	 */
	markdown_view_mode_choice: MarkdownViewMode | null = $state.raw(null);

	/**
	 * The id of a heading the markdown view reveals once it shows this file,
	 * then clears — set by following a link with a `#fragment` here from
	 * another file (`Diskfiles.open_path`).
	 */
	markdown_pending_fragment: string | null = $state.raw(null);

	#in_flight_save: InFlightSave | null = null;

	/** The follow-up save queued behind the in-flight write. */
	#queued_save: Promise<boolean> | null = null;

	// Basic derived states
	readonly original_content: string | null = $derived.by(() => this.diskfile.content);
	readonly path: DiskfilePath = $derived.by(() => this.diskfile.path);
	/**
	 * Whether the file's content is loaded (see `Diskfile.content_loaded`).
	 * While it isn't — still loading, or not loadable — the editor is
	 * read-only: edits are ignored and nothing can be saved, since a save
	 * would overwrite a file nobody has seen.
	 */
	readonly content_loaded: boolean = $derived(this.original_content !== null);
	/** The file's `Diskfile.content_status`. */
	readonly content_status: DiskfileContentStatus = $derived.by(() => this.diskfile.content_status);
	/**
	 * Whether the content is on its way (`unrequested` or `loading`) — read-only
	 * until it lands, which the views say apart from content that can't load.
	 */
	readonly content_loading: boolean = $derived(
		this.content_status === 'unrequested' || this.content_status === 'loading'
	);
	/**
	 * The mode the markdown view shows this file in: the user's choice, else
	 * `split`, or `preview` when the content can't be loaded (read-only).
	 */
	readonly markdown_view_mode: MarkdownViewMode = $derived(
		this.markdown_view_mode_choice ??
			to_default_markdown_view_mode(this.content_status !== 'unloadable')
	);
	readonly has_changes = $derived.by(() => {
		// an unloaded file has no baseline to differ from, and can't be edited
		if (this.original_content === null) return false;
		return this.current_content !== this.original_content;
	});
	/**
	 * Whether saving would write anything. Always true for a file deleted on
	 * disk — saving recreates it even when the content matches its last state
	 * — but not for an uncovered one (`Diskfile.uncovered`), which may still
	 * be on disk. Never true when the content wasn't loaded.
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
	/**
	 * Whether the views show the disk content rather than the user's
	 * (`shown_content`), read-only — asked for with `set_showing_disk` during
	 * a conflict, so the user can look at what's on disk without touching
	 * their edit. Only ever true while `has_conflict` holds and the file is
	 * on disk, so it ends when the conflict resolves, any way it resolves; it
	 * follows a newer disk change. Never changes what's saved or sent.
	 */
	readonly showing_disk: boolean = $derived.by(
		() => this.#show_disk && this.has_conflict && !this.diskfile.deleted_on_disk
	);
	/**
	 * The text the views display: `current_content`, or the disk content while
	 * `showing_disk`. Display only — saving and the conflict logic read
	 * `current_content`, a file part the draft.
	 */
	readonly shown_content: string = $derived(
		this.showing_disk ? (this.original_content ?? '') : this.current_content
	);
	/**
	 * Whether the editor takes edits: the content is loaded (`content_loaded`)
	 * and the views show the user's content, not the disk's (`showing_disk`).
	 * While false, setting `current_content` is ignored.
	 */
	readonly can_edit: boolean = $derived(this.content_loaded && !this.showing_disk);

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

	/**
	 * Applies an edit — see the class docs for how it lands in the history.
	 * Ignored while the editor is read-only (`can_edit`).
	 */
	set current_content(value: string) {
		if (!this.can_edit) return;
		// an edit lands only on the user's content, so a lapsed request to show the disk ends
		this.#show_disk = false;

		const shown = this.current_content;
		this.content_was_modified_by_user = value !== this.original_content;
		if (value !== shown) this.#apply_edit(value, shown);
	}

	constructor(options: { app: Frontend; diskfile: Diskfile }) {
		this.app = options.app;
		this.diskfile = options.diskfile;
		this.history = new DiskfileHistory({ app: this.app, json: { path: this.diskfile.path } });

		const { content, content_hash } = this.diskfile;
		if (content !== null) this.#seed(content, content_hash);
	}

	/**
	 * Takes the file's first loaded content as its original state — at
	 * construction, or when it lands later (see `check_disk_changes`).
	 */
	#seed(content: string, content_hash: string | null): void {
		this.last_seen_disk_content = content;
		this.last_seen_disk_hash = content_hash;
		this.selected_history_entry_id = this.history.add_entry(content, {
			is_original_state: true
		}).id;
	}

	/** Disposes the history. Called by `Diskfiles` when the diskfile goes away. */
	dispose(): void {
		this.#show_disk = false;
		this.history.dispose();
	}

	/**
	 * Shows the disk content in the views instead of the user's, or back —
	 * "show disk version" / "show your draft" on the conflict notice. Only
	 * takes effect during a conflict (see `showing_disk`); changes nothing
	 * else — the edit, the history, and what's saved stay as they are.
	 */
	set_showing_disk(showing: boolean): void {
		this.#show_disk = showing && this.has_conflict && !this.diskfile.deleted_on_disk;
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
	 * since last seen. `Diskfiles` calls it whenever new content lands, so
	 * the history tracks the disk whether or not an editor shows the file;
	 * calling it again is a no-op — a re-read of the same text changes nothing.
	 *
	 * The first content to land for a state made before the file loaded seeds
	 * the original state instead: it's the file as first seen, not a change
	 * on disk, so it never reads as a conflict.
	 *
	 * A clean editor moves to the new disk content. An editor showing the
	 * user's content keeps it, and the change becomes a `disk_conflict` —
	 * unless it's that very content (e.g. our own save's broadcast, landing
	 * after an external edit's), which settles the editor, or the content of
	 * the save in flight (our own write, with typing continuing past it).
	 */
	check_disk_changes(): void {
		const { content: disk_content, content_hash } = this.diskfile;
		if (disk_content === null) return;
		if (disk_content === this.last_seen_disk_content) {
			// the same text is the same bytes, so the same hash — taken when none
			// was known, for content seeded without a read
			this.last_seen_disk_hash ??= content_hash;
			return;
		}
		// never loaded until now (nothing can be edited before), so nothing to weigh it against
		if (this.last_seen_disk_content === null && this.history.entries.length === 0) {
			this.#seed(disk_content, content_hash);
			return;
		}
		this.last_seen_disk_content = disk_content;
		this.last_seen_disk_hash = content_hash;

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
			// a refused overwrite's error no longer holds — the disk has what it would have written
			if (this.save_error === SAVE_ERROR_CHANGED_AGAIN) this.save_error = null;
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
	 * change on disk arrives as metadata and the content follows by a read, so
	 * a save waits for a read of the file in flight or queued
	 * (`Diskfiles.pending_read`, `save_pending` meanwhile) and then decides as
	 * above, on the content it brought. If the file's last read failed
	 * (`content_error`) — the disk may hold a change it never brought — the
	 * save reads it once more and decides on that; a second failure refuses,
	 * with `save_error` saying the file couldn't be checked. An `overwrite`
	 * writes without that retry. A file whose content isn't loaded is never
	 * saved: this sets `save_error`.
	 *
	 * The backend checks as well, closing the window the frontend can't see —
	 * a write it hasn't been told of yet: the save carries the hash of the
	 * disk content it's based on (`last_seen_disk_hash`), and is refused,
	 * writing nothing, if the file no longer holds it. The file is then read
	 * again (`save_pending` meanwhile), so the change lands like any other —
	 * a conflict under the user's content, whose notice says why it wasn't
	 * saved. An `overwrite` is checked the same way, against the disk version
	 * the user was shown and chose to write over — taken when it's asked for,
	 * so a newer version whose read lands while the save waits for it is
	 * refused, not written over unseen, and the refusal says so in
	 * `save_error` (`SAVE_ERROR_CHANGED_AGAIN`). If the file's last read had
	 * failed (`content_error`) when it's asked for, there's no version the
	 * user can trust as shown, and the overwrite writes over whatever is
	 * there, even once a read lands meanwhile. A save of a file deleted on
	 * disk is an exclusive create, refused if anything is at the path — so a
	 * file something else recreated meanwhile is read, not replaced. An overwrite queued
	 * behind a save in flight takes its base when it runs, after that save:
	 * the base moves with what that save wrote, and so with any change
	 * recorded while it was in flight.
	 *
	 * @returns whether the content was written — for a queued follow-up with
	 * nothing left to write, whether the in-flight save succeeded, and for a
	 * save refused because the disk moved on, whether the disk now holds what
	 * it would have written
	 */
	save_changes(options?: DiskfileSaveOptions): Promise<boolean> {
		// an overwrite is of the version shown now, whatever lands while it waits
		const overwrite_base: OverwriteBase | null = options?.overwrite
			? { hash: this.#save_base(options) }
			: null;
		return this.#save_changes(options, overwrite_base);
	}

	/**
	 * `save_changes`, with an overwrite's base taken when it was asked for
	 * (`null` when it isn't an overwrite, or for a queued follow-up, which
	 * takes its own).
	 */
	#save_changes(
		options: DiskfileSaveOptions | undefined,
		overwrite_base: OverwriteBase | null
	): Promise<boolean> {
		// choosing to overwrite shows the content being written
		if (options?.overwrite) this.#show_disk = false;
		// never write over a file whose content isn't loaded
		// (`Diskfiles.update` refuses it too)
		if (!this.content_loaded) {
			this.save_error = `not saved — ${to_diskfile_unloaded_message(this.diskfile)}`;
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
		// a change on disk was reported and its content is still on the way, or
		// the last read failed — decide once it's checked, so a save can't write
		// over a change it hasn't seen
		const pending_read = this.app.diskfiles.pending_read(this.diskfile);
		if (pending_read || this.#must_check_failed_read(options)) {
			return this.#save_after_read(pending_read, options, overwrite_base);
		}
		if (!this.can_save) return Promise.resolve(false);
		if (this.has_conflict && !options?.overwrite) return Promise.resolve(false);

		// registered before the write starts — a write that throws synchronously
		// settles `#save` before it returns, and its cleanup must find the entry
		const in_flight_save: InFlightSave = {
			content: this.current_content,
			overwrite: !!options?.overwrite,
			create: this.diskfile.deleted_on_disk,
			expected_hash: overwrite_base ? overwrite_base.hash : this.#save_base(options),
			saving: Promise.resolve(false)
		};
		this.#in_flight_save = in_flight_save;
		in_flight_save.saving = this.#save(in_flight_save);
		return in_flight_save.saving;
	}

	/**
	 * The hash a save sends as its base (`InFlightSave.expected_hash`): the
	 * last disk content seen — what `has_conflict` weighs the edit against,
	 * and what a conflict shows — even for an `overwrite`, which chose to
	 * write over that version and no newer one — an uncovered file's
	 * (`Diskfile.uncovered`) included, since it may still be on disk. `null`
	 * for a file deleted on disk, whose save is an exclusive create instead
	 * (`InFlightSave.create`), and for an `overwrite` after a failed read
	 * (`content_error`), which writes over whatever is there: the version
	 * shown may not be what's on disk, and forcing the write is the user's
	 * way out.
	 */
	#save_base(options: DiskfileSaveOptions | undefined): string | null {
		if (this.diskfile.deleted_on_disk) return null;
		if (options?.overwrite && this.diskfile.content_error !== null) return null;
		return this.last_seen_disk_hash;
	}

	/**
	 * Whether the file's last read failed (`content_error`) with the old
	 * content kept, so the disk may hold a change that never arrived — a save
	 * checks first, unless it's an `overwrite` or the file is deleted on disk
	 * (writing recreates it, over nothing).
	 */
	#must_check_failed_read(options: DiskfileSaveOptions | undefined): boolean {
		return (
			this.diskfile.content_error !== null && !options?.overwrite && !this.diskfile.deleted_on_disk
		);
	}

	/**
	 * Waits for `pending_read`, then — unless `overwrite` — retries a failed
	 * read once (`Diskfiles.read_again`), then decides again from the top
	 * (`save_changes`). Bounded per call, not per file: a retry that fails too
	 * refuses rather than retrying again (a second save made during the wait
	 * makes its own one retry), and only a newer change reported meanwhile
	 * makes the re-run wait again.
	 */
	async #save_after_read(
		pending_read: Promise<void> | null,
		options: DiskfileSaveOptions | undefined,
		overwrite_base: OverwriteBase | null
	): Promise<boolean> {
		this.#save_waits++;
		try {
			if (pending_read) await pending_read;
			if (this.#must_check_failed_read(options)) {
				// a save is an explicit ask, so the failed read gets one more try
				await this.app.diskfiles.read_again(this.diskfile);
				const error = this.diskfile.content_error;
				if (error !== null) {
					this.save_error = this.#is_read_missing()
						? this.#settle_missing()
						: `not saved — couldn't check the file on disk: ${error}`;
					return false;
				}
			}
		} finally {
			this.#save_waits--;
		}
		return this.#save_changes(options, overwrite_base);
	}

	/**
	 * Whether the file's last read failed because it's gone from disk — its
	 * delete not reported yet. Read from the error's reason, not its message.
	 */
	#is_read_missing(): boolean {
		return this.diskfile.content_error_reason === ERROR_PATH_NOT_FOUND;
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
		// refused because the disk isn't what the save assumed: changed under
		// an update, or there after all under a create
		let refused = false;
		let written_hash: string | null = null;
		try {
			if (in_flight_save.create) {
				const result = await this.app.diskfiles.create_exclusive(diskfile.path, content_to_save);
				if (!result.ok) {
					error_message = result.error.message;
					const { reason } = (result.error.data ?? {}) as { reason?: unknown };
					refused = reason === ERROR_ALREADY_EXISTS;
				}
			} else {
				const result = await this.app.diskfiles.update(
					diskfile.path,
					content_to_save,
					in_flight_save.expected_hash
				);
				if (result.ok) {
					written_hash = result.value.hash;
				} else {
					error_message = result.error.message;
					const { reason } = (result.error.data ?? {}) as { reason?: unknown };
					refused = reason === ERROR_DISK_CHANGED;
				}
			}
		} catch (error) {
			console.error('[DiskfileEditorState] save threw:', error);
			error_message = to_error_message(error, 'save failed');
		} finally {
			this.saving = false;
			if (this.#in_flight_save === in_flight_save) this.#in_flight_save = null;
		}

		if (refused) return this.#follow_refused_save(in_flight_save);
		if (error_message !== null) {
			this.save_error = error_message;
			return false;
		}
		this.save_error = null;
		// the write recreated a file deleted on disk — it's no longer held for a
		// draft or a tab, even before the `add` broadcast arrives (or out of the
		// index, if none will)
		if (in_flight_save.create) this.app.diskfiles.settle_recreated(diskfile);

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
			history.entries.some((entry) => is_saved_state(entry) && entry.content === content_to_save)
				? null
				: history.add_entry(content_to_save, {
						is_unsaved_edit: false,
						created: started,
						keep_id: this.selected_history_entry_id
					});

		if (!disk_moved_on) {
			this.last_seen_disk_content = content_to_save;
			this.last_seen_disk_hash = written_hash;
			// the disk holds what was saved, so nothing edited predates it
			this.disk_conflict = false;
		}

		if (settled && saved_entry) {
			this.content_was_modified_by_user = false;
			this.selected_history_entry_id = saved_entry.id;
		}

		// a create answers no hash, so the file is read back for the base the
		// next save sends — a save meanwhile waits on the read (`pending_read`)
		if (in_flight_save.create) void this.app.diskfiles.read_again(diskfile);

		return true;
	}

	/**
	 * Follows a save the backend refused because the disk isn't what it
	 * assumed — nothing was written, and the edit is left as it is: an update
	 * whose file no longer holds the content it was based on (`disk_changed`),
	 * or a create of a file deleted on disk that's there after all, or there
	 * again (`already_exists`). That one is on disk but out of the index as
	 * far as anything here knows, so it's flagged `uncovered` — later saves
	 * update it, checked against what's read now. Reads the file again
	 * (`Diskfiles.read_again`, `save_pending` meanwhile), so the change lands
	 * like any other: a conflict under the user's content, whose notice then
	 * says why (no `save_error`), or the editor settling if the disk now holds
	 * what was being saved.
	 *
	 * A refused `overwrite` sets `save_error` even then: the user asked to
	 * write, and the conflict's notice alone would read as if nothing happened.
	 *
	 * @returns whether the disk now holds what the save would have written
	 */
	async #follow_refused_save(refused: InFlightSave): Promise<boolean> {
		const { diskfile } = this;
		const content_to_save = refused.content;
		if (refused.create && diskfile.deleted_on_disk) {
			// in an unfocused repo this flags it `uncovered` where `#release`
			// would leave it unflagged — harmless, a refocus snapshot clears it
			this.app.diskfiles.set_deleted_on_disk(diskfile, false);
			this.app.diskfiles.set_uncovered(diskfile, true);
		}
		this.#save_waits++;
		try {
			await this.app.diskfiles.read_again(diskfile);
		} finally {
			this.#save_waits--;
		}
		if (diskfile.deleted_on_disk) {
			this.save_error = SAVE_ERROR_RECREATES;
			return false;
		}
		if (diskfile.content_error !== null) {
			this.save_error = this.#is_read_missing()
				? this.#settle_missing()
				: `not saved — the file changed on disk, and reading it again failed: ${diskfile.content_error}`;
			return false;
		}
		if (diskfile.content === null) {
			this.save_error = `not saved — ${to_diskfile_unloaded_message(diskfile)}`;
			return false;
		}
		if (diskfile.content === content_to_save) return true;
		if (this.has_conflict) {
			this.save_error = refused.overwrite ? SAVE_ERROR_CHANGED_AGAIN : null;
		} else if (refused.create) {
			this.save_error = 'not saved — the file is on disk again, shown now';
		} else {
			this.save_error = 'not saved — the file changed on disk while saving; save again';
		}
		return false;
	}

	/**
	 * The `save_error` for a save whose read found the file gone
	 * (`#is_read_missing`). A file in the index is left as it is — its delete
	 * is on the way. An uncovered one (`Diskfile.uncovered`) gets no delete
	 * from anywhere, nor does one held in an unfocused repo
	 * (`Diskfiles.is_in_unfocused_repo`, kept unflagged), so either is
	 * flagged `deleted_on_disk` here, and saving again recreates it —
	 * exclusively, so that's safe even if it reappears first.
	 */
	#settle_missing(): string {
		if (!this.diskfile.uncovered && !this.app.diskfiles.is_in_unfocused_repo(this.diskfile.path)) {
			return SAVE_ERROR_DELETED_ON_DISK;
		}
		this.app.diskfiles.set_deleted_on_disk(this.diskfile, true);
		return SAVE_ERROR_RECREATES;
	}

	/**
	 * Drops the edit in favor of the disk — "keep the disk version" on a conflict,
	 * "don't save" on closing a tab: shows the disk content, setting the draft
	 * aside as a discarded-edit entry so its text stays in the history (until
	 * the history caps or a clear drop it). A file deleted on disk or uncovered,
	 * kept for the draft with no tab, is then forgotten (`Diskfiles.release_if_unneeded`),
	 * disposing this state.
	 */
	discard_draft(): void {
		const draft = this.history.draft_entry;
		if (draft) this.#set_aside_draft(draft);
		this.#select_disk_entry();
		this.content_was_modified_by_user = false;
		this.disk_conflict = false;
		this.save_error = null;
		this.app.diskfiles.release_if_unneeded(this.diskfile.path);
	}

	/**
	 * Resets what the editor shows when the file's last tab closes, so reopening
	 * it shows the draft if there is one, else the disk content.
	 */
	reset_view(): void {
		this.#show_disk = false;
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
	 * Shows history entry `id` in the editor, ending any `showing_disk`.
	 * Picking an entry changes nothing else — editing it is what starts a draft.
	 */
	set_content_from_history(id: Uuid): void {
		const entry = this.history.find_entry_by_id(id);
		if (!entry) return;
		this.#show_disk = false;
		this.selected_history_entry_id = id;
		this.content_was_modified_by_user = entry.content !== this.original_content;
		this.#clear_conflict_if_settled();
	}

	/**
	 * Clears the history down to the unsaved edits and the entry for the disk
	 * content — the newest saved entry holding it, else a new one, never an
	 * older state that would show as a change to save — which becomes the
	 * original state. A selection it removes moves to that entry. For a file
	 * whose content wasn't loaded, the newest saved entry is kept instead.
	 */
	clear_history(): void {
		const { history } = this;
		if (history.entries.length <= 1) return;

		const disk_content = this.original_content;
		const saved = history.entries.filter(is_saved_state);
		const disk_entry =
			saved.find((entry) => entry.content === disk_content) ??
			(disk_content === null
				? (saved[0] ?? null)
				: history.add_entry(disk_content, { is_original_state: true }));
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
		this.app.diskfiles.release_if_unneeded(this.diskfile.path);
	}
}
