/**
 * WebSocket broadcast integration tests.
 *
 * Covers the backend-initiated fan-out path: `create_broadcast_api` ↔
 * `BackendWebsocketTransport` ↔ every connected `MockWsClient`. Dispatch
 * plumbing (ctx.notify, per-action auth, input validation, ctx.signal,
 * concurrent requests) lives in `ws.integration.dispatch.test.ts`.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import {create_ws_test_harness} from '@fuzdev/fuz_app/testing/ws_round_trip.js';

import {
	_test_emit_notifications_action_spec,
	workspace_changed_action_spec,
} from '$lib/action_specs.js';
import {DiskfileDirectoryPath} from '$lib/diskfile_types.js';
import type {BackendActionsApi} from '$lib/server/backend_actions_api.js';

import {
	build_broadcast_api,
	is_notification,
	settle_open,
	type JsonrpcNotification,
} from './ws_test_harness.js';

// A stub dispatch handler — broadcast tests don't invoke it, but the
// harness requires one per registered request/response spec. Kept minimal
// so the intent of each test stays visible.
const noop_handlers = {
	_test_emit_notifications: () => ({count: 0}),
};

type BroadcastApi = Pick<BackendActionsApi, 'workspace_changed'>;

describe('zzz WebSocket — broadcast', () => {
	test('workspace_changed fans out to every connected client', async () => {
		const harness = create_ws_test_harness({
			specs: [_test_emit_notifications_action_spec],
			handlers: noop_handlers,
		});
		const broadcast = build_broadcast_api<BroadcastApi>({
			harness,
			specs: [workspace_changed_action_spec],
		});

		const client_a = harness.connect();
		const client_b = harness.connect();
		await settle_open();

		await broadcast.workspace_changed({
			type: 'open',
			workspace: {
				path: DiskfileDirectoryPath.parse('/tmp/test-workspace/'),
				name: 'test-workspace',
				opened_at: '2026-04-18T00:00:00.000Z',
			},
		});

		const match = is_notification('workspace_changed');
		const a = await client_a.wait_for<JsonrpcNotification<{workspace: {name: string}}>>(match);
		const b = await client_b.wait_for<JsonrpcNotification<{workspace: {name: string}}>>(match);
		assert.strictEqual(a.params.workspace.name, 'test-workspace');
		assert.strictEqual(b.params.workspace.name, 'test-workspace');
	});

	test('closed clients no longer receive broadcasts', async () => {
		const harness = create_ws_test_harness({
			specs: [_test_emit_notifications_action_spec],
			handlers: noop_handlers,
		});
		const broadcast = build_broadcast_api<BroadcastApi>({
			harness,
			specs: [workspace_changed_action_spec],
		});

		const staying = harness.connect();
		const leaving = harness.connect();
		await settle_open();

		await leaving.close();

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
});
