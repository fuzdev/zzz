/**
 * Unified action handlers for zzz.
 *
 * Single source of truth for all 23 request_response handlers.
 * Both HTTP RPC and WebSocket dispatch call these same functions.
 * Handler signature mirrors Rust's `fn(params, ctx) -> Result<Value>`.
 *
 * @module
 */

import {ThrownJsonrpcError} from '@fuzdev/fuz_app/http/jsonrpc_errors.js';
import {update_env_variable} from '@fuzdev/fuz_app/env/update_env_variable.js';

import type {Backend} from './backend.js';
import type {CompletionOptions, CompletionHandlerOptions} from './backend_provider.js';
import {save_completion_response_to_disk} from './helpers.js';
import {API_KEY_ENV_FILE_PATH} from './api_key_env_file_path.js';
import {create_uuid} from '../zod_helpers.js';
import {to_serializable_disknode} from '../diskfile_helpers.js';
import {SerializableDisknode} from '../diskfile_types.js';
import {jsonrpc_errors} from '../zzz_jsonrpc_errors.js';
import type {OllamaListResponse, OllamaPsResponse, OllamaShowResponse} from '../ollama_helpers.js';
import type {ActionInputs, ActionOutputs} from '../action_collections.js';
import type {BackendActionMethod} from '../action_metatypes.js';

/**
 * Per-request context passed to every handler.
 * Mirrors Rust's `HandlerContext` — transport constructs it, handler borrows it.
 */
export interface ZzzHandlerContext {
	backend: Backend;
	/** From the JSON-RPC envelope. */
	request_id: string | number | null;
	/**
	 * Send a request-scoped JSON-RPC notification to the originator.
	 * WS routes to the originating socket; HTTP no-ops with a DEV warn.
	 */
	notify: (method: string, params: unknown) => void;
	/** Fires on request cancellation (HTTP disconnect or WS close). */
	signal: AbortSignal;
}

/** Methods handled by zzz_action_handlers (request_response only, excludes remote_notifications). */
export type ZzzHandledMethod = Exclude<
	BackendActionMethod,
	| 'filer_change'
	| 'completion_progress'
	| 'ollama_progress'
	| 'terminal_data'
	| 'terminal_exited'
	| 'workspace_changed'
	| '_test_notification'
>;

/** Typed handler map — each handler has per-method input/output types. */
export type ZzzActionHandlers = {
	[K in ZzzHandledMethod]: (
		input: ActionInputs[K],
		ctx: ZzzHandlerContext,
	) => ActionOutputs[K] | Promise<ActionOutputs[K]>;
};

/**
 * All 23 request_response handlers as pure functions.
 *
 * Logic sourced from the RPC versions (cleaner than the old WS handlers —
 * no Deno-only bug in provider_update_api_key, no console.log noise).
 */
