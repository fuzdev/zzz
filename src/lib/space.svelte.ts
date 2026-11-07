import {
	array,
	string,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { DiskfileDirectoryPath } from './diskfile_types.ts';

export const SpaceJson = cell_json_schema(
	{
		name: with_default(string, ''),
		directory_paths: with_default_fn(array(DiskfileDirectoryPath), () => [])
	},
	'Space'
);
export type SpaceJson = Infer<typeof SpaceJson>;
export type SpaceJsonInput = InferInput<typeof SpaceJson>;

export interface SpaceOptions extends CellOptions<typeof SpaceJson> {}

export class Space extends Cell<typeof SpaceJson> {
	name: string = $state.raw()!;
	directory_paths: Array<DiskfileDirectoryPath> = $state()!;

	readonly directory_count: number = $derived(this.directory_paths.length);

	/**
	 * Directory paths filtered to only include those backed by an open workspace.
	 * Stale entries (from closed workspaces) are excluded.
	 */
	readonly active_directory_paths: Array<DiskfileDirectoryPath> = $derived(
		this.directory_paths.filter((p) => this.app.workspaces.get_by_path(p) !== undefined)
	);

	constructor(options: SpaceOptions) {
		super(SpaceJson, options);
		this.init();
	}

	// TODO: callers should ensure the path is an open workspace (call workspace_open first) — this method is sync so it can't do it itself
	// TODO: space state is in-memory only — directory_paths lost on refresh, needs DB persistence to converge with workspace JSON persistence
	add_directory(path: DiskfileDirectoryPath): void {
		if (!this.directory_paths.includes(path)) {
			this.directory_paths.push(path);
		}
	}

	remove_directory(path: DiskfileDirectoryPath): void {
		const index = this.directory_paths.indexOf(path);
		if (index !== -1) {
			this.directory_paths.splice(index, 1);
		}
	}
}
