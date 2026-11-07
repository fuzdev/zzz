import {
	array,
	boolean,
	pipe,
	string,
	transform,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { cell_json_schema } from './cell_types.ts';
import { TurnJson } from './turn_types.ts';

// TODO add thread name and make it editable
export const ThreadJson = cell_json_schema(
	{
		// '' means no model is selected
		model_name: with_default(
			pipe(
				string,
				transform((v: string) => v.trim())
			),
			''
		),
		turns: with_default_fn(array(TurnJson), () => []),
		enabled: with_default(boolean, true),
		/** The unsent draft for this thread's input, preserved across chat and thread switches. */
		main_input: with_default(string, '')
	},
	'Thread'
);
export type ThreadJson = Infer<typeof ThreadJson>;
export type ThreadJsonInput = InferInput<typeof ThreadJson>;
