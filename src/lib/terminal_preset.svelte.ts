import {
	array,
	optional,
	string,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';

export const TerminalPresetJson = cell_json_schema(
	{
		name: with_default(string, ''),
		command: with_default(string, ''),
		args: with_default_fn(array(string), () => []),
		cwd: optional(string)
	},
	'TerminalPreset'
);
export type TerminalPresetJson = Infer<typeof TerminalPresetJson>;
export type TerminalPresetJsonInput = InferInput<typeof TerminalPresetJson>;

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
