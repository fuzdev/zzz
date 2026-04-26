import type {Gen} from '@fuzdev/gro/gen.js';
import {
	ImportBuilder,
	create_banner,
	generate_action_method_enums,
	generate_actions_api,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from './action_specs.js';

/**
 * Outputs a file with generated types and schemas using the action specs as the source of truth.
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
		generate_action_method_enums(all_action_specs, imports, options),
		generate_actions_api(all_action_specs, imports, options),
	].join('\n\n');

	return `
		// ${banner}

		${imports.build()}

		${blocks}

		// ${banner}
	`;
};
