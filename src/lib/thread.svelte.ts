import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import type { Model } from './model.svelte.ts';
import { Turn, create_turn_from_text } from './turn.svelte.ts';
import type { PartUnion } from './part.svelte.ts';
import {
	are_parts_pending_read,
	filter_failed_file_parts,
	load_parts_content,
	to_failed_file_parts_message
} from './part_helpers.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { ThreadJson } from './thread_types.ts';
import { CompletionRequest } from './completion_types.ts';
import {
	render_messages_to_string,
	render_messages_length,
	render_completion_messages
} from './thread_helpers.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { to_preview, estimate_token_count, estimate_token_count_from_length } from './helpers.ts';
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

	/** The rendered conversation — built only when read (copying it, say), not per streamed chunk. */
	readonly content: string = $derived(render_messages_to_string(this.turns.by_id.values()));

	/**
	 * `content.length`, summed from the turns' lengths so a streaming reply
	 * recomputes only its own turn, not the whole thread's text.
	 */
	readonly length: number = $derived(render_messages_length(this.turns.by_id.values()));
	readonly token_count: number = $derived(estimate_token_count_from_length(this.length));
	readonly content_preview: string = $derived(to_preview(this.content));

	/** Whether a turn's file part is still loading, so `content` lacks it for now. */
	readonly content_loading: boolean = $derived(
		Array.from(this.turns.by_id.values()).some((turn) => turn.content_loading)
	);

	/** Whether `load_content` has reading to do — see `are_parts_pending_read`. */
	readonly content_pending_read: boolean = $derived(
		Array.from(this.turns.by_id.values()).some((turn) => turn.content_pending_read)
	);

	/**
	 * Loads every file part's content in the turns, a failed read retried
	 * once (`load_parts_content`), then returns `content`.
	 */
	async load_content(): Promise<string> {
		await load_parts_content(() =>
			Array.from(this.turns.by_id.values()).flatMap((turn) => turn.parts)
		);
		return this.content;
	}

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

	/**
	 * Whether `send_message` would send now: no send in flight, the model is
	 * known, and its provider isn't reported unavailable (an unchecked provider
	 * counts as available, as in `send_message`).
	 */
	readonly can_send: boolean = $derived.by(() => {
		if (this.pending) return false;
		const model = this.model;
		if (!model) return false;
		return this.app.lookup_provider_status(model.provider_name)?.available !== false;
	});

	constructor(options: ThreadOptions) {
		super(ThreadJson, options);

		this.decoders = {
			turns: create_collection_decoder(
				() => this.#clear_turns(),
				(json) => this.add_turn(new Turn({ app: this.app, json }))
			)
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
	 *
	 * The turns are created and `pending` set synchronously. A file part in
	 * the history whose content is still on its way is awaited before the
	 * request is built, and one whose read failed (`Diskfile.content_error`)
	 * is read once more — a send is an explicit ask, so a transient error
	 * doesn't block it (`load_parts_content`); cancelling meanwhile sends
	 * nothing. A read that fails again stops the send: nothing is sent and
	 * the assistant turn takes the error, naming each such file and how to
	 * send without them (`to_failed_file_parts_message`). A file part whose
	 * file can't load as text (over 4 MiB, not UTF-8) is sent as the marker
	 * its `Turn.content` holds.
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

		const history = Array.from(this.turns.by_id.values());
		// the parts the request is built from — `render_completion_messages` skips
		// disabled turns (and errored ones, which hold no file parts)
		const history_parts = (): Array<PartUnion> =>
			history.filter((turn) => turn.enabled).flatMap((turn) => turn.parts);
		const history_waits = are_parts_pending_read(history_parts());

		const user_turn = this.add_user_turn(content);

		const create_request = (): CompletionRequest =>
			parse_or_throw(CompletionRequest, {
				created: user_turn.created,
				provider_name: model.provider_name,
				model: model.name,
				prompt: content,
				completion_messages: render_completion_messages(history)
			});

		// built now unless the history waits on file contents, or one failed to read
		let completion_request = history_waits ? null : create_request();

		// Create assistant turn with the request info so streaming updates can find it
		const assistant_turn = this.add_assistant_turn(
			'',
			completion_request ? { request: completion_request } : undefined
		);

		// Update the user turn with the request
		if (completion_request) user_turn.request = completion_request;

		// Send the prompt with thread history. Attach an AbortController so the
		// user can stop long streams mid-flight — the server's completion handler
		// cooperates via ctx.signal and the frontend WS client translates abort
		// into a `request_cancelled` JSON-RPC error.
		const controller = new AbortController();
		this.#pending_controller = controller;
		this.#pending_turn = assistant_turn;
		this.pending = true;
		try {
			if (!completion_request) {
				// the signal skips the retry of failed reads once cancelled
				await load_parts_content(history_parts, controller.signal);
				// cancelled while the contents loaded — nothing was sent
				if (controller.signal.aborted) return assistant_turn;
				// a file the history needs couldn't be read — sending without it would mislead
				const failed = filter_failed_file_parts(history_parts());
				if (failed.length) {
					assistant_turn.error_message = to_failed_file_parts_message(failed);
					return assistant_turn;
				}
				completion_request = create_request();
				assistant_turn.request = completion_request;
				user_turn.request = completion_request;
			}
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
