// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';
import type { CompletionRequest } from '$lib/completion_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

/** A stubbed `completion_create` call, resolved manually by the test. */
interface StubbedCall {
	completion_request: CompletionRequest;
	signal: AbortSignal | undefined;
	resolve: () => void;
}

let app: Frontend;
let calls: Array<StubbedCall>;

/**
 * Replaces `app.api` with a stub whose `completion_create` stays in flight until
 * the test resolves it — or until the caller aborts, mirroring the WS client.
 */
const stub_api = (target: Frontend): void => {
	(target as unknown as { api: unknown }).api = {
		completion_create: (
			input: { completion_request: CompletionRequest },
			options?: { signal?: AbortSignal }
		) =>
			new Promise<void>((resolve) => {
				calls.push({
					completion_request: input.completion_request,
					signal: options?.signal,
					resolve
				});
				options?.signal?.addEventListener('abort', () => resolve());
			})
	};
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({ models: [{ name: 'test-model', provider_name: 'claude' }] })
	);
	calls = [];
	stub_api(app);
});

const create_thread = (): Thread =>
	app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));

describe('Thread.cancel_pending', () => {
	test('cancelling before the first chunk settles the assistant turn', async () => {
		const thread = create_thread();
		const sent = thread.send_message('hi');
		assert.ok(thread.pending);
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;
		assert.ok(assistant_turn.pending);

		thread.cancel_pending();

		assert.ok(!thread.pending);
		assert.ok(assistant_turn.cancelled);
		assert.ok(!assistant_turn.pending);
		assert.ok(calls[0]!.signal?.aborted);
		assert.strictEqual(await sent, assistant_turn);
	});

	test('the empty cancelled turn is excluded from the next request history', async () => {
		const thread = create_thread();
		const first = thread.send_message('hi');
		thread.cancel_pending();
		await first;

		const second = thread.send_message('again');
		assert.deepEqual(calls[1]!.completion_request.completion_messages, [
			{ role: 'user', content: 'hi' }
		]);
		calls[1]!.resolve();
		await second;
	});

	test('does not mark an already-settled turn cancelled', async () => {
		const thread = create_thread();
		const sent = thread.send_message('hi');
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;
		assistant_turn.error_message = 'boom';
		thread.cancel_pending();
		await sent;
		assert.ok(!assistant_turn.cancelled);
	});

	test('is a no-op when nothing is pending', () => {
		const thread = create_thread();
		thread.cancel_pending();
		assert.ok(!thread.pending);
	});
});

describe('Thread.send_message', () => {
	test('skips a send while another is in flight', async () => {
		const thread = create_thread();
		const first = thread.send_message('one');
		const second = await thread.send_message('two');

		assert.isNull(second);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(thread.turns.size, 2);

		calls[0]!.resolve();
		await first;
		assert.ok(!thread.pending);
	});
});

describe('Thread.main_input', () => {
	test('defaults to empty and is independent per thread', () => {
		const a = create_thread();
		const b = create_thread();
		assert.strictEqual(a.main_input, '');
		a.main_input = 'draft for a';
		assert.strictEqual(b.main_input, '');
		assert.strictEqual(a.main_input_length, 'draft for a'.length);
		assert.ok(a.main_input_token_count > 0);
		assert.strictEqual(a.json.main_input, 'draft for a');
	});
});
