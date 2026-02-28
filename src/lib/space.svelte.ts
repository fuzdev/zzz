import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';

export const SpaceJson = CellJson.extend({
	name: z.string().default(''),
	directory_paths: z.array(z.string()).default(() => []),
}).meta({cell_class_name: 'Space'});
export type SpaceJson = z.infer<typeof SpaceJson>;
export type SpaceJsonInput = z.input<typeof SpaceJson>;

export interface SpaceOptions extends CellOptions<typeof SpaceJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Space extends Cell<typeof SpaceJson> {
	name: string = $state()!;
	directory_paths: Array<string> = $state()!;

	readonly directory_count: number = $derived(this.directory_paths.length);

	constructor(options: SpaceOptions) {
		super(SpaceJson, options);
		this.init();
	}

	add_directory(path: string): void {
		if (!this.directory_paths.includes(path)) {
			this.directory_paths.push(path);
		}
	}

	remove_directory(path: string): void {
		const index = this.directory_paths.indexOf(path);
		if (index !== -1) {
			this.directory_paths.splice(index, 1);
		}
	}
}
