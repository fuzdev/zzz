import { z } from 'zod';

import { ModelName } from './model.svelte.ts';
import { CellJson } from './cell_types.ts';
import { TurnJson } from './turn_types.ts';

// TODO add thread name and make it editable
export const ThreadJson = CellJson.extend({
	model_name: ModelName.default(''),
	turns: z.array(TurnJson).default(() => []),
	enabled: z.boolean().default(true)
}).meta({ cell_class_name: 'Thread' });
export type ThreadJson = z.infer<typeof ThreadJson>;
export type ThreadJsonInput = z.input<typeof ThreadJson>;
