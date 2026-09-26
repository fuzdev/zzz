// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import type { Chat } from '$lib/chat.svelte.ts';
import type { Thread } from '$lib/thread.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;
let signals: Array<AbortSignal | undefined>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({ models: [{ name: 'test-model', provider_name: 'claude' }] })
	);
	signals = [];
	// a `completion_create` that stays in flight until aborted
	(app as unknown as { api: unknown }).api = {
		completion_create: (_input: unknown, options?: { signal?: AbortSignal }) =>
			new Promise<void>((resolve) => {
				signals.push(options?.signal);
				options?.signal?.addEventListener('abort', () => resolve());
			})
	};
});

/** Creates an unselected chat with `count` threads, each with one user turn. */
const create_chat = (name: string, count = 2): Chat => {
	const chat = app.chats.add({ name });
	for (let i = 0; i < count; i++) {
		chat.add_thread(app.models.find_by_name('test-model')!);
		chat.threads[i]!.add_user_turn(`${name} ${i}`);
	}
	return chat;
};

const part_ids_of = (threads: Array<Thread>): Array<Uuid> => threads.flatMap((t) => t.part_ids);

/** Removes a chat without navigating, which needs a browser page. */
const remove_chat = (chat: Chat): void => {
	app.chats.selected_id = null;
	app.chats.remove(chat.id);
};

describe('removing a chat', () => {
	test('removes its threads, their turns, and their parts', () => {
		const chat = create_chat('a');
		const kept = create_chat('b');
		const { threads } = chat;
		const turn_ids = threads.flatMap((t) => t.turns.keys);
		const part_ids = part_ids_of(threads);
		assert.strictEqual(part_ids.length, 2);

		remove_chat(chat);

		for (const thread of threads) {
			assert.ok(!app.threads.items.has(thread.id));
			assert.ok(!app.cell_registry.all.has(thread.id));
		}
		for (const id of turn_ids) assert.ok(!app.cell_registry.all.has(id));
		for (const id of part_ids) assert.ok(!app.parts.items.has(id));

		// the other chat is untouched
		assert.strictEqual(kept.threads.length, 2);
		assert.deepEqual(
			part_ids_of(kept.threads).map((id) => app.parts.items.has(id)),
			[true, true]
		);
	});

	test('cancels an in-flight completion in its threads', async () => {
		const chat = create_chat('a', 1);
		const thread = chat.threads[0]!;
		const sent = thread.send_message('hi');
		assert.ok(thread.pending);

		remove_chat(chat);

		assert.ok(!thread.pending);
		assert.ok(signals[0]?.aborted);
		await sent;
	});

	test('keeps a thread another chat still has', () => {
		const chat = create_chat('a', 1);
		const other = create_chat('b', 0);
		const shared = chat.threads[0]!;
		other.thread_ids.push(shared.id);

		remove_chat(chat);

		assert.ok(app.threads.items.has(shared.id));
		assert.deepEqual(other.threads, [shared]);
		assert.ok(part_ids_of([shared]).every((id) => app.parts.items.has(id)));

		remove_chat(other);
		assert.ok(!app.threads.items.has(shared.id));
		assert.strictEqual(app.parts.items.size, 0);
	});

	test('a duplicate shares no threads, so removing it leaves the original intact', () => {
		const chat = create_chat('a');
		const copy = app.chats.duplicate(chat);
		copy.threads[0]!.add_user_turn('copy turn');

		remove_chat(copy);

		assert.strictEqual(chat.threads.length, 2);
		assert.deepEqual(
			part_ids_of(chat.threads).map((id) => app.parts.items.has(id)),
			[true, true]
		);
		assert.strictEqual(app.threads.items.size, 2);
		assert.strictEqual(app.parts.items.size, 2);
	});

	test('re-decoding the chats does not remove threads', () => {
		const chat = create_chat('a');
		const thread_ids = [...chat.thread_ids];

		app.chats.set_json(app.chats.json);

		assert.ok(thread_ids.every((id) => app.threads.items.has(id)));
		assert.strictEqual(app.parts.items.size, 2);
	});
});

describe('removing threads from a chat', () => {
	test('`remove_thread` removes an unshared thread and its parts from the app', () => {
		const chat = create_chat('a');
		const [removed, kept] = chat.threads;
		assert.ok(removed && kept);
		chat.select_thread(removed.id);

		chat.remove_thread(removed.id);

		assert.ok(!app.threads.items.has(removed.id));
		assert.ok(part_ids_of([removed]).every((id) => !app.parts.items.has(id)));
		assert.strictEqual(chat.selected_thread_id, kept.id);
		assert.ok(app.threads.items.has(kept.id));
	});

	test('`remove_thread` only detaches a thread another chat has', () => {
		const chat = create_chat('a', 1);
		const other = create_chat('b', 0);
		const shared = chat.threads[0]!;
		other.thread_ids.push(shared.id);

		chat.remove_thread(shared.id);

		assert.deepEqual(chat.thread_ids, []);
		assert.ok(app.threads.items.has(shared.id));
		assert.deepEqual(other.threads, [shared]);
	});

	test('`remove_all_threads` removes them all', () => {
		const chat = create_chat('a');
		chat.remove_all_threads();
		assert.deepEqual(chat.thread_ids, []);
		assert.strictEqual(chat.selected_thread_id, null);
		assert.strictEqual(app.threads.items.size, 0);
		assert.strictEqual(app.parts.items.size, 0);
	});

	test('`Threads.remove` removes a thread from every chat that has it', () => {
		const chat = create_chat('a', 1);
		const other = create_chat('b', 0);
		const shared = chat.threads[0]!;
		other.thread_ids.push(shared.id);

		app.threads.remove(shared.id);

		assert.deepEqual(chat.thread_ids, []);
		assert.deepEqual(other.thread_ids, []);
		assert.ok(!app.threads.items.has(shared.id));
		assert.strictEqual(app.parts.items.size, 0);
	});
});
