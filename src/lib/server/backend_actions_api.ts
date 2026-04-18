import {DEV} from 'esm-env';
import type {ActionSpecUnion} from '@fuzdev/fuz_app/actions/action_spec.js';
import {
	create_jsonrpc_notification,
	to_jsonrpc_params,
} from '@fuzdev/fuz_app/http/jsonrpc_helpers.js';

import type {FilerChangeHandler, Backend} from './backend.js';
import type {ActionInputs} from '../action_collections.js';
import {format_zod_validation_error} from '../zod_helpers.js';
import {
	filer_change_action_spec,
	terminal_data_action_spec,
	terminal_exited_action_spec,
	workspace_changed_action_spec,
} from '../action_specs.js';
import {
	map_watcher_change_to_diskfile_change,
	to_serializable_disknode,
} from '../diskfile_helpers.js';
import {DiskfilePath, SerializableDisknode} from '../diskfile_types.js';

/**
 * Broadcast-style notifications from the backend to all connected clients.
 * Request-scoped streaming (completion_progress, ollama_progress) goes through
 * `ctx.notify` instead — it's socket-scoped, not a broadcast.
 */
export interface BackendActionsApi {
	filer_change: (input: ActionInputs['filer_change']) => Promise<void>;
	terminal_data: (input: ActionInputs['terminal_data']) => Promise<void>;
	terminal_exited: (input: ActionInputs['terminal_exited']) => Promise<void>;
	workspace_changed: (input: ActionInputs['workspace_changed']) => Promise<void>;
}

/**
 * Sends a backend-initiated notification directly — validates input with Zod,
 * creates a JsonrpcNotification, and sends via peer.
 * Skips silently if no transport is available (e.g., at startup before any clients connect).
 */
const send_notification = async (
	backend: Backend,
	spec: ActionSpecUnion,
	input: unknown,
): Promise<void> => {
	const transport = backend.peer.transports.get_transport(
		backend.peer.default_send_options.transport_name,
	);
	if (!transport) {
		return;
	}

	try {
		const parsed = spec.input.safeParse(input);
		if (!parsed.success) {
			backend.log?.error(
				`[backend_actions_api.${spec.method}] input validation failed:`,
				format_zod_validation_error(parsed.error),
			);
			return;
		}

		const notification = create_jsonrpc_notification(spec.method, to_jsonrpc_params(parsed.data));

		const result = await backend.peer.send(notification);
		if (result !== null) {
			backend.log?.error(
				`[backend_actions_api.${spec.method}] failed to send notification:`,
				result.error,
			);
		}
	} catch (error) {
		backend.log?.error(`[backend_actions_api.${spec.method}] unexpected error:`, error);
	}
};

export const create_backend_actions_api = (backend: Backend): BackendActionsApi => {
	return {
		filer_change: (input) => send_notification(backend, filer_change_action_spec, input),
		terminal_data: (input) => send_notification(backend, terminal_data_action_spec, input),
		terminal_exited: (input) => send_notification(backend, terminal_exited_action_spec, input),
		workspace_changed: (input) => send_notification(backend, workspace_changed_action_spec, input),
	};
};

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

	// console.log(`change, disknode.id`, change.type, change.path, change.is_directory);

	void backend.api.filer_change({
		change: api_change,
		disknode: serializable_disknode,
	});
};
