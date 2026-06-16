import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.ts';
import {CellJson} from './cell_types.ts';

export const TerminalPresetJson = CellJson.extend({
	name: z.string().default(''),
	command: z.string().default(''),
	args: z.array(z.string()).default(() => []),
	cwd: z.string().optional(),
}).meta({cell_class_name: 'TerminalPreset'});
export type TerminalPresetJson = z.infer<typeof TerminalPresetJson>;
export type TerminalPresetJsonInput = z.input<typeof TerminalPresetJson>;

export interface TerminalPresetOptions extends CellOptions<typeof TerminalPresetJson> {}

export class TerminalPreset extends Cell<typeof TerminalPresetJson> {
	name: string = $state.raw()!;
	command: string = $state.raw()!;
	args: Array<string> = $state.raw()!;
	cwd: string | undefined = $state.raw();

	constructor(options: TerminalPresetOptions) {
		super(TerminalPresetJson, options);
		this.init();
	}
}
