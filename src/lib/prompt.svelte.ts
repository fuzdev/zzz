import {
	array,
	string,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { to_preview, estimate_token_count } from './helpers.ts';
import { Part, PartJson, type PartUnion } from './part.svelte.ts';
import { reorder_list } from './list_helpers.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { format_prompt_content } from './prompt_helpers.ts';
import { create_collection_decoder } from './cell_helpers.ts';

export interface PromptMessage {
	role: 'user' | 'system'; // TODO assistant? string? eh?
	content: Array<PromptActionContent>;
}

export type PromptActionContent = string; // TODO ?

export const PromptJson = cell_json_schema(
	{
		name: with_default(string, ''),
		parts: with_default_fn(array(PartJson), () => [])
	},
	'Prompt'
);
export type PromptJson = Infer<typeof PromptJson>;
export type PromptJsonInput = InferInput<typeof PromptJson>;

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

		this.decoders = {
			// `Part` is abstract, so each part is created as its concrete subclass
			parts: create_collection_decoder(
				() => this.remove_all_parts(),
				(json) => this.add_part(Part.create(this.app, json))
			)
		};

		this.init();
	}

	/**
	 * Add a part to this prompt.
	 */
	add_part(part: PartUnion): PartUnion {
		this.parts.push(part);
		return part;
	}

	/**
	 * Remove and dispose a part — a prompt's parts are its own, not shared.
	 */
	remove_part(id: Uuid): boolean {
		const index = this.parts.findIndex((f) => f.id === id);
		if (index !== -1) {
			const [part] = this.parts.splice(index, 1);
			part!.dispose(); // guaranteed by the index check
			return true;
		}
		return false;
	}

	/**
	 * Remove and dispose all parts.
	 */
	remove_all_parts(): void {
		const { parts } = this;
		this.parts = [];
		if (!parts) return; // not yet decoded
		for (const part of parts) {
			part.dispose();
		}
	}

	/**
	 * Disposes the prompt's parts along with it.
	 */
	override dispose(): void {
		this.remove_all_parts();
		super.dispose();
	}

	reorder_parts(from_index: number, to_index: number): void {
		reorder_list(this.parts, from_index, to_index);
	}
}
