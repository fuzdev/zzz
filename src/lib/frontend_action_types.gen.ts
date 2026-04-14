import type {Gen} from '@fuzdev/gro/gen.js';
import {ActionRegistry} from '@fuzdev/fuz_app/actions/action_registry.js';
import {
	ImportBuilder,
	generate_phase_handlers,
	create_banner,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from './action_specs.js';

/**
 * Generates frontend action handler types based on spec.initiator.
 * Uses `TypedActionEvent` to carry typed input/output from the generated `ActionEventDatas` map.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const registry = new ActionRegistry(all_action_specs);
	const banner = create_banner(origin_path);
	const imports = new ImportBuilder();

	// Add imports for the typed event alias
	imports.add_type('@fuzdev/fuz_app/actions/action_event.js', 'ActionEvent');
	imports.add_type('@fuzdev/fuz_app/actions/action_spec.js', 'ActionEventPhase');
	imports.add_type('@fuzdev/fuz_app/actions/action_event_types.js', 'ActionEventStep');
	imports.add_type('./action_collections.js', 'ActionEventDatas');

	// Generate handlers using custom TypedActionEvent that narrows data via ActionEventDatas
	const frontend_action_handlers = registry.specs
		.map((spec) =>
			generate_phase_handlers(spec, 'frontend', imports, {
				action_event_type: 'TypedActionEvent',
			}),
		)
		.filter(Boolean)
		.join(';\n\t');

	return `
		// ${banner}

		${imports.build()}

		import type {ActionMethod} from './action_metatypes.js';

		/** ActionEvent narrowed with zzz's generated ActionEventDatas for typed input/output. */
		type TypedActionEvent<TMethod extends ActionMethod, TPhase extends ActionEventPhase, TStep extends ActionEventStep> =
			ActionEvent<TMethod, TPhase, TStep> & {readonly data: ActionEventDatas[TMethod]};

		/**
		 * Frontend action handlers organized by method and phase.
		 * Generated using spec.initiator to determine valid phases:
		 * - initiator: 'frontend' → send/execute phases
		 * - initiator: 'backend' → receive phases
		 * - initiator: 'both' → all valid phases
		 */
		export interface FrontendActionHandlers {
			${frontend_action_handlers}
		}

		// ${banner}
	`;
};
