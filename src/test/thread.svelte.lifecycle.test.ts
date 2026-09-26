// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';
import { Turn } from '$lib/turn.svelte.ts';

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

const create_thread = (): Thread =>
	app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));

describe('Thread decoding', () => {
	test('decodes turns into registered `Turn` cells owned by the thread', () => {
		const part = app.parts.add({ type: 'text', content: 'hello' });
		const thread = new Thread({
			app,
			json: { model_name: 'test-model', turns: [{ role: 'user', part_ids: [part.id] }] }
		});

		const turn = thread.turns.values[0];
		assert.ok(turn instanceof Turn);
		assert.strictEqual(turn.thread_id, thread.id);
		assert.strictEqual(turn.content, 'hello');
		assert.ok(app.cell_registry.all.has(turn.id));
		assert.strictEqual(thread.content.includes('hello'), true);
	});

	test('round-trips its turns through JSON', () => {
		const thread = create_thread();
		thread.add_user_turn('hi');
		thread.add_assistant_turn('hello');

		// a fresh app, so the restored cells don't collide with the originals in the registry
		const restored = new Thread({
			app: monkeypatch_zzz_for_tests(new Frontend()),
			json: thread.json
		});

		assert.ok(restored.turns.values.every((turn) => turn instanceof Turn));
		assert.deepEqual(
			restored.turns.values.map((turn) => turn.role),
			['user', 'assistant']
		);
		assert.ok(restored.turns.values.every((turn) => turn.thread_id === restored.id));
	});
});

describe('Thread re-decoding', () => {
	test('replacing the turns cancels an in-flight completion and keeps the parts', async () => {
		const thread = create_thread();
		const sent = thread.send_message('hi');
		const part_count = app.parts.items.size;

		thread.set_json(thread.json);

		assert.ok(!thread.pending);
		assert.ok(signals[0]?.aborted);
		assert.strictEqual(thread.turns.size, 2);
		assert.strictEqual(app.parts.items.size, part_count);
		assert.strictEqual(thread.turns.values[0]?.content, 'hi');
		await sent;
	});

	test('re-decoding the threads keeps their turns and parts registered', () => {
		const thread = create_thread();
		const turn = thread.add_user_turn('hi');

		app.threads.set_json(app.threads.json);

		const decoded = app.threads.items.by_id.get(thread.id);
		assert.ok(decoded && decoded !== thread);
		assert.strictEqual(app.cell_registry.all.get(thread.id), decoded as unknown);
		assert.strictEqual(app.cell_registry.all.get(turn.id), decoded.turns.values[0] as unknown);
		assert.strictEqual(decoded.turns.values[0]?.content, 'hi');
	});
});

describe('turn disposal', () => {
	test('`remove_all_turns` disposes the turns and removes their parts', () => {
		const thread = create_thread();
		const turn = thread.add_user_turn('hi');
		const [part_id] = turn.part_ids;
		assert.ok(part_id && app.parts.items.has(part_id));
		assert.ok(app.cell_registry.all.has(turn.id));

		thread.remove_all_turns();

		assert.strictEqual(thread.turns.size, 0);
		assert.ok(!app.cell_registry.all.has(turn.id));
		assert.ok(!app.parts.items.has(part_id));
		assert.ok(!app.cell_registry.all.has(part_id));
	});

	test('`remove_all_turns` keeps parts another turn references', () => {
		const thread = create_thread();
		const other = create_thread();
		const turn = thread.add_user_turn('shared');
		const [part_id] = turn.part_ids;
		assert.ok(part_id);
		other.add_turn(new Turn({ app, json: { role: 'user', part_ids: [part_id] } }));

		thread.remove_all_turns();

		assert.ok(app.parts.items.has(part_id));
		assert.strictEqual(other.turns.values[0]?.content, 'shared');
	});

	test('`remove_all_turns` cancels an in-flight completion first', async () => {
		const thread = create_thread();
		const sent = thread.send_message('hi');
		assert.ok(thread.pending);

		thread.remove_all_turns();

		assert.ok(!thread.pending);
		assert.ok(signals[0]?.aborted);
		await sent;
		assert.ok(!thread.pending);
	});

	test('removing a thread disposes it and its turns, and cancels its completion', async () => {
		const chat = app.chats.add({ name: 'chat' });
		chat.add_thread(app.models.find_by_name('test-model')!);
		const thread = chat.threads[0]!;
		const first = thread.add_user_turn('earlier');
		const sent = thread.send_message('hi');

		app.threads.remove(thread.id);

		assert.ok(!app.threads.items.has(thread.id));
		assert.ok(!chat.thread_ids.includes(thread.id));
		assert.ok(!app.cell_registry.all.has(thread.id));
		assert.ok(!app.cell_registry.all.has(first.id));
		assert.strictEqual(app.parts.items.size, 0);
		assert.strictEqual(thread.turns.size, 0);
		assert.ok(signals[0]?.aborted);
		await sent;
	});
});
