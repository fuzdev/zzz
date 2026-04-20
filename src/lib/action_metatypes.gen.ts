import type {Gen} from '@fuzdev/gro/gen.js';
import {ActionRegistry} from '@fuzdev/fuz_app/actions/action_registry.js';
import {
	ImportBuilder,
	create_banner,
	generate_actions_api_method_signature,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from './action_specs.js';

// TODO some of these can probably be declared differently without codegen

/**
 * Outputs a file with generated types and schemas using the action specs as the source of truth.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const registry = new ActionRegistry(all_action_specs);
	const banner = create_banner(origin_path);
	const imports = new ImportBuilder();

	imports.add('zod', 'z');
	imports.add_type('@fuzdev/fuz_util/result.js', 'Result');
	imports.add_type('@fuzdev/fuz_app/http/jsonrpc.js', 'JsonrpcErrorObject');
	imports.add_type('@fuzdev/fuz_app/actions/rpc_client.js', 'RpcClientCallOptions');
	imports.add_types('./action_collections.js', 'ActionInputs', 'ActionOutputs');

	return `
		// ${banner}

		${imports.build()}

		/**
		 * All action method names. Request/response actions have two types per method.
		 */
		export const ActionMethod = z.enum([
			${registry.specs.map(({method}) => `'${method}'`).join(',\n\t')}
		]);
		export type ActionMethod = z.infer<typeof ActionMethod>;

		/**
		 * Names of all request_response actions.
		 */
		export const RequestResponseActionMethod = z.enum([${registry.request_response_specs
			.map((spec) => `'${spec.method}'`)
			.join(',\n\t')}]);
		export type RequestResponseActionMethod = z.infer<typeof RequestResponseActionMethod>;

		/**
		 * Names of all remote_notification actions.
		 */
		export const RemoteNotificationActionMethod = z.enum([${registry.remote_notification_specs
			.map((spec) => `'${spec.method}'`)
			.join(',\n\t')}]);
		export type RemoteNotificationActionMethod = z.infer<typeof RemoteNotificationActionMethod>;

		/**
		 * Names of all local_call actions.
		 */
		export const LocalCallActionMethod = z.enum([${registry.local_call_specs
			.map((spec) => `'${spec.method}'`)
			.join(',\n\t')}]);
		export type LocalCallActionMethod = z.infer<typeof LocalCallActionMethod>;

		/**
		 * Names of all actions that may be handled on the client.
		 */
		export const FrontendActionMethod = z.enum([${registry.frontend_methods
			.map((method) => `'${method}'`)
			.join(',\n\t')}]);
		export type FrontendActionMethod = z.infer<typeof FrontendActionMethod>;

		/**
		 * Names of all actions that may be handled on the server.
		 */
		export const BackendActionMethod = z.enum([${registry.backend_methods
			.map((method) => `'${method}'`)
			.join(',\n\t')}]);
		export type BackendActionMethod = z.infer<typeof BackendActionMethod>;

		/**
		 * Interface for action dispatch functions.
		 * Async methods (request_response, async local_call) return \`Promise<Result<...>>\`
		 * and accept an optional \`RpcClientCallOptions\` second arg that threads \`signal\`,
		 * \`transport_name\`, and \`queue\` through to the peer. Sync methods (like
		 * \`toggle_main_menu\`) return values directly.
		 */
		export interface ActionsApi {
			${registry.specs.map((spec) => generate_actions_api_method_signature(spec)).join('\n\t')}
		}

		// ${banner}
	`;
};
