import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {DiskfileDirectoryPath} from './diskfile_types.js';

export const SpaceJson = CellJson.extend({
	name: z.string().default(''),
	directory_paths: z.array(DiskfileDirectoryPath).default(() => []),
}).meta({cell_class_name: 'Space'});
export type SpaceJson = z.infer<typeof SpaceJson>;
export type SpaceJsonInput = z.input<typeof SpaceJson>;

export interface SpaceOptions extends CellOptions<typeof SpaceJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Space extends Cell<typeof SpaceJson> {
	name: string = $state()!;
	directory_paths: Array<DiskfileDirectoryPath> = $state()!;

	readonly directory_count: number = $derived(this.directory_paths.length);

	/**
	 * Directory paths filtered to only include those backed by an open workspace.
	 * Stale entries (from closed workspaces) are excluded.
	 */
	readonly active_directory_paths: Array<DiskfileDirectoryPath> = $derived(
		this.directory_paths.filter((p) => this.app.workspaces.get_by_path(p) !== undefined),
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
