import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import type { Model } from './model.svelte.ts';
import { Turn, create_turn_from_text, create_turn_from_part } from './turn.svelte.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { ThreadJson } from './thread_types.ts';
import { CompletionRequest, CompletionRole } from './completion_types.ts';
import { render_messages_to_string, render_completion_messages } from './thread_helpers.ts';
import type { PartUnion } from './part.svelte.ts';
import { HANDLED } from './cell_helpers.ts';
import { to_preview, estimate_token_count } from './helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import type { TurnJson } from './turn_types.ts';

// TODO add `thread.name` and lots of other things probably

export interface ThreadOptions extends CellOptions<typeof ThreadJson> {}
/**
 * A thread is a linear sequence of turns that maintains a chronological
 * record of interactions between the user and the AI.
 */
export class Thread extends Cell<typeof ThreadJson> {
	model_name: string = $state.raw()!;
	readonly model: Model | undefined = $derived.by(() =>
		this.app.models.find_by_name(this.model_name)
	);

	readonly turns: IndexedCollection<Turn> = new IndexedCollection({
		dispose_item: (turn) => turn.dispose()
	});

	enabled: boolean = $state.raw()!;

	main_input: string = $state.raw()!;
	readonly main_input_length: number = $derived(this.main_input.length);
	readonly main_input_token_count: number = $derived(estimate_token_count(this.main_input));

	readonly content: string = $derived(render_messages_to_string(this.turns.by_id.values()));

	readonly length: number = $derived(this.content.length);
	readonly token_count: number = $derived(estimate_token_count(this.content));
	readonly content_preview: string = $derived(to_preview(this.content));

	/** The ids of the parts of every turn. */
	get part_ids(): Array<Uuid> {
		const part_ids: Array<Uuid> = [];
		for (const turn of this.turns.by_id.values()) {
			part_ids.push(...turn.part_ids);
		}
		return part_ids;
	}

	// Imperative handle for the in-flight completion_create call. Not reactive —
	// UI state tracks `pending` below, which mirrors this controller's lifecycle.
	#pending_controller: AbortController | null = null;
	// The assistant turn receiving the in-flight completion, settled on cancel.
	#pending_turn: Turn | null = null;

	/**
	 * Reactive flag: true while `send_message` has an in-flight `completion_create`.
	 * Owned by the thread so multiple views of the same thread stay in sync.
	 * Callers that bypass `send_message` and call `app.api.completion_create`
	 * directly will not update this flag.
	 */
	pending: boolean = $state.raw(false);

	constructor(options: ThreadOptions) {
		super(ThreadJson, options);

		this.decoders = {
			turns: (items) => {
				if (Array.isArray(items)) {
					this.#clear_turns();
					for (const item_json of items) {
						this.add_turn(new Turn({ app: this.app, json: item_json }));
					}
				}
				return HANDLED;
			}
		};

		this.init();
	}

	/**
	 * Add a turn to this thread.
	 */
	add_turn(turn: Turn): void {
		turn.thread_id = this.id;
		this.turns.add(turn);
	}

	/**
	 * Create and add a user turn with the given content.
	 */
	add_user_turn(content: string, request?: CompletionRequest): Turn {
		const turn = create_turn_from_text(content, 'user', { thread_id: this.id, request }, this.app);
		this.add_turn(turn);
		return turn;
	}

	/**
	 * Create and add an assistant turn with the given content.
	 */
	add_assistant_turn(content: string, json?: Partial<TurnJson>): Turn {
		const turn = create_turn_from_text(
			content,
			'assistant',
			{ ...json, thread_id: this.id },
			this.app
		);
		this.add_turn(turn);
		return turn;
	}

	/**
	 * Create and add a system turn with the given content.
	 */
	add_system_turn(content: string): Turn {
		const turn = create_turn_from_text(content, 'system', { thread_id: this.id }, this.app);
		this.add_turn(turn);
		return turn;
	}

	/**
	 * Create and add a turn from a part.
	 */
	add_turn_from_part(part: PartUnion, role: CompletionRole): Turn {
		const turn = create_turn_from_part(part, role, {
			thread_id: this.id
		});
		this.add_turn(turn);
		return turn;
	}

