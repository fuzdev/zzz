// TODO: Phase 5 — import standard error codes from @fuzdev/fuz_app/http/jsonrpc_errors.js
// when the branded JsonrpcErrorCode types are unified between zzz and fuz_app.
// Currently kept local because zzz's JsonrpcErrorCode (from jsonrpc.ts) uses a different
// Zod brand than fuz_app's, making the types nominally incompatible.

import {
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	type JsonrpcErrorCode,
	type JsonrpcErrorJson,
} from './jsonrpc.js';

// TODO maybe move some of this to `jsonrpc.ts` and extract the rest to `jsonrpc_helpers.ts`,
// some of this is awkward, see `create_jsonrpc_error_message`
// and `create_jsonrpc_error_message_from_thrown` in `jsonrpc_helpers.ts`

// TODO of these, maybe implement `timeout` first, refine the API

/**
 * Includes standard JSON-RPC error codes and application-specific errors.
 */
export type JsonrpcErrorName =
	| 'parse_error'
	| 'invalid_request'
	| 'method_not_found'
	| 'invalid_params'
	| 'internal_error'
	| 'unauthenticated' // begin application-specific errors
	| 'forbidden'
	| 'not_found'
	| 'conflict'
	| 'validation_error'
	| 'rate_limited'
	| 'service_unavailable'
	| 'timeout'
	// | 'insufficient_storage'
	| 'ai_provider_error';

/**
 * Extended JSON-RPC error codes with application-specific errors.
 */
export const JSONRPC_ERROR_CODES = {
	// Standard JSON-RPC errors - https://www.jsonrpc.org/specification
	/** -32700 */
	parse_error: JSONRPC_PARSE_ERROR,
	/** -32600 */
	invalid_request: JSONRPC_INVALID_REQUEST,
	/** -32601 */
	method_not_found: JSONRPC_METHOD_NOT_FOUND,
	/** -32602 */
	invalid_params: JSONRPC_INVALID_PARAMS,
	/** -32603 */
	internal_error: JSONRPC_INTERNAL_ERROR,

	// These are the application-specific errors (-32000 to -32099,
	// JSONRPC_SERVER_ERROR_START to JSONRPC_SERVER_ERROR_END)
	// defined in the spec - https://www.jsonrpc.org/specification

	// Casts to `JsonrpcErrorCode` because parse has a runtime cost
	// and this is needed for the exported types.

	/**
	 * Same as HTTP status code 401 "unauthorized", but correctly named.
	 *
	 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status#client_error_responses
	 */
	unauthenticated: -32001 as JsonrpcErrorCode,
	/**
	 * This could be `unauthorized` for better symmetry with `unauthenticated`,
	 * but Zzz names it the same as HTTP status code 403 to avoid confusion
	 * with 401 which is incorrectly named "unauthorized" in HTTP
	 * (basics were still being figured out, this is backwards compat in action).
	 *
	 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status#client_error_responses
	 */
	forbidden: -32002 as JsonrpcErrorCode,
	not_found: -32003 as JsonrpcErrorCode,
	conflict: -32004 as JsonrpcErrorCode,
	/**
	 * For application-level validation failures (e.g., business logic validation).
	 * Use `invalid_params` (-32602) for schema/parsing failures of input parameters.
	 */
	validation_error: -32005 as JsonrpcErrorCode,
	rate_limited: -32006 as JsonrpcErrorCode,
	service_unavailable: -32007 as JsonrpcErrorCode,
	timeout: -32008 as JsonrpcErrorCode,
	// insufficient_storage: -32009 as JsonrpcErrorCode,
	// file_too_large: -32010 as JsonrpcErrorCode,
	// unsupported_media_type: -32011 as JsonrpcErrorCode,

	// AI provider specific errors
	ai_provider_error: -32020 as JsonrpcErrorCode,
	// ai_model_not_found: -32021 as JsonrpcErrorCode,
	// ai_quota_exceeded: -32022 as JsonrpcErrorCode,
	// ai_invalid_request: -32023 as JsonrpcErrorCode,
} as const satisfies Record<JsonrpcErrorName, JsonrpcErrorCode>;

