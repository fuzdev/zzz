import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';

export const TerminalPresetJson = CellJson.extend({
	name: z.string().default(''),
	command: z.string().default(''),
	args: z.array(z.string()).default(() => []),
	cwd: z.string().optional(),
}).meta({cell_class_name: 'TerminalPreset'});
export type TerminalPresetJson = z.infer<typeof TerminalPresetJson>;
export type TerminalPresetJsonInput = z.input<typeof TerminalPresetJson>;

export interface TerminalPresetOptions extends CellOptions<typeof TerminalPresetJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class TerminalPreset extends Cell<typeof TerminalPresetJson> {
	name: string = $state()!;
	command: string = $state()!;
	args: Array<string> = $state()!;
	cwd: string | undefined = $state()!;

	constructor(options: TerminalPresetOptions) {
		super(TerminalPresetJson, options);
		this.init();
	}
}
