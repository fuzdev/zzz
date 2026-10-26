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

import { describe, test, assert } from 'vitest';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import { default_cross_process_setup } from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';

const handle = inject_backend_handle();
const setup_test = default_cross_process_setup(handle);

describe('completion cross-backend', () => {
	test('completion_create_invalid_provider_rejected', async () => {
		// Sending a completion against an unconfigured provider surfaces as
		// a provider error rather than a successful completion: the
		// cross-process suite has no live provider credentials.
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
		// `gemini` is a registered provider, so an unconfigured instance (no
		// API key in the cross-process suite) is refused by
		// `ProviderClient::require` as `ai_provider_error` — zzz's declared
		// -32020, answering 502 (`src/lib/zzz_jsonrpc_errors.ts`), never an
		// `internal_error`
		assert.strictEqual(res.status, 502);
		assert.strictEqual(res.error.code, -32020);
		assert.strictEqual(res.error.message, 'gemini: needs API key');
	});

	test('completion_create_blank_prompt_rejected', async () => {
		// A blank prompt is refused as invalid params before any provider is
		// consulted, so the missing API key in the cross-process suite doesn't
		// mask it as a provider error.
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
					prompt: ' \n\t'
				}
			},
			headers: fixture.create_session_headers()
		});
		assert.ok(!res.ok, `expected error, got ${JSON.stringify(res)}`);
		assert.strictEqual(
			res.error.code,
			-32602,
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
