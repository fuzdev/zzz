/**
 * RPC actions for zzz — bridges backend domain logic to fuz_app's RPC endpoint.
 *
 * Each `RpcAction` combines an action spec with a handler that calls
 * the Backend's domain logic directly. The fuz_app RPC dispatcher handles
 * envelope parsing, auth checking, and input validation — handlers only
 * implement the business logic.
 *
 * @module
 */

import type {RpcAction, ActionHandler} from '@fuzdev/fuz_app/actions/action_rpc.js';
import type {RequestResponseActionSpec} from '@fuzdev/fuz_app/actions/action_spec.js';

import type {Backend} from './backend.js';
import type {CompletionOptions, CompletionHandlerOptions} from './backend_provider.js';
import {save_completion_response_to_disk} from './helpers.js';
import {update_env_variable} from './env_file_helpers.js';
import {create_uuid} from '../zod_helpers.js';
import {to_serializable_disknode} from '../diskfile_helpers.js';
import {SerializableDisknode} from '../diskfile_types.js';
import {jsonrpc_errors, ThrownJsonrpcError} from '../jsonrpc_errors.js';
import type {OllamaListResponse, OllamaPsResponse, OllamaShowResponse} from '../ollama_helpers.js';
import type {ActionOutputs} from '../action_collections.js';
import {
	ping_action_spec,
	session_load_action_spec,
	diskfile_update_action_spec,
	diskfile_delete_action_spec,
	directory_create_action_spec,
	completion_create_action_spec,
	ollama_list_action_spec,
	ollama_ps_action_spec,
	ollama_show_action_spec,
	ollama_pull_action_spec,
	ollama_delete_action_spec,
	ollama_copy_action_spec,
	ollama_create_action_spec,
	ollama_unload_action_spec,
	provider_load_status_action_spec,
	provider_update_api_key_action_spec,
	terminal_create_action_spec,
	terminal_data_send_action_spec,
	terminal_resize_action_spec,
	terminal_close_action_spec,
	workspace_open_action_spec,
	workspace_close_action_spec,
	workspace_list_action_spec,
} from '../action_specs.js';

/** Dependencies for creating zzz RPC actions. */
export interface ZzzRpcDeps {
	backend: Backend;
}

/**
 * Create all zzz RPC actions.
 *
 * Returns `RpcAction[]` for `create_rpc_endpoint`.
 * Each handler captures the Backend instance via closure and calls
 * the domain logic directly (no double-dispatch through `backend.receive()`).
 */