export const jsonrpc_error_messages = {
	parse_error: (data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.parse_error,
		message: 'parse error',
		data,
	}),

	invalid_request: (data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.invalid_request,
		message: 'invalid request',
		data,
	}),

	method_not_found: (method?: string, data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.method_not_found,
		message: method ? `method not found: ${method}` : 'method not found',
		data,
	}),

	invalid_params: (message?: string, data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.invalid_params,
		message: message ?? 'invalid params',
		data,
	}),

	internal_error: (
		message: string = 'internal server error',
		data?: unknown,
	): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.internal_error,
		message,
		data,
	}),

	unauthenticated: (message: string = 'unauthenticated', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.unauthenticated,
		message,
		data,
	}),

	forbidden: (message: string = 'forbidden', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.forbidden,
		message,
		data,
	}),

	not_found: (resource?: string, data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.not_found,
		message: resource ? `${resource} not found` : 'not found',
		data,
	}),

	conflict: (message: string = 'conflict', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.conflict,
		message,
		data,
	}),

	validation_error: (message: string = 'validation error', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.validation_error,
		message,
		data,
	}),

	rate_limited: (message: string = 'rate limited', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.rate_limited,
		message,
		data,
	}),

	service_unavailable: (
		message: string = 'service unavailable',
		data?: unknown,
	): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.service_unavailable,
		message,
		data,
	}),

	timeout: (message: string = 'timeout', data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.timeout,
		message,
		data,
	}),

	// insufficient_storage: (
	// 	message: string = 'insufficient storage',
	// 	data?: unknown,
	// ): JsonrpcErrorJson => ({
	// 	code: JSONRPC_ERROR_CODES.insufficient_storage,
	// 	message,
	// 	data,
	// }),

	ai_provider_error: (provider?: string, message?: string, data?: unknown): JsonrpcErrorJson => ({
		code: JSONRPC_ERROR_CODES.ai_provider_error,
		message:
			provider && message
				? `${provider}: ${message}`
				: provider
					? `${provider}: error`
					: (message ?? 'ai provider error'),
		data,
	}),
} as const satisfies Record<JsonrpcErrorName, (...args: Array<any>) => JsonrpcErrorJson>;

/**
 * Custom error class for JSON-RPC errors.
 */
export class ThrownJsonrpcError extends Error {
	code: JsonrpcErrorCode;
	data?: unknown;

	constructor(code: JsonrpcErrorCode, message: string, data?: unknown, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
		this.data = data;
	}
}

const create_error_thrower =
	<TFn extends (...args: Array<any>) => JsonrpcErrorJson>(
		error_fn: TFn,
	): ((...args: Parameters<TFn>) => ThrownJsonrpcError) =>
	(...args: Parameters<TFn>) => {
		const m = error_fn(...args);
		return new ThrownJsonrpcError(m.code, m.message, m.data);
	};

export const jsonrpc_errors = {
	parse_error: create_error_thrower(jsonrpc_error_messages.parse_error),
	invalid_request: create_error_thrower(jsonrpc_error_messages.invalid_request),
	method_not_found: create_error_thrower(jsonrpc_error_messages.method_not_found),
	invalid_params: create_error_thrower(jsonrpc_error_messages.invalid_params),
	internal_error: create_error_thrower(jsonrpc_error_messages.internal_error),
	unauthenticated: create_error_thrower(jsonrpc_error_messages.unauthenticated),
	forbidden: create_error_thrower(jsonrpc_error_messages.forbidden),
	not_found: create_error_thrower(jsonrpc_error_messages.not_found),
	validation_error: create_error_thrower(jsonrpc_error_messages.validation_error),
	conflict: create_error_thrower(jsonrpc_error_messages.conflict),
	rate_limited: create_error_thrower(jsonrpc_error_messages.rate_limited),
	service_unavailable: create_error_thrower(jsonrpc_error_messages.service_unavailable),
	timeout: create_error_thrower(jsonrpc_error_messages.timeout),
	// insufficient_storage: create_error_thrower(jsonrpc_error_messages.insufficient_storage),
	ai_provider_error: create_error_thrower(jsonrpc_error_messages.ai_provider_error),
} as const satisfies Record<JsonrpcErrorName, (...args: Array<any>) => ThrownJsonrpcError>;
