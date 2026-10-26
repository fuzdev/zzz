import { test, describe, assert } from 'vitest';
import {
	JSONRPC_ERROR_CODES as BASE_JSONRPC_ERROR_CODES,
	http_status_to_jsonrpc_error_code,
	jsonrpc_error_code_to_http_status
} from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import type { JsonrpcErrorCode } from '@fuzdev/fuz_app/http/jsonrpc.ts';

// the frontend module alone — no direct import of `zzz_jsonrpc_errors.ts` —
// so this pins that loading the frontend registers zzz's codes (the code is
// spelled out here for the same reason)
import '#lib/frontend.svelte.ts';

describe('frontend JSON-RPC error codes', () => {
	test('loading the frontend registers ai_provider_error as 502', () => {
		// the HTTP transport checks a response's status against this table
		assert.strictEqual(jsonrpc_error_code_to_http_status(-32020 as JsonrpcErrorCode), 502);
	});

	test('an envelope-less 502 is not read as ai_provider_error', () => {
		// a proxy in front of a stopped zzzd answers 502 with no JSON-RPC body
		assert.strictEqual(
			http_status_to_jsonrpc_error_code(502),
			BASE_JSONRPC_ERROR_CODES.internal_error
		);
	});
});
