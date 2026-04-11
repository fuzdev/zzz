import type {Hono} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {wait} from '@fuzdev/fuz_util/async.js';
import {get_request_context} from '@fuzdev/fuz_app/auth/request_context.js';
import {hash_session_token} from '@fuzdev/fuz_app/auth/session_queries.js';

import type {Uuid} from '../zod_helpers.js';
import type {Backend} from './backend.js';
import {BackendWebsocketTransport} from './backend_websocket_transport.js';
import {jsonrpc_error_messages} from '../jsonrpc_errors.js';
import {
	create_jsonrpc_error_message_from_thrown,
	to_jsonrpc_message_id,
} from '../jsonrpc_helpers.js';

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
 * Registers WebSocket endpoints for all service actions in the schema registry.
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

	app.get(
		path,
		upgradeWebSocket((c) => {
			// Extract session auth info from the Hono context.
			// require_auth middleware has already rejected unauthenticated requests,
			// so these are guaranteed non-null.
			const request_context = get_request_context(c)!;
			const session_id: string = c.get('auth_session_id')!;
			const token_hash = hash_session_token(session_id);
			const account_id: Uuid = request_context.account.id as Uuid;

			return {
				onOpen: (event, ws) => {
					const connection_id = transport.add_connection(ws, token_hash, account_id);
					backend.log?.debug('[ws] ws opened', connection_id, event);
				},
				onMessage: async (event, ws) => {
					let json;
					try {
						json = JSON.parse(String(event.data)); // eslint-disable-line @typescript-eslint/no-base-to-string
					} catch (error) {
						backend.log?.error(`[ws] JSON parse error:`, error);
						ws.send(JSON.stringify(jsonrpc_error_messages.parse_error()));
						return;
					}

					if (artificial_delay > 0) {
						backend.log?.debug(`[ws] throttling ${artificial_delay}ms`);
						await wait(artificial_delay);
					}

					try {
						const response = await backend.receive(json);
						// No responses for notifications
						if (response != null) {
							ws.send(JSON.stringify(response));
						}
					} catch (error) {
						// TODO maybe only return messages if it's req/res? breaks from http version tho
						backend.log?.error('[ws] error processing JSON-RPC request:', error);
						const error_response = create_jsonrpc_error_message_from_thrown(
							to_jsonrpc_message_id(json),
							error,
						);
						ws.send(JSON.stringify(error_response));
					}
				},
				onClose: (event, ws) => {
					transport.remove_connection(ws);
					backend.log?.debug('[ws] ws closed', event);
				},
			};
		}),
	);
};
