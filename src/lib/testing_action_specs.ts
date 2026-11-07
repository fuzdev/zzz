/**
 * Test-only action specs.
 *
 * `_testing_emit_notifications` + `_testing_notification` are kept out of the
 * production codegen surface (`all_action_specs` in `action_specs.ts`).
 * These are the TS twins of the methods zzzd's Rust registry registers on the
 * live HTTP-RPC + WebSocket dispatchers, only when `ZZZ_ENABLE_TEST_ACTIONS=1`,
 * which the cross-process test binary (`testing_zzz_server`) sets
 * unconditionally and production never does.
 *
 * Naming follows the test-binary safety convention — `_testing_*` /
 * `Testing*` for anything wire-visible or artifact-shipping, matching
 * `fuz_testing` / `TestingArgon2idHasher` / `testing_zzz_server`.
 *
 * @module
 */

import type {
	RemoteNotificationActionSpec,
	RequestResponseActionSpec
} from '@fuzdev/fuz_app/actions/action_spec.ts';
import {
	integer,
	max_value,
	min_value,
	number,
	object,
	pipe,
	safe_integer,
	void as fuz_void,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

// -- Schemas ----------------------------------------------------------------

/** Input for `_testing_emit_notifications`. */
export const TestingEmitNotificationsInput = object({
	count: pipe(number, integer, min_value(0), max_value(100))
});
export type TestingEmitNotificationsInput = Infer<typeof TestingEmitNotificationsInput>;

/** Output for `_testing_emit_notifications`. */
export const TestingEmitNotificationsOutput = object({
	count: pipe(number, safe_integer)
});
export type TestingEmitNotificationsOutput = Infer<typeof TestingEmitNotificationsOutput>;

/** Input for `_testing_notification`. */
export const TestingNotificationInput = object({
	index: pipe(number, safe_integer, min_value(0))
});
export type TestingNotificationInput = Infer<typeof TestingNotificationInput>;

// -- Specs ------------------------------------------------------------------

// Authenticated so unauth callers can't spam other sockets. `count` is bounded
// so even with the env var on, a misbehaving client can't DoS the server.
export const _testing_emit_notifications_action_spec = {
	method: '_testing_emit_notifications',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: TestingEmitNotificationsInput,
	output: TestingEmitNotificationsOutput,
	async: true,
	streams: '_testing_notification',
	description:
		'Test-only. Emits `count` `_testing_notification` notifications via ctx.notify, then returns {count}.'
} satisfies RequestResponseActionSpec;

export const _testing_notification_action_spec = {
	method: '_testing_notification',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TestingNotificationInput,
	output: fuz_void,
	async: true,
	description:
		'Test-only. Progress notification emitted by _testing_emit_notifications; carries the sequence index.'
} satisfies RemoteNotificationActionSpec;
