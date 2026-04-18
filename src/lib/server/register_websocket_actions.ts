/**
 * WebSocket endpoint wiring — thin wrapper over fuz_app's
 * {@link register_action_ws}.
 *
 * zzz supplies the handler map, action specs, and a context-extender that
 * adds the domain `Backend` onto the base per-request context. All dispatch,
 * auth, validation, and transport bookkeeping live in fuz_app.
 *
 * @module
 */

import type {Hono} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {
	register_action_ws,
	type BaseHandlerContext,
} from '@fuzdev/fuz_app/actions/register_action_ws.js';
import {BackendWebsocketTransport} from '@fuzdev/fuz_app/actions/transports_ws_backend.js';

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

	register_action_ws<BaseHandlerContext & {backend: Backend}>({
		path,
		app,
		upgradeWebSocket,
		specs: all_action_specs,
		// Cast: the generated handler map is typed per-method; the framework
		// indexes by string method name, so the input shape widens to `unknown`.
		handlers: zzz_action_handlers as unknown as Record<
			string,
			(input: unknown, ctx: BaseHandlerContext & {backend: Backend}) => unknown
		>,
		extend_context: (base) => ({...base, backend}),
		transport,
		artificial_delay,
		log: backend.log ?? undefined,
	});
};
