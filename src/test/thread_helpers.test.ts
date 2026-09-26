import { test, describe, assert } from 'vitest';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';

import { render_completion_messages } from '$lib/thread_helpers.ts';
import type { CompletionResponse, CompletionRole } from '$lib/completion_types.ts';

interface TestTurn {
	role: CompletionRole;
	content: string;
	enabled: boolean;
	response: CompletionResponse | undefined;
	error_message: string | undefined;
}

const create_test_turn = (
	role: CompletionRole,
	content: string,
	overrides?: Partial<TestTurn>
): TestTurn => ({
	role,
	content,
	enabled: true,
	response: undefined,
	error_message: undefined,
	...overrides
});

const create_claude_response = (text: string): CompletionResponse => ({
	created: get_datetime_now(),
	provider_name: 'claude',
	model: 'test-model',
	data: { type: 'claude', value: { content: [{ text }] } }
});

describe('render_completion_messages', () => {
	test('renders enabled turns in order', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'hi'),
			create_test_turn('assistant', 'hello')
		]);
		assert.deepEqual(messages, [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' }
		]);
	});

	test('skips empty and whitespace-only turns', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'hi'),
			create_test_turn('assistant', ''),
			create_test_turn('user', 'again'),
			create_test_turn('assistant', ' \n\t ')
		]);
		assert.deepEqual(messages, [
			{ role: 'user', content: 'hi' },
			{ role: 'user', content: 'again' }
		]);
	});

	test('skips errored turns even with partial streamed content', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'hi'),
			create_test_turn('assistant', 'partial answ', { error_message: 'overloaded' })
		]);
		assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
	});

	test('skips disabled turns', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'hi', { enabled: false }),
			create_test_turn('user', 'there')
		]);
		assert.deepEqual(messages, [{ role: 'user', content: 'there' }]);
	});

	test('uses the current content of an edited assistant turn, not its response text', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'hi'),
			create_test_turn('assistant', 'edited answer', {
				response: create_claude_response('original answer')
			})
		]);
		assert.deepEqual(messages, [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'edited answer' }
		]);
	});

	test('skips an assistant turn whose content was edited to empty', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'hi'),
			create_test_turn('assistant', '', { response: create_claude_response('original') })
		]);
		assert.deepEqual(messages, [{ role: 'user', content: 'hi' }]);
	});

	test('drops assistant turns before the first user turn', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'first', { enabled: false }),
			create_test_turn('assistant', 'orphaned reply'),
			create_test_turn('system', 'be brief'),
			create_test_turn('user', 'second'),
			create_test_turn('assistant', 'answer')
		]);
		assert.deepEqual(messages, [
			{ role: 'system', content: 'be brief' },
			{ role: 'user', content: 'second' },
			{ role: 'assistant', content: 'answer' }
		]);
	});

	test('drops every assistant turn when no user turn remains', () => {
		const messages = render_completion_messages([
			create_test_turn('user', 'first', { error_message: 'x' }),
			create_test_turn('assistant', 'a1'),
			create_test_turn('assistant', 'a2')
		]);
		assert.deepEqual(messages, []);
	});

	test('keeps assistant turns when the provided array already has a user message', () => {
		const messages = render_completion_messages(
			[create_test_turn('assistant', 'a')],
			[{ role: 'user', content: 'q' }]
		);
		assert.deepEqual(messages, [
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'a' }
		]);
	});

	test('appends to the provided array', () => {
		const existing = [{ role: 'system' as const, content: 'be nice' }];
		const messages = render_completion_messages([create_test_turn('user', 'hi')], existing);
		assert.strictEqual(messages, existing);
		assert.deepEqual(messages, [
			{ role: 'system', content: 'be nice' },
			{ role: 'user', content: 'hi' }
		]);
	});
});
