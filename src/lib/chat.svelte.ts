import { z } from 'zod';
import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { Uuid } from '@fuzdev/fuz_util/id.ts';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';

import type { Model } from './model.svelte.ts';
import { to_completion_response_text } from './response_helpers.ts';
import { Thread } from './thread.svelte.ts';
import type { Turn } from './turn.svelte.ts';
import { reorder_list } from './list_helpers.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import { get_unique_name, estimate_token_count } from './helpers.ts';
import { CompletionRequest } from './completion_types.ts';
import { render_message_with_role } from './thread_helpers.ts';
import { to_provider_http_status } from './provider_types.ts';

const ChatViewMode = z.enum(['simple', 'multi']).default('simple');
export type ChatViewMode = z.infer<typeof ChatViewMode>;

/** How many failed auto-naming attempts a chat makes before giving up. */
export const CHAT_AUTONAME_ATTEMPTS_MAX = 3;

/**
 * JSON-RPC error codes that won't change on retry, so auto-naming stops after
 * one — a bad request, missing method or resource, or an auth failure.
 * Provider failures are all `internal_error`; see `AUTONAME_PERMANENT_HTTP_STATUSES`.
 */
const AUTONAME_PERMANENT_ERROR_CODES: ReadonlySet<number> = new Set([
	JSONRPC_ERROR_CODES.parse_error,
	JSONRPC_ERROR_CODES.invalid_request,
	JSONRPC_ERROR_CODES.method_not_found,
	JSONRPC_ERROR_CODES.invalid_params,
	JSONRPC_ERROR_CODES.unauthenticated,
	JSONRPC_ERROR_CODES.forbidden,
	JSONRPC_ERROR_CODES.not_found,
	JSONRPC_ERROR_CODES.validation_error
]);

/**
 * Upstream HTTP statuses from the provider's API that won't change on retry —
 * a bad request, a bad key, or an unknown (e.g. retired) model. Others, like
 * 408, 429, and 5xx, are retried.
 */
const AUTONAME_PERMANENT_HTTP_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

/**
 * Whether a failed naming request can't succeed on retry.
 */
const is_permanent_autoname_error = (error: { code: number; data?: unknown }): boolean => {
	if (AUTONAME_PERMANENT_ERROR_CODES.has(error.code)) return true;
	const status = to_provider_http_status(error.data);
	return status !== null && AUTONAME_PERMANENT_HTTP_STATUSES.has(status);
};

export const ChatJson = CellJson.extend({
	name: z.string().default(''),
	/**
	 * Whether auto-naming may still set `name` — true while it's a default
	 * name, cleared once auto-naming succeeds or the user renames the chat.
	 */
	autoname: z.boolean().default(true),
	thread_ids: z.array(Uuid).default(() => []),
	main_input: z.string().default(''),
	view_mode: ChatViewMode,
	selected_thread_id: Uuid.nullable().default(null)
}).meta({ cell_class_name: 'Chat' });
export type ChatJson = z.infer<typeof ChatJson>;
export type ChatJsonInput = z.input<typeof ChatJson>;

export interface ChatOptions extends CellOptions<typeof ChatJson> {}

export class Chat extends Cell<typeof ChatJson> {
	name: string = $state.raw()!;
	autoname: boolean = $state.raw()!;
	thread_ids: Array<Uuid> = $state()!;
	main_input: string = $state.raw()!;
	view_mode: ChatViewMode = $state.raw()!;
	selected_thread_id: Uuid | null = $state.raw()!;

	readonly main_input_length: number = $derived(this.main_input.length);
	readonly main_input_token_count: number = $derived(estimate_token_count(this.main_input));

	// TODO look into using an index for this, incremental from `this.thread_ids`
	readonly threads: Array<Thread> = $derived.by(() => {
		const result: Array<Thread> = [];
		const { by_id } = this.app.threads.items;

		for (const id of this.thread_ids) {
			const thread = by_id.get(id);
			if (thread) {
				result.push(thread);
			}
		}

		return result;
	});

	readonly enabled_threads = $derived(this.threads.filter((t) => t.enabled)); // TODO indexed collection, also disabled variant?

	/**
	 * Enabled threads that can send now (see `Thread.can_send`: no send in
	 * flight, a known model, an available provider) — the ones `send_to_all` sends to.
	 */
	readonly sendable_threads: Array<Thread> = $derived(
		this.enabled_threads.filter((t) => t.can_send)
	);

	/**
	 * The selected thread, resolved only if it's still part of this chat,
	 * so a removed thread never keeps rendering or receiving sends.
	 */
	readonly selected_thread: Thread | undefined = $derived(
		this.selected_thread_id && this.thread_ids.includes(this.selected_thread_id)
			? this.app.threads.items.by_id.get(this.selected_thread_id)
			: undefined
	);

	readonly current_thread: Thread | undefined = $derived(
		this.selected_thread || this.enabled_threads[0]
	);

