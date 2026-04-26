import type {Gen} from '@fuzdev/gro/gen.js';
import {
	ImportBuilder,
	compose_gen_file,
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
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_typed_action_event_alias(imports),
			generate_frontend_action_handlers(all_action_specs, imports),
		],
	});
};
