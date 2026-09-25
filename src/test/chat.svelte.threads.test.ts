// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import type { Chat } from '$lib/chat.svelte.ts';
import type { Model } from '$lib/model.svelte.ts';
import type { Turn } from '$lib/turn.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;
let calls: Array<{ model: string; resolve: () => void }>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({
			models: [
				{ name: 'model_a', provider_name: 'claude', tags: ['tag_x'] },
				{ name: 'model_b', provider_name: 'chatgpt', tags: ['tag_y'] },
				{ name: 'model_c', provider_name: 'gemini', tags: ['tag_x'] }
			]
		})
	);
	calls = [];
	// `completion_create` stays in flight until the test resolves it
	(app as unknown as { api: unknown }).api = {
		completion_create: (input: { completion_request: { model: string } }) =>
			new Promise<void>((resolve) => {
				calls.push({ model: input.completion_request.model, resolve });
			})
	};
});

const get_model = (name: string): Model => app.models.find_by_name(name)!;

/** Creates a chat with one thread per model name, in order. */
const create_chat = (model_names: Array<string>): Chat => {
	const chat = app.chats.add();
	for (const name of model_names) chat.add_thread(get_model(name));
	return chat;
};

describe('Chat thread removal', () => {
	test('the first added thread is selected', () => {
		const chat = create_chat(['model_a', 'model_b']);
		assert.strictEqual(chat.selected_thread_id, chat.thread_ids[0]);
	});

	test('removing the selected thread advances to the thread at its index', () => {
		const chat = create_chat(['model_a', 'model_b', 'model_c']);
		const [id_a, id_b, id_c] = chat.thread_ids;
		chat.select_thread(id_b!);

		chat.remove_thread(id_b!);

		assert.deepEqual(chat.thread_ids, [id_a, id_c]);
		assert.strictEqual(chat.selected_thread_id, id_c);
		assert.strictEqual(chat.selected_thread?.id, id_c);
	});

	test('removing the selected last thread selects the new last thread', () => {
		const chat = create_chat(['model_a', 'model_b']);
		const [id_a, id_b] = chat.thread_ids;
		chat.select_thread(id_b!);

		chat.remove_thread(id_b!);

		assert.strictEqual(chat.selected_thread_id, id_a);
	});

	test('removing the only thread clears the selection', () => {
		const chat = create_chat(['model_a']);
		chat.remove_thread(chat.thread_ids[0]!);

		assert.isNull(chat.selected_thread_id);
		assert.strictEqual(chat.selected_thread, undefined);
		assert.strictEqual(chat.current_thread, undefined);
	});

	test('removing an unselected thread keeps the selection', () => {
		const chat = create_chat(['model_a', 'model_b']);
		const [id_a, id_b] = chat.thread_ids;

		chat.remove_thread(id_b!);

		assert.strictEqual(chat.selected_thread_id, id_a);
	});

	test('remove_threads moves the selection to the first remaining thread', () => {
		const chat = create_chat(['model_a', 'model_b', 'model_c']);
		const [id_a, id_b, id_c] = chat.thread_ids;
		chat.select_thread(id_c!);

		chat.remove_threads([id_a!, id_c!]);

		assert.deepEqual(chat.thread_ids, [id_b]);
		assert.strictEqual(chat.selected_thread_id, id_b);
	});

	test('remove_all_threads clears the selection', () => {
		const chat = create_chat(['model_a', 'model_b']);
		chat.remove_all_threads();

		assert.deepEqual(chat.thread_ids, []);
		assert.isNull(chat.selected_thread_id);
		assert.strictEqual(chat.selected_thread, undefined);
	});

	test('remove_threads_by_model_tag reconciles the selection', () => {
		const chat = create_chat(['model_a', 'model_b', 'model_c']);
		const [, id_b] = chat.thread_ids;

		chat.remove_threads_by_model_tag('tag_x');

		assert.deepEqual(chat.thread_ids, [id_b]);
		assert.strictEqual(chat.selected_thread_id, id_b);
	});

	test('selected_thread resolves only threads in the chat', () => {
		const chat = create_chat(['model_a']);
		const other = create_chat(['model_b']);
		// a stale id that exists app-wide but isn't in this chat
		chat.selected_thread_id = other.thread_ids[0]!;

		assert.ok(app.threads.items.by_id.has(other.thread_ids[0]!));
		assert.strictEqual(chat.selected_thread, undefined);
		assert.strictEqual(chat.current_thread?.id, chat.thread_ids[0]);
	});
});

