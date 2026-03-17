import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {Uuid} from './zod_helpers.js';

export const TerminalStatus = z.enum(['running', 'stopped', 'exited']);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const TerminalJson = CellJson.extend({
	name: z.string().default(''),
	command: z.string().default(''),
	args: z.array(z.string()).default(() => []),
	cwd: z.string().optional(),
	status: TerminalStatus.default('stopped'),
	exit_code: z.number().nullable().default(null),
	preset_id: Uuid.nullable().default(null),
}).meta({cell_class_name: 'Terminal'});
export type TerminalJson = z.infer<typeof TerminalJson>;
export type TerminalJsonInput = z.input<typeof TerminalJson>;

export interface TerminalOptions extends CellOptions<typeof TerminalJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Terminal extends Cell<typeof TerminalJson> {
	name: string = $state()!;
	command: string = $state()!;
	args: Array<string> = $state()!;
	cwd: string | undefined = $state();
	status: TerminalStatus = $state()!;
	exit_code: number | null = $state()!;
	preset_id: Uuid | null = $state()!;

	constructor(options: TerminalOptions) {
		super(TerminalJson, options);
		this.init();
	}
}
