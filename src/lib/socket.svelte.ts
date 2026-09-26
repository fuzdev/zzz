import { SvelteMap } from 'svelte/reactivity';
import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
import {
	DEFAULT_HEARTBEAT_INTERVAL,
	DEFAULT_RECONNECT_DELAY,
	DEFAULT_RECONNECT_DELAY_MAX,
	FrontendWebsocketClient,
	socket_status_to_async_status,
	type FrontendWebsocketHeartbeatOptions,
	type SocketMessageHandler,
	type SocketErrorHandler
} from '@fuzdev/fuz_app/actions/socket.svelte.ts';
import type { WebsocketRpcConnection } from '@fuzdev/fuz_app/actions/transports_ws.ts';
import type { JsonrpcRequestId } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import { ThrownJsonrpcError, UNKNOWN_ERROR_MESSAGE } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import { create_uuid, type Uuid } from '@fuzdev/fuz_util/id.ts';

import {
	DEFAULT_AUTO_RECONNECT,
	HEARTBEAT_INTERVAL_BOUNDS,
	RECONNECT_DELAY_BOUNDS,
	to_bounded_ms,
	to_heartbeat_receive_timeout
} from './socket_helpers.ts';
import type { Frontend } from './frontend.svelte.ts';
import {
	RPC_MESSAGE_MAX_BYTES,
	create_rpc_message_too_large_error,
	to_rpc_message_size
} from './rpc_message_limit.ts';

export interface SocketOptions {
	app: Frontend;
}

/** Queued message that couldn't be sent immediately. */
export interface QueuedMessage {
	id: Uuid;
	data: any;
	created: number;
}

/** Failed message that exceeded retry count. */
export interface FailedMessage extends QueuedMessage {
	failed: number;
	reason: string;
}

/**
 * Wraps `FrontendWebsocketClient` with zzz-specific concerns: a
 * retryable fire-and-forget send queue (distinct from fuz_app's
 * request-level durable queue), URL input tracking, and a mapping from
 * fuz_app's `SocketStatus` onto zzz's `AsyncStatus`. Plain reactive class
 * — not a Cell. Implements `WebsocketRpcConnection` so it can back
 * `FrontendWebsocketTransport`; the `request` method is a one-line
 * delegate to the underlying `FrontendWebsocketClient`, keeping the
 * pending-request map in one canonical place.
 *
 * fuz_app's `FrontendWebsocketClient` owns the activity-aware heartbeat,
 * sending the shared `heartbeat_action` at `heartbeat_interval` idle, with a
 * receive timeout scaled to the interval (`to_heartbeat_receive_timeout`).
 * Assigning `heartbeat_interval` pushes the new policy into the live
 * client immediately (the timer is restarted in place when connected).
 *
 * Reconnect settings (`reconnect_delay`, `reconnect_delay_max`,
 * `auto_reconnect`) propagate to the underlying client on assignment
 * via `apply_reconnect_policy()` — in-flight waits are monotonically
 * shortened (never extended).
 *
 * The millisecond settings coerce and clamp on assignment
 * (`HEARTBEAT_INTERVAL_BOUNDS`, `RECONNECT_DELAY_BOUNDS`) since form inputs
 * can hand over strings or empty values; a non-numeric write is ignored.
 */
export class Socket implements WebsocketRpcConnection {
	readonly app: Frontend;

	url_input: string = $state.raw('');
	#heartbeat_interval: number = $state.raw(DEFAULT_HEARTBEAT_INTERVAL);
	#reconnect_delay: number = $state.raw(DEFAULT_RECONNECT_DELAY);
	#reconnect_delay_max: number = $state.raw(DEFAULT_RECONNECT_DELAY_MAX);
	#auto_reconnect: boolean = $state.raw(DEFAULT_AUTO_RECONNECT);

	/**
	 * Heartbeat idle interval in ms, clamped to `HEARTBEAT_INTERVAL_BOUNDS`.
	 * Writing pushes the new policy into the underlying client immediately —
	 * when connected, the live timer is restarted in place; when
	 * disconnected, the policy is stashed for the next `connect()`.
	 */
	get heartbeat_interval(): number {
		return this.#heartbeat_interval;
	}
	set heartbeat_interval(value: number) {
		const interval = to_bounded_ms(value, HEARTBEAT_INTERVAL_BOUNDS);
		if (interval === null) return;
		this.#heartbeat_interval = interval;
		this.#client?.set_heartbeat(this.#heartbeat_policy());
	}

	/**
	 * Reconnect policy fields. Assignments push into the underlying client via
	 * `apply_reconnect_policy()` so in-flight waits honor the new policy
	 * (monotonically shortened, never extended).
	 */
	get reconnect_delay(): number {
		return this.#reconnect_delay;
	}
	set reconnect_delay(value: number) {
		const delay = to_bounded_ms(value, RECONNECT_DELAY_BOUNDS);
		if (delay === null) return;
		this.#reconnect_delay = delay;
		this.apply_reconnect_policy();
	}
	get reconnect_delay_max(): number {
		return this.#reconnect_delay_max;
	}
	set reconnect_delay_max(value: number) {
		const delay_max = to_bounded_ms(value, RECONNECT_DELAY_BOUNDS);
		if (delay_max === null) return;
		this.#reconnect_delay_max = delay_max;
		this.apply_reconnect_policy();
	}
	get auto_reconnect(): boolean {
		return this.#auto_reconnect;
	}
	set auto_reconnect(value: boolean) {
		this.#auto_reconnect = value;
		this.apply_reconnect_policy();
	}

