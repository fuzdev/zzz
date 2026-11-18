import {
	array,
	parse_or_throw,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { DEV } from 'esm-env';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { jsonrpc_error_messages } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Datetime } from './datetime.ts';
import { Diskfile } from './diskfile.svelte.ts';
import {
	DiskfileJson,
	DiskfilePath,
	type DiskfileDirectoryPath,
	type DiskfileJsonInput,
	type SerializableDisknode
} from './diskfile_types.ts';
import {
	DISKFILE_CONTENT_NOT_LOADED_MESSAGE,
	ERROR_ALREADY_EXISTS,
	ERROR_CONTENT_NOT_LOADED,
	disknode_to_diskfile_json,
	normalize_path,
	parse_new_diskfile_name,
	to_diskfile_unloaded_message,
	to_innermost_unindexed_part,
	to_file_directories,
	to_innermost_root,
	to_relative_path,
	type FileIndexUnindexedPart
} from './diskfile_helpers.ts';
import { to_diskfile_content_kind } from './diskfile_content_kind.ts';
import type { MarkdownLinkIndex } from './markdown_links.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { DiskfilesEditor } from './diskfiles_editor.svelte.ts';
import { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
import { Drafts } from './drafts.svelte.ts';
import type { MarkdownViewMode } from './markdown_view_mode.ts';
import { create_detached } from './reactive_helpers.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { DiskfileIndex } from './diskfile_index.svelte.ts';
import type { ActionInputs, ActionOutputs } from './action_collections.ts';
import { TaskQueue } from './task_queue.ts';
import { find_transcript_candidate_paths } from './transcript_helpers.ts';

/**
 * How many `diskfile_read` requests `Diskfiles` keeps in flight — reads
 * beyond it wait in a queue, the shown files first (JSON-RPC batches aren't
 * supported, so each read is its own request).
 */
export const DISKFILE_READ_CONCURRENCY = 4;

/** A content read in flight — see `Diskfiles.ensure_content`. */
interface ContentLoad {
	promise: Promise<void>;
	/** The file changed on disk while the read was in flight, so it reads again. */
	stale: boolean;
}

/**
 * What `Diskfiles` takes from a `diskfile_read`: its output, or why it failed
 * — the message, and the error's `data.reason` when it has one.
 */
type ContentReadResult =
	| { ok: true; value: ActionOutputs['diskfile_read'] }
	| { ok: false; message: string; reason: string | null };

export const DiskfilesJson = cell_json_schema(
	{
		diskfiles: with_default_fn(array(DiskfileJson), () => [])
	},
	'Diskfiles'
);
export type DiskfilesJson = Infer<typeof DiskfilesJson>;
export type DiskfilesJsonInput = InferInput<typeof DiskfilesJson>;

export interface DiskfilesOptions extends CellOptions<typeof DiskfilesJson> {}

/**
 * What `filer_change` reported while a file-tree snapshot was in flight —
 * see `Diskfiles.track_changes` for how a snapshot is applied around it.
 */
export interface DiskfileSnapshotChanges {
	/** Paths a `filer_change` reported. The snapshot's entries for them are skipped. */
	readonly paths: ReadonlySet<string>;
}

/** Records what `filer_change` reports while a file-tree snapshot is in flight. */
export interface DiskfileChangeTracker extends DiskfileSnapshotChanges {
	/** Stops recording. */
	stop: () => void;
}

export class Diskfiles extends Cell<typeof DiskfilesJson> {
	// TODO bound memory across files: a file with something to keep
	// (`DiskfileEditorState.can_drop`) keeps its state and history (each capped)
	// until the diskfile goes away — maybe an app-wide history budget
	/** The files' app-level editing states, by path — see `get_editor_state`. */
	readonly #editor_states: SvelteMap<DiskfilePath, DiskfileEditorState> = new SvelteMap();

	/**
	 * The files' drafts, by path — apart from the cells, so a draft can
	 * outlive its file's cell and editing state (for now a dirty editing
	 * state keeps both, `DiskfileEditorState.can_drop`). A draft keeps a file
	 * the index no longer has (`#is_held`).
	 */
	readonly drafts: Drafts = new Drafts(this);

	/**
	 * The markdown view mode chosen per file
	 * (`DiskfileEditorState.markdown_view_mode_choice`), by path — apart from
	 * the editing states, which are dropped when clean, so a choice lasts for
	 * the page. Page memory only.
	 */
	readonly markdown_view_modes: SvelteMap<DiskfilePath, MarkdownViewMode> = new SvelteMap();

	/**
	 * Keeps `mode` as the markdown view's mode for the file at `path`
	 * (`markdown_view_modes`), with or without a cell or editing state for it.
	 *
	 * @returns whether `path` is a markdown file — any other keeps nothing
	 */
	set_markdown_view_mode(path: DiskfilePath, mode: MarkdownViewMode): boolean {
		if (to_diskfile_content_kind(path) !== 'markdown') return false;
		this.markdown_view_modes.set(path, mode);
		return true;
	}

	/**
	 * The metadata of every file on disk the index reports — the source of
	 * truth for what's on disk here. A file has a cell (`cells`) only while
	 * something needs one; the cells kept after leaving the index
	 * (`deleted_on_disk`, `uncovered`) are the only ones not in it.
	 */
	readonly index: DiskfileIndex = new DiskfileIndex();

	/**
	 * The cells, by path — made only for a path something needs: held
	 * (`acquire` — a tab, a part, a view, a copy), with an editing state, or
	 * kept off the index for a draft or a tab. A path is its disk identity:
	 * `upsert` updates its cell in place, and a rename arrives as a delete
	 * plus an add.
	 */
	readonly #cells: SvelteMap<DiskfilePath, Diskfile> = new SvelteMap();

	/** The cells, by path — see `#cells`. Reactive. */
	get cells(): ReadonlyMap<DiskfilePath, Diskfile> {
		return this.#cells;
	}

	/**
	 * The selected file's path: the editor's selected tab's, so there's one
	 * selection — the selection follows the path, not a particular cell.
	 */
	readonly selected_path: DiskfilePath | null = $derived.by(() => this.editor.tabs.selected_path);

	readonly selected_file: Diskfile | null = $derived(
		this.selected_path ? (this.peek(this.selected_path) ?? null) : null
	);

	/**
	 * The records of the files on disk, as the index reports them — not the
	 * ones kept for a draft or a tab after a delete (`deleted_on_disk`) or
	 * after leaving the index (`uncovered`), so pickers offer only indexed
	 * files. Tracks the index's `membership` alone, so a change in place
	 * (size or times) doesn't rebuild it, or re-sort a list over it: each
	 * record's `id` is current, but its other fields may be stale, since the
	 * index replaces a changed record. A sorter that reads them reads the
	 * live record (`index.get`, untracked) and tracks `index.meta` itself
	 * (`Sorter.track`). A count is `index.size`.
	 */
	readonly on_disk: Array<SerializableDisknode> = $derived.by(() => {
		if (this.index.size === 0) return []; // tracks `membership`
		return untrack(() => Array.from(this.index.values()));
	});

	/**
	 * The files the explorer lists: the records on disk, plus a record for
	 * each file deleted on disk (`remove_by_path`) or uncovered
	 * (`release_uncovered`) but kept for a draft or a tab
	 * (`listed_unindexed`), so each stays reachable. A kept file's record is
	 * made from its cell, which keeps no `ctime`.
	 */
	readonly listed: Array<SerializableDisknode> = $derived.by(() => {
		const listed = this.on_disk.slice();
		for (const diskfile of this.listed_unindexed) listed.push(diskfile_to_disknode(diskfile));
		return listed;
	});

	/**
	 * Whether any file has a draft or is `dirty` (see
	 * `DiskfileEditorState.dirty`: its editor shows other content than the
	 * disk's) — edits that live only in memory, lost on a reload.
	 */
	readonly has_unsaved_changes: boolean = $derived.by(() => {
		if (this.drafts.size) return true;
		for (const editor_state of this.#editor_states.values()) {
			if (editor_state.dirty) return true;
		}
		return false;
	});

	/** The editor for managing diskfiles editing state. */
	readonly editor: DiskfilesEditor;

	constructor(options: DiskfilesOptions) {
		super(DiskfilesJson, options);

		this.editor = new DiskfilesEditor({ app: this.app });

		this.decoders = {
			diskfiles: create_collection_decoder(
				() => this.#write(() => this.#clear()),
				(json) => this.add(json)
			)
		};

		this.init();
	}

	// not reactive — bookkeeping for snapshot requests in flight
	readonly #change_trackers: Set<{ paths: Set<string> }> = new Set();

	/**
	 * Starts recording the paths `handle_change` is given. Start it before
	 * requesting a file-tree snapshot and pass it to `add_initial` or
	 * `reconcile` with the snapshot, which is then applied around what
	 * `filer_change` reported while the request was in flight: a reported
	 * path keeps what the notification left — the snapshot's entry for it is
	 * skipped, and it isn't pruned — so a file deleted meanwhile isn't
	 * resurrected and newer metadata isn't reverted.
	 *
	 * The two can't be ordered from here — a notification that arrives during
	 * the request may have been sent before or after the backend read its
	 * index for the snapshot — but the backend queues a notification for every
	 * change to its index, so its notifications converge on the index: if the
	 * snapshot was the newer of the two, whatever moved the file past the
	 * notification has its own notification still to come, and that one
	 * settles it.
	 */
	track_changes(): DiskfileChangeTracker {
		const tracker = { paths: new Set<string>() };
		this.#change_trackers.add(tracker);
		return {
			paths: tracker.paths,
			stop: () => this.#change_trackers.delete(tracker)
		};
	}

	/**
	 * Applies a `filer_change` notification. `add` and `change` both upsert by
	 * path — the backend's add/change split is advisory, and a re-seed or a
	 * missed delete must never leave two diskfiles for one path.
	 */
	handle_change(params: ActionInputs['filer_change']): void {
		const { disknode } = params;
		for (const tracker of this.#change_trackers) tracker.paths.add(disknode.id);
		if (params.change.type === 'delete') {
			this.remove_by_path(disknode.id);
		} else {
			this.upsert(disknode);
		}
	}

	/**
	 * Adds a diskfile from its json — its content included — with a cell
	 * kept until something holds its path and lets go (`release`, which
	 * settles it), for seeding a test or decoding. A path that has a cell already
	 * keeps it, and gets that one back. It isn't selected: a file appearing
	 * on disk never moves the selection or opens a tab — only `create_file`
	 * selects the file it creates.
	 */
	add(json: DiskfileJsonInput): Diskfile {
		const diskfile = new Diskfile({ app: this.app, json });
		const existing = untrack(() => this.peek(diskfile.path));
		if (existing) {
			if (DEV) console.error(`a diskfile is already at ${diskfile.path}`);
			diskfile.dispose();
			return existing;
		}
		this.#write(() => this.#add_cell(diskfile));
		this.#arrived(diskfile.path);
		return diskfile;
	}

	/** Puts `diskfile` in `cells` and brings the index in step (`#sync_index`). */
	#add_cell(diskfile: Diskfile, disknode?: SerializableDisknode): void {
		this.#cells.set(diskfile.path, diskfile);
		this.#sync_index(diskfile, disknode);
	}

	/**
	 * Takes `diskfile` out of `cells` and disposes it with its editing state,
	 * bringing the index in step: a file kept off the index leaves no record,
	 * and one on disk keeps its record — dropping an idle cell
	 * (`#settle`) forgets nothing. Only the cell at its path.
	 */
	#remove_cell(diskfile: Diskfile, keep_record: boolean): void {
		const { path } = diskfile;
		if (this.#cells.get(path) !== diskfile) return;
		this.#cells.delete(path);
		this.#unindexed_files.delete(diskfile.id);
		if (!keep_record) this.index.delete(path);
		this.#remove_editor_state(diskfile);
		diskfile.dispose();
	}

	/** Drops every cell, record, draft, and view-mode choice. */
	#clear(): void {
		this.drafts.clear();
		this.markdown_view_modes.clear();
		for (const diskfile of Array.from(this.#cells.values())) this.#remove_cell(diskfile, false);
		for (const record of Array.from(this.index.values())) this.index.delete(record.id);
	}

	/**
	 * Makes the cell for `path` from its index record, when it has one and no
	 * cell — untracked and detached, so a `$derived` or a component's init
	 * can cause it (`acquire`) without writing what it reads or freezing the
	 * cell's deriveds when it unmounts.
	 */
	#materialize(path: DiskfilePath): Diskfile | undefined {
		return untrack(() => {
			const existing = this.#cells.get(path);
			if (existing) return existing;
			const record = this.index.get(path);
			if (!record) return undefined;
			return create_detached(() => {
				const diskfile = new Diskfile({ app: this.app, json: disknode_to_diskfile_json(record) });
				this.#write(() => this.#add_cell(diskfile, record));
				return diskfile;
			});
		});
	}

	/** Selects a file `create_file` created as it arrives — see `#select_on_arrival`. */
	#arrived(path: DiskfilePath): void {
		if (path !== this.#select_on_arrival) return;
		this.#select_on_arrival = null;
		this.select(path, true);
		this.editor.tree.reveal_created(path);
	}

	/**
	 * The file `create_file` created whose `filer_change` hasn't arrived yet,
	 * selected and revealed in the tree when it does. Not reactive. Dropped
	 * when it's selected, when the user selects anything else (`select`, or a
	 * tab change through `DiskfilesEditor` — `drop_pending_selection`), when its
	 * project is removed (`handle_project_removed`), or by the next
	 * `create_file` — so a file the filer never reports (say under
	 * `node_modules/`) can't take the selection
	 * later.
	 */
	#select_on_arrival: DiskfilePath | null = null;

	/**
	 * The app-level editing state of `diskfile` (its history and save state,
	 * over its draft in `drafts`), created on first use and kept until
	 * nothing holds the file and it has nothing to keep
	 * (`DiskfileEditorState.can_drop`, see `#settle`) or the diskfile is
	 * removed — views read it, they don't own it. Safe to call from component init or a
	 * `$derived`: it's created detached from the calling effect, and reading it
	 * doesn't track the lookup. A diskfile no longer in `cells` gets a
	 * throwaway state.
	 */
	get_editor_state(diskfile: Diskfile): DiskfileEditorState {
		const existing = untrack(() => this.#editor_states.get(diskfile.path));
		// a stale `diskfile` (gone from `cells`) never gets the live cell's state
		if (existing?.diskfile === diskfile) return existing;
		return create_detached(() => {
			const throwaway = this.peek(diskfile.path) !== diskfile;
			const editor_state = new DiskfileEditorState({ app: this.app, diskfile, throwaway });
			if (!throwaway) {
				this.#editor_states.set(diskfile.path, editor_state);
			} else {
				// unmanaged, so nothing would dispose it — keep it out of the cell registry
				editor_state.dispose();
			}
			return editor_state;
		});
	}

	/** The editing state of the file at `path` if one was created — see `get_editor_state`. */
	find_editor_state(path: DiskfilePath): DiskfileEditorState | undefined {
		return this.#editor_states.get(path);
	}

	/** Disposes `diskfile`'s editing state — only its own, never another cell's at the same path. */
	#remove_editor_state(diskfile: Diskfile): void {
		const editor_state = this.#editor_states.get(diskfile.path);
		if (editor_state?.diskfile !== diskfile) return;
		this.#editor_states.delete(diskfile.path);
		editor_state.dispose();
	}

	/**
	 * Adds a diskfile for `disknode`, or updates the existing one at the same
	 * path in place — keeping the cell, with its content and editing state.
	 * A diskfile kept after a delete (see `remove_by_path`) is reattached this
	 * way when its path reappears on disk, and one kept uncovered
	 * (`release_uncovered`) when the index reports it again.
	 *
	 * A disknode carries metadata only — contents come from `diskfile_read`
	 * alone — so for a diskfile already held its content may be out of date:
	 * a file held eagerly — with an editing state or a holder (`acquire`: a
	 * tab, a `DiskfilePart`, a view, a copy) — is read again, keeping its content until the new one
	 * lands, and any other drops its content to `unrequested`, to be read when
	 * next needed (`ensure_content`). A read in flight reads again instead. A
	 * read that lands on the same text changes nothing
	 * (`DiskfileEditorState.check_disk_changes`), so a resync that re-sends
	 * every file, or a `touch`, raises no conflict. A new file gets a cell
	 * only if something holds its path (`acquire`), starting `unrequested`
	 * and read right away; any other is only its record.
	 *
	 * @returns the cell at the path, `undefined` when there's none
	 */
	upsert(disknode: SerializableDisknode): Diskfile | undefined {
		const path = disknode.id;
		const existing = untrack(() => this.#cells.get(path));
		if (!existing) {
			this.#write(() => this.index.set(disknode));
			// only a path something holds gets a cell — every other file is its record
			const diskfile = this.#holders.has(path) ? this.#materialize(path) : undefined;
			if (diskfile && this.#is_held_eagerly(diskfile)) void this.#start_load(diskfile);
			this.#arrived(path);
			return diskfile;
		}
		existing.deleted_on_disk = false;
		existing.uncovered = false;
		if (existing.source_dir !== disknode.source_dir) existing.source_dir = disknode.source_dir;
		if (existing.size !== disknode.size) existing.size = disknode.size;
		if (existing.mtime !== disknode.mtime) {
			existing.mtime = disknode.mtime;
			// as a new file's is (`disknode_to_diskfile_json`)
			if (disknode.mtime !== null) {
				existing.updated = parse_or_throw(Datetime, new Date(disknode.mtime).toISOString());
			}
		}
		// back on disk, and its root may have changed with a snapshot from another filer
		this.#write(() => this.#sync_index(existing, disknode));
		this.#follow_disk_change(existing);
		return existing;
	}

	/**
	 * Follows a change on disk (see `upsert`): a read in flight reads again, a
	 * file held eagerly is read, and any other held content is dropped.
	 */
	#follow_disk_change(diskfile: Diskfile): void {
		const load = this.#loads.get(diskfile.id);
		if (load) {
			load.stale = true;
			return;
		}
		if (this.#is_held_eagerly(diskfile)) {
			void this.#start_load(diskfile);
			return;
		}
		if (diskfile.content_status === 'loaded' || diskfile.content_status === 'unloadable') {
			diskfile.unloaded_status = 'unrequested';
			diskfile.unloaded_reason = null;
			diskfile.content_error = null;
			diskfile.content_error_reason = null;
			diskfile.content = null;
			diskfile.content_hash = null;
		}
	}

	/**
	 * Whether `diskfile`'s content is kept current as it changes on disk: it
	 * has an editing state (an editor shows it, or did — conflicts are caught
	 * against it) or a holder (`acquire`: a tab, a `DiskfilePart` — prompts
	 * and turns read it — a view, a copy in flight). Other files load on
	 * demand and drop their content on a change. Wider than `#is_held`, since
	 * only a draft or a tab keeps a file the index no longer has.
	 */
	#is_held_eagerly(diskfile: Diskfile): boolean {
		return (
			this.#holders.has(diskfile.path) || untrack(() => this.#editor_states.has(diskfile.path))
		);
	}

	/** Content reads in flight, by diskfile id — see `ensure_content`. Not reactive. */
	readonly #loads: Map<Uuid, ContentLoad> = new Map();

	readonly #read_queue: TaskQueue = new TaskQueue(DISKFILE_READ_CONCURRENCY);

	/** What holds each path's cell — see `acquire`. Not reactive. */
	readonly #holders: Map<DiskfilePath, Set<object>> = new Map();

	/** Paths whose last holder let go, settled in a microtask — see `release`. Not reactive. */
	readonly #releasing: Set<DiskfilePath> = new Set();

	/**
	 * Loads `diskfile`'s content (`diskfile_read`) unless it's settled —
	 * `loaded`, or `unloadable` — and resolves once it is. Single-flight:
	 * callers share the read in flight, which reads again when the file
	 * changes on disk meanwhile, resolving with the newer content. Reads are
	 * queued, at most `DISKFILE_READ_CONCURRENCY` at once, the selected
	 * file's first, then those open in tabs. Never rejects: a failed read
	 * settles the file with `content_error`.
	 *
	 * Writes state when it starts a read, so call it from an event handler,
	 * an `$effect`, or async code — not a `$derived` or a template expression.
	 */
	ensure_content(diskfile: Diskfile): Promise<void> {
		// read first, so an `$effect` calling this keeps tracking the status
		// while a read is in flight — and asks again once it drops to `unrequested`
		const status = diskfile.content_status;
		const load = this.#loads.get(diskfile.id);
		if (load) return load.promise;
		// a file deleted on disk keeps what it had, and one gone from `cells`
		// has nothing to read — reading it would only loop
		if (status === 'loaded' || status === 'unloadable' || !this.#is_live(diskfile)) {
			return Promise.resolve();
		}
		return this.#start_load(diskfile);
	}

	/**
	 * The read of `diskfile`'s content in flight or queued, `null` when there's
	 * none. It resolves once the reading stops: a read landed with no change on
	 * disk reported meanwhile, the last read failed (`content_error`), or the
	 * file went away — it never rejects (see `ensure_content`). Starts nothing:
	 * a save waits on it so it never writes before a change it was told of is
	 * checked (`DiskfileEditorState.save_changes`).
	 */
	pending_read(diskfile: Diskfile): Promise<void> | null {
		return this.#loads.get(diskfile.id)?.promise ?? null;
	}

	/**
	 * Reads `diskfile`'s content again even when it counts as settled
	 * (`loaded`, or `unloadable` after a failed read), joining a read in
	 * flight — for an explicit ask that can't trust what's held, such as a save
	 * after a re-read failed (`content_error` with the old content kept). The
	 * status doesn't change while it reads: only an `unrequested` file shows
	 * `loading`. A file deleted on disk or gone from `cells` isn't
	 * read. Never rejects: a failed read sets `content_error` again.
	 */
	read_again(diskfile: Diskfile): Promise<void> {
		const load = this.#loads.get(diskfile.id);
		if (load) return load.promise;
		if (!this.#is_live(diskfile)) return Promise.resolve();
		return this.#start_load(diskfile);
	}

	/**
	 * Loads `diskfile`'s content (`ensure_content`) and returns it — for what
	 * copies it, which shows why when it can't. Unlike `ensure_content`, it
	 * rejects rather than leave the caller to read the status, and it retries
	 * a read that failed (`content_error`): it's an explicit ask, where
	 * `ensure_content` runs in effects that would loop on a failure.
	 *
	 * @throws Error saying why the content can't be loaded
	 */
	async load_content(diskfile: Diskfile): Promise<string> {
		// held while it reads, as a copy in flight
		const holder = {};
		this.acquire(diskfile.path, holder);
		try {
			return await this.#load_content(diskfile);
		} finally {
			this.release(diskfile.path, holder);
		}
	}

	async #load_content(diskfile: Diskfile): Promise<string> {
		if (
			diskfile.content_status === 'unloadable' &&
			diskfile.content_error !== null &&
			this.#is_live(diskfile)
		) {
			// synchronous through `ensure_content` starting the read or joining the
			// one in flight, so an effect rerunning on this shares that read
			diskfile.content_error = null;
			diskfile.content_error_reason = null;
			diskfile.unloaded_reason = null;
			diskfile.unloaded_status = 'unrequested';
		}
		await this.ensure_content(diskfile);
		const { content } = diskfile;
		if (content === null) {
			throw new Error(
				diskfile.content_status === 'unloadable'
					? (to_diskfile_unloaded_message(diskfile) ?? DISKFILE_CONTENT_NOT_LOADED_MESSAGE)
					: 'content not loaded — the file is gone'
			);
		}
		return content;
	}

	#start_load(diskfile: Diskfile): Promise<void> {
		if (diskfile.content_status === 'unrequested') diskfile.unloaded_status = 'loading';
		const load: ContentLoad = { promise: Promise.resolve(), stale: false };
		this.#loads.set(diskfile.id, load);
		load.promise = this.#run_load(diskfile, load);
		return load.promise;
	}

	/**
	 * Reads until a read lands with no change on disk reported meanwhile.
	 * Each result is applied as it lands — so a file written more often than
	 * a read takes still shows its content; a failure is applied only when
	 * it's the last read.
	 */
	async #run_load(diskfile: Diskfile, load: ContentLoad): Promise<void> {
		try {
			do {
				const result = await this.#read_queue.run(
					() => {
						// reset as the read starts, not while it waits for a slot — a change
						// reported while it waits is one this read already sees
						load.stale = false;
						return this.#read(diskfile.path);
					},
					() => this.#read_priority(diskfile)
				);
				if (result.ok || !load.stale) this.#apply_read(diskfile, result);
			} while (load.stale && this.#is_live(diskfile));
		} finally {
			if (this.#loads.get(diskfile.id) === load) this.#loads.delete(diskfile.id);
			// stopped for a file deleted meanwhile, maybe with its last result skipped
			if (!this.#is_live(diskfile) && diskfile.unloaded_status === 'loading') {
				diskfile.unloaded_status = 'unrequested';
			}
		}
	}

	async #read(path: DiskfilePath): Promise<ContentReadResult> {
		try {
			const result = await this.app.api.diskfile_read({ path });
			if (result.ok) return result;
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			return {
				ok: false,
				message: result.error.message,
				reason: typeof reason === 'string' ? reason : null
			};
		} catch (error) {
			return {
				ok: false,
				message: to_error_message(error, 'read failed'),
				reason: null
			};
		}
	}

	/**
	 * Takes a read's contents, with their hash. They don't touch `size` or
	 * `mtime`: those come from the index's disknodes alone, so the two can't
	 * disagree over which is newer. A read for a diskfile that left
	 * `cells`, or whose file was deleted meanwhile, is dropped.
	 */
	#apply_read(diskfile: Diskfile, result: ContentReadResult): void {
		if (!this.#is_live(diskfile)) {
			if (diskfile.unloaded_status === 'loading') diskfile.unloaded_status = 'unrequested';
			return;
		}
		if (!result.ok) {
			console.error(`[diskfiles] reading ${diskfile.path} failed:`, result.message);
			// a re-read that failed keeps the content it had; without content, the
			// error is why it's unloadable now — an earlier read's reason no longer holds
			if (diskfile.content === null) {
				diskfile.unloaded_status = 'unloadable';
				diskfile.unloaded_reason = null;
			}
			diskfile.content_error = result.message;
			diskfile.content_error_reason = result.reason;
			return;
		}
		const { contents, unloaded_reason, hash } = result.value;
		if (contents === null) diskfile.unloaded_status = 'unloadable';
		diskfile.unloaded_reason = contents === null ? unloaded_reason : null;
		diskfile.content_error = null;
		diskfile.content_error_reason = null;
		diskfile.content = contents;
		diskfile.content_hash = hash;
		untrack(() => this.#editor_states.get(diskfile.path))?.check_disk_changes();
	}

	/**
	 * Whether `diskfile` is the cell at its path (`cells`) and may be on disk, so reading it
	 * makes sense — an uncovered one included: its read answers, or says why not.
	 */
	#is_live(diskfile: Diskfile): boolean {
		return untrack(() => this.#cells.get(diskfile.path)) === diskfile && !diskfile.deleted_on_disk;
	}

	/** Shown files read first: the selected tab's, then any open tab's, then the rest. */
	#read_priority(diskfile: Diskfile): number {
		return untrack(() => {
			if (this.editor.tabs.selected_path === diskfile.path) return 0;
			if (this.editor.tabs.by_path.has(diskfile.path)) return 1;
			return 2;
		});
	}

	/**
	 * Holds the cell at `path` for `holder` — a tab, a `DiskfilePart`, a view,
	 * a copy in flight — until `release(path, holder)`, and returns it,
	 * making it from the index's record when there's none yet, or
	 * `undefined` when no file is known there. The hold is by path, so it
	 * outlives the cell there and holds the next one: a file that leaves and
	 * comes back gets a cell again. A held file's content is kept current
	 * (see `upsert`). Holding twice with one holder holds once.
	 *
	 * A hold doesn't keep a file the index no longer has: one deleted on disk
	 * or uncovered is kept only for a draft or a tab (`#is_held`), so a part
	 * referencing a deleted file finds it missing. A kept file whose draft is
	 * saved while it's out of the index stays until its last holder lets go.
	 *
	 * Safe anywhere — a constructor, an event handler, an effect, or a
	 * `$derived`: a cell it makes is made untracked and detached
	 * (`#materialize`), and a reader of `peek` sees it arrive — a reader in
	 * another reaction; a `$derived` that reads `peek(path)` before causing
	 * the `acquire` keeps what it read until something else re-runs it.
	 *
	 * @mutates this - adds `holder` to the path's holders
	 */
	acquire(path: DiskfilePath, holder: object): Diskfile | undefined {
		let holders = this.#holders.get(path);
		if (!holders) {
			holders = new Set();
			this.#holders.set(path, holders);
		}
		holders.add(holder);
		return this.#materialize(path);
	}

	/**
	 * Lets go of `holder`'s hold on `path` (see `acquire`); releasing what
	 * isn't held does nothing. When the path's last holder lets go, the path
	 * is settled in a microtask (`#settle`: a file off the index forgotten
	 * unless kept, an idle cell dropped) unless something holds it again
	 * first — so an effect re-running, which lets go and holds again,
	 * doesn't release it, and a holder let go of while `cells` is being
	 * written can't re-enter it.
	 *
	 * @mutates this - drops `holder` from the path's holders
	 */
	release(path: DiskfilePath, holder: object): void {
		const holders = this.#holders.get(path);
		if (!holders?.delete(holder) || holders.size) return;
		this.#holders.delete(path);
		if (this.#releasing.has(path)) return;
		this.#releasing.add(path);
		queueMicrotask(() => {
			this.#releasing.delete(path);
			if (!this.#holders.has(path)) this.#settle(path);
		});
	}

	/**
	 * Settles `path` once nothing holds it (`release`): a file the index no
	 * longer has is forgotten unless kept (`release_if_unneeded`), and a file
	 * on disk drops its cell — with its editing state, unless that has
	 * something to keep (`DiskfileEditorState.can_drop`: a draft, a
	 * discarded edit, a save under way, a heading to reveal). Its record
	 * stays, and the next `acquire` makes a fresh cell, with content read
	 * again on demand.
	 */
	// TODO a state that turns clean while nothing holds the file (a save landing
	// after its tab closed) stays until the path's next let-go — a re-settle on
	// every read would also drop the states tests build without holding the file
	#settle(path: DiskfilePath): void {
		this.release_if_unneeded(path);
		const diskfile = untrack(() => this.#cells.get(path));
		if (
			!diskfile ||
			diskfile.deleted_on_disk ||
			diskfile.uncovered ||
			this.#holders.has(path) ||
			untrack(() => this.editor.tabs.by_path.has(path))
		) {
			return;
		}
		const editor_state = untrack(() => this.#editor_states.get(path));
		if (editor_state && !editor_state.can_drop) return;
		this.#write(() => this.#remove_cell(diskfile, true));
	}

	/**
	 * Holds the cell at `path` until the returned function is called — the
	 * shape of an `$effect`'s cleanup:
	 * `$effect(() => diskfiles.hold(path))`. See `acquire`.
	 */
	hold(path: DiskfilePath): () => void {
		const holder = {};
		this.acquire(path, holder);
		return () => this.release(path, holder);
	}

	/** Holds the cells at every one of `paths`, like `hold`, until the returned function is called. */
	hold_all(paths: Iterable<DiskfilePath>): () => void {
		const holder = {};
		const held = Array.from(paths);
		for (const path of held) this.acquire(path, holder);
		return () => {
			for (const path of held) this.release(path, holder);
		};
	}

	/** Whether anything holds the cell at `path` (see `acquire`). Not reactive. */
	is_acquired(path: DiskfilePath): boolean {
		return this.#holders.has(path);
	}

	/**
	 * Seed diskfiles from an initial file tree (e.g. session load or project open).
	 * Upserts by path, so overlapping seeds don't duplicate.
	 *
	 * @param files - the snapshot's file tree
	 * @param changes - what `filer_change` reported while the snapshot was in
	 * flight (see `track_changes`)
	 */
	add_initial(files: Array<SerializableDisknode>, changes?: DiskfileSnapshotChanges): void {
		this.#write(() => this.#upsert_snapshot(files, changes?.paths));
	}

	#upsert_snapshot(files: Array<SerializableDisknode>, skip_paths?: ReadonlySet<string>): void {
		for (const disknode of files) {
			if (skip_paths?.has(disknode.id)) continue;
			this.upsert(disknode);
		}
	}

	/**
	 * Replaces the file tree under `roots` with a session snapshot's: upserts
	 * every snapshot file (like `add_initial`), and removes each known file under
	 * a root that the snapshot lacks, via `remove_by_path` — so a file with a
	 * draft or a tab is kept, flagged `deleted_on_disk`. A file the index held
	 * here no longer covers (`is_indexed`) — its repo dropped from the registry
	 * or unfocused, its project closed — is absent because the snapshot doesn't
	 * look there, not because it's gone, so it's released as
	 * `release_uncovered` would: kept for a draft or a tab, flagged `uncovered`
	 * (unflagged in an unfocused repo), else forgotten. Files outside every
	 * root are left alone, since the snapshot says nothing about them.
	 *
	 * @param files - the snapshot's file tree
	 * @param roots - the directories (trailing `/`) whose complete trees `files` holds
	 * @param options.changes - what `filer_change` reported while the snapshot
	 *   was in flight (see `track_changes`): a reported path is neither
	 *   upserted nor removed
	 * @param options.skip_dirs - directories (trailing `/`) whose files aren't
	 *   removed, e.g. projects opened while the snapshot was in flight
	 */
	reconcile(
		files: Array<SerializableDisknode>,
		roots: ReadonlyArray<string>,
		options?: {
			changes?: DiskfileSnapshotChanges;
			skip_dirs?: ReadonlyArray<string>;
		}
	): void {
		const skip_paths = options?.changes?.paths;
		const skip_dirs = options?.skip_dirs ?? [];
		this.#write(() => {
			this.#upsert_snapshot(files, skip_paths);
			this.#prune_unlisted(files, roots, skip_paths, skip_dirs);
		});
	}

	#prune_unlisted(
		files: Array<SerializableDisknode>,
		roots: ReadonlyArray<string>,
		skip_paths: ReadonlySet<string> | undefined,
		skip_dirs: ReadonlyArray<string>
	): void {
		if (!roots.length) return;
		const snapshot_paths: Set<string> = new Set(files.map((disknode) => disknode.id));
		for (const path of this.#known_paths()) {
			if (snapshot_paths.has(path) || skip_paths?.has(path)) continue;
			if (!is_under_any(path, roots) || is_under_any(path, skip_dirs)) continue;
			if (this.is_indexed(path)) {
				this.remove_by_path(path);
			} else {
				this.#release_path(path);
			}
		}
	}

	/**
	 * Handles the diskfile at `path` being gone from disk.
	 *
	 * If it's held (`#is_held`) — it has a draft (edited in a tab, a file part,
	 * anywhere) or a tab — it's kept, flagged `deleted_on_disk` with its tab and
	 * editing state intact, so the user can save it back (recreating the file),
	 * or close the tab and discard the draft (see `release_if_unneeded`). A
	 * rename arrives as a delete plus an add, so its tab stays on the old path.
	 * If the path comes back on disk, `upsert` reattaches the same cell.
	 * Otherwise it's removed along with its editing state.
	 */
	remove_by_path(path: string): void {
		const diskfile = untrack(() => this.#cells.get(path as DiskfilePath));
		if (!diskfile) {
			this.#write(() => this.index.delete(path as DiskfilePath));
			return;
		}

		this.#write(() => {
			if (this.#is_held(diskfile)) {
				this.set_deleted_on_disk(diskfile, true);
			} else {
				this.#forget(diskfile);
			}
		});
	}

	/**
	 * Releases the files known under `dirs` that the index no longer covers —
	 * the focuses a newer project state dropped (`Projects`), a kind change
	 * included, since a checkout's or plain directory's one focus is its
	 * root, and a closed project's root — since stopping a filer deletes
	 * nothing here. A file still indexed (another focus, another root, a
	 * registry root's loose files) stays. Any other is still on disk as far
	 * as anything here knows: forgotten with its editing state, unless held
	 * — with a draft or a tab (`#release`). A held one in a repo that's
	 * present but unfocused (`is_in_unfocused_repo`) is kept as it is,
	 * unflagged, until the repo is focused again (the focus's files then
	 * settle it); any other held one — its entry out of the registry or
	 * missing, under a root that's become a registry's, or under a closed
	 * project's root — is kept flagged `uncovered`, until the index reports
	 * it again (`upsert`). Either way it's kept until nothing holds it
	 * (`release_if_unneeded`) and isn't watched meanwhile. A save never
	 * writes blind: an uncovered file's sends the disk version it was based
	 * on (`diskfile_update`'s `expected_hash`), and a file deleted on disk's
	 * creates it exclusively (`create_exclusive`), refused if it's there.
	 */
	release_uncovered(dirs: ReadonlyArray<string>): void {
		if (!dirs.length) return;
		this.#write(() => {
			for (const path of this.#known_paths()) {
				if (!is_under_any(path, dirs) || this.is_indexed(path)) continue;
				this.#release_path(path);
			}
		});
	}

	/**
	 * Every path known here — the index's records and the cells kept off it —
	 * as a snapshot, so the caller can change both while it walks them.
	 */
	#known_paths(): Array<DiskfilePath> {
		return untrack(() => {
			const paths: Array<DiskfilePath> = [];
			for (const record of this.index.values()) paths.push(record.id);
			for (const diskfile of this.#unindexed_files.values()) paths.push(diskfile.path);
			return paths;
		});
	}

	/**
	 * Releases the file at `path`, which the index no longer covers: its cell
	 * as `#release` does, else its record.
	 */
	#release_path(path: DiskfilePath): void {
		const diskfile = untrack(() => this.#cells.get(path));
		if (diskfile) {
			this.#release(diskfile);
		} else {
			this.index.delete(path);
		}
	}

	/**
	 * Releases `diskfile`, which the index no longer covers (see
	 * `release_uncovered`): forgotten unless held, else kept — as it is when
	 * it's deleted on disk or in an unfocused repo, and flagged `uncovered`
	 * otherwise.
	 */
	#release(diskfile: Diskfile): void {
		if (!this.#is_held(diskfile)) {
			this.#forget(diskfile);
		} else if (!diskfile.deleted_on_disk && !this.is_in_unfocused_repo(diskfile.path)) {
			this.set_uncovered(diskfile, true);
		}
	}

	/**
	 * Whether `diskfile` has a draft or a tab — what keeps one the index no
	 * longer has, deleted on disk (`remove_by_path`) or out of the index
	 * (`release_uncovered`), until both are gone (`release_if_unneeded`).
	 */
	#is_held(diskfile: Diskfile): boolean {
		return this.drafts.has(diskfile.path) || this.editor.tabs.by_path.has(diskfile.path);
	}

	/**
	 * Forgets the diskfile at `path` if it's outside what the index covers — deleted on
	 * disk, uncovered, or kept from an unfocused repo for its draft or tab
	 * (`release_uncovered`) — and nothing holds it anymore (`#is_held`): no draft and no tab.
	 * Called when its draft is discarded, when its last tab closes, and — in a
	 * microtask — when its path's last holder lets go (`release`). The path may name a newer
	 * cell than the caller's (one replaced at the same path); that's safe, since the check is on
	 * that cell's own state.
	 */
	release_if_unneeded(path: DiskfilePath): void {
		const diskfile = this.peek(path);
		if (
			diskfile &&
			(diskfile.deleted_on_disk || diskfile.uncovered || this.is_in_unfocused_repo(path)) &&
			!this.#is_held(diskfile)
		) {
			this.#forget(diskfile);
		}
	}

	/**
	 * Called when the last tab of the file at `path` closes. A diskfile deleted on disk or
	 * uncovered with no draft is forgotten now (see `release_if_unneeded`). Otherwise its
	 * editing state resets what it shows (`DiskfileEditorState.reset_view`), so
	 * a reopen shows the draft if there is one, else the disk content.
	 */
	handle_diskfile_detached(path: DiskfilePath): void {
		this.release_if_unneeded(path);
		this.#editor_states.get(path)?.reset_view();
	}

	/**
	 * Removes a diskfile with its editor tabs and editing state (disposed with
	 * the diskfile). If it was selected, selection follows the editor's newly
	 * selected tab, or clears.
	 */
	#forget(diskfile: Diskfile): void {
		// remove first, so closing its tabs re-entering `handle_diskfile_detached` is a no-op
		this.#write(() => this.#remove_cell(diskfile, false));
		this.editor.remove_diskfile(diskfile.path);
	}

	/**
	 * Writes `content` to the file at `path`. The local `Diskfile` changes only
	 * when the resulting `filer_change` broadcast arrives, not from the response
	 * — which carries the written bytes' `hash`.
	 *
	 * With `expected_hash` — the hash of the disk content the edit is based on
	 * (`DiskfileEditorState.last_seen_disk_hash`, from a read's
	 * `Diskfile.content_hash` or a save's response) — the backend writes only
	 * if the file still holds those bytes, else fails
	 * with `conflict` (`data.reason` `disk_changed`, `ERROR_DISK_CHANGED`),
	 * writing nothing. `null` writes over whatever is there.
	 *
	 * Refuses, without sending, to write over a known file whose content isn't
	 * loaded (`Diskfile.content_loaded` — not yet, or not loadable): nobody has
	 * seen what it would overwrite. Fails with `conflict` (`data.reason`
	 * `content_not_loaded`). The check reads the cell at `path`, so it holds
	 * for a caller that keeps one — an editing state, the one caller here; a
	 * path with no cell is sent unchecked.
	 *
	 * @returns the RPC result — on failure, callers surface `error` themselves
	 */
	update(
		path: DiskfilePath,
		content: string,
		expected_hash: string | null = null
	): Promise<Result<{ value: ActionOutputs['diskfile_update'] }, { error: JsonrpcErrorObject }>> {
		const existing = this.peek(path);
		if (existing && !existing.content_loaded) {
			return Promise.resolve({
				ok: false,
				error: jsonrpc_error_messages.conflict(
					`refusing to overwrite ${path}: ${to_diskfile_unloaded_message(existing)}`,
					{ reason: ERROR_CONTENT_NOT_LOADED }
				)
			});
		}
		return this.app.api.diskfile_update(
			expected_hash === null ? { path, content } : { path, content, expected_hash }
		);
	}

	/**
	 * Creates the file at `path` with `content`, never replacing one that's
	 * there (`diskfile_create`, `O_EXCL`) — how a save recreates a file
	 * deleted on disk (`Diskfile.deleted_on_disk`), which may be there after
	 * all, or there again unseen. Missing parent directories are created.
	 * Fails with `conflict` (`data.reason` `already_exists`,
	 * `ERROR_ALREADY_EXISTS`) when the path is taken, writing nothing. Unlike
	 * `create_file_at`, it selects nothing and refuses no location: the file
	 * is already known here.
	 *
	 * @returns the RPC result — on failure, callers surface `error` themselves
	 */
	create_exclusive(
		path: DiskfilePath,
		content: string
	): Promise<Result<{ value: ActionOutputs['diskfile_create'] }, { error: JsonrpcErrorObject }>> {
		return this.app.api.diskfile_create({ path, content });
	}

	/**
	 * Settles `diskfile` after a save recreated it (`create_exclusive`): no
	 * longer deleted on disk, and — where the index won't report it (out of
	 * every index, or skipped by its rules) — flagged `uncovered`, so it
	 * isn't listed as an indexed file it would never be. One the index
	 * covers is unflagged, its `add` on the way (`upsert`), and so is one in
	 * an unfocused repo, as `release_uncovered` keeps it.
	 */
	settle_recreated(diskfile: Diskfile): void {
		this.#write(() => {
			this.set_deleted_on_disk(diskfile, false);
			const { path } = diskfile;
			if (this.is_in_unfocused_repo(path)) return;
			if (!this.is_indexed(path) || this.to_unindexed(path) !== null) {
				this.set_uncovered(diskfile, true);
			}
		});
	}

	/**
	 * Deletes the file at `path` on disk. The file leaves the index when its
	 * `filer_change` arrives.
	 *
	 * @throws Error with the backend's message when the delete fails
	 */
	async delete(path: DiskfilePath): Promise<void> {
		const result = await this.app.api.diskfile_delete({ path });
		if (!result.ok) throw new Error(result.error.message);
	}

	/**
	 * The directory new files and folders are created in: the active
	 * project's (`Project.new_files_dir` — the last open's focus, else its
	 * root), `null` when no project is open.
	 */
	readonly new_files_dir: DiskfileDirectoryPath | null = $derived(
		this.app.projects.active?.new_files_dir ?? null
	);

	/**
	 * What the file index covers: the directories whose whole trees it holds
	 * (`trees` — the app directory, the scoped dirs, a checkout's or plain
	 * directory's root, a registry's focused repos) and those it holds at
	 * their top level alone (`top_levels` — a registry's root).
	 */
	readonly index_coverage: {
		trees: ReadonlyArray<DiskfileDirectoryPath>;
		top_levels: ReadonlyArray<DiskfileDirectoryPath>;
		/** A registry's entry dirs that aren't focused — named, but not indexed. */
		unfocused_dirs: ReadonlyArray<DiskfileDirectoryPath>;
	} = $derived.by(() => {
		const { zzz_dir, scoped_dirs, projects } = this.app;
		const trees: Array<DiskfileDirectoryPath> = zzz_dir ? [zzz_dir] : [];
		trees.push(...scoped_dirs);
		const top_levels: Array<DiskfileDirectoryPath> = [];
		const unfocused_dirs: Array<DiskfileDirectoryPath> = [];
		for (const project of projects.items.values) {
			if (project.kind === 'registry') {
				top_levels.push(project.root);
				trees.push(...project.focused);
				for (const entry of project.entries) {
					if (!project.focused.includes(entry.dir)) unfocused_dirs.push(entry.dir);
				}
			} else {
				trees.push(project.root);
			}
		}
		return { trees, top_levels, unfocused_dirs };
	});

	/**
	 * The part of `path` the file index skips — skipped only where every
	 * filer holding it skips it (`to_innermost_unindexed_part`), each by its
	 * root's rule: git's answer for a focused directory the daemon sent one
	 * for (`Projects.ignore_rules`), fixed names for every other root. Reactive,
	 * so a refresh of a project's `ignored` reaches the tree and the create
	 * notice.
	 *
	 * @param path - a normalized file path, or a folder's with a trailing `/`
	 * @returns the skipped part, `null` when the index enters it all or no root holds it
	 */
	to_unindexed(path: string): FileIndexUnindexedPart | null {
		return to_innermost_unindexed_part(
			path,
			this.index_coverage.trees,
			this.index_coverage.top_levels,
			this.app.projects.ignore_rules
		);
	}

	/**
	 * Whether the index covers `path`, by what's held here: under a root it
	 * indexes whole — the app dir, a scoped dir, a project's focus — or a
	 * registry root's loose file, which its top-level filer indexes.
	 */
	is_indexed(path: string): boolean {
		const { trees, top_levels } = this.index_coverage;
		return (
			is_under_any(path, trees) ||
			top_levels.some((root) => path.startsWith(root) && !path.slice(root.length).includes('/'))
		);
	}

	/**
	 * Whether `path` is under a registry project's root where the index doesn't
	 * look — below its top level and in no focused repo — so a file there
	 * never arrives.
	 */
	is_unfocused_path(path: string): boolean {
		const { trees, top_levels } = this.index_coverage;
		if (is_under_any(path, trees)) return false;
		const top = top_levels.find((root) => path.startsWith(root));
		return top !== undefined && path.slice(top.length).includes('/');
	}

	/**
	 * Whether `path` is in a repo of an open registry project — a present
	 * entry — that isn't focused, and outside everything else the index covers:
	 * on disk, but never reported, so a file there is neither listed nor
	 * watched.
	 */
	is_in_unfocused_repo(path: string): boolean {
		// a nested registry's loose files included, which its root's top-level filer indexes
		if (this.is_indexed(path)) return false;
		for (const [dir, project] of this.app.projects.repos) {
			if (path.startsWith(dir) && !project.focused.includes(dir as DiskfileDirectoryPath))
				return true;
		}
		return false;
	}

	/**
	 * The directories the file tree shows as roots, each with a trailing `/`:
	 * the app directory, the scoped dirs, and the open projects' roots. A
	 * project's index covers its focused directories and, for a registry, the
	 * root's loose files — an unfocused repo has no files, and the tree shows
	 * it from the project's entries (`Projects.repos`).
	 */
	readonly indexed_roots: ReadonlyArray<DiskfileDirectoryPath> = $derived.by(() => {
		const { zzz_dir, scoped_dirs, projects } = this.app;
		const roots: Array<DiskfileDirectoryPath> = zzz_dir ? [zzz_dir] : [];
		roots.push(...scoped_dirs);
		for (const project of projects.items.values) roots.push(project.root);
		return roots;
	});

	/**
	 * The cells kept off the index — deleted on disk or uncovered — by id
	 * — see `listed_unindexed`.
	 */
	readonly #unindexed_files: SvelteMap<Uuid, Diskfile> = new SvelteMap();

	/**
	 * The files `listed` holds that are deleted on disk or uncovered — kept
	 * for a draft or a tab, so missing from `index`. Tracks only those
	 * few files, not every cell.
	 */
	readonly listed_unindexed: Array<Diskfile> = $derived(
		Array.from(this.#unindexed_files.values()).filter((diskfile) => this.#is_held(diskfile))
	);

	/** How many files `listed` holds, without building it. */
	readonly listed_count: number = $derived(this.index.size + this.listed_unindexed.length);

	/**
	 * Marks `diskfile` gone from disk, or back — the one writer of
	 * `Diskfile.deleted_on_disk` besides `upsert`, so `index` stays in step. A delete clears `uncovered`, and ends any
	 * showing of the disk version (`DiskfileEditorState.showing_disk`), so the
	 * file reappearing shows the draft, not the disk.
	 */
	set_deleted_on_disk(diskfile: Diskfile, deleted_on_disk: boolean): void {
		if (diskfile.deleted_on_disk === deleted_on_disk) return;
		diskfile.deleted_on_disk = deleted_on_disk;
		if (deleted_on_disk) {
			diskfile.uncovered = false;
			this.#editor_states.get(diskfile.path)?.set_showing_disk(false);
		}
		this.#write(() => this.#sync_index(diskfile));
	}

	/**
	 * Marks `diskfile` out of the index though not seen deleted, or back — the
	 * one writer of `Diskfile.uncovered` besides `upsert`, so `index` stays
	 * in step. Never set on a file deleted on disk.
	 */
	set_uncovered(diskfile: Diskfile, uncovered: boolean): void {
		if (diskfile.uncovered === uncovered || (uncovered && diskfile.deleted_on_disk)) return;
		diskfile.uncovered = uncovered;
		this.#write(() => this.#sync_index(diskfile));
	}

	/**
	 * Brings the index's record for `diskfile`'s path in step with the cell:
	 * held while the cell is on disk (neither `deleted_on_disk` nor
	 * `uncovered`), absent otherwise. Called after every change to any of
	 * those. Does nothing unless `diskfile` is the cell at its path, so a
	 * stale or rejected object can't drop the file that's there. `disknode`
	 * is the record that just reported the cell, kept as is; without one the
	 * record is made from the cell. Also keeps `#unindexed_files`.
	 */
	#sync_index(diskfile: Diskfile, disknode?: SerializableDisknode): void {
		untrack(() => {
			const { path } = diskfile;
			const at_path = this.#cells.get(path);
			if (at_path !== diskfile) return;
			if (diskfile.deleted_on_disk || diskfile.uncovered) {
				if (!this.#unindexed_files.has(diskfile.id))
					this.#unindexed_files.set(diskfile.id, diskfile);
				this.index.delete(path);
			} else {
				this.#unindexed_files.delete(diskfile.id);
				this.index.set(disknode ?? diskfile_to_disknode(diskfile));
			}
		});
	}

	/** How deep `#write` calls are nested — the outermost checks the index in DEV. */
	#write_depth = 0;

	/**
	 * Runs a write of cells and the index as one batch of the index
	 * (`DiskfileIndex.batch`). In DEV, the outermost checks that the index is
	 * in step with the cells (`to_diskfile_index_mismatches`) while the
	 * cells and records are few enough to scan on every write.
	 */
	#write<T>(fn: () => T): T {
		this.#write_depth++;
		let result: T;
		try {
			result = this.index.batch(fn);
		} finally {
			this.#write_depth--;
		}
		// Only after `fn` returns, so a write that throws surfaces its own error.
		if (
			DEV &&
			this.#write_depth === 0 &&
			untrack(() => this.#cells.size + this.index.size) <= DISKFILE_INDEX_CHECK_LIMIT
		) {
			assert_diskfile_index_in_step(this);
		}
		return result;
	}

	/**
	 * The file index as markdown links see it, for telling a link's target
	 * exists — reactive, so a check in a `$derived` follows the index.
	 */
	readonly link_index: MarkdownLinkIndex = this.#create_link_index();

	#create_link_index(): MarkdownLinkIndex {
		const get_coverage = () => this.index_coverage;
		const get_ignore_rules = () => this.app.projects.ignore_rules;
		return {
			has_file: (path) => this.index.has(path),
			has_directory: (path) => this.index.directory_paths.has(path),
			get ignore_rules() {
				return get_ignore_rules();
			},
			get roots() {
				return get_coverage().trees;
			},
			get top_level_roots() {
				return get_coverage().top_levels;
			},
			get unfocused_dirs() {
				return get_coverage().unfocused_dirs;
			}
		};
	}

	/**
	 * Opens the file at `path` in a tab, as a preview unless `open_not_preview`
	 * (see `select`) — only a file on disk in the index. A markdown file's
	 * markdown view then reveals the heading `fragment` names (see
	 * `DiskfileEditorState.markdown_pending_fragment`).
	 *
	 * @returns whether a file was opened
	 */
	open_path(
		path: string,
		options?: { fragment?: string | null; open_not_preview?: boolean }
	): boolean {
		// on disk in the index — never one kept off it for a draft or a tab
		if (!untrack(() => this.index.has(path))) return false;
		this.open_in_tab(path as DiskfilePath, {
			permanent: options?.open_not_preview,
			fragment: options?.fragment
		});
		return true;
	}

	/**
	 * Opens the file at `path` in a tab and selects it — a preview unless
	 * `permanent` — whether or not it's indexed (a tab may name a path the
	 * index doesn't hold). A markdown file's view then reveals the heading
	 * `fragment` names. The `tab_open` intent's implementation.
	 */
	open_in_tab(
		path: DiskfilePath,
		options?: { permanent?: boolean | undefined; fragment?: string | null | undefined }
	): void {
		const fragment = options?.fragment;
		if (fragment && to_diskfile_content_kind(path) === 'markdown') {
			const editor_state = this.get_editor_state_at(path);
			if (editor_state) editor_state.markdown_pending_fragment = fragment;
		}
		this.select(path, options?.permanent ?? false);
	}

	/**
	 * Creates a new file in `new_files_dir` — never overwriting one: the
	 * backend's `diskfile_create` creates the final name exclusively, so an
	 * existing file (indexed or not) is left untouched. The new file is
	 * selected and opened in a permanent tab, like VS Code's new file — now if
	 * its `filer_change` already arrived, else when it does.
	 *
	 * @param filename - the file's path relative to `new_files_dir`, parsed by
	 * `parse_new_diskfile_name`: trimmed, with leading slashes dropped; refused
	 * when blank, naming the directory itself, with a whitespace-only segment,
	 * climbing out with `..`, or ending in an empty, `.`, or `..` segment
	 * @param content - the new file's content
	 * @throws Error when no project is open, the name is refused, the file
	 * already exists, or the write fails
	 */
	async create_file(filename: string, content: string = ''): Promise<void> {
		const dir = this.new_files_dir;
		if (!dir) {
			throw new Error('cannot create file: no project is open');
		}
		const parsed = parse_new_diskfile_name(filename, 'file');
		if (!parsed.ok) throw new Error(parsed.message);

		// `dir` has a trailing slash (`DiskfileDirectoryPath`), and the parsed name has no leading one
		await this.create_file_at(parse_or_throw(DiskfilePath, `${dir}${parsed.value}`), content);
	}

	/**
	 * Creates a new file at an absolute path — never overwriting one, like
	 * `create_file` — and selects it, opened in a permanent tab, now or when
	 * its `filer_change` arrives — never, for a path the index skips
	 * (`to_unindexed`), which isn't waited for. It's revealed in the
	 * tree then too (`DiskfileTreeState.reveal_created`), which the tree mode
	 * shows, now or on a later switch to it — so a copy made by "edit a copy"
	 * in the audio and transcript views is revealed as well.
	 *
	 * A path in a registry project where the index doesn't look — a repo
	 * that isn't focused, a directory no entry names — is refused before
	 * anything is written (`is_unfocused_path`): the file would never arrive.
	 *
	 * @param path - the new file's absolute path
	 * @param content - the new file's content
	 * @throws Error when the path is in an unfocused repo, the file already
	 * exists, or the write fails
	 */
	async create_file_at(path: DiskfilePath, content: string = ''): Promise<void> {
		this.#select_on_arrival = null;
		if (this.is_unfocused_path(normalize_path(path))) throw unindexed_location_error(path);

		const result = await this.app.api.diskfile_create({ path, content });
		if (!result.ok) {
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			throw new Error(reason === ERROR_ALREADY_EXISTS ? 'already exists' : result.error.message);
		}

		// the backend normalizes the path, and the filer reports it that way
		const created_path = parse_or_throw(DiskfilePath, normalize_path(path));
		// on disk already, or kept here off the index (deleted or uncovered, for a draft or a tab)
		if (untrack(() => this.index.has(created_path) || this.#cells.has(created_path))) {
			this.select(created_path, true);
			this.editor.tree.reveal_created(created_path);
		} else {
			// a path the file index skips never arrives — don't wait for it
			if (this.is_indexed(created_path) && this.to_unindexed(created_path) === null) {
				this.#select_on_arrival = created_path;
			}
		}
	}

	/**
	 * Drops a pending `create_file` selection after a user-driven tab change —
	 * selecting, opening, closing the selected tab, reopening, or navigating
	 * back / forward (the `DiskfilesEditor` methods) — since the user has
	 * moved on.
	 */
	drop_pending_selection(): void {
		this.#select_on_arrival = null;
	}

	/**
	 * Called when the project at `root` is removed: a file created there that
	 * hasn't arrived won't be selected if it arrives later.
	 */
	handle_project_removed(root: DiskfileDirectoryPath): void {
		if (this.#select_on_arrival?.startsWith(root)) this.#select_on_arrival = null;
	}

	/**
	 * Creates a new directory in `new_files_dir`.
	 *
	 * @param dirname - the directory's path relative to `new_files_dir`, parsed
	 * by `parse_new_diskfile_name` as for `create_file`, except that its last
	 * segment may be empty, `.`, or `..` (`src/`, `a/b/..`)
	 * @throws Error when no project is open, the name is refused or already
	 * taken, or the backend refuses
	 */
	async create_directory(dirname: string): Promise<void> {
		const dir = this.new_files_dir;
		if (!dir) {
			throw new Error('cannot create folder: no project is open');
		}

		const parsed = parse_new_diskfile_name(dirname, 'folder');
		if (!parsed.ok) throw new Error(parsed.message);

		await this.create_directory_at(parse_or_throw(DiskfilePath, `${dir}${parsed.value}`));
	}

	/**
	 * Creates a new directory at an absolute path, and any missing parents —
	 * never reusing an existing one, like `create_directory`. The index lists
	 * files only, so an empty directory never arrives in it; the file tree
	 * keeps one it created itself (`DiskfileTreeState.created_dirs`).
	 *
	 * A folder whose files would be refused (`create_file_at`) is refused
	 * too: in a registry project, anywhere but inside a focused repo.
	 *
	 * @param path - the new directory's absolute path
	 * @throws Error when the folder's files wouldn't be indexed, the path is
	 * taken, or the backend refuses
	 */
	async create_directory_at(path: DiskfilePath): Promise<void> {
		// as a folder, it holds files below it — refused where they would be
		if (this.is_unfocused_path(`${normalize_path(path).replace(/\/$/, '')}/`)) {
			throw unindexed_location_error(path);
		}
		const result = await this.app.api.directory_create({ path });
		if (!result.ok) {
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			throw new Error(reason === ERROR_ALREADY_EXISTS ? 'already exists' : result.error.message);
		}
	}

	/**
	 * The cell at `path`, if there is one — never creates one. A file is held
	 * by `acquire`; reading the cell needs nothing else. Reactive.
	 */
	peek(path: DiskfilePath): Diskfile | undefined {
		return this.#cells.get(path);
	}

	/**
	 * The index's record of the file at `path` — `undefined` for a file not on
	 * disk in the index, including one kept for a draft or a tab
	 * (`has_path`). Subscribes a reactive reader to `path`
	 * (`DiskfileIndex.get`); read it per path only in component effects, or
	 * deriveds that live in one.
	 */
	get_by_path(path: DiskfilePath): SerializableDisknode | undefined {
		return this.index.get(path);
	}

	/**
	 * The editing state of the file at `path` (see `get_editor_state`),
	 * created if there's none — `undefined` when no file is known there. For
	 * an event handler: the state is dropped with the cell at the next settle
	 * unless something holds the file or the state has something to keep
	 * (`DiskfileEditorState.can_drop`) — set what it keeps before returning.
	 */
	get_editor_state_at(path: DiskfilePath): DiskfileEditorState | undefined {
		const holder = {};
		const diskfile = this.acquire(path, holder);
		const editor_state = diskfile && this.get_editor_state(diskfile);
		this.release(path, holder);
		return editor_state;
	}

	/**
	 * The hash of the latest content known to be on disk at `path`: its
	 * editing state's (`DiskfileEditorState.last_seen_disk_hash`, which also
	 * moves when our own save lands), else its cell's last read, else `null`.
	 * What a draft's `base_hash` is weighed against (`Draft.status`).
	 */
	to_known_disk_hash(path: DiskfilePath): string | null {
		const editor_state = this.#editor_states.get(path);
		if (editor_state) return editor_state.last_seen_disk_hash;
		return this.peek(path)?.content_hash ?? null;
	}

	/** The innermost of `indexed_roots` holding `path`, `null` under none. */
	to_innermost_root(path: DiskfilePath): DiskfileDirectoryPath | null {
		return to_innermost_root(path, this.indexed_roots) as DiskfileDirectoryPath | null;
	}

	/**
	 * Whether the file at `path` is kept off the index (`uncovered` or
	 * `deleted_on_disk`, for a draft or a tab) under none of `indexed_roots`
	 * — its project isn't open here, so the daemon refuses to read or write
	 * it (its scope is those roots). Reopening the project (`Projects.open`
	 * on its directory, reconciling — `DiskfileDormantNotice`) binds it
	 * again. A file in the index is in scope by how it got there, and with
	 * no roots known yet (the session not loaded — the app directory is
	 * always one after) nothing is. Reactive.
	 */
	is_dormant(path: DiskfilePath): boolean {
		const diskfile = this.peek(path);
		if (!diskfile || !(diskfile.uncovered || diskfile.deleted_on_disk)) return false;
		return this.indexed_roots.length > 0 && this.to_innermost_root(path) === null;
	}

	/**
	 * Whether a file is known at `path`: on disk in the index, or kept off it
	 * for a draft or a tab (deleted on disk, or uncovered). Subscribes a
	 * reactive reader to `path` (`DiskfileIndex.has`) and, on an index miss,
	 * to the whole `#unindexed_files` map too, so any file kept or released
	 * off the index re-runs it. Read it per path only in component effects,
	 * or deriveds that live in one.
	 */
	has_path(path: string): boolean {
		if (this.index.has(path)) return true;
		for (const diskfile of this.#unindexed_files.values()) {
			if (diskfile.path === path) return true;
		}
		return false;
	}

	/**
	 * The paths beside the audio file at `source_path` that may be its
	 * transcripts, by name (`find_transcript_candidates`) — looked up among
	 * its folder's files in the tree index, not a scan of every file. Only
	 * files on disk; their contents say which are transcripts
	 * (`find_transcripts`), so a view holds them (`hold_all`) and reads their
	 * cells (`peek`).
	 */
	to_transcript_candidate_paths(source_path: string): Array<DiskfilePath> {
		const dir = source_path.slice(0, source_path.lastIndexOf('/') + 1);
		return find_transcript_candidate_paths(
			this.index.tree_index.get_children(dir).files,
			source_path
		) as Array<DiskfilePath>;
	}

	// TODO make this a derived property?
	/** The value `undefined` means uninitialized, `null` means loading, `''` means none. */
	to_relative_path(path: string): string | null | undefined {
		const { zzz_dir } = this.app;
		return zzz_dir && to_relative_path(path, zzz_dir);
	}

	/**
	 * Selects the file at `path` in a tab: a permanent one if
	 * `open_not_preview`, else a preview (a file already in a tab selects that
	 * tab).
	 */
	select(path: DiskfilePath, open_not_preview: boolean = false): void {
		this.#select_on_arrival = null;
		if (open_not_preview) {
			this.editor.open_diskfile(path);
		} else {
			this.editor.preview_diskfile(path);
		}
	}
}

/**
 * The refusal of a new file or folder where the file index doesn't look — in
 * a registry project, below its root's top level and in no focused repo.
 */
const unindexed_location_error = (path: string): Error =>
	new Error(
		`not created: ${path} isn't in a focused repo, so it would never show — create it inside a focused repo, or register and open the repo first`
	);

/**
 * The most cells `Diskfiles` checks its index against after every write in
 * DEV (`assert_diskfile_index_in_step`) — a scan of every cell, so a large
 * tree skips it.
 */
export const DISKFILE_INDEX_CHECK_LIMIT = 2000;

/**
 * The index record a cell on disk implies. The cell keeps no `ctime`, so the
 * record has none — what reported the cell, when there was one, is kept
 * instead (`Diskfiles.upsert`).
 */
const diskfile_to_disknode = (diskfile: Diskfile): SerializableDisknode => ({
	id: diskfile.path,
	source_dir: diskfile.source_dir,
	size: diskfile.size,
	ctime: null,
	mtime: diskfile.mtime
});

/**
 * How `diskfiles.index` differs from its cells, each difference described —
 * empty when they agree: no cell kept off disk (`deleted_on_disk` or
 * `uncovered`) has a record, and every other cell has one with the cell's
 * root, size, and mtime. A cell keeps no `ctime`, so that isn't compared.
 * Records without a cell are every file nothing needs, so they're expected.
 * Within `DISKFILE_INDEX_CHECK_LIMIT` records, also rebuilds the directories
 * and their counts from the records and compares them with
 * `DiskfileIndex.directory_paths` and `DiskfileIndex.directory_counts`.
 * Untracked. A scan of every cell and record — for tests and DEV checks.
 */
export const to_diskfile_index_mismatches = (diskfiles: Diskfiles): Array<string> =>
	untrack(() => {
		const mismatches: Array<string> = [];
		const { index } = diskfiles;
		for (const [path, diskfile] of diskfiles.cells) {
			if (diskfile.path !== path) mismatches.push(`${path}: holds the cell for ${diskfile.path}`);
			const record = index.get(path);
			if (diskfile.deleted_on_disk || diskfile.uncovered) {
				if (record) mismatches.push(`${path}: held off disk, but in the index`);
				continue;
			}
			if (!record) {
				mismatches.push(`${path}: on disk, but missing from the index`);
			} else if (
				record.source_dir !== diskfile.source_dir ||
				record.size !== diskfile.size ||
				record.mtime !== diskfile.mtime
			) {
				mismatches.push(
					`${path}: index has ${record.source_dir} ${record.size} ${record.mtime}, cell has ${diskfile.source_dir} ${diskfile.size} ${diskfile.mtime}`
				);
			}
		}
		if (index.size <= DISKFILE_INDEX_CHECK_LIMIT) {
			const expected: Map<string, number> = new Map();
			for (const record of index.values()) {
				for (const dir of to_file_directories(record.id, record.source_dir)) {
					expected.set(dir, (expected.get(dir) ?? 0) + 1);
				}
			}
			const { directory_counts, directory_paths } = index;
			for (const [dir, count] of expected) {
				const held = directory_counts.get(dir);
				if (held !== count)
					mismatches.push(`${dir}: index counts ${held ?? 0} files, records hold ${count}`);
				if (!directory_paths.has(dir))
					mismatches.push(`${dir}: holds files, but missing from \`directory_paths\``);
			}
			for (const [dir, count] of directory_counts) {
				if (!expected.has(dir))
					mismatches.push(`${dir}: index counts ${count} files, records hold none`);
			}
			for (const dir of directory_paths) {
				if (!expected.has(dir))
					mismatches.push(`${dir}: in \`directory_paths\`, but holds no files`);
			}
		}
		return mismatches;
	});

/**
 * Throws when `diskfiles.index` differs from its cells — see
 * `to_diskfile_index_mismatches`.
 *
 * @throws Error listing the differences
 */
export const assert_diskfile_index_in_step = (diskfiles: Diskfiles): void => {
	const mismatches = to_diskfile_index_mismatches(diskfiles);
	if (mismatches.length) {
		throw new Error(`diskfile index out of step:\n${mismatches.join('\n')}`);
	}
};

/** Whether `path` is inside one of `dirs` (each with a trailing `/`). */
const is_under_any = (path: string, dirs: ReadonlyArray<string>): boolean =>
	dirs.some((dir) => path.startsWith(dir));
