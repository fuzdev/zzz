// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';
import type { Turn } from '$lib/turn.svelte.ts';
import type { CompletionResponse } from '$lib/completion_types.ts';
import { create_frontend_action_handlers } from '$lib/frontend_action_handlers.ts';
import type { FrontendActionHandlers } from '$lib/frontend_action_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

type CompletionCreateHandlers = NonNullable<FrontendActionHandlers['completion_create']>;
type CompletionProgressHandlers = NonNullable<FrontendActionHandlers['completion_progress']>;

let app: Frontend;
let handlers: FrontendActionHandlers;
let thread: Thread;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	handlers = create_frontend_action_handlers(app);
	thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));
});

/** Fakes the minimal action event shape the handlers destructure. */
const to_fake_event = <T>(data: unknown): T => ({ data }) as unknown as T;

const create_claude_response = (text: string): CompletionResponse => ({
	created: get_datetime_now(),
	provider_name: 'claude',
	model: 'test-model',
	data: { type: 'claude', value: { content: [{ text }] } }
});

const receive_error = (turn: Turn, code: number, message: string): void => {
	void handlers.completion_create!.receive_error!(
		to_fake_event<Parameters<NonNullable<CompletionCreateHandlers['receive_error']>>[0]>({
			input: { _meta: { progressToken: turn.id } },
			error: { code, message }
		})
	);
};

const receive_response = (turn: Turn, completion_response: CompletionResponse): void => {
	void handlers.completion_create!.receive_response!(
		to_fake_event<Parameters<NonNullable<CompletionCreateHandlers['receive_response']>>[0]>({
			input: { completion_request: {}, _meta: { progressToken: turn.id } },
			output: { completion_response }
		})
	);
};

const receive_progress = (turn: Turn, content: string): void => {
	void handlers.completion_progress!.receive!(
		to_fake_event<Parameters<NonNullable<CompletionProgressHandlers['receive']>>[0]>({
			input: {
				chunk: { message: { role: 'assistant', content } },
				_meta: { progressToken: turn.id }
			}
		})
	);
};

describe('Turn pending and settled', () => {
	test('an empty assistant turn is pending until settled', () => {
		const turn = thread.add_assistant_turn('');
		assert.ok(turn.pending);
		assert.ok(!turn.settled);
		assert.ok(!turn.cancelled);
	});

	test('a cancelled empty assistant turn is not pending', () => {
		const turn = thread.add_assistant_turn('');
		turn.cancelled = true;
		assert.ok(!turn.pending);
		assert.ok(turn.settled);
	});

	test('an errored empty assistant turn is not pending', () => {
		const turn = thread.add_assistant_turn('');
		turn.error_message = 'boom';
		assert.ok(!turn.pending);
		assert.ok(turn.settled);
	});

	test('user turns are never pending', () => {
		const turn = thread.add_user_turn('');
		assert.ok(!turn.pending);
	});

	test('cancelled round-trips through json', () => {
		const turn = thread.add_assistant_turn('', { cancelled: true });
		assert.ok(turn.cancelled);
		assert.strictEqual(turn.json.cancelled, true);
		assert.ok(!thread.add_assistant_turn('x').cancelled);
	});
});

describe('completion_create receive_error', () => {
	test('keeps streamed content and sets the error separately', () => {
		const turn = thread.add_assistant_turn('');
		receive_progress(turn, 'partial ');
		receive_progress(turn, 'answer');
		receive_error(turn, -32000, 'overloaded');

		assert.strictEqual(turn.content, 'partial answer');
		assert.strictEqual(turn.error_message, 'overloaded');
		assert.ok(!turn.cancelled);
		assert.ok(!turn.pending);
	});

	test('an error before any content settles the turn', () => {
		const turn = thread.add_assistant_turn('');
		receive_error(turn, -32000, 'bad request');

		assert.strictEqual(turn.content, '');
		assert.strictEqual(turn.error_message, 'bad request');
		assert.ok(!turn.pending);
	});

	test('a cancel marks the turn cancelled with no error', () => {
		const turn = thread.add_assistant_turn('');
		receive_error(turn, JSONRPC_ERROR_CODES.request_cancelled, 'cancelled');

		assert.ok(turn.cancelled);
		assert.strictEqual(turn.error_message, undefined);
		assert.ok(!turn.pending);
	});

	test('a cancel keeps partial content', () => {
		const turn = thread.add_assistant_turn('');
		receive_progress(turn, 'partial');
		receive_error(turn, JSONRPC_ERROR_CODES.request_cancelled, 'cancelled');

		assert.strictEqual(turn.content, 'partial');
		assert.ok(turn.cancelled);
	});

	test('does not touch a turn that already has its response', () => {
		const turn = thread.add_assistant_turn('');
		receive_response(turn, create_claude_response('done'));
		receive_error(turn, -32000, 'late');

		assert.strictEqual(turn.content, 'done');
		assert.strictEqual(turn.error_message, undefined);
	});
});

describe('completion_progress', () => {
	test('appends chunks while the turn is in flight', () => {
		const turn = thread.add_assistant_turn('');
		receive_progress(turn, 'a');
		receive_progress(turn, 'b');
		assert.strictEqual(turn.content, 'ab');
	});

	test('ignores chunks after the final response', () => {
		const turn = thread.add_assistant_turn('');
		receive_progress(turn, 'hel');
		receive_response(turn, create_claude_response('hello'));
		receive_progress(turn, 'lo');
		assert.strictEqual(turn.content, 'hello');
	});

	test('ignores chunks after a cancel', () => {
		const turn = thread.add_assistant_turn('');
		receive_progress(turn, 'hel');
		turn.cancelled = true;
		receive_progress(turn, 'lo');
		assert.strictEqual(turn.content, 'hel');
	});

	test('ignores chunks after an error', () => {
		const turn = thread.add_assistant_turn('');
		receive_error(turn, -32000, 'boom');
		receive_progress(turn, 'late');
		assert.strictEqual(turn.content, '');
	});
});