	#client: FrontendWebsocketClient | null = $state.raw(null);

	/**
	 * UI timestamps for the "last send" / "last receive" diagnostics in
	 * `CapabilityWebsocket` — stamped by `send`, `request`, and inbound
	 * messages. Not used for heartbeat scheduling — fuz_app's client owns that.
	 */
	// TODO read these from the client's own `last_send_time` / `last_receive_time`
	// once fuz_app ships them — those also count heartbeats and error responses
	last_send_time: number | null = $state.raw(null);
	last_receive_time: number | null = $state.raw(null);

	#client_message_unsubscribe: (() => void) | null = null;
	#client_error_unsubscribe: (() => void) | null = null;

	message_queue: Array<QueuedMessage> = $state([]);
	failed_messages: SvelteMap<string, FailedMessage> = new SvelteMap();

	#message_handlers: Set<SocketMessageHandler> = new Set();
	#error_handlers: Set<SocketErrorHandler> = new Set();

	readonly ws: WebSocket | null = $derived(this.#client?.ws ?? null);
	readonly url: string | null = $derived(this.#client?.url ?? null);
	readonly reconnect_count: number = $derived(this.#client?.reconnect_count ?? 0);
	readonly current_reconnect_delay: number = $derived(this.#client?.current_reconnect_delay ?? 0);
	readonly last_connect_time: number | null = $derived(this.#client?.last_connect_time ?? null);
	/**
	 * Changes each time a close fires — used by the UI as an animation key so
	 * each reconnect wait restarts the progress bar.
	 */
	readonly reconnect_attempt: number = $derived(this.#client?.last_close_time ?? 0);
	readonly is_reconnect_pending: boolean = $derived(this.#client?.status === 'reconnecting');

	/**
	 * Whether the server closed the socket with `WS_CLOSE_SESSION_REVOKED` —
	 * terminal for this client. Usually the session is gone, but not always
	 * (see `reconnect_revoked`).
	 */
	readonly revoked: boolean = $derived(this.#client?.revoked ?? false);

	readonly status: AsyncStatus = $derived(
		socket_status_to_async_status(this.#client?.status ?? 'initial', this.revoked)
	);

	readonly connected: boolean = $derived(this.#client?.connected ?? false);
	readonly open: boolean = $derived(this.connected);
	readonly can_send: boolean = $derived(this.connected);
	readonly has_queued_messages: boolean = $derived(this.message_queue.length > 0);
	readonly queued_message_count: number = $derived(this.message_queue.length);
	readonly failed_message_count: number = $derived(this.failed_messages.size);

	readonly connection_duration: number | null = $derived.by(() =>
		this.connected && this.last_connect_time
			? Math.max(0, this.app.time.now_ms - this.last_connect_time)
			: null
	);
	readonly connection_duration_rounded: number | null = $derived.by(() =>
		this.connection_duration !== null
			? Math.round(this.connection_duration / this.app.time.interval) * this.app.time.interval
			: null
	);

	constructor(options: SocketOptions) {
		this.app = options.app;
	}

	connect(url: string | null = null): void {
		if (url !== null) {
			this.url_input = url;
		}
		const target_url = this.url_input;
		if (!target_url) {
			console.error('[socket] cannot connect: no URL provided');
			return;
		}

		this.#teardown_client();

		const client = new FrontendWebsocketClient(target_url, {
			reconnect: this.auto_reconnect
				? {
						delay: this.reconnect_delay,
						delay_max: this.reconnect_delay_max
					}
				: false,
			heartbeat: this.#heartbeat_policy()
		});

		this.#client_message_unsubscribe = client.add_message_handler((event) => {
			this.last_receive_time = Date.now();
			for (const handler of this.#message_handlers) {
				handler(event);
			}
		});
		this.#client_error_unsubscribe = client.add_error_handler((event) => {
			for (const handler of this.#error_handlers) {
				handler(event);
			}
		});

		this.#client = client;
		client.connect();
	}

	disconnect(): void {
		this.#teardown_client();
	}

	/**
	 * Reconnect after the server closed the socket as revoked — a revoked
	 * client never reconnects on its own, so this replaces it with a fresh
	 * one. Call only once a session recheck finds the session still valid:
	 * some revocations close every socket of the account while ending only
	 * another session (another tab's logout, an API-token revoke-all).
	 *
	 * @returns whether a reconnect started (`false` unless revoked)
	 */
	reconnect_revoked(): boolean {
		if (!this.revoked) return false;
		this.connect();
		return true;
	}

	#teardown_client(): void {
		this.#client_message_unsubscribe?.();
		this.#client_message_unsubscribe = null;
		this.#client_error_unsubscribe?.();
		this.#client_error_unsubscribe = null;
		if (this.#client) {
			this.#client.disconnect();
			this.#client = null;
		}
	}

	/**
	 * Delegate to the underlying `FrontendWebsocketClient.request` — keeps the
	 * pending-request map, durable queue, and `AbortSignal` cancel in one
	 * canonical place. Rejects when there is no client (call `connect()` first).
	 * Stamps `last_send_time` when the frame goes out immediately (a queued one
	 * goes out on reconnect) and `last_receive_time` when a result arrives.
	 *
	 * A request larger than `RPC_MESSAGE_MAX_BYTES` rejects with
	 * `invalid_request` (`payload_too_large`) without being sent — the backend
	 * closes the socket on an oversized message, which would fail every
	 * request in flight on it.
	 */
	request(
		method: string,
		params?: unknown,
		options?: { signal?: AbortSignal; queue?: boolean; id?: JsonrpcRequestId }
	): Promise<unknown> {
		const client = this.#client;
		if (!client) {
			return Promise.reject(new Error('[socket] cannot request: no client (call connect first)'));
		}
		// TODO replace with `FrontendWebsocketTransport`'s `max_message_bytes`
		// option once the fuz_app release that has it lands in zzz
		const size = to_rpc_message_size({ jsonrpc: '2.0', id: options?.id ?? 0, method, params });
		if (size > RPC_MESSAGE_MAX_BYTES) {
			const error = create_rpc_message_too_large_error(size);
			return Promise.reject(new ThrownJsonrpcError(error.code, error.message, error.data));
		}
		const sending = client.connected;
		const result = client.request(method, params, options);
		if (sending) this.last_send_time = Date.now();
		return result.then((value) => {
			this.last_receive_time = Date.now();
			return value;
		});
	}

	/**
	 * Fire-and-forget send, queued for retry when it can't go out now. A
	 * message larger than `RPC_MESSAGE_MAX_BYTES` is dropped (logged, returns
	 * `false`) rather than sent or queued — it would close the socket.
	 */
	send(data: object): boolean {
		const size = to_rpc_message_size(data);
		if (size > RPC_MESSAGE_MAX_BYTES) {
			console.error('[socket] message dropped:', create_rpc_message_too_large_error(size).message);
			return false;
		}
		if (this.can_send && this.#client) {
			try {
				const sent = this.#client.send(data);
				if (sent) {
					this.last_send_time = Date.now();
					return true;
				}
				this.#queue_message(data);
				return false;
			} catch (error) {
				console.error('[socket] error sending message:', error);
				this.#queue_message(data);
				return false;
			}
		}
		this.#queue_message(data);
		return false;
	}

	update_url(url: string): void {
		if (this.url === url) return;
		const was_connected = this.connected;
		this.url_input = url;
		if (was_connected) {
			this.connect();
		}
	}

	retry_queued_messages(): void {
		if (!this.can_send || this.message_queue.length === 0) return;

		const queue_copy = [...this.message_queue];
		this.message_queue = [];

		for (const message of queue_copy) {
			this.#process_queued_message(message);
		}
	}

	clear_failed_messages(): void {
		this.failed_messages.clear();
	}

	cancel_reconnect(): void {
		this.#client?.cancel_reconnect();
	}

	#heartbeat_policy(): FrontendWebsocketHeartbeatOptions {
		return {
			interval: this.#heartbeat_interval,
			receive_timeout: to_heartbeat_receive_timeout(this.#heartbeat_interval)
		};
	}

	/**
	 * Push the current `auto_reconnect` / `reconnect_delay` /
	 * `reconnect_delay_max` fields to the underlying client. No-op when
	 * there is no client (next `connect()` picks them up from construction).
	 */
	apply_reconnect_policy(): void {
		this.#client?.set_reconnect(
			this.auto_reconnect
				? { delay: this.reconnect_delay, delay_max: this.reconnect_delay_max }
				: false
		);
	}

	add_message_handler(handler: SocketMessageHandler): () => void {
		this.#message_handlers.add(handler);
		return () => this.#message_handlers.delete(handler);
	}

	add_error_handler(handler: SocketErrorHandler): () => void {
		this.#error_handlers.add(handler);
		return () => this.#error_handlers.delete(handler);
	}

	#queue_message(data: object): void {
		const message: QueuedMessage = {
			id: create_uuid(),
			data,
			created: Date.now()
		};
		this.message_queue.push(message);

		if (this.status === 'initial' && this.auto_reconnect && this.url_input) {
			this.connect();
		}
	}

	#process_queued_message(message: QueuedMessage): void {
		if (!this.can_send || !this.#client) {
			this.message_queue.push(message);
			return;
		}

		try {
			const sent = this.#client.send(message.data);
			if (sent) {
				this.last_send_time = Date.now();
			} else {
				this.#fail_message(message, this.#client.last_send_error?.message ?? 'send returned false');
			}
		} catch (error) {
			this.#fail_message(message, error instanceof Error ? error.message : UNKNOWN_ERROR_MESSAGE);
		}
	}

	#fail_message(message: QueuedMessage, reason: string): void {
		this.failed_messages.set(message.id, {
			...message,
			failed: Date.now(),
			reason
		});
	}
}
