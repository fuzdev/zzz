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
import {
	build_broadcast_api,
	create_ws_test_harness,
	is_notification,
	type JsonrpcNotificationFrame,
} from '@fuzdev/fuz_app/testing/ws_round_trip.js';

import {
	_test_emit_notifications_action_spec,
	workspace_changed_action_spec,
} from '$lib/action_specs.js';
import {DiskfileDirectoryPath} from '$lib/diskfile_types.js';
import type {BackendActionsApi} from '$lib/server/backend_actions_api.js';

// A stub dispatch action — broadcast tests don't invoke it, but the
// harness requires a handler per registered request/response spec. Kept
// minimal so the intent of each test stays visible.
const stub_emit_notifications = {
	spec: _test_emit_notifications_action_spec,
	handler: () => ({count: 0}),
};

type BroadcastApi = Pick<BackendActionsApi, 'workspace_changed'>;

describe('zzz WebSocket — broadcast', () => {
	test('workspace_changed fans out to every connected client', async () => {
		const harness = create_ws_test_harness({
			actions: [stub_emit_notifications],
		});
		const broadcast = build_broadcast_api<BroadcastApi>({
			harness,
			specs: [workspace_changed_action_spec],
		});

		const client_a = await harness.connect();
		const client_b = await harness.connect();

		await broadcast.workspace_changed({
			type: 'open',
			workspace: {
				path: DiskfileDirectoryPath.parse('/tmp/test-workspace/'),
				name: 'test-workspace',
				opened_at: '2026-04-18T00:00:00.000Z',
			},
		});

		const match = is_notification('workspace_changed');
		const a = await client_a.wait_for<JsonrpcNotificationFrame<{workspace: {name: string}}>>(match);
		const b = await client_b.wait_for<JsonrpcNotificationFrame<{workspace: {name: string}}>>(match);
		assert.strictEqual(a.params.workspace.name, 'test-workspace');
		assert.strictEqual(b.params.workspace.name, 'test-workspace');
	});

	test('closed clients no longer receive broadcasts', async () => {
		const harness = create_ws_test_harness({
			actions: [stub_emit_notifications],
		});
		const broadcast = build_broadcast_api<BroadcastApi>({
			harness,
			specs: [workspace_changed_action_spec],
		});

		const staying = await harness.connect();
		const leaving = await harness.connect();

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
