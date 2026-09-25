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

	test('uses the response text for assistant turns with a response', () => {
		const messages = render_completion_messages([
			create_test_turn('assistant', 'streamed', {
				response: create_claude_response('final')
			})
		]);
		assert.deepEqual(messages, [{ role: 'assistant', content: 'final' }]);
	});

	test('skips assistant turns whose response text is empty', () => {
		const messages = render_completion_messages([
			create_test_turn('assistant', '', { response: create_claude_response('') })
		]);
		assert.deepEqual(messages, []);
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
