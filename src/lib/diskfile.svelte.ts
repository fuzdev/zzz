import {z} from 'zod';
import {strip_start} from '@fuzdev/fuz_util/string.js';

import {Cell, type CellOptions} from './cell.svelte.js';
import {
	DiskfileDirectoryPath,
	DiskfileJson,
	type DiskfilePath,
	type SerializableDisknode,
} from './diskfile_types.js';
import {to_preview, estimate_token_count} from './helpers.js';
import type {PartUnion} from './part.svelte.js';

// TODO support directories/folders

export interface DiskfileOptions extends CellOptions<typeof DiskfileJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Diskfile extends Cell<typeof DiskfileJson> {
	path: DiskfilePath = $state()!;
	source_dir: DiskfileDirectoryPath = $state()!;

	content: string | null = $state()!;

	readonly part: PartUnion | undefined = $derived(
		this.app.parts.find_part_by_diskfile_path(this.path),
	);

	// TODO @many add UI support for deps for module diskfiles (TS, Svelte, etc)
	dependents: Array<[DiskfilePath, SerializableDisknode]> = $state.raw()!; // TODO @many these need to be null for unknown file types (support JS modules, etc)
	dependencies: Array<[DiskfilePath, SerializableDisknode]> = $state.raw()!; // TODO @many these need to be null for unknown file types (support JS modules, etc)

	readonly dependencies_by_id: Map<DiskfilePath, SerializableDisknode> = $derived(
		new Map(this.dependencies),
	);
	readonly dependents_by_id: Map<DiskfilePath, SerializableDisknode> = $derived(
		new Map(this.dependents),
	);

	readonly dependency_ids: Array<DiskfilePath> = $derived(this.dependencies.map(([id]) => id));
	readonly dependent_ids: Array<DiskfilePath> = $derived(this.dependents.map(([id]) => id));

	readonly has_dependencies: boolean = $derived(this.dependencies.length > 0);
	readonly has_dependents: boolean = $derived(this.dependents.length > 0);

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
	readonly content_token_count: number | null = $derived(
		this.content === null ? null : estimate_token_count(this.content),
	);
	readonly content_preview: string = $derived(to_preview(this.content));

	constructor(options: DiskfileOptions) {
		super(DiskfileJson, options);
		this.init();
	}
}

export const DiskfileSchema = z.instanceof(Diskfile);
