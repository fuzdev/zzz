/**
 * WebSocket endpoint wiring — thin wrapper over fuz_app's
 * {@link register_action_ws}.
 *
 * zzz supplies the action tuples (spec + handler) and a context-extender
 * that adds the domain `Backend` onto the base per-request context. All
 * dispatch, auth, validation, and transport bookkeeping live in fuz_app.
 *
 * The shared {@link heartbeat_action} is spread first so disconnect
 * detection is identical across every fuz_app consumer.
 *
 * @module
 */

import type {Hono} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {register_action_ws} from '@fuzdev/fuz_app/actions/register_action_ws.js';
import type {
	Action,
	BaseHandlerContext,
	WsActionHandler,
} from '@fuzdev/fuz_app/actions/action_types.js';
import {BackendWebsocketTransport} from '@fuzdev/fuz_app/actions/transports_ws_backend.js';
import {heartbeat_action} from '@fuzdev/fuz_app/actions/heartbeat.js';
import {cancel_action} from '@fuzdev/fuz_app/actions/cancel.js';

import {all_action_specs} from '../action_specs.js';
import type {Backend} from './backend.js';
import {zzz_action_handlers} from './zzz_action_handlers.js';

export interface RegisterWebsocketActionsOptions {
	path: string;
	app: Hono;
	backend: Backend;
	/** @see https://hono.dev/helpers/websocket */
	upgradeWebSocket: UpgradeWebSocket;
	/** Artificial response delay in ms (testing). */
	artificial_delay?: number;
	transport?: BackendWebsocketTransport;
}

type ZzzWsContext = BaseHandlerContext & {backend: Backend};

/**
 * Registers the WebSocket endpoint for all zzz request/response actions.
 *
 * The zzz `Backend` is exposed on every handler's context. Per-action auth,
 * Zod validation, and socket-scoped `notify` / `signal` come from fuz_app.
 */
export const register_websocket_actions = ({
	path,
	app,
	backend,
	upgradeWebSocket,
	artificial_delay = 0,
	transport = new BackendWebsocketTransport(),
}: RegisterWebsocketActionsOptions): void => {
	backend.peer.transports.register_transport(transport);

	// Build the action array: shared heartbeat + cancel first, then every zzz
	// spec paired with its handler (remote-notification specs have no handler).
	const actions: Array<Action<ZzzWsContext>> = [
		heartbeat_action as Action<ZzzWsContext>,
		cancel_action as Action<ZzzWsContext>,
	];
	for (const spec of all_action_specs) {
		if (spec.method === 'heartbeat' || spec.method === 'cancel') continue;
		const handler = (zzz_action_handlers as Record<string, unknown>)[spec.method];
		if (handler) {
			actions.push({
				spec,
				handler: handler as WsActionHandler<ZzzWsContext>,
			});
		} else {
			actions.push({spec});
		}
	}

	register_action_ws({
		path,
		app,
		upgradeWebSocket,
		actions,
		extend_context: (base) => ({...base, backend}),
		transport,
		artificial_delay,
		log: backend.log ?? undefined,
	});
};
