import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
import { type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { estimate_token_count_from_length } from './helpers.ts';
import { joined_content_length } from './thread_helpers.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import type { PartUnion, TextPart } from './part.svelte.ts';
import {
	are_parts_loading,
	are_parts_pending_read,
	load_parts_content,
	to_part_not_loaded_marker
} from './part_helpers.ts';
import type { Frontend } from './frontend.svelte.ts';
import type { Thread } from './thread.svelte.ts';
import { TurnJson } from './turn_types.ts';
import { to_completion_truncation, type CompletionTruncation } from './response_helpers.ts';
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

	/**
	 * The parts' text joined. A file part whose file can't load (over 4 MiB,
	 * not UTF-8 text, or unreadable) contributes a marker naming the file and
	 * why (`to_part_not_loaded_marker`), so a send or a copy never silently
	 * drops it. A file part still loading, or with no file at its path,
	 * contributes nothing, so what sends or copies the turn awaits
	 * `load_content` (or `load_parts_content` over the turns) first.
	 */
	get content(): string {
		return this.parts
			.map((part) => to_part_not_loaded_marker(part) ?? part.content)
			.filter((c) => c != null)
			.join('\n\n');
	}

	/** Whether a file part's content is still on its way, so `content` lacks it for now. */
	readonly content_loading: boolean = $derived(are_parts_loading(this.parts));

	/** Whether `load_content` has reading to do — see `are_parts_pending_read`. */
	readonly content_pending_read: boolean = $derived(are_parts_pending_read(this.parts));

	/**
	 * Loads every file part's content, a failed read retried once
	 * (`load_parts_content`), then returns `content`.
	 */
	async load_content(): Promise<string> {
		await load_parts_content(() => this.parts);
		return this.content;
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

	/** `content.length`, summed from the parts' lengths rather than by joining their content. */
	readonly length: number = $derived(
		joined_content_length(
			this.parts.map((part) => to_part_not_loaded_marker(part)?.length ?? part.length)
		)
	);
	readonly token_count: number = $derived(estimate_token_count_from_length(this.length));

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

	/**
	 * Why the final response was cut off — the output token limit or the
	 * context window — or `null` when it finished. A truncated turn's content is
	 * a partial reply.
	 */
	readonly truncation: CompletionTruncation | null = $derived(
		to_completion_truncation(this.response)
	);

	readonly truncated: boolean = $derived(this.truncation !== null);

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
