import {
	array,
	boolean,
	nullable,
	optional,
	string,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { cell_json_schema } from './cell_types.ts';
import { CompletionRequest, CompletionResponse, CompletionRole } from './completion_types.ts';

/**
 * Turn is a conversation turn (like A2A Message) that references one or more parts (content entities).
 * Turns contextualize reusable content within conversations, providing role, metadata, and ordering.
 */
export const TurnJson = cell_json_schema(
	{
		part_ids: with_default_fn(array(Uuid), () => []),
		thread_id: optional(nullable(Uuid)),
		role: CompletionRole,
		request: optional(CompletionRequest),
		response: optional(CompletionResponse),
		/**
		 * Set when a completion fails. The turn keeps any content that streamed in
		 * before the failure; errored turns are excluded from later completion history.
		 */
		error_message: optional(string),
		/**
		 * Set when the user stops a completion before it finished. The turn keeps any
		 * partial content that streamed in, and stops showing as pending.
		 */
		cancelled: with_default(boolean, false)
	},
	'Turn'
);
export type TurnJson = Infer<typeof TurnJson>;
export type TurnJsonInput = InferInput<typeof TurnJson>;