export const zzz_action_handlers: ZzzActionHandlers = {
	ping: (_input, ctx) => ({
		ping_id: ctx.request_id!, // request_response actions always have an id
	}),

	session_load: async (_input, ctx) => {
		const {backend} = ctx;
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

	diskfile_update: async (input, ctx) => {
		const {path, content} = input;
		try {
			await ctx.backend.scoped_fs.write_file(path, content);
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to write file: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	diskfile_delete: async (input, ctx) => {
		const {path} = input;
		try {
			await ctx.backend.scoped_fs.rm(path);
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to delete file: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	directory_create: async (input, ctx) => {
		const {path} = input;
		try {
			await ctx.backend.scoped_fs.mkdir(path, {recursive: true});
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to create directory: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	completion_create: async (input, ctx) => {
		const {backend} = ctx;
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
	},

	ollama_list: async (_input, ctx) => {
		try {
			return (await ctx.backend
				.lookup_provider('ollama')
				.get_client()
				.list()) as unknown as OllamaListResponse;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error('failed to list models');
		}
	},

	ollama_ps: async (_input, ctx) => {
		try {
			return (await ctx.backend
				.lookup_provider('ollama')
				.get_client()
				.ps()) as unknown as OllamaPsResponse;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error('failed to get running models');
		}
	},

	ollama_show: async (input, ctx) => {
		try {
			return (await ctx.backend
				.lookup_provider('ollama')
				.get_client()
				.show(input)) as unknown as OllamaShowResponse;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error('failed to show model');
		}
	},

	ollama_pull: async (input, ctx) => {
		const {_meta, ...params} = input;
		try {
			const response = await ctx.backend
				.lookup_provider('ollama')
				.get_client()
				.pull({...params, stream: true});

			for await (const progress of response) {
				if (ctx.signal.aborted) break;
				ctx.notify('ollama_progress', {
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
	},

	ollama_delete: async (input, ctx) => {
		try {
			await ctx.backend.lookup_provider('ollama').get_client().delete(input);
			return undefined;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error('failed to delete model');
		}
	},

	ollama_copy: async (input, ctx) => {
		try {
			await ctx.backend.lookup_provider('ollama').get_client().copy(input);
			return undefined;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error('failed to copy model');
		}
	},

	ollama_create: async (input, ctx) => {
		const {_meta, ...params} = input;
		try {
			const response = await ctx.backend
				.lookup_provider('ollama')
				.get_client()
				.create({...params, stream: true});

			for await (const progress of response) {
				if (ctx.signal.aborted) break;
				ctx.notify('ollama_progress', {
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
	},

	ollama_unload: async (input, ctx) => {
		try {
			await ctx.backend
				.lookup_provider('ollama')
				.get_client()
				.generate({model: input.model, prompt: '', keep_alive: 0});
			return undefined;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error('failed to unload model');
		}
	},

	provider_load_status: async (input, ctx) => {
		const {provider_name, reload} = input;
		const provider = ctx.backend.lookup_provider(provider_name);
		const status = await provider.load_status(reload);
		return {status};
	},

	provider_update_api_key: async (input, ctx) => {
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
			await update_env_variable(env_var_name, api_key, {
				env_file_path: API_KEY_ENV_FILE_PATH,
			});
			// Update runtime env (handles both Deno and Node)
			if (typeof globalThis.Deno !== 'undefined') {
				globalThis.Deno.env.set(env_var_name, api_key);
			} else if (typeof process !== 'undefined') {
				process.env[env_var_name] = api_key;
			}

			const provider = ctx.backend.lookup_provider(provider_name);
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

	terminal_create: (input, ctx) => {
		const terminal_id = create_uuid();
		try {
			ctx.backend.pty_manager.spawn(terminal_id, input.command, input.args, input.cwd);
			return {terminal_id};
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to create terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	terminal_data_send: async (input, ctx) => {
		if (!ctx.backend.pty_manager.has(input.terminal_id)) return null;
		try {
			await ctx.backend.pty_manager.write(input.terminal_id, input.data);
			return null;
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to send data to terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	terminal_resize: (input, ctx) => {
		if (!ctx.backend.pty_manager.has(input.terminal_id)) return null;
		try {
			ctx.backend.pty_manager.resize(input.terminal_id, input.cols, input.rows);
		} catch {
			// resize failures are non-fatal
		}
		return null;
	},

	terminal_close: async (input, ctx) => {
		if (!ctx.backend.pty_manager.has(input.terminal_id)) return {exit_code: null};
		try {
			const exit_code = await ctx.backend.pty_manager.kill(input.terminal_id, input.signal);
			return {exit_code};
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to close terminal: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	workspace_open: async (input, ctx) => {
		try {
			return await ctx.backend.workspace_open(input.path);
		} catch (error) {
			throw jsonrpc_errors.internal_error(
				`failed to open workspace: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	workspace_close: async (input, ctx) => {
		try {
			const closed = await ctx.backend.workspace_close(input.path);
			if (!closed) throw jsonrpc_errors.invalid_params(`workspace not open: ${input.path}`);
			return null;
		} catch (error) {
			if (error instanceof ThrownJsonrpcError) throw error;
			throw jsonrpc_errors.internal_error(
				`failed to close workspace: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	},

	workspace_list: (_input, ctx) => ({
		workspaces: ctx.backend.workspace_list(),
	}),

	_test_emit_notifications: (input, ctx) => {
		for (let i = 0; i < input.count; i++) {
			ctx.notify('_test_notification', {index: i});
		}
		return {count: input.count};
	},
};
