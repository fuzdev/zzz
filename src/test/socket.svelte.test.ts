// @vitest-environment jsdom

import {beforeEach, describe, test, vi, afterEach, assert} from 'vitest';

import {Socket} from '$lib/socket.svelte.js';
import {DEFAULT_CLOSE_CODE} from '$lib/socket_helpers.js';
import {Frontend} from '$lib/frontend.svelte.js';
import {monkeypatch_zzz_for_tests} from './test_helpers.ts';

// Mock WebSocket implementation for testing
class Mocket {
	listeners: Record<string, Array<(event: any) => void> | undefined> = {
		open: [],
		close: [],
		error: [],
		message: [],
	};
	url: string;
	readyState: number = 0; // CONNECTING
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
		this.readyState = 3; // CLOSED
		this.dispatchEvent('close', {code});
	}

	// Helper to simulate connection
	connect() {
		this.readyState = 1; // OPEN
		this.dispatchEvent('open', {});
	}
}

// Test constants
const TEST_URLS = {
	BASE: 'ws://test.zzz.software',
	ALTERNATE: 'ws://alternate.zzz.software',
};

const TEST_MESSAGE = {
	BASIC: {method: 'test_action', params: 'test_data'},
	PING: {method: 'ping', timestamp: 123456789},
};

describe('Socket', () => {
	let original_web_socket: typeof WebSocket;
	let mock_socket: Mocket;
	let app: Frontend;

	// Setup for each test
	beforeEach(() => {
		// Save original WebSocket
		original_web_socket = globalThis.WebSocket;

		// Create mock socket
		mock_socket = new Mocket(TEST_URLS.BASE);

		// Create real Zzz instance
		app = monkeypatch_zzz_for_tests(new Frontend());

		// TODO better mocking
		// Mock action API for testing
		(app as any).api = {
			ping: vi.fn(),
		} as any;

		// Set test time properties
		(app as any).time = {
			now_ms: Date.now(),
			interval: 1000,
		} as any;

		// Mock WebSocket class - must be a real class for `new` to work
		// eslint-disable-next-line prefer-arrow-callback
		const MockWebSocket = vi.fn(function (this: Mocket, url: string) {
			mock_socket.url = url;
			return mock_socket;
		}) as unknown as typeof WebSocket;
		globalThis.WebSocket = MockWebSocket;

		// Use fake timers for timing control
		vi.useFakeTimers();
	});

	// Cleanup after each test
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

			// Simulate connection
			mock_socket.connect();

			// Disconnect
			socket.disconnect();

			assert.strictEqual(mock_socket.close_code, DEFAULT_CLOSE_CODE);
			assert.isNull(socket.ws);
			assert.ok(!(socket.open));
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

			// Update URL
			socket.update_url(TEST_URLS.ALTERNATE);

			assert.strictEqual(socket.url, TEST_URLS.ALTERNATE);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 2);
			assert.deepEqual((globalThis.WebSocket as any).mock.calls[1], [TEST_URLS.ALTERNATE]);
		});
	});

	describe('Message handling', () => {
		test('send queues message when socket is not connected', () => {
			const socket = new Socket({app});

			// Not connected yet
			const sent = socket.send(TEST_MESSAGE.BASIC);
			assert.ok(!(sent));
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
			assert.deepEqual(JSON.parse(first_message!), TEST_MESSAGE.BASIC);
		});

		test('message queueing sends queued messages when reconnected', () => {
			const socket = new Socket({app});

			// Queue messages while disconnected
			socket.send({method: 'message_a'});
			socket.send({method: 'message_b'});

			assert.strictEqual(socket.queued_message_count, 2);

			// Connect
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			// Messages should be sent
			assert.strictEqual(mock_socket.sent_messages.length, 2);
			assert.strictEqual(socket.queued_message_count, 0);
		});
	});

	describe('Error handling', () => {
		test('failed messages moves message to failed when send throws error', () => {
			const socket = new Socket({app});

			// Queue a message
			socket.send(TEST_MESSAGE.BASIC);
			assert.strictEqual(socket.queued_message_count, 1);

			// Mock send failure
			const error_message = 'Send operation failed';
			mock_socket.send = vi.fn().mockImplementation(() => {
				throw new Error(error_message);
			});

			// Connect and trigger send attempt
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			// Message should move to failed
			assert.strictEqual(socket.queued_message_count, 0);
			assert.strictEqual(socket.failed_message_count, 1);

			// Check error reason
			const failed_message = Array.from(socket.failed_messages.values())[0];
			assert.isDefined(failed_message);
			assert.strictEqual(failed_message!.reason, error_message);
		});

		test('clear_failed_messages removes all failed messages', () => {
			const socket = new Socket({app});

			// Queue message
			socket.send(TEST_MESSAGE.BASIC);

			// Mock send failure
			mock_socket.send = vi.fn().mockImplementation(() => {
				throw new Error('Send failed');
			});

			// Connect to trigger processing
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			socket.retry_queued_messages();

			// Verify message moved to failed
			assert.strictEqual(socket.queued_message_count, 0);
			assert.strictEqual(socket.failed_message_count, 1);

			// Clear failed messages
			socket.clear_failed_messages();
			assert.strictEqual(socket.failed_message_count, 0);
		});
	});

	describe('Automatic reconnection', () => {
		test('auto reconnect attempts to reconnect after close', () => {
			const socket = new Socket({app});
			socket.reconnect_delay = 1000; // 1 second
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			// Simulate unexpected close
			mock_socket.dispatchEvent('close');

			assert.ok(!(socket.open));
			assert.strictEqual(socket.status, 'failure');

			// Should reconnect after delay
			vi.advanceTimersByTime(1000);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 2);
		});

		test('reconnect delay uses exponential backoff', () => {
			const socket = new Socket({app});
			// Set consistent values for testing
			socket.reconnect_delay = 1000; // base delay 1 second
			socket.reconnect_delay_max = 30000; // max 30 seconds

			// Initial connect
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			assert.strictEqual(socket.status, 'success');

			// First unexpected close
			mock_socket.dispatchEvent('close', {code: 1006});
			assert.strictEqual(socket.status, 'failure');
			assert.strictEqual(socket.reconnect_count, 1);
			assert.strictEqual(socket.current_reconnect_delay, 1000); // 1000 * 1.5^0

			// Trigger first reconnect
			vi.advanceTimersByTime(1000);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 2);

			// Test subsequent reconnects with increasing delays
			// Clear timers between tests to avoid interference
			if (socket.reconnect_timeout !== null) {
				clearTimeout(socket.reconnect_timeout);
			}

			// Test second attempt
			socket.status = 'failure';
			socket.reconnect_count = 1;
			socket.maybe_reconnect();
			assert.strictEqual(socket.reconnect_count, 2);
			assert.strictEqual(socket.current_reconnect_delay, 1500); // 1000 * 1.5^1

			// Clear timeout to avoid interference
			if (socket.reconnect_timeout !== null) {
				clearTimeout(socket.reconnect_timeout);
			}

			// Test third attempt
			socket.status = 'failure';
			socket.reconnect_count = 2;
			socket.maybe_reconnect();
			assert.strictEqual(socket.reconnect_count, 3);
			assert.strictEqual(socket.current_reconnect_delay, 2250); // 1000 * 1.5^2

			// Test max delay cap
			if (socket.reconnect_timeout !== null) {
				clearTimeout(socket.reconnect_timeout);
			}
			socket.status = 'failure';
			socket.reconnect_count = 14;
			socket.maybe_reconnect();
			assert.strictEqual(socket.reconnect_count, 15);
			assert.strictEqual(socket.current_reconnect_delay, 30000); // Capped at max value
		});
	});

	describe('Heartbeat mechanism', () => {
		test('heartbeat sends ping at interval', () => {
			const socket = new Socket({app});
			socket.heartbeat_interval = 1000; // 1 second for testing
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			// Advance time to trigger heartbeat
			vi.advanceTimersByTime(1000);

			// Check ping was sent
			assert.ok((app.api.ping as any).mock.calls.length > 0);
		});
	});
});
