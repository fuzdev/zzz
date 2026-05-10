/**
 * Test-only action specs and handler.
 *
 * `_test_emit_notifications` + `_test_notification` are kept out of the
 * production codegen surface (`all_action_specs` in `action_specs.ts`).
 * They register on the live HTTP-RPC + WebSocket dispatchers only when
 * `ZZZ_ENABLE_TEST_ACTIONS=1`, which the integration runner sets and
 * production never does.
 *
 * The cross-backend integration test `ctx_notify_socket_scoped`
 * (`test/integration/tests.ts`) exercises socket-scoped `ctx.notify`
 * routing through these specs without depending on a real AI provider.
 * In-process unit tests (`src/test/server/routes/ws.integration.*.test.ts`)
 * import the specs directly into custom action arrays — no env var needed
 * since they bypass the production registration path.
 *
 * @module
 */

import {z} from 'zod';
import type {
	ActionSpecUnion,
	RemoteNotificationActionSpec,
	RequestResponseActionSpec,
} from '@fuzdev/fuz_app/actions/action_spec.js';
import type {ActionContext, ActionHandler} from '@fuzdev/fuz_app/actions/action_rpc.js';

// -- Schemas ----------------------------------------------------------------

/** Input for `_test_emit_notifications`. */
export const TestEmitNotificationsInput = z.strictObject({
	count: z.number().int().min(0).max(100),
});
export type TestEmitNotificationsInput = z.infer<typeof TestEmitNotificationsInput>;

/** Output for `_test_emit_notifications`. */
export const TestEmitNotificationsOutput = z.strictObject({
	count: z.number().int(),
});
export type TestEmitNotificationsOutput = z.infer<typeof TestEmitNotificationsOutput>;

/** Input for `_test_notification`. */
export const TestNotificationInput = z.strictObject({
	index: z.number().int().min(0),
});
export type TestNotificationInput = z.infer<typeof TestNotificationInput>;

// -- Specs ------------------------------------------------------------------

// Authenticated so unauth callers can't spam other sockets. `count` is bounded
// so even with the env var on, a misbehaving client can't DoS the server.
export const _test_emit_notifications_action_spec = {
	method: '_test_emit_notifications',
	kind: 'request_response',
	initiator: 'frontend',
	auth: {account: 'required', actor: 'none'},
	side_effects: false,
	input: TestEmitNotificationsInput,
	output: TestEmitNotificationsOutput,
	async: true,
	streams: '_test_notification',
	description:
		'Test-only. Emits `count` `_test_notification` notifications via ctx.notify, then returns {count}.',
} satisfies RequestResponseActionSpec;

export const _test_notification_action_spec = {
	method: '_test_notification',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TestNotificationInput,
	output: z.void(),
	async: true,
	description:
		'Test-only. Progress notification emitted by _test_emit_notifications; carries the sequence index.',
} satisfies RemoteNotificationActionSpec;

/** Both test specs as a single array — splice into `all_action_specs` when test mode is on. */
export const test_action_specs: Array<ActionSpecUnion> = [
	_test_emit_notifications_action_spec,
	_test_notification_action_spec,
];

// -- Handler ----------------------------------------------------------------

/** Handler for `_test_emit_notifications`. Emits `count` notifications via `ctx.notify`. */
export const handle_test_emit_notifications: ActionHandler<
	TestEmitNotificationsInput,
	TestEmitNotificationsOutput
> = (input, ctx: ActionContext) => {
	for (let i = 0; i < input.count; i++) {
		ctx.notify('_test_notification', {index: i});
	}
	return {count: input.count};
};
