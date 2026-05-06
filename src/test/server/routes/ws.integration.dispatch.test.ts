/**
 * WebSocket dispatch integration tests.
 *
 * Exercises `register_action_ws` end-to-end via the in-process `ws_round_trip`
 * harness: request → per-action auth → input validation → handler invocation
 * → socket-scoped `ctx.notify` streams → final response frame. Broadcast
 * fan-out lives in `ws.integration.broadcast.test.ts`.
 *
 * Scenarios:
 *   - `ctx.notify` is socket-scoped (bystander sockets see nothing)
 *   - keeper-auth actions reject session callers (-32002 forbidden)
 *   - spec input validation rejects malformed params (-32602 invalid_params)
 *   - `ctx.signal` aborts when the socket closes — streaming handlers can
 *     bail out instead of burning work on a dead client
 *   - concurrent requests on one socket preserve per-request id correlation
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import {
	create_ws_test_harness,
	is_notification,
	is_response_for,
	type JsonrpcErrorResponseFrame,
	type JsonrpcNotificationFrame,
} from '@fuzdev/fuz_app/testing/ws_round_trip.js';

import {
	_test_emit_notifications_action_spec,
	_test_notification_action_spec,
	provider_update_api_key_action_spec,
} from '$lib/action_specs.js';

describe('zzz WebSocket — dispatch', () => {
	test('ctx.notify streams notifications to the originating socket only', async () => {
		const harness = create_ws_test_harness({
			actions: [
				{spec: _test_notification_action_spec},
				{
					spec: _test_emit_notifications_action_spec,
					handler: (input: unknown, ctx) => {
						const {count} = input as {count: number};
						for (let i = 0; i < count; i++) {
							ctx.notify('_test_notification', {index: i});
						}
						return {count};
					},
				},
			],
		});

		const originator = await harness.connect();
		const bystander = await harness.connect();

		const result = await originator.request<{count: number}>(1, '_test_emit_notifications', {
			count: 3,
		});
		assert.deepStrictEqual(result, {count: 3});

		const match = is_notification('_test_notification');
		const received = originator.messages.filter(match) as Array<
			JsonrpcNotificationFrame<{index: number}>
		>;
		assert.strictEqual(received.length, 3);
		for (let i = 0; i < 3; i++) {
			assert.strictEqual(received[i]!.params.index, i);
		}

		// Progress strictly precedes the final response.
		const first_progress_index = originator.messages.findIndex(match);
		const response_index = originator.messages.findIndex(is_response_for(1));
		assert.ok(first_progress_index < response_index, 'progress must precede final response');

		// The bystander socket must see nothing — notify is socket-scoped.
		assert.strictEqual(bystander.messages.length, 0);
	});

	test('keeper-auth actions reject session callers with -32002 forbidden', async () => {
		const harness = create_ws_test_harness({
			actions: [
				{
					spec: provider_update_api_key_action_spec,
					handler: () => {
						throw new Error('handler should not run for non-keeper caller');
					},
				},
			],
		});

		// Default identity is credential_type: 'session' with no roles —
		// fails both the daemon_token check and the keeper role check.
		const client = await harness.connect();
		// Raw send + wait_for so the test can assert on the error frame;
		// `client.request` would unwrap and throw.
		await client.send({
			jsonrpc: '2.0',
			id: 99,
			method: 'provider_update_api_key',
			params: {provider_name: 'claude', api_key: 'sk-test'},
		});

		const response = await client.wait_for<JsonrpcErrorResponseFrame>(is_response_for(99));
		assert.ok('error' in response, 'expected error response');
		assert.strictEqual(response.error.code, -32002);
	});

	test('malformed params → invalid_params (-32602) with zod issues', async () => {
		// Input schema requires `count: int >= 0`; `{count: -1}` passes the
		// type check but fails the min(0) refinement, so the dispatcher's
		// spec-level validation rejects it before the handler runs.
		const harness = create_ws_test_harness({
			actions: [
				{
					spec: _test_emit_notifications_action_spec,
					handler: () => {
						throw new Error('handler should not run for invalid input');
					},
				},
			],
		});

		const client = await harness.connect();
		// Raw send + wait_for for error-frame assertions.
		await client.send({
			jsonrpc: '2.0',
			id: 7,
			method: '_test_emit_notifications',
			params: {count: -1},
		});

		const response = await client.wait_for<JsonrpcErrorResponseFrame<{issues?: Array<unknown>}>>(
			is_response_for(7),
		);
		assert.ok('error' in response, 'expected error response');
		assert.strictEqual(response.error.code, -32602);
		assert.ok(
			Array.isArray(response.error.data?.issues) && response.error.data.issues.length > 0,
			'expected zod issues',
		);
	});

	test('ctx.signal aborts when the socket closes', async () => {
		let captured_signal: AbortSignal | null = null;
		let handler_resolved = false;

		const harness = create_ws_test_harness({
			actions: [
				{
					spec: _test_emit_notifications_action_spec,
					handler: async (_input, ctx) => {
						captured_signal = ctx.signal;
						await new Promise<void>((resolve) => {
							if (ctx.signal.aborted) {
								resolve();
								return;
							}
							ctx.signal.addEventListener('abort', () => resolve());
						});
						handler_resolved = true;
						return {count: 0};
					},
				},
			],
		});

		const client = await harness.connect();

		// Kick off dispatch without awaiting — the handler hangs until abort.
		// Raw `send` instead of `request` because `request` would block waiting
		// for a response that never arrives until the close aborts the handler.
		const dispatch = client.send({
			jsonrpc: '2.0',
			id: 1,
			method: '_test_emit_notifications',
			params: {count: 0},
		});

		// Yield a few microtasks so the handler runs up to the await.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		// TS CFA can't track closure assignments, so type-narrow by hand.
		const signal = captured_signal as AbortSignal | null;
		assert.ok(signal, 'handler should have captured ctx.signal');
		assert.strictEqual(signal.aborted, false);

		await client.close();

		// Yield so onClose propagates and aborts the controller.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.strictEqual(signal.aborted, true);

		await dispatch;
		assert.ok(handler_resolved, 'handler should unblock after abort');
	});

	test('concurrent requests on one socket preserve id correlation', async () => {
		const harness = create_ws_test_harness({
			actions: [
				{spec: _test_notification_action_spec},
				{
					spec: _test_emit_notifications_action_spec,
					handler: async (input: unknown, ctx) => {
						const {count} = input as {count: number};
						for (let i = 0; i < count; i++) {
							ctx.notify('_test_notification', {index: i});
							// Yield between notifies so a second in-flight dispatch
							// can interleave its sends between ours.
							await Promise.resolve();
						}
						return {count};
					},
				},
			],
		});

		const client = await harness.connect();

		// Fire both without awaiting — overlapping dispatches on one socket.
		const p1 = client.request<{count: number}>(101, '_test_emit_notifications', {count: 5});
		const p2 = client.request<{count: number}>(102, '_test_emit_notifications', {count: 3});
		const [r1, r2] = await Promise.all([p1, p2]);
		assert.strictEqual(r1.count, 5);
		assert.strictEqual(r2.count, 3);

		// Total notifications = 5 + 3 = 8, regardless of interleaving order.
		const notifs = client.messages.filter(is_notification('_test_notification'));
		assert.strictEqual(notifs.length, 8);
	});
});
