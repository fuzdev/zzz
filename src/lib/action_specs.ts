import {z} from 'zod';
import {JsonrpcRequestId} from '@fuzdev/fuz_app/http/jsonrpc.js';
import type {
	LocalCallActionSpec,
	RemoteNotificationActionSpec,
	RequestResponseActionSpec,
	ActionSpecUnion,
} from '@fuzdev/fuz_app/actions/action_spec.js';
import {heartbeat_action_spec} from '@fuzdev/fuz_app/actions/heartbeat.js';
import {cancel_action_spec} from '@fuzdev/fuz_app/actions/cancel.js';
import {Uuid} from '@fuzdev/fuz_util/id.js';

// Re-export so the codegen (which uses `import * as specs from './action_specs'`)
// sees the shared specs without duplicating the schemas locally.
export {heartbeat_action_spec, cancel_action_spec};

import {
	DiskfileChange,
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
} from './diskfile_types.js';
import {ProviderStatus, ProviderName} from './provider_types.js';
import {CompletionMessage, CompletionRequest, CompletionResponse} from './completion_types.js';
import {WorkspaceInfoJson} from './workspace.svelte.js';
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

// -- Shared sub-schemas -----------------------------------------------------

/**
 * Progress-token envelope shared by streaming actions. Carries the caller's
 * `progressToken` so streamed `*_progress` notifications can be correlated
 * with the originating request. `looseObject` lets transports tack on
 * additional MCP-style metadata without a schema bump.
 */
export const ProgressMeta = z.looseObject({progressToken: Uuid.optional()});
export type ProgressMeta = z.infer<typeof ProgressMeta>;

// -- Input/output schemas ---------------------------------------------------

/** Output for `ping`. Echoes the JSON-RPC request id back as `ping_id`. */
export const PingOutput = z.strictObject({
	ping_id: JsonrpcRequestId,
});
export type PingOutput = z.infer<typeof PingOutput>;

/**
 * Inner payload of `session_load`. The fields here are the actual session
 * snapshot — files, scoped dirs, provider status, workspaces.
 *
 * TODO extract to `diskfile_types.ts` (or a session-specific module) once
 * the Rust backend grows its own typed session response and we can move
 * this schema to the shared boundary.
 */
export const SessionLoadData = z.strictObject({
	zzz_dir: DiskfileDirectoryPath,
	scoped_dirs: z.readonly(z.array(DiskfileDirectoryPath)),
	files: z.array(SerializableDisknode),
	provider_status: z.array(ProviderStatus),
	workspaces: z.array(WorkspaceInfoJson),
});
export type SessionLoadData = z.infer<typeof SessionLoadData>;

/**
 * Output for `session_load`. The `data` wrapper is historical and kept for
 * cross-backend parity: the Rust backend serializes this exact shape
 * (`crates/zzz_server/src/handlers.rs::SessionLoadResult`) and three
 * integration tests in `test/integration/tests.ts` read `result.data.*`
 * directly. Flattening would break parity in both places, so the wrapper
 * stays until the Rust side moves alongside.
 */
export const SessionLoadOutput = z.strictObject({
	data: SessionLoadData,
});
export type SessionLoadOutput = z.infer<typeof SessionLoadOutput>;

/** Input for `filer_change`. */
export const FilerChangeInput = z.strictObject({
	change: DiskfileChange,
	disknode: SerializableDisknode,
});
export type FilerChangeInput = z.infer<typeof FilerChangeInput>;

/** Input for `diskfile_update`. */
export const DiskfileUpdateInput = z.strictObject({
	path: DiskfilePath,
	content: z.string(),
});
export type DiskfileUpdateInput = z.infer<typeof DiskfileUpdateInput>;

/** Input for `diskfile_delete`. */
export const DiskfileDeleteInput = z.strictObject({
	path: DiskfilePath,
});
export type DiskfileDeleteInput = z.infer<typeof DiskfileDeleteInput>;

/** Input for `directory_create`. */
export const DirectoryCreateInput = z.strictObject({
	path: DiskfilePath,
});
export type DirectoryCreateInput = z.infer<typeof DirectoryCreateInput>;

/** Input for `completion_create`. */
export const CompletionCreateInput = z.strictObject({
	completion_request: CompletionRequest,
	_meta: ProgressMeta.optional(),
});
export type CompletionCreateInput = z.infer<typeof CompletionCreateInput>;

