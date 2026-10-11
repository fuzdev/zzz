import { z } from 'zod';

import { CellJson } from './cell_types.ts';
import { TurnJson } from './turn_types.ts';

// TODO add thread name and make it editable
export const ThreadJson = CellJson.extend({
	// '' means no model is selected
	model_name: z.string().trim().default(''),
	turns: z.array(TurnJson).default(() => []),
	enabled: z.boolean().default(true),
	/** The unsent draft for this thread's input, preserved across chat and thread switches. */
	main_input: z.string().default('')
}).meta({ cell_class_name: 'Thread' });
export type ThreadJson = z.infer<typeof ThreadJson>;
export type ThreadJsonInput = z.input<typeof ThreadJson>;
