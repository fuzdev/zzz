/**
 * WebSocket endpoint wiring — thin wrapper over fuz_app's
 * `register_ws_endpoint`.
 *
 * zzz supplies the action tuples (spec + handler) and the per-request DB
 * handle; fuz_app owns the upgrade middleware stack (origin check, auth,
 * authorization phase that builds `RequestContext`), dispatch, validation,
 * and transport bookkeeping. Domain deps flow through
 * `create_zzz_action_handlers(backend)` — the factory closes over the
 * `Backend`, so handlers receive the unified `ActionContext` directly.
 *
 * The shared `protocol_actions` bundle (heartbeat + cancel pre-paired with
 * their handlers) is spread first so disconnect detection and per-request
 * cancellation are identical across every fuz_app consumer.
 *
 * @module
 */

import type {Hono} from 'hono';
import type {UpgradeWebSocket} from 'hono/ws';
import {register_ws_endpoint} from '@fuzdev/fuz_app/actions/register_ws_endpoint.js';
import type {Action} from '@fuzdev/fuz_app/actions/action_types.js';
import {BackendWebsocketTransport} from '@fuzdev/fuz_app/actions/transports_ws_backend.js';
import {protocol_actions} from '@fuzdev/fuz_app/actions/protocol.js';
import {is_protocol_action_method} from '@fuzdev/fuz_app/actions/action_codegen.js';
import type {Db} from '@fuzdev/fuz_app/db/db.js';

import {all_action_specs} from '../action_specs.js';
import type {Backend} from './backend.js';
import {create_zzz_action_handlers, get_action_handler} from './zzz_action_handlers.js';

export interface RegisterWebsocketActionsOptions {
	path: string;
	app: Hono;
	backend: Backend;
	/** Pool-level DB — the dispatcher wraps in `db.transaction` for `side_effects: true` actions. */
	db: Db;
	/** @see https://hono.dev/helpers/websocket */
	upgradeWebSocket: UpgradeWebSocket;
	/** Origin allowlist regexes — applied to the upgrade by `register_ws_endpoint`. */
	allowed_origins: Array<RegExp>;
	/** Artificial response delay in ms (testing). */
	artificial_delay?: number;
	transport?: BackendWebsocketTransport;
	/**
	 * Extra actions to register alongside zzz's production actions — used by
	 * integration tests to opt in `_test_*` specs via `ZZZ_ENABLE_TEST_ACTIONS`.
	 * Production callers leave this empty.
	 */
	extra_actions?: ReadonlyArray<Action>;
}

/**
 * Registers the WebSocket endpoint for all zzz request/response actions.
 *
 * Per-action auth, Zod validation, transaction scope, and socket-scoped
 * `notify` / `signal` come from fuz_app. zzz domain state reaches handlers
 * through the `Backend` closure baked into the handler map at boot.
 */
export const register_websocket_actions = ({
	path,
	app,
	backend,
	db,
	upgradeWebSocket,
	allowed_origins,
	artificial_delay = 0,
	transport = new BackendWebsocketTransport(),
	extra_actions,
}: RegisterWebsocketActionsOptions): void => {
	backend.peer.transports.register_transport(transport);

	const handlers = create_zzz_action_handlers(backend);

	// Build the action array: fuz_app's protocol_actions (heartbeat + cancel
	// pre-paired with their handlers) first, then every zzz spec paired with
	// its handler — protocol specs are skipped during iteration since they're
	// already registered above. Specs without a handler (backend-initiated
	// notifications, client-only) are registered spec-only.
	const actions: Array<Action> = [...protocol_actions];
	for (const spec of all_action_specs) {
		if (is_protocol_action_method(spec.method)) continue;
		const handler = get_action_handler(handlers, spec.method);
		if (handler) {
			actions.push({spec, handler});
		} else {
			actions.push({spec});
		}
	}
	if (extra_actions) actions.push(...extra_actions);

	register_ws_endpoint({
		path,
		app,
		upgradeWebSocket,
		actions,
		db,
		transport,
		artificial_delay,
		allowed_origins,
		log: backend.log ?? undefined,
	});
};
