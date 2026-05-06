/**
 * zzz-specific JSON-RPC error codes extending fuz_app's base set.
 *
 * fuz_app provides 5 standard + 8 general application error codes.
 * zzz adds domain-specific codes for AI provider errors.
 *
 * @module
 */

import type {JsonrpcErrorCode, JsonrpcErrorObject} from '@fuzdev/fuz_app/http/jsonrpc.js';
import {
	JSONRPC_ERROR_CODES as BASE_JSONRPC_ERROR_CODES,
	JSONRPC_ERROR_CODE_TO_HTTP_STATUS,
	HTTP_STATUS_TO_JSONRPC_ERROR_CODE,
	jsonrpc_error_messages as base_jsonrpc_error_messages,
	jsonrpc_errors as base_jsonrpc_errors,
	ThrownJsonrpcError,
	type JsonrpcErrorName as BaseJsonrpcErrorName,
} from '@fuzdev/fuz_app/http/jsonrpc_errors.js';

/** zzz error names — extends fuz_app's base set with AI provider errors. */
export type JsonrpcErrorName = BaseJsonrpcErrorName | 'ai_provider_error';

/** Extended error codes with zzz-specific AI provider error. */
export const JSONRPC_ERROR_CODES = {
	...BASE_JSONRPC_ERROR_CODES,
	ai_provider_error: -32020 as JsonrpcErrorCode,
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
		data,
	}),
} as const;

const create_error_thrower =
	<TFn extends (...args: Array<any>) => JsonrpcErrorObject>(
		error_fn: TFn,
	): ((...args: Parameters<TFn>) => ThrownJsonrpcError) =>
	(...args: Parameters<TFn>) => {
		const m = error_fn(...args);
		return new ThrownJsonrpcError(m.code, m.message, m.data);
	};

/** Extended error throwers. */
export const jsonrpc_errors = {
	...base_jsonrpc_errors,
	ai_provider_error: create_error_thrower(jsonrpc_error_messages.ai_provider_error),
} as const;

// Extend fuz_app's HTTP status mappings with zzz-specific codes.
// These are plain objects designed for consumer extension via mutation —
// fuz_app's `jsonrpc_error_code_to_http_status` reads from them at call time.
JSONRPC_ERROR_CODE_TO_HTTP_STATUS[-32020] = 502; // ai_provider_error → bad gateway
HTTP_STATUS_TO_JSONRPC_ERROR_CODE[502] = JSONRPC_ERROR_CODES.ai_provider_error;
