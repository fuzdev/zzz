import type {Gen} from '@fuzdev/gro/gen.js';
import {
	ImportBuilder,
	compose_gen_file,
	generate_action_event_datas,
	generate_action_inputs_outputs,
	generate_action_specs_record,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from './action_specs.js';

/**
 * Outputs a file with action collection types that can be imported by schemas.ts.
 * This is separate from `action_metatypes.gen.ts` to avoid circular dependencies.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const imports = new ImportBuilder();
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_specs_record(all_action_specs, imports),
			generate_action_inputs_outputs(all_action_specs, imports),
			// `collections_path` left unset — same-file scope: this gen feeds the
			// same `action_collections.ts` output as `generate_action_inputs_outputs`,
			// so `ActionInputs` / `ActionOutputs` resolve locally without imports.
			generate_action_event_datas(all_action_specs, imports),
		],
	});
};
