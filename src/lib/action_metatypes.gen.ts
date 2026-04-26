import type {Gen} from '@fuzdev/gro/gen.js';
import {
	ImportBuilder,
	compose_gen_file,
	generate_action_method_enums,
	generate_frontend_actions_api,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from './action_specs.js';

/**
 * Outputs a file with generated types and schemas using the action specs as the source of truth.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_method_enums(all_action_specs, imports),
			generate_frontend_actions_api(all_action_specs, imports),
		],
	});
};