/** Output for `completion_create`. */
export const CompletionCreateOutput = z.strictObject({
	completion_response: CompletionResponse,
	_meta: ProgressMeta.optional(),
});
export type CompletionCreateOutput = z.infer<typeof CompletionCreateOutput>;

/**
 * Input for `completion_progress`.
 *
 * TODO improve `chunk` schema. Today it's Ollama-shaped (`model`,
 * `created_at`, `done`, `message`); add `done_reason`, timing fields
 * (`total_duration`, `load_duration`, `prompt_eval_*`, `eval_*`),
 * `thinking`, `images`, `tool_calls` as more provider streams land.
 */
export const CompletionProgressInput = z.strictObject({
	chunk: z
		.looseObject({
			model: z.string().optional(),
			created_at: z.string().optional(),
			done: z.boolean().optional(),
			message: CompletionMessage.optional(),
		})
		.optional(),
	_meta: ProgressMeta.optional(),
});
export type CompletionProgressInput = z.infer<typeof CompletionProgressInput>;

/**
 * Input for `ollama_progress`. Composes the Ollama progress payload with the shared `_meta` envelope.
 *
 * Re-wraps with `z.strictObject` because `OllamaProgressResponse` is a
 * `z.looseObject` (Ollama API passthrough). Action-spec inputs must reject
 * unknown keys per the canonical convention.
 */
export const OllamaProgressInput = z.strictObject({
	...OllamaProgressResponse.shape,
	_meta: ProgressMeta.optional(),
});
export type OllamaProgressInput = z.infer<typeof OllamaProgressInput>;

// TODO this is just a placeholder for a local call
/** Input for `toggle_main_menu`. Optional — omit to toggle, pass `{show}` to set explicitly. */
export const ToggleMainMenuInput = z.strictObject({show: z.boolean().optional()}).optional();
export type ToggleMainMenuInput = z.infer<typeof ToggleMainMenuInput>;

/** Output for `toggle_main_menu`. */
export const ToggleMainMenuOutput = z.strictObject({show: z.boolean()});
export type ToggleMainMenuOutput = z.infer<typeof ToggleMainMenuOutput>;

/**
 * Input for `ollama_pull`. Composes the Ollama pull request with the streaming `_meta` envelope.
 *
 * Re-wraps with `z.strictObject` because `OllamaPullRequest` is a
 * `z.looseObject` (Ollama API passthrough). Action-spec inputs must reject
 * unknown keys per the canonical convention.
 */
export const OllamaPullInput = z.strictObject({
	...OllamaPullRequest.shape,
	_meta: ProgressMeta.optional(),
});
export type OllamaPullInput = z.infer<typeof OllamaPullInput>;

/**
 * Input for `ollama_create`. Composes the Ollama create request with the streaming `_meta` envelope.
 *
 * Re-wraps with `z.strictObject` because `OllamaCreateRequest` is a
 * `z.looseObject` (Ollama API passthrough). Action-spec inputs must reject
 * unknown keys per the canonical convention.
 */
export const OllamaCreateInput = z.strictObject({
	...OllamaCreateRequest.shape,
	_meta: ProgressMeta.optional(),
});
export type OllamaCreateInput = z.infer<typeof OllamaCreateInput>;

/** Input for `ollama_unload`. */
export const OllamaUnloadInput = z.strictObject({
	model: z.string(),
});
export type OllamaUnloadInput = z.infer<typeof OllamaUnloadInput>;

/** Input for `provider_load_status`. */
export const ProviderLoadStatusInput = z.strictObject({
	provider_name: ProviderName,
	reload: z.boolean().default(true).optional(),
});
export type ProviderLoadStatusInput = z.infer<typeof ProviderLoadStatusInput>;

/** Output for `provider_load_status`. */
export const ProviderLoadStatusOutput = z.strictObject({
	status: ProviderStatus,
});
export type ProviderLoadStatusOutput = z.infer<typeof ProviderLoadStatusOutput>;

/** Input for `provider_update_api_key`. */
export const ProviderUpdateApiKeyInput = z.strictObject({
	provider_name: ProviderName,
	api_key: z.string(),
});
export type ProviderUpdateApiKeyInput = z.infer<typeof ProviderUpdateApiKeyInput>;

/** Output for `provider_update_api_key`. */
export const ProviderUpdateApiKeyOutput = z.strictObject({
	status: ProviderStatus,
});
export type ProviderUpdateApiKeyOutput = z.infer<typeof ProviderUpdateApiKeyOutput>;

