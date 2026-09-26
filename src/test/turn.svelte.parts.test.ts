// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';
import { create_turn_from_part } from '$lib/turn.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;
let signals: Array<AbortSignal | undefined>;
let thread: Thread;

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
	thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));
});

describe('Turn.remove_part', () => {
	test('removes the part id and the part from `app.parts`', () => {
		const turn = thread.add_user_turn('hello');
		const [part_id] = turn.part_ids;

		assert.ok(turn.remove_part(part_id!));

		assert.deepEqual(turn.part_ids, []);
		assert.ok(!app.parts.items.has(part_id!));
	});

	test('keeps a part another turn still references', () => {
		const turn = thread.add_user_turn('hello');
		const part = turn.parts[0]!;
		const other = create_turn_from_part(part, 'user', {});
		thread.add_turn(other);

		turn.remove_part(part.id);

		assert.ok(app.parts.items.has(part.id));
		assert.deepEqual(other.parts, [part]);
	});

	test('returns false for a part the turn lacks', () => {
		const turn = thread.add_user_turn('hello');
		const other = thread.add_user_turn('other');
		const [other_part_id] = other.part_ids;

		assert.ok(!turn.remove_part(other_part_id!));
		assert.ok(app.parts.items.has(other_part_id!));
	});

	test('removing the completion part of a pending turn cancels its completion', async () => {
		const sent = thread.send_message('hi');
		const turns = Array.from(thread.turns.by_id.values());
		const user_turn = turns.at(-2)!;
		const assistant_turn = turns.at(-1)!;

		// a user turn's part isn't streamed into
		user_turn.remove_part(user_turn.part_ids[0]!);
		assert.ok(thread.pending);
		assert.ok(!signals[0]!.aborted);

		assert.ok(assistant_turn.remove_part(assistant_turn.completion_part!.id));

		assert.ok(!thread.pending);
		assert.ok(assistant_turn.cancelled);
		assert.ok(signals[0]!.aborted);
		assert.strictEqual(await sent, assistant_turn);
	});

	test('removing the completion part of an idle assistant turn leaves it unstopped', () => {
		const turn = thread.add_assistant_turn('');
		assert.ok(!turn.settled);

		assert.ok(turn.remove_part(turn.completion_part!.id));

		assert.ok(!turn.cancelled);
	});

	test('removing an idle turn completion part leaves another pending turn streaming', () => {
		const idle_turn = thread.add_assistant_turn('');
		void thread.send_message('hi');

		idle_turn.remove_part(idle_turn.completion_part!.id);

		assert.ok(!idle_turn.cancelled);
		assert.ok(thread.pending);
		assert.ok(!signals[0]!.aborted);
		thread.cancel_pending();
	});
});
