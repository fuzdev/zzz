// @slop Claude Opus 4

import {z} from 'zod';

import {
	DiskfileChange,
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
} from './diskfile_types.js';
import {ProviderStatus, ProviderName} from './provider_types.js';
import {CompletionMessage, CompletionRequest, CompletionResponse} from './completion_types.js';
import type {ActionSpecUnion} from '@fuzdev/fuz_app/actions/action_spec.js';
import {WorkspaceInfoJson} from './workspace.svelte.js';
import {JsonrpcRequestId} from './jsonrpc.js';
import {
	OllamaListRequest,
	OllamaListResponse,
	OllamaPsRequest,
	OllamaPsResponse,
	OllamaShowRequest,
	OllamaShowResponse,
	OllamaPullRequest,
	OllamaDeleteRequest,
	OllamaCopyRequest,
	OllamaCreateRequest,
	OllamaProgressResponse,
} from './ollama_helpers.js';
import {Uuid} from './zod_helpers.js';

// TODO I tried using the helper `create_action_spec` but I don't see how to get proper typing,
// we want the declared specs to have their literal types but not need to include optional
// properties;

export const ping_action_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'both',
	auth: 'public',
	side_effects: null,
	input: z.void().optional(),
	output: z.strictObject({
		ping_id: JsonrpcRequestId,
	}),
	async: true,
	description: 'Health check — echoes the request ID back to the caller.',
} satisfies ActionSpecUnion;

export const session_load_action_spec = {
	method: 'session_load',
	kind: 'request_response',
	// TODO @api is this actually a good restriction to have?
	// or should the server be calling actions internally too?
	initiator: 'frontend',
	auth: 'public',
	side_effects: null,
	input: z.void().optional(),
	output: z.strictObject({
		data: z.strictObject({
			// TODO extract this schema to diskfile_types or something
			zzz_dir: DiskfileDirectoryPath,
			scoped_dirs: z.readonly(z.array(DiskfileDirectoryPath)),
			files: z.array(SerializableDisknode),
			provider_status: z.array(ProviderStatus),
			workspaces: z.array(WorkspaceInfoJson),
		}),
	}),
	async: true,
	description: 'Load initial session data including filesystem state and provider status.',
} satisfies ActionSpecUnion;

export const filer_change_action_spec = {
	method: 'filer_change',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({
		change: DiskfileChange,
		disknode: SerializableDisknode,
	}),
	output: z.void(),
	async: true,
	description: 'Notifies the frontend of a file system change detected by the watcher.',
} satisfies ActionSpecUnion;

export const diskfile_update_action_spec = {
	method: 'diskfile_update',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		path: DiskfilePath,
		content: z.string(),
	}),
	output: z.null(),
	async: true,
	description: 'Write new content to a file on disk.',
} satisfies ActionSpecUnion;

export const diskfile_delete_action_spec = {
	method: 'diskfile_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		path: DiskfilePath,
	}),
	output: z.null(),
	async: true,
	description: 'Delete a file from disk.',
} satisfies ActionSpecUnion;

export const directory_create_action_spec = {
	method: 'directory_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		path: DiskfilePath,
	}),
	output: z.null(),
	async: true,
	description: 'Create a new directory on disk.',
} satisfies ActionSpecUnion;

export const completion_create_action_spec = {
	method: 'completion_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		completion_request: CompletionRequest,
		_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
	}),
	output: z.strictObject({
		completion_response: CompletionResponse,
		_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
	}),
	async: true,
	description: 'Start an AI completion request, optionally with a progress token for streaming.',
} satisfies ActionSpecUnion;