describe('Chat.send_to_all', () => {
	test('skips threads with a send already in flight', async () => {
		const chat = create_chat(['model_a', 'model_b']);
		const [thread_a, thread_b] = chat.threads;

		const first = chat.send_to_thread(thread_a!.id, 'one');
		assert.ok(thread_a!.pending);
		assert.strictEqual(calls.length, 1);
		assert.deepEqual(
			chat.idle_threads.map((t) => t.id),
			[thread_b!.id]
		);

		const all = chat.send_to_all('two');

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[1]!.model, 'model_b');
		assert.strictEqual(thread_a!.turns.size, 2);
		assert.strictEqual(thread_b!.turns.size, 2);

		for (const call of calls) call.resolve();
		await first;
		assert.strictEqual(await all, 1);
	});

	test('returns the number of threads sent to', async () => {
		const chat = create_chat(['model_a', 'model_b']);
		const all = chat.send_to_all('hi');
		for (const call of calls) call.resolve();
		assert.strictEqual(await all, 2);
	});

	test('sends nothing when every thread is busy', async () => {
		const chat = create_chat(['model_a']);
		const first = chat.send_to_thread(chat.thread_ids[0]!, 'one');

		assert.deepEqual(chat.idle_threads, []);
		assert.strictEqual(await chat.send_to_all('two'), 0);
		assert.strictEqual(calls.length, 1);

		calls[0]!.resolve();
		await first;
	});

	test('excludes disabled threads', async () => {
		const chat = create_chat(['model_a', 'model_b']);
		chat.threads[0]!.enabled = false;
		const all = chat.send_to_all('hi');
		for (const call of calls) call.resolve();
		assert.strictEqual(await all, 1);
		assert.strictEqual(calls[0]!.model, 'model_b');
	});
});

describe('Chat.send_to_thread', () => {
	test('returns null and leaves `updated` alone when the send is skipped', async () => {
		const chat = create_chat(['model_a']);
		const thread_id = chat.thread_ids[0]!;
		const first = chat.send_to_thread(thread_id, 'one');
		const updated = chat.updated;

		assert.isNull(await chat.send_to_thread(thread_id, 'two'));
		assert.strictEqual(chat.updated, updated);

		calls[0]!.resolve();
		await first;
	});

	test('bumps `updated` at send time and returns the assistant turn', async () => {
		const chat = create_chat(['model_a']);
		chat.updated = '2000-01-01T00:00:00.000Z' as Chat['updated'];
		const sent = chat.send_to_thread(chat.thread_ids[0]!, 'hi');

		// before the stubbed completion resolves
		assert.notStrictEqual(chat.updated, '2000-01-01T00:00:00.000Z');

		calls[0]!.resolve();
		const turn = await sent;
		assert.ok(turn);
		assert.strictEqual(turn.role, 'assistant');
	});

	test('does not bump `updated` when the model is missing', async () => {
		const chat = create_chat(['model_a']);
		chat.threads[0]!.model_name = 'missing_model';
		chat.updated = '2000-01-01T00:00:00.000Z' as Chat['updated'];

		assert.isNull(await chat.send_to_thread(chat.thread_ids[0]!, 'hi'));
		assert.strictEqual(chat.updated, '2000-01-01T00:00:00.000Z');
		assert.strictEqual(calls.length, 0);
	});
});

describe('Chat.send_to_thread auto-naming', () => {
	/** Resolves the send after mutating the assistant turn, returning the naming attempts. */
	const send_and_settle = async (settle: (turn: Turn) => void): Promise<Array<string>> => {
		const chat = create_chat(['model_a']);
		const naming_attempts: Array<string> = [];
		chat.init_name_from_turns = (_user_content, assistant_content) => {
			naming_attempts.push(assistant_content);
			return Promise.resolve();
		};
		const thread = chat.threads[0]!;
		const sent = chat.send_to_thread(thread.id, 'hi');
		settle(Array.from(thread.turns.by_id.values()).at(-1)!);
		calls[0]!.resolve();
		await sent;
		return naming_attempts;
	};

	test('names the chat after a successful reply', async () => {
		const attempts = await send_and_settle((turn) => {
			turn.content = 'hello there';
		});
		assert.deepEqual(attempts, ['hello there']);
	});

	test('does not name the chat after an errored reply', async () => {
		const attempts = await send_and_settle((turn) => {
			turn.content = 'partial';
			turn.error_message = 'boom';
		});
		assert.deepEqual(attempts, []);
	});

	test('does not name the chat after a cancelled reply', async () => {
		const attempts = await send_and_settle((turn) => {
			turn.content = 'partial';
			turn.cancelled = true;
		});
		assert.deepEqual(attempts, []);
	});

	test('does not name the chat after an empty reply', async () => {
		const attempts = await send_and_settle(() => {});
		assert.deepEqual(attempts, []);
	});
});
