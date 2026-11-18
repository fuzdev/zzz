import { SvelteMap } from 'svelte/reactivity';
import { create_uuid, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import type { DiskfileDirectoryPath, DiskfilePath } from './diskfile_types.ts';
import type { Diskfiles } from './diskfiles.svelte.ts';

/**
 * Where a draft stands against the disk, derived — never set by a scope
 * change:
 *
 * - `dormant`: its file is under no open root (`Diskfiles.is_dormant`) — its
 *   project closed. It can't be saved; reopening the project binds it again,
 *   and its `base_hash` is checked against what the disk holds then.
 * - `bound`: the disk holds the version the draft is based on, as far as
 *   anything here knows (`Draft.base_hash`).
 * - `stale`: the disk moved since — its hash isn't `base_hash`, or the
 *   file's editing state saw it move (`DiskfileEditorState.disk_conflict`).
 *   The editor's conflict: overwrite, or keep the disk version.
 * - `deleted`: the file is gone from disk (`Diskfile.deleted_on_disk`);
 *   saving recreates it, exclusively.
 */
export type DraftStatus = 'dormant' | 'bound' | 'stale' | 'deleted';

export interface DraftOptions {
	diskfiles: Diskfiles;
	path: DiskfilePath;
	root: DiskfileDirectoryPath | null;
	text: string;
	base_hash: string | null;
	/** Defaults to now. */
	updated?: number;
}

/**
 * A file's unsaved edit — the tip of its editing, kept apart from the
 * `Diskfile` that mirrors the disk, so dropping the mirror never touches
 * it. One per path (`Drafts`). Page memory for now; the shape a workspace
 * persists later, keyed by `root` and `path`.
 */
export class Draft {
	/** New for each draft — a draft set aside and started again is another. */
	readonly id: Uuid = create_uuid();

	/** The file's path — moved only by a rename (`Drafts.move`), keeping the draft's `id`. */
	path: DiskfilePath = $state.raw()!;

	/**
	 * The innermost root that held `path` when the draft was made
	 * (`Diskfiles.indexed_roots`), `null` under none — recorded, not part of
	 * the key: a path can sit under several open roots, and which is
	 * innermost changes as nested projects open and close. Recomputed when a
	 * rename moves the draft (`Drafts.move`).
	 */
	root: DiskfileDirectoryPath | null = $state.raw()!;

	/** The edited text. */
	text: string = $state.raw()!;

	/**
	 * The BLAKE3 of the disk content the draft is based on — what a save
	 * sends as `expected_hash` — or `null` when that content came without a
	 * hash (seeded, not read), taken once a read of the same text brings
	 * one. Moves when the draft is rebased: our own save landing under it
	 * (its response, or its read landing first), or the user choosing to
	 * write over the disk.
	 */
	base_hash: string | null = $state.raw()!;

	/** When the text last changed (ms since the epoch). */
	updated: number = $state.raw()!;

	readonly #diskfiles: Diskfiles;

	/** See `DraftStatus`. */
	readonly status: DraftStatus = $derived.by(() => {
		const diskfiles = this.#diskfiles;
		if (diskfiles.is_dormant(this.path)) return 'dormant';
		if (diskfiles.peek(this.path)?.deleted_on_disk) return 'deleted';
		const disk_hash = diskfiles.to_known_disk_hash(this.path);
		if (disk_hash !== null && disk_hash !== this.base_hash) return 'stale';
		// the editor saw the disk change under it — what decides when either
		// hash is unknown (content seeded, not read)
		return diskfiles.find_editor_state(this.path)?.disk_conflict ? 'stale' : 'bound';
	});

	constructor(options: DraftOptions) {
		this.#diskfiles = options.diskfiles;
		this.path = options.path;
		this.root = options.root;
		this.text = options.text;
		this.base_hash = options.base_hash;
		this.updated = options.updated ?? Date.now();
	}

	/**
	 * Replaces the text, dating it now (never earlier than before).
	 *
	 * @mutates this - sets `text` and `updated`
	 */
	set_text(text: string): void {
		this.text = text;
		this.updated = Math.max(Date.now(), this.updated);
	}
}

/**
 * The files' drafts, by path — at most one each. Owned by `Diskfiles`; a
 * draft is written by the file's `DiskfileEditorState`, kept apart so it
 * can outlive it and the file's cell (for now the editing state stays while
 * it has a draft). A draft keeps a file the index no longer has
 * (`Diskfiles.release_uncovered`, `remove_by_path`).
 */
export class Drafts {
	readonly #diskfiles: Diskfiles;
	readonly #by_path: SvelteMap<DiskfilePath, Draft> = new SvelteMap();

	constructor(diskfiles: Diskfiles) {
		this.#diskfiles = diskfiles;
	}

	/** How many files have a draft. Reactive. */
	get size(): number {
		return this.#by_path.size;
	}

	/** The draft of the file at `path`, if it has one. Reactive. */
	get(path: DiskfilePath): Draft | undefined {
		return this.#by_path.get(path);
	}

	/** Whether the file at `path` has a draft. Reactive. */
	has(path: DiskfilePath): boolean {
		return this.#by_path.has(path);
	}

	values(): IterableIterator<Draft> {
		return this.#by_path.values();
	}

	/**
	 * Starts a draft of `text` for the file at `path`, based on the disk
	 * content hashed `base_hash`, replacing any draft it had.
	 *
	 * @mutates this - sets the path's draft
	 */
	create(path: DiskfilePath, text: string, base_hash: string | null): Draft {
		const draft = new Draft({
			diskfiles: this.#diskfiles,
			path,
			root: this.#diskfiles.to_innermost_root(path),
			text,
			base_hash
		});
		this.#by_path.set(path, draft);
		return draft;
	}

	/**
	 * Removes the file's draft — `id`'s only, when given, so a caller holding
	 * an older draft can't remove a newer one.
	 *
	 * @returns whether a draft was removed
	 * @mutates this - drops the path's draft
	 */
	remove(path: DiskfilePath, id?: Uuid): boolean {
		const draft = this.#by_path.get(path);
		if (!draft || (id !== undefined && draft.id !== id)) return false;
		return this.#by_path.delete(path);
	}

	/**
	 * Follows a renamed file: its draft, the same one (its `id` is what the
	 * editor's history and the close dialog track), moves from `from` to
	 * `to`, its `root` recomputed for the new path. The caller (`Diskfiles`)
	 * refuses a rename onto a path that has a draft.
	 *
	 * @returns whether a draft moved
	 * @mutates this - re-keys the draft, and sets its `path` and `root`
	 */
	move(from: DiskfilePath, to: DiskfilePath): boolean {
		const draft = this.#by_path.get(from);
		if (!draft || this.#by_path.has(to)) return false;
		this.#by_path.delete(from);
		draft.path = to;
		draft.root = this.#diskfiles.to_innermost_root(to);
		this.#by_path.set(to, draft);
		return true;
	}

	/**
	 * Drops every draft.
	 *
	 * @mutates this - empties it
	 */
	clear(): void {
		this.#by_path.clear();
	}
}
