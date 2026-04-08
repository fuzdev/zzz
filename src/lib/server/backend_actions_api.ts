import {DEV} from 'esm-env';

import type {FilerChangeHandler, Backend} from './backend.js';
import type {ActionInputs} from '../action_collections.js';
import {create_action_event} from '../action_event.js';
import {
	filer_change_action_spec,
	completion_progress_action_spec,
	ollama_progress_action_spec,
	terminal_data_action_spec,
	workspace_changed_action_spec,
} from '../action_specs.js';
import {
	map_watcher_change_to_diskfile_change,
	to_serializable_disknode,
} from '../diskfile_helpers.js';
import {DiskfilePath, SerializableDisknode} from '../diskfile_types.js';

// TODO very unfinished/hacky

// TODO @api think about unification between frontend|backend_actions_api.ts
// (also think about unification with backend_action_handlers.ts)
// this is all a hacky WIP,
// thinking about a symmetric API for the frontend/backend
// without blowing the budgets for complexity and performance,
// think about unification with frontend_actions_api.ts and see it for better patterns

export interface BackendActionsApi {
	filer_change: (input: ActionInputs['filer_change']) => Promise<void>;
	completion_progress: (input: ActionInputs['completion_progress']) => Promise<void>;
	ollama_progress: (input: ActionInputs['ollama_progress']) => Promise<void>;
	terminal_data: (input: ActionInputs['terminal_data']) => Promise<void>;
	workspace_changed: (input: ActionInputs['workspace_changed']) => Promise<void>;
}

export const create_backend_actions_api = (backend: Backend): BackendActionsApi => {
	// TODO extend logger to add labels to the below
	return {
		filer_change: async (input: ActionInputs['filer_change']) => {
			// TODO @api think about symmetry and generic handling, see how the frontend actions does it

			// TODO cleaner way to do this?
			// Skip sending notifications if no transport is available (e.g., at startup before any clients connect).
			// Files are already included in session_load, so these notifications are redundant until a client connects.
			const transport = backend.peer.transports.get_transport(
				backend.peer.default_send_options.transport_name,
			);
			if (!transport) {
				return; // Silently skip - no clients connected yet
			}

			try {
				const event = create_action_event(backend, filer_change_action_spec, input, 'send');

				await event.parse().handle_async();

				if (event.data.step === 'handled' && event.data.notification) {
					// Send notification to all clients via the WebSocket transport
					const result = await backend.peer.send(event.data.notification);
					if (result !== null) {
						backend.log?.error(
							'[backend_actions_api.filer_change] failed to send filer_change notification:',
							result.error,
						);
					}
				} else if (event.data.step === 'failed') {
					backend.log?.error(
						'[backend_actions_api.filer_change] failed to create filer_change notification:',
						event.data.error,
					);
				}
			} catch (error) {
				// TODO implement proper error handling strategy (don't throw - notifications are fire-and-forget)
				backend.log?.error(
					'[backend_actions_api.filer_change] unexpected error in filer_change:',
					error,
				);
			}
		},
		completion_progress: async (input: ActionInputs['completion_progress']) => {
			try {
				const event = create_action_event(backend, completion_progress_action_spec, input, 'send');

				await event.parse().handle_async();

				if (event.data.step === 'handled' && event.data.notification) {
					// Send notification to all clients via the WebSocket transport
					const result = await backend.peer.send(event.data.notification);
					if (result !== null) {
						backend.log?.error(
							'[backend_actions_api.completion_progress] failed to send completion_progress notification:',
							result.error,
						);
					}
				} else if (event.data.step === 'failed') {
					backend.log?.error(
						'[backend_actions_api.completion_progress] failed to create completion_progress notification:',
						event.data.error,
					);
				}
			} catch (error) {
				backend.log?.error(
					'[backend_actions_api.completion_progress] unexpected error in completion_progress:',
					error,
				);
			}
		},
		ollama_progress: async (input: ActionInputs['ollama_progress']) => {
			try {
				const event = create_action_event(backend, ollama_progress_action_spec, input, 'send');

				await event.parse().handle_async();

				if (event.data.step === 'handled' && event.data.notification) {
					// Send notification to all clients via the WebSocket transport
					const result = await backend.peer.send(event.data.notification);
					if (result !== null) {
						backend.log?.error(
							'[backend_actions_api.ollama_progress] failed to send ollama_progress notification:',
							result.error,
						);
					}
				} else if (event.data.step === 'failed') {
					backend.log?.error(
						'[backend_actions_api.ollama_progress] failed to create ollama_progress notification:',
						event.data.error,
					);
				}
			} catch (error) {
				backend.log?.error(
					'[backend_actions_api.ollama_progress] unexpected error in ollama_progress:',
					error,
				);
			}
		},
		workspace_changed: async (input: ActionInputs['workspace_changed']) => {
			const transport = backend.peer.transports.get_transport(
				backend.peer.default_send_options.transport_name,
			);
			if (!transport) {
				return; // no clients connected
			}

			try {
				const event = create_action_event(backend, workspace_changed_action_spec, input, 'send');

				await event.parse().handle_async();

				if (event.data.step === 'handled' && event.data.notification) {
					const result = await backend.peer.send(event.data.notification);
					if (result !== null) {
						backend.log?.error(
							'[backend_actions_api.workspace_changed] failed to send workspace_changed notification:',
							result.error,
						);
					}
				} else if (event.data.step === 'failed') {
					backend.log?.error(
						'[backend_actions_api.workspace_changed] failed to create workspace_changed notification:',
						event.data.error,
					);
				}
			} catch (error) {
				backend.log?.error(
					'[backend_actions_api.workspace_changed] unexpected error in workspace_changed:',
					error,
				);
			}
		},
		terminal_data: async (input: ActionInputs['terminal_data']) => {
			const transport = backend.peer.transports.get_transport(
				backend.peer.default_send_options.transport_name,
			);
			if (!transport) {
				return; // no clients connected
			}

			try {
				const event = create_action_event(backend, terminal_data_action_spec, input, 'send');

				await event.parse().handle_async();

				if (event.data.step === 'handled' && event.data.notification) {
					const result = await backend.peer.send(event.data.notification);
					if (result !== null) {
						backend.log?.error(
							'[backend_actions_api.terminal_data] failed to send terminal_data notification:',
							result.error,
						);
					}
				} else if (event.data.step === 'failed') {
					backend.log?.error(
						'[backend_actions_api.terminal_data] failed to create terminal_data notification:',
						event.data.error,
					);
				}
			} catch (error) {
				backend.log?.error(
					'[backend_actions_api.terminal_data] unexpected error in terminal_data:',
					error,
				);
			}
		},
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
