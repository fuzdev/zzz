import type {Gen} from '@fuzdev/gro/gen.js';
import {
	type ActionMethodEnumKind,
	ImportBuilder,
	compose_gen_file,
	generate_action_method_enums,
	generate_frontend_actions_api,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from './action_specs.js';

/**
 * Outputs a file with generated types and schemas using the action specs as the source of truth.
 *
 * Method-enum kinds split by intent:
 * - **Open unions** (`ActionMethod`, `RequestResponseActionMethod`,
 *   `RemoteNotificationActionMethod`, `LocalCallActionMethod`,
 *   `FrontendActionMethod`, `BackendActionMethod`) include protocol actions
 *   (`heartbeat`, `cancel`) — they enumerate every dispatchable method.
 * - **Narrow handler-driving enums** (`FrontendRequestResponseMethod`,
 *   `BackendRequestResponseMethod`, `BroadcastActionMethod`) exclude protocol
 *   actions — they drive typed handler maps (`BackendActionHandlers` etc.)
 *   where protocol handlers don't belong (they ship dispatcher-owned via
 *   `protocol_actions`).
 *
 * `FrontendActionsApi` keeps protocol actions as callable methods so consumers
 * can invoke `app.api.heartbeat()` etc. for explicit dispatches.
 *
 * @nodocs
 */
const OPEN_UNION_KINDS: ReadonlySet<ActionMethodEnumKind> = new Set([
	'all',
	'request_response',
	'remote_notification',
	'local_call',
	'frontend',
	'backend',
]);
const HANDLER_NARROW_KINDS: ReadonlySet<ActionMethodEnumKind> = new Set([
	'frontend_handled',
	'backend_handled',
	'broadcast',
]);

export const gen: Gen = ({origin_path}) => {
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_method_enums(all_action_specs, imports, {
				emit: OPEN_UNION_KINDS,
				include_protocol_actions: true,
			}),
			generate_action_method_enums(all_action_specs, imports, {
				emit: HANDLER_NARROW_KINDS,
			}),
			generate_frontend_actions_api(all_action_specs, imports, {
				include_protocol_actions: true,
			}),
		],
	});
};
