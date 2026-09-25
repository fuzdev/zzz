// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import type { Chat } from '$lib/chat.svelte.ts';
import { to_duplicate_base_name } from '$lib/chats.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({
			models: [
				{ name: 'model_a', provider_name: 'claude' },
				{ name: 'model_b', provider_name: 'chatgpt' }
			]
		})
	);
});

const create_chat = (name: string): Chat => {
	const chat = app.chats.add({ name, view_mode: 'multi', main_input: 'draft' });
	chat.add_thread(app.models.find_by_name('model_a')!);
	chat.add_thread(app.models.find_by_name('model_b')!);
	chat.threads[0]!.add_user_turn('hello');
	return chat;
};

describe('Chats.duplicate', () => {
	test('creates fresh threads for the same models, sharing none', () => {
		const original = create_chat('my chat');
		const original_thread_ids = [...original.thread_ids];
		const thread_count = app.threads.items.size;

		const copy = app.chats.duplicate(original);

		assert.notStrictEqual(copy.id, original.id);
		assert.strictEqual(copy.thread_ids.length, 2);
		for (const id of copy.thread_ids) {
			assert.ok(!original_thread_ids.includes(id));
		}
		assert.deepEqual(
			copy.threads.map((t) => t.model_name),
			['model_a', 'model_b']
		);
		assert.ok(copy.threads.every((t) => t.turns.size === 0));
		assert.strictEqual(app.threads.items.size, thread_count + 2);

		// the original is untouched
		assert.deepEqual(original.thread_ids, original_thread_ids);
		assert.strictEqual(original.threads[0]!.turns.size, 1);
	});

	test('gets a unique name', () => {
		const original = create_chat('my chat');
		const copy = app.chats.duplicate(original);
		const copy2 = app.chats.duplicate(original);

		assert.strictEqual(copy.name, 'my chat 2');
		assert.strictEqual(copy2.name, 'my chat 3');
		assert.strictEqual(original.name, 'my chat');
	});

	test('numbers a duplicate of a duplicate from the base name', () => {
		const original = create_chat('my chat');
		const copy = app.chats.duplicate(original);
		const copy_of_copy = app.chats.duplicate(copy);

		assert.strictEqual(copy.name, 'my chat 2');
		assert.strictEqual(copy_of_copy.name, 'my chat 3');
	});

	test('keeps a trailing number when it is not a duplicate suffix', () => {
		const original = create_chat('gpt 4');
		const copy = app.chats.duplicate(original);

		assert.strictEqual(copy.name, 'gpt 4 2');
	});

	test('mirrors the selected thread by position', () => {
		const original = create_chat('my chat');
		original.select_thread(original.thread_ids[1]!);

		const copy = app.chats.duplicate(original);

		assert.strictEqual(copy.selected_thread_id, copy.thread_ids[1]);
		assert.strictEqual(copy.selected_thread?.model_name, 'model_b');
	});

	test('copies chat-level settings', () => {
		const original = create_chat('my chat');
		const copy = app.chats.duplicate(original);

		assert.strictEqual(copy.view_mode, 'multi');
		assert.strictEqual(copy.main_input, 'draft');
		assert.ok(app.chats.items.by_id.has(copy.id));
	});

	test('duplicating a chat with no threads has no selection', () => {
		const original = app.chats.add({ name: 'empty' });
		const copy = app.chats.duplicate(original);

		assert.deepEqual(copy.thread_ids, []);
		assert.isNull(copy.selected_thread_id);
	});
});

describe('to_duplicate_base_name', () => {
	const names = new Set(['my chat', 'my chat 2']);

	test('strips a numeric suffix when the base name exists', () => {
		assert.strictEqual(to_duplicate_base_name('my chat 2', names), 'my chat');
	});

	test('keeps the name when the base name does not exist', () => {
		assert.strictEqual(to_duplicate_base_name('gpt 4', names), 'gpt 4');
	});

	test('keeps names without a numeric suffix', () => {
		assert.strictEqual(to_duplicate_base_name('my chat', names), 'my chat');
	});

	test('falls back for an empty name', () => {
		assert.strictEqual(to_duplicate_base_name('', names), 'new chat');
	});
});
