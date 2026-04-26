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
 * `include_protocol_actions: true` keeps `heartbeat` / `cancel` in the runtime
 * arrays + typed maps so the registry built from `action_specs` covers every
 * dispatchable method and `ActionInputs[method]` resolves uniformly. The
 * narrow handler-side enums in `action_metatypes.ts` exclude protocols
 * separately (see comment there).
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const imports = new ImportBuilder();
	const options = {include_protocol_actions: true};
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_action_specs_record(all_action_specs, imports, options),
			generate_action_inputs_outputs(all_action_specs, imports, options),
			// `collections_path` left unset — same-file scope: this gen feeds the
			// same `action_collections.ts` output as `generate_action_inputs_outputs`,
			// so `ActionInputs` / `ActionOutputs` resolve locally without imports.
			generate_action_event_datas(all_action_specs, imports, options),
		],
	});
};
