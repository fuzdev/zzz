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
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { jsonrpc_error_messages } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { get_datetime_now } from './datetime.ts';
import { Diskfile } from './diskfile.svelte.ts';
import {
	DiskfileJson,
	DiskfilePath,
	type DiskfileDirectoryPath,
	type DiskfileJsonInput,
	type DisknodeMetadata,
	type SerializableDisknode
} from './diskfile_types.ts';
import {
	DISKFILE_CONTENT_NOT_LOADED_MESSAGE,
	ERROR_CONTENT_NOT_LOADED,
	disknode_to_diskfile_json,
	normalize_path,
	parse_new_diskfile_name,
	to_file_directories,
	to_innermost_root,
	to_diskfile_unloaded_message,
	to_relative_path,
	to_unindexed_segment
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
	/**
	 * Contents arrived on the wire while the read was in flight — maybe newer
	 * than what it returns, so its result isn't applied over them.
	 */
	superseded: boolean;
}

/** What `Diskfiles` takes from a `diskfile_read`: its output, or why it failed. */
type ContentReadResult =
	{ ok: true; value: ActionOutputs['diskfile_read'] } | { ok: false; message: string };

export const DiskfilesJson = cell_json_schema(
	{
		diskfiles: with_default_fn(array(DiskfileJson), () => []),
		selected_file_id: with_default(nullable(Uuid), null)
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
	/**
	 * Paths an `add`, `change`, or `delete` reported. The snapshot's entries
	 * for them are skipped.
	 */
	readonly paths: ReadonlySet<string>;
	/**
	 * The latest `touch` reported per path. A touch never makes the snapshot
	 * yield; its metadata is applied again after the snapshot.
	 */
	readonly touches: ReadonlyMap<string, DisknodeMetadata>;
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
	/** The files' app-level editing states, by diskfile id — see `get_editor_state`. */
	readonly #editor_states: SvelteMap<Uuid, DiskfileEditorState> = new SvelteMap();

	readonly items: IndexedCollection<Diskfile> = new IndexedCollection({
		dispose_item: (diskfile) => {
			// every way out of the collection passes here - `remove`, `remove_many`, and `clear`
			this.#sync_directories(diskfile);
			this.#remove_editor_state(diskfile.id);
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

	selected_file_id: Uuid | null = $state.raw(null);

	readonly selected_file: Diskfile | null = $derived(
		this.selected_file_id ? (this.items.by_id.get(this.selected_file_id) ?? null) : null
	);

	/** Diskfiles that exist on disk — excludes ones kept only for unsaved edits. */
	readonly on_disk: Array<Diskfile> = $derived(
		this.items.values.filter((diskfile) => !diskfile.deleted_on_disk)
	);

	/**
	 * The diskfiles the explorer lists: those on disk, plus ones deleted on disk
	 * but kept for a draft, so every draft stays reachable.
	 */
	readonly listed: Array<Diskfile> = $derived(
		this.items.values.filter(
			(diskfile) =>
				!diskfile.deleted_on_disk || !!this.#editor_states.get(diskfile.id)?.has_unsaved_edits
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
	readonly #change_trackers: Set<{
		paths: Set<string>;
		touches: Map<string, DisknodeMetadata>;
	}> = new Set();

	/**
	 * Starts recording what `handle_change` is given. Start it before
	 * requesting a file-tree snapshot and pass it to `add_initial` or
	 * `reconcile` with the snapshot, which is then applied around what
	 * `filer_change` reported while the request was in flight:
	 *
	 * - A path an `add`, `change`, or `delete` reported keeps what the
	 *   notification left: the snapshot's entry for it is skipped, and it isn't
	 *   pruned. So a file deleted meanwhile isn't resurrected and newer content
	 *   isn't reverted.
	 * - A `touch` never makes the snapshot yield, because it carries no
	 *   contents: a client that missed a `change` while disconnected holds old
	 *   text, and only the snapshot can replace it. The snapshot's entry is
	 *   applied (or the file pruned, if the snapshot lacks it), and then the
	 *   path's latest touch is applied again — unless an `add`, `change`, or
	 *   `delete` was also reported for the path, whose result already stands.
	 *
	 * The touch's metadata wins over the snapshot's whichever `mtime` is
	 * higher. The two can't be ordered from here — a notification that arrives
	 * during the request may have been sent before or after the backend read
	 * its index for the snapshot, and a file's `mtime` can move backwards — but
	 * the backend queues a notification for every change to its index, so its
	 * notifications converge on the index: if the snapshot was the newer of the
	 * two, whatever moved the file past the touch has its own notification
	 * still to come, and that one settles it. Preferring the snapshot would
	 * have no such correction when the touch was the newer.
	 */
	track_changes(): DiskfileChangeTracker {
		const tracker = { paths: new Set<string>(), touches: new Map<string, DisknodeMetadata>() };
		this.#change_trackers.add(tracker);
		return {
			paths: tracker.paths,
			touches: tracker.touches,
			stop: () => this.#change_trackers.delete(tracker)
		};
	}

	/**
	 * Applies a `filer_change` notification. `add` and `change` both upsert by
	 * path — the backend's add/change split is advisory, and a re-seed or a
	 * missed delete must never leave two diskfiles for one path. A `touch`
	 * carries no contents (see `touch`).
	 */
	handle_change(params: ActionInputs['filer_change']): void {
		const { disknode } = params;
		if (params.change.type === 'touch') {
			// recorded apart from the changes a snapshot in flight yields to
			// (see `track_changes`), whether or not there's a diskfile to update
			for (const tracker of this.#change_trackers) tracker.touches.set(disknode.id, disknode);
			this.touch(disknode);
			return;
		}
		for (const tracker of this.#change_trackers) tracker.paths.add(disknode.id);
		if (params.change.type === 'delete') {
			this.remove_by_path(disknode.id);
		} else {
			this.upsert(disknode);
		}
	}

	/**
	 * Applies a `touch`: the file's metadata changed on disk. It takes the new
	 * `size` and `mtime`, and since a notification without contents can't say
	 * whether the bytes moved, its content is treated as a change on disk
	 * would be (see `upsert`): read again if the file is held eagerly, else
	 * dropped until it's next needed. A read that lands on the same text
	 * changes nothing (`DiskfileEditorState.check_disk_changes`).
	 *
	 * A path this client doesn't hold is left alone (the next snapshot brings
	 * it), as is a diskfile kept after its file was deleted, whose content is
	 * no longer the file's.
	 *
	 * @returns whether a diskfile was updated
	 */
	touch(metadata: DisknodeMetadata): boolean {
		const existing = this.#apply_metadata(metadata);
		if (!existing) return false;
		this.#follow_disk_change(existing);
		return true;
	}

	/**
	 * Takes a touch's `size` and `mtime` — nothing else.
	 *
	 * @returns the diskfile updated, `undefined` for a path not held or a file deleted on disk
	 */
	#apply_metadata(metadata: DisknodeMetadata): Diskfile | undefined {
		const existing = this.items.by_optional('by_path', metadata.id);
		if (!existing || existing.deleted_on_disk) return undefined;
		if (existing.size !== metadata.size) existing.size = metadata.size;
		if (existing.mtime !== metadata.mtime) existing.mtime = metadata.mtime;
		return existing;
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
			this.select(diskfile.id, true);
			this.editor.tree.reveal_created(diskfile.path);
		}
		return diskfile;
	}

	/**
	 * The file `create_file` created whose `filer_change` hasn't arrived yet,
	 * selected and revealed in the tree when it does. Not reactive. Dropped
	 * when it's selected, when the user selects anything else (`select`, or a
	 * tab change through `DiskfilesEditor` — `follow_selected_tab`), when its
	 * workspace is removed (`handle_workspace_removed`), or by the next
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
		const existing = untrack(() => this.#editor_states.get(diskfile.id));
		if (existing) return existing;
		return create_detached(() => {
			const editor_state = new DiskfileEditorState({ app: this.app, diskfile });
			if (this.items.by_id.get(diskfile.id) === diskfile) {
				this.#editor_states.set(diskfile.id, editor_state);
			} else {
				// unmanaged, so nothing would dispose it — keep it out of the cell registry
				editor_state.dispose();
			}
			return editor_state;
		});
	}

	/** The editing state of diskfile `id` if one was created — see `get_editor_state`. */
	find_editor_state(id: Uuid): DiskfileEditorState | undefined {
		return this.#editor_states.get(id);
	}

	#remove_editor_state(id: Uuid): void {
		const editor_state = this.#editor_states.get(id);
		if (!editor_state) return;
		this.#editor_states.delete(id);
		editor_state.dispose();
	}

	/**
	 * Adds a diskfile for `disknode`, or updates the existing one at the same
	 * path in place — keeping its id, so tabs, selection, and parts stay attached.
	 * A diskfile kept after a delete (see `remove_by_path`) is reattached this
	 * way when its path reappears on disk.
	 *
	 * A disknode with `contents` is a read: the diskfile takes them as loaded
	 * (`null` makes it `unloadable`). An existing diskfile whose content and
	 * dependency data already match is left untouched but for its `size` and
	 * `mtime`, so a resync that re-sends every file doesn't churn the unchanged
	 * ones. A content change is recorded in the file's editing state, if it has
	 * one (`DiskfileEditorState.check_disk_changes`).
	 *
	 * A disknode without `contents` carries metadata only, so for a diskfile
	 * already held its content may be out of date: a file held eagerly — with
	 * an editing state, or referenced by a `DiskfilePart` — is read again,
	 * keeping its content until the new one lands, and any other drops its
	 * content to `unrequested`, to be read when next needed
	 * (`ensure_content`). A read in flight reads again instead. A new file
	 * starts `unrequested`, and is read right away if a part references it.
	 */
	upsert(disknode: SerializableDisknode): Diskfile {
		const existing = this.items.by_optional('by_path', disknode.id);
		const { contents } = disknode;
		if (!existing) {
			const diskfile = this.add(disknode_to_diskfile_json(disknode));
			if (contents === null) {
				diskfile.unloaded_status = 'unloadable';
			} else if (contents === undefined && this.#is_held_eagerly(diskfile)) {
				void this.#start_load(diskfile);
			}
			return diskfile;
		}
		if (contents === undefined) {
			existing.deleted_on_disk = false;
			if (existing.source_dir !== disknode.source_dir) existing.source_dir = disknode.source_dir;
			if (existing.size !== disknode.size) existing.size = disknode.size;
			if (existing.mtime !== disknode.mtime) existing.mtime = disknode.mtime;
			// back on disk, and its root may have changed with a snapshot from another filer
			this.#sync_directories(existing);
			this.#follow_disk_change(existing);
			return existing;
		}
		// a read in flight may have been served before this — it reads again,
		// and its result isn't applied over these contents
		const load = this.#loads.get(existing.id);
		if (load) {
			load.stale = true;
			load.superseded = true;
		}
		if (!existing.deleted_on_disk && diskfile_matches(existing, disknode)) {
			// the metadata a rewrite to the same content changes — and the only
			// sign of a change to a file whose content isn't loaded
			if (existing.size !== disknode.size) existing.size = disknode.size;
			if (existing.mtime !== disknode.mtime) existing.mtime = disknode.mtime;
			this.#settle_contents(existing, contents);
			return existing;
		}
		existing.deleted_on_disk = false;
		existing.set_json({
			...disknode_to_diskfile_json(disknode, existing.id),
			// TODO hacky, should be handled more cleanly elsewhere
			created: existing.created, // Preserve original creation date
			updated: get_datetime_now() // TODO @many probably rely on the db to bump `updated`
		});
		this.#settle_contents(existing, contents);
		// back on disk, and its root may have changed with a snapshot from another filer
		this.#sync_directories(existing);
		untrack(() => this.#editor_states.get(existing.id))?.check_disk_changes();
		return existing;
	}

	/**
	 * Settles the content status of a diskfile that took `contents` from a
	 * disknode: a string is loaded, `null` unloadable for a reason not given.
	 */
	#settle_contents(diskfile: Diskfile, contents: string | null): void {
		if (contents === null && diskfile.unloaded_status !== 'unloadable') {
			diskfile.unloaded_status = 'unloadable';
		}
		if (diskfile.unloaded_reason !== null) diskfile.unloaded_reason = null;
		if (diskfile.content_error !== null) diskfile.content_error = null;
	}

	/**
	 * Follows a change on disk that came without contents (see `upsert`): a
	 * read in flight reads again, a file held eagerly is read, and any other
	 * held content is dropped.
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
			diskfile.content = null;
		}
	}

	/**
	 * Whether `diskfile`'s content is kept current as it changes on disk: it
	 * has an editing state (an editor shows it, or did — conflicts are caught
	 * against it) or a `DiskfilePart` references it (prompts and turns read
	 * it). Other files load on demand and drop their content on a change.
	 */
	#is_held_eagerly(diskfile: Diskfile): boolean {
		return (
			untrack(() => this.#editor_states.has(diskfile.id)) ||
			(this.#part_paths.get(diskfile.path) ?? 0) > 0
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
		const load: ContentLoad = { promise: Promise.resolve(), stale: false, superseded: false };
		this.#loads.set(diskfile.id, load);
		load.promise = this.#run_load(diskfile, load);
		return load.promise;
	}

	/**
	 * Reads until a read lands with no change on disk reported meanwhile.
	 * Each result is applied as it lands — so a file written more often than
	 * a read takes still shows its content — unless contents arrived on the
	 * wire meanwhile, which may be newer; a failure is applied only when it's
	 * the last read.
	 */
	async #run_load(diskfile: Diskfile, load: ContentLoad): Promise<void> {
		try {
			do {
				const result = await this.#read_queue.run(
					() => {
						// reset as the read starts, not while it waits for a slot — a change
						// reported while it waits is one this read already sees
						load.stale = false;
						load.superseded = false;
						return this.#read(diskfile.path);
					},
					() => this.#read_priority(diskfile)
				);
				if (!load.superseded && (result.ok || !load.stale)) this.#apply_read(diskfile, result);
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
			return result.ok ? result : { ok: false, message: result.error.message };
		} catch (error) {
			return { ok: false, message: to_error_message(error, 'read failed') };
		}
	}

	/**
	 * Takes a read's contents. They don't touch `size` or `mtime`: those come
	 * from the index's disknodes alone, so the two can't disagree over which
	 * is newer. A read for a diskfile that left the collection, or whose file
	 * was deleted meanwhile, is dropped.
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
			return;
		}
		const { contents, unloaded_reason } = result.value;
		if (contents === null) diskfile.unloaded_status = 'unloadable';
		diskfile.unloaded_reason = contents === null ? unloaded_reason : null;
		diskfile.content_error = null;
		diskfile.content = contents;
		untrack(() => this.#editor_states.get(diskfile.id))?.check_disk_changes();
	}

	#is_live(diskfile: Diskfile): boolean {
		return this.items.by_id.get(diskfile.id) === diskfile && !diskfile.deleted_on_disk;
	}

	/** Shown files read first: the selected tab's, then any open tab's, then the rest. */
	#read_priority(diskfile: Diskfile): number {
		return untrack(() => {
			if (this.editor.tabs.selected_diskfile_id === diskfile.id) return 0;
			if (this.editor.tabs.by_diskfile_id.has(diskfile.id)) return 1;
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
	 * Seed diskfiles from an initial file tree (e.g. session load or workspace open).
	 * Upserts by path, so overlapping seeds don't duplicate.
	 *
	 * @param files - the snapshot's file tree
	 * @param changes - what `filer_change` reported while the snapshot was in
	 * flight (see `track_changes`)
	 */
	add_initial(files: Array<SerializableDisknode>, changes?: DiskfileSnapshotChanges): void {
		this.#upsert_snapshot(files, changes?.paths);
		this.#apply_touches(changes);
	}

	#upsert_snapshot(files: Array<SerializableDisknode>, skip_paths?: ReadonlySet<string>): void {
		for (const disknode of files) {
			if (skip_paths?.has(disknode.id)) continue;
			this.upsert(disknode);
		}
	}

	/**
	 * Applies the touches reported while a snapshot was in flight again, now
	 * that the snapshot is in — except for a path a full change was reported
	 * for (see `track_changes`).
	 */
	#apply_touches(changes: DiskfileSnapshotChanges | undefined): void {
		if (!changes) return;
		// metadata only — each touch already re-read or dropped its file's content when it arrived
		for (const [path, metadata] of changes.touches) {
			if (!changes.paths.has(path)) this.#apply_metadata(metadata);
		}
	}

	/**
	 * Replaces the file tree under `roots` with a session snapshot's: upserts
	 * every snapshot file (like `add_initial`), and removes each known file under
	 * a root that the snapshot lacks, via `remove_by_path` — so a file open with
	 * unsaved edits is kept, flagged `deleted_on_disk`. Files outside every root
	 * are left alone, since the snapshot says nothing about them.
	 *
	 * @param files - the snapshot's file tree
	 * @param roots - the directories (trailing `/`) whose complete trees `files` holds
	 * @param options.changes - what `filer_change` reported while the snapshot
	 *   was in flight (see `track_changes`): a path with a full change is
	 *   neither upserted nor removed
	 * @param options.skip_dirs - directories (trailing `/`) whose files aren't
	 *   removed, e.g. workspaces opened while the snapshot was in flight
	 */
	reconcile(
		files: Array<SerializableDisknode>,
		roots: ReadonlyArray<string>,
		options?: { changes?: DiskfileSnapshotChanges; skip_dirs?: ReadonlyArray<string> }
	): void {
		const changes = options?.changes;
		const skip_paths = changes?.paths;
		const skip_dirs = options?.skip_dirs ?? [];
		this.#upsert_snapshot(files, skip_paths);
		this.#prune_unlisted(files, roots, skip_paths, skip_dirs);
		this.#apply_touches(changes);
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
			this.remove_by_path(path);
		}
	}

	/**
	 * Handles the diskfile at `path` being gone from disk.
	 *
	 * If it has a draft — edited in a tab, a file part, anywhere — it's kept,
	 * flagged `deleted_on_disk` with its tabs and editing state intact, so the
	 * user can save it back (recreating the file) or discard the draft (see
	 * `release_if_unneeded`). Otherwise it's removed along with its tabs and
	 * editing state.
	 */
	remove_by_path(path: string): void {
		const diskfile = this.items.by_optional('by_path', path);
		if (!diskfile) return;

		if (this.#editor_states.get(diskfile.id)?.has_unsaved_edits) {
			this.set_deleted_on_disk(diskfile, true);
			return;
		}

		this.#forget(diskfile);
	}

	/**
	 * Forgets diskfile `id` if it's deleted on disk and nothing holds it anymore
	 * — no draft and no tab. Called when its draft is discarded and when its
	 * last tab closes.
	 */
	release_if_unneeded(id: Uuid): void {
		const diskfile = this.items.by_id.get(id);
		if (
			diskfile?.deleted_on_disk &&
			!this.#editor_states.get(id)?.has_unsaved_edits &&
			!this.editor.tabs.by_diskfile_id.has(id)
		) {
			this.#forget(diskfile);
		}
	}

	/**
	 * Called when a diskfile's last tab closes. A diskfile deleted on disk with
	 * no draft left is forgotten now (see `release_if_unneeded`). Otherwise its
	 * editing state resets what it shows (`DiskfileEditorState.reset_view`), so
	 * a reopen shows the draft if there is one, else the disk content.
	 */
	handle_diskfile_detached(diskfile_id: Uuid): void {
		this.release_if_unneeded(diskfile_id);
		this.#editor_states.get(diskfile_id)?.reset_view();
	}

	/**
	 * Removes a diskfile with its editor tabs and editing state (disposed with
	 * the diskfile). If it was selected, selection follows the editor's newly
	 * selected tab, or clears.
	 */
	#forget(diskfile: Diskfile): void {
		// remove first, so closing its tabs re-entering `handle_diskfile_detached` is a no-op
		this.items.remove(diskfile.id);
		this.editor.remove_diskfile(diskfile.id);

		if (this.selected_file_id === diskfile.id) {
			this.selected_file_id = this.editor.tabs.selected_diskfile_id;
		}
	}

	/**
	 * Writes `content` to the file at `path`. The local `Diskfile` changes only
	 * when the resulting `filer_change` broadcast arrives, not from the response.
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
		content: string
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
		return this.app.api.diskfile_update({ path, content });
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
	 * workspace's, `null` when no workspace is open.
	 */
	readonly new_files_dir: DiskfileDirectoryPath | null = $derived(
		this.app.workspaces.active?.path ?? null
	);

	/**
	 * The directories the file index covers, each with a trailing `/`: the app
	 * directory, the scoped dirs, and the open workspaces.
	 */
	readonly indexed_roots: ReadonlyArray<DiskfileDirectoryPath> = $derived.by(() => {
		const { zzz_dir, scoped_dirs, workspaces } = this.app;
		const roots: Array<DiskfileDirectoryPath> = zzz_dir ? [zzz_dir] : [];
		roots.push(...scoped_dirs);
		for (const workspace of workspaces.items.values) roots.push(workspace.path);
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

	/** The files in the collection that are deleted on disk, by id — see `listed_deleted`. */
	readonly #deleted_files: SvelteMap<Uuid, Diskfile> = new SvelteMap();

	/**
	 * The files `listed` holds that are deleted on disk — kept for their drafts,
	 * so missing from `tree_index`. Tracks only those few files, not the
	 * whole collection.
	 */
	readonly listed_deleted: Array<Diskfile> = $derived(
		Array.from(this.#deleted_files.values()).filter(
			(diskfile) => !!this.#editor_states.get(diskfile.id)?.has_unsaved_edits
		)
	);

	/**
	 * The directories holding a file on disk, each with a trailing `/` —
	 * changing only as a directory gains its first file or loses its last.
	 */
	readonly directory_paths: ReadonlySet<string> = this.#directory_paths;

	/**
	 * Marks `diskfile` gone from disk, or back — the one writer of
	 * `Diskfile.deleted_on_disk` besides `upsert`, so `directory_paths` stays
	 * in step. A delete also ends any showing of the disk version
	 * (`DiskfileEditorState.showing_disk`), so the file reappearing shows the
	 * draft, not the disk.
	 */
	set_deleted_on_disk(diskfile: Diskfile, deleted_on_disk: boolean): void {
		if (diskfile.deleted_on_disk === deleted_on_disk) return;
		diskfile.deleted_on_disk = deleted_on_disk;
		if (deleted_on_disk) this.#editor_states.get(diskfile.id)?.set_showing_disk(false);
		this.#sync_directories(diskfile);
	}

	/**
	 * Brings `#directory_counts` and `tree_index` in step with the file
	 * `diskfile`'s id names: it counts while it's in the collection and on
	 * disk, under its current path and root. Called after every change to any
	 * of those. Reads the collection's own object for the id when there is one,
	 * so a stale or rejected object (an `add` of an id already present) can't
	 * uncount the file that's there. Also keeps `#deleted_files`.
	 */
	#sync_directories(diskfile: Diskfile): void {
		untrack(() => {
			const counted = this.#counted_files.get(diskfile.id);
			const live = this.items.by_id.get(diskfile.id);
			const counts = !!live && !live.deleted_on_disk;
			if (live?.deleted_on_disk) {
				if (!this.#deleted_files.has(diskfile.id)) this.#deleted_files.set(diskfile.id, live);
			} else if (this.#deleted_files.has(diskfile.id)) {
				this.#deleted_files.delete(diskfile.id);
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
		const get_roots = () => this.indexed_roots;
		return {
			has_file: (path) => {
				const diskfile = this.get_by_path(path as DiskfilePath);
				return !!diskfile && !diskfile.deleted_on_disk;
			},
			has_directory: (path) => this.#directory_paths.has(path),
			get roots() {
				return get_roots();
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
		if (!diskfile || diskfile.deleted_on_disk) return false;
		const fragment = options?.fragment;
		if (fragment && to_diskfile_content_kind(diskfile.path) === 'markdown') {
			this.get_editor_state(diskfile).markdown_pending_fragment = fragment;
		}
		this.select(diskfile.id, options?.open_not_preview);
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
	 * @throws Error when no workspace is open, the name is refused, the file
	 * already exists, or the write fails
	 */
	async create_file(filename: string, content: string = ''): Promise<void> {
		const dir = this.new_files_dir;
		if (!dir) {
			throw new Error('cannot create file: no workspace is open');
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
	 * (`to_unindexed_segment`), which isn't waited for. It's revealed in the
	 * tree then too (`DiskfileTreeState.reveal_created`), which the tree mode
	 * shows, now or on a later switch to it — so a copy made by "edit a copy"
	 * in the audio and transcript views is revealed as well.
	 *
	 * @param path - the new file's absolute path
	 * @param content - the new file's content
	 * @throws Error when the file already exists or the write fails
	 */
	async create_file_at(path: DiskfilePath, content: string = ''): Promise<void> {
		this.#select_on_arrival = null;

		const result = await this.app.api.diskfile_create({ path, content });
		if (!result.ok) {
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			throw new Error(reason === 'already_exists' ? 'already exists' : result.error.message);
		}

		// the backend normalizes the path, and the filer reports it that way
		const created_path = parse_or_throw(DiskfilePath, normalize_path(path));
		const created = this.get_by_path(created_path);
		if (created) {
			this.select(created.id, true);
			this.editor.tree.reveal_created(created_path);
		} else {
			// a path the file index skips never arrives — don't wait for it
			const root = to_innermost_root(created_path, this.indexed_roots);
			if (root && to_unindexed_segment(created_path, root) === null) {
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
		this.selected_file_id = this.editor.tabs.selected_diskfile_id;
	}

	/**
	 * Called when the workspace at `path` is removed: a file created there that
	 * hasn't arrived won't be selected if it arrives later.
	 */
	handle_workspace_removed(path: DiskfileDirectoryPath): void {
		if (this.#select_on_arrival?.startsWith(path)) this.#select_on_arrival = null;
	}

	/**
	 * Creates a new directory in `new_files_dir`.
	 *
	 * @param dirname - the directory's path relative to `new_files_dir`, parsed
	 * by `parse_new_diskfile_name` as for `create_file`, except that its last
	 * segment may be empty, `.`, or `..` (`src/`, `a/b/..`)
	 * @throws Error when no workspace is open, the name is refused or already
	 * taken, or the backend refuses
	 */
	async create_directory(dirname: string): Promise<void> {
		const dir = this.new_files_dir;
		if (!dir) {
			throw new Error('cannot create folder: no workspace is open');
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
	 * @param path - the new directory's absolute path
	 * @throws Error when the path is taken, or the backend refuses
	 */
	async create_directory_at(path: DiskfilePath): Promise<void> {
		const result = await this.app.api.directory_create({ path });
		if (!result.ok) {
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			throw new Error(reason === 'already_exists' ? 'already exists' : result.error.message);
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
	 * Select a diskfile by id and also update the editor tabs.
	 * Default to the first file if `id` is `undefined`.
	 * If `id` is `null`, it selects no file.
	 * If `open_not_preview` is `true`, opens as a permanent tab, otherwise previews.
	 */
	select(id: Uuid | null | undefined, open_not_preview: boolean = false): void {
		this.#select_on_arrival = null;
		if (id === undefined) {
			this.select_next();
		} else {
			this.selected_file_id = id;

			// Update the editor if a file is selected
			if (id !== null) {
				if (open_not_preview) {
					this.editor.open_diskfile(id);
				} else {
					this.editor.preview_diskfile(id);
				}
			}
		}
	}

	select_next(): void {
		this.select(this.on_disk[0]?.id ?? null);
	}
}

/** Whether `path` is inside one of `dirs` (each with a trailing `/`). */
const is_under_any = (path: string, dirs: ReadonlyArray<string>): boolean =>
	dirs.some((dir) => path.startsWith(dir));

/** Whether `diskfile` already holds everything `upsert` would take from `disknode`. */
const diskfile_matches = (diskfile: Diskfile, disknode: SerializableDisknode): boolean =>
	diskfile.content === disknode.contents && diskfile.source_dir === disknode.source_dir;
