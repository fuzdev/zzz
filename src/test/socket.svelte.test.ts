// @vitest-environment jsdom

import {beforeEach, describe, test, vi, afterEach, assert} from 'vitest';
import {DEFAULT_CLOSE_CODE} from '@fuzdev/fuz_app/actions/socket.svelte.js';

import {Socket} from '$lib/socket.svelte.js';
import {Frontend} from '$lib/frontend.svelte.js';

import {monkeypatch_zzz_for_tests} from './test_helpers.js';

/**
 * Reconnect, close-code backoff, and heartbeat are tested in fuz_app's
 * `FrontendWebsocketClient` suite — this file focuses on what the Socket
 * wrapper adds on top: fire-and-forget message queueing and URL input
 * tracking.
 */

class Mocket {
	// `FrontendWebsocketClient#teardown` guards the close() call with
	// `ws.readyState === WebSocket.OPEN`, which resolves via the global —
	// so the mock needs matching static members.
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	listeners: Record<string, Array<(event: any) => void> | undefined> = {
		open: [],
		close: [],
		error: [],
		message: [],
	};
	url: string;
	readyState: number = Mocket.CONNECTING;
	sent_messages: Array<string> = [];
	close_code: number | null = null;

	constructor(url: string) {
		this.url = url;
	}

	addEventListener(method: string, listener: (event: any) => void) {
		if (!this.listeners[method]) {
			this.listeners[method] = [];
		}
		this.listeners[method].push(listener);
	}

	removeEventListener(method: string, listener: (event: any) => void) {
		if (!this.listeners[method]) return;
		this.listeners[method] = this.listeners[method].filter((l) => l !== listener);
	}

	dispatchEvent(method: string, event: any = {}) {
		if (!this.listeners[method]) return;
		for (const listener of this.listeners[method]) {
			listener(event);
		}
	}

	send(data: string) {
		this.sent_messages.push(data);
	}

	close(code: number = 1000) {
		this.close_code = code;
		this.readyState = Mocket.CLOSED;
		this.dispatchEvent('close', {code});
	}

	// Helper to simulate connection
	connect() {
		this.readyState = Mocket.OPEN;
		this.dispatchEvent('open', {});
	}
}

const TEST_URLS = {
	BASE: 'ws://test.zzz.software',
	ALTERNATE: 'ws://alternate.zzz.software',
};

const TEST_MESSAGE = {
	BASIC: {method: 'test_action', params: 'test_data'},
};