/** Input for `terminal_create`. */
export const TerminalCreateInput = z.strictObject({
	command: z.string(),
	args: z.array(z.string()).default(() => []),
	cwd: z.string().optional(),
	preset_id: Uuid.optional(),
});
export type TerminalCreateInput = z.infer<typeof TerminalCreateInput>;

/** Output for `terminal_create`. */
export const TerminalCreateOutput = z.strictObject({
	terminal_id: Uuid,
});
export type TerminalCreateOutput = z.infer<typeof TerminalCreateOutput>;

/** Input for `terminal_data_send`. */
export const TerminalDataSendInput = z.strictObject({
	terminal_id: Uuid,
	data: z.string(),
});
export type TerminalDataSendInput = z.infer<typeof TerminalDataSendInput>;

/** Input for `terminal_data` (backend → frontend stdout/stderr stream). */
export const TerminalDataInput = z.strictObject({
	terminal_id: Uuid,
	data: z.string(),
});
export type TerminalDataInput = z.infer<typeof TerminalDataInput>;

/** Input for `terminal_resize`. */
export const TerminalResizeInput = z.strictObject({
	terminal_id: Uuid,
	cols: z.number().int(),
	rows: z.number().int(),
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeInput>;

/** Input for `terminal_close`. */
export const TerminalCloseInput = z.strictObject({
	terminal_id: Uuid,
	signal: z.string().default('SIGTERM').optional(),
});
export type TerminalCloseInput = z.infer<typeof TerminalCloseInput>;

/** Output for `terminal_close`. */
export const TerminalCloseOutput = z.strictObject({
	exit_code: z.number().nullable(),
});
export type TerminalCloseOutput = z.infer<typeof TerminalCloseOutput>;

/** Input for `terminal_exited`. */
export const TerminalExitedInput = z.strictObject({
	terminal_id: Uuid,
	exit_code: z.number().nullable(),
});
export type TerminalExitedInput = z.infer<typeof TerminalExitedInput>;

/** Input for `workspace_open`. */
export const WorkspaceOpenInput = z.strictObject({
	path: DiskfileDirectoryPath,
});
export type WorkspaceOpenInput = z.infer<typeof WorkspaceOpenInput>;

/** Output for `workspace_open`. */
export const WorkspaceOpenOutput = z.strictObject({
	workspace: WorkspaceInfoJson,
	files: z.array(SerializableDisknode),
});
export type WorkspaceOpenOutput = z.infer<typeof WorkspaceOpenOutput>;

/** Input for `workspace_close`. */
export const WorkspaceCloseInput = z.strictObject({
	path: DiskfileDirectoryPath,
});
export type WorkspaceCloseInput = z.infer<typeof WorkspaceCloseInput>;

/** Output for `workspace_list`. */
export const WorkspaceListOutput = z.strictObject({
	workspaces: z.array(WorkspaceInfoJson),
});
export type WorkspaceListOutput = z.infer<typeof WorkspaceListOutput>;

/** Input for `workspace_changed`. */
export const WorkspaceChangedInput = z.strictObject({
	type: z.enum(['open', 'close']),
	workspace: WorkspaceInfoJson,
});
export type WorkspaceChangedInput = z.infer<typeof WorkspaceChangedInput>;

/** Input for `_test_emit_notifications`. */
export const TestEmitNotificationsInput = z.strictObject({
	count: z.number().int().min(0).max(100),
});
export type TestEmitNotificationsInput = z.infer<typeof TestEmitNotificationsInput>;

/** Output for `_test_emit_notifications`. */
export const TestEmitNotificationsOutput = z.strictObject({
	count: z.number().int(),
});
export type TestEmitNotificationsOutput = z.infer<typeof TestEmitNotificationsOutput>;

/** Input for `_test_notification`. */
export const TestNotificationInput = z.strictObject({
	index: z.number().int().min(0),
});
export type TestNotificationInput = z.infer<typeof TestNotificationInput>;

// -- Action specs -----------------------------------------------------------

export const ping_action_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'both',
	auth: 'public',
	side_effects: false,
	input: z.void().optional(),
	output: PingOutput,
	async: true,
	description: 'Health check — echoes the request ID back to the caller.',
} satisfies RequestResponseActionSpec;

export const session_load_action_spec = {
	method: 'session_load',
	kind: 'request_response',
	// TODO @api is this actually a good restriction to have?
	// or should the server be calling actions internally too?
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: z.void().optional(),
	output: SessionLoadOutput,
	async: true,
	description: 'Load initial session data including filesystem state and provider status.',
} satisfies RequestResponseActionSpec;

export const filer_change_action_spec = {
	method: 'filer_change',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: FilerChangeInput,
	output: z.void(),
	async: true,
	description: 'Notifies the frontend of a file system change detected by the watcher.',
} satisfies RemoteNotificationActionSpec;

export const diskfile_update_action_spec = {
	method: 'diskfile_update',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: DiskfileUpdateInput,
	output: z.null(),
	async: true,
	description: 'Write new content to a file on disk.',
} satisfies RequestResponseActionSpec;

export const diskfile_delete_action_spec = {
	method: 'diskfile_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: DiskfileDeleteInput,
	output: z.null(),
	async: true,
	description: 'Delete a file from disk.',
} satisfies RequestResponseActionSpec;

export const directory_create_action_spec = {
	method: 'directory_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: DirectoryCreateInput,
	output: z.null(),
	async: true,
	description: 'Create a new directory on disk.',
} satisfies RequestResponseActionSpec;

export const completion_create_action_spec = {
	method: 'completion_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: CompletionCreateInput,
	output: CompletionCreateOutput,
	async: true,
	streams: 'completion_progress',
	description: 'Start an AI completion request, optionally with a progress token for streaming.',
} satisfies RequestResponseActionSpec;

export const completion_progress_action_spec = {
	method: 'completion_progress',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: CompletionProgressInput,
	output: z.void(),
	async: true,
	description: 'Streams a completion chunk to the frontend during a streaming AI response.',
} satisfies RemoteNotificationActionSpec;

export const ollama_progress_action_spec = {
	method: 'ollama_progress',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: OllamaProgressInput,
	output: z.void(),
	async: true,
	description: 'Streams progress updates for an Ollama model operation (pull, create, etc.).',
} satisfies RemoteNotificationActionSpec;

export const toggle_main_menu_action_spec = {
	method: 'toggle_main_menu',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: true,
	input: ToggleMainMenuInput,
	output: ToggleMainMenuOutput,
	async: false,
	description: 'Toggle or set the visibility of the main navigation menu.',
} satisfies LocalCallActionSpec;

export const ollama_list_action_spec = {
	method: 'ollama_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: OllamaListRequest,
	output: z.union([OllamaListResponse, z.null()]),
	async: true,
	description: 'List all locally available Ollama models.',
} satisfies RequestResponseActionSpec;

export const ollama_ps_action_spec = {
	method: 'ollama_ps',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: OllamaPsRequest,
	output: z.union([OllamaPsResponse, z.null()]),
	async: true,
	description: 'List currently running Ollama models.',
} satisfies RequestResponseActionSpec;

export const ollama_show_action_spec = {
	method: 'ollama_show',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: OllamaShowRequest,
	output: z.union([OllamaShowResponse, z.null()]),
	async: true,
	description: 'Show detailed information about an Ollama model.',
} satisfies RequestResponseActionSpec;

export const ollama_pull_action_spec = {
	method: 'ollama_pull',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: OllamaPullInput,
	output: z.null(),
	async: true,
	streams: 'ollama_progress',
	description: 'Pull an Ollama model from the registry.',
} satisfies RequestResponseActionSpec;

export const ollama_delete_action_spec = {
	method: 'ollama_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: OllamaDeleteRequest,
	output: z.null(),
	async: true,
	description: 'Delete an Ollama model from local storage.',
} satisfies RequestResponseActionSpec;

export const ollama_copy_action_spec = {
	method: 'ollama_copy',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: OllamaCopyRequest,
	output: z.null(),
	async: true,
	description: 'Copy an Ollama model under a new name.',
} satisfies RequestResponseActionSpec;

export const ollama_create_action_spec = {
	method: 'ollama_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: OllamaCreateInput,
	output: z.null(),
	async: true,
	streams: 'ollama_progress',
	description: 'Create a new Ollama model from a Modelfile.',
} satisfies RequestResponseActionSpec;

export const ollama_unload_action_spec = {
	method: 'ollama_unload',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: OllamaUnloadInput,
	output: z.null(),
	async: true,
	description: 'Unload an Ollama model from memory.',
} satisfies RequestResponseActionSpec;

export const provider_load_status_action_spec = {
	method: 'provider_load_status',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: ProviderLoadStatusInput,
	output: ProviderLoadStatusOutput,
	async: true,
	description: 'Check the availability and status of an AI provider.',
} satisfies RequestResponseActionSpec;

export const provider_update_api_key_action_spec = {
	method: 'provider_update_api_key',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'keeper',
	side_effects: true,
	input: ProviderUpdateApiKeyInput,
	output: ProviderUpdateApiKeyOutput,
	async: true,
	description: 'Update the API key for an AI provider.',
} satisfies RequestResponseActionSpec;

export const terminal_create_action_spec = {
	method: 'terminal_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: TerminalCreateInput,
	output: TerminalCreateOutput,
	async: true,
	description: 'Spawn a PTY process and return the terminal ID.',
} satisfies RequestResponseActionSpec;

export const terminal_data_send_action_spec = {
	method: 'terminal_data_send',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: TerminalDataSendInput,
	output: z.null(),
	async: true,
	description: 'Send stdin bytes to a terminal.',
} satisfies RequestResponseActionSpec;

export const terminal_data_action_spec = {
	method: 'terminal_data',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TerminalDataInput,
	output: z.void(),
	async: true,
	description: 'Stream stdout/stderr bytes from a terminal to the frontend.',
} satisfies RemoteNotificationActionSpec;

export const terminal_resize_action_spec = {
	method: 'terminal_resize',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: TerminalResizeInput,
	output: z.null(),
	async: true,
	description: 'Update PTY dimensions for a terminal.',
} satisfies RequestResponseActionSpec;

export const terminal_close_action_spec = {
	method: 'terminal_close',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: TerminalCloseInput,
	output: TerminalCloseOutput,
	async: true,
	description: 'Kill a terminal process and return the exit code.',
} satisfies RequestResponseActionSpec;

export const terminal_exited_action_spec = {
	method: 'terminal_exited',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TerminalExitedInput,
	output: z.void(),
	async: true,
	description: 'Notify the frontend that a terminal process exited naturally.',
} satisfies RemoteNotificationActionSpec;

export const workspace_open_action_spec = {
	method: 'workspace_open',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: WorkspaceOpenInput,
	output: WorkspaceOpenOutput,
	async: true,
	description: 'Open a workspace directory — registers with ScopedFs and starts file watching.',
} satisfies RequestResponseActionSpec;

export const workspace_close_action_spec = {
	method: 'workspace_close',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: true,
	input: WorkspaceCloseInput,
	output: z.null(),
	async: true,
	description: 'Close a workspace directory — stops file watching and removes from ScopedFs.',
} satisfies RequestResponseActionSpec;

export const workspace_list_action_spec = {
	method: 'workspace_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: z.void().optional(),
	output: WorkspaceListOutput,
	async: true,
	description: 'List all open workspaces.',
} satisfies RequestResponseActionSpec;

export const workspace_changed_action_spec = {
	method: 'workspace_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: WorkspaceChangedInput,
	output: z.void(),
	async: true,
	description: 'Notifies frontends when a workspace is opened or closed.',
} satisfies RemoteNotificationActionSpec;

// Test-only: exists so the integration suite can verify `ctx.notify` routing
// (socket-scoped delivery) without depending on a real AI/Ollama provider.
// The backend handler emits `count` `_test_notification` notifications via
// `ctx.notify` and then returns `{count}`. Authenticated so unauth callers
// can't spam other sockets.
export const _test_emit_notifications_action_spec = {
	method: '_test_emit_notifications',
	kind: 'request_response',
	initiator: 'frontend',
	auth: 'authenticated',
	side_effects: false,
	input: TestEmitNotificationsInput,
	output: TestEmitNotificationsOutput,
	async: true,
	streams: '_test_notification',
	description:
		'Test-only. Emits `count` `_test_notification` notifications via ctx.notify, then returns {count}.',
} satisfies RequestResponseActionSpec;

export const _test_notification_action_spec = {
	method: '_test_notification',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TestNotificationInput,
	output: z.void(),
	async: true,
	description:
		'Test-only. Progress notification emitted by _test_emit_notifications; carries the sequence index.',
} satisfies RemoteNotificationActionSpec;

export const all_action_specs: Array<ActionSpecUnion> = [
	heartbeat_action_spec,
	cancel_action_spec,
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
	_test_emit_notifications_action_spec,
	_test_notification_action_spec,
];
