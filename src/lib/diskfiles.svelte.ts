import { z } from 'zod';
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { strip_start } from '@fuzdev/fuz_util/string.ts';
import { Uuid } from '@fuzdev/fuz_util/id.ts';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { jsonrpc_error_messages } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Diskfile } from './diskfile.svelte.ts';
import {
	DiskfileJson,
	DiskfilePath,
	type DiskfileJsonInput,
	type SerializableDisknode
} from './diskfile_types.ts';
import {
	DISKFILE_CONTENT_NOT_LOADED_MESSAGE,
	ERROR_CONTENT_NOT_LOADED,
	disknode_to_diskfile_json,
	to_relative_path
} from './diskfile_helpers.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { HANDLED } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index } from './indexed_collection_helpers.svelte.ts';
import { DiskfilesEditor } from './diskfiles_editor.svelte.ts';
import { DiskfileEditorState } from './diskfile_editor_state.svelte.ts';
import { create_detached } from './reactive_helpers.svelte.ts';
import { CellJson } from './cell_types.ts';
import type { ActionInputs, ActionOutputs } from './action_collections.ts';

export const DiskfilesJson = CellJson.extend({
	diskfiles: z.array(DiskfileJson).default(() => []),
	selected_file_id: Uuid.nullable().default(null)
}).meta({ cell_class_name: 'Diskfiles' });
export type DiskfilesJson = z.infer<typeof DiskfilesJson>;
export type DiskfilesJsonInput = z.input<typeof DiskfilesJson>;

export interface DiskfilesOptions extends CellOptions<typeof DiskfilesJson> {}

