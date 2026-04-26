import type {Gen} from '@fuzdev/gro/gen.js';
import {
	ImportBuilder,
	create_banner,
	generate_frontend_action_handlers,
	generate_typed_action_event_alias,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from './action_specs.js';

/**
 * Generates frontend action handler types based on spec.initiator.
 * Uses `TypedActionEvent` to carry typed input/output from the generated `ActionEventDatas` map.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const imports = new ImportBuilder();
	const banner = create_banner(origin_path);

	// `include_composables: true` keeps `heartbeat` / `cancel` on the typed
	// surface — see the matching note in `action_collections.gen.ts`.
	const options = {include_composables: true};

	const blocks = [
		generate_typed_action_event_alias(imports),
		generate_frontend_action_handlers(all_action_specs, imports, options),
	].join('\n\n');

	return `
		// ${banner}

		${imports.build()}

		${blocks}

		// ${banner}
	`;
};
