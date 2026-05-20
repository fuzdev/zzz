/**
 * Cross-backend integration tests for `completion_create`.
 *
 * The old standalone runner exercises completions through real provider
 * integrations, which the cross-backend matrix doesn't wire (no keeper
 * provider API keys in the test binaries). This file covers what is
 * portable today — invalid-provider rejection plus a smoke RPC against
 * the Ollama provider, which the test binaries stub as unavailable.
 *
 * @module
 */

import {describe, test, inject, assert} from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {rpc_call} from '@fuzdev/fuz_app/testing/rpc_helpers.js';

import './cross_test_types.js';

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
					provider_name: 'ollama',
					model: 'nonexistent_model_zzz_cross',
					prompt: 'cross-backend completion smoke test',
				},
			},
			headers: fixture.create_session_headers(),
		});
		assert.ok(!res.ok, `expected error, got ${JSON.stringify(res)}`);
		// Either provider-unavailable (-32603) or invalid-params (-32602)
		// is acceptable — both backends surface unconfigured-provider as
		// one of these.
		assert.ok(
			res.error.code === -32603 || res.error.code === -32602,
			`unexpected error code: ${res.error.code} (${res.error.message})`,
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
