/**
 * WebSocket endpoint with direct handler dispatch.
 *
 * Replaces the old `backend.receive(json)` → ActionPeer → ActionEvent path
 * with: spec lookup → Zod input validation → handler call → JSON-RPC response.
 * Keeps existing per-action auth checking at the transport layer.
 *
 * @module
 */

import {DEV} from 'esm-env';
import type {Hono} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {wait} from '@fuzdev/fuz_util/async.js';
import {get_request_context, has_role} from '@fuzdev/fuz_app/auth/request_context.js';
import {hash_session_token} from '@fuzdev/fuz_app/auth/session_queries.js';
import {ROLE_KEEPER} from '@fuzdev/fuz_app/auth/role_schema.js';
import {jsonrpc_error_messages} from '@fuzdev/fuz_app/http/jsonrpc_errors.js';
import {JSONRPC_VERSION} from '@fuzdev/fuz_app/http/jsonrpc.js';
import {
	create_jsonrpc_error_response,
	create_jsonrpc_error_response_from_thrown,
	to_jsonrpc_message_id,
	is_jsonrpc_request,
} from '@fuzdev/fuz_app/http/jsonrpc_helpers.js';

import type {Uuid} from '../zod_helpers.js';
import {all_action_specs} from '../action_specs.js';
import type {Backend} from './backend.js';
import {BackendWebsocketTransport} from './backend_websocket_transport.js';
import {zzz_action_handlers, type ZzzHandledMethod} from './zzz_action_handlers.js';

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

	// Build action spec lookup for per-action auth checking and input/output validation
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
								create_jsonrpc_error_response(null, jsonrpc_error_messages.parse_error()),
							),
						);
						return;
					}

					// Batch JSON-RPC is not supported on the WebSocket path.
					if (Array.isArray(json)) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(
									null,
									jsonrpc_error_messages.invalid_request(
										'batch JSON-RPC requests are not supported on WebSocket',
									),
								),
							),
						);
						return;
					}

					// Only handle requests (method + id). Notifications (no id) are silenced per JSON-RPC spec.
					if (!is_jsonrpc_request(json)) {
						// If it has a method but no id, it's a notification — no response per JSON-RPC spec
						if (typeof json === 'object' && json !== null && 'method' in json && !('id' in json)) {
							return;
						}
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(
									to_jsonrpc_message_id(json),
									jsonrpc_error_messages.invalid_request(),
								),
							),
						);
						return;
					}

					const {method, id, params} = json;

					// Per-action auth check — enforce auth level from action spec.
					const spec = spec_by_method.get(method);
					if (!spec) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(id, jsonrpc_error_messages.method_not_found(method)),
							),
						);
						return;
					}

					const {auth} = spec;
					if (auth === 'keeper') {
						if (credential_type !== 'daemon_token' || !has_role(request_context, ROLE_KEEPER)) {
							ws.send(
								JSON.stringify(
									create_jsonrpc_error_response(
										id,
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
								create_jsonrpc_error_response(
									id,
									jsonrpc_error_messages.internal_error(
										'role-based action auth is not yet supported on WebSocket',
									),
								),
							),
						);
						return;
					}

					// Look up handler — method is validated against spec_by_method above
					const handler = zzz_action_handlers[method as ZzzHandledMethod];
					if (!handler) {
						ws.send(
							JSON.stringify(
								create_jsonrpc_error_response(id, jsonrpc_error_messages.method_not_found(method)),
							),
						);
						return;
					}

					// Validate input against spec schema
					let validated_input;
					if (spec.input) {
						const parsed = spec.input.safeParse(params);
						if (!parsed.success) {
							ws.send(
								JSON.stringify(
									create_jsonrpc_error_response(
										id,
										jsonrpc_error_messages.invalid_params(`invalid params for ${method}`, {
											issues: parsed.error.issues,
										}),
									),
								),
							);
							return;
						}
						validated_input = parsed.data;
					} else {
						validated_input = params;
					}

					if (artificial_delay > 0) {
						backend.log?.debug(`[ws] throttling ${artificial_delay}ms`);
						await wait(artificial_delay);
					}

					try {
						// Input is Zod-validated above; cast needed because dynamic dispatch
						// indexes ZzzActionHandlers with a union key.
						const output = await (handler as any)(validated_input, {backend, request_id: id});

						// DEV-only output validation — catches handler bugs during development
						if (DEV && spec.output) {
							const output_parsed = spec.output.safeParse(output);
							if (!output_parsed.success) {
								backend.log?.error(
									`[ws] output validation failed for ${method}:`,
									output_parsed.error.issues,
								);
							}
						}

						// Send result directly — null stays null, matching the HTTP RPC path.
						// (to_jsonrpc_result wraps null → {} for MCP compat, but action specs
						// define output: z.null() and both backends should return null.)
						ws.send(JSON.stringify({jsonrpc: JSONRPC_VERSION, id, result: output}));
					} catch (error) {
						backend.log?.error('[ws] handler error:', method, error);
						ws.send(JSON.stringify(create_jsonrpc_error_response_from_thrown(id, error)));
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
