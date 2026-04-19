/**
 * WebSocket cancel integration — proves the shared `cancel_action` primitive
 * aborts zzz's in-flight handlers end-to-end.
 *
 * The test spec (`_test_emit_notifications`) is reused here with a streaming
 * handler that awaits `ctx.signal` — when the client aborts its side
 * (`FrontendWebsocketClient.request({signal})`), the client sends the shared
 * `cancel` notification; `register_action_ws` looks up the matching pending
 * controller and fires its abort; the handler bails and the server writes an
 * error frame. No AI provider or real long-running action is involved — the
 * point is the dispatcher-owned cancel path.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import {
	create_ws_test_harness,
	is_response_for,
	type JsonrpcErrorResponseFrame,
} from '@fuzdev/fuz_app/testing/ws_round_trip.js';
import {CANCEL_METHOD} from '@fuzdev/fuz_app/actions/cancel.js';
import {cancel_action} from '@fuzdev/fuz_app/actions/cancel.js';

import {_test_emit_notifications_action_spec} from '$lib/action_specs.js';

describe('zzz WebSocket — cancel', () => {
	test('client cancel notification aborts matching in-flight handler', async () => {
		let captured_signal: AbortSignal | null = null;

		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: _test_emit_notifications_action_spec,
					handler: async (_input, ctx) => {
						captured_signal = ctx.signal;
						await new Promise<void>((resolve) => {
							if (ctx.signal.aborted) {
								resolve();
								return;
							}
							ctx.signal.addEventListener('abort', () => resolve(), {once: true});
						});
						throw new Error('aborted mid-stream');
					},
				},
			],
		});

		const client = await harness.connect();

		// Kick off dispatch without awaiting — handler hangs until abort.
		void client.send({
			jsonrpc: '2.0',
			id: 42,
			method: '_test_emit_notifications',
			params: {count: 1},
		});

		// Let the dispatcher register the pending controller.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.ok(captured_signal, 'handler should have captured ctx.signal');
		assert.strictEqual(captured_signal.aborted, false);

		// Client-initiated cancel — the primitive under test.
		await client.send({
			jsonrpc: '2.0',
			method: CANCEL_METHOD,
			params: {request_id: 42},
		});

		const response = await client.wait_for<JsonrpcErrorResponseFrame>(is_response_for(42));
		assert.ok('error' in response);
		assert.match(String(response.error.message), /aborted mid-stream/);
		assert.strictEqual(captured_signal.aborted, true);
	});

	test('cancel for completed id is a no-op (idempotent)', async () => {
		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: _test_emit_notifications_action_spec,
					handler: () => ({count: 0}),
				},
			],
		});

		const client = await harness.connect();

		// Complete a request first.
		const done = await client.request<{count: number}>(1, '_test_emit_notifications', {
			count: 0,
		});
		assert.deepStrictEqual(done, {count: 0});

		// Late cancel for the completed id — must not produce an error frame.
		await client.send({
			jsonrpc: '2.0',
			method: CANCEL_METHOD,
			params: {request_id: 1},
		});

		// Follow-up request proves dispatch is still healthy.
		const again = await client.request<{count: number}>(2, '_test_emit_notifications', {
			count: 0,
		});
		assert.deepStrictEqual(again, {count: 0});

		// No stray error frames arrived for the late cancel.
		const error_frames = client.messages.filter(
			(m) => typeof m === 'object' && m !== null && 'error' in m,
		);
		assert.strictEqual(error_frames.length, 0);
	});
});
