import { test, describe, assert } from 'vitest';
import { ActionEventData } from '@fuzdev/fuz_app/actions/action_event_data.ts';

import {
	ACTION_ERROR_MESSAGE_TRUNCATED_KEY,
	action_event_data_has_omitted_payload,
	bound_action_event_data,
	estimate_json_length,
	is_action_error_message_truncated,
	is_action_payload_omitted,
	is_action_payload_over_budget,
	truncate_action_error_message
} from '$lib/action_helpers.ts';

const BUDGET = 100;

const big_string = 'x'.repeat(BUDGET * 10);

const create_data = (overrides: Partial<ActionEventData> = {}): ActionEventData => ({
	kind: 'request_response',
	phase: 'receive_response',
	step: 'handled',
	method: 'session_load',
	executor: 'frontend',
	input: null,
	output: null,
	error: null,
	progress: null,
	request: { jsonrpc: '2.0', id: 'r1', method: 'session_load' },
	response: { jsonrpc: '2.0', id: 'r1', result: null },
	notification: null,
	...overrides
});

describe('estimate_json_length', () => {
	test('matches JSON.stringify for values without escapes', () => {
		const values: Array<unknown> = [
			null,
			true,
			42,
			-1.5,
			'',
			'abc',
			[],
			[1, 'two', null],
			{},
			{ a: 1, b: 'two', c: [true, { d: null }] },
			{ skipped: undefined, kept: 1 },
			[{ a: [] }, { b: {} }]
		];
		for (const value of values) {
			assert.strictEqual(
				estimate_json_length(value, 10_000),
				JSON.stringify(value).length,
				JSON.stringify(value)
			);
		}
	});

	test('stops once past the limit', () => {
		const huge = Array.from({ length: 100_000 }, (_, i) => ({ path: `/file/${i}`, contents: 'x' }));
		assert.ok(estimate_json_length(huge, 1000) > 1000);
		assert.ok(estimate_json_length({ contents: big_string }, BUDGET) > BUDGET);
	});
});

describe('truncate_action_error_message', () => {
	test('keeps a message within the budget', () => {
		assert.strictEqual(truncate_action_error_message('boom', BUDGET), 'boom');
		const exact = 'x'.repeat(BUDGET);
		assert.strictEqual(truncate_action_error_message(exact, BUDGET), exact);
	});

	test('truncates a longer message and notes its length', () => {
		assert.strictEqual(
			truncate_action_error_message('x'.repeat(BUDGET + 1), BUDGET),
			`${'x'.repeat(BUDGET)}… [truncated from ${BUDGET + 1} characters]`
		);
	});
});

describe('is_action_payload_over_budget', () => {
	test('checks strings, objects, and arrays', () => {
		assert.ok(!is_action_payload_over_budget(null, BUDGET));
		assert.ok(!is_action_payload_over_budget(123, BUDGET));
		assert.ok(!is_action_payload_over_budget('small', BUDGET));
		assert.ok(is_action_payload_over_budget(big_string, BUDGET));
		assert.ok(!is_action_payload_over_budget({ a: 'small' }, BUDGET));
		assert.ok(is_action_payload_over_budget({ a: big_string }, BUDGET));
		assert.ok(is_action_payload_over_budget([big_string], BUDGET));
	});
});

