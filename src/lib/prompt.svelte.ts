import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {to_preview, estimate_token_count} from './helpers.js';
import {PartJson, type PartUnion} from './part.svelte.js';
import {reorder_list} from './list_helpers.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {format_prompt_content} from './prompt_helpers.js';

export interface PromptMessage {
	role: 'user' | 'system'; // TODO assistant? string? eh?
	content: Array<PromptActionContent>;
}

export type PromptActionContent = string; // TODO ?

export const PromptJson = CellJson.extend({
	name: z.string().default(''),
	parts: z.array(PartJson).default(() => []),
}).meta({cell_class_name: 'Prompt'});
export type PromptJson = z.infer<typeof PromptJson>;
export type PromptJsonInput = z.input<typeof PromptJson>;

export interface PromptOptions extends CellOptions<typeof PromptJson> {
	name?: string;
}

export class Prompt extends Cell<typeof PromptJson> {
	name: string = $state.raw()!;
	parts: Array<PartUnion> = $state()!;

	readonly content: string = $derived(format_prompt_content(this.parts));

	readonly length: number = $derived(this.content.length);
	readonly token_count: number = $derived(estimate_token_count(this.content));
	readonly content_preview: string = $derived(to_preview(this.content));

	constructor(options: PromptOptions) {
		super(PromptJson, options);
		this.init();
	}

	/**
	 * Add a part to this prompt.
	 */
	add_part(part: PartUnion): PartUnion {
		this.parts.push(part);
		return part;
	}

	remove_part(id: Uuid): boolean {
		const index = this.parts.findIndex((f) => f.id === id);
		if (index !== -1) {
			this.parts.splice(index, 1);
			return true;
		}
		return false;
	}

	remove_all_parts(): void {
		this.parts = [];
	}

	reorder_parts(from_index: number, to_index: number): void {
		reorder_list(this.parts, from_index, to_index);
	}
}

export const PromptSchema = z.instanceof(Prompt);