/** Records the paths `filer_change` touches while a file-tree snapshot is in flight. */
export interface DiskfileChangeTracker {
	/** Paths `Diskfiles.handle_change` touched since tracking started. */
	readonly paths: ReadonlySet<string>;
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
			this.#remove_editor_state(diskfile.id);
			diskfile.dispose();
		},
		indexes: [
			create_single_index({
				key: 'by_path',
				extractor: (file) => file.path,
				query_schema: z.string(),
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

	/** The editor for managing diskfiles editing state. */
	readonly editor: DiskfilesEditor;

	constructor(options: DiskfilesOptions) {
		super(DiskfilesJson, options);

		this.editor = new DiskfilesEditor({ app: this.app });

		this.decoders = {
			diskfiles: (diskfiles) => {
				if (Array.isArray(diskfiles)) {
					this.items.clear();
					for (const diskfile_json of diskfiles) {
						this.add(diskfile_json);
					}
				}
				return HANDLED;
			}
		};

		this.init();
	}

	// not reactive — bookkeeping for snapshot requests in flight
	readonly #change_trackers: Set<Set<string>> = new Set();

	/**
	 * Starts recording the paths `handle_change` touches. Start it before
	 * requesting a file-tree snapshot and pass its `paths` to `add_initial`, so
	 * the snapshot doesn't overwrite what `filer_change` reported while the
	 * request was in flight — a notification is at least as new as the snapshot,
	 * so a file it deleted isn't resurrected and newer content isn't reverted.
	 */
	track_changes(): DiskfileChangeTracker {
		const paths: Set<string> = new Set();
		this.#change_trackers.add(paths);
		return { paths, stop: () => this.#change_trackers.delete(paths) };
	}

	/**
	 * Applies a `filer_change` notification. `add` and `change` both upsert by
	 * path — the backend's add/change split is advisory, and a re-seed or a
	 * missed delete must never leave two diskfiles for one path.
	 */
	handle_change(params: ActionInputs['filer_change']): void {
		for (const paths of this.#change_trackers) paths.add(params.disknode.id);
		switch (params.change.type) {
			case 'add':
			case 'change': {
				this.upsert(params.disknode);
				break;
			}
			case 'delete': {
				this.remove_by_path(params.disknode.id);
				break;
			}
		}
	}

	add(json: DiskfileJsonInput, auto_select: boolean = true): Diskfile {
		const diskfile = new Diskfile({ app: this.app, json });
		this.items.add(diskfile);

		if (auto_select && this.selected_file_id === null) {
			this.select(diskfile.id);
		}

		return diskfile;
	}

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
	 * way when its path reappears on disk. An existing diskfile whose content
	 * and dependency data already match is left untouched, so a resync that
	 * re-sends every file doesn't churn the unchanged ones. A content change is
	 * recorded in the file's editing state, if it has one
	 * (`DiskfileEditorState.check_disk_changes`).
	 */
	upsert(disknode: SerializableDisknode): Diskfile {
		const existing = this.items.by_optional('by_path', disknode.id);
		if (!existing) {
			return this.add(disknode_to_diskfile_json(disknode));
		}
		if (!existing.deleted_on_disk && diskfile_matches(existing, disknode)) {
			return existing;
		}
		existing.deleted_on_disk = false;
		existing.set_json({
			...disknode_to_diskfile_json(disknode, existing.id),
			// TODO hacky, should be handled more cleanly elsewhere
			created: existing.created, // Preserve original creation date
			updated: get_datetime_now() // TODO @many probably rely on the db to bump `updated`
		});
		untrack(() => this.#editor_states.get(existing.id))?.check_disk_changes();
		return existing;
	}

	/**
	 * Seed diskfiles from an initial file tree (e.g. session load or workspace open).
	 * Upserts by path, so overlapping seeds don't duplicate.
	 *
	 * @param files - the snapshot's file tree
	 * @param skip_paths - paths `filer_change` touched while the snapshot was in
	 * flight (see `track_changes`), whose snapshot entries are stale
	 */
	add_initial(files: Array<SerializableDisknode>, skip_paths?: ReadonlySet<string>): void {
		for (const disknode of files) {
			if (skip_paths?.has(disknode.id)) continue;
			this.upsert(disknode);
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
	 * @param options.skip_paths - paths `filer_change` touched while the snapshot
	 *   was in flight (see `track_changes`), neither upserted nor removed
	 * @param options.skip_dirs - directories (trailing `/`) whose files aren't
	 *   removed, e.g. workspaces opened while the snapshot was in flight
	 */
	reconcile(
		files: Array<SerializableDisknode>,
		roots: ReadonlyArray<string>,
		options?: { skip_paths?: ReadonlySet<string>; skip_dirs?: ReadonlyArray<string> }
	): void {
		const skip_paths = options?.skip_paths;
		const skip_dirs = options?.skip_dirs ?? [];
		this.add_initial(files, skip_paths);
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
			diskfile.deleted_on_disk = true;
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
	 * Refuses, without sending, to write over a known file whose content wasn't
	 * loaded (`Diskfile.content_loaded` — over 4 MiB, not UTF-8 text, or
	 * unreadable): nobody has seen what it would overwrite. Fails with
	 * `conflict` (`data.reason` `content_not_loaded`).
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
					`refusing to overwrite ${path}: ${DISKFILE_CONTENT_NOT_LOADED_MESSAGE}`,
					{ reason: ERROR_CONTENT_NOT_LOADED }
				)
			});
		}
		return this.app.api.diskfile_update({ path, content });
	}

	async delete(path: DiskfilePath): Promise<void> {
		const result = await this.app.api.diskfile_delete({ path });
		// Handler already updated state on error
		if (!result.ok) return;
	}

	/**
	 * Creates a new file under the zzz dir — never overwriting one: the
	 * backend's `diskfile_create` creates the final name exclusively, so an
	 * existing file (indexed or not) is left untouched.
	 *
	 * @throws Error when the zzz dir isn't set, the file already exists, or
	 * the write fails
	 */
	async create_file(filename: string, content: string = ''): Promise<void> {
		if (!this.app.zzz_dir) {
			throw new Error('cannot create file: zzz_dir is not set');
		}

		// zzz_dir already has trailing slash (DiskfileDirectoryPath), strip any leading slash from filename
		const path = DiskfilePath.parse(`${this.app.zzz_dir}${strip_start(filename, '/')}`);

		const result = await this.app.api.diskfile_create({ path, content });
		if (!result.ok) {
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			throw new Error(
				reason === 'already_exists' ? `${filename} already exists` : result.error.message
			);
		}
	}

	async create_directory(dirname: string): Promise<void> {
		if (!this.app.zzz_dir) {
			throw new Error('cannot create directory: zzz_dir is not set');
		}

		const path = DiskfilePath.parse(`${this.app.zzz_dir}${dirname}`);

		const result = await this.app.api.directory_create({ path });
		// Handler already updated state on error
		if (!result.ok) return;
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
	diskfile.content === disknode.contents &&
	diskfile.source_dir === disknode.source_dir &&
	dependency_lists_match(diskfile.dependents, disknode.dependents) &&
	dependency_lists_match(diskfile.dependencies, disknode.dependencies);

const dependency_lists_match = (
	a: ReadonlyArray<readonly [string, unknown]>,
	b: ReadonlyArray<readonly [string, unknown]>
): boolean => a.length === b.length && (a.length === 0 || JSON.stringify(a) === JSON.stringify(b));