	// TODO refactor
	/**
	 * Auto-naming progress: `initial` while it may still run, `failure` once it
	 * gives up (see `init_name_error`), `success` once it named the chat.
	 */
	init_name_status: AsyncStatus = $state.raw('initial');
	/** Failed auto-naming attempts so far. */
	init_name_attempts: number = $state.raw(0);
	/** The last auto-naming failure, shown as a hint on the chat name. */
	init_name_error: string | null = $state.raw(null);

	/** Counts user sends — one `send_to_all` is one send across its threads. */
	#send_count = 0;
	/** The send that last triggered auto-naming, so each send triggers it at most once. */
	#init_name_send: number | null = null;

	constructor(options: ChatOptions) {
		super(ChatJson, options);
		this.init();
	}

	add_thread(model: Model, select?: boolean): void {
		const thread = new Thread({ app: this.app, json: { model_name: model.name } });
		this.app.threads.add_thread(thread);
		this.thread_ids.push(thread.id);
		if (select || (!this.selected_thread_id && this.thread_ids.length === 1)) {
			this.select_thread(thread.id);
		}
	}

	add_threads_by_model_tag(tag: string): void {
		const models = this.app.models.filter_by_tag(tag);
		for (const model of models) {
			this.add_thread(model);
		}
	}

	/**
	 * Removes a thread from this chat, and from the app unless another chat still has it.
	 * If it was selected, the selection moves to the thread now at its index
	 * (or the new last thread), or clears.
	 */
	remove_thread(id: Uuid): void {
		this.detach_thread(id);
		this.app.threads.remove_unreferenced([id]);
	}

	/**
	 * Removes threads from this chat, and from the app unless another chat still has them.
	 * If the selected thread was removed, the selection moves to the first remaining thread, or clears.
	 */
	remove_threads(ids: Array<Uuid>): void {
		this.detach_threads(ids);
		this.app.threads.remove_unreferenced(ids);
	}

	remove_threads_by_model_tag(tag: string): void {
		this.remove_threads(
			this.threads.filter((t) => t.model?.tags.includes(tag) ?? false).map((t) => t.id)
		);
	}

	remove_all_threads(): void {
		this.remove_threads([...this.thread_ids]);
	}

	/**
	 * Drops a thread from this chat without removing it from the app — see `remove_thread`.
	 */
	detach_thread(id: Uuid): void {
		const index = this.thread_ids.indexOf(id);
		if (index === -1) return;
		this.thread_ids.splice(index, 1);
		if (this.selected_thread_id === id) {
			this.select_thread(this.thread_ids[Math.min(index, this.thread_ids.length - 1)] ?? null);
		}
	}

	/**
	 * Drops threads from this chat without removing them from the app — see `remove_threads`.
	 */
	detach_threads(ids: Array<Uuid>): void {
		// no reassignment when nothing changes, so `threads` doesn't re-derive
		if (!this.thread_ids.some((t) => ids.includes(t))) return;
		this.thread_ids = this.thread_ids.filter((t) => !ids.includes(t));
		if (this.selected_thread_id && !this.thread_ids.includes(this.selected_thread_id)) {
			this.select_thread(this.thread_ids[0] ?? null);
		}
	}

	/**
	 * Sends `content` to every thread in `sendable_threads`.
	 *
	 * @returns the number of threads a message was sent to
	 */
	async send_to_all(content: string): Promise<number> {
		const send = ++this.#send_count;
		const turns = await Promise.all(
			// TODO batched endpoint
			this.sendable_threads.map((thread) => this.#send_to_thread(thread.id, content, send))
		);
		return turns.filter((turn) => turn !== null).length;
	}

	/**
	 * Sends `content` to one thread, and auto-names the chat from the first
	 * successful exchange.
	 *
	 * @returns the assistant turn, or `null` if the send was skipped
	 */
	send_to_thread(thread_id: Uuid, content: string): Promise<Turn | null> {
		return this.#send_to_thread(thread_id, content, ++this.#send_count);
	}

	/**
	 * Sends to one thread as part of user send `send`. Only the first successful
	 * reply of a send triggers auto-naming, so a multi-thread send makes at most
	 * one naming attempt and a failure is retried on a later send.
	 */
	async #send_to_thread(thread_id: Uuid, content: string, send: number): Promise<Turn | null> {
		const thread = this.app.threads.items.by_id.get(thread_id);
		if (!thread) return null;

		if (thread.pending) return null; // a send is already in flight

		const sending = thread.send_message(content);
		// `send_message` sets `pending` synchronously once it creates the turns, and every
		// skip path returns before that — so bump at send time, not when the reply finishes
		if (thread.pending) this.updated = get_datetime_now(); // TODO @many probably rely on the db to bump `updated`

		const assistant_turn = await sending;
		if (!assistant_turn) return null; // skipped, e.g. unavailable model or provider

		// TODO maybe make the above return a result, so we can get better error handling, or maybe do that through the error handlers for the action?
		// don't burn the one naming attempt on a failed, cancelled, or empty reply
		if (
			!assistant_turn.error_message &&
			!assistant_turn.cancelled &&
			assistant_turn.content.trim() &&
			this.#init_name_send !== send
		) {
			this.#init_name_send = send;
			void this.init_name_from_turns(content, assistant_turn.content);
		}

		return assistant_turn;
	}

