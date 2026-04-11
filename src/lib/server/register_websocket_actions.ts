import type {Hono} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {wait} from '@fuzdev/fuz_util/async.js';
import {get_request_context, has_role} from '@fuzdev/fuz_app/auth/request_context.js';
import {hash_session_token} from '@fuzdev/fuz_app/auth/session_queries.js';
import {ROLE_KEEPER} from '@fuzdev/fuz_app/auth/role_schema.js';

import type {Uuid} from '../zod_helpers.js';
import {all_action_specs} from '../action_specs.js';
import type {Backend} from './backend.js';
import {BackendWebsocketTransport} from './backend_websocket_transport.js';
import {jsonrpc_error_messages} from '../jsonrpc_errors.js';
import {
	create_jsonrpc_error_message,
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

	// Build action spec lookup for per-action auth checking
	const spec_by_method = new Map(all_action_specs.map((spec) => [spec.method, spec]));

	app.get(
		path,
		upgradeWebSocket((c) => {
			// Extract auth info from the Hono context.
			// require_auth middleware has already rejected unauthenticated requests,
			// so request_context is guaranteed non-null.
			const request_context = get_request_context(c)!;
			const account_id: Uuid = request_context.account.id as Uuid;
			const credential_type = c.get('credential_type');
			// Session-based connections have a token hash for targeted revocation.
			// Bearer token connections (api_token, daemon_token) pass null —
			// they're still reachable via close_sockets_for_account.
			const token_hash =
				credential_type === 'session' ? hash_session_token(c.get('auth_session_id')!) : null;

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
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_message(null, jsonrpc_error_messages.parse_error()),
							),
						);
						return;
					}

					// Batch JSON-RPC is not supported on the WebSocket path.
					if (Array.isArray(json)) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_message(
									null,
									jsonrpc_error_messages.invalid_request(
										'batch JSON-RPC requests are not supported on WebSocket',
									),
								),
							),
						);
						return;
					}

					// Per-action auth check — enforce auth level from action spec.
					// The HTTP RPC path checks this via fuz_app's create_rpc_endpoint;
					// the WS path must check it here before backend.receive().
					const method = json.method;
					if (typeof method === 'string') {
						const spec = spec_by_method.get(method);
						if (spec) {
							const {auth} = spec;
							if (auth === 'keeper') {
								if (credential_type !== 'daemon_token' || !has_role(request_context, ROLE_KEEPER)) {
									ws.send(
										JSON.stringify(
											create_jsonrpc_error_message(
												to_jsonrpc_message_id(json),
												jsonrpc_error_messages.forbidden(
													'keeper actions require daemon_token credential with keeper role',
												),
											),
										),
									);
									return;
								}
							} else if (typeof auth === 'object' && auth !== null) {
								ws.send(
									JSON.stringify(
										create_jsonrpc_error_message(
											to_jsonrpc_message_id(json),
											jsonrpc_error_messages.internal_error(
												'role-based action auth is not yet supported on WebSocket',
											),
										),
									),
								);
								return;
							}
						}
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
