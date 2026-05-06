/**
 * RPC actions for zzz — thin adapter from unified handlers to fuz_app's `RpcAction` format.
 *
 * Maps `(input, ActionContext) -> handler(input, {backend, request_id})`.
 * All business logic lives in `server/zzz_action_handlers.ts`.
 *
 * @module
 */

import type {RpcAction, ActionHandler} from '@fuzdev/fuz_app/actions/action_rpc.js';
import type {RequestResponseActionSpec} from '@fuzdev/fuz_app/actions/action_spec.js';

import type {Backend} from './backend.js';
import {zzz_action_handlers} from './zzz_action_handlers.js';
import {all_action_specs} from '../action_specs.js';
import type {BackendRequestResponseMethod} from '../action_metatypes.js';

/** Dependencies for creating zzz RPC actions. */
export interface ZzzRpcDeps {
	backend: Backend;
}

/**
 * Create all zzz RPC actions.
 *
 * Returns `RpcAction[]` for `create_rpc_endpoint`.
 * Each handler wraps the unified handler with the fuz_app ActionContext adapter.
 */
export const create_zzz_rpc_actions = (deps: ZzzRpcDeps): Array<RpcAction> => {
	const {backend} = deps;

	return all_action_specs
		.filter((spec): spec is RequestResponseActionSpec => spec.kind === 'request_response')
		.filter((spec) => spec.method in zzz_action_handlers)
		.map((spec) => ({
			spec,
			handler: ((input, ctx) =>
				zzz_action_handlers[spec.method as BackendRequestResponseMethod](input, {
					backend,
					request_id: ctx.request_id,
					notify: ctx.notify,
					signal: ctx.signal,
				})) satisfies ActionHandler,
		}));
};
