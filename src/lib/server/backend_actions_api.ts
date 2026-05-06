import {DEV} from 'esm-env';
import {create_broadcast_api} from '@fuzdev/fuz_app/actions/broadcast_api.js';

import type {FilerChangeHandler, Backend} from './backend.js';
import {broadcast_action_specs, type BackendActionsApi} from './backend_action_types.js';
import {
	map_watcher_change_to_diskfile_change,
	to_serializable_disknode,
} from '../diskfile_helpers.js';
import {DiskfilePath, SerializableDisknode} from '../diskfile_types.js';

export const create_backend_actions_api = (backend: Backend): BackendActionsApi =>
	create_broadcast_api<BackendActionsApi>({
		peer: backend.peer,
		specs: broadcast_action_specs,
		log: backend.log,
	});

// TODO where does this belong? it calls into the `BackendActionsApi`
/**
 * Handle file system changes and notify clients.
 */
export const handle_filer_change: FilerChangeHandler = (
	change,
	disknode,
	backend,
	dir,
	_filer,
): void => {
	const api_change = {
		type: map_watcher_change_to_diskfile_change(change.type),
		path: DiskfilePath.parse(change.path),
	};
	const serializable_disknode = to_serializable_disknode(disknode, dir);

	// In development mode, validate strictly and fail loudly.
	// This is less of a need in production because we control both sides,
	// but maybe it should be optional or even required.
	if (DEV) {
		SerializableDisknode.parse(serializable_disknode);

		// TODO can this be moved to the schema?
		if (!serializable_disknode.id.startsWith(serializable_disknode.source_dir)) {
			throw new Error(
				`source file ${serializable_disknode.id} does not start with source dir ${serializable_disknode.source_dir}`,
			);
		}
	}

	void backend.api.filer_change({
		change: api_change,
		disknode: serializable_disknode,
	});
};
