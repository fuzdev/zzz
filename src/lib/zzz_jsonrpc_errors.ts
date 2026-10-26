/**
 * zzz-specific JSON-RPC error codes extending fuz_app's base set.
 *
 * fuz_app provides the standard codes plus its general application codes.
 * zzz adds domain-specific codes for AI provider errors.
 *
 * @module
 */

import type { JsonrpcErrorCode, JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import {
	JSONRPC_ERROR_CODES as BASE_JSONRPC_ERROR_CODES,
	jsonrpc_error_messages as base_jsonrpc_error_messages,
	jsonrpc_errors as base_jsonrpc_errors,
	register_jsonrpc_error_code,
	ThrownJsonrpcError,
	type JsonrpcErrorName as BaseJsonrpcErrorName
} from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

/** zzz error names — extends fuz_app's base set with AI provider errors. */
export type JsonrpcErrorName = BaseJsonrpcErrorName | 'ai_provider_error';

/** Extended error codes with zzz-specific AI provider error. */
export const JSONRPC_ERROR_CODES = {
	...BASE_JSONRPC_ERROR_CODES,
	ai_provider_error: -32020 as JsonrpcErrorCode
} as const satisfies Record<JsonrpcErrorName, JsonrpcErrorCode>;

/** Extended error message constructors. */
export const jsonrpc_error_messages = {
	...base_jsonrpc_error_messages,
	ai_provider_error: (provider?: string, message?: string, data?: unknown): JsonrpcErrorObject => ({
		code: JSONRPC_ERROR_CODES.ai_provider_error,
		message:
			provider && message
				? `${provider}: ${message}`
				: provider
					? `${provider}: error`
					: (message ?? 'ai provider error'),
		data
	})
} as const;

const create_error_thrower =
	<TFn extends (...args: Array<any>) => JsonrpcErrorObject>(
		error_fn: TFn
	): ((...args: Parameters<TFn>) => ThrownJsonrpcError) =>
	(...args: Parameters<TFn>) => {
		const m = error_fn(...args);
		return new ThrownJsonrpcError(m.code, m.message, m.data);
	};

/** Extended error throwers. */
export const jsonrpc_errors = {
	...base_jsonrpc_errors,
	ai_provider_error: create_error_thrower(jsonrpc_error_messages.ai_provider_error)
} as const;

// Register zzz's `ai_provider_error` code with fuz_app, so
// `jsonrpc_error_code_to_http_status` answers 502 (bad gateway) rather than 500.
// The frontend imports this module for that side effect (`frontend.svelte.ts`),
// and `sideEffects` keeps it in the build. A registered code joins no reverse
// status → code map: an envelope-less 502 (a proxy in front of a stopped zzzd)
// isn't a provider error.
register_jsonrpc_error_code(JSONRPC_ERROR_CODES.ai_provider_error, 502);