describe('bound_action_event_data', () => {
	test('returns the same data when every payload fits', () => {
		const data = create_data({ input: { a: 1 }, output: { b: 'two' } });
		assert.strictEqual(bound_action_event_data(data, BUDGET), data);
	});

	test('replaces large payloads with markers and keeps the rest', () => {
		const output = { files: [{ contents: big_string }] };
		const data = create_data({
			input: { small: true },
			output,
			response: { jsonrpc: '2.0', id: 'r1', result: output }
		});
		const bounded = bound_action_event_data(data, BUDGET);
		assert.notStrictEqual(bounded, data);
		assert.deepEqual(bounded.input, { small: true });
		assert.ok(is_action_payload_omitted(bounded.output));
		assert.ok(bounded.response && 'result' in bounded.response);
		assert.ok(is_action_payload_omitted(bounded.response.result));
		assert.strictEqual(bounded.response.id, 'r1');
		assert.strictEqual(bounded.step, 'handled');
		assert.strictEqual(bounded.method, 'session_load');
		assert.strictEqual(data.output, output, 'the source data is untouched');
		assert.ok(action_event_data_has_omitted_payload(bounded));
		assert.ok(!action_event_data_has_omitted_payload(data));
	});

	test('bounds request and notification params, progress, and error data', () => {
		const data = create_data({
			phase: 'receive_error',
			step: 'handled',
			input: { content: big_string },
			progress: [big_string],
			error: { code: -32603, message: 'boom', data: { trace: big_string } },
			request: {
				jsonrpc: '2.0',
				id: 'r1',
				method: 'diskfile_update',
				params: { content: big_string }
			},
			response: {
				jsonrpc: '2.0',
				id: 'r1',
				error: { code: -32603, message: 'boom', data: { trace: big_string } }
			},
			notification: { jsonrpc: '2.0', method: 'n', params: { content: big_string } }
		});
		const bounded = bound_action_event_data(data, BUDGET);
		assert.ok(is_action_payload_omitted(bounded.input));
		assert.ok(is_action_payload_omitted(bounded.progress));
		assert.ok(bounded.error);
		assert.strictEqual(bounded.error.message, 'boom');
		assert.strictEqual(bounded.error.code, -32603);
		assert.ok(is_action_payload_omitted(bounded.error.data));
		assert.ok(bounded.request);
		assert.strictEqual(bounded.request.method, 'diskfile_update');
		assert.ok(is_action_payload_omitted(bounded.request.params));
		assert.ok(is_action_payload_omitted(bounded.notification?.params));
		const response = bounded.response as { error: { message: string; data?: unknown } };
		assert.strictEqual(response.error.message, 'boom');
		assert.ok(is_action_payload_omitted(response.error.data));
	});

	test('truncates long error messages', () => {
		const message = 'm'.repeat(BUDGET * 3);
		const data = create_data({
			phase: 'receive_error',
			error: { code: -32603, message },
			response: { jsonrpc: '2.0', id: 'r1', error: { code: -32603, message } }
		});
		const bounded = bound_action_event_data(data, BUDGET);
		assert.ok(bounded.error);
		assert.strictEqual(bounded.error.message, truncate_action_error_message(message, BUDGET));
		assert.ok(bounded.error.message.startsWith('m'.repeat(BUDGET) + '…'));
		assert.include(bounded.error.message, `truncated from ${BUDGET * 3} characters`);
		assert.strictEqual(bounded.error.code, -32603);
		assert.notProperty(bounded.error, 'data');
		assert.strictEqual(
			(bounded.error as Record<string, unknown>)[ACTION_ERROR_MESSAGE_TRUNCATED_KEY],
			BUDGET * 3
		);
		assert.ok(is_action_error_message_truncated(bounded.error));
		const response = bounded.response as { error: { message: string } };
		assert.strictEqual(response.error.message, bounded.error.message);
		assert.ok(is_action_error_message_truncated(response.error));
		assert.ok(ActionEventData.safeParse(bounded).success);
		assert.ok(action_event_data_has_omitted_payload(bounded));
		assert.ok(!action_event_data_has_omitted_payload(data));
	});

	test('a truncated message alone counts as omitted, in the error or the response', () => {
		const message = 'm'.repeat(BUDGET + 1);
		const error_only = bound_action_event_data(
			create_data({ phase: 'receive_error', error: { code: -32603, message } }),
			BUDGET
		);
		assert.ok(action_event_data_has_omitted_payload(error_only));
		const response_only = bound_action_event_data(
			create_data({
				phase: 'receive_error',
				response: { jsonrpc: '2.0', id: 'r1', error: { code: -32603, message } }
			}),
			BUDGET
		);
		assert.ok(action_event_data_has_omitted_payload(response_only));
		const short = bound_action_event_data(
			create_data({ phase: 'receive_error', error: { code: -32603, message: 'boom' } }),
			BUDGET
		);
		assert.ok(!action_event_data_has_omitted_payload(short));
		assert.ok(!is_action_error_message_truncated(short.error));
	});

	test('the bounded data still parses as ActionEventData', () => {
		const data = create_data({
			input: { content: big_string },
			output: { content: big_string },
			request: {
				jsonrpc: '2.0',
				id: 'r1',
				method: 'session_load',
				params: { content: big_string }
			},
			response: { jsonrpc: '2.0', id: 'r1', result: { content: big_string } }
		});
		const parsed = ActionEventData.safeParse(bound_action_event_data(data, BUDGET));
		assert.ok(parsed.success, parsed.error?.message);
	});
});
