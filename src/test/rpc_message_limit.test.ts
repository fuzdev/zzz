import { test, describe, assert } from 'vitest';

import {
	RPC_MESSAGE_MAX_BYTES,
	create_rpc_message_too_large_error,
	to_rpc_message_size
} from '$lib/rpc_message_limit.ts';

describe('to_rpc_message_size', () => {
	test('counts UTF-8 bytes of the JSON encoding', () => {
		assert.strictEqual(to_rpc_message_size({ a: 'x' }), '{"a":"x"}'.length);
		// 3 bytes each
		assert.strictEqual(to_rpc_message_size('€€'), 2 + 6);
		// escaping counts: a newline goes out as `\n`
		assert.strictEqual(to_rpc_message_size('\n'), 4);
	});
});

describe('create_rpc_message_too_large_error', () => {
	test('is invalid_request with the payload_too_large reason', () => {
		const error = create_rpc_message_too_large_error(RPC_MESSAGE_MAX_BYTES + 1);
		assert.strictEqual(error.code, -32600);
		assert.deepEqual(error.data, { reason: 'payload_too_large' });
		assert.ok(error.message.startsWith('request too large'), error.message);
	});
});