export const completion_progress_action_spec = {
	method: 'completion_progress',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({
		// TODO improve schema
		// "gemma3:1b"
		// 		interface ChatResponse {
		//     model: string;
		//     created_at: Date;
		//     message: Message;
		//     done: boolean;
		//     done_reason: string;
		//     total_duration: number;
		//     load_duration: number;
		//     prompt_eval_count: number;
		//     prompt_eval_duration: number;
		//     eval_count: number;
		//     eval_duration: number;
		// }
		// Ollama types:
		//		 thinking?: string;
		//		 images?: Uint8Array[] | string[];
		//		 tool_calls?: ToolCall[];
		chunk: z
			.looseObject({
				model: z.string().optional(),
				created_at: z.string().optional(),
				done: z.boolean().optional(),
				message: CompletionMessage.optional(),
			})
			.optional(),
		_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
	}),
	output: z.void(),
	async: true,
	description: 'Streams a completion chunk to the frontend during a streaming AI response.',
} satisfies ActionSpecUnion;

export const ollama_progress_action_spec = {
	method: 'ollama_progress',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject(
		OllamaProgressResponse.extend({
			_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
		}).shape,
	),
	output: z.void(),
	async: true,
	description: 'Streams progress updates for an Ollama model operation (pull, create, etc.).',
} satisfies ActionSpecUnion;

// TODO this is just a placeholder for a local call
export const toggle_main_menu_action_spec = {
	method: 'toggle_main_menu',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: true,
	input: z.strictObject({show: z.boolean().optional()}).optional(),
	output: z.strictObject({show: z.boolean()}),
	async: false,
	description: 'Toggle or set the visibility of the main navigation menu.',
} satisfies ActionSpecUnion;

export const ollama_list_action_spec = {
	method: 'ollama_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: null,
	input: OllamaListRequest,
	output: z.union([OllamaListResponse, z.null()]),
	async: true,
	description: 'List all locally available Ollama models.',
} satisfies ActionSpecUnion;

export const ollama_ps_action_spec = {
	method: 'ollama_ps',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: null,
	input: OllamaPsRequest,
	output: z.union([OllamaPsResponse, z.null()]),
	async: true,
	description: 'List currently running Ollama models.',
} satisfies ActionSpecUnion;

export const ollama_show_action_spec = {
	method: 'ollama_show',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: null,
	input: OllamaShowRequest,
	output: z.union([OllamaShowResponse, z.null()]),
	async: true,
	description: 'Show detailed information about an Ollama model.',
} satisfies ActionSpecUnion;

export const ollama_pull_action_spec = {
	method: 'ollama_pull',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject(
		OllamaPullRequest.extend({
			_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
		}).shape,
	), // TODO @many is strict right here?
	output: z.void().optional(),
	async: true,
	description: 'Pull an Ollama model from the registry.',
} satisfies ActionSpecUnion;

export const ollama_delete_action_spec = {
	method: 'ollama_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: OllamaDeleteRequest,
	output: z.void().optional(),
	async: true,
	description: 'Delete an Ollama model from local storage.',
} satisfies ActionSpecUnion;

export const ollama_copy_action_spec = {
	method: 'ollama_copy',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: OllamaCopyRequest,
	output: z.void().optional(),
	async: true,
	description: 'Copy an Ollama model under a new name.',
} satisfies ActionSpecUnion;

export const ollama_create_action_spec = {
	method: 'ollama_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject(
		OllamaCreateRequest.extend({
			_meta: z.looseObject({progressToken: Uuid.optional()}).optional(),
		}).shape,
	), // TODO @many is strict right here?
	output: z.void().optional(),
	async: true,
	description: 'Create a new Ollama model from a Modelfile.',
} satisfies ActionSpecUnion;

export const ollama_unload_action_spec = {
	method: 'ollama_unload',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		model: z.string(),
	}),
	output: z.void().optional(),
	async: true,
	description: 'Unload an Ollama model from memory.',
} satisfies ActionSpecUnion;

export const provider_load_status_action_spec = {
	method: 'provider_load_status',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: null,
	input: z.strictObject({
		provider_name: ProviderName,
		reload: z.boolean().default(true).optional(),
	}),
	output: z.strictObject({
		status: ProviderStatus,
	}),
	async: true,
	description: 'Check the availability and status of an AI provider.',
} satisfies ActionSpecUnion;

export const provider_update_api_key_action_spec = {
	method: 'provider_update_api_key',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		provider_name: ProviderName,
		api_key: z.string(),
	}),
	output: z.strictObject({
		status: ProviderStatus,
	}),
	async: true,
	description: 'Update the API key for an AI provider.',
} satisfies ActionSpecUnion;

