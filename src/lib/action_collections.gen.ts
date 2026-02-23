import type {Gen} from '@fuzdev/gro/gen.js';
import {ActionRegistry} from '@fuzdev/fuz_app/action_registry.js';
import {ImportBuilder, create_banner} from '@fuzdev/fuz_app/action_codegen.js';

import {all_action_specs} from './action_specs.js';
import {
	to_action_spec_input_identifier,
	to_action_spec_output_identifier,
} from './action_helpers.js';

/**
 * Outputs a file with action collection types that can be imported by schemas.ts.
 * This is separate from `action_metatypes.gen.ts` to avoid circular dependencies.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const registry = new ActionRegistry(all_action_specs);
	const imports = new ImportBuilder();
	const banner = create_banner(origin_path);

	// Add base imports
	imports.add('zod', 'z');
	imports.add_type('@fuzdev/fuz_app/action_spec.js', 'ActionSpecUnion');
	imports.add_many('./action_specs.js', '* as specs');

	// Determine which data type to use for each method based on its spec
	const action_event_data_mappings = registry.specs.map((spec) => {
		const data_type =
			spec.kind === 'request_response'
				? 'ActionEventRequestResponseData'
				: spec.kind === 'remote_notification'
					? 'ActionEventRemoteNotificationData'
					: 'ActionEventLocalCallData';

		imports.add_types('./action_event_data.js', data_type);

		return `${spec.method}: ${data_type}<'${spec.method}'>`;
	});

	return `
		// ${banner}

		${imports.build()}

		// TODO consistent naming, maybe \`ActionMethodUnion\`
		/**
		 * All method types combined.
		 */
		export const ActionMethods = z.enum([
			${registry.methods.map((method) => `'${method}'`).join(',\n\t\t\t')}
		]);
		export type ActionMethods = z.infer<typeof ActionMethods>;
		
		/**
		 * Action specifications indexed by method name.
		 * These represent the complete action spec definitions.
		 */
		export const ActionSpecs = {
			${registry.specs
				.map((spec) => `${spec.method}: specs.${spec.method}_action_spec`)
				.join(',\n\t\t\t')}
		} as const;
		export interface ActionSpecs {
			${registry.specs
				.map((spec) => `${spec.method}: typeof specs.${spec.method}_action_spec`)
				.join(';\n\t\t\t')}
		}

		export const action_specs: Array<ActionSpecUnion> = Object.values(ActionSpecs);

		/**
		 * Action parameter schemas indexed by method name.
		 * These represent the input data for each action,
		 * e.g. JSON-RPC request/notification params and local call arguments.
		 */
		export const ActionInputs = {
			${registry.specs
				.map((spec) => `${spec.method}: specs.${to_action_spec_input_identifier(spec.method)}`)
				.join(',\n\t\t\t')}
		} as const;
		export interface ActionInputs {
			${registry.specs
				.map(
					(spec) =>
						`${spec.method}: z.infer<typeof specs.${to_action_spec_input_identifier(spec.method)}>`,
				)
				.join(';\n\t\t\t')}
		}

		/**
		 * Action result schemas indexed by method name.
		 * These represent the output data for each action,
		 * e.g. JSON-RPC response results and local call return values.
		 */
		export const ActionOutputs = {
			${registry.specs
				.map((spec) => `${spec.method}: specs.${to_action_spec_output_identifier(spec.method)}`)
				.join(',\n\t\t\t')}
		} as const;
		export interface ActionOutputs {
			${registry.specs
				.map(
					(spec) =>
						`${spec.method}: z.infer<typeof specs.${to_action_spec_output_identifier(spec.method)}>`,
				)
				.join(';\n\t\t\t')}
		}

		/**
		 * Action event data types indexed by method name.
		 * These represent the full discriminated union of all possible states
		 * for each action's event data, properly typed with inputs and outputs.
		 */
		export interface ActionEventDatas {
			${action_event_data_mappings.join(';\n\t\t\t')}
		}

		// ${banner}
	`;
};
