/**
 * WebSocket round-trip integration tests.
 *
 * Drives `register_action_ws` + `BackendWebsocketTransport` via the
 * in-process harness from `@fuzdev/fuz_app/testing/ws_round_trip.js` —
 * no HTTP server. Exercises shapes that aren't covered by the
 * cross-backend integration suite:
 *
 * 1. `_test_emit_notifications` dispatch: `ctx.notify` streams
 *    `_test_notification` events to the originating socket **only**,
 *    then the final response carries the request id. A second
 *    connected client receives nothing — this is the two-socket
 *    assertion deferred from Phase 1.
 * 2. Broadcast: `create_broadcast_api(...).workspace_changed(...)`
 *    fans out to every connected client (mirrors the real
 *    `BackendActionsApi` wiring).
 * 3. Close removes the connection from the broadcast transport —
 *    closed clients do not receive subsequent broadcasts.
 * 4. Keeper auth gate — session-credential callers are rejected with
 *    `-32002 forbidden` on keeper-level actions.
 * 5. `ctx.signal` aborts when the socket closes — lets streaming
 *    handlers bail out instead of burning work on a dead client.
 * 6. Concurrent requests on one socket — the dispatcher preserves
 *    per-request id correlation under overlapping async handlers.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import {ActionPeer} from '@fuzdev/fuz_app/actions/action_peer.js';
import {create_broadcast_api} from '@fuzdev/fuz_app/actions/broadcast_api.js';
import type {ActionEventEnvironment} from '@fuzdev/fuz_app/actions/action_event_types.js';
import {create_ws_test_harness} from '@fuzdev/fuz_app/testing/ws_round_trip.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

import {
	_test_emit_notifications_action_spec,
	_test_notification_action_spec,
	provider_update_api_key_action_spec,
	workspace_changed_action_spec,
} from '$lib/action_specs.js';
import {DiskfileDirectoryPath} from '$lib/diskfile_types.js';
import type {BackendActionsApi} from '$lib/server/backend_actions_api.js';

const make_peer = (): ActionPeer =>
	new ActionPeer({
		environment: {
			executor: 'backend',
			lookup_action_handler: () => undefined,
			lookup_action_spec: () => undefined,
			log: new Logger('[ws-test-peer]'),
		} satisfies ActionEventEnvironment,
	});

const is_notification = (method: string) => (msg: unknown) =>
	typeof msg === 'object' &&
	msg !== null &&
	(msg as {method?: string}).method === method &&
	!('id' in msg);

const is_response_for = (id: number | string) => (msg: unknown) =>
	typeof msg === 'object' &&
	msg !== null &&
	(msg as {id?: unknown}).id === id &&
	('result' in msg || 'error' in msg);

describe('WebSocket round-trip', () => {
	test('ctx.notify streams notifications to the originating socket only', async () => {
		const harness = create_ws_test_harness({
			specs: [_test_emit_notifications_action_spec, _test_notification_action_spec],
			handlers: {
				_test_emit_notifications: (input: unknown, ctx) => {
					const {count} = input as {count: number};
					for (let i = 0; i < count; i++) {
						ctx.notify('_test_notification', {index: i});
					}
					return {count};
				},
			},
		});

		const originator = harness.connect();
		const bystander = harness.connect();
		await Promise.resolve();
		await Promise.resolve();

		await originator.send({
			jsonrpc: '2.0',
			id: 1,
			method: '_test_emit_notifications',
			params: {count: 3},
		});

		const response = await originator.wait_for<{id: number; result: {count: number}}>(
			is_response_for(1),
		);
		assert.deepStrictEqual(response.result, {count: 3});

		const match = is_notification('_test_notification');
		const received = originator.messages.filter(match);
		assert.strictEqual(received.length, 3);
		for (let i = 0; i < 3; i++) {
			assert.strictEqual((received[i] as {params: {index: number}}).params.index, i);
		}

		// Progress strictly precedes the final response.
		const first_progress_index = originator.messages.findIndex(match);
		const response_index = originator.messages.findIndex(is_response_for(1));
		assert.ok(first_progress_index < response_index, 'progress must precede final response');

		// The bystander socket must see nothing — notify is socket-scoped.
		assert.strictEqual(bystander.messages.length, 0);
	});

	test('workspace_changed broadcast fans out to every connected client', async () => {
		const harness = create_ws_test_harness({
			specs: [_test_emit_notifications_action_spec],
			handlers: {
				// Dispatch is not exercised — this test drives broadcast only.
				_test_emit_notifications: () => ({count: 0}),
			},
		});

		const peer = make_peer();
		peer.transports.register_transport(harness.transport);
		const broadcast = create_broadcast_api<Pick<BackendActionsApi, 'workspace_changed'>>({
			peer,
			specs: [workspace_changed_action_spec],
		});

		const client_a = harness.connect();
		const client_b = harness.connect();
		await Promise.resolve();
		await Promise.resolve();

		await broadcast.workspace_changed({
			type: 'open',
			workspace: {
				path: DiskfileDirectoryPath.parse('/tmp/test-workspace/'),
				name: 'test-workspace',
				opened_at: '2026-04-18T00:00:00.000Z',
			},
		});

		const match = is_notification('workspace_changed');
		const a = await client_a.wait_for<{params: {workspace: {name: string}}}>(match);
		const b = await client_b.wait_for<{params: {workspace: {name: string}}}>(match);
		assert.strictEqual(a.params.workspace.name, 'test-workspace');
		assert.strictEqual(b.params.workspace.name, 'test-workspace');
	});

	test('closed clients no longer receive broadcasts', async () => {
		const harness = create_ws_test_harness({
			specs: [_test_emit_notifications_action_spec],
			handlers: {
				_test_emit_notifications: () => ({count: 0}),
			},
		});

		const peer = make_peer();
		peer.transports.register_transport(harness.transport);
		const broadcast = create_broadcast_api<Pick<BackendActionsApi, 'workspace_changed'>>({
			peer,
			specs: [workspace_changed_action_spec],
		});

		const staying = harness.connect();
		const leaving = harness.connect();
		await Promise.resolve();
		await Promise.resolve();

		leaving.close();
		await Promise.resolve();

		await broadcast.workspace_changed({
			type: 'close',
			workspace: {
				path: DiskfileDirectoryPath.parse('/tmp/closed-ws/'),
				name: 'closed-ws',
				opened_at: '2026-04-18T00:00:00.000Z',
			},
		});

		const match = is_notification('workspace_changed');
		await staying.wait_for(match);
		assert.strictEqual(
			leaving.messages.filter(match).length,
			0,
			'closed client should not receive broadcasts',
		);
	});

	test('keeper-auth actions reject session callers with -32002 forbidden', async () => {
		const harness = create_ws_test_harness({
			specs: [provider_update_api_key_action_spec],
			handlers: {
				provider_update_api_key: () => {
					throw new Error('handler should not run for non-keeper caller');
				},
			},
		});

		// Default identity is credential_type: 'session' with no roles —
		// fails both the daemon_token check and the keeper role check.
		const client = harness.connect();
		await client.send({
			jsonrpc: '2.0',
			id: 99,
			method: 'provider_update_api_key',
			params: {provider_name: 'claude', api_key: 'sk-test'},
		});

		const response = await client.wait_for<{id: number; error: {code: number}}>(
			is_response_for(99),
		);
		assert.ok('error' in response, 'expected error response');
		assert.strictEqual(response.error.code, -32002);
	});

	test('ctx.signal aborts when the socket closes', async () => {
		let captured_signal: AbortSignal | null = null;
		let handler_resolved = false;

		const harness = create_ws_test_harness({
			specs: [_test_emit_notifications_action_spec],
			handlers: {
				_test_emit_notifications: async (_input, ctx) => {
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
		});

		const client = harness.connect();
		await Promise.resolve();
		await Promise.resolve();

		// Kick off dispatch without awaiting — the handler hangs until abort.
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

		client.close();

		// Yield so onClose propagates and aborts the controller.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.strictEqual(signal.aborted, true);

		await dispatch;
		assert.ok(handler_resolved, 'handler should unblock after abort');
	});

	test('concurrent requests on one socket preserve id correlation', async () => {
		const harness = create_ws_test_harness({
			specs: [_test_emit_notifications_action_spec, _test_notification_action_spec],
			handlers: {
				_test_emit_notifications: async (input: unknown, ctx) => {
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
		});

		const client = harness.connect();
		await Promise.resolve();
		await Promise.resolve();

		// Fire both without awaiting — overlapping dispatches on one socket.
		const p1 = client.send({
			jsonrpc: '2.0',
			id: 101,
			method: '_test_emit_notifications',
			params: {count: 5},
		});
		const p2 = client.send({
			jsonrpc: '2.0',
			id: 102,
			method: '_test_emit_notifications',
			params: {count: 3},
		});
		await Promise.all([p1, p2]);

		const r1 = await client.wait_for<{id: number; result: {count: number}}>(is_response_for(101));
		const r2 = await client.wait_for<{id: number; result: {count: number}}>(is_response_for(102));
		assert.strictEqual(r1.id, 101);
		assert.strictEqual(r2.id, 102);
		assert.strictEqual(r1.result.count, 5);
		assert.strictEqual(r2.result.count, 3);

		// Total notifications = 5 + 3 = 8, regardless of interleaving order.
		const notifs = client.messages.filter(is_notification('_test_notification'));
		assert.strictEqual(notifs.length, 8);
	});
});
