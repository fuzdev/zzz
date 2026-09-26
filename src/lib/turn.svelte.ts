import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { estimate_token_count } from './helpers.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import type { PartUnion, TextPart } from './part.svelte.ts';
import type { Frontend } from './frontend.svelte.ts';
import type { Thread } from './thread.svelte.ts';
import { TurnJson } from './turn_types.ts';
import type { CompletionRequest, CompletionResponse, CompletionRole } from './completion_types.ts';

export interface TurnOptions extends CellOptions<typeof TurnJson> {}

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
	cancelled: boolean = $state.raw()!;

	readonly parts: Array<PartUnion> = $derived(
		this.part_ids
			.map((id) => this.app.parts.items.by_id.get(id))
			.filter((part): part is PartUnion => !!part)
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

	/**
	 * The part completion output is written to — the first `TextPart` of an
	 * assistant turn. `null` for other roles and for turns without a text part,
	 * so completion output never writes through a `DiskfilePart` to disk.
	 */
	readonly completion_part: TextPart | null = $derived.by(() => {
		if (this.role !== 'assistant') return null;
		for (const part of this.parts) {
			if (part.type === 'text') return part;
		}
		return null;
	});

	readonly length: number = $derived(this.content.length);
	readonly token_count: number = $derived(estimate_token_count(this.content));

	readonly raw_content: string | null | undefined = $derived(this.parts[0]?.content);
	readonly is_content_loaded: boolean = $derived(
		this.parts.length > 0 && this.parts.every((part) => part.content !== undefined)
	);
	readonly is_content_empty: boolean = $derived(
		this.parts.length === 0 || this.parts.every((part) => !part.content)
	);

	/**
	 * True once the completion for this turn has ended — a final response arrived,
	 * it failed, or it was cancelled. Late streaming chunks are ignored after this.
	 */
	readonly settled: boolean = $derived(!!this.response || !!this.error_message || this.cancelled);

	readonly pending: boolean = $derived(
		this.role === 'assistant' && this.is_content_loaded && this.is_content_empty && !this.settled
	);

	constructor(options: TurnOptions) {
		super(TurnJson, options);
		this.init();
	}

	/**
	 * Appends streamed completion text to `completion_part`.
	 * @param text - the chunk to append
	 * @returns `false` if the turn has no `completion_part`, leaving it unchanged
	 */
	append_completion_text(text: string): boolean {
		const part = this.completion_part;
		if (!part) return false;
		part.content += text;
		return true;
	}

	/**
	 * Replaces the text of `completion_part` with a final completion response.
	 * @param text - the full response text
	 * @returns `false` if the turn has no `completion_part`, leaving it unchanged
	 */
	set_completion_text(text: string): boolean {
		const part = this.completion_part;
		if (!part) return false;
		part.content = text;
		return true;
	}

	set_part(part: PartUnion): void {
		this.part_ids = [part.id];
	}

	add_part(part: PartUnion): void {
		if (!this.part_ids.includes(part.id)) {
			this.part_ids.push(part.id);
		}
	}

	/**
	 * Removes a part from this turn, and from `app.parts` unless another turn
	 * still references it. Removing the `completion_part` while its thread's
	 * in-flight completion streams into this turn cancels that completion
	 * first — its output has nowhere to go. An idle turn is left as is.
	 *
	 * @returns whether the turn had the part
	 */
	remove_part(part_id: Uuid): boolean {
		const index = this.part_ids.indexOf(part_id);
		if (index === -1) return false;
		if (this.completion_part?.id === part_id) {
			this.#get_thread()?.cancel_pending_turn(this);
		}
		this.part_ids.splice(index, 1);
		this.app.parts.remove_unreferenced([part_id]);
		return true;
	}

	/**
	 * Cancels the completion streaming into this turn — through its thread when
	 * it's the thread's pending turn, so the request is aborted too — settling
	 * the turn so late chunks are ignored.
	 */
	cancel_completion(): void {
		if (!this.#get_thread()?.cancel_pending_turn(this)) this.cancelled = true;
	}

	#get_thread(): Thread | undefined {
		return this.thread_id ? this.app.threads.items.by_id.get(this.thread_id) : undefined;
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
	json: Partial<OmitStrict<TurnJson, 'role' | 'part_ids'>>
): Turn => {
	return new Turn({
		app: part.app,
		json: {
			...json,
			role,
			part_ids: [part.id]
		}
	});
};

export const create_turn_from_text = (
	content: string,
	role: CompletionRole,
	json: Partial<OmitStrict<TurnJson, 'role' | 'part_ids'>>,
	app: Frontend
): Turn => {
	const part = app.parts.add({ type: 'text', content });
	return new Turn({
		app,
		json: {
			...json,
			role,
			part_ids: [part.id]
		}
	});
};

export const create_turn_from_parts = (
	parts: Array<PartUnion>,
	role: CompletionRole,
	json: Partial<OmitStrict<TurnJson, 'role' | 'part_ids'>>
): Turn => {
	if (parts.length === 0) throw new Error('create_turn_from_parts requires at least one part');
	return new Turn({
		app: parts[0]!.app, // guaranteed by length check above
		json: {
			...json,
			role,
			part_ids: parts.map((b) => b.id)
		}
	});
};
