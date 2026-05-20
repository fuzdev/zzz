/**
 * WebSocket cancel integration — `completion_create` handler translation.
 *
 * Proves that zzz's completion handler translates `ctx.signal.aborted` into
 * `request_cancelled` (-32010), not `ai_provider_error` (-32020), even when
 * the underlying provider throws a plain Error. The shared cancel primitive
 * is exercised in `ws.integration.cancel.test.ts`; this file covers the
 * zzz-specific discriminator inside `completion_create` — the handler
 * checks `ctx.signal.aborted` (authoritative), not the error shape (each
 * SDK throws a different abort type).
 *
 * A stub backend supplies a fake provider whose `get_handler` returns a
 * function under test's control — no real AI provider, no real Backend
 * class. The full WS dispatch path (cancel notification → pending
 * controller lookup → abort → catch in handler → re-throw as typed error)
 * runs for real via `create_ws_test_harness`.
 *
 * Two cases:
 *   - Positive: client cancel fires → signal aborts → stub throws generic
 *     error → handler re-throws as `request_cancelled`.
 *   - Negative: provider throws with signal never aborted → falls through
 *     to `ai_provider_error`. Proves the signal is the discriminator.
 *
 * @module
 */

import {test, assert, describe} from 'vitest';
import {create_ws_test_harness} from '@fuzdev/fuz_app/testing/ws_round_trip.js';
import {
	is_response_for,
	type JsonrpcErrorResponseFrame,
} from '@fuzdev/fuz_app/testing/transports/ws_client.js';
import {cancel_action, cancel_action_spec} from '@fuzdev/fuz_app/actions/cancel.js';
import {JSONRPC_ERROR_CODES as BASE_JSONRPC_ERROR_CODES} from '@fuzdev/fuz_app/http/jsonrpc_errors.js';

import {completion_create_action_spec} from '$lib/action_specs.js';
import {create_zzz_action_handlers} from '$lib/server/zzz_action_handlers.js';
import type {Backend} from '$lib/server/backend.js';
import {JSONRPC_ERROR_CODES as ZZZ_JSONRPC_ERROR_CODES} from '$lib/zzz_jsonrpc_errors.js';

interface StubProviderHandlerOptions {
	signal?: AbortSignal;
}

interface StubProvider {
	get_handler: (streaming: boolean) => (options: StubProviderHandlerOptions) => Promise<never>;
}

const STUB_CONFIG = {
	frequency_penalty: undefined,
	output_token_max: 256,
	presence_penalty: undefined,
	seed: undefined,
	stop_sequences: undefined,
	system_message: '',
	temperature: undefined,
	top_k: undefined,
	top_p: undefined,
};

/**
 * Slice of `Backend` actually touched by the `completion_create` handler.
 * Other handlers' fields (`pty_manager`, `workspace_*`, `filers`, …) aren't
 * needed here; per-field casts below acknowledge each shortcut.
 */
type CompletionStubBackend = Pick<Backend, 'config' | 'lookup_provider' | 'zzz_dir' | 'scoped_fs'>;

const create_stub_backend = (provider: StubProvider): CompletionStubBackend => ({
	// Partial ZzzOptions — completion_create only reads completion-tuning fields.
	config: STUB_CONFIG as Backend['config'],
	// `lookup_provider` is generic across provider names; the stub is enough for the cancel path.
	lookup_provider: (() => provider) as Backend['lookup_provider'],
	// Branded DiskfileDirectoryPath — never written to in this test.
	zzz_dir: '/tmp/zzz-test' as Backend['zzz_dir'],
	// `save_completion_response_to_disk` is never reached (both paths throw before it).
	scoped_fs: {} as Backend['scoped_fs'],
});

const create_test_completion_request = () => ({
	created: new Date().toISOString(),
	provider_name: 'claude' as const,
	model: 'claude-sonnet-4-5',
	prompt: 'test prompt',
});

describe('zzz WebSocket — completion_create cancel translation', () => {
	test('client cancel translates to request_cancelled (-32010), not ai_provider_error', async () => {
		let captured_signal: AbortSignal | null = null;

		const stub_provider: StubProvider = {
			get_handler: () => async (options) => {
				captured_signal = options.signal ?? null;
				await new Promise<void>((resolve) => {
					if (options.signal?.aborted) {
						resolve();
						return;
					}
					options.signal?.addEventListener('abort', () => resolve(), {once: true});
				});
				// Mimics an SDK abort error — a plain Error, not a ThrownJsonrpcError.
				// The handler discriminates on ctx.signal.aborted, not this shape.
				throw new Error('APIUserAbortError: Request was aborted.');
			},
		};

		const handlers = create_zzz_action_handlers(create_stub_backend(stub_provider) as Backend);

		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: completion_create_action_spec,
					handler: handlers.completion_create,
				},
			],
		});

		const client = await harness.connect();

		const request_id = 100;
		void client.send({
			jsonrpc: '2.0',
			id: request_id,
			method: 'completion_create',
			params: {
				completion_request: create_test_completion_request(),
			},
		});

		// Let the dispatcher register the pending controller and the handler enter its await.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		assert.ok(captured_signal, 'handler should have captured its signal');
		assert.strictEqual((captured_signal as AbortSignal).aborted, false);

		await client.send({
			jsonrpc: '2.0',
			method: cancel_action_spec.method,
			params: {request_id},
		});

		const response = await client.wait_for<JsonrpcErrorResponseFrame>(is_response_for(request_id));
		assert.ok('error' in response);
		assert.strictEqual(
			response.error.code,
			BASE_JSONRPC_ERROR_CODES.request_cancelled,
			`expected request_cancelled (${BASE_JSONRPC_ERROR_CODES.request_cancelled}) but got code ${response.error.code}: ${response.error.message}`,
		);
		assert.notStrictEqual(
			response.error.code,
			ZZZ_JSONRPC_ERROR_CODES.ai_provider_error,
			'cancel must not surface as ai_provider_error',
		);
		assert.strictEqual((captured_signal as AbortSignal).aborted, true);
	});

	test('non-cancel provider error stays ai_provider_error (-32020) — signal is the discriminator', async () => {
		const stub_provider: StubProvider = {
			get_handler: () => () => {
				throw new Error('API key revoked');
			},
		};

		const handlers = create_zzz_action_handlers(create_stub_backend(stub_provider) as Backend);

		const harness = create_ws_test_harness({
			actions: [
				cancel_action,
				{
					spec: completion_create_action_spec,
					handler: handlers.completion_create,
				},
			],
		});

		const client = await harness.connect();

		const request_id = 200;
		await client.send({
			jsonrpc: '2.0',
			id: request_id,
			method: 'completion_create',
			params: {
				completion_request: create_test_completion_request(),
			},
		});

		const response = await client.wait_for<JsonrpcErrorResponseFrame>(is_response_for(request_id));
		assert.ok('error' in response);
		assert.strictEqual(
			response.error.code,
			ZZZ_JSONRPC_ERROR_CODES.ai_provider_error,
			`expected ai_provider_error (${ZZZ_JSONRPC_ERROR_CODES.ai_provider_error}) but got code ${response.error.code}: ${response.error.message}`,
		);
		assert.notStrictEqual(
			response.error.code,
			BASE_JSONRPC_ERROR_CODES.request_cancelled,
			'non-cancel error must not surface as request_cancelled',
		);
		assert.match(response.error.message, /API key revoked/);
	});
});