	/**
	 * Remove and dispose all turns from this thread, cancelling any in-flight
	 * completion first since its turn is going away, and remove the turns' parts
	 * from `app.parts` unless another turn references them.
	 */
	remove_all_turns(): void {
		const { part_ids } = this;
		this.#clear_turns();
		this.app.parts.remove_unreferenced(part_ids);
	}

	/**
	 * Cancels any in-flight completion and disposes the thread's turns.
	 * Their parts are left to whoever removes the thread (see `Threads.remove`),
	 * since disposal also happens when a decoder replaces the collection.
	 */
	override dispose(): void {
		this.#clear_turns();
		super.dispose();
	}

	#clear_turns(): void {
		this.cancel_pending();
		this.turns.clear();
	}

	/**
	 * Send a message to the AI and create corresponding turns.
	 * Returns null if a send is already in flight, or if the model or provider
	 * is unavailable (defensive checks - UI should prevent these).
	 */
	async send_message(content: string): Promise<Turn | null> {
		// TODO rethink this API with the completion request/response (see OpenAI/MCP/A2A)
		// TODO maybe do this in the `completion_create: {send_request:` handler?

		if (this.pending) {
			console.warn('[thread.send_message] a send is already in flight, skipping send');
			return null;
		}

		const model = this.model;
		if (!model) {
			console.warn(`[thread.send_message] model '${this.model_name}' not found, skipping send`);
			return null;
		}

		// Pre-flight check: verify provider is available (defensive - UI should prevent this)
		const provider_status = this.app.lookup_provider_status(model.provider_name);
		if (provider_status && !provider_status.available) {
			console.warn(
				`[thread.send_message] provider '${model.provider_name}' unavailable, skipping send`
			);
			return null; // No turn created - UI already shows error
		}

		const completion_messages = render_completion_messages(this.turns.by_id.values());

		const user_turn = this.add_user_turn(content);

		const completion_request = CompletionRequest.parse({
			created: user_turn.created,
			provider_name: model.provider_name,
			model: model.name,
			prompt: content,
			completion_messages
		});

		// Create assistant turn with the request info so streaming updates can find it
		const assistant_turn = this.add_assistant_turn('', { request: completion_request });

		// Update the user turn with the request
		user_turn.request = completion_request;

		// Send the prompt with thread history. Attach an AbortController so the
		// user can stop long streams mid-flight — the server's completion handler
		// cooperates via ctx.signal and the frontend WS client translates abort
		// into a `request_cancelled` JSON-RPC error.
		const controller = new AbortController();
		this.#pending_controller = controller;
		this.#pending_turn = assistant_turn;
		this.pending = true;
		try {
			await this.app.api.completion_create(
				{
					completion_request,
					_meta: { progressToken: assistant_turn.id }
				},
				{ signal: controller.signal }
			);
		} finally {
			// Only clear if this is still the active controller — a concurrent
			// send is guarded against above, but this is cheap insurance.
			if (this.#pending_controller === controller) {
				this.#pending_controller = null;
				this.#pending_turn = null;
				this.pending = false;
			}
		}
		// Result not needed - handlers update turn, which contains error content if failed

		return assistant_turn;
	}

	/**
	 * Abort the in-flight `completion_create` call (if any). Safe to call when
	 * nothing is pending — no-op. The frontend WS client rejects the pending
	 * promise with `request_cancelled` and fires a `cancel` notification so the
	 * server can stop its provider stream.
	 *
	 * The in-flight assistant turn is marked `cancelled` (unless it already
	 * settled) so it stops showing as pending even if no content streamed in,
	 * and any late streaming chunks are ignored.
	 */
	cancel_pending(): void {
		const turn = this.#pending_turn;
		if (turn && !turn.settled) turn.cancelled = true;
		this.#pending_controller?.abort();
		this.#pending_controller = null;
		this.#pending_turn = null;
		this.pending = false;
	}

	/**
	 * Cancels the in-flight completion if it's the one streaming into `turn`
	 * (see `cancel_pending`).
	 *
	 * @returns whether `turn` was the pending turn
	 */
	cancel_pending_turn(turn: Turn): boolean {
		if (this.#pending_turn !== turn) return false;
		this.cancel_pending();
		return true;
	}

	switch_model(model_id: Uuid): void {
		const model = this.app.models.items.by_id.get(model_id);
		if (model) {
			this.model_name = model.name; // TODO @many probably should be id
		} else {
			console.error(`model with id ${model_id} not found`);
		}
	}
}
