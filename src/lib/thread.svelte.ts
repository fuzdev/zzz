import type {Model} from './model.svelte.js';
import {Turn, create_turn_from_text, create_turn_from_part} from './turn.svelte.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {ThreadJson} from './thread_types.js';
import {CompletionRequest, CompletionRole} from './completion_types.js';
import {render_messages_to_string, render_completion_messages} from './thread_helpers.js';
import type {PartUnion} from './part.svelte.js';
import {HANDLED} from './cell_helpers.js';
import {to_preview, estimate_token_count} from './helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import type {Uuid} from './zod_helpers.js';
import type {TurnJson} from './turn_types.js';

// TODO add `thread.name` and lots of other things probably

export interface ThreadOptions extends CellOptions<typeof ThreadJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type
/**
 * A thread is a linear sequence of turns that maintains a chronological
 * record of interactions between the user and the AI.
 */
export class Thread extends Cell<typeof ThreadJson> {
	model_name: string = $state.raw()!;
	readonly model: Model = $derived.by(() => {
		const model = this.app.models.find_by_name(this.model_name);
		if (!model) throw new Error(`Model "${this.model_name}" not found`); // TODO do this differently?
		return model;
	});

	readonly turns: IndexedCollection<Turn> = new IndexedCollection();

	enabled: boolean = $state.raw()!;

	readonly content: string = $derived(render_messages_to_string(this.turns.by_id.values()));
	readonly length: number = $derived(this.content.length);
	readonly token_count: number = $derived(estimate_token_count(this.content));
	readonly content_preview: string = $derived(to_preview(this.content));

	constructor(options: ThreadOptions) {
		super(ThreadJson, options);

		this.decoders = {
			turns: (items) => {
				if (Array.isArray(items)) {
					this.turns.clear();
					for (const item_json of items) {
						this.add_turn(item_json);
					}
				}
				return HANDLED;
			},
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
		const turn = create_turn_from_text(content, 'user', {thread_id: this.id, request}, this.app);
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
			{...json, thread_id: this.id},
			this.app,
		);
		this.add_turn(turn);
		return turn;
	}

	/**
	 * Create and add a system turn with the given content.
	 */
	add_system_turn(content: string): Turn {
		const turn = create_turn_from_text(content, 'system', {thread_id: this.id}, this.app);
		this.add_turn(turn);
		return turn;
	}

	/**
	 * Create and add a turn from a part.
	 */
	add_turn_from_part(part: PartUnion, role: CompletionRole): Turn {
		const turn = create_turn_from_part(part, role, {
			thread_id: this.id,
		});
		this.add_turn(turn);
		return turn;
	}

	/**
	 * Remove all turns from this thread.
	 */
	remove_all_turns(): void {
		this.turns.clear();
	}

	/**
	 * Send a message to the AI and create corresponding turns.
	 * Returns null if provider is unavailable (defensive check - UI should prevent this).
	 */
	async send_message(content: string): Promise<Turn | null> {
		// TODO rethink this API with the completion request/response (see OpenAI/MCP/A2A)
		// TODO maybe do this in the `completion_create: {send_request:` handler?

		// Pre-flight check: verify provider is available (defensive - UI should prevent this)
		const provider_status = this.app.lookup_provider_status(this.model.provider_name);
		if (provider_status && !provider_status.available) {
			console.warn(
				`[thread.send_message] provider '${this.model.provider_name}' unavailable, skipping send`,
			);
			return null; // No turn created - UI already shows error
		}

		const completion_messages = render_completion_messages(this.turns.by_id.values());

		const user_turn = this.add_user_turn(content);

		const completion_request = CompletionRequest.parse({
			created: user_turn.created,
			provider_name: this.model.provider_name,
			model: this.model.name,
			prompt: content,
			completion_messages,
		});

		// Create assistant turn with the request info so streaming updates can find it
		const assistant_turn = this.add_assistant_turn('', {request: completion_request});

		// Update the user turn with the request
		user_turn.request = completion_request;

		// Send the prompt with thread history
		await this.app.api.completion_create({
			completion_request,
			_meta: {progressToken: assistant_turn.id},
		});
		// Result not needed - handlers update turn, which contains error content if failed

		return assistant_turn;
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
