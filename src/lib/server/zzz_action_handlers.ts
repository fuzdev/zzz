/**
 * Unified action handler factory for zzz.
 *
 * `create_zzz_action_handlers(backend)` is the single source of truth for
 * all 23 request_response handlers. Both HTTP RPC and WebSocket dispatch
 * call into the same map. The `Backend` is closed over at construction
 * time — handlers receive fuz_app's unified `ActionContext` (auth, db,
 * request_id, notify, signal) without any context extension.
 *
 * @module
 */

import {ThrownJsonrpcError} from '@fuzdev/fuz_app/http/jsonrpc_errors.js';
import {update_env_variable} from '@fuzdev/fuz_app/env/update_env_variable.js';
import type {ActionHandler} from '@fuzdev/fuz_app/actions/action_rpc.js';
import {create_uuid} from '@fuzdev/fuz_util/id.js';

import type {Backend} from './backend.js';
import type {CompletionOptions, CompletionHandlerOptions} from './backend_provider.js';
import {save_completion_response_to_disk} from './helpers.js';
import {ENV_FILE} from './constants.js';
import {to_serializable_disknode} from '../diskfile_helpers.js';
import {SerializableDisknode} from '../diskfile_types.js';
import {jsonrpc_errors} from '../zzz_jsonrpc_errors.js';
import type {ActionOutputs} from '../action_collections.js';
import type {BackendRequestResponseMethod} from '../action_metatypes.js';
import type {BackendActionHandlers} from './backend_action_types.js';

/**
 * Look up a handler in the typed map by method name.
 *
 * Centralizes the unavoidable string-key → typed-handler cast that both
 * transports (`zzz_rpc_actions.ts`, `register_websocket_actions.ts`) need.
 * Returns `undefined` for methods the factory doesn't produce — e.g.,
 * fuz_app's `cancel` (handler lives in `protocol_actions`) or
 * notification specs (no request_response handler).
 */
export const get_action_handler = (
	handlers: BackendActionHandlers,
	method: string,
): ActionHandler | undefined =>
	method in handlers
		? (handlers[method as BackendRequestResponseMethod] as ActionHandler)
		: undefined;

/**
 * Build the 23 request_response handlers bound to a zzz `Backend`.
 *
 * Logic sourced from the RPC versions (cleaner than the old WS handlers —
 * no Deno-only bug in provider_update_api_key, no console.log noise).
 */
