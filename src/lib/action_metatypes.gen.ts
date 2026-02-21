import type {Gen} from '@fuzdev/gro/gen.js';

import {get_innermost_type_name} from './zod_helpers.js';
import * as action_specs from './action_specs.js';
import {is_action_spec} from '@fuzdev/fuz_app/action_spec.js';
import {ActionRegistry} from './action_registry.js';
import {ImportBuilder, create_banner} from './codegen.js';

// TODO some of these can probably be declared differently without codegen

/**
 * Outputs a file with generated types and schemas using the action specs as the source of truth.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const registry = new ActionRegistry(Object.values(action_specs).filter((s) => is_action_spec(s)));
	const banner = create_banner(origin_path);
	const imports = new ImportBuilder();

	imports.add('zod', 'z');
	imports.add_type('@fuzdev/fuz_util/result.js', 'Result');
	imports.add_types('./action_collections.js', 'ActionInputs', 'ActionOutputs');
	imports.add_type('./jsonrpc.js', 'JsonrpcErrorJson');

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
		 * All async methods return Result types for type-safe error handling.
		 * Sync methods (like toggle_main_menu) return values directly.
		 */
		export interface ActionsApi {
			${registry.specs
				.map((spec) => {
					const innermost_type_name = get_innermost_type_name(spec.input);
					const has_input = innermost_type_name !== 'null' && innermost_type_name !== 'void';
					const is_async = spec.kind === 'request_response' || spec.async;
					const return_type = is_async
						? `Promise<Result<{value: ActionOutputs['${spec.method}']}, {error: JsonrpcErrorJson}>>`
						: `ActionOutputs['${spec.method}']`; // Sync method returns value directly
					return `${spec.method}: (${
						has_input
							? `input${spec.input.safeParse(undefined).success ? '?' : ''}: ActionInputs['${spec.method}']`
							: 'input?: void'
					}) => ${return_type};`;
				})
				.join('\n\t')}
		}

		// ${banner}
	`;
};
