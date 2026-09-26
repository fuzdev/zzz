import { test, describe, assert } from 'vitest';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';

import {
	is_completion_truncated,
	to_completion_truncation,
	to_completion_response_text,
	to_completion_stop_reason
} from '$lib/response_helpers.ts';
import type { CompletionResponse } from '$lib/completion_types.ts';

const create_response = (data: CompletionResponse['data']): CompletionResponse => ({
	created: get_datetime_now(),
	provider_name: data.type,
	model: 'test-model',
	data
});

const claude = (value: unknown): CompletionResponse => create_response({ type: 'claude', value });
const chatgpt = (value: unknown): CompletionResponse => create_response({ type: 'chatgpt', value });
const gemini = (finish_reason: string | null, text = 'hi'): CompletionResponse =>
	create_response({
		type: 'gemini',
		value: {
			text,
			candidates: finish_reason === null ? null : [{ finishReason: finish_reason }]
		}
	});

describe('to_completion_response_text', () => {
	test('joins Claude text blocks, skipping thinking blocks', () => {
		const response = claude({
			content: [
				{ type: 'thinking', thinking: '', signature: 'sig' },
				{ type: 'text', text: 'Hello, ' },
				{ type: 'text', text: 'world' }
			]
		});
		assert.strictEqual(to_completion_response_text(response), 'Hello, world');
	});

	test('is null for a Claude response with only a thinking block', () => {
		const response = claude({ content: [{ type: 'thinking', thinking: 'hmm' }] });
		assert.isNull(to_completion_response_text(response));
	});

	test('reads ChatGPT and Gemini text', () => {
		assert.strictEqual(
			to_completion_response_text(chatgpt({ choices: [{ message: { content: 'a' } }] })),
			'a'
		);
		assert.strictEqual(to_completion_response_text(gemini('STOP', 'b')), 'b');
		assert.isNull(
			to_completion_response_text(chatgpt({ choices: [{ message: { content: null } }] }))
		);
	});
});

describe('to_completion_stop_reason', () => {
	test("reads each provider's stop reason", () => {
		assert.strictEqual(to_completion_stop_reason(claude({ stop_reason: 'end_turn' })), 'end_turn');
		assert.strictEqual(
			to_completion_stop_reason(chatgpt({ choices: [{ finish_reason: 'length' }] })),
			'length'
		);
		assert.strictEqual(to_completion_stop_reason(gemini('MAX_TOKENS')), 'MAX_TOKENS');
	});

	test('is null when the response carries none', () => {
		assert.isNull(to_completion_stop_reason(undefined));
		assert.isNull(to_completion_stop_reason(claude({})));
		assert.isNull(to_completion_stop_reason(chatgpt({ choices: [] })));
		assert.isNull(to_completion_stop_reason(gemini(null)));
	});
});

describe('is_completion_truncated', () => {
	test('is true for each provider’s token-limit reason', () => {
		assert.ok(is_completion_truncated(claude({ stop_reason: 'max_tokens' })));
		assert.ok(is_completion_truncated(claude({ stop_reason: 'model_context_window_exceeded' })));
		assert.ok(is_completion_truncated(chatgpt({ choices: [{ finish_reason: 'length' }] })));
		assert.ok(is_completion_truncated(gemini('MAX_TOKENS')));
	});

	test('is false for finished replies and other providers’ reasons', () => {
		assert.ok(!is_completion_truncated(undefined));
		assert.ok(!is_completion_truncated(claude({ stop_reason: 'end_turn' })));
		assert.ok(!is_completion_truncated(chatgpt({ choices: [{ finish_reason: 'stop' }] })));
		assert.ok(!is_completion_truncated(gemini('STOP')));
		// another provider's truncation reason doesn't count
		assert.ok(!is_completion_truncated(claude({ stop_reason: 'length' })));
	});
});

describe('to_completion_truncation', () => {
	test('names the limit that cut the reply off', () => {
		assert.strictEqual(
			to_completion_truncation(claude({ stop_reason: 'max_tokens' })),
			'max_tokens'
		);
		assert.strictEqual(
			to_completion_truncation(claude({ stop_reason: 'model_context_window_exceeded' })),
			'context_window'
		);
		assert.strictEqual(
			to_completion_truncation(chatgpt({ choices: [{ finish_reason: 'length' }] })),
			'max_tokens'
		);
		assert.strictEqual(to_completion_truncation(gemini('MAX_TOKENS')), 'max_tokens');
	});

	test('is null for finished replies and inherited property names', () => {
		assert.isNull(to_completion_truncation(claude({ stop_reason: 'end_turn' })));
		assert.isNull(to_completion_truncation(claude({ stop_reason: 'constructor' })));
		assert.isNull(to_completion_truncation(undefined));
	});
});
