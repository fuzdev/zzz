import type {Gen} from '@fuzdev/gro/gen.js';
import {
	ImportBuilder,
	compose_gen_file,
	generate_backend_action_handlers_map,
	generate_backend_actions_api,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {all_action_specs} from '../action_specs.js';

/**
 * Generates the backend's typed dispatch + handler surfaces:
 * - `BackendActionsApi` — typed broadcast surface used by `create_broadcast_api`.
 * - `broadcast_action_specs` — the matching `ReadonlyArray<ActionSpecUnion>` bundle.
 * - `BackendActionHandlers` — the typed handler map (`{[K in BackendRequestResponseMethod]: ...}`)
 *   that pins per-method input / output for `zzz_action_handlers`.
 *
 * `ZzzHandlerContext` is imported manually so the helper-emitted
 * `BackendActionHandlers` type closes over zzz's per-request context
 * shape without renaming.
 *
 * @nodocs
 */
export const gen: Gen = ({origin_path}) => {
	const imports = new ImportBuilder();
	imports.add_type('./zzz_action_handlers.js', 'ZzzHandlerContext');
	return compose_gen_file({
		origin_path,
		imports,
		blocks: [
			generate_backend_actions_api(all_action_specs, imports, {
				specs_module: '../action_specs.js',
				collections_path: '../action_collections.js',
			}),
			generate_backend_action_handlers_map(imports, {
				context_type: 'ZzzHandlerContext',
				collections_path: '../action_collections.js',
				metatypes_path: '../action_metatypes.js',
			}),
		],
	});
};
