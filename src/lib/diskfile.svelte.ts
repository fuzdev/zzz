import {z} from 'zod';
import {strip_start} from '@fuzdev/fuz_util/string.ts';

import {Cell, type CellOptions} from './cell.svelte.ts';
import {
	DiskfileDirectoryPath,
	DiskfileJson,
	type DiskfilePath,
	type SerializableDisknode,
} from './diskfile_types.ts';
import {to_preview} from './helpers.ts';
import type {PartUnion} from './part.svelte.ts';

// TODO support directories/folders

export interface DiskfileOptions extends CellOptions<typeof DiskfileJson> {}

export class Diskfile extends Cell<typeof DiskfileJson> {
	path: DiskfilePath = $state.raw()!;
	source_dir: DiskfileDirectoryPath = $state.raw()!;

	content: string | null = $state.raw()!;

	readonly part: PartUnion | undefined = $derived(
		this.app.parts.find_part_by_diskfile_path(this.path),
	);

	// TODO @many add UI support for deps for module diskfiles (TS, Svelte, etc)
	dependents: Array<[DiskfilePath, SerializableDisknode]> = $state.raw()!; // TODO @many these need to be null for unknown file types (support JS modules, etc)
	dependencies: Array<[DiskfilePath, SerializableDisknode]> = $state.raw()!; // TODO @many these need to be null for unknown file types (support JS modules, etc)

	readonly dependencies_count: number = $derived(this.dependencies.length);
	readonly dependents_count: number = $derived(this.dependents.length);

	/** e.g. .zzz/foo/bar.json */
	readonly pathname: string | null | undefined = $derived(
		this.path && this.app.zzz_dir && strip_start(this.path, this.app.zzz_dir),
	);
	/** e.g. bar/foo.json */
	readonly path_relative: string | null | undefined = $derived(
		this.app.diskfiles.to_relative_path(this.path),
	);

	readonly content_length: number = $derived(this.content?.length ?? 0);
	readonly content_preview: string = $derived(to_preview(this.content));

	constructor(options: DiskfileOptions) {
		super(DiskfileJson, options);
		this.init();
	}
}

export const DiskfileSchema = z.instanceof(Diskfile);