export const create_zzz_rpc_actions = (deps: ZzzRpcDeps): Array<RpcAction> => {
	const {backend} = deps;

	return [
		{
			spec: ping_action_spec as RequestResponseActionSpec,
			handler: ((_input, ctx) => ({
				ping_id: ctx.request_id,
			})) satisfies ActionHandler,
		},
		{
			spec: session_load_action_spec as RequestResponseActionSpec,
			handler: (async () => {
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
			}) satisfies ActionHandler,
		},
		{
			spec: diskfile_update_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				const {path, content} = input;
				try {
					await backend.scoped_fs.write_file(path, content);
					return null;
				} catch (error) {
					throw jsonrpc_errors.internal_error(
						`failed to write file: ${error instanceof Error ? error.message : 'unknown error'}`,
					);
				}
			}) satisfies ActionHandler,
		},
		{
			spec: diskfile_delete_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				const {path} = input;
				try {
					await backend.scoped_fs.rm(path);
					return null;
				} catch (error) {
					throw jsonrpc_errors.internal_error(
						`failed to delete file: ${error instanceof Error ? error.message : 'unknown error'}`,
					);
				}
			}) satisfies ActionHandler,
		},
		{
			spec: directory_create_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				const {path} = input;
				try {
					await backend.scoped_fs.mkdir(path, {recursive: true});
					return null;
				} catch (error) {
					throw jsonrpc_errors.internal_error(
						`failed to create directory: ${error instanceof Error ? error.message : 'unknown error'}`,
					);
				}
			}) satisfies ActionHandler,
		},
		{
			spec: completion_create_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
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
				};

				const provider = backend.lookup_provider(provider_name);
				const handler = provider.get_handler(!!progress_token);

				let result: ActionOutputs['completion_create'];
				try {
					result = await handler(handler_options);
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					const error_message = error instanceof Error ? error.message : 'AI provider error';
					throw jsonrpc_errors.ai_provider_error(provider_name, error_message);
				}

				void save_completion_response_to_disk(input, result, backend.zzz_dir, backend.scoped_fs);

				return result;
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_list_action_spec as RequestResponseActionSpec,
			handler: (async () => {
				try {
					return (await backend
						.lookup_provider('ollama')
						.get_client()
						.list()) as unknown as OllamaListResponse;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to list models');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_ps_action_spec as RequestResponseActionSpec,
			handler: (async () => {
				try {
					return (await backend
						.lookup_provider('ollama')
						.get_client()
						.ps()) as unknown as OllamaPsResponse;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to get running models');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_show_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				try {
					return (await backend
						.lookup_provider('ollama')
						.get_client()
						.show(input)) as unknown as OllamaShowResponse;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to show model');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_pull_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				const {_meta, ...params} = input;
				try {
					const response = await backend
						.lookup_provider('ollama')
						.get_client()
						.pull({...params, stream: true});

					for await (const progress of response) {
						await backend.api.ollama_progress({
							status: progress.status,
							digest: progress.digest,
							total: progress.total,
							completed: progress.completed,
							_meta: {progressToken: _meta?.progressToken},
						});
					}

					return undefined;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to pull model');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_delete_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				try {
					await backend.lookup_provider('ollama').get_client().delete(input);
					return undefined;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to delete model');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_copy_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				try {
					await backend.lookup_provider('ollama').get_client().copy(input);
					return undefined;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to copy model');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_create_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				const {_meta, ...params} = input;
				try {
					const response = await backend
						.lookup_provider('ollama')
						.get_client()
						.create({...params, stream: true});

					for await (const progress of response) {
						await backend.api.ollama_progress({
							status: progress.status,
							digest: progress.digest,
							total: progress.total,
							completed: progress.completed,
							_meta: {progressToken: _meta?.progressToken},
						});
					}

					return undefined;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to create model');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: ollama_unload_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				try {
					await backend
						.lookup_provider('ollama')
						.get_client()
						.generate({model: input.model, prompt: '', keep_alive: 0});
					return undefined;
				} catch (error) {
					if (error instanceof ThrownJsonrpcError) throw error;
					throw jsonrpc_errors.internal_error('failed to unload model');
				}
			}) satisfies ActionHandler,
		},
		{
			spec: provider_load_status_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				const {provider_name, reload} = input;
				const provider = backend.lookup_provider(provider_name);
				const status = await provider.load_status(reload);
				return {status};
			}) satisfies ActionHandler,
		},
		{
			spec: provider_update_api_key_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				const {provider_name, api_key} = input;

				if (provider_name === 'ollama') {
					throw jsonrpc_errors.invalid_params('Ollama does not require an API key');
				}

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
					await update_env_variable(env_var_name, api_key);
					// Update runtime env (Deno-specific, safe to call even in Node)
					if (typeof globalThis.Deno !== 'undefined') {
						globalThis.Deno.env.set(env_var_name, api_key);
					} else if (typeof process !== 'undefined') {
						process.env[env_var_name] = api_key;
					}

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
			}) satisfies ActionHandler,
		},
		{
			spec: terminal_create_action_spec as RequestResponseActionSpec,
			handler: ((input) => {
				const terminal_id = create_uuid();
				try {
					backend.pty_manager.spawn(terminal_id, input.command, input.args, input.cwd);
					return {terminal_id};
				} catch (error) {
					throw jsonrpc_errors.internal_error(
						`failed to create terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
					);
				}
			}) satisfies ActionHandler,
		},
		{
			spec: terminal_data_send_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				if (!backend.pty_manager.has(input.terminal_id)) return null;
				try {
					await backend.pty_manager.write(input.terminal_id, input.data);
					return null;
				} catch (error) {
					throw jsonrpc_errors.internal_error(
						`failed to send data to terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
					);
				}
			}) satisfies ActionHandler,
		},
		{
			spec: terminal_resize_action_spec as RequestResponseActionSpec,
			handler: ((input) => {
				if (!backend.pty_manager.has(input.terminal_id)) return null;
				try {
					backend.pty_manager.resize(input.terminal_id, input.cols, input.rows);
				} catch {
					// resize failures are non-fatal
				}
				return null;
			}) satisfies ActionHandler,
		},
		{
			spec: terminal_close_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				if (!backend.pty_manager.has(input.terminal_id)) return {exit_code: null};
				try {
					const exit_code = await backend.pty_manager.kill(input.terminal_id, input.signal);
					return {exit_code};
				} catch (error) {
					throw jsonrpc_errors.internal_error(
						`failed to close terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
					);
				}
			}) satisfies ActionHandler,
		},
		{
			spec: workspace_open_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
				try {
					return await backend.workspace_open(input.path);
				} catch (error) {
					throw jsonrpc_errors.internal_error(
						`failed to open workspace: ${error instanceof Error ? error.message : 'unknown error'}`,
					);
				}
			}) satisfies ActionHandler,
		},
		{
			spec: workspace_close_action_spec as RequestResponseActionSpec,
			handler: (async (input) => {
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
			}) satisfies ActionHandler,
		},
		{
			spec: workspace_list_action_spec as RequestResponseActionSpec,
			handler: (() => ({
				workspaces: backend.workspace_list(),
			})) satisfies ActionHandler,
		},
	];
};