export const terminal_create_action_spec = {
	method: 'terminal_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		command: z.string(),
		args: z.array(z.string()).default(() => []),
		cwd: z.string().optional(),
		preset_id: Uuid.optional(),
	}),
	output: z.strictObject({
		terminal_id: Uuid,
	}),
	async: true,
	description: 'Spawn a PTY process and return the terminal ID.',
} satisfies ActionSpecUnion;

export const terminal_data_send_action_spec = {
	method: 'terminal_data_send',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		terminal_id: Uuid,
		data: z.string(),
	}),
	output: z.null(),
	async: true,
	description: 'Send stdin bytes to a terminal.',
} satisfies ActionSpecUnion;

export const terminal_data_action_spec = {
	method: 'terminal_data',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({
		terminal_id: Uuid,
		data: z.string(),
	}),
	output: z.void(),
	async: true,
	description: 'Stream stdout/stderr bytes from a terminal to the frontend.',
} satisfies ActionSpecUnion;

export const terminal_resize_action_spec = {
	method: 'terminal_resize',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		terminal_id: Uuid,
		cols: z.number().int(),
		rows: z.number().int(),
	}),
	output: z.null(),
	async: true,
	description: 'Update PTY dimensions for a terminal.',
} satisfies ActionSpecUnion;

export const terminal_close_action_spec = {
	method: 'terminal_close',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		terminal_id: Uuid,
		signal: z.string().default('SIGTERM').optional(),
	}),
	output: z.strictObject({
		exit_code: z.number().nullable(),
	}),
	async: true,
	description: 'Kill a terminal process and return the exit code.',
} satisfies ActionSpecUnion;

export const terminal_exited_action_spec = {
	method: 'terminal_exited',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({
		terminal_id: Uuid,
		exit_code: z.number().nullable(),
	}),
	output: z.void(),
	async: true,
	description: 'Notify the frontend that a terminal process exited naturally.',
} satisfies ActionSpecUnion;

export const workspace_open_action_spec = {
	method: 'workspace_open',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		path: DiskfileDirectoryPath,
	}),
	output: z.strictObject({
		workspace: WorkspaceInfoJson,
		files: z.array(SerializableDisknode),
	}),
	async: true,
	description: 'Open a workspace directory — registers with ScopedFs and starts file watching.',
} satisfies ActionSpecUnion;

export const workspace_close_action_spec = {
	method: 'workspace_close',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: true,
	input: z.strictObject({
		path: DiskfileDirectoryPath,
	}),
	output: z.null(),
	async: true,
	description: 'Close a workspace directory — stops file watching and removes from ScopedFs.',
} satisfies ActionSpecUnion;

export const workspace_list_action_spec = {
	method: 'workspace_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'public',
	side_effects: null,
	input: z.void().optional(),
	output: z.strictObject({
		workspaces: z.array(WorkspaceInfoJson),
	}),
	async: true,
	description: 'List all open workspaces.',
} satisfies ActionSpecUnion;

export const workspace_changed_action_spec = {
	method: 'workspace_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: z.strictObject({
		type: z.enum(['open', 'close']),
		workspace: WorkspaceInfoJson,
	}),
	output: z.void(),
	async: true,
	description: 'Notifies frontends when a workspace is opened or closed.',
} satisfies ActionSpecUnion;

export const all_action_specs: Array<ActionSpecUnion> = [
	ping_action_spec,
	session_load_action_spec,
	filer_change_action_spec,
	diskfile_update_action_spec,
	diskfile_delete_action_spec,
	directory_create_action_spec,
	completion_create_action_spec,
	completion_progress_action_spec,
	ollama_progress_action_spec,
	toggle_main_menu_action_spec,
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
	terminal_data_action_spec,
	terminal_resize_action_spec,
	terminal_close_action_spec,
	terminal_exited_action_spec,
	workspace_open_action_spec,
	workspace_close_action_spec,
	workspace_list_action_spec,
	workspace_changed_action_spec,
];
