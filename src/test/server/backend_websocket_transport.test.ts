import {describe, test, assert} from 'vitest';
import {WSContext} from 'hono/ws';

import {BackendWebsocketTransport} from '../../lib/server/backend_websocket_transport.js';
import {WS_CLOSE_SESSION_REVOKED} from '../../lib/socket_helpers.js';
import type {Uuid} from '../../lib/zod_helpers.js';

interface MockWs {
	ws: WSContext;
	closed: {code?: number; reason?: string} | null;
	sent: Array<string | ArrayBuffer | Uint8Array>;
}

/** Create a mock WSContext that records `send` and `close` calls. */
const create_mock_ws = (): MockWs => {
	const mock: MockWs = {
		ws: null!,
		closed: null,
		sent: [],
	};
	mock.ws = new WSContext({
		send: (data) => {
			mock.sent.push(data);
		},
		close: (code, reason) => {
			mock.closed = {code, reason};
		},
		readyState: 1, // OPEN
	});
	return mock;
};

const ACCOUNT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as Uuid;
const ACCOUNT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' as Uuid;
const TOKEN_HASH_1 = 'hash_session_1';
const TOKEN_HASH_2 = 'hash_session_2';

describe('BackendWebsocketTransport', () => {
	describe('add_connection', () => {
		test('returns a connection ID and makes transport ready', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			assert.ok(!transport.is_ready());
			const id = transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);
			assert.ok(id);
			assert.ok(transport.is_ready());
		});

		test('accepts null token_hash for bearer token connections', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			const id = transport.add_connection(m.ws, null, ACCOUNT_A);
			assert.ok(id);
			assert.ok(transport.is_ready());
		});
	});

	describe('remove_connection', () => {
		test('removes the connection and makes transport not ready', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);
			assert.ok(transport.is_ready());

			transport.remove_connection(m.ws);
			assert.ok(!transport.is_ready());
		});

		test('is idempotent — second call is a no-op', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.remove_connection(m.ws);
			transport.remove_connection(m.ws); // should not throw
			assert.ok(!transport.is_ready());
		});
	});

	describe('close_sockets_for_session', () => {
		test('closes matching sockets and returns count', () => {
			const transport = new BackendWebsocketTransport();
			const m1 = create_mock_ws();
			const m2 = create_mock_ws();

			transport.add_connection(m1.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.add_connection(m2.ws, TOKEN_HASH_2, ACCOUNT_A);

			const count = transport.close_sockets_for_session(TOKEN_HASH_1);
			assert.strictEqual(count, 1);
			assert.strictEqual(m1.closed?.code, WS_CLOSE_SESSION_REVOKED);
			assert.strictEqual(m1.closed?.reason, 'Session revoked');
			assert.strictEqual(m2.closed, null);
		});

		test('closes multiple sockets with the same session', () => {
			const transport = new BackendWebsocketTransport();
			const m1 = create_mock_ws();
			const m2 = create_mock_ws();

			transport.add_connection(m1.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.add_connection(m2.ws, TOKEN_HASH_1, ACCOUNT_A);

			const count = transport.close_sockets_for_session(TOKEN_HASH_1);
			assert.strictEqual(count, 2);
			assert.ok(m1.closed);
			assert.ok(m2.closed);
		});

		test('returns 0 when no sockets match', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);

			const count = transport.close_sockets_for_session('nonexistent_hash');
			assert.strictEqual(count, 0);
			assert.strictEqual(m.closed, null);
		});

		test('skips connections with null token_hash', () => {
			const transport = new BackendWebsocketTransport();
			const m_bearer = create_mock_ws();
			const m_session = create_mock_ws();

			transport.add_connection(m_bearer.ws, null, ACCOUNT_A);
			transport.add_connection(m_session.ws, TOKEN_HASH_1, ACCOUNT_A);

			const count = transport.close_sockets_for_session(TOKEN_HASH_1);
			assert.strictEqual(count, 1);
			assert.strictEqual(m_bearer.closed, null);
			assert.ok(m_session.closed);
		});

		test('cleans up tracking state after revocation', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.close_sockets_for_session(TOKEN_HASH_1);

			assert.ok(!transport.is_ready());
			// remove_connection after revocation is safe (idempotent)
			transport.remove_connection(m.ws);
			assert.ok(!transport.is_ready());
		});
	});

	describe('close_sockets_for_account', () => {
		test('closes all sockets for an account across sessions', () => {
			const transport = new BackendWebsocketTransport();
			const m1 = create_mock_ws();
			const m2 = create_mock_ws();
			const m3 = create_mock_ws();

			transport.add_connection(m1.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.add_connection(m2.ws, TOKEN_HASH_2, ACCOUNT_A);
			transport.add_connection(m3.ws, TOKEN_HASH_1, ACCOUNT_B);

			const count = transport.close_sockets_for_account(ACCOUNT_A);
			assert.strictEqual(count, 2);
			assert.ok(m1.closed);
			assert.ok(m2.closed);
			assert.strictEqual(m3.closed, null);
			assert.ok(transport.is_ready()); // m3 still connected
		});

		test('returns 0 when no sockets match', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);

			const count = transport.close_sockets_for_account(ACCOUNT_B);
			assert.strictEqual(count, 0);
		});

		test('closes connections with null token_hash', () => {
			const transport = new BackendWebsocketTransport();
			const m_bearer = create_mock_ws();
			const m_session = create_mock_ws();

			transport.add_connection(m_bearer.ws, null, ACCOUNT_A);
			transport.add_connection(m_session.ws, TOKEN_HASH_1, ACCOUNT_A);

			const count = transport.close_sockets_for_account(ACCOUNT_A);
			assert.strictEqual(count, 2);
			assert.ok(m_bearer.closed);
			assert.ok(m_session.closed);
		});
	});

	describe('is_ready', () => {
		test('stays ready after partial removal', () => {
			const transport = new BackendWebsocketTransport();
			const m1 = create_mock_ws();
			const m2 = create_mock_ws();
			const m3 = create_mock_ws();

			transport.add_connection(m1.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.add_connection(m2.ws, TOKEN_HASH_2, ACCOUNT_A);
			transport.add_connection(m3.ws, TOKEN_HASH_1, ACCOUNT_B);

			transport.remove_connection(m1.ws);
			assert.ok(transport.is_ready());

			transport.remove_connection(m2.ws);
			assert.ok(transport.is_ready());

			transport.remove_connection(m3.ws);
			assert.ok(!transport.is_ready());
		});

		test('stays ready after partial revocation', () => {
			const transport = new BackendWebsocketTransport();
			const m1 = create_mock_ws();
			const m2 = create_mock_ws();

			transport.add_connection(m1.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.add_connection(m2.ws, TOKEN_HASH_2, ACCOUNT_B);

			transport.close_sockets_for_session(TOKEN_HASH_1);
			assert.ok(transport.is_ready()); // m2 still connected
		});
	});

	describe('broadcast after revocation', () => {
		test('send only reaches remaining connections', async () => {
			const transport = new BackendWebsocketTransport();
			const m1 = create_mock_ws();
			const m2 = create_mock_ws();
			const m3 = create_mock_ws();

			transport.add_connection(m1.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.add_connection(m2.ws, TOKEN_HASH_2, ACCOUNT_A);
			transport.add_connection(m3.ws, TOKEN_HASH_1, ACCOUNT_B);

			// Revoke account A's sockets
			transport.close_sockets_for_account(ACCOUNT_A);

			// Broadcast a notification — only m3 should receive it
			await transport.send({jsonrpc: '2.0', method: 'test_event', params: {}});

			assert.strictEqual(m1.sent.length, 0);
			assert.strictEqual(m2.sent.length, 0);
			assert.strictEqual(m3.sent.length, 1);
		});
	});

	describe('interleaved revocation', () => {
		test('session revoke then account revoke does not double-count', () => {
			const transport = new BackendWebsocketTransport();
			const m1 = create_mock_ws();
			const m2 = create_mock_ws();

			// Same account, different sessions
			transport.add_connection(m1.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.add_connection(m2.ws, TOKEN_HASH_2, ACCOUNT_A);

			// Revoke session 1 — closes m1
			const session_count = transport.close_sockets_for_session(TOKEN_HASH_1);
			assert.strictEqual(session_count, 1);

			// Revoke account A — only m2 remains, m1 already cleaned up
			const account_count = transport.close_sockets_for_account(ACCOUNT_A);
			assert.strictEqual(account_count, 1);

			assert.ok(!transport.is_ready());
		});

		test('account revoke then session revoke returns 0', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);

			transport.close_sockets_for_account(ACCOUNT_A);
			const count = transport.close_sockets_for_session(TOKEN_HASH_1);
			assert.strictEqual(count, 0);
		});
	});

	describe('bearer token connections', () => {
		test('session revoke skips bearer, account revoke catches both', () => {
			const transport = new BackendWebsocketTransport();
			const m_bearer = create_mock_ws();
			const m_session = create_mock_ws();

			transport.add_connection(m_bearer.ws, null, ACCOUNT_A);
			transport.add_connection(m_session.ws, TOKEN_HASH_1, ACCOUNT_A);

			// Session revoke only catches the session connection
			const session_count = transport.close_sockets_for_session(TOKEN_HASH_1);
			assert.strictEqual(session_count, 1);
			assert.strictEqual(m_bearer.closed, null);
			assert.ok(m_session.closed);

			// Account revoke catches the remaining bearer connection
			const account_count = transport.close_sockets_for_account(ACCOUNT_A);
			assert.strictEqual(account_count, 1);
			assert.ok(m_bearer.closed);
		});

		test('remove_connection after bearer add is safe', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, null, ACCOUNT_A);
			transport.remove_connection(m.ws);
			assert.ok(!transport.is_ready());
		});
	});

	describe('revocation then remove_connection', () => {
		test('remove_connection after close_sockets_for_session is safe', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.close_sockets_for_session(TOKEN_HASH_1);

			// onClose handler would call remove_connection — must not throw
			transport.remove_connection(m.ws);
		});

		test('remove_connection after close_sockets_for_account is safe', () => {
			const transport = new BackendWebsocketTransport();
			const m = create_mock_ws();

			transport.add_connection(m.ws, TOKEN_HASH_1, ACCOUNT_A);
			transport.close_sockets_for_account(ACCOUNT_A);

			transport.remove_connection(m.ws);
		});
	});
});
