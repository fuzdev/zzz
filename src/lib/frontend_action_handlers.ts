import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import type { Frontend } from './frontend.svelte.ts';
import type { FrontendActionHandlers } from './frontend_action_types.ts';
import { Turn } from './turn.svelte.ts';
import { to_completion_response_text } from './response_helpers.ts';

// TODO stubbing out a lot of these

export const create_frontend_action_handlers = (frontend: Frontend): FrontendActionHandlers => ({
	ping: {
		send_request: ({ data: { request } }) => {
			frontend.capabilities.handle_ping_sent(request.id);
		},
		receive_response: ({ data: { output } }) => {
			frontend.capabilities.handle_ping_received(output.ping_id);
		},
		receive_error: ({ data: { error, request } }) => {
			console.error('[frontend_action_handlers] ping failed:', error);
			frontend.capabilities.handle_ping_error(request.id, error.message);
		}
	},

	session_load: {
		send_request: () => {
			console.log('[frontend_action_handlers] loading session...');
		},
		receive_response: ({ data: { output, response } }) => {
			console.log('[frontend_action_handlers] session loaded:', response);

			frontend.receive_session(output.data);
		},
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] session load failed:', error);
		}
	},

	completion_create: {
		send_request: (action_event) => {
			const {
				data: { input }
			} = action_event;
			console.log('[frontend_action_handlers] sending prompt:', input.completion_request.prompt);
		},
		receive_response: (action_event) => {
			const {
				data: { input, output }
			} = action_event;
			console.log(
				'[frontend_action_handlers] received completion:',
				input.completion_request,
				output
			);

			// TODO hacky
			const progress_token = input._meta?.progressToken;
			if (progress_token) {
				const turn = frontend.cell_registry.all.get(progress_token);
				if (turn) {
					if (turn instanceof Turn) {
						// TODO hacky, shouldnt need to do this
						// Get the final response text
						const response_text = to_completion_response_text(output.completion_response) || '';

						// Update the assistant turn's text part with the final response content and metadata
						if (!turn.set_completion_text(response_text)) {
							console.error(
								'[frontend_action_handlers] completion turn has no assistant text part:',
								progress_token
							);
						}
						turn.response = output.completion_response;
					} else {
						console.error(
							'[frontend_action_handlers] unknown cell type for for completion progress_token:',
							progress_token
						);
					}
					return;
				}

				console.error(
					'[frontend_action_handlers] no assistant turn found for completion progress_token:',
					progress_token
				);
			}
		},
		receive_error: ({ data: { input, error } }) => {
			const cancelled = error.code === JSONRPC_ERROR_CODES.request_cancelled;
			// User-initiated cancels are expected and not a failure — log quietly
			// and keep whatever content the stream already delivered (no error banner).
			if (cancelled) {
				console.log('[frontend_action_handlers] completion cancelled');
			} else {
				console.error('[frontend_action_handlers] completion failed:', error);
			}
			const progress_token = input._meta?.progressToken;
			if (progress_token) {
				const turn = frontend.cell_registry.all.get(progress_token);
				if (turn instanceof Turn && !turn.settled) {
					// keep any streamed content — the error renders separately,
					// and errored turns are excluded from later completion history
					if (cancelled) {
						turn.cancelled = true;
					} else {
						turn.error_message = error.message;
					}
				}
			}
		}
	},

	diskfile_update: {
		send_request: ({ data: { input } }) => {
			console.log('[frontend_action_handlers] updating file:', input.path);
		},
		receive_response: ({ data: { input, output } }) => {
			console.log('[frontend_action_handlers] updated file:', input.path, output);
		},
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] update file failed:', input.path, error);
		}
	},

	diskfile_create: {
		send_request: ({ data: { input } }) => {
			console.log('[frontend_action_handlers] creating file:', input.path);
		},
		receive_response: ({ data: { input } }) => {
			console.log('[frontend_action_handlers] created file:', input.path);
		},
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] create file failed:', input.path, error);
		}
	},

	diskfile_delete: {
		send_request: ({ data: { input } }) => {
			console.log('[frontend_action_handlers] deleting file:', input.path);
		},
		receive_response: ({ data: { input } }) => {
			console.log('[frontend_action_handlers] deleted file:', input.path);
		},
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] delete file failed:', input.path, error);
		}
	},

	directory_create: {
		send_request: ({ data: { input } }) => {
			console.log('[frontend_action_handlers] creating directory:', input.path);
		},
		receive_response: (ctx) => {
			console.log('[frontend_action_handlers] created directory:', ctx);
		},
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] create directory failed:', input.path, error);
		}
	},

	filer_change: {
		receive: ({ data: { input } }) => {
			frontend.diskfiles.handle_change(input);
		}
	},

	completion_progress: {
		receive: ({ data: { input } }) => {
			// console.log('[frontend_action_handlers] received completion streaming progress:', input);
			const { chunk } = input;
			const progress_token = input._meta?.progressToken;

			const turn = progress_token && frontend.cell_registry.all.get(progress_token);

			// a removed turn leaves the registry and its thread cancels the completion,
			// but chunks already in flight can still arrive — drop them quietly
			if (!turn) return;

			if (!(turn instanceof Turn) || !chunk || turn.role !== chunk.message?.role) {
				console.error(
					'[frontend_action_handlers] no matching turn found for progress_token:',
					progress_token,
					'chunk:',
					chunk
				);
				return;
			}

			// ignore chunks that arrive after the turn got its final response,
			// failed, or was cancelled — they'd duplicate or resurrect content
			if (turn.settled) return;

			if (!turn.append_completion_text(chunk.message.content)) {
				// nothing can take the output — stop the completion, which settles
				// the turn so later chunks are dropped above instead of re-logging
				console.error(
					'[frontend_action_handlers] completion turn has no assistant text part, cancelling:',
					progress_token
				);
				const thread = turn.thread_id
					? frontend.threads.items.by_id.get(turn.thread_id)
					: undefined;
				if (!thread?.cancel_pending_turn(turn)) turn.cancelled = true;
			}
		}
	},

	toggle_main_menu: {
		execute: ({ data: { input } }) => {
			return { show: frontend.ui.toggle_main_menu(input?.show) };
		}
	},

	provider_load_status: {
		receive_response: ({ data: { output } }) => {
			frontend.update_provider_status(output.status);
		}
	},

	// terminal state is settled by `Terminals` / `Terminal` from the call results
	terminal_create: {
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] terminal_create failed:', error);
		}
	},

	terminal_data_send: {},

	terminal_data: {
		receive: ({ data: { input } }) => {
			frontend.terminals.receive_output(input.terminal_id, input.data);
		}
	},

	terminal_resize: {},

	terminal_close: {
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] terminal_close failed:', error);
		}
	},

	terminal_exited: {
		receive: ({ data: { input } }) => {
			frontend.terminals.receive_exited(input.terminal_id, input.exit_code);
		}
	},

	workspace_open: {
		receive_response: ({ data: { output } }) => {
			frontend.workspaces.add(output.workspace);
			// populate diskfiles from initial file tree
			frontend.diskfiles.add_initial(output.files);
		},
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] workspace_open failed:', error);
		}
	},

	workspace_close: {
		receive_response: ({ data: { input } }) => {
			frontend.workspaces.remove_by_path(input.path);
		},
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] workspace_close failed:', error);
		}
	},

	workspace_list: {
		receive_response: ({ data: { output } }) => {
			for (const workspace_data of output.workspaces) {
				frontend.workspaces.add(workspace_data);
			}
		},
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] workspace_list failed:', error);
		}
	},

	workspace_changed: {
		receive: ({ data: { input } }) => {
			if (input.type === 'open') {
				frontend.workspaces.add(input.workspace);
			} else {
				frontend.workspaces.remove_by_path(input.workspace.path);
			}
		}
	}
});
