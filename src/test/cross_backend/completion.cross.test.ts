/**
 * Cross-backend integration tests for `completion_create`.
 *
 * The cross-backend matrix doesn't wire real provider integrations (no
 * keeper provider API keys in the test binary). This file covers what
 * is portable today — a smoke RPC against a registered-but-unconfigured
 * provider, which the backend rejects for lack of an API key.
 *
 * @module
 */

import { describe, test, inject, assert } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

describe('completion cross-backend', () => {
	test('completion_create_invalid_provider_rejected', async () => {
		// Sending a completion against an unconfigured provider should
		// surface as an RPC error rather than a successful completion.
		// Neither backend has live provider credentials in the cross-process
		// suite, so both should error — the exact code differs by backend
		// but every code in the JSON-RPC spec range is rejection.
		const fixture = await setup_test();
		const res = await rpc_call({
			app: fixture.transport,
			path: handle.config.rpc_path,
			method: 'completion_create',
			params: {
				completion_request: {
					created: new Date().toISOString(),
					provider_name: 'gemini',
					model: 'nonexistent_model_zzz_cross',
					prompt: 'cross-backend completion smoke test'
				}
			},
			headers: fixture.create_session_headers()
		});
		assert.ok(!res.ok, `expected error, got ${JSON.stringify(res)}`);
		// `gemini` is a registered provider, so an unconfigured instance
		// (no API key in the cross-process suite) surfaces as
		// `ai_provider_error` (-32020); an unregistered provider would surface
		// as internal-error (-32603) or invalid-params (-32602). Any of the
		// three is a valid rejection — every code in the JSON-RPC spec range
		// means "not a successful completion", and the exact code is
		// environment-dependent and identical across all three TS runtimes.
		assert.ok(
			res.error.code === -32603 || res.error.code === -32602 || res.error.code === -32020,
			`unexpected error code: ${res.error.code} (${res.error.message})`
		);
	});

	// TODO: completion_create happy-path + cancel coverage needs a mock
	// provider plumbed into the test binaries (no live keys in the
	// cross-backend matrix). The old standalone runner skipped the
	// happy path for the same reason — it only exercised
	// `_testing_emit_notifications` to cover the streaming notification
	// fan-out path generically. See `ctx_notify_socket_scoped` in the
	// old runner for that primitive.
});
