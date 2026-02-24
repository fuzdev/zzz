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
 * Frontend can handle:
 * - send/execute phases when initiator is 'frontend' or 'both'
 * - receive phases when initiator is 'backend' or 'both'
 *
 * Example generated imports:
 * ```typescript
 * import type {ActionEvent} from './action_event.js';
 * import type {ActionInputs, ActionOutputs} from './action_collections.js';
 * import type {Frontend} from './frontend.svelte.js';
 * ```
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const registry = new ActionRegistry(all_action_specs);
	const banner = create_banner(origin_path);
	const imports = new ImportBuilder();

	// Generate handlers for each spec, building imports on demand
	const frontend_action_handlers = registry.specs
		.map((spec) => generate_phase_handlers(spec, 'frontend', imports))
		.filter(Boolean) // Remove empty strings
		.join(';\n\t');

	return `
		// ${banner}

		${imports.build()}

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
