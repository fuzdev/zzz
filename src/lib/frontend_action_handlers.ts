import type {Frontend} from './frontend.svelte.js';
import type {FrontendActionHandlers} from './frontend_action_types.js';
import {Turn} from './turn.svelte.js';
import {to_completion_response_text} from './response_helpers.js';

// TODO stubbing out a lot of these

export const create_frontend_action_handlers = (frontend: Frontend): FrontendActionHandlers => ({
	ping: {
		send_request: ({data: {request}}) => {
			frontend.capabilities.handle_ping_sent(request.id);
		},
		receive_response: ({data: {output}}) => {
			frontend.capabilities.handle_ping_received(output.ping_id);
		},
		receive_error: ({data: {error, request}}) => {
			console.error('[frontend_action_handlers] ping failed:', error);
			frontend.capabilities.handle_ping_error(request.id, error.message);
		},
	},

	session_load: {
		send_request: () => {
			console.log('[frontend_action_handlers] loading session...');
		},
		receive_response: ({data: {output, response}}) => {
			console.log('[frontend_action_handlers] session loaded:', response);

			frontend.receive_session(output.data);
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] session load failed:', error);
		},
	},

	completion_create: {
		send_request: (action_event) => {
			const {
				data: {input},
			} = action_event;
			console.log('[frontend_action_handlers] sending prompt:', input.completion_request.prompt);
		},
		receive_response: (action_event) => {
			const {
				data: {input, output},
			} = action_event;
			console.log(
				'[frontend_action_handlers] received completion:',
				input.completion_request,
				output,
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

						// Update the assistant turn with the final response content and metadata
						turn.content = response_text;
						turn.response = output.completion_response;
					} else {
						console.error(
							'[frontend_action_handlers] unknown cell type for for completion progress_token:',
							progress_token,
						);
					}
					return;
				}

				console.error(
					'[frontend_action_handlers] no assistant turn found for completion progress_token:',
					progress_token,
				);
			}
		},
		receive_error: ({data: {input, error}}) => {
			console.error('[frontend_action_handlers] completion failed:', error);
			const progress_token = input._meta?.progressToken;
			if (progress_token) {
				const turn = frontend.cell_registry.all.get(progress_token);
				if (turn instanceof Turn) {
					turn.content = `Error: ${error.message}`;
					turn.error_message = error.message;
				}
			}
		},
	},

	diskfile_update: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] updating file:', input.path);
		},
		receive_response: ({data: {input, output}}) => {
			console.log('[frontend_action_handlers] updated file:', input.path, output);
		},
		receive_error: ({data: {input, error}}) => {
			console.error('[frontend_action_handlers] update file failed:', input.path, error);
		},
	},

	diskfile_delete: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] deleting file:', input.path);
		},
		receive_response: ({data: {input}}) => {
			console.log('[frontend_action_handlers] deleted file:', input.path);
		},
		receive_error: ({data: {input, error}}) => {
			console.error('[frontend_action_handlers] delete file failed:', input.path, error);
		},
	},

	directory_create: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] creating directory:', input.path);
		},
		receive_response: (ctx) => {
			console.log('[frontend_action_handlers] created directory:', ctx);
		},
		receive_error: ({data: {input, error}}) => {
			console.error('[frontend_action_handlers] create directory failed:', input.path, error);
		},
	},

	filer_change: {
		receive: ({data: {input}}) => {
			frontend.diskfiles.handle_change(input);
		},
	},

	completion_progress: {
		receive: ({data: {input}}) => {
			// console.log('[frontend_action_handlers] received completion streaming progress:', input);
			const {chunk} = input;
			const progress_token = input._meta?.progressToken;

			const turn = progress_token && frontend.cell_registry.all.get(progress_token);

			if (!turn || !(turn instanceof Turn) || !chunk || turn.role !== chunk.message?.role) {
				console.error(
					'[frontend_action_handlers] no matching turn found for progress_token:',
					progress_token,
					'chunk:',
					chunk,
				);
				return;
			}

			turn.content += chunk.message.content;
		},
	},

	toggle_main_menu: {
		execute: ({data: {input}}) => {
			return {show: frontend.ui.toggle_main_menu(input?.show)};
		},
	},

	ollama_list: {
		send_request: () => {
			console.log('[frontend_action_handlers] sending ollama_list request');
			frontend.ollama.handle_ollama_list_start();
		},
		receive_response: ({data: {output}}) => {
			console.log('[frontend_action_handlers] received ollama_list response:', output);
			frontend.ollama.handle_ollama_list_complete(output);
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] ollama_list failed:', error);
			frontend.ollama.list_status = 'failure';
			frontend.ollama.list_error = error.message;
			frontend.ollama.list_last_updated = Date.now();
		},
	},
	ollama_ps: {
		send_request: () => {
			console.log('[frontend_action_handlers] sending ollama_ps request');
			frontend.ollama.handle_ollama_ps_start();
		},
		receive_response: ({data: {output}}) => {
			console.log('[frontend_action_handlers] received ollama_ps response:', output);
			frontend.ollama.handle_ollama_ps_complete(output);
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] ollama_ps failed:', error);
			frontend.ollama.ps_status = 'failure';
			frontend.ollama.ps_error = error.message;
		},
	},
	ollama_show: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] sending ollama_show request:', input);
		},
		receive_response: ({data: {input, output}}) => {
			console.log('[frontend_action_handlers] received ollama_show response:', input, output);
			frontend.ollama.handle_ollama_show(input, output);
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] ollama_show failed:', error);
		},
	},
	ollama_pull: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] sending ollama_pull request:', input);
			frontend.ollama.pulling_models.add(input.model);
		},
		receive_response: ({data: {input}}) => {
			console.log('[frontend_action_handlers] received ollama_pull response:', input);
			frontend.ollama.pulling_models.delete(input.model);
			frontend.ollama.pull_model_name = '';
			frontend.ollama.pull_insecure = false;
		},
		receive_error: ({data: {input, error}}) => {
			console.error('[frontend_action_handlers] ollama_pull failed:', error);
			frontend.ollama.pulling_models.delete(input.model);
		},
	},
	ollama_delete: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] sending ollama_delete request:', input);
		},
		receive_response: async ({data: {input}}) => {
			console.log('[frontend_action_handlers] received ollama_delete response:', input);
			await frontend.ollama.handle_ollama_delete(input);
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] ollama_delete failed:', error);
		},
	},
	ollama_copy: {
		send_request: () => {
			console.log('[frontend_action_handlers] sending ollama_copy request');
			frontend.ollama.copy_is_copying = true;
		},
		receive_response: async () => {
			console.log('[frontend_action_handlers] received ollama_copy response');
			frontend.ollama.copy_source_model = '';
			frontend.ollama.copy_destination_model = '';
			frontend.ollama.copy_is_copying = false;
			await frontend.ollama.refresh();
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] ollama_copy failed:', error);
			frontend.ollama.copy_is_copying = false;
		},
	},
	ollama_create: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] sending ollama_create request:', input);
			frontend.ollama.create_is_creating = true;
			frontend.ollama.pulling_models.add(input.model);
		},
		receive_response: async ({data: {input}}) => {
			console.log('[frontend_action_handlers] received ollama_create response:', input);
			frontend.ollama.pulling_models.delete(input.model);
			frontend.ollama.create_model_name = '';
			frontend.ollama.create_from_model = '';
			frontend.ollama.create_system_prompt = '';
			frontend.ollama.create_template = '';
			frontend.ollama.create_is_creating = false;
			await frontend.ollama.refresh();
		},
		receive_error: ({data: {input, error}}) => {
			console.error('[frontend_action_handlers] ollama_create failed:', error);
			frontend.ollama.pulling_models.delete(input.model);
			frontend.ollama.create_is_creating = false;
		},
	},

	ollama_unload: {
		send_request: ({data: {input}}) => {
			console.log('[frontend_action_handlers] sending ollama_unload request:', input);
		},
		receive_response: ({data: {input}}) => {
			console.log('[frontend_action_handlers] received ollama_unload response:', input);
		},
		receive_error: ({data: {input, error}}) => {
			console.error('[frontend_action_handlers] ollama_unload failed:', input, error);
		},
	},

	ollama_progress: {
		receive: ({data: {input}}) => {
			// console.log('[frontend_action_handlers] received ollama_progress notification:', input);

			const {_meta, ...progress} = input;
			if (!_meta) {
				console.error('[frontend_action_handlers] ollama_progress missing _meta');
				return;
			}

			// TODO this is hacky, rethink in combination with some other things including the backend,
			// also notice we have a different progress pattern for other actions because the data received is different,
			// but there's probably a cleaner/simpler design

			const progress_token = _meta.progressToken;
			if (!progress_token) {
				console.error('[frontend_action_handlers] ollama_progress missing progress_token');
				return;
			}

			// TODO refactor
			const action = frontend.actions.items.values.find(
				(a) => (a.action_event_data?.input as any)?._meta?.progressToken === progress_token,
			);
			if (!action) {
				console.error(
					'[frontend_action_handlers] ollama_progress cannot find action for progress_token:',
					progress_token,
				);
				return;
			}
			if (!action.action_event) {
				console.error(
					'[frontend_action_handlers] action does not have action_event reference',
					action,
				);
				return;
			}

			action.action_event.update_progress(progress);
		},
	},

	provider_load_status: {
		receive_response: ({data: {output}}) => {
			frontend.update_provider_status(output.status);
		},
	},

	provider_update_api_key: {
		receive_response: ({data: {output}}) => {
			frontend.update_provider_status(output.status);
		},
	},

	terminal_create: {
		receive_response: ({data: {output}}) => {
			console.log('[frontend_action_handlers] terminal created:', output.terminal_id);
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] terminal_create failed:', error);
		},
	},

	terminal_data_send: {},

	terminal_data: {
		receive: ({data: {input}}) => {
			frontend.terminal_writers.get(input.terminal_id)?.(input.data);
		},
	},

	terminal_resize: {},

	terminal_close: {
		receive_response: ({data: {output}}) => {
			console.log('[frontend_action_handlers] terminal closed, exit_code:', output.exit_code);
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] terminal_close failed:', error);
		},
	},

	terminal_exited: {
		receive: ({data: {input}}) => {
			console.log(
				'[frontend_action_handlers] terminal exited:',
				input.terminal_id,
				'exit_code:',
				input.exit_code,
			);
			frontend.terminal_exit_handlers.get(input.terminal_id)?.(input.exit_code);
		},
	},

	workspace_open: {
		receive_response: ({data: {output}}) => {
			frontend.workspaces.add(output.workspace);
			// populate diskfiles from initial file tree
			for (const disknode of output.files) {
				frontend.diskfiles.handle_change({
					change: {type: 'add', path: disknode.id},
					disknode,
				});
			}
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] workspace_open failed:', error);
		},
	},

	workspace_close: {
		receive_response: ({data: {input}}) => {
			const workspace = frontend.workspaces.get_by_path(input.path);
			if (workspace) {
				frontend.workspaces.remove(workspace.id);
			}
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] workspace_close failed:', error);
		},
	},

	workspace_list: {
		receive_response: ({data: {output}}) => {
			for (const workspace_data of output.workspaces) {
				frontend.workspaces.add(workspace_data);
			}
		},
		receive_error: ({data: {error}}) => {
			console.error('[frontend_action_handlers] workspace_list failed:', error);
		},
	},

	workspace_changed: {
		receive: ({data: {input}}) => {
			if (input.type === 'open') {
				frontend.workspaces.add(input.workspace);
			} else {
				const workspace = frontend.workspaces.get_by_path(input.workspace.path);
				if (workspace) {
					frontend.workspaces.remove(workspace.id);
				}
			}
		},
	},
});
