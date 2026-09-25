import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import { CompletionRequest, CompletionResponse, CompletionRole } from './completion_types.ts';

/**
 * Turn is a conversation turn (like A2A Message) that references one or more parts (content entities).
 * Turns contextualize reusable content within conversations, providing role, metadata, and ordering.
 */
export const TurnJson = CellJson.extend({
	part_ids: z.array(Uuid).default(() => []),
	thread_id: Uuid.nullable().optional(),
	role: CompletionRole,
	request: CompletionRequest.optional(),
	response: CompletionResponse.optional(),
	/**
	 * Set when a completion fails. The turn keeps any content that streamed in
	 * before the failure; errored turns are excluded from later completion history.
	 */
	error_message: z.string().optional(),
	/**
	 * Set when the user stops a completion before it finished. The turn keeps any
	 * partial content that streamed in, and stops showing as pending.
	 */
	cancelled: z.boolean().default(false)
}).meta({ cell_class_name: 'Turn' });
export type TurnJson = z.infer<typeof TurnJson>;
export type TurnJsonInput = z.input<typeof TurnJson>;

export const TurnSchema = z.instanceof(Cell);
