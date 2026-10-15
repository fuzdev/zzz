// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi, type MockInstance } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import type { Transport } from '@fuzdev/fuz_app/actions/transports.ts';

import { QUIET_ACTION_METHODS } from '#lib/action_helpers.ts';
import { Frontend, type FrontendOptions } from '#lib/frontend.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const NOT_FOUND: JsonrpcErrorObject = {
	code: JSONRPC_ERROR_CODES.not_found,
	message: 'terminal not found'
};

let app: Frontend;
let console_error: MockInstance;

/** An app whose real dispatcher sends over a transport that answers every request with `error`. */
const create_app = (error: JsonrpcErrorObject | null, options?: FrontendOptions): Frontend => {
	app = monkeypatch_zzz_for_tests(new Frontend(options));
	const transport = {
		transport_name: 'stub',
		is_ready: () => true,
		send: (message: { id?: unknown }) =>
			Promise.resolve(
				error
					? { jsonrpc: '2.0', id: message.id, error }
					: { jsonrpc: '2.0', id: message.id, result: null }
			)
	} as unknown as Transport;
	app.peer.transports.register_transport(transport);
	return app;
};

const methods_logged = (): Array<string> => app.actions.items.values.map((action) => action.method);

beforeEach(() => {
	console_error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	console_error.mockRestore();
	app.dispose();
});

describe('quiet action methods', () => {
	test('`terminal_ack` is one', () => {
		create_app(null);
		assert.ok(QUIET_ACTION_METHODS.has('terminal_ack'));
	});

	test('their calls stay out of the actions log', async () => {
		create_app(null);
		const terminal_id = create_uuid();
		for (let bytes = 1; bytes <= 3; bytes++) {
			const result = await app.api.terminal_ack({ terminal_id, bytes });
			assert.ok(result.ok);
		}
		assert.deepEqual(methods_logged(), []);

		// any other call is still recorded
		await app.api.terminal_resize({ terminal_id, cols: 80, rows: 24 });
		assert.deepEqual(methods_logged(), ['terminal_resize']);
	});

	test('an ack answered `not_found` reaches its caller and logs nothing', async () => {
		create_app(NOT_FOUND);
		const terminal_id = create_uuid();
		const result = await app.api.terminal_ack({ terminal_id, bytes: 1 });
		assert.ok(!result.ok);
		assert.strictEqual(result.error.code, JSONRPC_ERROR_CODES.not_found);
		assert.deepEqual(console_error.mock.calls, [], 'the terminal closing first is expected');

		// the same answer to any other method is still reported by the dispatcher
		await app.api.terminal_resize({ terminal_id, cols: 80, rows: 24 });
		assert.deepEqual(console_error.mock.calls, [
			['[peer] send request failed:', 'terminal_resize', 'terminal not found']
		]);
	});

	test('an `unauthenticated` answer to one still triggers the session recheck', async () => {
		const on_unauthenticated = vi.fn();
		create_app(
			{ code: JSONRPC_ERROR_CODES.unauthenticated, message: 'unauthenticated' },
			{ on_unauthenticated }
		);
		await app.api.terminal_ack({ terminal_id: create_uuid(), bytes: 1 });
		assert.strictEqual(on_unauthenticated.mock.calls.length, 1);
	});
});
