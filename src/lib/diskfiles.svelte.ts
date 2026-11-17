import {
	array,
	nullable,
	parse_or_throw,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
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
	to_file_directories,
	to_diskfile_unloaded_message,
	to_innermost_unindexed_part,
	to_relative_path,
	type FileIndexUnindexedPart
} from './diskfile_helpers.ts';
import { to_diskfile_content_kind } from './diskfile_content_kind.ts';
import type { MarkdownLinkIndex } from './markdown_links.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index } from './indexed_collection_helpers.svelte.ts';
import { DiskfilesEditor } from './diskfiles_editor.svelte.ts';
import { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
import { create_detached } from './reactive_helpers.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { DiskfileTreeIndex } from './diskfile_tree_state.svelte.ts';
import type { ActionInputs, ActionOutputs } from './action_collections.ts';
import { TaskQueue } from './task_queue.ts';

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
		diskfiles: with_default_fn(array(DiskfileJson), () => []),
		selected_path: with_default(nullable(DiskfilePath), null)
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
	// TODO bound memory across files: every file opened keeps its state and history
	// (each capped) until the diskfile goes away — maybe drop clean ones when their
	// last view and tab close, or keep an app-wide history budget
	/** The files' app-level editing states, by path — see `get_editor_state`. */
	readonly #editor_states: SvelteMap<DiskfilePath, DiskfileEditorState> = new SvelteMap();

	readonly items: IndexedCollection<Diskfile> = new IndexedCollection({
		dispose_item: (diskfile) => {
			// every way out of the collection passes here - `remove`, `remove_many`, and `clear`
			this.#sync_directories(diskfile);
			this.#remove_editor_state(diskfile);
			diskfile.dispose();
		},
		indexes: [
			create_single_index({
				key: 'by_path',
				extractor: (file) => file.path,
				// a diskfile's path is its disk identity — `upsert` updates in place by path,
				// and renames arrive as a delete plus an add
				immutable_key: true
			})
		]
	});

	/** The selected file's path — the selection follows the path, not a particular cell. */
	selected_path: DiskfilePath | null = $state.raw(null);

	readonly selected_file: Diskfile | null = $derived(
		this.selected_path ? (this.get_by_path(this.selected_path) ?? null) : null
	);

	/**
	 * Diskfiles that exist on disk, as the index reports them — excludes ones
	 * kept for a draft or a tab after a delete (`deleted_on_disk`) or after
	 * leaving the index (`uncovered`), so pickers offer only indexed files.
	 */
	readonly on_disk: Array<Diskfile> = $derived(
		this.items.values.filter((diskfile) => !diskfile.deleted_on_disk && !diskfile.uncovered)
	);

	/**
	 * The diskfiles the explorer lists: those on disk, plus ones deleted on disk
	 * (`remove_by_path`) or uncovered (`release_uncovered`) but kept for a draft
	 * or a tab, so each stays reachable.
	 */
	readonly listed: Array<Diskfile> = $derived(
		this.items.values.filter(
			(diskfile) => (!diskfile.deleted_on_disk && !diskfile.uncovered) || this.#is_held(diskfile)
		)
	);

	/**
	 * Whether any file is `dirty` (see `DiskfileEditorState.dirty`: it has a
	 * draft, or its editor shows other content than the disk's) — edits that
	 * live only in memory, lost on a reload.
	 */
	readonly has_unsaved_changes: boolean = $derived.by(() => {
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
				() => this.items.clear(),
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
	 * Adds a diskfile. It isn't selected: a file appearing on disk — seeded by
	 * a snapshot, or created by another tool — never moves the selection or
	 * opens a tab. Only `create_file` selects the file it creates.
	 */
	add(json: DiskfileJsonInput): Diskfile {
		const diskfile = new Diskfile({ app: this.app, json });
		this.items.add(diskfile);
		this.#sync_directories(diskfile);
		if (diskfile.path === this.#select_on_arrival) {
			this.#select_on_arrival = null;
			this.select(diskfile.path, true);
			this.editor.tree.reveal_created(diskfile.path);
		}
		return diskfile;
	}

	/**
	 * The file `create_file` created whose `filer_change` hasn't arrived yet,
	 * selected and revealed in the tree when it does. Not reactive. Dropped
	 * when it's selected, when the user selects anything else (`select`, or a
	 * tab change through `DiskfilesEditor` — `follow_selected_tab`), when its
	 * project is removed (`handle_project_removed`), or by the next
	 * `create_file` — so a file the filer never reports (say under
	 * `node_modules/`) can't take the selection
	 * later.
	 */
	#select_on_arrival: DiskfilePath | null = null;

	/**
	 * The app-level editing state of `diskfile` (its draft, history, and save
	 * state), created on first use and kept until the diskfile is removed —
	 * views read it, they don't own it. Safe to call from component init or a
	 * `$derived`: it's created detached from the calling effect, and reading it
	 * doesn't track the lookup. A diskfile no longer in the collection gets a
	 * throwaway state.
	 */
	get_editor_state(diskfile: Diskfile): DiskfileEditorState {
		const existing = untrack(() => this.#editor_states.get(diskfile.path));
		// a stale `diskfile` (gone from the collection) never gets the live cell's state
		if (existing?.diskfile === diskfile) return existing;
		return create_detached(() => {
			const editor_state = new DiskfileEditorState({ app: this.app, diskfile });
			if (this.get_by_path(diskfile.path) === diskfile) {
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
	 * a file held eagerly — with an editing state, or referenced by a
	 * `DiskfilePart` — is read again, keeping its content until the new one
	 * lands, and any other drops its content to `unrequested`, to be read when
	 * next needed (`ensure_content`). A read in flight reads again instead. A
	 * read that lands on the same text changes nothing
	 * (`DiskfileEditorState.check_disk_changes`), so a resync that re-sends
	 * every file, or a `touch`, raises no conflict. A new file starts
	 * `unrequested`, and is read right away if a part references it.
	 */
	upsert(disknode: SerializableDisknode): Diskfile {
		const existing = this.items.by_optional('by_path', disknode.id);
		if (!existing) {
			const diskfile = this.add(disknode_to_diskfile_json(disknode));
			if (this.#is_held_eagerly(diskfile)) void this.#start_load(diskfile);
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
		this.#sync_directories(existing);
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
	 * against it), a tab, or a `DiskfilePart` references it (prompts and turns
	 * read it). Other files load on demand and drop their content on a change.
	 * Wider than `#is_held`, since a part reads a file but doesn't keep it.
	 */
	#is_held_eagerly(diskfile: Diskfile): boolean {
		return (
			untrack(
				() => this.#editor_states.has(diskfile.path) || this.editor.tabs.by_path.has(diskfile.path)
			) || (this.#part_paths.get(diskfile.path) ?? 0) > 0
		);
	}

	/** Content reads in flight, by diskfile id — see `ensure_content`. Not reactive. */
	readonly #loads: Map<Uuid, ContentLoad> = new Map();

	readonly #read_queue: TaskQueue = new TaskQueue(DISKFILE_READ_CONCURRENCY);

	/** How many `DiskfilePart`s reference each path — see `track_part_path`. Not reactive. */
	readonly #part_paths: Map<string, number> = new Map();

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
		// a file deleted on disk keeps what it had, and one gone from the
		// collection has nothing to read — reading it would only loop
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
	 * `loading`. A file deleted on disk or gone from the collection isn't
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
	 * disagree over which is newer. A read for a diskfile that left the
	 * collection, or whose file was deleted meanwhile, is dropped.
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
	 * Whether `diskfile` is in the collection and may be on disk, so reading it
	 * makes sense — an uncovered one included: its read answers, or says why not.
	 */
	#is_live(diskfile: Diskfile): boolean {
		return this.items.by_id.get(diskfile.id) === diskfile && !diskfile.deleted_on_disk;
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
	 * Counts a `DiskfilePart` moving from `previous` to `next` — a file a part
	 * references is held eagerly (see `upsert`), and is read when the part
	 * attaches, in a microtask so a part constructed anywhere can call this.
	 */
	track_part_path(previous: DiskfilePath | null, next: DiskfilePath | null): void {
		if (previous === next) return;
		if (previous !== null) {
			const count = (this.#part_paths.get(previous) ?? 0) - 1;
			if (count > 0) {
				this.#part_paths.set(previous, count);
			} else {
				this.#part_paths.delete(previous);
			}
		}
		if (next !== null) {
			this.#part_paths.set(next, (this.#part_paths.get(next) ?? 0) + 1);
			queueMicrotask(() => {
				// a part detached meanwhile no longer needs it
				if (!this.#part_paths.has(next)) return;
				const diskfile = this.get_by_path(next);
				if (diskfile && !diskfile.deleted_on_disk) void this.ensure_content(diskfile);
			});
		}
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
		this.#upsert_snapshot(files, changes?.paths);
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
		this.#upsert_snapshot(files, skip_paths);
		this.#prune_unlisted(files, roots, skip_paths, skip_dirs);
	}

	#prune_unlisted(
		files: Array<SerializableDisknode>,
		roots: ReadonlyArray<string>,
		skip_paths: ReadonlySet<string> | undefined,
		skip_dirs: ReadonlyArray<string>
	): void {
		if (!roots.length) return;
		const snapshot_paths: Set<string> = new Set(files.map((disknode) => disknode.id));
		for (const diskfile of this.items.values) {
			const { path } = diskfile;
			if (snapshot_paths.has(path) || skip_paths?.has(path)) continue;
			if (!is_under_any(path, roots) || is_under_any(path, skip_dirs)) continue;
			if (this.is_indexed(path)) {
				this.remove_by_path(path);
			} else {
				this.#release(diskfile);
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
		const diskfile = this.items.by_optional('by_path', path);
		if (!diskfile) return;

		if (this.#is_held(diskfile)) {
			this.set_deleted_on_disk(diskfile, true);
			return;
		}

		this.#forget(diskfile);
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
		for (const diskfile of this.items.values) {
			const { path } = diskfile;
			if (!is_under_any(path, dirs) || this.is_indexed(path)) continue;
			this.#release(diskfile);
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
		return (
			!!this.#editor_states.get(diskfile.path)?.has_unsaved_edits ||
			this.editor.tabs.by_path.has(diskfile.path)
		);
	}

	/**
	 * Forgets the diskfile at `path` if it's outside what the index covers — deleted on
	 * disk, uncovered, or kept from an unfocused repo for its draft or tab
	 * (`release_uncovered`) — and nothing holds it anymore (`#is_held`): no draft and no tab.
	 * Called when its draft is discarded and when its last tab closes. The path may name a newer
	 * cell than the caller's (one replaced at the same path); that's safe, since the check is on
	 * that cell's own state.
	 */
	release_if_unneeded(path: DiskfilePath): void {
		const diskfile = this.get_by_path(path);
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
		this.items.remove(diskfile.id);
		this.editor.remove_diskfile(diskfile.path);

		if (this.selected_path === diskfile.path) {
			this.selected_path = this.editor.tabs.selected_path;
		}
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
	 * `content_not_loaded`).
	 *
	 * @returns the RPC result — on failure, callers surface `error` themselves
	 */
	update(
		path: DiskfilePath,
		content: string,
		expected_hash: string | null = null
	): Promise<Result<{ value: ActionOutputs['diskfile_update'] }, { error: JsonrpcErrorObject }>> {
		const existing = this.get_by_path(path);
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
		this.set_deleted_on_disk(diskfile, false);
		const { path } = diskfile;
		if (this.is_in_unfocused_repo(path)) return;
		if (!this.is_indexed(path) || this.to_unindexed(path) !== null) {
			this.set_uncovered(diskfile, true);
		}
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
	 * How many files on disk each directory holds, at any depth, by its path
	 * with a trailing `/` — every ancestor of each file up to its root (see
	 * `to_file_directories`). Kept in step as files come and go
	 * (`#sync_directories`), never rebuilt. Not reactive: `directory_paths` is.
	 */
	readonly #directory_counts: Map<string, number> = new Map();

	/** What each counted diskfile contributed to `#directory_counts`, by id. Not reactive. */
	readonly #counted_files: Map<Uuid, { path: string; source_dir: string }> = new Map();

	readonly #directory_paths: SvelteSet<string> = new SvelteSet();

	/**
	 * Each folder's children among the files on disk, every file linked up to
	 * `/` — not its `source_dir`, which is whichever root's filer reported it
	 * last — so any root's folder shows it. Kept in step with
	 * `directory_paths`; the file tree reads it (see `DiskfileTreeState`).
	 */
	readonly tree_index: DiskfileTreeIndex = new DiskfileTreeIndex();

	/**
	 * The files in the collection that are deleted on disk or uncovered, by id
	 * — see `listed_unindexed`.
	 */
	readonly #unindexed_files: SvelteMap<Uuid, Diskfile> = new SvelteMap();

	/**
	 * The files `listed` holds that are deleted on disk or uncovered — kept
	 * for a draft or a tab, so missing from `tree_index`. Tracks only those
	 * few files, not the whole collection.
	 */
	readonly listed_unindexed: Array<Diskfile> = $derived(
		Array.from(this.#unindexed_files.values()).filter((diskfile) => this.#is_held(diskfile))
	);

	/**
	 * The directories holding a file on disk, each with a trailing `/` —
	 * changing only as a directory gains its first file or loses its last.
	 */
	readonly directory_paths: ReadonlySet<string> = this.#directory_paths;

	/**
	 * Marks `diskfile` gone from disk, or back — the one writer of
	 * `Diskfile.deleted_on_disk` besides `upsert`, so `directory_paths` stays
	 * in step. A delete clears `uncovered`, and ends any showing of the disk
	 * version (`DiskfileEditorState.showing_disk`), so the file reappearing
	 * shows the draft, not the disk.
	 */
	set_deleted_on_disk(diskfile: Diskfile, deleted_on_disk: boolean): void {
		if (diskfile.deleted_on_disk === deleted_on_disk) return;
		diskfile.deleted_on_disk = deleted_on_disk;
		if (deleted_on_disk) {
			diskfile.uncovered = false;
			this.#editor_states.get(diskfile.path)?.set_showing_disk(false);
		}
		this.#sync_directories(diskfile);
	}

	/**
	 * Marks `diskfile` out of the index though not seen deleted, or back — the
	 * one writer of `Diskfile.uncovered` besides `upsert`, so `directory_paths`
	 * stays in step. Never set on a file deleted on disk.
	 */
	set_uncovered(diskfile: Diskfile, uncovered: boolean): void {
		if (diskfile.uncovered === uncovered || (uncovered && diskfile.deleted_on_disk)) return;
		diskfile.uncovered = uncovered;
		this.#sync_directories(diskfile);
	}

	/**
	 * Brings `#directory_counts` and `tree_index` in step with the file
	 * `diskfile`'s id names: it counts while it's in the collection and on
	 * disk, under its current path and root. Called after every change to any
	 * of those. Reads the collection's own object for the id when there is one,
	 * so a stale or rejected object (an `add` of an id already present) can't
	 * uncount the file that's there. Also keeps `#unindexed_files`.
	 */
	#sync_directories(diskfile: Diskfile): void {
		untrack(() => {
			const counted = this.#counted_files.get(diskfile.id);
			const live = this.items.by_id.get(diskfile.id);
			const unindexed = !!live && (live.deleted_on_disk || live.uncovered);
			const counts = !!live && !unindexed;
			if (live && unindexed) {
				if (!this.#unindexed_files.has(diskfile.id)) this.#unindexed_files.set(diskfile.id, live);
			} else if (this.#unindexed_files.has(diskfile.id)) {
				this.#unindexed_files.delete(diskfile.id);
			}
			const { path, source_dir } = live ?? diskfile;
			if (counted && counts && counted.path === path && counted.source_dir === source_dir) return;
			if (counted) {
				this.#counted_files.delete(diskfile.id);
				const dirs = to_file_directories(counted.path, counted.source_dir);
				this.tree_index.remove_file(counted.path, to_file_directories(counted.path, '/'));
				for (const dir of dirs) {
					const count = this.#directory_counts.get(dir)! - 1;
					if (count > 0) {
						this.#directory_counts.set(dir, count);
					} else {
						this.#directory_counts.delete(dir);
						this.#directory_paths.delete(dir);
					}
				}
			}
			if (counts) {
				this.#counted_files.set(diskfile.id, { path, source_dir });
				const dirs = to_file_directories(path, source_dir);
				this.tree_index.add_file(path, to_file_directories(path, '/'));
				for (const dir of dirs) {
					const count = this.#directory_counts.get(dir) ?? 0;
					this.#directory_counts.set(dir, count + 1);
					if (count === 0) this.#directory_paths.add(dir);
				}
			}
		});
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
			has_file: (path) => {
				const diskfile = this.get_by_path(path as DiskfilePath);
				return !!diskfile && !diskfile.deleted_on_disk && !diskfile.uncovered;
			},
			has_directory: (path) => this.#directory_paths.has(path),
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
		const diskfile = this.get_by_path(path as DiskfilePath);
		if (!diskfile || diskfile.deleted_on_disk || diskfile.uncovered) return false;
		const fragment = options?.fragment;
		if (fragment && to_diskfile_content_kind(diskfile.path) === 'markdown') {
			this.get_editor_state(diskfile).markdown_pending_fragment = fragment;
		}
		this.select(diskfile.path, options?.open_not_preview);
		return true;
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
		const created = this.get_by_path(created_path);
		if (created) {
			this.select(created.path, true);
			this.editor.tree.reveal_created(created_path);
		} else {
			// a path the file index skips never arrives — don't wait for it
			if (this.is_indexed(created_path) && this.to_unindexed(created_path) === null) {
				this.#select_on_arrival = created_path;
			}
		}
	}

	/**
	 * Makes the selected file the editor's selected tab's (or none) after a
	 * user-driven tab change — selecting, opening, closing the selected tab,
	 * reopening, or navigating back/forward (the `DiskfilesEditor` methods) —
	 * and drops a pending `create_file` selection, since the user has moved on.
	 */
	follow_selected_tab(): void {
		this.#select_on_arrival = null;
		this.selected_path = this.editor.tabs.selected_path;
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

	get_by_path(path: DiskfilePath): Diskfile | undefined {
		return this.items.by_optional('by_path', path);
	}

	// TODO make this a derived property?
	/** The value `undefined` means uninitialized, `null` means loading, `''` means none. */
	to_relative_path(path: string): string | null | undefined {
		const { zzz_dir } = this.app;
		return zzz_dir && to_relative_path(path, zzz_dir);
	}

	/**
	 * Select a file by path and also update the editor tabs.
	 * Default to the first file if `path` is `undefined`.
	 * If `path` is `null`, it selects no file.
	 * If `open_not_preview` is `true`, opens as a permanent tab, otherwise previews.
	 */
	select(path: DiskfilePath | null | undefined, open_not_preview: boolean = false): void {
		this.#select_on_arrival = null;
		if (path === undefined) {
			this.select_next();
		} else {
			this.selected_path = path;

			// Update the editor if a file is selected
			if (path !== null) {
				if (open_not_preview) {
					this.editor.open_diskfile(path);
				} else {
					this.editor.preview_diskfile(path);
				}
			}
		}
	}

	select_next(): void {
		this.select(this.on_disk[0]?.path ?? null);
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

/** Whether `path` is inside one of `dirs` (each with a trailing `/`). */
const is_under_any = (path: string, dirs: ReadonlyArray<string>): boolean =>
	dirs.some((dir) => path.startsWith(dir));