	/**
	 * Renames the chat as the user, which stops auto-naming from replacing the name.
	 * A no-op when `name` is unchanged.
	 */
	rename(name: string): void {
		if (name === this.name) return;
		this.name = name;
		this.autoname = false;
		this.init_name_error = null;
	}

	// TODO needs to be reworked (maybe accept an array of messages?)
	/**
	 * Uses an LLM to name the chat based on the user input and AI response.
	 * Only runs while `autoname` is set, so it never replaces a name the user
	 * chose. A failure is retried on a later send, up to
	 * `CHAT_AUTONAME_ATTEMPTS_MAX` attempts, except one that can't change on
	 * retry (e.g. an unknown model or an auth error), which ends it at once;
	 * the last failure is kept in `init_name_error`.
	 */
	async init_name_from_turns(user_content: string, assistant_content: string): Promise<void> {
		// TODO better abstraction for this kind of thing including de-duping the request,
		// returning the current promise
		if (!this.autoname || this.init_name_status !== 'initial') return;

		// Check if namerbot's provider is available before attempting to name
		const namerbot_model = this.app.models.find_by_name(this.app.bots.namerbot);
		if (!namerbot_model) {
			console.warn(
				`[chat.init_name_from_turns] namerbot model not found: ${this.app.bots.namerbot}`
			);
			return; // Stay in 'initial' state for retry later
		}

		const provider_status = this.app.lookup_provider_status(namerbot_model.provider_name);
		if (provider_status && !provider_status.available) {
			console.warn(
				`[chat.init_name_from_turns] namerbot provider '${namerbot_model.provider_name}' unavailable, skipping auto-naming`
			);
			return; // Stay in 'initial' state for retry later
		}

		this.init_name_status = 'pending';

		// TODO refactor
		let p = `Output a short title for this chat conversation with no commentary,
			for this chat content, use lowercase words (unless proper nouns) with no punctuation:\n\n`;

		// TODO not hardcoded?
		p += render_message_with_role('user', user_content);
		p += '\n\n' + render_message_with_role('assistant', assistant_content);

		try {
			// TODO configure this utility LLM (roles?), and set the output token count from config as well
			const name_response = await this.app.api.completion_create({
				// TODO @many should parsing be automatic, so the types change to schema input types? makes sense yeah?
				// I think perf is maybe the main reason not to do this?
				completion_request: CompletionRequest.parse({
					provider_name: namerbot_model.provider_name,
					model: this.app.bots.namerbot,
					prompt: p
				})
			});

			if (!name_response.ok) {
				const { error } = name_response;
				this.#fail_init_name(error.message, is_permanent_autoname_error(error));
				return;
			}

			const { completion_response } = name_response.value;

			const response_text = (to_completion_response_text(completion_response) || '').trim();

			if (!response_text) {
				this.#fail_init_name('the naming model returned no text', false);
				return;
			}

			this.init_name_status = 'success';
			this.init_name_error = null;
			// the user may have renamed the chat while the request was in flight
			if (!this.autoname) return;
			this.autoname = false;
			if (response_text !== this.name) {
				this.name = get_unique_name(response_text, this.app.chats.items_by_name);
			}
		} catch (error) {
			this.#fail_init_name(error instanceof Error ? error.message : String(error), false);
		}
	}

	/**
	 * Records a failed auto-naming attempt, allowing a retry on a later send
	 * unless the failure is permanent or the attempts are used up.
	 */
	#fail_init_name(message: string, permanent: boolean): void {
		// renamed while the request was in flight — auto-naming no longer applies
		if (!this.autoname) {
			this.init_name_status = 'initial';
			return;
		}
		this.init_name_attempts++;
		this.init_name_error = message;
		const done = permanent || this.init_name_attempts >= CHAT_AUTONAME_ATTEMPTS_MAX;
		this.init_name_status = done ? 'failure' : 'initial';
		console.error(
			`[chat.init_name_from_turns] failed to name the chat (attempt ${this.init_name_attempts}${done ? ', giving up' : ''}):`,
			message
		);
	}

	select_thread(thread_id: Uuid | null): void {
		this.selected_thread_id = thread_id;
	}

	/**
	 * Reorder threads by moving from one index to another.
	 */
	reorder_threads(from_index: number, to_index: number): void {
		reorder_list(this.thread_ids, from_index, to_index);
	}
}

export const ChatSchema = z.instanceof(Chat);