describe('Socket', () => {
	let original_web_socket: typeof WebSocket;
	let mock_socket: Mocket;
	let app: Frontend;

	beforeEach(() => {
		original_web_socket = globalThis.WebSocket;

		mock_socket = new Mocket(TEST_URLS.BASE);

		app = monkeypatch_zzz_for_tests(new Frontend());

		// Mock action API for testing
		(app as any).api = {
			ping: vi.fn(),
		};

		// Stub time so connection_duration derivations don't depend on real clock.
		(app as any).time = {
			now_ms: Date.now(),
			interval: 1000,
		};

		// `new WebSocket(url)` returns the shared mock; we then drive open/close
		// events through `mock_socket.connect()` / `mock_socket.dispatchEvent()`.
		// eslint-disable-next-line prefer-arrow-callback
		const MockWebSocket: any = vi.fn(function (this: Mocket, url: string) {
			mock_socket.url = url;
			return mock_socket;
		});
		// Static `WebSocket.OPEN` etc. are referenced by `FrontendWebsocketClient`;
		// the vi.fn wrapper doesn't inherit the Mocket statics automatically.
		MockWebSocket.CONNECTING = Mocket.CONNECTING;
		MockWebSocket.OPEN = Mocket.OPEN;
		MockWebSocket.CLOSING = Mocket.CLOSING;
		MockWebSocket.CLOSED = Mocket.CLOSED;
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

		vi.useFakeTimers();
	});

	afterEach(() => {
		globalThis.WebSocket = original_web_socket;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe('Connection management', () => {
		test('connect creates WebSocket with provided URL', () => {
			const socket = new Socket({app});
			socket.connect(TEST_URLS.BASE);

			assert.ok((globalThis.WebSocket as any).mock.calls.length > 0);
			assert.deepEqual((globalThis.WebSocket as any).mock.calls[0], [TEST_URLS.BASE]);
			assert.strictEqual(socket.url, TEST_URLS.BASE);
			assert.strictEqual(socket.status, 'pending');
		});

		test('disconnect closes WebSocket with default close code', () => {
			const socket = new Socket({app});
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			socket.disconnect();

			assert.strictEqual(mock_socket.close_code, DEFAULT_CLOSE_CODE);
			assert.isNull(socket.ws);
			assert.ok(!socket.open);
			// User-initiated disconnect resets the wrapper to 'initial'.
			assert.strictEqual(socket.status, 'initial');
		});

		test('connection success updates state correctly', () => {
			const socket = new Socket({app});
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			assert.ok(socket.open);
			assert.strictEqual(socket.status, 'success');
			assert.ok(socket.connected);
		});

		test('update_url reconnects with new URL if already connected', () => {
			const socket = new Socket({app});
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			assert.strictEqual(socket.url, TEST_URLS.BASE);

			socket.update_url(TEST_URLS.ALTERNATE);

			assert.strictEqual(socket.url, TEST_URLS.ALTERNATE);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 2);
			assert.deepEqual((globalThis.WebSocket as any).mock.calls[1], [TEST_URLS.ALTERNATE]);
		});
	});

	describe('Message handling', () => {
		test('send queues message when socket is not connected', () => {
			const socket = new Socket({app});

			const sent = socket.send(TEST_MESSAGE.BASIC);
			assert.ok(!sent);
			assert.strictEqual(socket.queued_message_count, 1);
		});

		test('send transmits message when socket is connected', () => {
			const socket = new Socket({app});
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			const sent = socket.send(TEST_MESSAGE.BASIC);

			assert.ok(sent);
			assert.strictEqual(mock_socket.sent_messages.length, 1);
			const first_message = mock_socket.sent_messages[0];
			assert.isDefined(first_message);
			assert.deepEqual(JSON.parse(first_message), TEST_MESSAGE.BASIC);
		});

		test('retry_queued_messages sends queued messages when connected', () => {
			const socket = new Socket({app});

			// Queue messages while disconnected (no url_input, so no auto-connect)
			socket.send({method: 'message_a'});
			socket.send({method: 'message_b'});
			assert.strictEqual(socket.queued_message_count, 2);

			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			socket.retry_queued_messages();

			assert.strictEqual(mock_socket.sent_messages.length, 2);
			assert.strictEqual(socket.queued_message_count, 0);
		});
	});

	describe('Error handling', () => {
		test('retry_queued_messages moves message to failed when send fails', () => {
			// `FrontendWebsocketClient.send()` catches thrown errors and returns
			// `false`, so the wrapper surfaces a generic reason rather than the
			// underlying `Error.message`.
			const socket = new Socket({app});

			socket.send(TEST_MESSAGE.BASIC);
			assert.strictEqual(socket.queued_message_count, 1);

			mock_socket.send = vi.fn().mockImplementation(() => {
				throw new Error('Send operation failed');
			});

			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			socket.retry_queued_messages();

			assert.strictEqual(socket.queued_message_count, 0);
			assert.strictEqual(socket.failed_message_count, 1);

			const failed_message = Array.from(socket.failed_messages.values())[0];
			assert.isDefined(failed_message);
			assert.ok(failed_message.reason.length > 0);
		});

		test('clear_failed_messages removes all failed messages', () => {
			const socket = new Socket({app});

			socket.send(TEST_MESSAGE.BASIC);

			mock_socket.send = vi.fn().mockImplementation(() => {
				throw new Error('Send failed');
			});

			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			socket.retry_queued_messages();

			assert.strictEqual(socket.queued_message_count, 0);
			assert.strictEqual(socket.failed_message_count, 1);

			socket.clear_failed_messages();
			assert.strictEqual(socket.failed_message_count, 0);
		});
	});

	describe('Automatic reconnection', () => {
		test('auto reconnect attempts to reconnect after close', () => {
			const socket = new Socket({app});
			socket.reconnect_delay = 1000;
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			// Simulate unexpected close; the wrapper maps fuz_app's 'reconnecting'
			// to zzz's 'failure' AsyncStatus for UI compatibility.
			mock_socket.dispatchEvent('close', {code: 1006});

			assert.ok(!socket.open);
			assert.strictEqual(socket.status, 'failure');
			assert.ok(socket.is_reconnect_pending);

			vi.advanceTimersByTime(1000);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 2);
		});
	});
});