export const create_zzz_action_handlers = (backend: Backend): BackendActionHandlers => ({
	ping: (_input, ctx) => ({
		ping_id: ctx.request_id,
	}),

	session_load: async () => {
		await backend.workspaces_ready();

		const files_array: Array<SerializableDisknode> = [];
		for (const [dir, filer_instance] of backend.filers.entries()) {
			for (const file of filer_instance.filer.files.values()) {
				files_array.push(to_serializable_disknode(file, dir));
			}
		}

		const provider_status = await Promise.all(backend.providers.map((p) => p.load_status()));

		return {
			data: {
				files: files_array,
				zzz_dir: backend.zzz_dir,
				scoped_dirs: backend.scoped_dirs,
				provider_status,
				workspaces: backend.workspace_list(),
			},
		};
	},

	diskfile_update: async (input) => {
		const {path, content} = input;
		try {
			await backend.scoped_fs.write_file(path, content);
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to write file: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	diskfile_delete: async (input) => {
		const {path} = input;
		try {
			await backend.scoped_fs.rm(path);
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to delete file: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	directory_create: async (input) => {
		const {path} = input;
		try {
			await backend.scoped_fs.mkdir(path, {recursive: true});
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to create directory: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	completion_create: async (input, ctx) => {
		const {prompt, provider_name, model, completion_messages} = input.completion_request;
		const progress_token = input._meta?.progressToken;

		const {
			frequency_penalty,
			output_token_max,
			presence_penalty,
			seed,
			stop_sequences,
			system_message,
			temperature,
			top_k,
			top_p,
		} = backend.config;

		const completion_options: CompletionOptions = {
			frequency_penalty,
			output_token_max,
			presence_penalty,
			seed,
			stop_sequences,
			system_message,
			temperature,
			top_k,
			top_p,
		};

		const handler_options: CompletionHandlerOptions = {
			model,
			completion_options,
			completion_messages,
			prompt,
			progress_token,
			// Route streaming chunks to the originator (socket-scoped on WS,
			// no-op on HTTP). The provider falls back to its constructor-level
			// broadcast callback when `on_progress` is undefined.
			on_progress: (progress_input) => {
				ctx.notify('completion_progress', progress_input);
				return Promise.resolve();
			},
			signal: ctx.signal,
		};

		const provider = backend.lookup_provider(provider_name);
		const handler = provider.get_handler(!!progress_token);

		let result: ActionOutputs['completion_create'];
		try {
			result = await handler(handler_options);
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			// Cancellation is not a provider failure — translate to the wire code
			// so telemetry and any late-arriving response match the intent.
			// Check `ctx.signal.aborted` rather than error shape: each SDK throws
			// a different abort type (APIUserAbortError on Anthropic/OpenAI,
			// DOMException on fetch), but the signal is authoritative.
			if (ctx.signal.aborted) {
				throw jsonrpc_errors.request_cancelled(`completion_create cancelled (${provider_name})`);
			}
			const error_message = error instanceof Error ? error.message : 'AI provider error';
			throw jsonrpc_errors.ai_provider_error(provider_name, error_message);
		}

		void save_completion_response_to_disk(input, result, backend.zzz_dir, backend.scoped_fs);

		return result;
	},

	provider_load_status: async (input) => {
		const {provider_name, reload} = input;
		const provider = backend.lookup_provider(provider_name);
		const status = await provider.load_status(reload);
		return {status};
	},

	provider_update_api_key: async (input) => {
		// `acting` is required on the input schema (keeper bucket invariant) but is
		// resolved by fuz_app's authorization phase before this handler runs.
		const {provider_name, api_key} = input;

		const env_var_map: Record<string, string> = {
			claude: 'SECRET_ANTHROPIC_API_KEY',
			chatgpt: 'SECRET_OPENAI_API_KEY',
			gemini: 'SECRET_GOOGLE_API_KEY',
		};

		const env_var_name = env_var_map[provider_name];
		if (!env_var_name) {
			throw jsonrpc_errors.invalid_params(`Unknown provider: ${provider_name}`);
		}

		try {
			await update_env_variable(env_var_name, api_key, {env_file_path: ENV_FILE});

			const provider = backend.lookup_provider(provider_name);
			provider.set_api_key(api_key);
			const status = await provider.load_status(true);
			return {status};
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error(
				`Failed to update API key: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	terminal_create: (input) => {
		const terminal_id = create_uuid();
		try {
			backend.pty_manager.spawn(terminal_id, input.command, input.args, input.cwd);
			return {terminal_id};
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to create terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	terminal_data_send: async (input) => {
		if (!backend.pty_manager.has(input.terminal_id)) return null;
		try {
			await backend.pty_manager.write(input.terminal_id, input.data);
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to send data to terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	terminal_resize: (input) => {
		if (!backend.pty_manager.has(input.terminal_id)) return null;
		try {
			backend.pty_manager.resize(input.terminal_id, input.cols, input.rows);
		} catch {
			// resize failures are non-fatal
		}
		return null;
	},

	terminal_close: async (input) => {
		if (!backend.pty_manager.has(input.terminal_id)) return {exit_code: null};
		try {
			const exit_code = await backend.pty_manager.kill(input.terminal_id, input.signal);
			return {exit_code};
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to close terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	workspace_open: async (input) => {
		try {
			return await backend.workspace_open(input.path);
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to open workspace: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	workspace_close: async (input) => {
		try {
			const closed = await backend.workspace_close(input.path);
			if (!closed) throw jsonrpc_errors.invalid_params(`workspace not open: ${input.path}`);
			return null;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error(
				`failed to close workspace: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	workspace_list: () => ({
		workspaces: backend.workspace_list(),
	}),
});
