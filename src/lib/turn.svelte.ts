import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

import {estimate_token_count} from './helpers.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {Uuid} from './zod_helpers.js';
import type {PartUnion} from './part.svelte.js';
import type {Frontend} from './frontend.svelte.js';
import {TurnJson} from './turn_types.js';
import type {CompletionRequest, CompletionResponse, CompletionRole} from './completion_types.js';

export interface TurnOptions extends CellOptions<typeof TurnJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

/**
 * Turn represents a conversation turn (like A2A Message).
 * Contextualizes parts within a conversation, providing role, metadata, and ordering.
 */
export class Turn extends Cell<typeof TurnJson> {
	part_ids: Array<Uuid> = $state()!;
	thread_id: Uuid | null | undefined = $state.raw();
	role: CompletionRole = $state.raw()!;
	request: CompletionRequest | undefined = $state.raw();
	response: CompletionResponse | undefined = $state.raw();
	error_message: string | undefined = $state.raw();

	readonly parts: Array<PartUnion> = $derived(
		this.part_ids
			.map((id) => this.app.parts.items.by_id.get(id))
			.filter((part): part is PartUnion => !!part),
	);

	get enabled(): boolean {
		return this.parts.length > 0 && this.parts.every((part) => part.enabled);
	}
	set enabled(value: boolean) {
		for (const part of this.parts) {
			part.enabled = value;
		}
	}

	get content(): string {
		return this.parts
			.map((part) => part.content)
			.filter((c) => c != null)
			.join('\n\n');
	}
	set content(value: string | null | undefined) {
		if (value != null && this.parts[0]) {
			this.parts[0].content = value;
		}
	}

	readonly length: number = $derived(this.content.length);
	readonly token_count: number = $derived(estimate_token_count(this.content));

	readonly raw_content: string | null | undefined = $derived(this.parts[0]?.content);
	readonly is_content_loaded: boolean = $derived(
		this.parts.length > 0 && this.parts.every((part) => part.content !== undefined),
	);
	readonly is_content_empty: boolean = $derived(
		this.parts.length === 0 || this.parts.every((part) => !part.content),
	);

	readonly pending: boolean = $derived(
		this.role === 'assistant' &&
			this.is_content_loaded &&
			this.is_content_empty &&
			!this.response &&
			!this.error_message,
	);

	constructor(options: TurnOptions) {
		super(TurnJson, options);
		this.init();
	}

	set_part(part: PartUnion): void {
		this.part_ids = [part.id];
	}

	add_part(part: PartUnion): void {
		if (!this.part_ids.includes(part.id)) {
			this.part_ids.push(part.id);
		}
	}

	remove_part(part_id: Uuid): boolean {
		const index = this.part_ids.indexOf(part_id);
		if (index !== -1) {
			this.part_ids.splice(index, 1);
			return true;
		}
		return false;
	}

	// // A2A protocol serialization (commented out for now)
	// toA2AMessage(): A2A_Message {
	// 	return {
	// 		role: this.role,
	// 		parts: this.parts.map(part => part.toA2APart())
	// 	};
	// }
}

export const create_turn_from_part = (
	part: PartUnion,
	role: CompletionRole,
	json: Partial<OmitStrict<TurnJson, 'role' | 'part_ids'>>,
): Turn => {
	return new Turn({
		app: part.app,
		json: {
			...json,
			role,
			part_ids: [part.id],
		},
	});
};

export const create_turn_from_text = (
	content: string,
	role: CompletionRole,
	json: Partial<OmitStrict<TurnJson, 'role' | 'part_ids'>>,
	app: Frontend,
): Turn => {
	const part = app.parts.add({type: 'text', content});
	return new Turn({
		app,
		json: {
			...json,
			role,
			part_ids: [part.id],
		},
	});
};

export const create_turn_from_parts = (
	parts: Array<PartUnion>,
	role: CompletionRole,
	json: Partial<OmitStrict<TurnJson, 'role' | 'part_ids'>>,
): Turn => {
	if (parts.length === 0) throw new Error('create_turn_from_parts requires at least one part');
	return new Turn({
		app: parts[0]!.app, // guaranteed by length check above
		json: {
			...json,
			role,
			part_ids: parts.map((b) => b.id),
		},
	});
};
