/**
 * Shared helpers for the zzz WebSocket round-trip integration tests.
 *
 * Each test builds its own `create_ws_test_harness` with ad-hoc specs +
 * handlers (no module-level state to share, so no memoization). This file
 * centralizes:
 *   - JSON-RPC predicates + wire types
 *   - `send_rpc` / `wait_result` (error-frame-aware response waiting)
 *   - `make_peer()` — an `ActionPeer` for broadcast tests
 *   - `build_broadcast_api()` — wires peer + harness transport + typed
 *     broadcast API, mirroring how `src/lib/server/backend_actions_api.ts`
 *     assembles the real stack
 *   - `settle_open()` — drains the microtask chain after `harness.connect()`
 *     so the transport holds the connection before the next action
 *
 * @module
 */

import {ActionPeer} from '@fuzdev/fuz_app/actions/action_peer.js';
import type {ActionEventEnvironment} from '@fuzdev/fuz_app/actions/action_event_types.js';
import {create_broadcast_api} from '@fuzdev/fuz_app/actions/broadcast_api.js';
import type {RemoteNotificationActionSpec} from '@fuzdev/fuz_app/actions/action_spec.js';
import type {MockWsClient, WsTestHarness} from '@fuzdev/fuz_app/testing/ws_round_trip.js';
import {Logger} from '@fuzdev/fuz_util/log.js';

// ---------------------------------------------------------------------
// Predicates + wire types
// ---------------------------------------------------------------------

export const is_notification =
	(method: string) =>
	(msg: unknown): boolean =>
		typeof msg === 'object' &&
		msg !== null &&
		(msg as {method?: string}).method === method &&
		!('id' in msg);

export const is_response_for =
	(id: number | string) =>
	(msg: unknown): boolean =>
		typeof msg === 'object' &&
		msg !== null &&
		(msg as {id?: unknown}).id === id &&
		('result' in msg || 'error' in msg);

export interface JsonrpcNotification<P = unknown> {
	jsonrpc: '2.0';
	method: string;
	params: P;
}

export interface JsonrpcSuccessResponse<R = unknown> {
	jsonrpc: '2.0';
	id: number | string;
	result: R;
}

export interface JsonrpcErrorResponse {
	jsonrpc: '2.0';
	id: number | string;
	error: {code: number; message: string; data?: unknown};
}

// ---------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------

/** Send a JSON-RPC request. Awaits queue flush, not the response. */
export const send_rpc = (
	client: MockWsClient,
	id: number | string,
	method: string,
	params: unknown,
): Promise<void> => client.send({jsonrpc: '2.0', id, method, params});

/**
 * Wait for the response to a specific request id; throws with a useful
 * message if the frame is an error. Without this, asserting on
 * `result.foo` in a test that got back `{error: ...}` throws
 * `Cannot read property 'foo' of undefined`, which tells you nothing.
 */
export const wait_result = async <R = unknown>(
	client: MockWsClient,
	id: number | string,
	timeout_ms?: number,
): Promise<R> => {
	const msg = await client.wait_for<JsonrpcSuccessResponse<R> | JsonrpcErrorResponse>(
		is_response_for(id),
		timeout_ms,
	);
	if ('error' in msg) {
		const data = (msg.error as {data?: unknown}).data;
		const detail = data ? ` data=${JSON.stringify(data)}` : '';
		throw new Error(`rpc #${id} failed: [${msg.error.code}] ${msg.error.message}${detail}`);
	}
	return msg.result;
};

// ---------------------------------------------------------------------
// Broadcast wiring
// ---------------------------------------------------------------------

/** An `ActionPeer` suitable for hosting a broadcast API in tests. */
export const make_peer = (): ActionPeer =>
	new ActionPeer({
		environment: {
			executor: 'backend',
			lookup_action_handler: () => undefined,
			lookup_action_spec: () => undefined,
			log: new Logger('[ws-test-peer]', {level: 'off'}),
		} satisfies ActionEventEnvironment,
	});

/**
 * Wire a typed broadcast API against the harness's transport, matching
 * how the real backend composes the stack. Returns the typed API so
 * tests can call `.workspace_changed(...)` etc.
 */
export const build_broadcast_api = <TApi>(options: {
	harness: WsTestHarness;
	specs: ReadonlyArray<RemoteNotificationActionSpec>;
}): TApi => {
	const peer = make_peer();
	peer.transports.register_transport(options.harness.transport);
	return create_broadcast_api<TApi>({peer, specs: options.specs});
};

/**
 * Yield to the event loop long enough for the harness's per-socket open
 * microtasks to drain. Necessary before broadcasting to a just-connected
 * client — `BackendWebsocketTransport.register_ws` runs in the Hono upgrade
 * path, which chains through two microtasks before the connection is
 * addressable.
 */
export const settle_open = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};
