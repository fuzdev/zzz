import { JSONRPC_ERROR_CODES, ThrownJsonrpcError } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import type { Frontend } from './frontend.svelte.ts';
import type { FrontendActionHandlers } from './frontend_action_types.ts';
import { Turn } from './turn.svelte.ts';
import { to_completion_response_text } from './response_helpers.ts';
import { ERROR_DISK_CHANGED } from './diskfile_helpers.ts';
import { ERROR_PROJECT_NOT_OPEN, ERROR_REPO_NOT_FOCUSED } from './project_helpers.ts';
import { goto_unless_current, to_view_url } from './nav.ts';

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
		// `Frontend.load_session` applies the snapshot and retries failures
		receive_response: ({ data: { output } }) => {
			// counts only — the full snapshot (every indexed file) would be
			// retained by devtools on every load
			const { files, projects, terminal_ids } = output.data;
			console.log('[frontend_action_handlers] session loaded:', {
				files: files.length,
				projects: projects.length,
				terminals: terminal_ids.length
			});
		},
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] session load failed:', error);
		}
	},

	completion_create: {
		receive_response: ({ data: { input, output } }) => {
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
							'[frontend_action_handlers] unknown cell type for completion progress_token:',
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
		receive_error: ({ data: { input, error } }) => {
			// a save based on content the file no longer holds — routine, and the
			// editor follows it (`DiskfileEditorState.save_changes`)
			const { reason } = (error.data ?? {}) as { reason?: unknown };
			if (reason === ERROR_DISK_CHANGED) {
				console.debug('[frontend_action_handlers] update file refused, disk changed:', input.path);
				return;
			}
			console.error('[frontend_action_handlers] update file failed:', input.path, error);
		}
	},

	diskfile_create: {
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] create file failed:', input.path, error);
		}
	},

	diskfile_delete: {
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] delete file failed:', input.path, error);
		}
	},

	directory_create: {
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] create directory failed:', input.path, error);
		}
	},

	media_finalize: {
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] finalize media failed:', input.path, error);
		}
	},

	transcription_create: {
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] transcribe failed:', input.path, error);
		}
	},

	transcription_progress: {
		receive: ({ data: { input } }) => {
			frontend.jobs.receive_transcription_progress(input.job_id, input.segments);
		}
	},

	job_cancel: {
		receive_error: ({ data: { input, error } }) => {
			console.error('[frontend_action_handlers] cancel job failed:', input.job_id, error);
		}
	},

	job_changed: {
		receive: ({ data: { input } }) => {
			frontend.jobs.receive_changed(input.job);
		}
	},

	filer_change: {
		receive: ({ data: { input } }) => {
			frontend.diskfiles.handle_change(input);
		}
	},

	completion_progress: {
		receive: ({ data: { input } }) => {
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
				turn.cancel_completion();
			}
		}
	},

	main_menu_toggle: {
		execute: ({ data: { input } }) => {
			return { show: frontend.ui.toggle_main_menu(input?.show) };
		}
	},

	palette_toggle: {
		execute: ({ data: { input } }) => ({ show: frontend.ui.toggle_palette(input?.show) })
	},

	sidebar_toggle: {
		execute: ({ data: { input } }) => ({ show: frontend.ui.toggle_sidebar(input?.show) })
	},

	desk_toggle: {
		execute: ({ data: { input } }) => ({ show: frontend.ui.toggle_desk_menu(input?.show) })
	},

	desk_pin_toggle: {
		execute: ({ data: { input } }) => ({ pinned: frontend.ui.toggle_desk_pinned(input?.pinned) })
	},

	tab_open: {
		execute: ({ data: { input } }) => {
			frontend.diskfiles.open_in_tab(input.path, {
				permanent: input.permanent,
				fragment: input.fragment
			});
		}
	},

	tab_select: {
		execute: ({ data: { input } }) => {
			const { diskfiles } = frontend;
			if (!diskfiles.editor.tabs.by_path.has(input.path)) return { found: false };
			// a file with a tab selects that tab, a preview staying a preview
			diskfiles.select(input.path);
			return { found: true };
		}
	},

	tab_pin: {
		execute: ({ data: { input } }) => {
			const { editor } = frontend.diskfiles;
			const tab = editor.tabs.by_path.get(input.path);
			if (!tab) return { found: false };
			editor.open_tab(tab.id);
			return { found: true };
		}
	},

	tab_close: {
		execute: ({ data: { input } }) => {
			const { editor } = frontend.diskfiles;
			const tab = editor.tabs.by_path.get(input.path);
			if (!tab) return { result: 'no_tab' };
			return { result: editor.request_close_tab(tab.id) ? 'closed' : 'asking' };
		}
	},

	tab_move: {
		execute: ({ data: { input } }) => ({
			moved: frontend.diskfiles.editor.tabs.move_tab(input.path, input.before_path)
		})
	},

	tab_reopen_closed: {
		execute: () => ({ path: frontend.diskfiles.editor.reopen_last_closed_tab() })
	},

	tab_back: {
		execute: () => ({ path: frontend.diskfiles.editor.navigate('back') })
	},

	tab_forward: {
		execute: () => ({ path: frontend.diskfiles.editor.navigate('forward') })
	},

	explorer_mode_set: {
		execute: ({ data: { input } }) => {
			frontend.diskfiles.editor.set_explorer_mode(input.mode);
		}
	},

	file_reveal: {
		execute: ({ data: { input } }) => ({
			revealed: frontend.diskfiles.editor.reveal_in_tree(input.path)
		})
	},

	markdown_mode_set: {
		execute: ({ data: { input } }) => ({
			markdown: frontend.diskfiles.set_markdown_view_mode(input.path, input.mode)
		})
	},

	path_open: {
		execute: async ({ data: { input } }) => {
			const result = await frontend.projects.open_path(input.path);
			if (!result.ok) {
				const { code, message, data } = result.error;
				throw new ThrownJsonrpcError(code, message, data);
			}
			return result.value;
		}
	},

	file_rename: {
		execute: async ({ data: { input } }) => {
			const result = await frontend.diskfiles.rename(input.path, input.name);
			if (!result.ok) {
				const { code, message, data } = result.error;
				throw new ThrownJsonrpcError(code, message, data);
			}
			return result.value;
		}
	},

	project_activate: {
		execute: ({ data: { input } }) => ({ found: frontend.projects.activate_root(input.root) })
	},

	view_show: {
		execute: ({ data: { input } }) => {
			void goto_unless_current(to_view_url(input.view, input.id));
		}
	},

	tab_close_resolve: {
		execute: async ({ data: { input } }) => {
			const outcome = await frontend.diskfiles.editor.resolve_close(input.path, input.choice);
			if (!outcome.ok) {
				throw outcome.conflict
					? new ThrownJsonrpcError(JSONRPC_ERROR_CODES.conflict, outcome.message, {
							reason: ERROR_DISK_CHANGED
						})
					: new ThrownJsonrpcError(JSONRPC_ERROR_CODES.internal_error, outcome.message);
			}
			return { result: outcome.result };
		}
	},

	diskfile_details_toggle: {
		execute: ({ data: { input } }) => ({
			show: frontend.ui.toggle_diskfile_details(input?.show)
		})
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
			frontend.terminals.receive_output(input.terminal_id, input.data, input.sent_bytes);
		}
	},

	terminal_ack: {},

	terminal_resize: {},

	terminal_close: {
		receive_error: ({ data: { error } }) => {
			// `not_found`: the process already ended — nothing left to close
			if (error.code === JSONRPC_ERROR_CODES.not_found) return;
			console.error('[frontend_action_handlers] terminal_close failed:', error);
		}
	},

	terminal_exited: {
		receive: ({ data: { input } }) => {
			frontend.terminals.receive_exited(input.terminal_id, input.exit_code);
		}
	},

	// `Projects.open` adds the project and its files
	project_open: {
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] project_open failed:', error);
		}
	},

	// `Frontend.close_project` applies the close at its rev
	project_close: {
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] project_close failed:', error);
		}
	},

	project_list: {
		receive_response: ({ data: { output } }) => {
			for (const project_data of output.projects) {
				frontend.projects.receive_remote_change(project_data);
			}
		},
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] project_list failed:', error);
		}
	},

	// `Projects.focus_repo` adds the project and the repo's files
	repo_focus: {
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] repo_focus failed:', error);
		}
	},

	// `Projects` pulls a repo another client focused and reconciles its files
	repo_files: {
		receive_error: ({ data: { error } }) => {
			// the focus or the project went meanwhile, which its own
			// `project_changed` settles
			const { reason } = (error.data ?? {}) as { reason?: unknown };
			if (reason === ERROR_REPO_NOT_FOCUSED || reason === ERROR_PROJECT_NOT_OPEN) return;
			console.error('[frontend_action_handlers] repo_files failed:', error);
		}
	},

	// `Projects.unfocus_repo` updates the project and releases the repo's files
	repo_unfocus: {
		receive_error: ({ data: { error } }) => {
			console.error('[frontend_action_handlers] repo_unfocus failed:', error);
		}
	},

	project_changed: {
		receive: ({ data: { input } }) => {
			if (input.type === 'close') {
				frontend.receive_project_closed(input.project.root, input.project.rev);
			} else {
				frontend.projects.receive_remote_change(input.project);
			}
		}
	}
});
