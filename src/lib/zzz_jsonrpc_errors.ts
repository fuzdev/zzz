/**
 * zzz-specific JSON-RPC error codes extending fuz_app's base set.
 *
 * fuz_app provides the standard codes plus its general application codes.
 * zzz adds `ai_provider_error` for AI provider failures, which zzzd raises;
 * importing this module registers its HTTP status with fuz_app.
 *
 * @module
 */

import type { JsonrpcErrorCode } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import {
	JSONRPC_ERROR_CODES as BASE_JSONRPC_ERROR_CODES,
	register_jsonrpc_error_code,
	type JsonrpcErrorName as BaseJsonrpcErrorName
} from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

/** zzz error names — extends fuz_app's base set with AI provider errors. */
export type JsonrpcErrorName = BaseJsonrpcErrorName | 'ai_provider_error';

/** Extended error codes with zzz-specific AI provider error. */
export const JSONRPC_ERROR_CODES = {
	...BASE_JSONRPC_ERROR_CODES,
	ai_provider_error: -32020 as JsonrpcErrorCode
} as const satisfies Record<JsonrpcErrorName, JsonrpcErrorCode>;

// Register zzz's `ai_provider_error` code with fuz_app, so
// `jsonrpc_error_code_to_http_status` answers 502 (bad gateway) rather than 500.
// The frontend imports this module for that side effect (`frontend.svelte.ts`),
// and `sideEffects` keeps it in the build. A registered code joins no reverse
// status → code map: an envelope-less 502 (a proxy in front of a stopped zzzd)
// isn't a provider error.
register_jsonrpc_error_code(JSONRPC_ERROR_CODES.ai_provider_error, 502);
