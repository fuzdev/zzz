/**
 * RPC actions for zzz — thin adapter from unified handlers to fuz_app's `RpcAction` format.
 *
 * Binds `create_zzz_action_handlers(backend)` once and pairs each handler
 * with its spec for `create_rpc_endpoint`. All business logic lives in
 * `server/zzz_action_handlers.ts`.
 *
 * @module
 */

import type {RpcAction, ActionHandler} from '@fuzdev/fuz_app/actions/action_rpc.js';
import type {RequestResponseActionSpec} from '@fuzdev/fuz_app/actions/action_spec.js';
import {is_protocol_action_method} from '@fuzdev/fuz_app/actions/action_codegen.js';

import type {Backend} from './backend.js';
import {create_zzz_action_handlers} from './zzz_action_handlers.js';
import {all_action_specs} from '../action_specs.js';
import type {BackendRequestResponseMethod} from '../action_metatypes.js';

/** Dependencies for creating zzz RPC actions. */
export interface ZzzRpcDeps {
	backend: Backend;
	/**
	 * Extra `(spec, handler)` pairs to register alongside zzz's production
	 * actions — used by integration tests to opt in `_test_*` specs via
	 * `ZZZ_ENABLE_TEST_ACTIONS`. Production callers leave this empty.
	 */
	extra_actions?: ReadonlyArray<RpcAction>;
}

/**
 * Create all zzz RPC actions.
 *
 * Returns `RpcAction[]` for `create_rpc_endpoint`. Each handler is built
 * once at boot from `create_zzz_action_handlers(backend)`; the handlers
 * close over `backend` and receive fuz_app's unified `ActionContext`
 * directly — no per-call adapter shim.
 *
 * fuz_app's protocol actions (heartbeat, cancel) are excluded — `cancel`
 * is `remote_notification` (filtered by `kind`), and `heartbeat`'s handler
 * lives in fuz_app's `protocol_actions` bundle (WS liveness only), so
 * HTTP RPC doesn't expose it.
 *
 * `BackendActionHandlers` is keyed by `BackendRequestResponseMethod`,
 * which is generated from `all_action_specs` — so every non-protocol
 * request_response spec is guaranteed at compile time to have a handler.
 * The cast below is the unavoidable bridge from `string` to that union.
 */
export const create_zzz_rpc_actions = (deps: ZzzRpcDeps): Array<RpcAction> => {
	const handlers = create_zzz_action_handlers(deps.backend);

	const production_actions: Array<RpcAction> = all_action_specs
		.filter((spec): spec is RequestResponseActionSpec => spec.kind === 'request_response')
		.filter((spec) => !is_protocol_action_method(spec.method))
		.map((spec) => ({
			spec,
			handler: handlers[spec.method as BackendRequestResponseMethod] as ActionHandler,
		}));

	return deps.extra_actions ? [...production_actions, ...deps.extra_actions] : production_actions;
};
