// @vitest-environment jsdom

import { beforeEach, describe, test, vi, afterEach, assert } from 'vitest';
import {
	DEFAULT_CLOSE_CODE,
	DEFAULT_HEARTBEAT_INTERVAL
} from '@fuzdev/fuz_app/actions/socket.svelte.ts';
import {
	WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT,
	WS_CLOSE_SESSION_REVOKED
} from '@fuzdev/fuz_app/actions/transports.ts';

import { Socket } from '$lib/socket.svelte.ts';
import { Frontend } from '$lib/frontend.svelte.ts';
import { HEARTBEAT_INTERVAL_BOUNDS, RECONNECT_DELAY_BOUNDS } from '$lib/socket_helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

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
		message: []
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
		this.dispatchEvent('close', { code });
	}

	// Helper to simulate connection
	connect() {
		this.readyState = Mocket.OPEN;
		this.dispatchEvent('open', {});
	}
}

const TEST_URLS = {
	BASE: 'ws://test.zzz.software',
	ALTERNATE: 'ws://alternate.zzz.software'
};

const TEST_MESSAGE = {
	BASIC: { method: 'test_action', params: 'test_data' }
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
			ping: vi.fn()
		};

		// Stub time so connection_duration derivations don't depend on real clock.
		(app as any).time = {
			now_ms: Date.now(),
			interval: 1000
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
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);

			assert.ok((globalThis.WebSocket as any).mock.calls.length > 0);
			assert.deepEqual((globalThis.WebSocket as any).mock.calls[0], [TEST_URLS.BASE]);
			assert.strictEqual(socket.url, TEST_URLS.BASE);
			assert.strictEqual(socket.status, 'pending');
		});

		test('disconnect closes WebSocket with default close code', () => {
			const socket = new Socket({ app });
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
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			assert.ok(socket.open);
			assert.strictEqual(socket.status, 'success');
			assert.ok(socket.connected);
		});

		test('update_url reconnects with new URL if already connected', () => {
			const socket = new Socket({ app });
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
			const socket = new Socket({ app });

			const sent = socket.send(TEST_MESSAGE.BASIC);
			assert.ok(!sent);
			assert.strictEqual(socket.queued_message_count, 1);
		});

		test('send transmits message when socket is connected', () => {
			const socket = new Socket({ app });
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
			const socket = new Socket({ app });

			// Queue messages while disconnected (no url_input, so no auto-connect)
			socket.send({ method: 'message_a' });
			socket.send({ method: 'message_b' });
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
			const socket = new Socket({ app });

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
			const socket = new Socket({ app });

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
			const socket = new Socket({ app });
			socket.reconnect_delay = 1000;
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			// Simulate unexpected close; the wrapper maps fuz_app's 'reconnecting'
			// to zzz's 'failure' AsyncStatus for UI compatibility.
			mock_socket.dispatchEvent('close', { code: 1006 });

			assert.ok(!socket.open);
			assert.strictEqual(socket.status, 'failure');
			assert.ok(socket.is_reconnect_pending);

			vi.advanceTimersByTime(1000);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 2);
		});
	});

	describe('Heartbeat', () => {
		/** Advance `total` ms in half-interval steps, answering each heartbeat as it goes out. */
		const idle_answering_heartbeats = async (total: number, step: number): Promise<void> => {
			let answered = 0;
			for (let elapsed = 0; elapsed < total; elapsed += step) {
				await vi.advanceTimersByTimeAsync(step);
				const frames = mock_socket.sent_messages.map((m) => JSON.parse(m));
				for (const frame of frames.slice(answered)) {
					if (frame.method === 'heartbeat') {
						mock_socket.dispatchEvent('message', {
							data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })
						});
					}
				}
				answered = frames.length;
			}
		};

		test('defaults to fuz_app interval', () => {
			const socket = new Socket({ app });
			assert.strictEqual(socket.heartbeat_interval, DEFAULT_HEARTBEAT_INTERVAL);
		});

		test('an idle socket stays open while heartbeats are answered', async () => {
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			await idle_answering_heartbeats(10 * 60_000, DEFAULT_HEARTBEAT_INTERVAL / 2);

			assert.isNull(mock_socket.close_code);
			assert.ok(socket.connected);
			assert.ok(mock_socket.sent_messages.length > 0, 'heartbeats were sent');
		});

		test('a long interval scales the receive timeout instead of closing idle sockets', async () => {
			const socket = new Socket({ app });
			socket.heartbeat_interval = HEARTBEAT_INTERVAL_BOUNDS.max;
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			await idle_answering_heartbeats(
				4 * HEARTBEAT_INTERVAL_BOUNDS.max,
				HEARTBEAT_INTERVAL_BOUNDS.max / 2
			);

			assert.isNull(mock_socket.close_code);
			assert.ok(socket.connected);
		});

		test('an unanswered heartbeat still closes a dead socket', () => {
			const socket = new Socket({ app });
			socket.auto_reconnect = false;
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();

			vi.advanceTimersByTime(3 * DEFAULT_HEARTBEAT_INTERVAL);

			assert.strictEqual(mock_socket.close_code, WS_CLOSE_CLIENT_HEARTBEAT_TIMEOUT);
		});
	});

	describe('Settings coercion', () => {
		test('numeric strings are coerced', () => {
			const socket = new Socket({ app });
			socket.heartbeat_interval = '45000' as unknown as number;
			socket.reconnect_delay = '2500' as unknown as number;
			socket.reconnect_delay_max = '20000' as unknown as number;
			assert.strictEqual(socket.heartbeat_interval, 45_000);
			assert.strictEqual(socket.reconnect_delay, 2500);
			assert.strictEqual(socket.reconnect_delay_max, 20_000);
		});

		test('empty, null, and NaN writes keep the current value', () => {
			const socket = new Socket({ app });
			socket.heartbeat_interval = 45_000;
			socket.reconnect_delay = 2500;
			for (const bad of ['', null, undefined, NaN, 'abc', Infinity]) {
				socket.heartbeat_interval = bad as unknown as number;
				socket.reconnect_delay = bad as unknown as number;
				socket.reconnect_delay_max = bad as unknown as number;
			}
			assert.strictEqual(socket.heartbeat_interval, 45_000);
			assert.strictEqual(socket.reconnect_delay, 2500);
		});

		test('out-of-range writes are clamped', () => {
			const socket = new Socket({ app });
			socket.heartbeat_interval = 0;
			socket.reconnect_delay = 0;
			socket.reconnect_delay_max = -5;
			assert.strictEqual(socket.heartbeat_interval, HEARTBEAT_INTERVAL_BOUNDS.min);
			assert.strictEqual(socket.reconnect_delay, RECONNECT_DELAY_BOUNDS.min);
			assert.strictEqual(socket.reconnect_delay_max, RECONNECT_DELAY_BOUNDS.min);
			socket.heartbeat_interval = 1e12;
			socket.reconnect_delay = 1e12;
			assert.strictEqual(socket.heartbeat_interval, HEARTBEAT_INTERVAL_BOUNDS.max);
			assert.strictEqual(socket.reconnect_delay, RECONNECT_DELAY_BOUNDS.max);
		});

		test('a zero reconnect delay cannot spin a reconnect loop', () => {
			const socket = new Socket({ app });
			socket.reconnect_delay = '' as unknown as number;
			socket.reconnect_delay = 0;
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			mock_socket.dispatchEvent('close', { code: 1006 });

			vi.advanceTimersByTime(RECONNECT_DELAY_BOUNDS.min - 1);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 1);
			vi.advanceTimersByTime(1);
			assert.strictEqual((globalThis.WebSocket as any).mock.calls.length, 2);
		});
	});

	describe('Traffic timestamps', () => {
		test('an RPC request stamps last send, and its response last receive', async () => {
			vi.setSystemTime(1_000);
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			assert.isNull(socket.last_send_time);

			const pending = socket.request('workspace_list', {}, { id: 'req-1' });
			assert.strictEqual(socket.last_send_time, 1_000);
			assert.isNull(socket.last_receive_time);

			vi.setSystemTime(2_000);
			mock_socket.dispatchEvent('message', {
				data: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: { workspaces: [] } })
			});
			await pending;
			assert.strictEqual(socket.last_receive_time, 2_000);
		});

		test('a request queued while disconnected does not stamp last send', () => {
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);
			void socket.request('workspace_list', {}, { id: 'req-2' }).catch(() => {});
			assert.isNull(socket.last_send_time);
		});
	});

	describe('Connection duration', () => {
		/** Connects at `connected_at`, then reads the duration with `Time` at `now_ms`. */
		const duration_rounded_at = (connected_at: number, now_ms: number): number | null => {
			vi.setSystemTime(connected_at);
			(app as any).time = { now_ms, interval: 60_000 };
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			assert.strictEqual(socket.last_connect_time, connected_at);
			return socket.connection_duration_rounded;
		};

		test('under one interval rounds down to 0, not up to a minute', () => {
			assert.strictEqual(duration_rounded_at(1_000, 1_000 + 59_999), 0);
		});

		test('rounds down, never overstating the time connected', () => {
			assert.strictEqual(duration_rounded_at(1_000, 1_000 + 119_999), 60_000);
			assert.strictEqual(duration_rounded_at(1_000, 1_000 + 120_000), 120_000);
		});

		test('is null while disconnected', () => {
			(app as any).time = { now_ms: 10_000, interval: 60_000 };
			const socket = new Socket({ app });
			assert.isNull(socket.connection_duration_rounded);
		});
	});

	describe('Revocation', () => {
		test('revoked reflects a session-revoked close', () => {
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			assert.ok(!socket.revoked);

			mock_socket.dispatchEvent('close', { code: WS_CLOSE_SESSION_REVOKED });

			assert.ok(socket.revoked);
			assert.strictEqual(socket.status, 'failure');
		});

		test('reconnect_revoked replaces a revoked client with a fresh connection', () => {
			const socket = new Socket({ app });
			socket.connect(TEST_URLS.BASE);
			mock_socket.connect();
			const constructed = () =>
				(globalThis.WebSocket as unknown as { mock: { calls: Array<unknown> } }).mock.calls.length;
			assert.strictEqual(constructed(), 1);

			// not revoked — nothing to do
			assert.ok(!socket.reconnect_revoked());
			assert.strictEqual(constructed(), 1);

			mock_socket.dispatchEvent('close', { code: WS_CLOSE_SESSION_REVOKED });
			assert.ok(socket.revoked);
			// a revoked client never reconnects on its own
			vi.advanceTimersByTime(60_000);
			assert.strictEqual(constructed(), 1);

			assert.ok(socket.reconnect_revoked());
			assert.strictEqual(constructed(), 2, 'a new WebSocket to the same URL');
			assert.strictEqual(mock_socket.url, TEST_URLS.BASE);
			assert.ok(!socket.revoked);
			mock_socket.connect();
			assert.ok(socket.connected);
		});
	});
});
