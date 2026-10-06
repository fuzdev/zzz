import { z } from 'zod';

import { Cell, type CellOptions } from './cell.svelte.ts';
import {
	DiskfileDirectoryPath,
	DiskfileJson,
	type DiskfilePath,
	type SerializableDisknode
} from './diskfile_types.ts';
import { to_preview } from './helpers.ts';
import type { PartUnion } from './part.svelte.ts';

// TODO support directories/folders

export interface DiskfileOptions extends CellOptions<typeof DiskfileJson> {}

export class Diskfile extends Cell<typeof DiskfileJson> {
	path: DiskfilePath = $state.raw()!;
	source_dir: DiskfileDirectoryPath = $state.raw()!;

	content: string | null = $state.raw()!;

	mtime: number | null = $state.raw()!;

	/**
	 * The file is gone from disk, but this diskfile is kept because a tab holds
	 * unsaved edits for it. Transient client state, not serialized — cleared
	 * when the path reappears on disk.
	 */
	deleted_on_disk: boolean = $state.raw(false);

	readonly part: PartUnion | undefined = $derived(
		this.app.parts.find_part_by_diskfile_path(this.path)
	);

	// TODO @many add UI support for deps for module diskfiles (TS, Svelte, etc)
	dependents: SerializableDisknode['dependents'] = $state.raw()!; // TODO @many these need to be null for unknown file types (support JS modules, etc)
	dependencies: SerializableDisknode['dependencies'] = $state.raw()!; // TODO @many these need to be null for unknown file types (support JS modules, etc)

	readonly dependencies_count: number = $derived(this.dependencies.length);
	readonly dependents_count: number = $derived(this.dependents.length);

	/** e.g. `bar/foo.json` inside the zzz dir, or an absolute path outside it. */
	readonly path_relative: string | null | undefined = $derived(
		this.app.diskfiles.to_relative_path(this.path)
	);

	/**
	 * Whether the file's content was loaded. `false` when the backend sent
	 * `contents: null` — the file is over the 4 MiB index cap, not UTF-8 text,
	 * or unreadable — so `content` says nothing about what's on disk: it can't
	 * be edited or saved over (see `DISKFILE_CONTENT_NOT_LOADED_MESSAGE`).
	 */
	readonly content_loaded: boolean = $derived(this.content !== null);

	readonly content_length: number = $derived(this.content?.length ?? 0);
	readonly content_preview: string = $derived(to_preview(this.content));

	constructor(options: DiskfileOptions) {
		super(DiskfileJson, options);
		this.init();
	}
}

export const DiskfileSchema = z.instanceof(Diskfile);
