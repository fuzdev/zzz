import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {Cell} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {CompletionRequest, CompletionResponse, CompletionRole} from './completion_types.js';

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
	error_message: z.string().optional(),
}).meta({cell_class_name: 'Turn'});
export type TurnJson = z.infer<typeof TurnJson>;
export type TurnJsonInput = z.input<typeof TurnJson>;

export const TurnSchema = z.instanceof(Cell);
